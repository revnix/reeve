// dispatch -- what a phase runs, and the seam that runs it.
//
// Everything a run is judged against is captured ONCE, here: the argv, the
// prompt hash, the registry snapshot hash, and the run row. Nothing downstream
// re-resolves any of it, because a changed environment must never change a
// running task by itself.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { runWorker, OUTCOMES, isSameProcess } from "../supervisor.mjs";
import { insertRun, bindRun, settleRun, runPathsFor, revocationProbe, heartbeatRun } from "./run.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");

// ALIASES ARE REFUSED, NOT RESOLVED HERE. Resolving one needs the installed CLI,
// which is I/O; refusing one keeps this function pure and puts the resolution at
// the caller, where the resolved id is also what goes on the command line. A
// snapshot that recorded `fable` would resolve to a different model after an
// upgrade, and the task's model would change with nobody deciding it.
const ALIASES = new Set(["fable", "sonnet", "opus", "haiku", "default", "sonnet[1m]"]);

/**
 * Which phases dispatch, and what each one runs.
 *
 * EMPTY HERE, ON PURPOSE. S3-D registers SIZING, RESEARCH and DESIGN, one per
 * pull request. Until it does, `specFor` answers null for every phase and the
 * stage is a filing surface that spawns nothing -- which is the correct state
 * for this task rather than a gap in it.
 *
 * NULL-PROTOTYPE, and that is load-bearing rather than tidy. A plain object
 * literal answers `specFor("toString")` with a function, and `specFor("__proto__")`
 * with the prototype -- so a phase name arriving from a task row could resolve to
 * a "spec" nobody wrote. Phase names come out of the database, so this lookup
 * takes untrusted input.
 *
 * A FOURTH KEY TURNS S3 INTO S4. `ADVANCE.DESIGN` is `SPEC_DRAFT`, so a finished
 * DESIGN really does move the task there; what must not happen is the next tick
 * dispatching it. The absence of a `SPEC_DRAFT` entry is the boundary of the
 * whole stage, and it is enforced by `specFor` returning null rather than by
 * anyone remembering.
 */
export const PHASE_SPECS = Object.freeze(Object.assign(Object.create(null), {
}));

/**
 * The spec for a phase, or null when that phase dispatches nothing.
 *
 * `null` is an ANSWER, not a failure: the tick reads it as "no action for this
 * phase" and moves on. `Object.hasOwn` rather than a truthiness test, so a key
 * whose spec is legitimately falsy is still distinguishable from an absent one.
 */
export function specFor(phase) {
  return Object.hasOwn(PHASE_SPECS, phase) ? PHASE_SPECS[phase] : null;
}

export function contractSnapshot({ cliVersion, model, effort, argv, prompt, settings, tools,
                                   agents, maxTurns, maxBudgetUsd, canaryId, registrySnapshotHash }) {
  if (!model || ALIASES.has(String(model)))
    return { ok: false, error: `contractSnapshot: model must be a fully resolved id, never the alias ${JSON.stringify(model)}` };
  // `ok` on BOTH paths. A refusal shaped `{ok:false}` beside a success with no
  // `ok` at all makes `if (!snap.ok)` true for a perfectly good snapshot, and the
  // caller that gets it right is the one that happened to test the other branch.
  return {
    ok: true, cliVersion, modelId: model, effort,
    argvHash: sha(JSON.stringify(argv)), promptHash: sha(prompt), settingsHash: sha(settings),
    toolsHash: sha(tools), agentsHash: sha(agents),
    maxTurns, maxBudgetUsd, canaryId, snapshotHash: registrySnapshotHash,
  };
}

/** The per-field difference between the snapshot an attempt will reuse and the
 *  environment it is about to run in. RECORDED, never acted on: adopting drift
 *  is a founder command, and a dispatcher that refused on drift would stop a
 *  task because someone upgraded the CLI. */
export function contractDrift(snapshot, live) {
  const out = {};
  // EVERY FIELD THE SNAPSHOT CARRIES, derived from the snapshot itself rather
  // than listed again here. A hand-kept list is a second spelling of
  // `contractSnapshot`'s shape, and it had already drifted from it: `maxTurns`,
  // `maxBudgetUsd`, `argvHash` and `promptHash` were all absent, so
  // `contractDrift(snap, {...snap, maxTurns: 1})` measured as null -- a live
  // profile change to the worker's own limits reported a clean dispatch.
  //
  // `ok` is the envelope, not a contract field.
  for (const f of Object.keys(snapshot))
    if (f !== "ok" && snapshot[f] !== live[f]) out[f] = { was: snapshot[f] ?? null, now: live[f] ?? null };
  // NULL, not {}. An empty object is truthy, and a caller writing `if (drift)`
  // would record drift on every clean dispatch.
  return Object.keys(out).length ? out : null;
}

