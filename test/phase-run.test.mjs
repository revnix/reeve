// `one_live_run` is the database's opinion about two workers on one task, and it
// has to be the database's rather than the caller's. A caller-side count is a
// read followed by a write, and two ticks interleave there -- which is exactly
// the shape that put two workers on one subscription slot before the provider
// scheduler existed.
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHub } from "../src/build/hubdb.mjs";
import { insertRun, bindRun, heartbeatRun, settleRun, runStatus, liveRuns,
         runPathsFor, revocationProbe } from "../src/build/run.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-phaserun-"));
const db = openHub(join(dir, "hub.db"));
const alive = () => true;
const task = (id) => db.exec(
  `INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,generation,source_kind,source_key,
     repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,created_at,updated_at)
   VALUES('${id}','p',7,'o/r','t','RESEARCH',1,'founder','${id}','/p','/f','h','main','private',1,
          unixepoch(),unixepoch())`);
task("bt:a"); task("bt:b");

const KEY = { task: "bt:a", generation: 1, phase: "RESEARCH", slice: 0, attempt: 1 };
const PATHS = { outPath: join(dir, "a.out"), errPath: join(dir, "a.err") };
const SNAP = { cliVersion: "1.2.3", modelId: "claude-fable-4-5-20260101", effort: "high",
               argvHash: "a".repeat(64), promptHash: "b".repeat(64), settingsHash: "c".repeat(64),
               toolsHash: "d".repeat(64), agentsHash: "e".repeat(64),
               maxTurns: 60, maxBudgetUsd: 5, canaryId: "canary-1", snapshotHash: "f".repeat(64) };
// A STUB DOES NOT MAKE AN ASSERTION FAIL -- it usually makes a CALL THROW, and a
// throw kills the whole file, so every assertion after it never runs and reads
// in the log exactly like one that passed. Two entries in the manifest were
// UNRUNNABLE for that reason before this existed.
//
// `ok: null` is neither true nor false, so whichever direction the consuming
// assertion tests, it goes red rather than the file dying on the line above it.
// `threw` is carried so a red says what happened instead of merely that it did.
//
// NOT APPLIED where the exception IS the subject: `bindRun` must throw, and the
// assertion for that calls it directly inside its own try, because wrapping it
// would report a fail-closed binding as having succeeded.
const attempt = (fn) => {
  try { return fn(); } catch (e) { return { ok: null, reason: null, threw: String(e.message) }; }
};
const ins = (over = {}) => attempt(() => insertRun(db, { ...KEY, ...PATHS, snapshot: SNAP, drift: null,
                                           startedAt: 1000, leaseSeconds: 400, isAlive: alive, ...over }));
const beat = (args) => attempt(() => heartbeatRun(db, args));

// ── one live run per task, enforced by the index ─────────────────────────────
{
  const first = ins();
  check(first.ok === true, "the first live run for a task is admitted", JSON.stringify(first));
  check(runStatus(db, KEY) === "live", "and the row reads live", String(runStatus(db, KEY)));

  const second = ins({ attempt: 2, startedAt: 1001 });
  check(second.ok === false && second.reason === "live-run-exists",
    "a second live run for the SAME task is refused", JSON.stringify(second));
  check(db.prepare("SELECT count(*) c FROM phase_run WHERE task='bt:a'").get().c === 1,
    "and NOTHING was inserted -- a refusal that leaves a row is a second worker's permission slip",
    JSON.stringify(db.prepare("SELECT task,attempt,status FROM phase_run").all()));

  // CONTROL. The refusal is about one task, not about phase_run: an implementation
  // that refused every second insert would pass the assertion above and stop the
  // builder dead at two tasks.
  const other = ins({ task: "bt:b", startedAt: 1002 });
  check(other.ok === true, "control: a DIFFERENT task's first live run is admitted", JSON.stringify(other));

  // A TASK THE HUB HAS NO ROW FOR is the third refusal, and it is the database's
  // too: the foreign key is what answers, not a SELECT the caller could skip.
  const orphan = ins({ task: "bt:nope", startedAt: 1003 });
  check(orphan.ok === false && orphan.reason === "no-such-task",
    "a run for a task that does not exist is refused", JSON.stringify(orphan));
}

