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

import { writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { resolveHome, DEFAULT_HOME } from "./home.mjs";
import { ARTIFACT_FILE } from "./paths.mjs";

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
  // `git add` and `git commit` join `git push` because reeve now does all three.
  // Denied rather than merely unmentioned: without an explicit refusal the write
  // deny on `.git` surfaces as `Operation not permitted` on `.git/index.lock`,
  // which reads as a broken machine rather than a boundary. A worker met exactly
  // that on 2026-08-23 and spent thirteen of its thirty-six turns investigating
  // the filesystem instead of finishing.
  //
  // These are DIAGNOSTIC, not the boundary, and the difference matters. The
  // matcher compares from the start of a command, so an option-bearing form --
  // `git -C <path> add`, which this module elsewhere says workers do write --
  // matches neither prefix, falls through the umbrella `Bash(git:*)` grant, and
  // lands on the same EPERM. Enumerating those forms is not possible from a
  // prefix list, and narrowing the umbrella grant was already measured to break
  // `git -C <path> log` for six denials in one run. What actually stops a worker
  // committing is the write deny; what stops it WASTING a run on the attempt is
  // the prompt, which now tells it reeve commits and it does not.
  "Bash(git add:*)", "Bash(git commit:*)",
  "Bash(git push:*)", "Bash(git remote:*)", "Bash(gh pr merge:*)", "Bash(gh api:*)",
  "Bash(gh auth:*)", "Bash(curl:*)", "Bash(wget:*)", "Bash(ssh:*)", "Bash(nc:*)",
  "Bash(sudo:*)", "Bash(chmod:*)", "Bash(rm -rf:*)",
  "Bash(npm publish:*)", "Bash(pnpm publish:*)", "Bash(yarn publish:*)",
];

/**
 * Tools the CLI provides directly, which a worker never gets.
 *
 * This list exists separately from `NEVER` above because the two are not the same
 * kind of thing, and conflating them is what left this gap open. `NEVER` is a list
 * of SHELL COMMANDS: `Bash(curl:*)` stops a worker shelling out to curl. But
 * `WebFetch` is not a shell command, so no `Bash(...)` rule can reach it, and the
 * docblock above this file's grant has claimed "it cannot reach the network" while
 * nothing in this module named a single one of these tools.
 *
 * MEASURED, 2026-08-24: the boundary held anyway. A real worker under reeve's own
 * settings called `WebFetch` and was told "Claude requested permissions to use
 * WebFetch, but you haven't granted it yet." Not being on the allow list is enough,
 * because an ungranted tool falls through to a permission prompt and a headless run
 * has nobody to answer one.
 *
 * That is a boundary by consequence, not by statement, and it is being written
 * down for the two reasons this project has already paid for once:
 *
 *   · Nothing enforced it and no test read it, so a CLI default that changed would
 *     open the door silently. The read deny list that turned out to be inert
 *     (2026-08-22) and the `.git` block imposed a layer beneath reeve's settings
 *     (2026-08-23) were both this shape.
 *   · The worker spends PAID TURNS finding out. In the same measurement it burned
 *     three of them on a tool it was never going to get. That is the `git commit`
 *     lesson exactly: what stops the attempt costing a run is the prompt.
 *
 * Grouped by the capability each would hand over, because a name-by-name list
 * invites additions that do not belong and omissions that do:
 *
 *   network egress          the one the docblock already claimed was closed
 *   agent delegation        a spawned agent's grant is not this grant
 *   cross-session reach     other sessions on this machine are outside the sandbox
 *   work outliving the run  a schedule survives the checkout being released
 *   leaving the checkout    the worktree IS the boundary; do not let it be left
 *
 * Deliberately NOT here: `ToolSearch`, `Skill`, `Monitor`, `Read`/`Edit`/`Write`
 * and the rest. Those are how a worker does the job it was given, and the file
 * tools are already scoped to the checkout by `permissions.deny`. Denying a tool a
 * repair needs would produce a worker that reports success on work nothing checked,
 * which is the failure `NEVER`'s own comment warns against.
 */
