// sandbox — the controls that hold when the model does not cooperate.
//
// The profile has always declared sensitive paths, quarantined paths, forbidden
// commands and lane territory. Until now every one of them was rendered as PROSE
// into the worker's prompt, while the worker received `Read,Edit,Write,Grep,Glob,
// Bash` — a full shell. Asking a model not to do something is not a control, and
// the same loop feeds it CI logs and review comments written by other systems.
//
// Four things were measured against the installed CLI before any of this was
// designed, because a sandbox that does not actually deny is worse than none:
//
//   · `permissions.deny` blocks in headless `-p` mode.
//   · Denying Write/Edit while allowing bare Bash is THEATRE. Asked to write a
//     denied file, the model used `printf > file` and succeeded on the next turn.
//   · A SCOPED allowlist contains Bash on its own. Granted only
//     `Bash(git status:*)`, `git status` ran while `git push`, `printf > file`,
//     `printf | tee` and a chained `git remote -v` were each refused.
//   · Path-scoped denies work, verified with a control file that DID change in
//     the same run.
//   · But `deny: ["Bash"]` removes the tool from the session ENTIRELY, scoped
//     grants included. The first version of this file denied Bash as a class and
//     would have shipped a fixer that could edit code and never run a test —
//     reporting success on work nothing had checked.
//
// And one nobody asked for: denied twice, the model reached for a third tool that
// was never offered. Any tool that can run a command is a write primitive, so the
// grant is a CLOSED ALLOWLIST and the denies are belt-and-braces on top of it.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Read-only git. A fixer has to see what it is changing, and none of these can
 * mutate a repository or reach the network.
 */
const GIT_READ = ["status", "diff", "log", "show", "rev-parse", "ls-files", "branch --show-current"];

/** Recording work locally. Publishing it is reeve's job, never the worker's. */
const GIT_WRITE = ["add", "commit", "checkout --", "restore"];

/**
 * Never granted to a worker under any profile, whatever it declares.
 *
 * These are AUTHORITY and NETWORK, which is what a sandbox can actually enforce
 * against a process whose job is to change code.
 *
 * It deliberately no longer tries to stop the worker EXECUTING things. That was
 * the first version's mistake and it failed on its first real dispatch: eleven
 * denied tool calls, because reeve's own `npm test` is a shell loop over
 * `node <file>` and the worker reasonably reached for the file directly. Worse,
 * the restriction was never real — a worker holding Write can write a script and
 * run it through any granted runner, so denying `node -e` bought nothing and only
 * made the failure confusing.
 *
 * What IS enforceable, and is enforced: it cannot push or merge, so it can never
 * be both the actor and the only claim the action was allowed; it cannot reach the
 * network; it cannot read or write quarantined or sensitive paths; it cannot edit
 * the files that judge it; and whatever it produces is checked against the lane's
 * territory before reeve publishes it.
 */
const NEVER = [
  "Bash(git push:*)", "Bash(git remote:*)", "Bash(gh pr merge:*)", "Bash(gh api:*)",
  "Bash(gh auth:*)", "Bash(curl:*)", "Bash(wget:*)", "Bash(ssh:*)", "Bash(nc:*)",
  "Bash(sudo:*)", "Bash(chmod:*)", "Bash(rm -rf:*)",
  "Bash(npm publish:*)", "Bash(pnpm publish:*)", "Bash(yarn publish:*)",
];

/** The paths that judge the work. A worker EDITING these grades its own exam;
 * reading them is how it understands the exam. */
const SELF_GOVERNING = [".github/**", ".git/**"];

