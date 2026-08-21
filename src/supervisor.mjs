// supervisor — spawn worker lanes, keep them honest, and never leak a process.
//
// Every rule here was measured on this machine, several with negative controls:
//
//   · `spawn(detached:true)` makes the child a process-group LEADER, and
//     `process.kill(-pid)` kills the whole group. The control proved a plain
//     `kill(pid)` ORPHANS the grandchild onto pid 1 — which over an unattended
//     run leaves a growing pile of stranded vitest/tsc/dev-server processes.
//   · SIGTERM runs claude's SessionEnd hook and exits 143 with signal === null.
//     SIGKILL runs nothing. So SIGTERM first, always, and classify 143 as
//     "we terminated it": a supervisor inspecting only `signal` misclassifies
//     every timeout as a clean exit.
//   · pids churn at ~963/s here and a genuine wrap-around reuse was forced in
//     192 seconds, so a stored pid alone eventually names a stranger. The
//     identity token is `ps -o lstart= -p <pid>`.
//   · `--output-format stream-json` REQUIRES `--verbose` under `-p`; without it
//     the process exits 1 having written nothing, which looks exactly like a hang.
//   · a worker whose tool calls were DENIED still exits 0 with is_error:false and
//     writes a plausible answer. `permission_denials` is the only signal.
//   · a 429 hangs the CLI indefinitely (measured 5m33s, no output) because it
//     retries internally. CLAUDE_CODE_MAX_RETRIES bounds it.

import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export const OUTCOMES = {
  OK: "ok",
  FAILED: "failed",               // the worker reported is_error
  DENIED: "denied",               // tools were blocked; the answer is not trustworthy
  TIMEOUT: "timeout",             // we killed it for overrunning its budget
  RATE_LIMITED: "rate_limited",   // the provider refused
  CRASHED: "crashed",             // died without a result event
  CANCELLED: "cancelled",         // halt switch or explicit cancel
};

/** Identity token for a pid. Non-zero exit means dead; a differing string means reused. */
export function readStart(pid) {
  // stderr is piped, not inherited: ps writes "process id too large" for an
  // out-of-range pid, and a liveness probe must not print anything.
  try { return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || null; }
  catch { return null; }
}

/**
 * Is this pid still the process we launched? Only meaningful as a per-pid reuse
 * guard: lstart has one-second granularity, so it is not a global fingerprint.
 * Unnecessary while the worker is still our own unreaped child, because a live
 * child's pid cannot be recycled. It matters after the daemon restarts.
 */
export function isSameProcess(pid, storedStart) {
  const now = readStart(pid);
  return now !== null && now === storedStart;
}

/**
 * Every worker group this process has started and not yet reaped.
 *
 * Workers are spawned DETACHED so their own grandchildren can be group-killed,
 * but detachment cuts both ways: if the supervisor dies, the worker survives it.
 * Measured directly — a supervisor killed mid-dispatch leaves a claude worker,
 * its shell, and whatever build it was running with no parent to stop them.
 * These handlers close that, and they are idempotent because a process can be
 * signalled and then exit normally.
 */
const LIVE_GROUPS = new Set();
let reaperInstalled = false;

function installReaper() {
  if (reaperInstalled) return;
  reaperInstalled = true;
  const reap = () => {
    for (const pid of LIVE_GROUPS) {
      try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
    }
    LIVE_GROUPS.clear();
  };
  process.on("exit", reap);
  // A signalled supervisor must take its workers with it, then die itself.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => { reap(); process.exit(sig === "SIGINT" ? 130 : 143); });
  }
  process.on("uncaughtException", e => { reap(); throw e; });
}

/** Kill a whole process group, swallowing ESRCH. Always the NEGATIVE pid. */
function killGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; }
  catch (e) { if (e.code !== "ESRCH") throw e; return false; }
}

/**
 * Build the argv for a worker. Flags are passed EXPLICITLY, never inherited:
 * an inherited setting is one a future default can silently change.
 */
export function workerArgs({ prompt, cwd, agent = null, allowedTools = null, settingSources = null,
                             settings = null, maxTurns = null, model = null, sessionId = null, resume = null }) {
  const a = ["-p", prompt, "--output-format", "stream-json",
             // Required: without --verbose the process exits 1 and writes NOTHING
             // to stdout, which is indistinguishable from a hang.
             "--verbose"];
  if (agent) a.push("--agent", agent);
  if (model) a.push("--model", model);
  if (maxTurns != null) a.push("--max-turns", String(maxTurns));
  if (allowedTools) a.push("--allowedTools", allowedTools);
  // The deterministic half of the boundary. The allowlist above scopes what may
  // run; this file carries the profile's forbidden commands and quarantined paths
  // as rules the CLI enforces, rather than as prose the model is asked to respect.
  if (settings) a.push("--settings", settings);
  // `--setting-sources project` cuts the preamble ~8x (31,647 -> 3,845 cache-creation
  // tokens, $0.3166 -> $0.0386 for one reply) but strips plugin-shipped agents, so it
  // is only safe for a worker that needs none.
  if (settingSources) a.push("--setting-sources", settingSources);
  if (resume) a.push("--resume", resume);
  else if (sessionId) a.push("--session-id", sessionId);
  return a;
}