export const NEVER_TOOLS = [
  "WebFetch", "WebSearch",
  "Task", "Agent", "Workflow",
  "SendMessage", "ListAgents",
  "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger", "PushNotification",
  "EnterWorktree", "ExitWorktree",
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
 * closes FILE credentials only. The keychain is closed by a different mechanism
 * entirely: a worker's HOME is reeve's own scratch directory, so no login
 * keychain is in its search list, and the canary measures that per CLI build.
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
const expandTilde = p => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/**
 * An absolute path as a PERMISSION RULE writes it: with a second leading slash.
 *
 * The two layers of this policy want two different spellings of the same path,
 * and getting it wrong is silent both ways. Measured 2026-08-22 with a real
 * worker (docs/measured/2026-08-22-the-read-deny-list-was-inert.md):
 *
 *   sandbox.filesystem.denyRead    /Users/x/.ssh      the OS layer, plain
 *   permissions.deny  Read(...)   //Users/x/.ssh      the CLI layer, TWO slashes
 *
 * A rule written `Read(/Users/x/.ssh/**)` matches nothing at all. This branch
 * shipped that form for one afternoon, which left every credential deny inert:
 * the first live canary read a decoy the shell beside it could not.
 *
 * A tilde is not an option here either. It expands against the PROCESS's home,
 * and a worker's home is reeve's scratch directory, so `~/.ssh` would protect a
 * directory that does not exist. Project-relative rules are resolved against the
 * checkout and are written plainly.
 */
export const ruleFor = p => (p.startsWith("/") ? `/${p}` : p);

/** Is `p` the same path as `d`, or inside it? */
export const under = (p, d) => typeof p === "string" && typeof d === "string" && (p === d || p.startsWith(d.endsWith("/") ? d : d + "/"));

/**
 * A read grant is legitimate only when it reopens part of something the SAME
 * policy denies. Used to build the grant and to validate it, so the two cannot
 * disagree — the alternative was a parameter every caller had to reconstruct,
 * and the canary reconstructed it wrongly and denied itself its own script.
 */
export const carveOuts = (denyRead, paths) => paths.filter(p => p && denyRead.some(d => under(p, d)));

/** The tools that touch files, and so are governed by permissions alone. */
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "Grep", "Glob", "NotebookEdit"]);

/**
 * The file tools, granted only inside one directory.
 *
 * BOTH forms per tool. `<dir>/**` matches descendants, and creating a new file
 * is checked against the DIRECTORY, so a grant of only the subtree refused the
 * worker's own `./made.txt` -- the same shape as `Read(<file>/**)` leaving the
 * file itself readable. Measured with a real worker: with both forms a worker
 * writes at the checkout root, writes in subdirectories and edits, while reads
 * and writes outside are refused.
 *
 * The path is resolved before it is written into a rule. macOS puts temporary
 * directories behind /var -> /private/var, and the CLI checks the resolved path,
 * so an unresolved scope silently matches nothing and the worker cannot write in
 * its own checkout.
 */
export function scopedFileTools(tools, dir) {
  // No absolute directory to scope to, so no file tools. Returning them BARE
  // would be a silent grant of the whole filesystem from a caller that forgot an
  // argument -- the failure mode this function exists to remove. A worker with
  // no file tools cannot work, and says so loudly.
  if (!dir || !dir.startsWith("/")) return [];
  let real = dir;
  try { real = realpathSync(dir); } catch { /* not created yet: the given path is the best available */ }
  return tools.flatMap(t => [`${t}(${ruleFor(real)})`, `${t}(${ruleFor(real)}/**)`]);
}