/**
 * Paths a worker's shell must never read, enforced by the OS sandbox
 * (`sandbox.filesystem.denyRead`, Seatbelt on macOS) and mirrored as `Read(...)`
 * deny rules for the Read tool, which the OS sandbox does not cover.
 *
 * Measured 2026-08-22 (docs/measured/2026-08-22-claude-print-mode.md): the
 * deny holds under -p, through symlinks, for Bash and for the Read tool. It
 * does NOT reach the keychain -- securityd reads an item on the process's
 * behalf and the runtime's profile hard-allows that service -- so this list
 * closes FILE credentials only; the keychain is measured separately at daemon
 * start (canary.mjs) and a host that holds a GitHub credential there stays
 * refused.
 *
 *   ~/.reeve           the App's private key, every store, every other run's output
 *   ~/.claude          the founder's sessions, settings and account state; the
 *                      CLI reads these from its own (unsandboxed) process
 *   ~/.claude.json     account state
 *   ~/.config/gh       gh's config; a token when logged in with --insecure-storage
 *   ~/.ssh             keys; the agent socket is already stripped from the env
 *   ~/.gitconfig       the founder's helpers and URL rewrites
 *   ~/.git-credentials the store helper's plaintext file
 *   ~/.netrc           curl/git plaintext logins
 *   ~/.npmrc           registry tokens
 *   ~/.aws ~/.azure ~/.config/gcloud ~/.kube ~/.docker ~/.gnupg
 *                      cloud, cluster, registry and signing credentials
 */
export const CREDENTIAL_PATHS = [
  "~/.reeve", "~/.claude", "~/.claude.json", "~/.config/gh", "~/.ssh", "~/.gitconfig",
  "~/.git-credentials", "~/.netrc", "~/.npmrc", "~/.aws", "~/.azure", "~/.config/gcloud",
  "~/.kube", "~/.docker", "~/.gnupg",
];
// The same list as Read-tool rules: a file is named, a directory gets `/**`.
const CREDENTIAL_FILES = new Set(["~/.claude.json", "~/.gitconfig", "~/.git-credentials", "~/.netrc", "~/.npmrc"]);
const credentialReadDenies = () => CREDENTIAL_PATHS.map(p => (CREDENTIAL_FILES.has(p) ? `Read(${p})` : `Read(${p}/**)`));

/**
 * Actions whose Bash may reach the network at all, and where the domains come
 * from. Everything else is denied outright: a fixer needs no registry (its
 * dependencies are installed before it is dispatched) and a spec writer needs
 * no web. Research reads the profile's list and nothing else.
 */
const NETWORK_DOMAINS = (profile, action) =>
  action === "BUILD_RESEARCH" ? [...(profile?.builder?.network?.research?.allowedDomains ?? [])] : [];

/**
 * Where a project's tests live, when the profile does not say.
 *
 * Tests judge the work exactly as the workflow does, but they cannot simply be
 * denied: the worker prompt REQUIRES a test that fails on the broken code, so a
 * repair that adds one is the intended shape. What is never a repair is a diff
 * with nothing in it BUT tests -- that has changed the exam and nothing else.
 */
const TEST_PATHS = [
  "test/**", "tests/**", "spec/**", "**/__tests__/**",
  "**/*.test.*", "**/*_test.*", "**/*.spec.*", "**/test_*.py",
];

/** Actions whose whole purpose is to change code so a check goes green. */
const REPAIRING = new Set(["FIX_CI"]);

/** What a project of each language is actually run with. */
const RUNTIMES = {
  typescript: ["node", "npx", "tsx"],
  python: ["python", "python3", "pytest", "uv", "ruff", "mypy"],
  go: ["go"],
  rust: ["cargo"],
};

const denyAllVerbs = glob =>
  ["Read", "Edit", "Write", "NotebookEdit"].map(v => `${v}(./${glob.replace(/^\.\//, "")})`);

/**
 * Writing only, for paths a worker must not CHANGE but does need to understand.
 *
 * The distinction is deliberate and the two are not interchangeable:
 *
 *   quarantine — deny every verb, READS INCLUDED. This is data that must never be
 *   seen at all: another client's credentials, a production dump.
 *
 *   sensitive and self-governing — deny writes only. Auth code, a migration, the
 *   workflow that is failing: reading these is how a fixer works out what went
 *   wrong, and changing them is what needs a human. Denying the read left the
 *   worker unable to see what CI even ran, and it spent its turns guessing.
 */
