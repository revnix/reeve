// home — the reeve home, resolved in ONE place.
//
// Six modules resolved it for themselves and they did not agree. `bin/reeve`
// read `process.env.REEVE_HOME ?? ~/.reeve`; `credentialPaths()` read the
// environment raw and treated an unset one as "no state root to deny"; the
// canary decoy spelled the default out again; `init` used `~/.reeve/profiles`
// and consulted neither the flag NOR the environment; and the App credentials
// were a module-level constant built from `homedir()` at import time.
//
// That divergence was not cosmetic. When `--home` was added, only `bin/reeve`
// learned about it, so a command could run against an explicit home while the
// sandbox denied a DIFFERENT root and the canary measured its decoy under
// `~/.reeve` -- and a canary that measures the wrong tree can report
// containment CLOSED for a policy that does not contain anything.
//
// So: one resolver, and `bin/reeve` writes the answer back into
// `process.env.REEVE_HOME` before any route runs. That makes the flag and the
// environment variable the same mechanism rather than two, which is what stops
// a seventh site from diverging -- there is nothing left to forget to thread.
// The cost is that every consumer must read the home LAZILY: a module-level
// constant is evaluated at import, which is before `bin/reeve`'s body runs.
// `test/cli-flags.test.mjs` asserts both halves.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** `~/.reeve`, the home when nothing else says otherwise. */
export const DEFAULT_HOME = () => join(homedir(), ".reeve");

/**
 * The reeve home: an explicit choice, else the environment, else the default.
 *
 * ABSOLUTE, always. A relative `REEVE_HOME` used to be dropped by
 * `credentialPaths()`'s own `startsWith("/")` guard, so a state root named
 * `state/` was silently left readable by every worker -- the one case where the
 * sandbox's answer depended on how the operator had spelled the path.
 */
export function resolveHome(explicit = null) {
  return resolve(explicit ?? process.env.REEVE_HOME ?? DEFAULT_HOME());
}