// ── the three refusals are told apart, INCLUDING where two rules break at once ──
//
// The mapping is read from the errcode. Proven only on inputs that violate one
// rule at a time it would never see the overlap: re-inserting an attempt whose
// row is still LIVE breaks the primary key AND the partial index, and SQLite
// reports the index. 2067 is the right answer there -- a live run does exist --
// but a classifier keyed on the message cannot reach it, because the primary
// key's text CONTAINS the index's `phase_run.task` as a substring.
{
  const overlap = ins({ startedAt: 1400 });
  check(overlap.ok === false && overlap.reason === "live-run-exists",
    "re-inserting an attempt whose row is still LIVE answers live-run-exists, not duplicate-attempt",
    JSON.stringify(overlap));
  check(db.prepare("SELECT count(*) c FROM phase_run WHERE task='bt:a'").get().c === 1,
    "control: and it inserted nothing either", JSON.stringify(overlap));
}

// ── the heartbeat names its own cadence, and a beat for nothing is a refusal ──
{
  const h = beat({ ...KEY, at: 1100, leaseSeconds: 400, isAlive: alive });
  check(h.ok === true && h.expiresAt === 1500,
    "a heartbeat extends the lease from NOW, not from the run's start", JSON.stringify(h));
  check(h.beatEvery === 100,
    "and returns the cadence it must be called at, derived as lease/4 rather than configured twice",
    JSON.stringify(h));

  const nothing = beat({ ...KEY, attempt: 9, at: 1100, leaseSeconds: 400, isAlive: alive });
  check(nothing.ok === false && nothing.reason === "no-such-run",
    "a heartbeat for a run that does not exist is a refusal, never a silent no-op",
    JSON.stringify(nothing));
}

// ── binding fails CLOSED ─────────────────────────────────────────────────────
{
  const bound = attempt(() => bindRun(db, { ...KEY, pid: 4242, lstart: "42", sessionId: "s-1", isAlive: alive }));
  check(bound.task === "bt:a", "a live run accepts a process binding", JSON.stringify(bound));
  // `?? {}` for the same reason: with no row the read answers undefined and
  // the property access below throws, which ends the file instead of failing.
  const row = db.prepare("SELECT pid, lstart, session_id FROM phase_run WHERE task='bt:a' AND attempt=1").get() ?? {};
  check(row.pid === 4242 && row.lstart === "42" && row.session_id === "s-1",
    "and the pid, its start and the session are what the row now says", JSON.stringify(row));

  // THROWS rather than returning a refusal, because S1 turns a throw from
  // onSpawn into a killed process group. A binding that returned {ok:false}
  // would leave a running worker that no row can name.
  let threw = null;
  try { bindRun(db, { ...KEY, attempt: 77, pid: 1, lstart: "1", isAlive: alive }); }
  catch (e) { threw = String(e.message); }
  check(threw !== null && /no live run row/.test(threw),
    "binding a process to a run that does not exist THROWS, so the spawn is killed rather than orphaned",
    String(threw));
}

// ── attempt is monotonic and never reused ────────────────────────────────────
{
  settleRun(db, { ...KEY, status: "succeeded", outcome: "ok", evidence: null, truncated: 0, isAlive: alive });
  check(runStatus(db, KEY) === "succeeded", "a settled run leaves the live index", String(runStatus(db, KEY)));

  const next = ins({ attempt: 2, startedAt: 1200 });
  check(next.ok === true, "so the next attempt is admitted", JSON.stringify(next));
  const rows = db.prepare("SELECT attempt,status FROM phase_run WHERE task='bt:a' ORDER BY attempt").all();
  check(rows.length === 2 && rows[0].attempt === 1 && rows[0].status === "succeeded",
    "and the previous attempt's row SURVIVES: attempt is monotonic and never reused", JSON.stringify(rows));

  settleRun(db, { ...KEY, attempt: 2, status: "succeeded", outcome: "ok", truncated: 0, isAlive: alive });
  const again = ins({ attempt: 1, startedAt: 1300 });
  check(again.ok === false && again.reason === "duplicate-attempt",
    "re-inserting a settled attempt number is refused, not an upsert over the record of what happened",
    JSON.stringify(again));
  check((db.prepare("SELECT status FROM phase_run WHERE task='bt:a' AND attempt=1").get() ?? {}).status === "succeeded",
    "and attempt 1 still says what it said");
}

