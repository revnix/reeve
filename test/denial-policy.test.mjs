// Any denied tool call disqualified the whole run, and that made dispatch
// effectively impossible.
//
// A model explores. Given a worktree it will eventually reach for something
// outside it — run 10 was denied exactly once, for
// `grep -rn ProgramArguments ~/Library/LaunchAgents/…`, which is a CORRECT
// refusal — and that single correct refusal threw away a completed run. Across
// ten dispatches the denial count fell 11 → 5 → 6 → 0 → 1 → 1, and the last two
// were refusals working as intended. Waiting for zero is waiting for a model that
// never explores.
//
// The original reasoning was sound but aimed at the wrong object: a denied worker
// exits 0 and writes a plausible account of what it could not run, so its NARRATIVE
// cannot be trusted. reeve never needed the narrative. It has the diff, which git
// reports rather than the worker, and it has CI re-running at the head it
// publishes. Those verify the artifact.
//
// So denials are recorded and reported, and publication rests on evidence:
// the process finished, and the diff passes the gate. What must still disqualify
// is not knowing what the worker did — a timeout, a crash, an error.
import { classifyResult, OUTCOMES } from "../src/supervisor.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const exited = { code: 0, signal: null, killedByUs: false };
const denial = cmd => ({ tool_name: "Bash", tool_input: { command: cmd } });

// --- a completed run with denials is usable, and says what was refused --------
{
  const r = classifyResult({ is_error: false, terminal_reason: "completed",
    permission_denials: [denial("grep -rn x ~/Library/LaunchAgents/y")] }, exited);
  check(r.outcome === OUTCOMES.OK,
    "a run that FINISHED is OK even though a call was refused", JSON.stringify(r.outcome));
  check((r.denials ?? []).length === 1,
    "and the refusal is carried, not discarded — it is how the sandbox gets tuned", JSON.stringify(r.denials));
}
{
  const r = classifyResult({ is_error: false, terminal_reason: "completed", permission_denials: [] }, exited);
  check(r.outcome === OUTCOMES.OK && (r.denials ?? []).length === 0,
    "control: a clean run is OK with no denials", JSON.stringify(r));
}

// --- what MUST still disqualify: not knowing what happened -------------------
{
  const r = classifyResult({ is_error: false, permission_denials: [denial("x")] },
                           { code: 143, signal: null, killedByUs: true });
  check(r.outcome === OUTCOMES.TIMEOUT,
    "a worker killed for exceeding its budget is NOT usable, denials or not", JSON.stringify(r));
}
{
  const r = classifyResult(null, { code: 1, signal: null, killedByUs: false });
  check(r.outcome === OUTCOMES.CRASHED, "a crash with no result event is not usable", JSON.stringify(r));
}
{
  const r = classifyResult({ is_error: true, terminal_reason: "max_turns" }, exited);
  check(r.outcome === OUTCOMES.FAILED,
    "a run that ended in error is not usable — max_turns means it stopped mid-task", JSON.stringify(r));
}
{
  const r = classifyResult({ is_error: false, api_error_status: 429 }, exited);
  check(r.outcome === OUTCOMES.RATE_LIMITED, "a 429 is its own outcome, not a failure to fix");
}

// --- the invariant this must not break ---------------------------------------
// Publication never rests on the worker's own account of itself. The reason a
// denial no longer disqualifies is that something else checks the artifact, so
// the outcome alone must never be sufficient.
{
  const r = classifyResult({ is_error: false, terminal_reason: "completed",
    result: "I fixed everything, all tests pass.",
    permission_denials: [denial("pnpm test")] }, exited);
  check(r.outcome === OUTCOMES.OK, "a worker denied its TESTS still reports OK at the process level");
  check((r.denials ?? []).some(d => /pnpm test/.test(d.tool_input?.command ?? "")),
    "but the fact that it could not verify itself is recorded and must reach a human",
    JSON.stringify(r.denials));
  check(!/all tests pass/.test(JSON.stringify(r.why ?? "")),
    "and its own claim about itself is never the reason", JSON.stringify(r.why));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
