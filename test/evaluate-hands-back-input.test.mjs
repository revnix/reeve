// evaluatePr hands back the exact input its verdict was computed from (#165).
//
// The tick records that input as the verdict's evidence, and `reeve replay`
// recomputes the verdict from it, so it has to be the whole input as it was
// given: the verdict recomputed from it is the verdict evaluatePr returned.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluatePr, clearRequirements } from "../src/pr.mjs";
import { computeVerdict } from "../src/verdict.mjs";
import { open } from "../src/db/ops.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const HEAD = "a".repeat(40), BASE = "b".repeat(40);
const runJson = (name, conclusion) => JSON.stringify({ name, status: "completed", conclusion, id: 1,
  completed_at: new Date().toISOString(), app: { slug: "github-actions", id: 1 } });

// gh and git stand-ins on the PATH, as test/ci-read-completely.test.mjs has them:
// gh answers on the request path, one JSON value per line; git answers ls-remote
// with the base's head. The head's CI failed, and its base's passed.
function withFakes(fn) {
  const bin = tempDir("reeve-eval-bin-");
  const path = process.env.PATH;
  const page = JSON.stringify({ data: { repository: { pullRequest: { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", reviewDecision: null,
    reviews: { totalCount: 0 }, reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
  const answers = `  */commits/${BASE}/check-runs*) echo '${runJson("CI Gate", "success")}';;
  */commits/${BASE}/status*) ;;
  */check-runs*) echo '${runJson("CI Gate", "failure")}';;
  */status*) ;;
  */check-suites*) echo '[{"app":{"slug":"github-actions"},"status":"completed"}]';;`;
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nfor a in "$@"; do case "$a" in repos/*|graphql) p="$a";; esac; done\ncase "$p" in\n  graphql) echo '${page}';;\n${answers}\n  *) ;;\nesac\n`, { mode: 0o755 });
  writeFileSync(join(bin, "git"), `#!/bin/sh\n[ "$1" = ls-remote ] && printf '%s\\trefs/heads/main\\n' ${BASE}\nexit 0\n`, { mode: 0o755 });
  try {
    process.env.PATH = `${bin}:${path}`;
    clearRequirements();
    return fn();
  } finally { process.env.PATH = path; }
}

test("evaluatePr hands back the input its verdict was computed from, whole", () => {
  const db = open(join(tempDir("reeve-eval-db-"), "state.db"));
  const profile = { ci: { requiredChecks: [], reviewerStatusContexts: [] }, reviewers: [] };
  const anchor = { ok: true, headRef: "feature", baseRef: "main", state: "OPEN", title: "t", updatedAt: "2026-09-25T00:00:00Z",
                   head: HEAD, pin: { ok: true, sha: HEAD }, authorLogin: "someone" };
  const e = withFakes(() => evaluatePr({ nwo: "o/r", pr: 7, profile, db, anchor }));
  db.close();
  assert.equal(e.ok, true, e.why);
  assert.equal(e.input?.head, HEAD);
  assert.deepEqual(computeVerdict(e.input), e.verdict);
});
