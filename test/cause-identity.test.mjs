// A red revision usually reports MORE THAN ONE failing check: the job that broke,
// and the aggregate gate that refuses because it broke. The daemon read only the
// first of those.
//
// Measured on revnix/reeve PR #2: both `CI Gate` and `Test` failed, and the cause
// stored against the fix-attempt ledger was
//
//   revnix/reeve::CI Gate::Refuse anything that is not a success::
//   .github:10|CI Gate refuses: test concluded 'failure'
//
// Every word of that is constant. Whatever breaks, the gate refuses with the same
// sentence, so:
//
//   1. two unrelated failures share ONE identity. The retry brake counts attempts
//      against that identity, so the second distinct failure reads as the first one
//      surviving a fix, and reeve escalates "the same failure survived a second fix"
//      about work it has never attempted.
//   2. the worker's WHAT FAILED section names no cause. Run 12 succeeded only
//      because the prompt separately tells the worker to reproduce the failure
//      itself -- the root-cause tier contributed nothing.
//
// The fix reads every failing check, preferring the ones this pull request caused,
// and builds both the identity and the prompt from all of them.
import { causeKey, resolveFailureCause } from "../src/ci-rootcause.mjs";
import { fixCiPrompt } from "../src/prompts.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const NWO = "revnix/reeve";

// The aggregate gate: the SAME annotation whatever the underlying failure was.
const GATE = {
  ok: true, source: "annotations", job: "CI Gate",
  step: "Refuse anything that is not a success",
  cause: [{ where: ".github:10", message: "CI Gate refuses: test concluded 'failure'" }],
};

const testJob = (where, message) => ({
  ok: true, source: "annotations", job: "Test", step: "Run the suite",
  cause: [{ where, message }],
});

// Two genuinely different failures, behind an identical gate.
const A = testJob("test/notify.test.mjs:45", "an enormous message is truncated");
const B = testJob("test/worktree.test.mjs:88", "a dirty checkout is refused");

// GitHub returns the gate first, which is exactly why reading only the first failed.
const checksFor = () => ({
  failing: [{ name: "CI Gate", id: 1 }, { name: "Test", id: 2 }],
  caused: ["CI Gate", "Test"],
});
const resolverFor = specific => (_nwo, chk) => (chk.id === 1 ? GATE : specific);

// ── the control: the fixture must be able to exhibit the defect ───────────────
//
// Without this the assertions below would pass just as happily against a fixture
// where the two scenarios were never similar in the first place.

const oldSelect = (nwo, checks, resolve) => {
  const f = checks.failing.find(x => (checks.caused ?? []).includes(x.name)) ?? checks.failing[0];
  const rc = resolve(nwo, f);
  return rc.ok ? causeKey(nwo, rc) : null;
};

const oldA = oldSelect(NWO, checksFor(), resolverFor(A));
const oldB = oldSelect(NWO, checksFor(), resolverFor(B));
check(oldA !== null && oldA === oldB,
  "control: reading only the first failing check gives two different failures ONE identity", oldA);

// ── the property ─────────────────────────────────────────────────────────────

const rA = resolveFailureCause(NWO, checksFor(), resolverFor(A));
const rB = resolveFailureCause(NWO, checksFor(), resolverFor(B));

check(rA.fp && rB.fp && rA.fp !== rB.fp,
  "two different failures behind one gate get different identities",
  `A=${rA.fp}\n        B=${rB.fp}`);

check(rA.fp.includes("notify.test.mjs:45"),
  "the identity names the job that actually broke, not only the gate", rA.fp);

check(rA.fp.includes("CI Gate"),
  "and still carries the gate, so a change in WHICH checks fail is also a new identity", rA.fp);

// ── order independence ───────────────────────────────────────────────────────
//
// The identity is a database key. If it depended on the order GitHub happened to
// return checks in, the brake would grant a free retry at random.

const reversed = { failing: [{ name: "Test", id: 2 }, { name: "CI Gate", id: 1 }], caused: ["CI Gate", "Test"] };
check(resolveFailureCause(NWO, reversed, resolverFor(A)).fp === rA.fp,
  "the identity does not depend on the order the checks arrived in");

// ── caused checks are read before inherited ones ─────────────────────────────

const inherited = {
  failing: [{ name: "Flaky ancillary", id: 9 }, { name: "Test", id: 2 }],
  caused: ["Test"],
};
const seen = [];
resolveFailureCause(NWO, inherited, (_n, chk) => { seen.push(chk.name); return chk.id === 2 ? A : GATE; }, 1);
check(seen.length === 1 && seen[0] === "Test",
  "with a budget of one, the check this PR caused is the one that gets read", seen.join(","));

// ── a check with no job behind it cannot be read ─────────────────────────────

const noJob = { failing: [{ name: "some commit status", id: null }], caused: [] };
check(resolveFailureCause(NWO, noJob, () => A).cause === null,
  "a commit status has no job behind it, so there is nothing to root-cause");

// ── single-cause identities are unchanged ────────────────────────────────────
//
// Fix attempts already recorded against a one-check repository must keep counting.
// A key that silently changed shape would refund every brake in the store at once.

const single = { failing: [{ name: "Test", id: 2 }], caused: ["Test"] };
check(resolveFailureCause(NWO, single, () => A).fp === causeKey(NWO, A),
  "a lone failing check produces exactly the key it produced before");

// ── the worker is told what actually failed ──────────────────────────────────

const prompt = fixCiPrompt({
  profile: { ci: { commands: { test: "npm test" } } },
  nwo: NWO, pr: 2, head: "abc123", branch: "test/x", cause: rA.cause,
});

check(prompt.includes("an enormous message is truncated"),
  "the prompt names the assertion that broke");
check(prompt.includes("[Test]") && prompt.includes("[CI Gate]"),
  "and attributes each line to its job, so the worker knows which to reproduce");

// A prompt built from one cause must not grow an attribution prefix it never had.
const lone = fixCiPrompt({
  profile: { ci: { commands: { test: "npm test" } } },
  nwo: NWO, pr: 2, head: "abc123", branch: "test/x", cause: A,
});
check(lone.includes("  test/notify.test.mjs:45  an enormous message is truncated"),
  "a single-cause prompt keeps its plainer, unattributed shape",
  lone.split("\n").find(l => l.includes("notify.test.mjs")) ?? "(the line is missing entirely)");

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
