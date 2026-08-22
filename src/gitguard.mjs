// gitguard — how reeve runs git in a directory a worker has held.
//
// This module used to own the whole linked-worktree lifecycle: acquire, verify,
// release, publish. Workers now run in standalone clones (checkout.mjs), which
// close the shared-ref and shared-config holes by construction, so that
// lifecycle has no caller and is gone. Keeping it would have been worse than
// dead weight: its tests kept passing, which reads as coverage of the path
// dispatch actually takes.
//
// What survives is the part that is still load-bearing, and is about git rather
// than about worktrees:
//
//   · the neutralising `-c` flags every daemon git command carries, because a
//     worker's repository config can name programs git RUNS;
//   · the configuration fingerprint, taken when reeve builds the checkout and
//     verified before the daemon runs anything else in it;
//   · the pre-push hook a checkout carries.

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";

/**
 * Git configuration that makes git RUN something. A worker holds an unrestricted
 * `git` grant inside its checkout, and several config keys are documented as
 * invoking a program: `core.fsmonitor` (a pathname is run as a hook),
 * `core.hooksPath`, the pagers and editors, `diff.external`, `core.sshCommand`,
 * the pack hooks, and credential helpers. Every one of those would execute as
 * the DAEMON user the moment reeve ran `git status` in that checkout, outside
 * the sandbox. Command-line `-c` beats repository config, so every daemon git
 * command in worker-controlled directories is prefixed with these.
 * (Codex #4f-[6].)
 *
 * `-c` cannot blanket-clear `filter.<name>.clean`, whose driver name comes from
 * the repository's own .gitattributes, so the fingerprint check below is what
 * actually closes this: the daemon refuses to run git at all in a checkout whose
 * configuration the worker changed.
 */
const NEUTRALISE_ANYWHERE = [
  // A replacement ref rewrites what git SHOWS without touching what a push
  // carries: a worker can `git replace <pinned-head> <fake>` so every diff the
  // daemon takes reports an innocuous change, while the branch it publishes
  // holds the real commits. The configuration fingerprint cannot see this — a
  // replacement is a ref, not a config key. (Codex #5-[16].)
  "--no-replace-objects",
  "-c", "core.fsmonitor=",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.pager=cat",
  "-c", "core.editor=true",
  "-c", "sequence.editor=true",
  "-c", "diff.external=",
  "-c", "uploadpack.packObjectsHook=",
];

/**
 * And these, which only a WORKER-CONTROLLED directory carries.
 *
 * Every key here decides how git REACHES A REMOTE. Applied to the founder's own
 * repository they do not harden anything — there is no hostile content there —
 * and they break the two operations reeve exists to perform. Measured
 * 2026-08-22 against this repository, whose origin is https and whose
 * credentials come from a global `credential.https://github.com.helper`:
 *
 *     $ git ls-remote origin refs/heads/main
 *     aad542c…  refs/heads/main
 *     $ <the same, under these and no global config>
 *     fatal: could not read Username for 'https://github.com'
 *
 * So every fetch, every ls-remote and every push reeve would make on the
 * founder's behalf failed to authenticate. A global `url.<base>.insteadOf`
 * rewrite — SSH rewrites, corporate proxies — is the same shape of breakage
 * from the other direction. (Codex #7-[10].)
 */
const NEUTRALISE_WORKER_ONLY = [
  "-c", "core.sshCommand=",
  "-c", "core.askPass=",
  "-c", "credential.helper=",
  "-c", "protocol.ext.allow=never",
];

const NEUTRALISE = [...NEUTRALISE_ANYWHERE, ...NEUTRALISE_WORKER_ONLY];

/**
 * The environment every daemon git command in a worker-controlled directory runs
 * under: no global config, no system config.
 *
 * `-c` can only override keys it NAMES, and a filter driver's name comes from
 * the repository's own `.gitattributes`. So a `filter.<anything>.smudge` in the
 * founder's global config is invoked by a checkout of PR-controlled content,
 * unsandboxed, as the daemon, BEFORE the worker starts — and the configuration
 * fingerprint cannot protect an operation that already happened. Taking the
 * files out of git's reach removes the whole class rather than a list of names.
 * (Codex #5-[19].)
 */
export const GIT_ISOLATED_ENV = Object.freeze({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
});

/**
 * The env for a daemon git call in a WORKER-CONTROLLED directory: the real
 * environment with the isolation above layered on.
 */
export function gitEnv(extra = {}) {
  return { ...withoutInjectedConfig(), ...GIT_ISOLATED_ENV, ...extra };
}

/**
 * The env for a daemon git call in the FOUNDER's own repository.
 *
 * The founder's configuration is kept, because that is where the remote's URL,
 * its rewrites and its credential helper live and reeve is acting as the
 * founder when it fetches and pushes.
 *
 * `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` are dropped only when they hold
 * REEVE'S OWN isolation value, so a daemon launched with them already at
 * /dev/null cannot reproduce the breakage this exists to avoid, silently. Any
 * other value is a founder naming where their configuration lives — a company
 * file supplying the rewrite or the credential helper — and deleting it puts
 * git back on a `~/.gitconfig` that may carry neither. Measured 2026-08-23:
 * `ls-remote` resolves through an explicit `GIT_CONFIG_GLOBAL` and fails the
 * moment it is dropped. (Codex #10-[3].)
 *
 * What the founder's repository does not have is a terminal. A missing
 * credential must fail and be reported, not wait for an answer nobody is there
 * to give.
 */
