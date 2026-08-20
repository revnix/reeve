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
import { rootCause, causeKey } from "./ci-rootcause.mjs";
import { readState } from "./status.mjs";
import { countFixAttempts, recordFixAttempt, startRun, notePid, finishRun, heartbeat, LEASE_SECONDS } from "./db/ops.mjs";
import { writeDash } from "./dash.mjs";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, fstatSync, statSync, existsSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

const now = () => Math.floor(Date.now() / 1000);

// Whether this process's stdout already points at the log file. launchd's
// StandardOutPath names the very file the daemon appends to, so echoing as well
// writes every line twice — and the shadow week counts its evidence from this
// file, which makes a quiet night read as a busy one. Compared by (dev, ino)
// rather than by path, because a redirect leaves no path to compare. Cached per
// path: a daemon's stdout does not change underneath it.
const stdoutIsFile = new Map();
function stdoutAlreadyWrites(logPath) {
  if (stdoutIsFile.has(logPath)) return stdoutIsFile.get(logPath);
  let same = false;
  try {
    const out = fstatSync(1), file = statSync(logPath);
    same = out.dev === file.dev && out.ino === file.ino;
  } catch { same = false; }   // a pipe, a tty or an unreadable path is never the log
  stdoutIsFile.set(logPath, same);
  return same;
}

// Beat at a quarter of the lease: frequent enough that a live worker never lets
// its lease lapse, rare enough to cost nothing. Derived from LEASE_SECONDS rather
// than chosen, so the two cannot drift apart.
const HEARTBEAT_MS = (LEASE_SECONDS / 4) * 1000;

export function log(logPath, line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  if (!logPath) { console.log(stamped); return; }
  let appended = false;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, stamped + "\n");
    appended = true;
  } catch { /* logging must never kill the loop */ }
  // Stat after the append, so the first line of a fresh log has a file to compare.
  if (!appended || !stdoutAlreadyWrites(logPath)) console.log(stamped);
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

    // The root cause is resolved BEFORE the decision, not after it. The watcher's
    // retry cap reads `h.fingerprint`, and the daemon never supplied one -- so the
    // cap read zero attempts every time and could not fire at all. Resolving it
    // here costs nothing extra: the same cause is reused for the worker's prompt
    // below, where it used to be computed a second time.
    const red = e.checks?.verdict === "RED" && (e.checks?.failing ?? []).length > 0;
    let cause = null, fp = null;
    if (red) {
      const failing = (e.checks.failing).find(f => (e.checks.caused ?? []).includes(f.name)) ?? e.checks.failing[0];
      const rc = failing?.id ? rootCause(nwo, failing) : { ok: false, why: "the failing check has no job behind it" };
      if (rc.ok) { cause = rc; fp = causeKey(nwo, rc); }
    }

    const decision = nextAction(e, profile, {
      now: now(),
      unknownSince: unknownSince(db, pr),
      // From the store, not from a map rebuilt empty on every tick.
      fingerprint: fp,
      fixAttempts: fp ? new Map([[fp, countFixAttempts(db, nwo, pr, fp)]]) : new Map(),
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
        // Already resolved above, where it gated the decision. If it could not be
        // resolved there, there is nothing to tell a fixer to repair.
        if (!cause) { log(logPath, `  #${e.pr}: cannot dispatch FIX_CI — no resolvable root cause`); continue; }
        // Counted against the cause and written before the worker starts, so a
        // crash mid-fix still costs an attempt rather than granting a free retry.
        const tried = recordFixAttempt(db, nwo, e.pr, fp, e.head);
        promptCtx = { ...promptCtx, cause, attempt: tried };
      } else if (decision.action === "FIX_FINDINGS") {
        promptCtx = { ...promptCtx, threads: e.threadDetails ?? [] };
      } else if (decision.action === "REQUEST_REVIEW") {
        promptCtx = { ...promptCtx, reviewers: (profile.reviewers ?? []).filter(r => r.trigger) };
      } else if (decision.action === "SPILL") {
        promptCtx = { ...promptCtx, findings: e.threadDetails ?? [] };
      }

      const spec = promptFor(decision, promptCtx);
      if (!spec) continue;

      const wt = resolveWorktree(ctx, profile, e);
      if (!wt.path) {
        escalations.set(`#${e.pr}: cannot dispatch — ${wt.why}`, 1);
        log(logPath, `  #${e.pr}: NOT dispatching — ${wt.why}`);
        continue;
      }
      const worktree = wt.path;

      // A durable run is the ONLY way a worker may start. The exclusive right to
      // act on this PR is taken FIRST, so a restarted daemon cannot re-dispatch
      // work already in flight -- the log shows exactly that happening, the same
      // fix launched at 15:02 and again at 15:12.
      const run = startRun(db, { nwo, pr: e.pr, action: decision.action, head: e.head, cause });
      if (!run.ok) {
        // Refusing to act is the only safe answer when the transition cannot be
        // recorded: an unrecorded worker is one nothing can reason about later.
        log(logPath, `  #${e.pr}: NOT dispatching — ${run.why}`);
        continue;
      }

      log(logPath, `  #${e.pr}: dispatching ${decision.action} in ${worktree} (run ${run.runId}, attempt ${run.attempt})`);
      started++;
      const beat = setInterval(() => { try { heartbeat(db, { runId: run.runId }); } catch { /* a missed beat must not kill the worker */ } },
                               HEARTBEAT_MS);
      let r;
      try {
        r = await runWorker({
          args: workerArgs({ prompt: spec.prompt, allowedTools: spec.tools, maxTurns: profile.watch?.maxTurns ?? 40 }),
          cwd: worktree,
          budgetMs: (profile.watch?.workerBudgetMinutes ?? 20) * 60_000,
          isHalted: () => halted(ctx.haltMarker),
          // Bind the process to the run the instant it exists, before it can
          // touch anything, so a crash leaves something probeable.
          onSpawn: ({ pid, lstart }) => notePid(db, { runId: run.runId, pid, boot: lstart }),
        });
      } finally {
        clearInterval(beat);
        // Closed in `finally`: a throw between spawn and result would otherwise
        // leave the run leased forever, and the PR unworkable until it expired.
        finishRun(db, { runId: run.runId, outcome: r?.outcome ?? "failed",
                        why: r?.why ?? "the worker threw before returning a result",
                        ms: r?.ms, cost: r?.cost, sessionId: r?.sessionId });
      }
      log(logPath, `  #${e.pr}: ${decision.action} -> ${r.outcome} (${r.why}) in ${Math.round(r.ms / 1000)}s${r.cost != null ? `, ${r.cost.toFixed(3)}` : ""}`);

      // A worker whose tools were denied wrote a plausible answer it could not
      // support. Treating that as progress is the fail-open this exists to close.
      if (r.outcome === OUTCOMES.DENIED) escalations.set(`#${e.pr}: worker tool calls were denied — its answer is not trustworthy`, 1);
      if (r.outcome === OUTCOMES.RATE_LIMITED) { escalations.set("the provider is rate limiting; work is paused", 1); break; }
    }
  }

  // Regenerate the glance surface every tick. A dashboard that is only refreshed
  // on request is one that shows a state that stopped being true hours ago.
  if (ctx.dashPath) {
    try { writeDash(ctx.dashPath, { nwo, state: readState(db), health: ctx.health ?? {} }); }
    catch (e) { log(logPath, `could not write the dashboard: ${e.message}`); }
  }

  // Announce what STARTED or CHANGED, and what went away. Repeating a standing
  // cause every tick is how an operator learns to ignore the channel.
  const { fresh, cleared } = announceable(db, escalations);
  for (const { why, count } of fresh) log(logPath, `NEEDS YOU: ${why}${count > 1 ? ` (${count} PRs)` : ""}`);
  for (const why of cleared) log(logPath, `CLEARED: ${why}`);
  return { decisions, escalations, halted: false };
}

