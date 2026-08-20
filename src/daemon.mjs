// daemon — the loop that makes this run for hours instead of for one session.
//
// One tick: read every open PR at a pinned head, publish a verdict, decide the
// single next action, and act within capacity. Everything it learns is written
// to the store, so a restart resumes rather than restarting.
//
// Two properties are deliberate and they are the whole point:
//
//   · The halt switch fails CLOSED. A marker file stops the loop AND terminates
//     workers in flight. The previous system's hooks all ended in `|| true`,
//     which is the opposite: every failure was swallowed and the session
//     continued as if healthy.
//   · Execution is OPT-IN. By default a tick observes, publishes and reports what
//     it WOULD do. Shipping a loop that acts before its decisions have been
//     watched is how an unattended run becomes an incident.

import { evaluatePr, publishVerdict } from "./pr.mjs";
import { nextAction, describe, ACTIONS } from "./watcher.mjs";
import { reconcilePr } from "./github/reconciler.mjs";
import { capacity, stayAwake, halted, runWorker, workerArgs, OUTCOMES } from "./supervisor.mjs";
import { promptFor } from "./prompts.mjs";
import { rootCause, fingerprint } from "./ci-rootcause.mjs";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const now = () => Math.floor(Date.now() / 1000);

function log(logPath, line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  if (!logPath) return;
  try { mkdirSync(dirname(logPath), { recursive: true }); appendFileSync(logPath, stamped + "\n"); } catch { /* logging must never kill the loop */ }
}

function openPrs(nwo, limit = 20) {
  try {
    const out = execFileSync("gh", ["pr", "list", "--repo", nwo, "--state", "open",
      "--limit", String(limit), "--json", "number", "--jq", ".[].number"], { encoding: "utf8" }).trim();
    return out ? out.split("\n").map(Number) : [];
  } catch { return null; }   // null means "could not ask", which is not "none"
}

/**
 * Record what a tick decided, so the dashboard and `reeve why` can answer without
 * re-deriving anything, and so a restart knows how long a clause has been UNKNOWN.
 */
function record(db, { pr, head, verdict, decision }) {
  try {
    db.prepare(`INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)`)
      .run(now(), "daemon", "pr.decided", `pr:${pr}`, JSON.stringify({
        head, state: verdict.state, summary: verdict.summary,
        action: decision.action, why: decision.why,
        clauses: verdict.clauses.map(c => ({ id: c.id, state: c.state })),
      }));
  } catch { /* a store that cannot record must not stop the loop */ }
}

/** How long has this PR been sitting in UNKNOWN? Read from the event log, not memory. */
function unknownSince(db, pr) {
  try {
    const rows = db.prepare(
      `SELECT at, payload FROM event WHERE subject = ? AND op = 'pr.decided' ORDER BY seq DESC LIMIT 30`
    ).all(`pr:${pr}`);
    let since = null;
    for (const r of rows) {
      const p = JSON.parse(r.payload);
      if (p.state === "UNKNOWN") since = r.at; else break;
    }
    return since;
  } catch { return null; }
}

/**
 * One pass over one project.
 * @returns {{decisions: object[], escalations: Map, halted: boolean}}
 */
