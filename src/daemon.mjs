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
import { capacity, stayAwake, halted, runWorker, workerArgs, statedBlocker, OUTCOMES } from "./supervisor.mjs";
import { promptFor } from "./prompts.mjs";
import { sandboxFor, writeSandbox, reviewDiff } from "./sandbox.mjs";
import { acquireWorktree, releaseWorktree, pushWorktree } from "./worktree.mjs";
import { rootCause, resolveFailureCause } from "./ci-rootcause.mjs";
import { readState, noteTick, cleanMergeRate } from "./status.mjs";
import { buildAlert, notify } from "./notify.mjs";
import { countFixAttempts, recordFixAttempt, fixAttemptNote, noteFixAttempt, refundFixAttempt, startRun, notePid, finishRun, heartbeat, LEASE_SECONDS } from "./db/ops.mjs";
import { writeDash } from "./dash.mjs";
import { snapshot } from "./backup.mjs";
import { selfAudit } from "./selfaudit.mjs";
import { observe, ingest, noteHead } from "./review/ingest.mjs";
import { derivePr, deriveSupply, reviewState } from "./review/derive.mjs";
import { compare, record as recordShadow, streak } from "./review/shadow.mjs";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, fstatSync, statSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

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

/**
 * Attempts already spent on this cause. A store that cannot be read does not
 * report zero: an unknown count returns the cap, so the decision blocks rather
 * than handing out a retry it cannot justify.
 */
