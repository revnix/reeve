// Supervisor behaviour. The process tests use /bin/sh rather than claude: they
// are about signals and process groups, and a real worker would cost money to
// prove the same thing.
import { runWorker, classifyResult, workerArgs, readEvent, readStart, isSameProcess, capacity, OUTCOMES }
  from "../src/supervisor.mjs";
import { spawn, execFileSync } from "node:child_process";

let fail = 0;
const check = (n, got, want) => { const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) { console.log(`        got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); fail++; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ── argv ──────────────────────────────────────────────────────────────────
{
  const a = workerArgs({ prompt: "hi", settings: "/tmp/s.json" });
  // Without --verbose the CLI exits 1 having written NOTHING to stdout, which is
  // indistinguishable from a hang. It must never be optional.
  check("--verbose is always present", a.includes("--verbose"), true);
  check("stream-json is always present", a.includes("stream-json"), true);
  const b = workerArgs({ prompt: "hi", settings: "/tmp/s.json", agent: "reviewer", model: "opus", maxTurns: 5, allowedTools: "Read" });
  check("flags are passed explicitly, never inherited",
    ["--agent", "--model", "--max-turns", "--allowedTools"].every(f => b.includes(f)), true);
}

// ── result classification ─────────────────────────────────────────────────
const R = o => classifyResult(o, { code: 0, signal: null, killedByUs: false }).outcome;

check("a clean result is ok", R({ is_error: false, subtype: "success", permission_denials: [] }), OUTCOMES.OK);

// subtype is "success" even on API and auth failures, so it is never the discriminator.
check("is_error beats a 'success' subtype",
  R({ is_error: true, subtype: "success", terminal_reason: "auth" }), OUTCOMES.FAILED);

// A denied worker exits 0, reports is_error:false, and writes a plausible answer
// explaining what it could not run — so its ACCOUNT of itself is worthless. That
// was once read as "the run is worthless", which made dispatch impossible: a model
// explores, so given a worktree it eventually reaches outside it, and one correct
// refusal threw away a finished run.
//
// The account was never what reeve relied on. The diff comes from git and CI
// re-runs at the published head, so the artifact is checked independently.
// Denials now travel with the result — they are how the sandbox gets tuned, and a
// worker denied its own tests produced something nothing verified.
//
// See test/denial-policy.test.mjs for the whole contract.
check("a finished run is OK even when a call was refused",
  R({ is_error: false, subtype: "success", permission_denials: [{ tool: "Bash" }] }), OUTCOMES.OK);

check("a 429 is its own outcome",
  R({ is_error: true, subtype: "success", api_error_status: 429 }), OUTCOMES.RATE_LIMITED);

check("no result event at all is a crash",
  classifyResult(null, { code: 1, signal: null, killedByUs: false }).outcome, OUTCOMES.CRASHED);

// claude installs its own SIGTERM handler, so Node reports code 143 with signal
// null. A supervisor inspecting only `signal` calls every timeout a clean exit.
check("exit 143 with a null signal is a timeout, not a clean exit",
  classifyResult({ is_error: false, permission_denials: [] }, { code: 143, signal: null, killedByUs: false }).outcome,
  OUTCOMES.TIMEOUT);
check("a SIGKILLed worker is a timeout",
  classifyResult(null, { code: null, signal: "SIGKILL", killedByUs: false }).outcome, OUTCOMES.TIMEOUT);

// ── stream parsing ────────────────────────────────────────────────────────
check("a rate_limit_event is recognised",
  readEvent(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } })).kind, "rate_limit");
check("an init event yields the session id",
  readEvent(JSON.stringify({ type: "system", subtype: "init", session_id: "abc" })).sessionId, "abc");
check("a malformed line is skipped, not thrown on", readEvent("{not json"), null);
// Six hook events preceded init in the measured stream, so init is not first.
check("an unknown system subtype does not break parsing",
  readEvent(JSON.stringify({ type: "system", subtype: "hook_started" })).kind, "other");

// ── liveness ──────────────────────────────────────────────────────────────
{
  const s = readStart(process.pid);
  check("this process has a start time", typeof s === "string" && s.length > 0, true);
  check("it is stable across reads", readStart(process.pid), s);
  check("the same pid with the right token is the same process", isSameProcess(process.pid, s), true);
  // pids churn at ~963/s here and wrap in ~192s, so a stored pid alone
  // eventually names a stranger's process.
  check("the same pid with a stale token is NOT", isSameProcess(process.pid, "Thu Jan  1 00:00:00 1970"), false);
  check("a dead pid has no start time", readStart(999999), null);
}

// ── the group kill, with its control ──────────────────────────────────────
{
  // A worker that overruns, holding a grandchild. Group kill must take both.
  const r = await runWorker({
    bin: "/bin/sh",
    args: ["-c", 'sleep 300 & echo "GRANDCHILD=$!"; wait'],
    budgetMs: 1500, graceMs: 800,
  });
  check("an overrunning worker is a timeout", r.outcome, OUTCOMES.TIMEOUT);
  const gc = Number(String(r.text ?? "").match(/GRANDCHILD=(\d+)/)?.[1] ?? 0);
  // Fall back to parsing what the shell printed if the result field is unused.
  check("we recorded the worker's pid", typeof r.pid === "number", true);
  if (gc) check("the grandchild died with the group", alive(gc), false);
}
{
  // NEGATIVE CONTROL: signalling the positive pid orphans the grandchild onto
  // pid 1. This is the leak the group kill exists to prevent, and without this
  // control the test above proves nothing.
  const child = spawn("/bin/sh", ["-c", 'sleep 60 & echo $!; wait'], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const gcPid = await new Promise(res => child.stdout.once("data", d => res(Number(String(d).trim()))));
  try { process.kill(child.pid, "SIGKILL"); } catch {}
  await new Promise(r => setTimeout(r, 300));
  check("CONTROL: a plain kill(pid) orphans the grandchild", alive(gcPid), true);
  try { process.kill(gcPid, "SIGKILL"); } catch {}
  await new Promise(r => setTimeout(r, 200));
  check("CONTROL: the orphan is reapable directly", alive(gcPid), false);
}
{
  // A worker inside its budget is not killed.
  const r = await runWorker({ bin: "/bin/sh", args: ["-c", 'echo hi; exit 0'], budgetMs: 5000 });
  // No result event from /bin/sh, so this is CRASHED by design: the classifier
  // requires a result event and does not infer success from exit 0.
  check("exit 0 without a result event is still not 'ok'", r.outcome, OUTCOMES.CRASHED);
  check("and it was not killed by us", r.code, 0);
}
{
  // The halt switch terminates work in flight rather than letting it finish.
  const r = await runWorker({ bin: "/bin/sh", args: ["-c", "sleep 60"], budgetMs: 60000, isHalted: () => true });
  check("the halt switch stops a worker in flight", r.outcome, OUTCOMES.TIMEOUT);
}

// ── capacity ──────────────────────────────────────────────────────────────
{
  const c = capacity({ maxWorkers: 5, hardCeiling: 6, running: 0 });
  check("capacity never exceeds the hard ceiling", c.allowed <= 6, true);
  check("capacity is never negative", c.allowed >= 0, true);
  const busy = capacity({ maxWorkers: 5, hardCeiling: 6, running: 99 });
  check("nothing starts when already over capacity", busy.canStart, 0);
}


// A supervisor that is itself killed must take its workers with it. Workers are
// spawned detached so their grandchildren can be group-killed, but detachment
// cuts both ways: without a reaper, killing the supervisor leaves the worker, its
// shell and whatever build it was running with no parent to stop them.
{
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const supScript = join(mkdtempSync(join(tmpdir(), "reeve-sup-")), "sup.mjs");
  const modPath = new URL("../src/supervisor.mjs", import.meta.url).pathname;
  writeFileSync(supScript, [
    'import { runWorker } from ' + JSON.stringify(modPath) + ';',
    'runWorker({ bin: "/bin/sh", args: ["-c", "sleep 120"], budgetMs: 60000,',
    '  onSpawn: ({ pid }) => { process.stdout.write(String(pid) + "\\n"); } });',
    'setInterval(() => {}, 60000);',
  ].join("\n"));

  const sup = spawn(process.execPath, [supScript], { stdio: ["ignore", "pipe", "ignore"] });
  const workerPid = await new Promise(res => sup.stdout.once("data", d => res(Number(String(d).trim().split("\n")[0]))));
  // The piped stdout holds a handle open, which would keep this test process
  // alive forever after the child is gone.
  sup.stdout.destroy();
  sup.unref();
  await new Promise(r => setTimeout(r, 500));
  check("the worker is running before the supervisor dies", alive(workerPid), true);
  sup.kill("SIGTERM");
  await new Promise(r => setTimeout(r, 1500));
  check("killing the supervisor takes the worker with it", alive(workerPid), false);
  try { process.kill(workerPid, "SIGKILL"); } catch {}
  try { sup.kill("SIGKILL"); } catch {}
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
