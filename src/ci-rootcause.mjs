// ci-rootcause — turn a failing check into an actionable cause, cheaply.
//
// The chain needs no search: a failed check run's `id` IS the Actions job id, so
// failed check run -> /actions/jobs/{id} names the failing step, and
// /check-runs/{id}/annotations carries the message.
//
// Measured on this repo: 296 bytes vs 82,719 for a changeset failure, and 6,833
// vs 2,108,314 for a Playwright failure. But annotations are not uniformly
// useful, and that nuance is the whole reason this file is more than one call:
//
//   · a step that is a TEST RUNNER with a reporter yields exact test names and
//     file:line in its annotations;
//   · a step that is a PLAIN SHELL COMMAND yields only "Process completed with
//     exit code 1", and the cause is in the log.
//
// So the log fallback is a normal branch, not an exceptional one, and it is
// sliced to the failing step rather than downloaded whole.

import { execFileSync } from "node:child_process";

/** Annotation messages that carry no cause. Anything matching needs the log. */
const GENERIC = [
  /^Process completed with exit code \d+\.?$/i,
  /^The (job|run) was cancelled/i,
  /^The operation was canceled/i,
  /^The self-hosted runner .* lost communication/i,
];

function sh(args) {
  try { return { ok: true, out: execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64e6, stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { ok: false, out: "", err: String(e.stderr || e.message).trim() }; }
}
const api = (path, jq) => { const a = ["api", path]; if (jq) a.push("--jq", jq); return sh(a); };

/**
 * Parse an Actions log line's timestamp. The trailing Z is load-bearing: without
 * it JavaScript reads the value as LOCAL time, which on this machine is five
 * hours off, and a step window built from it matches nothing.
 */
export function parseLogStamp(line) {
  const m = String(line).match(/^(\S+Z)\s/);
  return m ? Date.parse(m[1]) : NaN;
}

export function isActionable(message) {
  const m = String(message ?? "").trim();
  if (!m) return false;
  return !GENERIC.some(re => re.test(m));
}

/** Step 1: which step failed? Always available, always cheap. */
export function failingStep(nwo, checkRunId) {
  const r = api(`repos/${nwo}/actions/jobs/${checkRunId}`,
    '{name: .name, run_id: .run_id, attempt: .run_attempt, steps: [.steps[] | select(.conclusion=="failure") | {number, name, started_at, completed_at}]}');
  if (!r.ok) return { ok: false, why: r.err.split("\n")[0] };
  const j = JSON.parse(r.out);
  return { ok: true, job: j.name, runId: j.run_id, attempt: j.attempt, steps: j.steps };
}

/** Step 2: annotations. 6.8KB where the log is 2.1MB. */
export function annotations(nwo, checkRunId) {
  const r = api(`repos/${nwo}/check-runs/${checkRunId}/annotations`);
  if (!r.ok) return { ok: false, why: r.err.split("\n")[0], rows: [] };
  let rows;
  try { rows = JSON.parse(r.out); } catch { return { ok: false, why: "unparseable annotations", rows: [] }; }
  return {
    ok: true, bytes: r.out.length,
    rows: rows.map(a => ({
      level: a.annotation_level, path: a.path, line: a.start_line,
      title: a.title, message: a.message, actionable: isActionable(a.message),
    })),
  };
}

/**
 * Step 3, only when needed: the log, sliced to the failing step.
 *
 * Actions logs prefix every line with an ISO timestamp, and a step's boundaries
 * are its own started_at/completed_at, so the slice is a timestamp window rather
 * than a text search. `gh run view --log-failed` is not used: it labels every
 * line UNKNOWN STEP, losing the attribution this needs.
 */
export function logSlice(nwo, checkRunId, step, { maxLines = 120 } = {}) {
  const r = sh(["api", `repos/${nwo}/actions/jobs/${checkRunId}/logs`]);
  if (!r.ok) return { ok: false, why: r.err.split("\n")[0] };
  const lines = r.out.split("\n");
  const from = step?.started_at ? Date.parse(step.started_at) : null;
  const to = step?.completed_at ? Date.parse(step.completed_at) : null;

  let picked = lines;
  let windowed = false;
  if (from && to) {
    // The trailing Z is load-bearing. Slicing a fixed 24 characters drops it, and
    // JavaScript then reads the timestamp as LOCAL time — five hours off here —
    // so the window matched nothing and the cause came back empty.
    const inWindow = lines.filter(l => {
      const t = parseLogStamp(l);
      return Number.isFinite(t) && t >= from - 1000 && t <= to + 1000;
    });
    // A window that matches nothing is a bug in the window, not an absence of
    // cause. Widening beats reporting "no cause found".
    if (inWindow.length) { picked = inWindow; windowed = true; }
  }
  // Keep the whole step window: the cause is often NOT at the end. reeve's own
  // first CI failure put the FAIL line at 136 of 371, and a tail-only slice of
  // 120 lines missed it entirely, reporting only "Process completed with exit
  // code 1". The tail is a fallback for when nothing salient is found.
  const tail = picked.length <= maxLines ? picked : picked.slice(-maxLines);
  return {
    ok: true, bytes: r.out.length, sliced: tail.length, total: lines.length, windowed,
    // Strip the timestamp prefix: it is noise once the window has been applied.
    text: tail.map(l => l.replace(/^\S+Z\s/, "")).join("\n"),
    full: picked.map(l => l.replace(/^\S+Z\s/, "")).join("\n"),
  };
}

/** Lines a human or an agent would actually act on. */
export function salientLines(text, limit = 25) {
  const patterns = [
    /^\s*[✖✗×]\s/, /\bError\b/, /\bERROR\b/, /^\s*FAIL\b/, /\bfailed\b/i,
    /\bexpect\(/, /\bAssertionError\b/, /\bTraceback\b/, /^\s*at .*\(\S+:\d+:\d+\)/,
    /^##\[error\]/, /\bE\s{2,}/, /\bexit code \d+/,
  ];
  const hits = [];
  for (const line of text.split("\n")) {
    if (patterns.some(re => re.test(line))) hits.push(line.replace(/\[[0-9;]*m/g, "").trimEnd());
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * The whole chain for one failing check.
 * Returns a cause with a `source` saying which tier answered, so the cost of the
 * answer is visible rather than hidden.
 */
export function rootCause(nwo, check) {
  const id = check.id;
  if (!id) return { ok: false, why: "check has no id (a commit status has no job behind it)" };

  const step = failingStep(nwo, id);
  if (!step.ok) return { ok: false, why: step.why };
  const failing = step.steps?.[0] ?? null;

  const ann = annotations(nwo, id);
  const actionable = (ann.rows ?? []).filter(a => a.actionable && a.level === "failure");

  if (actionable.length) {
    return {
      ok: true, source: "annotations", bytes: ann.bytes,
      job: step.job, step: failing?.name ?? null, runId: step.runId, attempt: step.attempt,
      cause: actionable.map(a => ({ where: a.path && a.line ? `${a.path}:${a.line}` : a.path, message: a.message.split("\n")[0].slice(0, 300) })),
      // The full set is kept for a fixer that wants every failing test, not just the first.
      all: actionable,
    };
  }

  // Annotations exist but say nothing: a plain shell step. Fall through to the log.
  const slice = logSlice(nwo, id, failing);
  if (!slice.ok) {
    return { ok: false, source: "annotations", why: `annotations were generic and the log could not be read: ${slice.why}`,
             job: step.job, step: failing?.name ?? null };
  }
  // Search the FULL window first; fall back to the tail only if it says nothing.
  let salient = salientLines(slice.full ?? slice.text);
  if (!salient.length) salient = salientLines(slice.text);
  return {
    ok: true, source: "log", bytes: slice.bytes, sliced: slice.sliced,
    job: step.job, step: failing?.name ?? null, runId: step.runId, attempt: step.attempt,
    cause: salient.map(l => ({ where: null, message: l.slice(0, 300) })),
    text: slice.text,
    note: ann.rows?.length ? "annotations were present but generic; the cause came from the log" : "no annotations; the cause came from the log",
  };
}

/**
 * Has this exact failure already been seen at this revision? A fixer that tries
 * the same thing twice is the loop that actually runs away, so the caller caps
 * attempts per fingerprint rather than per PR.
 */
export function fingerprint(nwo, sha, cause) {
  const parts = [nwo, sha?.slice(0, 10), cause.job, cause.step,
                 ...(cause.cause ?? []).slice(0, 3).map(c => `${c.where ?? ""}|${c.message.slice(0, 120)}`)];
  return parts.join("::");
}

/**
 * Deterministic failure, or flake? A job that failed on an earlier attempt and
 * passed on a later one is a flake by demonstration. Anything else is assumed
 * deterministic: assuming flake is how a real failure gets re-run until it is
 * someone else's problem.
 */
export function flakeEvidence(nwo, runId, jobName) {
  const r = api(`repos/${nwo}/actions/runs/${runId}/attempts`, ".total_count // 0");
  const attempts = r.ok ? Number(r.out.trim() || 0) : 0;
  if (attempts <= 1) return { flake: false, why: "single attempt; no evidence either way", attempts };
  const outcomes = [];
  for (let a = 1; a <= attempts; a++) {
    const j = api(`repos/${nwo}/actions/runs/${runId}/attempts/${a}/jobs`,
      `.jobs[] | select(.name=="${jobName}") | .conclusion`);
    if (j.ok && j.out.trim()) outcomes.push(j.out.trim());
  }
  const passed = outcomes.includes("success");
  const failed = outcomes.includes("failure");
  return { flake: passed && failed, outcomes, attempts,
           why: passed && failed ? "the same job both passed and failed across attempts" : "outcomes are consistent" };
}
