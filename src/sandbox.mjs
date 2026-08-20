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

/** The paths that judge the work. A worker editing these grades its own exam. */
const SELF_GOVERNING = [".github/**", ".git/**"];

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
 * The deterministic policy for one worker.
 *
 * Returns the closed tool allowlist and a settings object to hand the CLI with
 * `--settings`. `additionalDirectories` is deliberately empty: the worker runs
 * with its worktree as the working directory, and adding anything to that widens
 * the only boundary keeping it inside its own checkout.
 */
export function sandboxFor({ profile, action, worktree, lane = null }) {
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

  const gitTools = [...GIT_READ, ...GIT_WRITE].map(g => `Bash(git ${g}:*)`);
  const runnerTools = [...runners].map(r => `Bash(${r}:*)`);

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
    ...(risk.sensitivePaths ?? []).flatMap(denyAllVerbs),
    ...SELF_GOVERNING.flatMap(denyAllVerbs),
  ];

  return {
    allowedTools: tools.join(","),
    settings: {
      permissions: {
        deny,
        allow: tools.filter(t => t.startsWith("Bash(")),
        // Empty on purpose. The worktree is the boundary.
        additionalDirectories: [],
      },
    },
    worktree,
    lane: lane?.id ?? null,
  };
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
export function reviewDiff({ files, profile, lane = null }) {
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

  const sensitive = list.filter(f => matchesAny(f, risk.sensitivePaths));
  if (sensitive.length)
    return { ok: false, why: `sensitive path(s) changed and need a human: ${sensitive.join(", ")}`, files: sensitive };

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