const denyWriteVerbs = glob =>
  ["Edit", "Write", "NotebookEdit"].map(v => `${v}(./${glob.replace(/^\.\//, "")})`);

/**
 * The deterministic policy for one worker.
 *
 * Returns the closed tool allowlist and a settings object to hand the CLI with
 * `--settings`. `additionalDirectories` is deliberately empty: the worker runs
 * with its worktree as the working directory, and adding anything to that widens
 * the only boundary keeping it inside its own checkout.
 */
export function sandboxFor({ profile, action, worktree, lane = null, tmpDir = null }) {
  const risk = profile?.risk ?? {};
  const units = profile?.units ?? [];

  // Commands the project itself declares. A fixer that cannot run the tests
  // cannot tell whether its fix worked, so this is the minimum that makes the
  // work verifiable rather than asserted.
  const projectCmds = [];
  const runners = new Set();
  for (const u of units) {
    for (const c of Object.values(u.commands ?? {})) {
      if (!c?.cmd) continue;
      // The runner and its first argument: `pnpm test --watch` must not be
      // reachable merely because `pnpm test` is.
      const head = c.cmd.trim().split(/\s+/).slice(0, 2).join(" ");
      if (head) projectCmds.push(`Bash(${head}:*)`);
    }
    // The language's own runner, because a declared command is often a wrapper.
    // reeve's `npm test` is a shell loop over `node <file>`, and a fixer that
    // cannot run ONE test has to run the whole suite to check a one-line change,
    // or give up -- which is what it did.
    for (const r of RUNTIMES[u.language] ?? []) runners.add(r);
    if (u.packageManager) runners.add(u.packageManager);
  }

  // Reading the workspace. A fixer that cannot list a directory is reduced to
  // guessing at filenames.
  for (const r of ["ls", "cat", "head", "tail", "wc", "find", "which", "pwd"]) runners.add(r);

  // `git` as a whole, not subcommand by subcommand. The matcher compares from the
  // start of the command, and a worker handed a worktree path writes
  // `git -C <path> log …` — where the flag sits BEFORE the subcommand, so
  // `Bash(git log:*)` never matches it. Six denials in one run were this.
  //
  // Safe because deny beats allow, measured: `deny: ["Bash"]` with a narrow allow
  // blocked everything. The dangerous subcommands stay denied below, so widening
  // the grant does not widen the authority.
  const gitTools = ["Bash(git:*)"];

  // The interpreter by its absolute path as well as its name. The worker reached
  // for /Users/…/node because that is what reeve itself runs as, and a bare-name
  // grant does not match a path.
  const selfInterpreter = `Bash(${process.execPath}:*)`;
  const runnerTools = [...[...runners].map(r => `Bash(${r}:*)`), selfInterpreter];

  // A closed set. Nothing reaches the network, nothing spawns a shell, and Bash
  // appears only with a scope attached.
  const tools = action === "FIX_CI" || action === "FIX_FINDINGS"
    ? ["Read", "Edit", "Write", "Grep", "Glob", ...gitTools, ...runnerTools, ...new Set(projectCmds)]
    : ["Read", "Grep", "Glob", ...gitTools];

  const deny = [
    // Bash is NOT denied as a class here, and that is a measured decision rather
    // than an omission. `deny: ["Bash"]` removes the tool from the session
    // entirely — scoped grants included — so the worker could edit files but
    // never run the tests, never commit, and never verify its own fix. It would
    // report success on work nothing had checked, which is a worse failure than
    // the one being fixed.
    //
    // Scoping through the allowlist was measured to hold on its own: with only
    // `Bash(git status:*)` granted, `git status` ran, `git push` was refused, and
    // three separate attempts to write a file through the shell — `printf >`,
    // `printf > … ; ls`, and `printf | tee` — were each refused. The entries
    // below are defence in depth on top of that, not the load-bearing part.
    ...NEVER,
    ...(risk.forbiddenCommands ?? []).map(c => `Bash(${c}:*)`),
    ...(risk.quarantinePaths ?? []).flatMap(denyAllVerbs),
    // A lane may declare sensitiveOk to work its own territory even where that
    // territory is sensitive -- without it the release lane was dead at both
    // layers, this one denying the write whose result the diff gate would have
    // refused anyway. The lift is by VERBATIM glob only, because glob-subset
    // reasoning cannot be done safely here; the diff gate still judges every
    // actual file, and quarantine and SELF_GOVERNING stay untouched below.
    ...(risk.sensitivePaths ?? [])
      .filter(p => !(lane?.sensitiveOk === true && (lane.territory ?? []).includes(p)))
      .flatMap(denyWriteVerbs),
    ...SELF_GOVERNING.flatMap(denyWriteVerbs),
  ];

  // The Read tool is not under the OS sandbox, so the credential paths are
  // denied to it here as well; measured to hold for an absolute path and for a
  // symlink inside the worktree that points at one.
  deny.push(...credentialReadDenies());

  return {
    allowedTools: tools.join(","),
    settings: {
      permissions: {
        deny,
        allow: tools.filter(t => t.startsWith("Bash(")),
        // Empty on purpose. The worktree is the boundary.
        additionalDirectories: [],
      },
      // The OS boundary (Seatbelt on macOS, bubblewrap on Linux, refused
      // elsewhere): every Bash subprocess runs inside it. The string-pattern
      // denies above document intent; this enforces it. No fallback to an
      // unsandboxed command, no auto-allow that would bypass the closed
      // allowlist, nothing excluded. Write scope is the worktree (implicit: the
      // CLI adds cwd) plus the run's own tmp, which sits under ~/.reeve and so
      // must be carved back out of the deny-read. Every key is listed, because
      // the validator is a closed allowlist and an absent key would be a
      // default chosen by the CLI rather than by this file.
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: false,
        excludedCommands: [],
        filesystem: {
          allowWrite: tmpDir ? [tmpDir] : [],
          denyWrite: [],
          allowRead: tmpDir ? [tmpDir] : [],
          denyRead: [...CREDENTIAL_PATHS],
        },
        network: {
          allowedDomains: NETWORK_DOMAINS(profile, action),
          deniedDomains: [],
          allowUnixSockets: [],
          allowAllUnixSockets: false,
          allowLocalBinding: false,
          allowMachLookup: [],
        },
      },
    },
    worktree,
    lane: lane?.id ?? null,
  };
}

