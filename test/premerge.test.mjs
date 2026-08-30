// The gate that runs BEFORE a merge, and every way it must refuse to say "clear".
//
// It exists because three pull requests went wrong in three different ways in one
// day: two merged at a head their branch had moved past (the second stranding two
// review fixes), and one merged with a review finding still open. Every check we had
// answered afterwards.
//
// The assertions below are mostly about the states that are NOT clear, because
// "clear" is the easy one and the dangerous failure is a summary line that reads as
// a pass while carrying a reason not to merge.
import { gate, headState, threadState, checkState, CLEAR, REFUSE, UNREVIEWED, UNKNOWN }
  from "../src/premerge.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail !== undefined) console.log("        " + detail); fail++; }
};

const SHA_A = "a".repeat(40), SHA_B = "b".repeat(40);
const resolved = n => Array.from({ length: n }, () => ({ isResolved: true }));

// --- head ------------------------------------------------------------------------
{
  check(headState({ prHead: SHA_A, branchNow: SHA_A, branchRead: "read" }).state === CLEAR,
    "a head equal to the branch tip is clear");

  const moved = headState({ prHead: SHA_A, branchNow: SHA_B, branchRead: "read" });
  check(moved.state === REFUSE, "a head the branch has moved past is refused", moved.why);
  // The WORDING is load-bearing and was corrected once already: unequal tips prove
  // the merge would take an older commit, NOT that anything is missing from main.
  check(!/missing from main|not on main/i.test(moved.why),
    "and the refusal does not claim those commits are missing from the default branch", moved.why);

  check(headState({ prHead: SHA_A, branchNow: null, branchRead: "unreadable" }).state === UNKNOWN,
    "refs that could not be read are UNKNOWN, not clear");
  check(headState({ prHead: SHA_A, branchNow: null, branchRead: "gone" }).state === UNKNOWN,
    "a deleted head branch is UNKNOWN, not clear");
  check(headState({ prHead: null, branchNow: SHA_A, branchRead: "read" }).state === UNKNOWN,
    "an unreadable pull-request head is UNKNOWN, not clear");
  // CONTROL: unreadable and gone are DIFFERENT facts and must not share one sentence.
  check(headState({ prHead: SHA_A, branchNow: null, branchRead: "unreadable" }).why
        !== headState({ prHead: SHA_A, branchNow: null, branchRead: "gone" }).why,
    "control: 'gone' and 'unreadable' give different reasons, so a reader can tell them apart");
}

// --- threads ---------------------------------------------------------------------
{
  check(threadState({ totalCount: 3, nodes: resolved(3) }).state === CLEAR,
    "every thread resolved is clear");

  const open = threadState({ totalCount: 3, nodes: [...resolved(2), { isResolved: false }] });
  check(open.state === REFUSE && open.unresolved.length === 1,
    "an unresolved thread is refused, and named", open.why);

  // THE STATE MOST LIKELY TO BE ARGUED AWAY. An empty list means both "reviewed and
  // nothing raised" and "never reviewed", and merging on the second is not the same
  // decision as merging on the first.
  const none = threadState({ totalCount: 0, nodes: [] });
  check(none.state === UNREVIEWED, "no threads at all is UNREVIEWED, not clear", none.why);
  check(none.state !== CLEAR, "control: and it is specifically NOT the clear state");

  // A page cap makes a partial read look settled. This is the completeness signal.
  const capped = threadState({ totalCount: 120, nodes: resolved(100) });
  check(capped.state === UNKNOWN,
    "a truncated listing is UNKNOWN, because 'none unresolved' would be about a page", capped.why);

  check(threadState({}).state === UNKNOWN, "an absent listing is UNKNOWN, not clear");
  check(threadState({ totalCount: 2, nodes: null }).state === UNKNOWN,
    "a null node list is UNKNOWN, not clear");
}

