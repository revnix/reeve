// GitHub as a test's tick finds it: out of reach (#243).
//
// The tick reads GitHub through seams a test fills: `openPrs`, `evaluate`,
// `observe`, `reconcile`, `resolveCause`, `mergeRate` and more. A seam a test
// leaves empty calls gh, for a repository that doesn't exist. These stand-ins
// answer as those reads answer when GitHub can't be reached, which is what an
// empty seam met in CI, where gh has no login. So a test that spreads them into
// its context keeps the behavior it had, without the call.
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { observe } from "../../src/review/ingest.mjs";
import { cleanMergeRate } from "../../src/status.mjs";

// The folder holding the tests' offline gh, which the runner and CI put first
// on every test's PATH.
export const OFFLINE_GH_DIR = join(dirname(fileURLToPath(import.meta.url)), "offline-gh");

// The environment for a process a test starts whose own reads of GitHub the
// test doesn't measure, such as a reeve it runs: the offline gh comes first on
// its PATH, so those reads meet GitHub out of reach, whether or not the test
// runs under the runner. They're that process's reads, not the test reaching
// GitHub, so they aren't written down for the runner.
export function offlineEnv(env = process.env) {
  const out = { ...env, PATH: `${OFFLINE_GH_DIR}${delimiter}${env.PATH ?? ""}` };
  delete out.REEVE_TEST_GH_LOG;
  return out;
}

const WHY = "a test never reaches GitHub";
const unanswered = () => ({ ok: false, out: "", err: WHY });

// For a function that takes its reads as `io`: `gh` and `api` for a REST read,
// `sh` for a gh command, each failing as a read GitHub didn't answer.
export const OFFLINE_IO = Object.freeze({ gh: unanswered, api: unanswered, sh: unanswered });

export const OFFLINE_READS = Object.freeze({
  // What reconcilePr returns for a read that failed. It writes nothing first.
  reconcile: () => ({ ok: false, why: WHY }),
  // What rootCause returns when its first read fails.
  resolveCause: () => ({ ok: false, why: WHY }),
  // What flakeEvidence returns when its read of the run's attempts fails.
  flakeProbe: () => ({ flake: false, why: "single attempt; no evidence either way", attempts: 0 }),
  // The real reads, each given a GitHub that doesn't answer.
  observe: (nwo, pr) => observe(nwo, pr, OFFLINE_IO),
  mergeRate: (nwo, n, _probe, options) => cleanMergeRate(nwo, n, { merged: () => null, checks: () => null }, options),
  // The head's tree, for the subject of a verdict's evidence (#165): unreadable,
  // which the record keeps as unknown.
  treeOf: () => null,
});
