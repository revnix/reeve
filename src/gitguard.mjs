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
const NEUTRALISE = [
  "-c", "core.fsmonitor=",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.pager=cat",
  "-c", "core.editor=true",
  "-c", "sequence.editor=true",
  "-c", "core.sshCommand=",
  "-c", "core.askPass=",
  "-c", "diff.external=",
  "-c", "uploadpack.packObjectsHook=",
  "-c", "credential.helper=",
  "-c", "protocol.ext.allow=never",
];

function git(cwd, args) {
  try {
    return { ok: true, out: execFileSync("git", ["-C", cwd, ...NEUTRALISE, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
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
