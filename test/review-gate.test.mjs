// The review half of the loop is executable but its data is not real.
//
// `unspilledCritical` is hard-coded to 0 in evaluatePr, and the severity gate
// reads `R.unspilledCritical > 0`. So the clause that exists to honour a standing
// ruling -- criticals are NEVER spilled to a follow-up, they escalate -- could not
// fire, while SPILL fires on `unspilledCritical === 0`, which was always true.
// reeve would have spilled P0 findings to a follow-up PR and called it policy.
//
// `rounds.n` is derived from the latest reviewed head per reviewer, so one
// reviewer can complete twenty rounds and the count still reads one.
//
// Neither is a thing to patch around in the watcher. Until review ingest exists,
// these actions must not be reachable at all, and "not built" must not look like
// "nothing to do".
import { nextAction, ACTIONS } from "../src/watcher.mjs";
import { CLAUSE_IDS } from "../src/verdict.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const cl = (id, state, detail = "") => ({ id, state, detail });
// DERIVED from the one declaration, so a clause added later is exercised here
// too rather than silently absent from every case in this file.
const all = () => CLAUSE_IDS.map(id => cl(id, "PASS"));
const swap = (id, state, detail) => all().map(c => (c.id === id ? cl(id, state, detail) : c));
const ev = (clauses, rounds) => ({
  pr: 1, state: "open",
  verdict: { state: clauses.some(c => c.state === "BLOCK") ? "BLOCK"
                   : clauses.some(c => c.state === "UNKNOWN") ? "UNKNOWN" : "PASS", clauses, summary: "x" },
  rounds: rounds ?? { n: 1, softCap: 5, hardCap: 10, unspilledCritical: null },
  checks: {},
});
const OFF = { rounds: { softCap: 5, hardCap: 10 }, authority: { policy: "propose_and_merge" }, watch: {} };
const ON  = { ...OFF, watch: { reviewActions: true } };

// --- gated off by default ----------------------------------------------------
for (const [name, clauses] of [
  ["a PR with no review verdict", swap("review", "BLOCK", "no verdict at this head")],
  ["a PR with blocking findings", swap("findings", "BLOCK", "2 findings open")],
  ["a PR past the soft cap",      swap("threads", "BLOCK", "unresolved threads")],
]) {
  const d = nextAction(ev(clauses), OFF);
  check(d.action === ACTIONS.ESCALATE,
    `${name} escalates rather than dispatching a review action`, JSON.stringify(d));
  check(/review/i.test(d.why ?? "") && /not built|not enabled|human/i.test(d.why ?? ""),
    "  and says plainly that the review half is not built", JSON.stringify(d.why));
}

// --- the control: nothing else changed --------------------------------------
{
  const d = nextAction(ev(all()), OFF);
  check(d.action === ACTIONS.MERGE, "control: a green PR is unaffected by the gate", JSON.stringify(d.action));
}
{
  const d = nextAction(ev(swap("ci", "BLOCK", "failing: CI Gate")), OFF);
  check(d.action !== ACTIONS.ESCALATE || /review/i.test(d.why ?? "") === false,
    "control: a CI failure is still handled by the CI path, not swallowed by the gate", JSON.stringify(d));
}

// --- and when it IS enabled, the severity rule must hold ---------------------
{
  // unknown criticals must never be read as "no criticals". Spilling on an
  // unknown is exactly the ruling this is meant to enforce, inverted.
  const d = nextAction(ev(swap("threads", "BLOCK", "t"), { n: 6, softCap: 5, hardCap: 10, unspilledCritical: null }), ON);
  check(d.action !== ACTIONS.SPILL,
    "past the soft cap with an UNKNOWN critical count, reeve does not spill", JSON.stringify(d));
}
{
  const d = nextAction(ev(swap("threads", "BLOCK", "t"), { n: 6, softCap: 5, hardCap: 10, unspilledCritical: 0 }), ON);
  check(d.action === ACTIONS.SPILL,
    "control: past the soft cap with a KNOWN zero criticals, spilling is correct", JSON.stringify(d));
}
{
  const d = nextAction(ev(swap("threads", "BLOCK", "t"), { n: 6, softCap: 5, hardCap: 10, unspilledCritical: 2 }), ON);
  check(d.action !== ACTIONS.SPILL, "and criticals are never spilled", JSON.stringify(d));
}

// ── the gated key is an identity, not a report ───────────────────────────────
//
// Measured on nextly #1128: the gated why embedded the threads clause detail, so
// the escalation key read "...cannot act on \"13 of 17 thread(s) unresolved\"".
// Another session resolving threads changed the count, the count changed the key,
// and a changed key is a NEW escalation -- three phone pushes in one morning for
// one unchanged condition. The founder was being paged about PROGRESS.
{
  const d13 = nextAction(ev(swap("threads", "BLOCK", "13 of 17 thread(s) unresolved")), OFF);
  const d23 = nextAction(ev(swap("threads", "BLOCK", "23 of 27 thread(s) unresolved")), OFF);

  // Control: the fixture must exhibit the defect's precondition — both are the
  // gated FIX_FINDINGS path, and their clause details genuinely differ.
  check(d13.action === ACTIONS.ESCALATE && d13.gated === ACTIONS.FIX_FINDINGS,
    "control: an unresolved-threads block is the gated FIX_FINDINGS path", JSON.stringify(d13));

  check(d13.why === d23.why,
    "the key does not move when the thread count does", `${d13.why}\n        ${d23.why}`);
  check(!/\d/.test(d13.why), "and carries no number at all", d13.why);
  check(/unresolved review threads/.test(d13.why),
    "while still saying WHICH action is missing", d13.why);
  check(/13 of 17/.test(d13.detail ?? ""),
    "the count survives on the detail, where a human reads it deliberately", d13.detail);

  // Different GATED ACTIONS are different problems and must key differently.
  const rr = nextAction(ev(swap("review", "UNKNOWN", "not yet run: codex")), OFF);
  check(rr.action === ACTIONS.ESCALATE && rr.why !== d13.why,
    "a gated review request keys differently from gated thread work", rr.why);
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