export const CREDENTIAL_PATHS = [
  // The founder's keychains, BY PATH. A scratch HOME removes the login keychain
  // from the search LIST, which is not the same as putting it out of reach:
  // measured 2026-08-22, `security find-internet-password -s github.com
  // ~/Library/Keychains/login.keychain-db` returns the credential under a
  // scratch home, because the process runs as the same OS user and the keychain
  // is unlocked with no timeout. Naming the path closes it — measured, with the
  // same probe returning 44 under this deny and 0 without it.
  "~/Library/Keychains",
  "~/.reeve", "~/.claude", "~/.claude.json", "~/.config/gh", "~/.ssh", "~/.gitconfig",
  // Git's `store` helper writes plaintext tokens to ~/.git-credentials OR, under
  // the XDG layout, ~/.config/git/credentials. Stripping XDG_CONFIG_HOME from the
  // worker env only restores ~/.config as the default, so the XDG location must
  // be denied by path like every other credential file. (Codex #4e-[3].)
  "~/.git-credentials", "~/.config/git", "~/.netrc", "~/.npmrc", "~/.aws", "~/.azure",
  "~/.config/gcloud", "~/.kube", "~/.docker", "~/.gnupg",
];
// The same list as Read-tool rules: a file is named, a directory gets `/**`.
const CREDENTIAL_FILE_NAMES = ["~/.claude.json", "~/.gitconfig", "~/.git-credentials", "~/.netrc", "~/.npmrc"];
const isCredentialFile = p => CREDENTIAL_FILE_NAMES.map(expandTilde).includes(p);

/**
 * The credential paths, plus the CONFIGURED reeve state root when it is not the
 * default `~/.reeve`. `~/.reeve` (the profile, every store, every run's output)
 * is already listed, but `REEVE_HOME` can point the state root elsewhere, and a
 * state root the sandbox does not deny is readable — a worker could copy the
 * profile or another run's output into its worktree for reeve to publish.
 * (Codex #4b-[11].)
 */
export function credentialPaths() {
  // `resolveHome()`, not the raw variable: it applies `--home` (which
  // `bin/reeve` writes back into the environment) and it makes a relative root
  // absolute. The old `startsWith("/")` guard silently dropped a relative
  // REEVE_HOME, leaving that state root readable by every worker.
  const root = resolveHome().replace(/\/+$/, "");
  const extra = root !== DEFAULT_HOME() ? [root] : [];
  // ABSOLUTE, always. Measured 2026-08-22: the sandbox expands `~` against the
  // PROCESS's home, and a worker's home is now reeve's scratch directory — so a
  // `~/.ssh` rule would expand to `<scratch>/.ssh` and protect nothing at all.
  // The credentials being protected live in the DAEMON's home, so that is the
  // home these resolve against.
  return [...CREDENTIAL_PATHS.map(expandTilde), ...extra];
}
const credentialReadDenies = () => credentialPaths().map(p => (isCredentialFile(p) ? `Read(${ruleFor(p)})` : `Read(${ruleFor(p)}/**)`));

/**
 * The clone a worker's checkout was made FROM.
 *
 * The run checkout carries only COMMITTED content, so the founder's uncommitted
 * work and their ignored files (a `.env` among them) are not in it. That is a
 * different claim from being out of a worker's reach, and the difference was
 * measured on 2026-08-22: the sandbox denies WRITES outside the checkout, not
 * reads, so a worker could simply `cat` them where they still live
 * (test/escape.test.mjs). Nothing legitimate needs that directory — the worker
 * has its own clone and its dependencies were copied in before it started — so
 * it is denied like any other credential path.
 */
export function sourceCheckoutOf(profile) {
  const c = profile?.identity?.checkout;
  return typeof c === "string" && c.startsWith("/") ? [c.replace(/\/+$/, "")] : [];
}

/**
 * The roots every worker's checkout and home live under, denied so that one
 * worker cannot read another's.
 *
 * Capacity runs several workers at once under one `identity.worktreeRoot`, and
 * the OS sandbox permits reads outside the checkout: sibling `run-*` directories
 * and `.reeve-worker-home/*` were readable, so a worker could copy another run's
 * unreviewed changes -- or its session state -- into an allowed path and have
 * reeve publish them. (Codex #5-[14].)
 *
 * The ROOT is denied and the current run's own paths are carved back out, which
 * is the only shape that survives a new sibling appearing mid-run: an
 * enumeration of the siblings that existed at policy time would not.
 */