export function founderGitEnv(extra = {}) {
  const env = withoutInjectedConfig();
  for (const k of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"])
    if (env[k] === GIT_ISOLATED_ENV[k]) delete env[k];
  return { ...env, GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", ...extra };
}

/**
 * The daemon's environment with git's CONFIGURATION-INJECTION variables removed.
 * Both callers strip these, because they are how a config key reaches git
 * without a config FILE.
 *
 * `GIT_CONFIG_COUNT` with its `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` pairs, and
 * `GIT_CONFIG_PARAMETERS`, are applied by git INDEPENDENTLY of the global and
 * system files — so pointing those files at /dev/null closes nothing if the
 * daemon was launched with a filter driver injected that way, and a pull
 * request's `.gitattributes` can then name it. Inheriting them is the same hole
 * the file isolation exists to shut. (Codex #7-[1].)
 */
function withoutInjectedConfig() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    // `GIT_CONFIG` is here as insurance, not as a measured hole. Its own
    // documentation says it applies to `git config` and "has no effect on other
    // Git commands", and measured on git 2.50.1 an injected smudge driver did
    // NOT run through it, for a clone or a checkout. A reviewer reported
    // otherwise on 2.43. Rather than depend on a promise about every version and
    // vendor of git this daemon might meet, it is dropped: it costs nothing and
    // reeve has no use for it. (Codex #7-[4], not reproduced here.)
    if (k === "GIT_CONFIG" || k === "GIT_CONFIG_COUNT" || k === "GIT_CONFIG_PARAMETERS"
        || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete env[k];
  }
  return env;
}

function git(cwd, args) {
  try {
    return { ok: true, out: execFileSync("git", ["-C", cwd, ...NEUTRALISE, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv() }).trim() };
  } catch { return { ok: false, out: "" }; }
}

/**
 * The line of git's stderr that says what actually went wrong.
 *
 * git narrates on stderr as it works, so the LAST line is often progress, not
 * the failure. Reporting it gave "Preparing worktree (resetting branch …)" as the
 * reason a checkout could not be created, when the real cause two lines up was
 * "cannot force update the branch … used by worktree at /tmp/…". A wrong reason
 * is worse than a vague one: it sends the reader somewhere else entirely.
 */
export function reason(stderr) {
  const lines = String(stderr ?? "").split("\n").map(l => l.trim()).filter(Boolean);
  return lines.find(l => /^(fatal|error):/i.test(l)) ?? lines.at(-1) ?? "git failed with no message";
}

/** The exported prefix, so every other daemon git call can use the same one. */
export const GIT_NEUTRALISE = NEUTRALISE;

/** The same, for a command whose repository is the FOUNDER's: everything that
 * stops git running a program, and nothing that decides how it reaches a
 * remote. */
export const GIT_NEUTRALISE_FOUNDER = NEUTRALISE_ANYWHERE;

/** The pre-push hook every worker checkout carries. It refuses unconditionally. */
export const REFUSING_HOOK = "#!/bin/sh\necho 'this checkout does not publish; reeve publishes after the diff gate' >&2\nexit 1\n";

/**
 * The repository's configuration as entries, shared and worktree-scoped. Taken
 * when reeve builds the checkout, and compared before the daemon runs any other
 * git command in it.
 *
 * Entries rather than a hash, because the REASON matters when they differ: the
 * refusal names the key, and a named key is something a human can act on.
 */
export function configEntries(path) {
  const out = {};
  for (const scope of ["--local", "--worktree"]) {
    const r = git(path, ["config", scope, "--list"]);
    out[scope] = r.ok ? r.out.split("\n").filter(Boolean).sort() : [];
  }
  return out;
}

const keyOf = line => line.slice(0, line.indexOf("=")).toLowerCase();

const fingerprintPath = path => `${path}.cfg`;

/** Record the configuration beside the checkout (outside it, where the sandbox denies writes). */
export function recordConfig(path) {
  try { writeFileSync(fingerprintPath(path), JSON.stringify(configEntries(path))); return true; } catch { return false; }
}

/**
 * Has the repository configuration changed since reeve built the checkout?
 * An unreadable record is a refusal, not a pass: without the baseline there is
 * no way to say the config is the one reeve wrote.
 *
 * ANY difference is the worker's. The linked-worktree version carried an
 * allowlist of keys reeve writes itself, because a daemon upgrade re-hardened a
 * worktree it had made earlier and legitimately rewrote them. A run checkout is
 * built once and never re-hardened — preparing over an existing one refuses —
 * so nothing but the worker can move a key after the baseline is taken, and an
 * allowlist would only have let a worker overwrite the two keys reeve sets as
 * containment layers without the check saying a word.
 */
export function verifyConfig(path) {
  let recorded = null;
  try { recorded = JSON.parse(readFileSync(fingerprintPath(path), "utf8")); } catch { return { ok: false, keys: [], why: "no recorded git configuration to compare against" }; }
  const now = configEntries(path);
  const foreign = new Set();
  for (const scope of ["--local", "--worktree"]) {
    const before = new Set(recorded[scope] ?? []), after = new Set(now[scope] ?? []);
    for (const line of [...before].filter(l => !after.has(l)).concat([...after].filter(l => !before.has(l)))) foreign.add(keyOf(line));
  }
  if (foreign.size) return { ok: false, keys: [...foreign], why: `the worker changed this checkout's git configuration (${[...foreign].slice(0, 3).join(", ")}), which git would execute` };
  return { ok: true, keys: [], why: null };
}