/** Parse one stream-json line into something the supervisor acts on. */
export function readEvent(line) {
  let e;
  try { e = JSON.parse(line); } catch { return null; }
  if (e.type === "rate_limit_event") return { kind: "rate_limit", info: e.rate_limit_info ?? {} };
  if (e.type === "system" && e.subtype === "init") return { kind: "init", sessionId: e.session_id };
  if (e.type === "result") return { kind: "result", result: e };
  if (e.type === "assistant") return { kind: "assistant" };
  return { kind: "other", type: e.type };
}

/**
 * Classify a finished worker. `subtype` is "success" even on API and auth
 * failures, so it is never the discriminator.
 */
/**
 * The worker's own account of itself, from the fenced json block every prompt
 * asks it to finish with.
 *
 * That block was written into every prompt and parsed by NOTHING. Measured: a
 * worker correctly declined to fix a failure because the change belonged in a
 * sensitive path, said so in `needsHuman`, and reeve discarded it and told the
 * founder "a fix was produced but refused publication -- the worker produced an
 * empty diff". Two statements that cannot both be true, about a worker that had
 * done exactly the right thing.
 *
 * Trusted for ONE question: why did you stop. Whether anything was actually
 * fixed is answered by git and by CI, never by this -- the actor is not the
 * witness, and that is the rule the whole design rests on. But "why did you
 * stop" has no other witness, and reeve asks for it in every prompt.
 */
export function parseReport(text) {
  if (typeof text !== "string") return null;
  // The LAST block: a worker explaining itself may quote the shape earlier.
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(blocks[i][1]);
      if (o && typeof o === "object" && !Array.isArray(o)) return o;
    } catch { /* try the one before it */ }
  }
  return null;
}