export async function tick(ctx) {
  const { nwo, profile, db, logPath, execute = false, shadow = true } = ctx;
  const decisions = [];
  const escalations = new Map();

  if (halted(ctx.haltMarker)) {
    log(logPath, `HALTED: ${ctx.haltMarker} exists — no work will be started`);
    return { decisions, escalations, halted: true };
  }

  const prs = openPrs(nwo);
  if (prs === null) {
    // Could not ask is not none. Returning an empty list here would look exactly
    // like a quiet, healthy fleet.
    log(logPath, `tick: could not list PRs for ${nwo} — skipping this pass rather than assuming zero`);
    return { decisions, escalations, halted: false, unreadable: true };
  }
  log(logPath, `tick: ${nwo} — ${prs.length} open PR(s)`);

  for (const pr of prs) {
    if (halted(ctx.haltMarker)) { log(logPath, "HALTED mid-tick"); return { decisions, escalations, halted: true }; }

    const e = evaluatePr({ nwo, pr, profile, db });
    if (!e.ok) { log(logPath, `  #${pr}: could not evaluate — ${e.why}`); continue; }

    // GitHub is authoritative for PR facts; this is also what releases a lease
    // when a PR merges.
    const rec = reconcilePr(db, { nwo, pr, profile });
    if (rec.ok && rec.released) log(logPath, `  #${pr}: released ${rec.released} lease(s) — PR merged`);

    const decision = nextAction(e, profile, {
      now: now(),
      unknownSince: unknownSince(db, pr),
      fixAttempts: ctx.fixAttempts ?? new Map(),
    });

    record(db, { pr, head: e.head, verdict: e.verdict, decision });
    decisions.push({ e, decision });
    log(logPath, "  " + describe(e, decision));

    // Republish on every tick: a verdict is bound to a revision, so when the head
    // moves the old check stops applying to anything. Without this the shadow
    // record silently decays to nothing.
    const pub = await publishVerdict({ nwo, verdict: e.verdict, shadow });
    if (!pub.ok) log(logPath, `    could not publish: ${pub.why}`);

    // A shared cause is one problem, not N. Four PRs blocked on a red base is a
    // single escalation, or the phone becomes noise and gets muted.
    if (decision.shared) escalations.set(decision.why, (escalations.get(decision.why) ?? 0) + 1);
    else if (decision.action === ACTIONS.ESCALATE) escalations.set(`#${pr}: ${decision.why}`, 1);
  }

  if (execute) {
    const cap = capacity({ maxWorkers: profile.watch?.maxWorkers ?? 5, running: ctx.running ?? 0 });
    log(logPath, `execute: capacity allows ${cap.canStart} worker(s) (load ${cap.load1?.toFixed?.(2) ?? "?"}, ${cap.perfCores} perf cores)`);
    let started = 0;

    for (const { e, decision } of decisions) {
      if (started >= cap.canStart) { log(logPath, `  capacity reached; ${decisions.length - started} decision(s) deferred to the next tick`); break; }
      if (halted(ctx.haltMarker)) { log(logPath, "HALTED before dispatch"); break; }

      // Only some decisions are worker tasks. WAIT, PARK, MERGE and ESCALATE are
      // not: two of them are for a human and one is the gate's own job.
      let promptCtx = { profile, nwo, pr: e.pr, head: e.head, branch: e.headRef };
      if (decision.action === "FIX_CI") {
        const failing = (e.checks?.failing ?? []).find(f => (decision.caused ?? []).includes(f.name)) ?? (e.checks?.failing ?? [])[0];
        if (!failing?.id) { log(logPath, `  #${e.pr}: cannot dispatch FIX_CI — the failing check has no job behind it`); continue; }
        const cause = rootCause(nwo, failing);
        if (!cause.ok) { log(logPath, `  #${e.pr}: cannot dispatch FIX_CI — ${cause.why}`); continue; }
        // One attempt per fingerprint, keyed on the revision: the same failure at
        // a NEW head is a fresh attempt, not a repeat.
        const fp = fingerprint(nwo, e.head, cause);
        const tried = (ctx.fixAttempts?.get(fp) ?? 0);
        if (tried >= (profile.rounds?.maxFixAttemptsPerFinding ?? 1)) {
          log(logPath, `  #${e.pr}: already attempted this failure ${tried}x — escalating rather than guessing again`);
          escalations.set(`#${e.pr}: the same failure survived a fix`, 1);
          continue;
        }
        ctx.fixAttempts?.set(fp, tried + 1);
        promptCtx = { ...promptCtx, cause, attempt: tried + 1 };
      } else if (decision.action === "FIX_FINDINGS") {
        promptCtx = { ...promptCtx, threads: e.threadDetails ?? [] };
      } else if (decision.action === "REQUEST_REVIEW") {
        promptCtx = { ...promptCtx, reviewers: (profile.reviewers ?? []).filter(r => r.trigger) };
      } else if (decision.action === "SPILL") {
        promptCtx = { ...promptCtx, findings: e.threadDetails ?? [] };
      }

      const spec = promptFor(decision, promptCtx);
      if (!spec) continue;

      const worktree = ctx.worktreeFor?.(e) ?? profile.identity?.worktreeRoot ?? process.cwd();
      log(logPath, `  #${e.pr}: dispatching ${decision.action} in ${worktree}`);
      started++;
      const r = await runWorker({
        args: workerArgs({ prompt: spec.prompt, allowedTools: spec.tools, maxTurns: profile.watch?.maxTurns ?? 40 }),
        cwd: worktree,
        budgetMs: (profile.watch?.workerBudgetMinutes ?? 20) * 60_000,
        isHalted: () => halted(ctx.haltMarker),
      });
      log(logPath, `  #${e.pr}: ${decision.action} -> ${r.outcome} (${r.why}) in ${Math.round(r.ms / 1000)}s${r.cost != null ? `, ${r.cost.toFixed(3)}` : ""}`);
      try {
        db.prepare(`INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)`)
          .run(now(), "worker", "worker.finished", `pr:${e.pr}`, JSON.stringify({
            action: decision.action, outcome: r.outcome, why: r.why, ms: r.ms, cost: r.cost, sessionId: r.sessionId,
          }));
      } catch { /* recording must not stop the loop */ }

      // A worker whose tools were denied wrote a plausible answer it could not
      // support. Treating that as progress is the fail-open this exists to close.
      if (r.outcome === OUTCOMES.DENIED) escalations.set(`#${e.pr}: worker tool calls were denied — its answer is not trustworthy`, 1);
      if (r.outcome === OUTCOMES.RATE_LIMITED) { escalations.set("the provider is rate limiting; work is paused", 1); break; }
    }
  }

  for (const [why, n] of escalations) log(logPath, `NEEDS YOU: ${why}${n > 1 ? ` (${n} PRs)` : ""}`);
  return { decisions, escalations, halted: false };
}

/** The long-running loop. Ticks until halted or stopped. */
export async function run(ctx) {
  const { logPath, intervalMs = 90_000 } = ctx;
  log(logPath, `reeve daemon starting — node ${process.version}, pid ${process.pid}`);

  // Assert the floor rather than trusting the environment: node on this machine's
  // PATH is v22, and launchd never sources a shell profile.
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 24) { log(logPath, `FATAL: node ${process.version} is below the 24 floor`); process.exit(1); }

  // The assertion dies with this process, so a crashed daemon can never leave the
  // Mac permanently unable to sleep.
  const caffeinatePid = stayAwake(process.pid);
  if (caffeinatePid) log(logPath, `staying awake via caffeinate pid ${caffeinatePid}`);

  let stop = false;
  const shutdown = sig => { log(logPath, `${sig} — finishing this tick then stopping`); stop = true; };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  for (;;) {
    try {
      const r = await tick(ctx);
      if (r.halted) { log(logPath, "halted — sleeping until the marker is removed"); }
    } catch (e) {
      // A tick that throws must not kill the daemon: launchd would restart it on a
      // 10s floor and the failure would repeat invisibly.
      log(logPath, `tick threw: ${e.stack?.split("\n").slice(0, 3).join(" | ") ?? e.message}`);
    }
    if (stop) break;
    await new Promise(r => setTimeout(r, intervalMs));
    if (stop) break;
  }
  log(logPath, "daemon stopped");
}