/**
 * Validate generated settings before spawn.
 *
 * Measured: under `-p` a settings file that fails the CLI's own validation is
 * ignored IN ITS ENTIRETY, silently, exit 0 -- its deny rules included. So a
 * supplied path proves nothing, and this is the check that turns "a file was
 * passed" into "the file says what was meant". It is a closed allowlist of
 * keys with exact values, not a schema of what the CLI accepts: a key this
 * function does not know is refused, because it may be one that weakens the
 * boundary (enableWeakerNestedSandbox, ignoreViolations, excludedCommands all
 * do). `tmpDir` is required: the only write grant beyond cwd is the run's own
 * tmp, and the validator cannot judge a grant without knowing what it should be.
 */
export function validateSettings(settings, { tmpDir = null } = {}) {
  const errors = [];
  if (!tmpDir) return { ok: false, errors: ["validator needs the run's tmpDir to judge the write grant"] };
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { ok: false, errors: ["settings absent"] };
  const isObj = v => v && typeof v === "object" && !Array.isArray(v);
  const strs = v => Array.isArray(v) && v.every(x => typeof x === "string");
  const keysIn = (obj, allowed, where) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unexpected key: ${k}`);
  };

  keysIn(settings, ["permissions", "sandbox"], "settings");
  const p = settings.permissions;
  if (!isObj(p)) errors.push("permissions must be an object");
  else {
    keysIn(p, ["allow", "deny", "additionalDirectories"], "permissions");
    if (!strs(p.allow)) errors.push("permissions.allow must be an array of strings");
    if (!strs(p.deny)) errors.push("permissions.deny must be an array of strings");
    if (!Array.isArray(p.additionalDirectories) || p.additionalDirectories.length) errors.push("permissions.additionalDirectories must be empty");
    if (strs(p.deny)) for (const d of credentialReadDenies()) if (!p.deny.includes(d)) errors.push(`permissions.deny is missing ${d}`);
  }

  const sb = settings.sandbox;
  if (!isObj(sb)) errors.push("sandbox block absent");
  else {
    keysIn(sb, ["enabled", "failIfUnavailable", "allowUnsandboxedCommands", "autoAllowBashIfSandboxed", "excludedCommands", "filesystem", "network"], "sandbox");
    if (sb.enabled !== true) errors.push("sandbox.enabled must be true");
    if (sb.failIfUnavailable !== true) errors.push("sandbox.failIfUnavailable must be true");
    if (sb.allowUnsandboxedCommands !== false) errors.push("sandbox.allowUnsandboxedCommands must be false");
    if (sb.autoAllowBashIfSandboxed !== false) errors.push("sandbox.autoAllowBashIfSandboxed must be false");
    if (!Array.isArray(sb.excludedCommands) || sb.excludedCommands.length) errors.push("sandbox.excludedCommands must be empty");
    const fs = sb.filesystem;
    if (!isObj(fs)) errors.push("sandbox.filesystem must be an object");
    else {
      keysIn(fs, ["allowWrite", "denyWrite", "allowRead", "denyRead"], "sandbox.filesystem");
      for (const k of ["allowWrite", "denyWrite", "allowRead", "denyRead"]) if (!strs(fs[k])) errors.push(`sandbox.filesystem.${k} must be an array of strings`);
      if (strs(fs.allowWrite) && (fs.allowWrite.length !== 1 || fs.allowWrite[0] !== tmpDir)) errors.push(`sandbox.filesystem.allowWrite must be exactly the run's tmp (${tmpDir})`);
      if (strs(fs.allowRead) && (fs.allowRead.length !== 1 || fs.allowRead[0] !== tmpDir)) errors.push(`sandbox.filesystem.allowRead must be exactly the run's tmp (${tmpDir})`);
      if (strs(fs.denyRead)) for (const c of CREDENTIAL_PATHS) if (!fs.denyRead.includes(c)) errors.push(`sandbox.filesystem.denyRead is missing ${c}`);
    }
    const net = sb.network;
    if (!isObj(net)) errors.push("sandbox.network must be an object");
    else {
      keysIn(net, ["allowedDomains", "deniedDomains", "allowUnixSockets", "allowAllUnixSockets", "allowLocalBinding", "allowMachLookup"], "sandbox.network");
      for (const k of ["allowedDomains", "deniedDomains", "allowUnixSockets", "allowMachLookup"]) if (!strs(net[k])) errors.push(`sandbox.network.${k} must be an array of strings`);
      if (strs(net.allowUnixSockets) && net.allowUnixSockets.length) errors.push("sandbox.network.allowUnixSockets must be empty");
      if (strs(net.allowMachLookup) && net.allowMachLookup.length) errors.push("sandbox.network.allowMachLookup must be empty");
      if (net.allowAllUnixSockets !== false) errors.push("sandbox.network.allowAllUnixSockets must be false");
      if (net.allowLocalBinding !== false) errors.push("sandbox.network.allowLocalBinding must be false");
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Write the settings a worker will run under, and return the path. */
export function writeSandbox(dir, sandbox) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "sandbox-settings.json");
  writeFileSync(path, JSON.stringify(sandbox.settings, null, 2));
  return path;
}