/** What the worker said it needs a human for, or null. Never a bare `true`. */
export function statedBlocker(report) {
  const v = report?.needsHuman;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function classifyResult(result, { code, signal, killedByUs }) {
  if (killedByUs) return { outcome: OUTCOMES.TIMEOUT, why: "exceeded its wall-clock budget" };
  // claude installs its own SIGTERM handler and exits deliberately, so Node
  // reports code 143 with signal null rather than signal 'SIGTERM'.
  if (code === 143 && signal === null) return { outcome: OUTCOMES.TIMEOUT, why: "terminated (exit 143)" };
  if (signal === "SIGKILL") return { outcome: OUTCOMES.TIMEOUT, why: "killed after refusing SIGTERM" };
  if (!result) return { outcome: OUTCOMES.CRASHED, why: `exited ${code} without a result event` };
  if (result.api_error_status === 429) return { outcome: OUTCOMES.RATE_LIMITED, why: "provider returned 429" };
  if (result.is_error) return { outcome: OUTCOMES.FAILED, why: result.terminal_reason ?? result.result ?? "is_error" };
  // Denials are CARRIED, not fatal.
  //
  // The original rule made any refusal disqualify the run, on the grounds that a
  // denied worker exits 0 and writes a plausible account of what it could not do.
  // That reasoning is right about the NARRATIVE and wrong about the artifact, and
  // it made dispatch impossible in practice: a model explores, so given a worktree
  // it eventually reaches outside it. Run 10 was denied exactly once — for
  // `grep … ~/Library/LaunchAgents/…`, a correct refusal — and that threw away a
  // completed run. Waiting for zero denials is waiting for a model that never
  // looks around.
  //
  // reeve never needed the narrative. The diff is reported by git, not by the
  // worker, and CI re-runs at the head reeve publishes. Publication therefore
  // rests on those, and the denials travel with the result so the sandbox can be
  // tuned and a human can see what the worker could not do.
  //
  // What still disqualifies is not knowing what happened at all: a timeout, a
  // crash, an error — each handled above, before this line.
  const denials = result.permission_denials ?? [];
  return { outcome: OUTCOMES.OK, why: result.terminal_reason ?? "completed", denials,
           report: parseReport(result.result) };
}

/**
 * Run one worker to completion or to its budget.
 * Resolves with an outcome; never throws for a worker failure.
 */
export function runWorker({
  bin = "claude", args, cwd, env = {},
  budgetMs = 20 * 60 * 1000,
  graceMs = 5000,
  maxRetries = 1,
  onEvent = () => {},
  // Called once with the worker's pid and identity token, before any output.
  // Without it a caller cannot observe or record a worker until it has already
  // exited, which is exactly when a supervisor most needs to know about it.
  onSpawn = () => {},
  isHalted = () => false,
} = {}) {
  return new Promise(resolve => {
    const child = spawn(bin, args, {
      cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Without this a 429 hangs indefinitely: the CLI retries internally with
        // no output, which reads as a stuck worker rather than a rate limit.
        CLAUDE_CODE_MAX_RETRIES: String(maxRetries),
        ...env,
      },
    });
    installReaper();
    LIVE_GROUPS.add(child.pid);
    const startedAt = Date.now();
    const lstart = readStart(child.pid);
    try { onSpawn({ pid: child.pid, lstart }); } catch { /* an observer must not kill the worker */ }

    let result = null, sessionId = null, rateLimit = null;
    let killedByUs = false, settled = false;
    let stdout = "", stderr = "", buf = "";

    const finish = payload => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer); clearTimeout(killTimer); clearInterval(haltTimer);
      resolve(payload);
    };

    child.stdout.on("data", d => {
      stdout += d;
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const ev = readEvent(line);
        if (!ev) continue;
        if (ev.kind === "init") sessionId = ev.sessionId;
        if (ev.kind === "result") result = ev.result;
        if (ev.kind === "rate_limit") rateLimit = ev.info;
        onEvent(ev);
      }
    });
    child.stderr.on("data", d => { stderr += d; });

    const termTimer = setTimeout(() => {
      killedByUs = true;
      // SIGTERM to the GROUP: the negative pid is what reaches the grandchildren.
      killGroup(child.pid, "SIGTERM");
    }, budgetMs);

    // Escalation only after grace. SIGKILL first would skip SessionEnd entirely.
    const killTimer = setTimeout(() => { if (!settled) killGroup(child.pid, "SIGKILL"); }, budgetMs + graceMs);

    // The halt switch fails CLOSED: a worker in flight is terminated, not left running.
    const haltTimer = setInterval(() => {
      if (isHalted() && !settled) { killedByUs = true; killGroup(child.pid, "SIGTERM"); }
    }, 2000);

    child.on("error", err => { LIVE_GROUPS.delete(child.pid); return finish({
      outcome: OUTCOMES.CRASHED, why: `could not spawn ${bin}: ${err.message}`,
      pid: child.pid, lstart, ms: Date.now() - startedAt, stderr,
    }); });

    child.on("exit", (code, signal) => {
      LIVE_GROUPS.delete(child.pid);
      // The leader can exit while a grandchild lingers, so sweep the group.
      killGroup(child.pid, "SIGKILL");
      const c = classifyResult(result, { code, signal, killedByUs });
      finish({
        ...c, pid: child.pid, lstart, sessionId, code, signal,
        ms: Date.now() - startedAt, rateLimit,
        cost: result?.total_cost_usd ?? null,
        usage: result?.usage ?? null,
        text: result?.result ?? null,
        stderr: stderr.slice(0, 4000),
        stdoutBytes: stdout.length,
      });
    });
  });
}

/**
 * Should the scheduler start more work? Driven by observed load rather than a
 * frozen constant: 10 performance cores here, and the machine already carries a
 * load average around 3.6 from interactive sessions.
 */
export function capacity({ maxWorkers = 5, hardCeiling = 6, running = 0 } = {}) {
  let load1 = 0;
  try { load1 = Number(execFileSync("sysctl", ["-n", "vm.loadavg"], { encoding: "utf8" }).replace(/[{}]/g, "").trim().split(/\s+/)[0]); }
  catch { /* unreadable load is not a reason to over-schedule */ }
  const perfCores = (() => {
    try { return Number(execFileSync("sysctl", ["-n", "hw.perflevel0.logicalcpu"], { encoding: "utf8" }).trim()) || 10; }
    catch { return 10; }
  })();
  // Back off when the machine is already busy, so reeve never competes with the
  // founder's own interactive work.
  const loadHeadroom = Math.max(0, Math.floor(perfCores - load1) - 1);
  const allowed = Math.min(maxWorkers, hardCeiling, loadHeadroom);
  return { allowed, running, canStart: Math.max(0, allowed - running), load1, perfCores };
}

/** Keep the Mac awake for exactly as long as the daemon lives, never longer. */
export function stayAwake(pid = process.pid) {
  if (process.platform !== "darwin") return null;
  // -i prevents system idle sleep while leaving the display free to sleep.
  // -w ties the assertion to this pid, so a crashed daemon cannot leave the Mac
  // permanently unable to sleep.
  const c = spawn("caffeinate", ["-i", "-w", String(pid)], { detached: true, stdio: "ignore" });
  c.unref();
  return c.pid;
}

/** The halt switch. A marker file, so it can be set from a phone over ntfy or ssh. */
export function halted(markerPath) {
  return Boolean(markerPath) && existsSync(markerPath);
}