// ── the contract snapshot, and the drift that is recorded but never acted on ──
{
  const K3 = { ...KEY, attempt: 3 };
  const drift = { modelId: { was: "claude-fable-4-5-20260101", now: "other" }, maxTurns: { was: 60, now: 10 } };
  const r = ins({ attempt: 3, startedAt: 1500, drift });
  check(r.ok === true, "a run records the contract it was dispatched under", JSON.stringify(r));
  const row = db.prepare("SELECT cli_version, model_id, effort, max_turns, snapshot_hash, contract_drift FROM phase_run WHERE task='bt:a' AND attempt=3").get() ?? {};
  check(row.cli_version === "1.2.3" && row.model_id === SNAP.modelId && row.effort === "high" &&
        row.max_turns === 60 && row.snapshot_hash === SNAP.snapshotHash,
    "and the snapshot columns are the values it was given", JSON.stringify(row));

  // THE DRIFT KEEPS ITS VALUES. Serialised with a replacer ARRAY -- which is a
  // key whitelist applied at every level, not an ordering -- every nested
  // object empties, and the column would record WHICH fields drifted while
  // destroying what they drifted to. That is the only thing the column is for.
  // JSON.parse of a missing column throws for the same reason, so it is read
  // through a guard that answers {} instead of ending the file.
  const back = (() => { try { return JSON.parse(row.contract_drift); } catch { return {}; } })();
  check(back.modelId && back.modelId.was === "claude-fable-4-5-20260101" && back.modelId.now === "other",
    "the drift's nested values SURVIVE serialisation", row.contract_drift);
  check(back.maxTurns && back.maxTurns.was === 60 && back.maxTurns.now === 10,
    "control: and so do a second field's, so the first is not surviving by accident", row.contract_drift);
  check(row.contract_drift === '{"maxTurns":{"now":10,"was":60},"modelId":{"now":"other","was":"claude-fable-4-5-20260101"}}',
    "and the bytes are the hub's own canonical form, so a replay compares against the event log rather than a second spelling",
    row.contract_drift);

  settleRun(db, { ...K3, status: "succeeded", outcome: "ok", truncated: 0, isAlive: alive });
}

// ── liveRuns is what admission and restart count ─────────────────────────────
{
  const live = liveRuns(db);
  check(live.length === 1 && live[0].task === "bt:b",
    "liveRuns returns exactly the rows still entitled to a process", JSON.stringify(live.map(r => [r.task, r.status])));
}

// ── the revocation probe: what isRevoked will be given ───────────────────────
{
  const K2 = { ...KEY, attempt: 4 };
  ins({ attempt: 4, startedAt: 1600, leaseSeconds: 400 });
  check(revocationProbe(db, K2, { at: 1700 }) === null,
    "a live run is not revoked", String(revocationProbe(db, K2, { at: 1700 })));

  // A LEASE THAT RAN OUT is a stop with a different follow-up from a cancel,
  // and the two must not read alike: another process may already have adopted
  // this run, which is never true of a deliberate kill.
  const late = revocationProbe(db, K2, { at: 9999 });
  check(typeof late === "string" && /lease expired/.test(late) && !/^cancelled/.test(late),
    "an expired lease revokes, and does NOT read as a cancellation", String(late));

  db.exec("UPDATE phase_run SET status='killed' WHERE task='bt:a' AND attempt=4");
  const why = revocationProbe(db, K2, { at: 1700 });
  check(typeof why === "string" && /^cancelled\b/.test(why),
    "a killed row answers with a reason beginning `cancelled`, which is how the supervisor tells a cancel from a lost lease",
    String(why));

  db.exec("DELETE FROM phase_run WHERE task='bt:a' AND attempt=4");
  const gone = revocationProbe(db, K2, { at: 1700 });
  check(typeof gone === "string" && gone.length > 0,
    "a run row that has VANISHED is revoked too: absent and live are not the same fact, and only one of them entitles a process to keep running",
    String(gone));
}