export async function dispatchPhase(db, {
  task, generation, phase, slice = 0, attempt, home, bin = "claude", argv, env, cwd,
  snapshot, drift = null, leaseSeconds, budgetMs, graceMs = 5000, maxOutputBytes = 64 * 1024 * 1024,
  now = () => Math.floor(Date.now() / 1000), isAlive = isSameProcess,
  run = runWorker, bind = bindRun,
  // THE CALLER'S OWN SPAWN HOOK, chained after the run row's binding.
  //
  // The tick claims a provider slot BEFORE the worker exists, so the lease
  // records the DAEMON's pid and lstart; its onSpawn re-binds that lease to the
  // worker. Hard-coding this hook to the run row alone dropped that entirely --
  // and provider.mjs says what follows in as many words: liveness is then asked
  // about a long-lived daemon that is always alive, so a worker that dies takes
  // its slot with it until expiry, and the reaper, whose whole basis is
  // pid-and-lstart death, can never fire for it.
  //
  // Chained rather than replaced, and the run row binds FIRST: the row is the
  // permission to run, and a provider lease re-bound to a worker no row can name
  // is the wrong half to keep.
  onSpawn = null,
  // AND THE EMERGENCY STOP. runWorker defaults isHalted to () => false, so a
  // HALT marker appearing AFTER a worker started left it running -- modifying
  // its worktree and spending the subscription -- with the pre-dispatch check
  // unable to see it. The guardian path passes its own probe for exactly this
  // reason; the builder had none to pass.
  isHalted = () => false,
}) {
  const runKey = { task, generation, phase, slice, attempt };
  const { runDir, outPath, errPath, argvPath } = runPathsFor(home, runKey);
  mkdirSync(runDir, { recursive: true });

  // THE ARGV MUST BE THE ARGV THE SNAPSHOT NAMES. The snapshot is the contract
  // the attempt is judged against and a retry reuses verbatim; if the caller
  // rebuilt or mutated `argv` after taking it, the worker runs one command
  // while the row, the file and every later comparison label it with the hash
  // of another. Nothing downstream could detect that, because everything
  // downstream trusts the hash.
  const actualArgvHash = sha(JSON.stringify(argv));
  if (actualArgvHash !== snapshot.argvHash)
    return { ok: false, reason: "argv-does-not-match-the-snapshot",
             detail: `the snapshot records ${snapshot.argvHash} and the argv about to run hashes to ${actualArgvHash}` };

  // THE ROW BEFORE THE PROCESS. A row written after the spawn is a window in
  // which a live worker is invisible to admission, to the reaper and to a
  // restart.
  const inserted = insertRun(db, { ...runKey, outPath, errPath, snapshot, drift,
                                   startedAt: now(), leaseSeconds, isAlive });
  if (!inserted.ok) return { ok: false, reason: inserted.reason };

  // AND THE ARGV RECORD IS WRITTEN ONLY ONCE THE ROW IS GRANTED. Written first,
  // a refused dispatch overwrote the SETTLED attempt's durable record with argv
  // that never ran: the row kept the original `argv_hash` while the file beside
  // it held different bytes, so the audit trail disagreed with itself and the
  // retry evidence was gone. The row is the permission; the file is what the
  // permission was for.
  //
  // The COMPLETE argv, not only the hash. A hash answers "did it change"; the
  // argv answers "what changed", which is the question after a retry behaves
  // differently from the attempt it was supposed to reproduce.
  //
  // AND A FAILURE HERE SETTLES THE ROW IT WAS WRITTEN FOR. Moving the write
  // below the insert closed one hole and opened its mirror: a full disk, a
  // changed permission or a directory occupying the path throws AFTER the row
  // is committed and BEFORE the try that would settle it, leaving `phase_run`
  // live with no process -- and `one_live_run` then blocks every later dispatch
  // of that task until something else intervenes. The same fault the throw
  // handler below exists for, reached by a different door.
  try {
    writeFileSync(argvPath, JSON.stringify({ argv, argvHash: snapshot.argvHash }, null, 2) + "\n");
  } catch (e) {
    settleRun(db, { ...runKey, status: "failed", outcome: OUTCOMES.CRASHED,
                    evidence: { why: `the argv record could not be written: ${e.message}`, denials: [], cost: null },
                    truncated: 0, isAlive });
    return { ok: false, reason: "argv-record-failed", runKey, error: e.message };
  }

  // A HEARTBEAT THAT COULD NOT BE WRITTEN IS A CLAIM THAT WAS NOT RENEWED, and
  // swallowing it lets the worker act without one. The failure is not
  // self-correcting from the row's side: `revocationProbe` reads a
  // lease_expires_at that is still in the future -- precisely because nobody
  // could move it -- and answers `null`, so the worker keeps going for the rest
  // of the lease. A live maintenance lock is the case that matters: writes are
  // refused for the duration of a restore, which is exactly when a worker must
  // not still be acting.
  let heartbeatFailure = null;
  const beat = setInterval(
    () => {
      try {
        const h = heartbeatRun(db, { ...runKey, at: now(), leaseSeconds, isAlive });
        if (!h.ok) heartbeatFailure = `the heartbeat was refused: ${h.reason}`;
      } catch (e) { heartbeatFailure = `the heartbeat could not be written: ${e.message}`; }
    },
    Math.max(1000, Math.floor(leaseSeconds / 4) * 1000));

  let result;
  try {
    result = await run({
      bin, args: argv, cwd, env, outPath, errPath, maxOutputBytes, budgetMs, graceMs,
      // FAIL CLOSED. A throw here is S1's UNBOUND path: the group is killed and
      // the worker never gets to run unobserved.
      // BOTH BINDINGS, run row first, and either throwing stays fail closed.
      onSpawn: ({ pid, lstart }) => {
        bind(db, { ...runKey, pid, lstart, isAlive });
        if (onSpawn) onSpawn({ pid, lstart });
      },
      isHalted,
      // THE ROW FIRST, the heartbeat second, and the order is the classification.
      // A cancelled row answers with a reason beginning `cancelled`, which is what
      // makes runWorker record an operator cancel rather than a lost lease. Asking
      // the heartbeat first would report a deliberate cancel as a lease failure
      // whenever both were true -- the same stop, the wrong follow-up.
      isRevoked: () => revocationProbe(db, runKey) ?? heartbeatFailure,
    });
  } catch (e) {
    // A REJECTION IS AN OUTCOME TOO, and leaving the row live is worse than any
    // of them. The `finally` that clears the heartbeat does not settle the row,
    // so a `runWorker` that THREW rather than returning left `phase_run` saying
    // `live` for a process that is gone -- and `one_live_run` then refuses the
    // task's next dispatch forever, on behalf of nothing. Nobody would see it
    // until the task simply stopped progressing.
    clearInterval(beat);
    settleRun(db, { ...runKey, status: "failed", outcome: OUTCOMES.CRASHED,
                    evidence: { why: `the dispatch threw: ${e.message}`, denials: [], cost: null },
                    truncated: 0, isAlive });
    return { ok: false, reason: "dispatch-threw", runKey, error: e.message };
  }
  clearInterval(beat);

  const status = result.outcome === OUTCOMES.OK ? "succeeded"
    : result.outcome === OUTCOMES.CANCELLED || result.outcome === OUTCOMES.LEASE_LOST ? "killed"
    : "failed";
  settleRun(db, { ...runKey, status, outcome: result.outcome,
                  evidence: { why: result.why, denials: result.denials ?? [], cost: result.cost ?? null },
                  // EITHER STREAM. `runWorker` reports stdout truncation as
                  // `truncated` and stderr's separately as `stderrTruncated`,
                  // and it classifies a stderr-only truncation as FAILED for the
                  // same reason this bit exists: the durable record is
                  // incomplete. Reading only the first stored 0 beside a run
                  // whose evidence is missing, so replay and every audit surface
                  // reported it as complete.
                  truncated: (result.truncated || result.stderrTruncated) ? 1 : 0,
                  // Learned from the worker's init event, so it arrives on the
                  // RESULT and never at `onSpawn`, which bound a null.
                  sessionId: result.sessionId ?? null, isAlive });
  if (result.outcome === OUTCOMES.UNBOUND)
    return { ok: false, reason: "unbound", runKey, pid: result.pid ?? null, result };
  // `runKey`, `argv` and `env` travel with the answer: they are what the tick
  // logs and what a reader compares a retry against, and re-deriving them at the
  // caller is how two spellings of one dispatch start to disagree.
  return { ok: true, runKey, argv, env, result };
}