function attemptsFor(db, nwo, pr, fp, logPath) {
  try { return countFixAttempts(db, nwo, pr, fp); }
  catch (err) {
    log(logPath, `  #${pr}: could not read fix attempts (${err.message}) — treating as exhausted`);
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Files the worker actually changed, staged or not. Read from git rather than
 * from anything the worker says about itself: the whole point of this gate is
 * that the actor does not get to be the only witness.
 */
function changedFiles(worktree, since = null) {
  const run = args => {
    try { return execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" }).trim(); }
    catch { return null; }
  };

  // Uncommitted work, for a worker that stopped part-way.
  const dirty = run(["status", "--porcelain"]);
  if (dirty === null) return null;   // could not ask, which reviewDiff refuses on its own terms
  // Porcelain v1: two status columns, a space, then the path. A rename carries
  // "old -> new"; the new name is the one that matters.
  const uncommitted = dirty ? dirty.split("\n").map(l => l.slice(3).trim().split(" -> ").pop()).filter(Boolean) : [];

  // And COMMITTED work, which is what a worker that finished produces. The prompt
  // tells it to commit; committing leaves a clean tree; and reading only the tree
  // therefore reported a complete, correct, committed fix as "nothing was changed"
  // and refused to publish it. The instrument could not represent the success case
  // it was written to check.
  const committed = since ? (run(["diff", "--name-only", `${since}..HEAD`]) ?? "") : "";
  const fromCommits = committed ? committed.split("\n").filter(Boolean) : [];

  return [...new Set([...fromCommits, ...uncommitted])];
}

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

/**
 * Is this pull request finished -- merged or closed?
 *
 * Asked ONLY about a PR that already holds a standing escalation and is missing
 * from the open list, and answered by GitHub rather than by that absence. The
 * open list is capped, so a PR beyond the cap is unread rather than gone, and
 * retiring a human's escalation on that would be absence read as success again.
 *
 * Anything other than a clear MERGED or CLOSED leaves the escalation standing.
 */
function prIsFinished(nwo, pr) {
  try {
    const out = execFileSync("gh", ["pr", "view", String(pr), "--repo", nwo,
      "--json", "state", "--jq", ".state"], { encoding: "utf8" }).trim();
    return out === "MERGED" || out === "CLOSED";
  } catch { return false; }
}

/**
 * PRs whose escalation should retire because the PR itself is over.
 *
 * Measured on nextly #1127: it merged, left the open list, and could therefore
 * never be evaluated again -- so its escalation could never be retired and sat in
 * NEEDS YOU permanently. A surface whose target state is empty fills up with
 * finished work, and an operator stops reading it. That is the same muting the
 * repeat-push guard exists to prevent, arriving from the other direction.
 */
function finishedSubjects(db, nwo, open, io = {}) {
  const isFinished = io.prIsFinished ?? prIsFinished;
  const gone = new Set();
  let rows = [];
  try { rows = db.prepare("SELECT why FROM escalation").all(); } catch { return gone; }
  for (const { why } of rows) {
    const m = why.match(/^#(\d+):/);
    if (!m) continue;
    const pr = Number(m[1]);
    if (open.has(pr) || gone.has(pr)) continue;
    if (isFinished(nwo, pr)) gone.add(pr);
  }
  return gone;
}

function openPrs(nwo, limit = 20) {   // bounded; the caller LOGS when the bound bites
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
// `ctx` may override evaluate, publish, spawnWorker, openPrs and resolveCause. The dispatch
// path is the one place where a mistake costs real work, and it was the only
// path with no test at all -- because driving it otherwise needs GitHub and a
// live `claude`. A ReferenceError sat in it undetected for exactly that reason.
export async function tick(ctx) {
  const { nwo, profile, db, logPath, execute = false, shadow = true } = ctx;
  const decisions = [];
  const escalations = new Map();

  if (halted(ctx.haltMarker)) {
    log(logPath, `HALTED: ${ctx.haltMarker} exists — no work will be started`);
    return { decisions, escalations, halted: true };
  }

  const prs = (ctx.openPrs ?? openPrs)(nwo, profile.watch?.maxOpenPrs ?? 20);
  if (prs === null) {
    // Could not ask is not none. Returning an empty list here would look exactly
    // like a quiet, healthy fleet.
    log(logPath, `tick: could not list PRs for ${nwo} — skipping this pass rather than assuming zero`);
    return { decisions, escalations, halted: false, unreadable: true };
  }
  // A cap that does not say it capped reads as "covered everything". The portfolio
  // includes repositories with 100 open pull requests against a bound of 20, and
  // it is always the SAME 20 -- so the remainder would never be looked at once,
  // silently, forever.
  const CAP = profile.watch?.maxOpenPrs ?? 20;
  log(logPath, `tick: ${nwo} — ${prs.length} open PR(s)` +
      (prs.length >= CAP ? ` — AT THE ${CAP} CAP: any beyond this are not being watched at all` : ""));

  const evaluated = new Set();
  // Evaluated is not the same as settled. A PR whose decision this tick is WAIT
  // was looked at and found to be IN FLIGHT, which says nothing about whether the
  // human-needed condition behind its escalation still holds.
  const waiting = new Set();
  for (const pr of prs) {
    if (halted(ctx.haltMarker)) { log(logPath, "HALTED mid-tick"); return { decisions, escalations, halted: true }; }

    const e = (ctx.evaluate ?? evaluatePr)({ nwo, pr, profile, db });
    if (!e.ok) { log(logPath, `  #${pr}: could not evaluate — ${e.why}`); continue; }

    // GitHub is authoritative for PR facts; this is also what releases a lease
    // when a PR merges.
    evaluated.add(pr);
    const rec = reconcilePr(db, { nwo, pr, profile });
    if (rec.ok && rec.released) log(logPath, `  #${pr}: released ${rec.released} lease(s) — PR merged`);

    // Review ingest, in SHADOW: it writes and nothing reads. Landing raw
    // observations now means the derivation that comes next has history to fold
    // rather than starting from whatever it happens to see on its first tick.
    //
    // Skipped unless the PR moved, because re-polling a quiet PR costs API quota
    // for rows the content key would reject anyway. `updatedAt` is GitHub's, so a
    // change reeve has not seen yet still triggers a read.
    if (ctx.reviewIngest !== false && e.ok) {
      noteHead(db, nwo, pr, e.head);
      const moved = !ctx.lastIngest?.get?.(pr) || ctx.lastIngest.get(pr) !== e.updatedAt;
      if (moved) {
        try {
          const seen = (ctx.observe ?? observe)(nwo, pr);
          const w = ingest(db, nwo, pr, seen.observations, { at: now() });
          if (w.inserted || w.generations) {
            log(logPath, `  #${pr}: ingest +${w.inserted} new, +${w.generations} edit(s)` +
                         `${seen.incomplete ? " — INCOMPLETE read" : ""}`);
          }
          // Only a COMPLETE read updates the watermark. Skipping a PR on the
          // strength of a partial read is how a gap becomes permanent.
          if (!seen.incomplete) (ctx.lastIngest ??= new Map()).set(pr, e.updatedAt);
        } catch (err) {
          log(logPath, `  #${pr}: ingest failed — ${err.message}`);
        }
      }
      // Derived EVERY tick, even when ingest was skipped: clearing depends on the
      // head under judgement, so a push with no new review still changes the
      // answer -- it un-clears everything until a reviewer speaks at the new head.
      try {
        const d = (ctx.derivePr ?? derivePr)(db, nwo, pr, profile,
          { at: now(), head: e.head, complete: !ctx.lastIngestIncomplete?.get?.(pr) });
        const st = (ctx.reviewState ?? reviewState)(db, nwo, pr, profile, { at: now() });
        if (st.readable && (st.open || st.unspilledCritical)) {
          log(logPath, `  #${pr}: review ${st.open}/${st.total} open, ` +
                       `${st.unspilledCritical} blocking, round ${st.rounds} (shadow)`);
        } else if (!st.readable) {
          log(logPath, `  #${pr}: review projection not readable — ${st.why}`);
        }
        void d;

        // The shadow comparison. e.threads is the LIVE read the verdict already
        // trusts, so this asks the only question that matters before PR-5 swaps
        // them over: does the derived view say the same thing?
        const cmp = compare(e.threads, st);
        recordShadow(db, nwo, pr, cmp, now());
        if (cmp.comparable && !cmp.agree) {
          log(logPath, `  #${pr}: SHADOW DIVERGENCE — ${cmp.why}`);
        }
      } catch (err) {
        log(logPath, `  #${pr}: derive failed — ${err.message}`);
      }
    }

    // The root cause is resolved BEFORE the decision, not after it. The watcher's
    // retry cap reads `h.fingerprint`, and the daemon never supplied one -- so the
    // cap read zero attempts every time and could not fire at all. Resolving it
    // here costs nothing extra: the same cause is reused for the worker's prompt
    // below, where it used to be computed a second time.
    // Every failing check is read, not just the first. Where CI ends in an
    // aggregate gate, the first failure is the gate, whose message is the same
    // sentence whatever broke -- an identity two unrelated failures would share
    // and a cause that names nothing for the worker to reproduce.
    const red = e.checks?.verdict === "RED" && (e.checks?.failing ?? []).length > 0;
    let cause = null, fp = null;
    if (red) ({ cause, fp } = resolveFailureCause(nwo, e.checks, ctx.resolveCause ?? rootCause));

    const decision = nextAction(e, profile, {
      now: now(),
      unknownSince: unknownSince(db, pr),
      // From the store, not from a map rebuilt empty on every tick.
      fingerprint: fp,
      // Guarded: an unreadable store must not take down the whole tick, and a
      // count that cannot be read is not zero. Unknown attempts block rather
      // than grant a free retry.
      fixAttempts: fp ? new Map([[fp, attemptsFor(db, nwo, pr, fp, logPath)]]) : new Map(),
    });

    record(db, { pr, head: e.head, verdict: e.verdict, decision });
    if (decision.action === ACTIONS.WAIT) waiting.add(pr);
    // Carried on the entry rather than left in this block's scope: the dispatch
    // loop below is a SEPARATE block, and reaching for these there threw a
    // ReferenceError on every FIX_CI the moment --execute was on.
    decisions.push({ e, decision, cause, fp });
    log(logPath, "  " + describe(e, decision));

    // Republish on every tick: a verdict is bound to a revision, so when the head
    // moves the old check stops applying to anything. Without this the shadow
    // record silently decays to nothing.
    const pub = await (ctx.publish ?? publishVerdict)({ nwo, verdict: e.verdict, shadow });
    if (!pub.ok) log(logPath, `    could not publish: ${pub.why}`);

    // A shared cause is one problem, not N. Four PRs blocked on a red base is a
    // single escalation, or the phone becomes noise and gets muted.
    if (decision.shared) escalations.set(decision.why, (escalations.get(decision.why) ?? 0) + 1);
    else if (decision.action === ACTIONS.ESCALATE) {
      // "The same failure survived a second fix" assumes a fix was attempted. When
      // the previous worker declined -- because the change belonged to a human --
      // nothing survived anything, and a founder reading that goes looking for a
      // bad fix that was never made. The reason it gave is carried on the ledger
      // row for exactly this moment.
      const note = fp ? fixAttemptNote(db, nwo, pr, fp) : null;
      escalations.set(note ? `#${pr}: needs a human — ${note}` : `#${pr}: ${decision.why}`, 1);
    }
  }

  if (execute) {
    const cap = capacity({ maxWorkers: profile.watch?.maxWorkers ?? 5, running: ctx.running ?? 0 });
    log(logPath, `execute: capacity allows ${cap.canStart} worker(s) (load ${cap.load1?.toFixed?.(2) ?? "?"}, ${cap.perfCores} perf cores)`);
    let started = 0;

    for (const { e, decision, cause, fp } of decisions) {
      if (started >= cap.canStart) { log(logPath, `  capacity reached; ${decisions.length - started} decision(s) deferred to the next tick`); break; }
      if (halted(ctx.haltMarker)) { log(logPath, "HALTED before dispatch"); break; }

      // Only some decisions are worker tasks. WAIT, PARK, MERGE and ESCALATE are
      // not: two of them are for a human and one is the gate's own job.
      let promptCtx = { profile, nwo, pr: e.pr, head: e.head, branch: e.headRef };
      if (decision.action === "FIX_CI") {
        // Already resolved above, where it gated the decision. If it could not be
        // resolved there, there is nothing to tell a fixer to repair.
        if (!cause) { log(logPath, `  #${e.pr}: cannot dispatch FIX_CI — no resolvable root cause`); continue; }
        // The attempt is NOT spent here. Several refusals still lie between this
        // point and a running worker -- no prompt, no worktree, no run -- and
        // spending an attempt on a dispatch that never happened burns the one
        // retry the design allows.
        promptCtx = { ...promptCtx, cause, attempt: countFixAttempts(db, nwo, e.pr, fp) + 1 };
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
      // Spent here, beside the run: past every refusal, before any work. A crash
      // after this point costs an attempt, which is the correct direction --
      // a crashed fix that silently earns a free retry is the runaway loop.
      if (run.ok && decision.action === "FIX_CI" && fp) recordFixAttempt(db, nwo, e.pr, fp, e.head);
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
      // The deterministic boundary, built from the profile rather than described
      // to the model. Measured against the CLI first: a scoped allowlist refuses
      // `printf > file`, `| tee`, `git push` and a chained `git remote -v`, while
      // still letting the worker run the project's own commands -- which it must,
      // or it cannot tell whether its fix worked.
      const lane = (profile.lanes ?? []).find(l => l.id === decision.lane) ?? null;
      const sandbox = sandboxFor({ profile, action: decision.action, worktree, lane });
      const settingsPath = writeSandbox(join(dirname(ctx.logPath ?? "/tmp/x"), "sandboxes", String(e.pr)), sandbox);

      let r;
      try {
        r = await (ctx.spawnWorker ?? runWorker)({
          args: workerArgs({ prompt: spec.prompt,
                             allowedTools: spec.tools ?? sandbox.allowedTools,
                             settings: settingsPath,
                             maxTurns: profile.watch?.maxTurns ?? 40 }),
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

      // What the worker PRODUCED, judged after it has stopped talking. The
      // permission layer stops it reaching a forbidden path; this answers the
      // different question of whether the change is inside the work it was given.
      // A model that argued its way to a plausible edit outside its territory
      // still does not get it published.
      // A worker that did not finish still leaves its work behind, and the next
      // attempt cannot use a dirty checkout -- verifyWorktree refuses it, correctly,
      // and the pull request is then stuck forever with no path out.
      //
      // Measured: a worker repaired the planted bug and then hit its turn limit
      // before committing. The fix was correct, cost real money, and would have
      // blocked every later attempt while looking like nothing had happened.
      // WHAT was refused, on every run, and declared BEFORE anything reads it —
      // the first version of this sat below its own use sites and threw a
      // ReferenceError after the worker had finished, losing a completed run.
      //
      // A denial no longer disqualifies the work: a model explores, and a correct
      // refusal is not a failed repair. But refusals are how the sandbox gets
      // tuned, and a worker that could not run the tests produced something
      // nothing verified. Both facts have to be visible.
      const refused = [...new Set((r.denials ?? []).map(x => {
        const i = x.tool_input ?? {};
        return String(i.command ?? i.file_path ?? x.tool_name ?? "?").replace(/\s+/g, " ").slice(0, 100);
      }))];
      for (const w of refused) log(logPath, `  #${e.pr}: refused -> ${w}`);

      // Being unable to VERIFY is different from being unable to explore. If the
      // project's own check command was among the refusals, whatever was produced
      // is unverified, and that must reach a human even when it publishes.
      const checkCmds = (profile.units ?? []).flatMap(u2 =>
        Object.values(u2.commands ?? {}).map(c => c?.cmd).filter(Boolean));
      const couldNotVerify = refused.some(w =>
        checkCmds.some(c => w.includes(c.split(/\s+/)[0])) && /test|lint|check|build/i.test(w));

      if (r.outcome !== OUTCOMES.OK) {
        const left = changedFiles(worktree, e.head);
        if (left?.length) {
          const rel = releaseWorktree({ path: worktree, pr: e.pr });
          log(logPath, `  #${e.pr}: the worker left ${left.length} changed file(s) unfinished — ${rel.quarantined ? `preserved at ${rel.path}` : "released"}`);
          escalations.set(`#${e.pr}: an unfinished candidate fix was preserved rather than published — ${left.slice(0, 3).join(", ")}`, 1);
        } else {
          releaseWorktree({ path: worktree, pr: e.pr });
        }
      }

      // Attached now rather than at dispatch: the reason only exists once the
      // worker has spoken, and it is what the retry cap will quote when it fires.
      if (decision.action === "FIX_CI" && fp) noteFixAttempt(db, nwo, e.pr, fp, statedBlocker(r.report));

      if (r.outcome === OUTCOMES.OK) {
        const changed = changedFiles(worktree, e.head);
        const gate = reviewDiff({ files: changed, profile, lane, action: decision.action });
        if (!gate.ok) {
          log(logPath, `  #${e.pr}: NOT published — ${gate.why}`);
          // A worker that DECLINED is not a worker that failed. Told to stop when
          // a fix belongs in a sensitive path, it stops and says why -- and
          // reporting that as "a fix was produced but refused publication --
          // empty diff" states two things that cannot both be true, about the
          // one outcome the rules asked for. Its own reason is the only witness
          // to why it stopped, so it is the one a human is given.
          const blocker = statedBlocker(r.report);
          escalations.set(blocker
            ? `#${e.pr}: needs a human — ${blocker}`
            : `#${e.pr}: a fix was produced but refused publication — ${gate.why}`, 1);
        } else {
          // reeve publishes, not the worker: the actor and the only claim that
          // the action was allowed must not be the same party.
          const pushed = pushWorktree({ path: worktree, branch: e.headRef, expectedRemote: e.head,
                                         repoRoot: profile.identity?.checkout ?? null });
          if (!pushed.ok) {
            log(logPath, `  #${e.pr}: NOT published — ${pushed.why}`);
            escalations.set(`#${e.pr}: a fix was produced but could not be published — ${pushed.why}`, 1);
          } else {
            log(logPath, `  #${e.pr}: published ${changed.length} file(s)` + (refused.length ? ` (${refused.length} call(s) refused along the way)` : ""));
            // Published, and still escalated: CI at the new head is the check that
            // matters, and a fix nothing ran the tests over should be watched.
            if (couldNotVerify)
              escalations.set(`#${e.pr}: a fix was published but the worker could not run the project's checks — watch CI at the new head`, 1);
            // Only ever release what pushed cleanly. Anything else quarantines,
            // because a directory holding work nobody has a copy of is not spare
            // disk space.
            const rel = releaseWorktree({ path: worktree, pr: e.pr });
            if (!rel.ok) log(logPath, `  #${e.pr}: worktree quarantined — ${rel.why}`);
          }
        }
      }

      // A worker whose tools were denied wrote a plausible answer it could not
      // support. Treating that as progress is the fail-open this exists to close.
      if (r.outcome === OUTCOMES.RATE_LIMITED) { escalations.set("the provider is rate limiting; work is paused", 1); break; }
    }
  }

  // Regenerate the glance surface every tick. A dashboard that is only refreshed
  // on request is one that shows a state that stopped being true hours ago.
  if (ctx.dashPath) {
    // Computed here rather than left to the CLI, which is why the dashboard's
    // headline was permanently blank: nothing ever set ctx.health. Recomputed only
    // when the open set has SHRUNK, because that is the only moment a merge can
    // have happened and the rate can have moved -- a per-tick recount would spend
    // API calls to learn nothing.
    if (ctx.lastOpenCount == null || prs.length < ctx.lastOpenCount) {
      const clean = cleanMergeRate(nwo, 20, null, { required: profile.ci?.requiredChecks ?? [] });
      ctx.health = { clean };
      log(logPath, `health: clean-merge ${clean.ok ? Math.round(clean.rate * 100) + "% over " + clean.judged + " judged" : clean.why}` +
                   (clean.unjudged ? `, ${clean.unjudged} unjudged` : ""));
    }
    ctx.lastOpenCount = prs.length;

    try { writeDash(ctx.dashPath, { nwo, state: readState(db), health: ctx.health ?? {} }); }
    catch (e) { log(logPath, `could not write the dashboard: ${e.message}`); }
  }

  // reeve's own health, on every tick. The checks are local and cost about a
  // millisecond; running them on a slower cadence would make them ABSENT from
  // most ticks, and absence within a tick is what the layer below reads as
  // resolved. Their findings ride the same dedup, so a standing fault is said
  // once and clears when it goes.
  if (ctx.selfAudit !== false) {
    for (const f of (ctx.runSelfAudit ?? selfAudit)(db, {
      nwo, profile, at: now(),
      backupRoot: ctx.backupRoot === false ? null
                : (ctx.backupRoot ?? join(dirname(logPath ?? "/tmp/x"), "backups")),
    })) {
      log(logPath, `self: ${f.level} ${f.why}${f.detail ? ` — ${f.detail}` : ""}`);
      escalations.set(f.why, f.count ?? 1);
    }
  }

  // Announce what STARTED or CHANGED, and what went away. Repeating a standing
  // cause every tick is how an operator learns to ignore the channel.
  // A PR that merged or closed will never be evaluated again, so its escalation
  // needs a positive answer about the PR itself or it stands forever.
  const finished = finishedSubjects(db, nwo, new Set(prs), ctx);
  for (const pr of finished) log(logPath, `  #${pr}: is merged or closed — retiring what it was escalating`);
  const { fresh, cleared } = announceable(db, escalations,
    { covered: evaluated, waiting, finished, complete: evaluated.size === prs.length });
  // Recorded last, so it means "a tick completed" rather than "a tick began".
  // That is the difference between a daemon that is working and one that is
  // wedged part-way through every pass.
  // A second copy, taken from the tick that just finished writing. `VACUUM INTO`
  // holds a read lock, so this is consistent even mid-loop, and it is skipped when
  // one was already taken within the window -- a backup every 150 seconds would
  // fill the disk of the machine it is meant to protect.
  if (ctx.backupRoot !== false) {
    const at = now();
    if (!ctx.lastBackupAt || at - ctx.lastBackupAt >= (profile.watch?.backupIntervalSeconds ?? 3600)) {
      const s = snapshot(db, ctx.backupRoot ?? join(dirname(logPath ?? "/tmp/x"), "backups"), nwo, at);
      log(logPath, s.ok ? `backup: ${s.path}` : `backup FAILED: ${s.why}`);
      ctx.lastBackupAt = at;
    }
  }

  if (ctx.reviewIngest !== false) {
    const sk = streak(db, nwo, now());
    log(logPath, `shadow: ${sk.days} consecutive day(s) agreeing over ${sk.comparisons} comparison(s)` +
                 (sk.firstDivergence ? ` — last divergence ${sk.firstDivergence.day}` : ""));
  }

  // Repo-wide, so once per tick rather than once per pull request.
  if (ctx.reviewIngest !== false) {
    try { (ctx.deriveSupply ?? deriveSupply)(db, nwo, profile, { at: now() }); }
    catch (err) { log(logPath, `supply derive failed — ${err.message}`); }
  }

  noteTick(db);

  for (const { why, count } of fresh) log(logPath, `NEEDS YOU: ${why}${count > 1 ? ` (${count} PRs)` : ""}`);
  for (const why of cleared) log(logPath, `CLEARED: ${why}`);

  // Only what ARRIVED goes to a phone. `fresh` is already the deduplicated set,
  // so a standing cause is pushed once rather than every two and a half minutes --
  // which is how a channel gets muted and stops being a channel.
  const alert = buildAlert({ nwo, escalations: fresh });
  if (alert) {
    const sent = (ctx.notify ?? notify)({ profile, alert });
    // Logged either way. A push channel nobody knows is broken is the same as no
    // push channel, so a decline is never swallowed.
    log(logPath, sent.ok ? `pushed ${fresh.length} escalation(s) to ${profile.notify?.topic}`
                         : `did NOT push: ${sent.why}`);
    // Recorded as well as logged: the self-audit reads this to notice a channel
    // that has been refusing for days, and a log line does not survive a restart
    // as something queryable.
    try {
      db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
        .run(now(), "daemon", sent.ok ? "notify.sent" : "notify.failed", `repo:${nwo}`,
             JSON.stringify({ count: fresh.length, why: sent.why ?? null }));
    } catch { /* recording a push must never fail a tick */ }
  }
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
export function announceable(db, escalations, { covered = null, waiting = null, finished = null, complete = true, at = Math.floor(Date.now() / 1000) } = {}) {
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
    if (escalations.has(why)) continue;
    // Absent from THIS tick is not the same as gone. A tick that could not
    // evaluate a PR -- a rate limit, a network blip, an early continue -- simply
    // does not produce its escalation, and retiring it on that silence announces
    // "resolved" for a problem nobody looked at. Absence is not success here
    // either, and this is the surface a human trusts to tell them it is over.
    //
    // Nor is being LOOKED at the same as being settled. Measured on nextly #834:
    // its decisions ran ESCALATE, then seven ticks of WAIT while CI was in
    // flight, then ESCALATE again -- and because a waiting tick produces no
    // escalation, the standing cause was retired and re-announced twice, four
    // and twenty-five minutes apart, with the reason string identical each time.
    // WAIT means "something is in flight; check again later", never "the thing a
    // human was needed for is resolved". Two pushes for one unchanged condition
    // is how the channel earns being muted, and a muted channel is worse than
    // none.
    const subject = why.match(/^#(\d+):/)?.[1];
    const pr = subject ? Number(subject) : null;
    const looked = !subject
      // A shared cause names no PR, so only a tick that finished what it set out
      // to do is entitled to retire it.
      ? complete
      // GitHub says the pull request is over. That is a positive fact about the
      // subject, not an absence, and it is the ONLY way an escalation for a PR
      // that has left the open list can ever retire.
      : finished?.has(pr) ? true
      // In flight this tick, which says nothing either way.
      : waiting?.has(pr) ? false
      : (covered === null || covered.has(pr));
    if (!looked) continue;
    db.prepare("DELETE FROM escalation WHERE why=?").run(why);
    cleared.push(why);
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
  // An explicit override still wins: that is how a test, or a human working a PR
  // by hand, hands a specific directory to a worker.
  const override = ctx.worktreeFor?.(e) ?? null;
  if (override) {
    if (!isAbsolute(override)) return { path: null, why: `worktree path is relative (${override})` };
    if (!existsSync(override)) return { path: null, why: `worktree does not exist: ${override}` };
    return { path: override, why: null };
  }

  const root = profile.identity?.worktreeRoot ?? null;
  const checkout = profile.identity?.checkout ?? null;
  if (!root) return { path: null, why: "no identity.worktreeRoot in the profile" };
  if (!isAbsolute(root)) return { path: null, why: `identity.worktreeRoot is relative (${root}); it must be absolute` };
  if (!checkout) return { path: null, why: "no identity.checkout in the profile — a worktree is created FROM a clone" };
  if (!existsSync(checkout)) return { path: null, why: `identity.checkout does not exist: ${checkout}` };

  // A dedicated, verified checkout of THIS pull request's branch at the revision
  // reeve pinned. Refusing is the whole point: a worktree holding somebody's
  // unsaved work is not a worktree a worker may reset.
  const w = acquireWorktree({ repoRoot: checkout, root, pr: e.pr, branch: e.headRef, head: e.head });
  return w.ok ? { path: w.path, why: null, reused: w.reused } : { path: null, why: w.why };
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