// ── one attempt's files are its own ──────────────────────────────────────────
{
  const p = runPathsFor("/home", KEY);
  check(p.outPath.endsWith("g1-RESEARCH-s0-a1.out") && p.errPath.endsWith("g1-RESEARCH-s0-a1.err"),
    "an attempt's paths carry its whole key", JSON.stringify(p));
  const p2 = runPathsFor("/home", { ...KEY, attempt: 2 });
  check(p2.outPath !== p.outPath,
    "so a resumed attempt writes a NEW file rather than appending to the one being read",
    JSON.stringify([p.outPath, p2.outPath]));
}

// ── the contract snapshot is frozen, in both halves ─────────────────────────
//
// A freeze verified only against the half it already covered proves nothing
// about the half that was added. The COLUMNS are what phase_run promises;
// `insertRun`'s statement is what actually reaches them. A column added to one
// without the other is a permanent NULL that reads as recorded.
{
  const { createHash } = await import("node:crypto");
  const frozen = JSON.parse(readFileSync(new URL("./fixtures/phase-run-contract.json", import.meta.url), "utf8"));
  const cols = db.prepare("SELECT name FROM pragma_table_info('phase_run')").all().map((r) => r.name).sort();
  check(JSON.stringify(cols) === JSON.stringify(frozen.columns),
    "phase_run's columns are unchanged since PR-C1 froze them",
    `expected ${frozen.columns.join(",")}\n        actual   ${cols.join(",")}\n        ` +
    "A new column needs a new numbered migration AND an entry in TABLES_AT/COLUMNS_AT.");

  const src = readFileSync(new URL("../src/build/run.mjs", import.meta.url), "utf8");
  check(src.length > 2000, "control: src/build/run.mjs was actually read", String(src.length));
  check(createHash("sha256").update(src).digest("hex") === frozen.writerSha256,
    "and so is the writer that fills them",
    "If this change is intentional, re-generate the fixture in the same commit and say in the body which column moved.");

  // AND THE PROPERTY THE FREEZE EXISTS FOR, asserted directly rather than
  // inferred from a hash. A sha over the whole file reddens on a comment and
  // stays green on nothing else -- it is a tripwire, not a check. What actually
  // matters is that every column of the CONTRACT family is reached by the
  // insert: a snapshot column that exists and is never written is worse than a
  // missing one, because it reads as recorded and drift is computed against it.
  //
  // The other columns are deliberately absent from this list: status is a
  // literal, pid/lstart/session_id are bindRun's, and outcome/evidence/truncated
  // are settleRun's. Naming the family rather than "every column" is what keeps
  // this assertion about the contract instead of about the schema.
  const CONTRACT = ["cli_version", "model_id", "effort", "argv_hash", "prompt_hash", "settings_hash",
                    "tools_hash", "agents_hash", "max_turns", "max_budget_usd", "canary_id",
                    "snapshot_hash", "contract_drift"];
  const insert = src.slice(src.indexOf("const INSERT_SQL"), src.indexOf("export function insertRun"));
  check(insert.includes("INSERT INTO phase_run"),
    "control: the insert statement was located in the source", insert.slice(0, 60));
  const unwritten = CONTRACT.filter((c) => !insert.includes(c));
  check(unwritten.length === 0,
    "every contract column is reached by the insert, so none can exist unwritten",
    JSON.stringify(unwritten));
  const missingFromTable = CONTRACT.filter((c) => !cols.includes(c));
  check(missingFromTable.length === 0,
    "control: and every one of them is a real column, so the list cannot pass by naming nothing",
    JSON.stringify(missingFromTable));
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