export function siblingRootsOf(profile) {
  const root = profile?.identity?.worktreeRoot;
  return typeof root === "string" && root.startsWith("/") ? [root.replace(/\/+$/, "")] : [];
}

/**
 * Actions whose Bash may reach the network at all, and where the domains come
 * from. Everything else is denied outright: a fixer needs no registry (its
 * dependencies are installed before it is dispatched) and a spec writer needs
 * no web. Research reads the profile's list and nothing else.
 */
/**
 * Quarantined paths as ABSOLUTE OS deny-read entries.
 *
 * `risk.quarantinePaths` are repo-relative globs, and until now they were denied
 * only to the file TOOLS. A fixer is granted `cat` and a language runtime, so a
 * shell read walked straight past them: the worker could copy a production dump
 * into a source file and the diff gate, which judges destination filenames, would
 * pass it. (Codex #4e-[8].)
 *
 * The OS layer takes concrete paths, so each glob is reduced to the segments
 * before its first wildcard and resolved against the worktree. That is
 * deliberately STRICTER than the glob (`data/*.sql` denies all of `data/`),
 * because over-denying a quarantined tree is the safe error. A glob whose FIRST
 * segment is a wildcard has no concrete prefix short of the worktree itself and
 * is reported as unrepresentable: the caller refuses the dispatch rather than
 * pretending the path is covered.
 */