/**
 * A glob to a regular expression, without a placeholder byte.
 *
 * The first version substituted `**` for a sentinel character and then swapped it
 * back, and that sentinel was a raw NUL -- which makes the whole file BINARY to
 * git, so every diff of it renders as "Binary files differ" and no reviewer sees
 * the change. Splitting on `**` needs no sentinel at all: each remaining segment
 * contains no `**` by construction, so it can be escaped and have its single `*`
 * expanded independently.
 */
const toRe = glob => new RegExp("^" + glob.split("**")
  .map(seg => seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
  .join(".*") + "$");

const matchesAny = (file, globs) => (globs ?? []).some(g => toRe(g).test(file));

/**
 * The gate between a worker finishing and reeve pushing.
 *
 * The permission layer stops a worker reaching a forbidden path. This answers the
 * different question of whether what it actually produced is inside the work it
 * was given — enforced on the diff, deterministically, after the model has
 * stopped talking. A model that argued its way to a plausible edit outside its
 * territory still does not get it published.
 *
 * An EMPTY diff refuses. A worker that changed nothing has not fixed anything,
 * and pushing nothing as though it were a repair is absence read as success.
 */
export function reviewDiff({ files, profile, lane = null, action = null }) {
  const risk = profile?.risk ?? {};
  // null is "could not ask git", which is not the same as "nothing changed" and
  // must not be reported as it. Both refuse; only one of them is the worker's fault.
  if (files === null || files === undefined)
    return { ok: false, why: "could not read what the worker changed, so it cannot be published" };
  const list = files;
  if (!list.length) return { ok: false, why: "the worker produced an empty diff — nothing was changed" };

  const quarantined = list.filter(f => matchesAny(f, risk.quarantinePaths));
  if (quarantined.length)
    return { ok: false, why: `quarantined path(s) changed: ${quarantined.join(", ")}`, files: quarantined };

  const governing = list.filter(f => matchesAny(f, SELF_GOVERNING));
  if (governing.length)
    return { ok: false, why: `the change edits what judges it: ${governing.join(", ")}`, files: governing };

  // A lane that declared sensitiveOk works its OWN territory even where that
  // territory is sensitive -- the release lane's whole territory sat in
  // sensitivePaths, so this refusal fired before territory was ever read and
  // the lane could never publish anything. The exemption is per actual file,
  // scoped to the declaring lane's territory, and sits BELOW quarantine and
  // self-governing, which no declaration reaches.
  const laneOwned = lane?.sensitiveOk === true && (lane.territory ?? []).length
    ? f => matchesAny(f, lane.territory) : () => false;
  const sensitive = list.filter(f => matchesAny(f, risk.sensitivePaths) && !laneOwned(f));
  if (sensitive.length)
    return { ok: false, why: `sensitive path(s) changed and need a human: ${sensitive.join(", ")}`, files: sensitive };

  // A repair that changed ONLY tests has repaired nothing. Either the test was
  // genuinely wrong -- a real case, and one a human should judge rather than a
  // fixer decide alone -- or it was weakened until it stopped objecting. Both
  // escalate; neither is published on the strength of the resulting green.
  //
  // The honest limit: a diff that touches one source line and guts a suite still
  // passes here. This refuses the whole-hog case only.
  if (REPAIRING.has(action)) {
    const tests = risk.testPaths ?? TEST_PATHS;
    if (list.every(f => matchesAny(f, tests)))
      return { ok: false, files: list,
               why: `every changed file is a test, so nothing was repaired -- only what judges it: ${list.join(", ")}` };
  }

  // No lane means territory was never assigned, which is not the same as being
  // allowed everywhere — but it is the profile's own choice, and the risk rules
  // above still applied. Only a lane WITH territory can be exceeded.
  const territory = lane?.territory ?? null;
  if (territory?.length) {
    const outside = list.filter(f => !matchesAny(f, territory));
    if (outside.length)
      return { ok: false, why: `outside the ${lane.id} lane's territory: ${outside.join(", ")}`, files: outside };
  }

  return { ok: true, why: null, files: list };
}
