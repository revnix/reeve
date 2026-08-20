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
                             maxTurns = null, model = null, sessionId = null, resume = null }) {
  const a = ["-p", prompt, "--output-format", "stream-json",
             // Required: without --verbose the process exits 1 and writes NOTHING
             // to stdout, which is indistinguishable from a hang.
             "--verbose"];
  if (agent) a.push("--agent", agent);
  if (model) a.push("--model", model);
  if (maxTurns != null) a.push("--max-turns", String(maxTurns));
  if (allowedTools) a.push("--allowedTools", allowedTools);
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
export function classifyResult(result, { code, signal, killedByUs }) {
  if (killedByUs) return { outcome: OUTCOMES.TIMEOUT, why: "exceeded its wall-clock budget" };
  // claude installs its own SIGTERM handler and exits deliberately, so Node
  // reports code 143 with signal null rather than signal 'SIGTERM'.
  if (code === 143 && signal === null) return { outcome: OUTCOMES.TIMEOUT, why: "terminated (exit 143)" };
  if (signal === "SIGKILL") return { outcome: OUTCOMES.TIMEOUT, why: "killed after refusing SIGTERM" };
  if (!result) return { outcome: OUTCOMES.CRASHED, why: `exited ${code} without a result event` };
  if (result.api_error_status === 429) return { outcome: OUTCOMES.RATE_LIMITED, why: "provider returned 429" };
  if (result.is_error) return { outcome: OUTCOMES.FAILED, why: result.terminal_reason ?? result.result ?? "is_error" };
  // A denied tool call still exits 0 with is_error false, and the model writes a
  // plausible answer explaining what it could not run. Trusting that answer is
  // the fail-open here.
  const denials = result.permission_denials ?? [];
  if (denials.length) return { outcome: OUTCOMES.DENIED, why: `${denials.length} tool call(s) denied`, denials };
  return { outcome: OUTCOMES.OK, why: result.terminal_reason ?? "completed" };
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
    const startedAt = Date.now();
    const lstart = readStart(child.pid);

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

    child.on("error", err => finish({
      outcome: OUTCOMES.CRASHED, why: `could not spawn ${bin}: ${err.message}`,
      pid: child.pid, lstart, ms: Date.now() - startedAt, stderr,
    }));

    child.on("exit", (code, signal) => {
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