// --- checks -----------------------------------------------------------------------
{
  const ok = n => Array.from({ length: n }, (_, i) => ({ name: `job${i}`, conclusion: "SUCCESS" }));
  check(checkState({ nodes: ok(3) }).state === CLEAR, "all checks succeeded is clear");

  const failed = checkState({ nodes: [...ok(2), { name: "Stub sweep", conclusion: "FAILURE" }] });
  check(failed.state === REFUSE && /Stub sweep/.test(failed.why),
    "a failing check is refused, and named", failed.why);

  // THE WINDOW THIS EXISTS FOR. A pull request merged on this repository while its
  // checks were still pending, so nothing about that commit was established.
  const pending = checkState({ nodes: [...ok(1), { name: "Test", conclusion: null, state: null }] });
  check(pending.state === UNKNOWN, "an unfinished check is UNKNOWN, not clear", pending.why);

  // Same shape as an empty thread list: nothing failing is not something passing.
  const none = checkState({ nodes: [] });
  check(none.state === UNKNOWN, "no checks at all is UNKNOWN, not clear", none.why);
  check(checkState({}).state === UNKNOWN, "an unreadable rollup is UNKNOWN, not clear");

  // CONTROL: the three not-clear reasons are distinguishable, or a reader cannot
  // tell "still running" from "never ran" from "could not read".
  const reasons = new Set([pending.why, none.why, checkState({}).why]);
  check(reasons.size === 3, "control: unfinished, absent and unreadable give three different reasons",
    JSON.stringify([...reasons]));

  for (const conclusion of ["TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"])
    check(checkState({ nodes: [{ name: "j", conclusion }] }).state === REFUSE,
      `a ${conclusion} check is refused rather than treated as merely not-success`);
}

// --- a legacy status context reports progress in `state`, not `conclusion` --------
{
  // THE ONE THAT CLEARED THE GATE. A StatusContext has no conclusion at all and
  // reports PENDING or EXPECTED in `state`. Reading "has a value" as "finished" put
  // it in neither the unfinished set nor the failing set, so a pull request whose
  // only status was still pending was reported CLEAR with "all checks succeeded" --
  // the gate defeated through the shape it did not enumerate.
  for (const state of ["PENDING", "EXPECTED"]) {
    const r = checkState({ nodes: [{ context: "ci/legacy", state }] });
    check(r.state === UNKNOWN, `a legacy status in ${state} is UNKNOWN, not clear`, r.why);
  }
  check(checkState({ nodes: [{ context: "ci/legacy", state: "FAILURE" }] }).state === REFUSE,
    "a legacy status in FAILURE is refused");
  check(checkState({ nodes: [{ context: "ci/legacy", state: "SUCCESS" }] }).state === CLEAR,
    "control: a legacy status in SUCCESS is clear, so the shape is understood and not merely rejected");
  // SUCCESS is named positively, so a state nobody anticipated cannot pass.
  check(checkState({ nodes: [{ name: "j", conclusion: "SOME_FUTURE_STATE" }] }).state === UNKNOWN,
    "an unrecognised conclusion is UNKNOWN rather than treated as success");
}

// --- a terminal conclusion is not an unfinished one -------------------------------
{
  // STALE is terminal: the run will never complete. Reporting it as "has not
  // finished" tells automation to wait for something that will not arrive, so a
  // caller keying on the verdict codes retries for ever. The distinction that
  // matters is not success-versus-failure but whether anything further will happen.
  const stale = checkState({ nodes: [{ name: "j", conclusion: "STALE" }] });
  check(stale.state === REFUSE, "a STALE check run is refused, not reported as unfinished", stale.why);
  // CONTROL: an actually-unfinished run is still UNKNOWN, so this is about
  // terminality and not about widening the failure set until nothing is unfinished.
  check(checkState({ nodes: [{ name: "j", conclusion: null, status: "IN_PROGRESS" }] }).state === UNKNOWN,
    "control: a genuinely running check is still UNKNOWN");
}