export function quarantineOsDenies(worktree, globs = []) {
  const paths = [], unrepresentable = [];
  for (const g of globs) {
    const clean = String(g).replace(/^\.\//, "");
    const segs = clean.split("/");
    const cut = segs.findIndex(seg => seg.includes("*") || seg.includes("?") || seg.includes("["));
    const prefix = (cut === -1 ? segs : segs.slice(0, cut)).filter(Boolean);
    if (!prefix.length) { unrepresentable.push(g); continue; }
    paths.push(worktree ? join(worktree, ...prefix) : prefix.join("/"));
  }
  return { paths: [...new Set(paths)], unrepresentable };
}

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

/**
 * Does the sandbox refuse this command whatever else it grants?
 *
 * Deny beats allow, so a declared project command can be in the allowlist and
 * still be refused: a profile whose test command is `npm publish` gets
 * `Bash(npm publish:*)` granted from its own declaration and denied by NEVER.
 * The prompt must not offer one of those as an example, and a check that reads
 * only `permissions.allow` cannot tell.
 *
 * Matching is by prefix, because that is how the permission matcher compares.
 */
export function commandDenied(cmd, profile) {
  // Normalised on BOTH sides, because `sandboxFor` builds the granted head by
  // splitting on whitespace -- so `npm   publish` grants `Bash(npm publish:*)`
  // while an unnormalised comparison against the raw string finds no deny and
  // reports it runnable. The grant and the check have to see the same command.
  const flat = s => String(s ?? "").trim().replace(/\s+/g, " ");
  const target = flat(cmd);
  const rules = [...NEVER, ...(profile?.risk?.forbiddenCommands ?? []).map(c => `Bash(${flat(c)}:*)`)];
  return rules.some(rule => {
    const m = /^Bash\((.+):\*\)$/.exec(rule);
    if (!m) return false;
    const prefix = flat(m[1]);
    return target === prefix || target.startsWith(prefix + " ");
  });
}

/**
 * The commands the sandbox refuses, as a worker should read them.
 *
 * Exported because the prompt used to tell the worker that "the rules below say
 * which" specific forms are denied, while rendering only the profile's own
 * `forbiddenCommands` -- so `git remote -v` looked like a qualified allowance and
 * was refused. Naming them is the only version of that sentence that is true, and
 * it is cheaper for the worker than discovering each one by spending a turn.
 */
export function deniedCommands(profile) {
  const own = (profile?.risk?.forbiddenCommands ?? []).filter(c => typeof c === "string" && c.length);
  const built = NEVER.map(rule => /^Bash\((.+):\*\)$/.exec(rule)?.[1]).filter(Boolean);
  return [...new Set([...built, ...own])];
}

/** Utilities that make a checkout readable. A fixer that cannot list a directory
 * is reduced to guessing at filenames. */
const READ_ONLY_UTILITIES = ["ls", "cat", "head", "tail", "wc", "find", "which", "pwd"];

/**
 * The bare command names a worker may run for this profile, before `git` and the
 * interpreter's absolute path are added: the language's runners, the declared
 * package manager, and the read-only utilities.
 *
 * Exported because the worker PROMPT also names commands, in prose, and prose
 * that disagrees with this set is the single most repeated defect measured in
 * this codebase: six times by 2026-08-23, most recently a prompt promising
 * `pnpm test` to a worker granted `npm`. Two derivations can disagree; one,
 * read by both, cannot.
 */
export function projectRunners(profile) {
  const runners = new Set();
  for (const u of profile?.units ?? []) {
    // The language's own runner, because a declared command is often a wrapper.
    // reeve's `npm test` is a shell loop over `node <file>`, and a fixer that
    // cannot run ONE test has to run the whole suite to check a one-line change,
    // or give up -- which is what it did.
    for (const r of RUNTIMES[u.language] ?? []) runners.add(r);
    if (u.packageManager) runners.add(u.packageManager);
  }
  for (const r of READ_ONLY_UTILITIES) runners.add(r);
  // A profile may forbid a command that is otherwise a runner, and deny wins.
  for (const r of [...runners]) if (commandDenied(r, profile)) runners.delete(r);
  return runners;
}

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
export function sandboxFor({ profile, action, worktree, lane = null, tmpDir = null, stateRoots = [] }) {
  const sourceCheckout = sourceCheckoutOf(profile);
  // The shared root, minus this run's own checkout. A worker reads its own
  // directory through the cwd grant and the allowRead carve-out below, so
  // denying the parent costs it nothing and closes every sibling at once.
  const siblingRoots = siblingRootsOf(profile).filter(r => !worktree || (worktree !== r && !r.startsWith(worktree + "/")));
  // The publishing credential the profile names by absolute path: outside every
  // hard-coded credential directory, so it must be denied explicitly or a worker
  // could copy the token into a source file. (Codex #4f-[8].)
  const notifyCred = typeof profile?.notify?.credentialFile === "string" && profile.notify.credentialFile.startsWith("/") ? [profile.notify.credentialFile] : [];
  const risk = profile?.risk ?? {};
  const units = profile?.units ?? [];

  // Commands the project itself declares. A fixer that cannot run the tests
  // cannot tell whether its fix worked, so this is the minimum that makes the
  // work verifiable rather than asserted.
  const projectCmds = [];
  for (const u of units) {
    for (const c of Object.values(u.commands ?? {})) {
      if (!c?.cmd) continue;
      // The runner and its first argument: `pnpm test --watch` must not be
      // reachable merely because `pnpm test` is.
      const head = c.cmd.trim().split(/\s+/).slice(0, 2).join(" ");
      if (head) projectCmds.push(`Bash(${head}:*)`);
    }
  }
  // Shared with the prompt, so the prose and the grant cannot drift apart.
  const runners = projectRunners(profile);

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

  // A closed set. Nothing reaches the network, nothing spawns a shell, and every
  // tool appears with a scope attached.
  //
  // The file tools are scoped to the CHECKOUT, which is not decoration. They are
  // not covered by the OS sandbox at all -- the CLI's own process runs outside
  // the Seatbelt profile it applies to the shells it spawns -- so `Read` granted
  // bare is a grant to read the whole disk, and the deny list is the only thing
  // standing in front of it. Measured 2026-08-22: a worker with a bare `Read`
  // grant read a file the `cp` beside it was refused, in the same run
  // (docs/measured/2026-08-22-the-read-deny-list-was-inert.md).
  //
  // A scope makes the checkout itself the boundary rather than an enumeration of
  // forbidden paths, which is the same reason a worker gets its own clone rather
  // than a list of branches it must not move. The deny list stays as the second
  // layer, and it holds even against a bare grant once the rule form is right.
  const fileTools = action === "FIX_CI" || action === "FIX_FINDINGS"
    ? ["Read", "Edit", "Write", "Grep", "Glob"]
    : ["Read", "Grep", "Glob"];
  const tools = [...scopedFileTools(fileTools, worktree),
                 ...gitTools,
                 ...(action === "FIX_CI" || action === "FIX_FINDINGS" ? [...runnerTools, ...new Set(projectCmds)] : [])];

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

  const quarantine = quarantineOsDenies(worktree, risk.quarantinePaths ?? []);

  // The OS deny list, built once: the read grant above is derived from it.

  const osDenyRead = [...credentialPaths(), ...notifyCred, ...sourceCheckout, ...siblingRoots, ...stateRoots, ...quarantine.paths];

  // The Read tool is not under the OS sandbox, so the credential paths are
  // denied to it here as well; measured to hold for an absolute path and for a
  // symlink inside the worktree that points at one.
  deny.push(...credentialReadDenies());
  // reeve's own state is denied too: with a --log or --db outside ~/.reeve it is
  // not otherwise covered, and a worker could copy another run's output, the
  // event store, or the log into its worktree for reeve to publish.
  // (Codex #4d-[15].) BOTH forms per entry, because a state root may be a FILE
  // (the log, the database): `Read(<file>/**)` matches descendants of it, which
  // a file does not have, so the file itself would stay readable. (Codex #4f-[2].)
  for (const r of stateRoots) { deny.push(`Read(${ruleFor(r)})`); deny.push(`Read(${ruleFor(r)}/**)`); }
  for (const c of notifyCred) deny.push(`Read(${ruleFor(c)})`);
  // Both forms, for the same reason the state roots take both: `Read(<p>/**)`
  // matches descendants, so the directory entry itself would stay readable.
  for (const c of sourceCheckout) { deny.push(`Read(${ruleFor(c)})`); deny.push(`Read(${ruleFor(c)}/**)`); }
  // The shared worktree root is DELIBERATELY not denied here, only in the OS list
  // below.
  //
  // The worker's own checkout is a CHILD of that root, and a deny beats an allow
  // — the same precedence this module relies on everywhere else. Denying the
  // parent at the permission layer therefore refused every Read of the worker's
  // own files, for every worker. MEASURED 2026-08-22 against the real CLI: with
  // the parent denied, `Read ./own-file.txt` in the checkout is refused; without
  // it, it succeeds.
  //
  // Nothing is lost. The file tools are scoped to this checkout, so a sibling is
  // outside the grant and refused for want of one; the OS list is what closes the
  // shell. The canary now reads a file inside the checkout with the Read TOOL,
  // because its own probes only ever read OUTSIDE and could not represent this.
  // (Codex #7-[2].)

  return {
    allowedTools: tools.join(","),
    // Both, on purpose, and they are not redundant. `--disallowedTools` is the
    // flag the CLI documents for this; `permissions.deny` is what the settings
    // file states, so a reader of the sandbox sees the boundary without having to
    // reconstruct the command line. A bare tool name in `deny` removes the tool
    // outright -- which for these is exactly the intent, unlike `Bash`, where the
    // same move was measured to take the scoped grants with it.
    disallowedTools: NEVER_TOOLS.join(","),
    settings: {
      permissions: {
        deny: [...deny, ...NEVER_TOOLS],
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
          // The run's tmp, then the checkout itself WHEN this policy denies
          // something above it — which it does once the shared worktree root is
          // denied so that no worker can read a sibling. Expressed with the same
          // predicate the validator uses, so a grant and its justification can
          // never drift apart.
          allowRead: [...(tmpDir ? [tmpDir] : []), ...carveOuts(osDenyRead, [worktree])],
          denyRead: osDenyRead,
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
    // Non-empty means a quarantine glob could not be enforced at the OS layer;
    // the caller must refuse the dispatch rather than run with a hole.
    unrepresentableQuarantine: quarantine.unrepresentable,
    // A denied path that CONTAINS the worktree denies the worker its own code
    // (and the canary its own script), so containment could never close and the
    // reason would look like a sandbox failure. A layout such as
    // REEVE_HOME=/srv/reeve with worktreeRoot=/srv/reeve/worktrees is a
    // configuration error, and it is named as one. (Codex #4g-[4].)
    stateHomeContainsWorktree: worktree
      ? [...credentialPaths().map(expandTilde), ...sourceCheckout, ...stateRoots].filter(d => d.startsWith("/") && (worktree === d || worktree.startsWith(d.endsWith("/") ? d : d + "/")))
      : [],
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
/**
 * Validate the TOOL GRANT before spawn.
 *
 * `--allowedTools` travels beside the settings file, not inside it, so
 * validateSettings never sees it -- and it is where the file tools are granted.
 * A bare `Read` there is a grant to read the whole disk: the file tools are not
 * covered by the OS sandbox, so nothing else is standing in front of them.
 *
 * Every file tool must therefore carry a scope, and that scope must be the
 * checkout the worker was given. A grant scoped to somewhere else is worse than
 * a bare one, because it looks careful.
 */
/**
 * Scope the file tools in a grant to one directory, leaving everything else be.
 *
 * A prompt spec may name its own tools (SPILL asks for `Read,Grep`), and those
 * strings cannot know the worktree. Rather than refuse them at spawn, they are
 * scoped here, at the one place that knows both. An entry that already carries a
 * scope is left exactly as written -- validateToolGrant then judges whether that
 * scope is the right one, which is a different question from whether one exists.
 */
export function scopeGrant(allowedTools, worktree) {
  const list = String(allowedTools ?? "").split(",").map(t => t.trim()).filter(Boolean);
  return list.flatMap(t => (FILE_TOOLS.has(t) ? scopedFileTools([t], worktree) : [t])).join(",");
}

export function validateToolGrant(allowedTools, { worktree = null } = {}) {
  const errors = [];
  const list = String(allowedTools ?? "").split(",").map(t => t.trim()).filter(Boolean);
  if (!list.length) return { ok: false, errors: ["the tool grant is empty; a worker with no tools cannot fix anything"] };
  if (!worktree) return { ok: false, errors: ["the validator needs the worktree to judge the file-tool scope"] };
  let real = worktree;
  try { real = realpathSync(worktree); } catch { /* judged against the path as given */ }
  const allowed = new Set([ruleFor(real), `${ruleFor(real)}/**`]);
  for (const t of list) {
    const m = /^([A-Za-z]+)(?:\((.*)\))?$/.exec(t);
    if (!m) { errors.push(`unreadable tool grant: ${t}`); continue; }
    const [, name, scope] = m;
    if (!FILE_TOOLS.has(name)) continue;
    if (scope === undefined) { errors.push(`${name} is granted without a scope, which grants it the whole filesystem`); continue; }
    if (!allowed.has(scope)) errors.push(`${name} is scoped to ${scope}, which is not the worker's checkout`);
  }
  return { ok: errors.length === 0, errors };
}

export function validateSettings(settings, { tmpDir = null, stateRoots = [], quarantineDenies = [], extraDenies = [], sourceCheckout = [],
                                            siblingRoots = [], worktree = null, readCarveOuts = [] } = {}) {
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
    if (strs(p.deny)) for (const d of [...credentialReadDenies(), ...extraDenies.map(c => `Read(${ruleFor(c)})`),
                                      // NOT siblingRoots: the worker's own checkout is a child of that
                                      // root, and a deny beats an allow — requiring it here would demand
                                      // the very rule that refuses a worker its own files.
                                      ...[...stateRoots, ...sourceCheckout].flatMap(r => [`Read(${ruleFor(r)})`, `Read(${ruleFor(r)}/**)`])]) if (!p.deny.includes(d)) errors.push(`permissions.deny is missing ${d}`);
    // A rule naming an absolute path with ONE leading slash matches nothing, and
    // says nothing while it does so. Refusing the shape is the only way a
    // regression to it cannot reach a worker. (Measured 2026-08-22.)
    if (strs(p.deny)) for (const d of p.deny) {
      const m = /^[A-Za-z]+\((\/[^/].*)\)$/.exec(d);
      if (m) errors.push(`permissions.deny has an absolute rule with one leading slash, which matches nothing: ${d}`);
    }
    // A permission deny that CONTAINS the worker's checkout refuses the worker
    // its own files, because a deny beats an allow and the file tools are
    // scoped to a child of it. Measured, and it would break every dispatch.
    if (strs(p.deny) && worktree) for (const d of p.deny) {
      const m = /^[A-Za-z]+\(\/(\/[^)]*?)(?:\/\*\*)?\)$/.exec(d);
      if (m && under(worktree, m[1]) && worktree !== m[1])
        errors.push(`permissions.deny has ${d}, which contains the worker's own checkout and would refuse it every read`);
    }
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
      // The run's tmp, and THIS run's own checkout when the policy denies
      // something above it. Nothing else, and a sibling least of all: a sibling
      // is also "under a deny", so a rule that merely required the grant to
      // reopen part of a denied tree would permit exactly the read this exists
      // to stop. The worktree is named, so the check is an equality.
      if (strs(fs.allowRead) && strs(fs.denyRead)) {
        const want = [tmpDir, ...carveOuts(fs.denyRead, [worktree, ...readCarveOuts])];
        if (JSON.stringify(fs.allowRead) !== JSON.stringify(want))
          errors.push(`sandbox.filesystem.allowRead must be exactly ${want.join(", ")}`);
      }
      if (strs(fs.denyRead)) for (const c of [...credentialPaths(), ...extraDenies, ...sourceCheckout, ...siblingRoots, ...stateRoots, ...quarantineDenies]) if (!fs.denyRead.includes(c)) errors.push(`sandbox.filesystem.denyRead is missing ${c}`);
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
// `s`, so `.` matches a NEWLINE. git allows one in a pathname, and without the
// flag `**` compiles to `.*` which stops dead at it: measured 2026-08-23,
// `secrets/**` did not match `secrets/x\nanything` and `reviewDiff` returned ok
// for it, so a worker could put a sensitive or self-governing path beyond every
// deny rule by choosing a filename with a newline in it. `*` compiles to a
// NEGATED class and was never affected, which is why only the `**` forms leaked.
const toRe = glob => new RegExp("^" + glob.split("**")
  .map(seg => seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
  .join(".*") + "$", "s");

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
  // THE SIBLING'S PHASES ARE NOT THIS FUNCTION'S. A report phase produces an
  // artifact and no diff, so it would arrive here with an empty file list and be
  // refused as "the worker produced an empty diff" -- a refusal that reads as the
  // worker's fault and is the gate's. Throwing is deliberate: reaching this
  // function with an artifact phase is a wiring error at the dispatch seam, not
  // an operator condition, and an operator cannot act on it.
  //
  // The phase set is DERIVED from the one place that declares which phases
  // produce an artifact. Listing the three names here would be a second
  // inventory of that map, and it would agree with it right up until a fourth
  // report phase was added -- at which point this guard would silently stop
  // covering the new one.
  if (action !== null && Object.hasOwn(ARTIFACT_FILE, action))
    throw new Error(`${action} produces an artifact, not a diff; reviewArtifact is its gate`);
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
