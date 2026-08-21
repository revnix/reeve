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
import { existsSync, mkdirSync, openSync, writeSync, closeSync, readSync, fstatSync } from "node:fs";
import { dirname } from "node:path";

export const OUTCOMES = {
  OK: "ok",
  FAILED: "failed",               // the worker reported is_error
  DENIED: "denied",               // tools were blocked; the answer is not trustworthy
  TIMEOUT: "timeout",             // we killed it for overrunning its budget
  RATE_LIMITED: "rate_limited",   // the provider refused
  CRASHED: "crashed",             // died without a result event
  CANCELLED: "cancelled",         // halt switch or explicit cancel
  UNBOUND: "unbound",             // pid+lstart could not be recorded; the worker was killed unobserved
  LEASE_LOST: "lease_lost",       // the run lease expired or was taken; the worker was terminated
};

/** Identity token for a pid. Non-zero exit means dead; a differing string means reused. */
export function readStart(pid) {
  // stderr is piped, not inherited: ps writes "process id too large" for an
  // out-of-range pid, and a liveness probe must not print anything.
  try { return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || null; }
  catch { return null; }
}

/** The last `n` bytes of a file, read from the end: a 64 MiB stderr must not be decoded whole for a 4 KB tail. */
function tailOf(path, n) {
  let fd = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(n, size);
    const b = Buffer.alloc(len);
    readSync(fd, b, 0, len, size - len);
    return b.toString("utf8");
  } catch { return ""; }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } } }
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
  // A child whose spawn failed has no pid; there is no group to kill, and
  // `process.kill(-NaN)` would throw inside whatever called us.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(-pid, signal); return true; }
  catch (e) { if (e.code !== "ESRCH") throw e; return false; }
}

/**
 * Build the argv for a worker. Flags are passed EXPLICITLY, never inherited:
 * an inherited setting is one a future default can silently change.
 *
 * `settings` is REQUIRED. It used to default to null, and a resume that did not
 * re-pass it relaunched a worker with no denylist and no sandbox at all -- the
 * CLI does not carry `--settings` across `--resume`. An optional parameter that
 * guards a safety rule is the class of defect that bit four times in one day;
 * this one is removed rather than asserted around.
 *
 * The three isolation flags are unconditional: the founder's user settings carry
 * broad permissions, plugins, and MCP servers a worker must never inherit.
 */