// --- the rollup gets the same completeness rule as the threads --------------------
{
  // This rule was applied to threads and not to checks: the connection added last
  // did not inherit it. A hundred passing checks beside one omitted pending one read
  // as CLEAR, which is the gate defeated by its own missing check.
  const ok = n => Array.from({ length: n }, (_, i) => ({ name: `job${i}`, conclusion: "SUCCESS" }));
  const capped = checkState({ nodes: ok(100), totalCount: 120 });
  check(capped.state === UNKNOWN, "a truncated check rollup is UNKNOWN, not clear", capped.why);
  check(checkState({ nodes: ok(3), totalCount: 3 }).state === CLEAR,
    "control: a complete rollup still clears, so the check is about truncation and not about counting at all");
}

// --- the combined verdict never rounds up ----------------------------------------
{
  const bothClear = gate({ head: { prHead: SHA_A, branchNow: SHA_A, branchRead: "read" },
                           threads: { totalCount: 1, nodes: resolved(1) },
                           checks: { nodes: [{ name: "j", conclusion: "SUCCESS" }] } });
  check(bothClear.state === CLEAR && bothClear.clear === true,
    "control: when both halves are clear the gate is clear", JSON.stringify(bothClear.why));

  // Each half is checked for dominance separately, because a gate that only reports
  // the FIRST problem gets one fixed and is surprised by the other.
  const headBad = gate({ head: { prHead: SHA_A, branchNow: SHA_B, branchRead: "read" },
                         threads: { totalCount: 1, nodes: resolved(1) },
                           checks: { nodes: [{ name: "j", conclusion: "SUCCESS" }] } });
  check(headBad.state === REFUSE && !headBad.clear, "a stale head refuses even with threads clear");

  const threadsBad = gate({ head: { prHead: SHA_A, branchNow: SHA_A, branchRead: "read" },
                            threads: { totalCount: 1, nodes: [{ isResolved: false }] },
                            checks: { nodes: [{ name: "j", conclusion: "SUCCESS" }] } });
  check(threadsBad.state === REFUSE && !threadsBad.clear, "an open thread refuses even with the head current");

  const unreviewed = gate({ head: { prHead: SHA_A, branchNow: SHA_A, branchRead: "read" },
                            threads: { totalCount: 0, nodes: [] },
                            checks: { nodes: [{ name: "j", conclusion: "SUCCESS" }] } });
  check(unreviewed.state === UNREVIEWED && !unreviewed.clear,
    "an unreviewed pull request is not clear even with a current head", JSON.stringify(unreviewed.why));

  // UNKNOWN outranks UNREVIEWED: not knowing is worse than knowing nobody looked.
  const unknownWins = gate({ head: { prHead: SHA_A, branchNow: null, branchRead: "unreadable" },
                             threads: { totalCount: 0, nodes: [] },
                            checks: { nodes: [{ name: "j", conclusion: "SUCCESS" }] } });
  check(unknownWins.state === UNKNOWN, "UNKNOWN outranks UNREVIEWED");

  const refuseWins = gate({ head: { prHead: SHA_A, branchNow: null, branchRead: "unreadable" },
                            threads: { totalCount: 1, nodes: [{ isResolved: false }] },
                            checks: { nodes: [{ name: "j", conclusion: "SUCCESS" }] } });
  check(refuseWins.state === REFUSE, "REFUSE outranks UNKNOWN, so the worst news wins");

  // BOTH reasons are always reported, whichever won.
  check(refuseWins.why.length === 3 && refuseWins.why.some(w => w.startsWith(UNKNOWN))
        && refuseWins.why.some(w => w.startsWith(REFUSE)),
    "and both halves are reported, not only the one that decided the verdict",
    JSON.stringify(refuseWins.why));

  // The one thing no summary line may do.
  for (const g of [headBad, threadsBad, unreviewed, unknownWins, refuseWins])
    if (g.clear) { check(false, "a non-clear verdict never reports clear:true", g.state); break; }
  check(true, "no non-clear verdict reports clear:true");
}

console.log(fail ? `\nFAILED ${fail}` : "\nok");
process.exit(fail ? 1 : 0);