/**
 * Reduce this tick's escalations against the standing set, so a cause is
 * announced when it arrives and when its shape changes, never on every tick.
 * Clearing is announced too: an operator who is only ever told about problems
 * cannot distinguish "resolved" from "reeve stopped looking".
 *
 * @param {Map<string, number>} escalations  cause -> how many PRs share it
 * @returns {{fresh: {why: string, count: number}[], cleared: string[]}}
 */
export function announceable(db, escalations, at = Math.floor(Date.now() / 1000)) {
  const fresh = [], cleared = [];
  const standing = new Map(
    db.prepare("SELECT why, count, announced_count FROM escalation").all().map(r => [r.why, r]));

  for (const [why, count] of escalations) {
    const prev = standing.get(why);
    if (!prev) {
      db.prepare(`INSERT INTO escalation(why,count,first_seen_at,last_seen_at,announced_count)
                  VALUES(?,?,?,?,?)`).run(why, count, at, at, count);
      fresh.push({ why, count });
    } else {
      db.prepare("UPDATE escalation SET count=?, last_seen_at=? WHERE why=?").run(count, at, why);
      // The count is the shape of a shared cause: 1 PR on a red base and 4 PRs
      // on it are different situations and both deserve saying.
      if (prev.announced_count !== count) {
        db.prepare("UPDATE escalation SET announced_count=? WHERE why=?").run(count, why);
        fresh.push({ why, count });
      }
    }
  }

  for (const why of standing.keys()) {
    if (!escalations.has(why)) {
      db.prepare("DELETE FROM escalation WHERE why=?").run(why);
      cleared.push(why);
    }
  }
  return { fresh, cleared };
}

/**
 * Where a worker for this escalation should run.
 *
 * Returns `{path: null, why}` rather than a default, because the previous
 * default was `process.cwd()` -- which under launchd is the daemon's
 * WorkingDirectory, so a worker sent to fix a pull request in one repository
 * would have run inside another. A wrong directory is not a smaller version of
 * the right one, and refusing is the only safe answer.
 */
export function resolveWorktree(ctx, profile, e) {
  const p = ctx.worktreeFor?.(e) ?? profile.identity?.worktreeRoot ?? null;
  if (!p) return { path: null, why: "no identity.worktreeRoot in the profile" };
  if (!isAbsolute(p)) return { path: null, why: `identity.worktreeRoot is relative (${p}); it must be absolute` };
  if (!existsSync(p)) return { path: null, why: `identity.worktreeRoot does not exist: ${p}` };
  return { path: p, why: null };
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