export function workerArgs({ prompt, settings, agent = null, allowedTools = null, disallowedTools = null,
                             settingSources = "local", maxTurns = null, model = null, effort = null,
                             maxBudgetUsd = null, jsonSchema = null, agents = null, mcpConfig = null,
                             sessionId = null, resume = null }) {
  if (typeof settings !== "string" || !settings.length)
    throw new Error("workerArgs: settings is required; a worker without its settings file has no sandbox");
  const a = ["-p", prompt, "--output-format", "stream-json",
             // Required: without --verbose the process exits 1 and writes NOTHING
             // to stdout, which is indistinguishable from a hang.
             "--verbose",
             // Nothing ambient: no user CLAUDE.md, hooks, plugins, MCP servers,
             // custom agents, or Chrome. What the worker gets is what is passed.
             "--safe-mode", "--strict-mcp-config", "--no-chrome",
             "--settings", settings];
  if (mcpConfig) a.push("--mcp-config", mcpConfig);
  if (agent) a.push("--agent", agent);
  if (agents) a.push("--agents", agents);
  if (model) a.push("--model", model);
  if (effort) a.push("--effort", effort);
  if (maxTurns != null) a.push("--max-turns", String(maxTurns));
  if (maxBudgetUsd != null) a.push("--max-budget-usd", String(maxBudgetUsd));
  if (allowedTools) a.push("--allowedTools", allowedTools);
  if (disallowedTools) a.push("--disallowedTools", disallowedTools);
  if (jsonSchema) a.push("--json-schema", jsonSchema);
  // `--safe-mode` leaves permissions alone by the CLI's own description, so the
  // founder's user-level allow rules (and the target repo's project file) would
  // still merge into the worker. `local` is the one source that names neither;
  // the worker's rules come from the --settings file above and nothing else.
  // (`project` was measured to cut the preamble ~8x but also loads the repo's
  // own permissions; a caller that wants it must ask.)
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
  if (e.type === "system" && e.subtype === "init") return { kind: "init", sessionId: e.session_id, model: e.model ?? null };
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
  bin = "claude", args, cwd, env,
  outPath = null, errPath = null, maxOutputBytes = 64 * 1024 * 1024,
  budgetMs = 20 * 60 * 1000,
  graceMs = 5000,
  onEvent = () => {},
  // Called once with the worker's pid and identity token, before any output.
  // Without it a caller cannot observe or record a worker until it has already
  // exited, which is exactly when a supervisor most needs to know about it.
  onSpawn = () => {},
  isHalted = () => false,
  // Asked every poll: a non-null answer is the reason the worker's lease is
  // gone, and the worker is terminated with it.
  isRevoked = () => null,
  // The identity reader, injectable for the test that makes it fail; the
  // default is the real `ps` read and a null answer is a refused binding.
  readStart: readStartOf = readStart,
} = {}) {
  // The environment is EXACT. It used to be `{...process.env, ...env}`, which
  // handed every worker the founder's tokens and the ssh agent; see workerenv.mjs.
  if (!env || typeof env !== "object") throw new Error("runWorker: env is required; a worker never inherits the supervisor's environment");
  if (!outPath || !errPath) throw new Error("runWorker: outPath and errPath are required; a worker's output must survive the supervisor");
  return new Promise(resolve => {
    // Output goes to durable files, not memory: a restart reads the report from
    // the file, and a worker that prints without end cannot take the supervisor
    // down. Past the cap, bytes are dropped and the drop is recorded.
    mkdirSync(dirname(outPath), { recursive: true });
    mkdirSync(dirname(errPath), { recursive: true });
    const outFd = openSync(outPath, "w"), errFd = openSync(errPath, "w");
    // Each stream has its own cap and its own count: a chatty stderr must not
    // spend stdout's budget, and stdoutBytes must mean stdout.
    const streams = { out: { fd: outFd, written: 0, truncated: false }, err: { fd: errFd, written: 0, truncated: false } };
    let buf = "", writeError = null;
    const write = (s, chunk) => {
      if (writeError) return;
      if (s.written + chunk.length > maxOutputBytes) { s.truncated = true; return; }
      // A write that fails (disk full, a mount gone) throws inside a stream
      // callback, where nothing awaits it; unhandled, it would take the daemon
      // down. It ends this worker instead, with the reason.
      try { writeSync(s.fd, chunk); s.written += chunk.length; }
      catch (err) { writeError = err.message; killedByUs = true; killGroup(child.pid, "SIGTERM"); setTimeout(() => { if (!settled) killGroup(child.pid, "SIGKILL"); }, graceMs); }
    };

    const child = spawn(bin, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env });
    const startedAt = Date.now();

    let result = null, sessionId = null, rateLimit = null, initModel = null, revokedWhy = null;
    let killedByUs = false, settled = false;
    let termTimer = null, killTimer = null, haltTimer = null;

    const finish = payload => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer); clearTimeout(killTimer); clearInterval(haltTimer);
      try { closeSync(outFd); closeSync(errFd); } catch { /* already closed */ }
      resolve(payload);
    };

    // The error listener goes on FIRST. A binary that cannot be spawned emits
    // its error asynchronously, and a child with no listener for it takes the
    // whole daemon down; measured once, with launchd ready to restart it into
    // the same death.
    child.on("error", err => { if (child.pid) LIVE_GROUPS.delete(child.pid); return finish({
      outcome: OUTCOMES.CRASHED, why: `could not spawn ${bin}: ${err.message}`,
      pid: child.pid ?? null, lstart: null, ms: Date.now() - startedAt, stderr: tailOf(errPath, 4000), outPath, errPath, truncated: false,
    }); });

    // No pid means the spawn already failed and the error event is on its way;
    // there is nothing to bind, observe, or kill.
    if (!child.pid) return;

    installReaper();
    LIVE_GROUPS.add(child.pid);
    const lstart = readStartOf(child.pid);

    // The binding is not an observer. A worker whose pid and start time could
    // not be written is one a restart can neither adopt nor kill with
    // confidence, so it does not get to run at all. A start time that could
    // not be READ is the same failure from the other side: pid alone names a
    // stranger after the first reuse, so an empty token is no binding.
    try {
      if (!lstart) throw new Error("the worker's start time could not be read, so its pid cannot be told from a reused one");
      onSpawn({ pid: child.pid, lstart });
    }
    catch (err) {
      killGroup(child.pid, "SIGKILL");
      LIVE_GROUPS.delete(child.pid);
      child.on("exit", () => {});
      return finish({ outcome: OUTCOMES.UNBOUND, why: `run binding failed: ${err.message}`,
                      pid: child.pid, lstart, ms: Date.now() - startedAt, stderr: "", outPath, errPath, truncated: false });
    }

    child.stdout.on("data", d => {
      write(streams.out, d);
      // The partial-line buffer is bounded too: a newline-free stream would
      // otherwise grow it without limit while the file stayed capped. No
      // stream-json line approaches a megabyte, so dropping one that does
      // loses nothing the parser could have used.
      buf = buf.length > 1024 * 1024 ? "" : buf + d;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const ev = readEvent(line);
        if (!ev) continue;
        if (ev.kind === "init") { sessionId = ev.sessionId; initModel = ev.model ?? null; }
        if (ev.kind === "result") result = ev.result;
        if (ev.kind === "rate_limit") rateLimit = ev.info;
        onEvent(ev);
      }
    });
    child.stderr.on("data", d => { write(streams.err, d); });

    termTimer = setTimeout(() => {
      killedByUs = true;
      // SIGTERM to the GROUP: the negative pid is what reaches the grandchildren.
      killGroup(child.pid, "SIGTERM");
    }, budgetMs);

    // Escalation only after grace. SIGKILL first would skip SessionEnd entirely.
    killTimer = setTimeout(() => { if (!settled) killGroup(child.pid, "SIGKILL"); }, budgetMs + graceMs);

    // The halt switch and the lease both fail CLOSED: a worker in flight is
    // terminated, not left running. A lease that cannot be proven live is the
    // same as no lease; the former posture ("a missed beat must not kill the
    // worker") left workers acting with no durable claim on anything. A
    // revoked worker gets the same grace as a timed-out one before SIGKILL.
    haltTimer = setInterval(() => {
      if (settled) return;
      if (isHalted()) { killedByUs = true; killGroup(child.pid, "SIGTERM"); return; }
      const why = isRevoked();
      if (why && !revokedWhy) {
        revokedWhy = String(why); killedByUs = true; killGroup(child.pid, "SIGTERM");
        setTimeout(() => { if (!settled) killGroup(child.pid, "SIGKILL"); }, graceMs);
      }
    }, 2000);

    // Classification waits for `close`, which fires after stdout and stderr have
    // drained; `exit` can precede the final result line and would classify a
    // finished worker as CRASHED. `exit` only sweeps the group.
    child.on("exit", () => { killGroup(child.pid, "SIGKILL"); });
    child.on("close", (code, signal) => {
      LIVE_GROUPS.delete(child.pid);
      // Sampled once more here: a lease revoked between the last poll and a
      // normal exit would otherwise be classified OK and its result published
      // under a claim the worker no longer held.
      const lateWhy = revokedWhy ?? isRevoked();
      // A truncated record is an incomplete record: the result parsed from the
      // stream may describe an event the durable file no longer holds, and a
      // store that says OK beside a file that cannot show why is absence read
      // as success. Truncation and a failed write therefore outrank everything
      // but a lost lease.
      const truncated = streams.out.truncated;
      const c = lateWhy
        ? { outcome: OUTCOMES.LEASE_LOST, why: `lease revoked: ${lateWhy}` }
        : writeError
          ? { outcome: OUTCOMES.FAILED, why: `durable output write failed: ${writeError}` }
          : truncated
            ? { outcome: OUTCOMES.FAILED, why: `output truncated at ${maxOutputBytes} bytes; the durable record is incomplete` }
            : classifyResult(result, { code, signal, killedByUs });
      finish({
        ...c, pid: child.pid, lstart, sessionId, code, signal,
        ms: Date.now() - startedAt, rateLimit,
        cost: result?.total_cost_usd ?? null,
        usage: result?.usage ?? null,
        text: result?.result ?? null,
        model: initModel,
        stderr: tailOf(errPath, 4000),
        stdoutBytes: streams.out.written, stderrBytes: streams.err.written, outPath, errPath,
        truncated, stderrTruncated: streams.err.truncated,
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
