// What reeve enqueues for a SPILL, instead of asking a worker to do it.
//
// The findings that reach the cap are moved to ONE follow-up issue so they survive
// the parent merging. The interesting assertions are not that the issue is created --
// they are about the DEPENDENCY EDGE and about the findings that have no thread,
// because those are the two places this can be wrong while looking right.
import { spillEffects, issueBody, isBodyFinding } from "../src/outbox/spill.mjs";
import { open, tx, enqueueWithDependants } from "../src/db/ops.mjs";
import { resolveDependencyArgs, needsDependency } from "../src/outbox/depends.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail !== undefined) console.log("        " + detail); fail++; }
};

const NWO = "o/r", PR = 42, HEAD = "a".repeat(40), FP = "fp1";
const thread = (id, over = {}) => ({ thread_id: id, path: "src/a.mjs", line: 7,
                                     body: `finding ${id}`, anchor: "thread", ...over });
const bodyFinding = { anchor: "body", body: "stated in the review body" };
const build = (findings, over = {}) =>
  spillEffects({ nwo: NWO, pr: PR, head: HEAD, fingerprint: FP, findings, ...over });

// --- the shape ------------------------------------------------------------------
{
  const { parent, dependants, threaded, carried } = build([thread("T1"), thread("T2")]);
  check(parent.kind === "gh.issue.create", "one issue is created, not one per finding");
  check(dependants.length === 4, "and each THREAD gets a reply and a resolve", String(dependants.length));
  check(threaded === 2 && carried === 2, "control: both findings were threaded", `${threaded}/${carried}`);
  check(dependants.filter(d => d.kind === "gh.pr.comment").length === 2 &&
        dependants.filter(d => d.kind === "gh.thread.resolve").length === 2,
    "one comment and one resolve each, not two of either");
}

// --- a finding with no thread gets no reply and no resolve -----------------------
{
  // It is carried into the issue like the rest. Replying to it would be a comment
  // posted at nothing, and resolving it would resolve a thread that does not exist.
  const { dependants, threaded, carried } = build([thread("T1"), bodyFinding]);
  check(carried === 2 && threaded === 1,
    "a body finding is carried but not threaded", `${threaded} of ${carried}`);
  check(dependants.length === 2, "so it produces no reply and no resolve", String(dependants.length));
  check(issueBody({ nwo: NWO, pr: PR, head: HEAD, findings: [bodyFinding] })
          .includes("stated in the review body"),
    "control: and its text really is in the issue, so it is deferred rather than dropped");
}

// --- the permalink is pinned, and absent when there is nothing to point at -------
{
  const body = issueBody({ nwo: NWO, pr: PR, head: HEAD, findings: [thread("T1"), bodyFinding] });
  check(body.includes(`/blob/${HEAD}/src/a.mjs#L7`),
    "a finding that names a file gets a permalink pinned to the head", body.slice(0, 160));
  check(!/blob\/[a-f0-9]{40}\/\s|blob\/[a-f0-9]{40}$/m.test(body),
    "and a finding with no path gets no link rather than one aimed at the repository root");
  // Pinned rather than branch-relative: the issue outlives the parent, and a branch
  // link resolves to whatever that branch becomes.
  check(!body.includes("/blob/main/") && !body.includes(`/blob/${PR}/`),
    "control: the link names the head sha, not a branch");
}

// --- the edge, end to end through the real outbox --------------------------------
{
  const db = open(join(mkdtempSync(join(tmpdir(), "spill-")), "s.db"));
  const { parent, dependants } = build([thread("T1")]);
  const { parentId, childIds } = tx(db, () => enqueueWithDependants(db, parent, dependants));
  const rows = db.prepare("SELECT kind, depends_on FROM outbox ORDER BY id").all();
  check(rows[0].kind === "gh.issue.create" && rows[0].depends_on === null,
    "the issue depends on nothing", JSON.stringify(rows[0]));
  check(rows.slice(1).every(r => r.depends_on === parentId),
    "and every reply and resolve depends on it", JSON.stringify(rows));
  check(childIds.length === 2, "control: both dependants were actually enqueued");

  // THE TOKEN IS UNRESOLVED UNTIL THE PARENT DELIVERS, which is the point of the
  // edge: the reply cannot name an issue number before one exists.
  const comment = dependants.find(d => d.kind === "gh.pr.comment");
  check(needsDependency(comment.args), "the reply carries a dependency token", JSON.stringify(comment.args));
  const filled = resolveDependencyArgs(comment.args, { number: 1234 });
  check(filled.body.includes("#1234") && !filled.body.includes("${dep."),
    "which is substituted from the parent's result at delivery", filled.body);
}

// --- the key is the FINDINGS, so a push does not re-file and a change does -------
{
  const a = build([thread("T1")]);
  const b = build([thread("T1")], { head: "b".repeat(40) });
  check(a.parent.idemKey === b.parent.idemKey,
    "a new head does not file a second issue for the same findings", a.parent.idemKey);
  const c = build([thread("T1")], { fingerprint: "fp2" });
  check(a.parent.idemKey !== c.parent.idemKey,
    "but a changed finding set does", `${a.parent.idemKey} vs ${c.parent.idemKey}`);
  // CONTROL: the keys within one spill are distinct, or the second thread's reply
  // would collide with the first's and silently never be enqueued.
  const many = build([thread("T1"), thread("T2")]);
  const keys = new Set([many.parent.idemKey, ...many.dependants.map(d => d.idemKey)]);
  check(keys.size === 5, "control: every effect in one spill has its own key", String(keys.size));
}

// --- it refuses rather than building a half-formed spill -------------------------
{
  for (const missing of ["nwo", "pr", "head", "fingerprint"]) {
    const args = { nwo: NWO, pr: PR, head: HEAD, fingerprint: FP, findings: [] };
    delete args[missing];
    let threw = false;
    try { spillEffects(args); } catch { threw = true; }
    check(threw, `a spill with no ${missing} refuses rather than enqueuing something wrong`);
  }
}

console.log(fail ? `\nFAILED ${fail}` : "\nok");
process.exit(fail ? 1 : 0);
