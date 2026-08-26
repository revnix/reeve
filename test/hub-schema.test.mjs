// The hub is the authority for who is allowed to do what, so it does not
// inherit the guardian's pragmas. synchronous=NORMAL can lose the last
// transactions on power loss, which for the guardian costs a re-poll and for
// the hub would mean an approval or a merge decision that the database no
// longer remembers granting. It is also forward-only: an older binary opening
// a newer store would read columns it does not know about as absent, and
// absence is never read as success anywhere else in this system either.
import { hubPathFor, statePathFor } from "../src/paths.mjs";
import { openHub, hubTx, HUB_SCHEMA_VERSION, COLUMNS_AT } from "../src/build/hubdb.mjs";
import { validateSnapshot } from "../src/backup.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const dir = mkdtempSync(join(tmpdir(), "reeve-hub-"));

// ── the path is one place, and it is not a repository store ──────────────────
{
  check(hubPathFor("/h") === join("/h", "state", "hub.db"), "the hub lives at <home>/state/hub.db", hubPathFor("/h"));
  check(hubPathFor("/h") !== statePathFor("/h", "nextlyhq/nextly"),
    "and is not the same file as any repository's store", `${hubPathFor("/h")} vs ${statePathFor("/h", "nextlyhq/nextly")}`);
  check(hubPathFor("/h") !== statePathFor("/h", "hub/db"),
    "control: a repository literally named hub/db still does not collide with it");
}

// ── the pragmas the hub does not inherit ─────────────────────────────────────
{
  const db = openHub(join(dir, "p.db"));
  const one = (sql) => Object.values(db.prepare(sql).get())[0];
  check(String(one("PRAGMA journal_mode")).toLowerCase() === "wal", "journal_mode is WAL", String(one("PRAGMA journal_mode")));
  check(one("PRAGMA synchronous") === 2, "synchronous is FULL, not the guardian's NORMAL", `got ${one("PRAGMA synchronous")} (1=NORMAL, 2=FULL)`);
  check(one("PRAGMA foreign_keys") === 1, "foreign_keys is ON", String(one("PRAGMA foreign_keys")));
  check(one("PRAGMA busy_timeout") === 10000, "busy_timeout is 10s", String(one("PRAGMA busy_timeout")));
  db.close();
}

// ── the version is recorded, and opening again is inert ──────────────────────
{
  const p = join(dir, "v.db");
  const a = openHub(p);
  const v1 = a.prepare("SELECT max(version) v FROM schema_version").get().v;
  check(v1 === HUB_SCHEMA_VERSION, "a fresh store records the binary's schema version", `${v1} vs ${HUB_SCHEMA_VERSION}`);
  const rows1 = a.prepare("SELECT count(*) c FROM schema_version").get().c;
  a.close();
  const b = openHub(p);
  const rows2 = b.prepare("SELECT count(*) c FROM schema_version").get().c;
  check(rows2 === rows1, "re-opening applies nothing and appends no version row", `${rows1} then ${rows2}`);
  b.close();
}

// ── forward-only: an older binary refuses a newer store ──────────────────────
{
  const p = join(dir, "future.db");
  openHub(p).close();
  const raw = new DatabaseSync(p);
  // CONTIGUOUS, not merely tall. Writing only `HUB_SCHEMA_VERSION + 7` leaves
  // every version between it and this binary's missing, so `openHub`'s
  // CONTIGUITY refusal fires first and this whole block passes against an
  // implementation with no forward-version check at all. Measured, not
  // supposed: with both version checks stubbed out the refusal read
  // `records schema version 8 but is missing migration(s) 2, 3, 4, 5, 6, 7`
  // and every assertion here stayed green.
  for (let v = HUB_SCHEMA_VERSION + 1; v <= HUB_SCHEMA_VERSION + 7; v++)
    raw.exec(`INSERT INTO schema_version(version, applied_at) VALUES(${v}, unixepoch())`);
  raw.close();
  let why = null;
  try { openHub(p); } catch (e) { why = e.message; }
  check(why !== null, "a store recorded above this binary's version refuses to open");
  // The PHRASES, not bare digits. `why.includes("1")` is satisfied by any "1"
  // anywhere in the message -- and the message contains a tmpdir path, which on
  // this machine supplied one, so that assertion was green by accident.
  check(new RegExp(`schema version ${HUB_SCHEMA_VERSION + 7}\\b`).test(String(why)) &&
        new RegExp(`this binary knows ${HUB_SCHEMA_VERSION}\\b`).test(String(why)),
    "and the refusal names both versions, so the operator knows which binary to run", String(why));
  // WHICH refusal. Contiguity and forward-version are different failures and
  // only one is this block's subject; without this line the assertions above
  // are satisfied by a hole the fixture itself created.
  check(!/missing migration/.test(String(why)),
    "and it is refused for being NEWER than this binary, not for a hole in its history", String(why));
  // And by the OPENING check, not the locked recheck. Both refuse a newer
  // store, so removing the opening one alone leaves this block green -- while
  // the operator gets `It was migrated by a newer reeve while this one was
  // opening it`, which describes a concurrent migration that did not happen.
  // The two exist for different reasons and each needs its own assertion.
  check(/Migrations are forward-only/.test(String(why)),
    "and the message is the opening refusal, not the concurrent-migration one that would misdescribe it",
    String(why));
}

// ── hubTx rolls back, so a failed transition leaves nothing behind ───────────
{
  const db = openHub(join(dir, "tx.db"));
  db.exec("CREATE TABLE t(x INTEGER) STRICT");
  try { hubTx(db, () => { db.exec("INSERT INTO t VALUES(1)"); throw new Error("boom"); }); } catch {}
  check(db.prepare("SELECT count(*) c FROM t").get().c === 0, "hubTx rolls back on a throw");
  hubTx(db, () => db.exec("INSERT INTO t VALUES(2)"));
  check(db.prepare("SELECT count(*) c FROM t").get().c === 1, "control: hubTx commits when the body returns");
  db.close();
}

// ── family 1: identity and state ─────────────────────────────────────────────
{
  const db = openHub(join(dir, "f1.db"));
  const tables = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name));
  for (const t of ["task","task_territory","task_drain","phase_event","hold_reason","hub_event","phase_run","gate_run"])
    check(tables.has(t), `openHub creates ${t}`);

  // STRICT is the point of the whole file: without it a TEXT lands in an
  // INTEGER column and nothing complains until something reads it back.
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?");
  for (const t of ["task","phase_event","hub_event","phase_run","gate_run"])
    check(/\bSTRICT\b/.test(sql.get(t).sql), `${t} is STRICT`);
  for (const t of ["task_territory","task_drain","phase_run"])
    check(/WITHOUT ROWID/.test(sql.get(t).sql), `${t} is WITHOUT ROWID (its identity is composite)`);

  // The phase CHECK is the authoritative enumeration of section 3.1. If this
  // list and phases.mjs ever disagree, one of them is admitting a state the
  // other refuses, and the database is the half that cannot be argued with.
  const ins = (phase) => {
    try {
      db.prepare(`INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,source_kind,source_key,
                                   repo_path,profile_path,profile_hash,default_branch,visibility,
                                   registry_version,created_at,updated_at)
                  VALUES(?,'p',1,'o/r','t',?,'founder',?, '/p','/f','h','main','private',1,unixepoch(),unixepoch())`)
        .run(`bt:${phase}`, phase, `k:${phase}`);
      return true;
    } catch { return false; }
  };
  const LEGAL = ["FILED","CLAIMING","SIZING","RESEARCH","DESIGN","SPEC_DRAFT","SPEC_PR_OPEN","GATE",
                 "APPROVED","IMPLEMENTING","IMPL_PR_OPEN","VERDICT_WAIT","SLICE_MERGED","FINALIZING",
                 "BLOCKED","ESCALATED","CANCELLING","DONE","CANCELLED","LOST","INFEASIBLE"];
  check(LEGAL.every(ins), "every one of the 21 phases in the section 3.1 enumeration is accepted");
  check(!ins("REVISING"), "REVISING is refused: a revision is an edge, never a state");
  check(!ins("PHASE_FAILED"), "PHASE_FAILED is refused: it is a phase_run outcome, never a state");
  check(!ins("implementing"), "control: the CHECK is case-sensitive, so a lowercased phase cannot slip in");

  // A territory claim that is not one of the two accepted shapes is refused by
  // the database as well as by the grammar, because the grammar is code and
  // this is the row that outlives it.
  const terr = (kind) => { try {
    db.prepare("INSERT INTO task_territory(task,kind,path) VALUES('bt:FILED',?,'packages/x')").run(kind);
    return true; } catch { return false; } };
  // Both kinds, asserted separately. `a === false || b` is SATISFIED when the
  // schema wrongly rejects 'file' (the left side becomes true), so the original
  // passed on exactly the breakage it was written to catch.
  check(terr("file"), "task_territory accepts an exact-file claim");
  check(terr("prefix"), "and a recursive-prefix claim");
  check(!terr("glob"), "and refuses anything else, including glob");

  // At most one live run per task. The guardian's run table learned this the
  // hard way; the hub is not going to relearn it.
  const run = (attempt, status) => { try {
    db.prepare(`INSERT INTO phase_run(task,generation,phase,slice,attempt,resume_seq,status,started_at,heartbeat_at,lease_expires_at,out_path,err_path)
                VALUES('bt:FILED',1,'RESEARCH',0,?,0,?,unixepoch(),unixepoch(),unixepoch()+120,'/o','/e')`).run(attempt, status);
    return true; } catch { return false; } };
  check(run(1, "live"), "a live run is admitted");
  check(!run(2, "live"), "a SECOND live run for the same task is refused by one_live_run");
  check(run(3, "succeeded"), "control: a settled run beside a live one is fine, so the index is partial and not a blanket");

  db.close();
}

// ── family 2: gate evidence and the attested chain ───────────────────────────
{
  const db = openHub(join(dir, "f2.db"));
  const tables = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name));
  for (const t of ["gate_request","approval","notice_receipt","task_pr","attested_push","guardian_receipt","ownership_check","harness_acceptance"])
    check(tables.has(t), `openHub creates ${t}`);

  db.exec(`INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,source_kind,source_key,
             repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,created_at,updated_at)
           VALUES('bt:1','p',1,'o/r','t','GATE','founder','k','/p','/f','h','main','private',1,unixepoch(),unixepoch())`);

  const approve = (kind, verdict, path) => { try {
    db.prepare(`INSERT INTO approval(task,spec_repo_id,spec_pr,head_sha,actor_id,actor_login_snapshot,kind,verdict,path,observed_at,source_id,task_generation)
                VALUES('bt:1',9,1,?,5,'m',?,?,?,unixepoch(),?,1)`)
      .run("a".repeat(40), kind, verdict, path, `${kind}:${verdict}:${path}`);
    return true; } catch { return false; } };
  check(approve("codex_clean", "clean", null), "a Codex clean pass is a legal approval row");
  check(approve("founder_silence", "approve", "codex_clean_silence"), "so is a silence approval carrying its path");
  check(!approve("waiver", "approve", null), "there is no waiver kind: the Codex-unavailable path is an approval row, not a waiver");
  check(!approve("founder_review", "lgtm", null), "control: an invented verdict is refused, so the CHECK is on verdict too");

  // A merge witness must be traceable to a pusher AND to the mechanism that
  // recorded it. builder pushes arrive through the outbox; guardian pushes
  // arrive as imported receipts. A row claiming a builder push arrived as a
  // guardian_event is a chain nobody can verify, so the pairing is a CHECK.
  const push = (pusher, sourceKind) => { try {
    db.prepare(`INSERT INTO attested_push(task,generation,slice,pr,sha,pusher,source_kind,source_ref,at)
                VALUES('bt:1',1,0,7,?,?,?,'r',unixepoch())`).run(`${pusher}${sourceKind}`.padEnd(40,"0").slice(0,40), pusher, sourceKind);
    return true; } catch { return false; } };
  check(push("builder", "outbox"), "a builder push attests through the outbox");
  check(push("guardian", "guardian_event"), "a guardian push attests through an imported receipt");
  check(!push("builder", "guardian_event"), "a builder push claiming a guardian receipt is refused");
  check(!push("guardian", "outbox"), "and a guardian push claiming the hub outbox is refused");

  // At-least-once delivery is the guardian receipt contract. Importing the same
  // seq twice must be inert, not a second row and not an error the caller has
  // to special-case away.
  const receipt = () => db.prepare(
    `INSERT INTO guardian_receipt(repo_id,guardian_event_seq,kind,pr,head_before,head_after,payload_hash,received_at,status)
     VALUES(1,42,'push.settled',7,'a','b','h',unixepoch(),'imported') ON CONFLICT DO NOTHING`).run();
  receipt(); receipt();
  check(db.prepare("SELECT count(*) c FROM guardian_receipt WHERE repo_id=1 AND guardian_event_seq=42").get().c === 1,
    "importing the same guardian_event seq twice leaves exactly one receipt");

  // impl_pr binds a PR to a slice, and UNIQUE(repo_id, pr) is what the receipt
  // importer joins on. Two slices claiming one PR would make that join
  // ambiguous and a merge would be attributed to the wrong slice.
  db.exec(`INSERT INTO task_pr(task,kind,generation,slice,repo_id,pr,head_sha,created_at) VALUES('bt:1','impl',1,0,1,7,'h0',unixepoch())`);
  let dup = true;
  try { db.exec(`INSERT INTO task_pr(task,kind,generation,slice,repo_id,pr,head_sha,created_at) VALUES('bt:1','impl',1,1,1,7,'h1',unixepoch())`); }
  catch { dup = false; }
  check(!dup, "two slices cannot bind the same (repo_id, pr)");

  db.close();
}

// ── family 3: holds and authority ────────────────────────────────────────────
{
  const db = openHub(join(dir, "f3.db"));
  for (const t of ["pr_hold","project_authority","repo_gate_state"]) {
    const has = db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name=?").get(t).c === 1;
    check(has, `openHub creates ${t}`);
  }
  db.exec(`INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,source_kind,source_key,
             repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,created_at,updated_at)
           VALUES('bt:1','p',1,'o/r','t','BLOCKED','founder','k','/p','/f','h','main','private',1,unixepoch(),unixepoch())`);

  const hold = (reason) => { try {
    db.prepare(`INSERT INTO pr_hold(task,repo_id,pr,head_sha,reason,created_at) VALUES('bt:1',1,7,?,?,unixepoch())`)
      .run("a".repeat(40), reason); return true; } catch { return false; } };
  check(hold("cancel"), "a hold is written for an open builder PR");

  // The whole point of one_open_hold: a task that is held twice must not
  // accumulate two open rows, because the guardian's verdict clause asks "is
  // there an uncleared hold" and clearing one of two would answer no while the
  // other still stands.
  check(!hold("escalated"), "a SECOND open hold on the same (repo_id, pr) is refused");
  db.exec("UPDATE pr_hold SET cleared_at=unixepoch() WHERE cleared_at IS NULL");
  check(hold("escalated"), "control: once cleared, the same PR can be held again");
  check(!hold("because-i-said-so"), "an invented hold reason is refused; the set is closed");

  // An expired authority row authorizes nothing. Storing `until` as an INTEGER
  // is what makes that a comparison rather than a string parse at merge time.
  db.exec(`INSERT INTO project_authority(project_id,kind,granted_by,until,created_at)
           VALUES('nextly','review-witness',5,unixepoch()+3600,unixepoch())`);
  const live = db.prepare(
    `SELECT count(*) c FROM project_authority WHERE project_id='nextly' AND kind='review-witness' AND until > unixepoch()`).get().c;
  check(live === 1, "a live review-witness grant is findable by a plain comparison");
  let badKind = true;
  try { db.exec(`INSERT INTO project_authority(project_id,kind,granted_by,until,created_at) VALUES('n','merge',5,1,1)`); }
  catch { badKind = false; }
  check(!badKind, "review-witness is the only authority kind there is");

  // repo_gate_state has no merge-permission probe column, by design: nothing in
  // this system ever attempts a merge against a production repository to find
  // out whether it could.
  const cols = new Set(db.prepare("PRAGMA table_info(repo_gate_state)").all().map(c => c.name));
  check(cols.has("ruleset_requires_check") && cols.has("bound_app_id") && cols.has("expected_app_id") && cols.has("verified_at"),
    "repo_gate_state records what the ruleset requires and which app is bound", [...cols].join(","));
  check(![...cols].some(c => /merge.*(probe|permission)|can_merge/.test(c)),
    "and carries no merge-permission probe column", [...cols].join(","));
  db.close();
}

// ── family 4: effects, transport, coordination ───────────────────────────────
{
  const db = openHub(join(dir, "f4.db"));
  for (const t of ["inbox","outbox","merge_decision","singleton_lease","writer_lease","maintenance_lock",
                   "directory_lease","territory_lease","provider_lease","provider_state","intake_event","escalation"]) {
    const has = db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name=?").get(t).c === 1;
    check(has, `openHub creates ${t}`);
  }
  db.exec(`INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,source_kind,source_key,
             repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,created_at,updated_at)
           VALUES('bt:1','p',1,'o/r','t','SPEC_DRAFT','founder','k','/p','/f','h','main','private',1,unixepoch(),unixepoch())`);

  // outbox.fence is a FOREIGN KEY to phase_event(seq), so the authorising event
  // has to exist before any effect can reference it. Seq 1 is minted here for
  // the same reason the transition transaction writes phase_event before it
  // enqueues: an effect whose authorisation cannot be checked should be
  // impossible to store, not merely unusual.
  db.exec(`INSERT INTO phase_event(seq,task,at,op,from_phase,to_phase,detail)
           VALUES(1,'bt:1',unixepoch(),'seed',NULL,'SPEC_DRAFT','{}')`);

  // The builder never publishes a check run on any production repository; the
  // guardian is the sole publisher of ops/merge-policy there. That is not a
  // convention to remember at the call site -- there is no kind to enqueue.
  const kind = (k) => { try {
    db.prepare(`INSERT INTO outbox(idempotency_key,kind,task_id,task_generation,fence,cancellable,args,created_at,updated_at)
                VALUES(?,?, 'bt:1',1,1,1,'{}',unixepoch(),unixepoch())`).run(`k:${k}`, k); return true; } catch { return false; } };
  check(kind("git.push.branch") && kind("gh.pr.create") && kind("notify"), "the ordinary effect kinds are enqueueable");
  check(!kind("gh.check.publish"), "there is NO builder check-publish kind: the guardian is the sole publisher");
  check(!kind("gh.pr.forceMerge"), "control: an invented kind is refused, so the enumeration is closed and not open");

  // The fence FK, asserted rather than merely declared. Without this line the
  // REFERENCES clause is a claim the plan makes and no test checks, and a
  // migration that quietly dropped it would go unnoticed.
  const orphan = () => { try {
    db.prepare(`INSERT INTO outbox(idempotency_key,kind,task_id,task_generation,fence,cancellable,args,created_at,updated_at)
                VALUES('bt:1:orphan','notify','bt:1',1,9999,1,'{}',unixepoch(),unixepoch())`).run();
    return true; } catch { return false; } };
  check(!orphan(), "an effect whose fence names no phase_event is refused: authorisation must be checkable");

  // Key uniqueness is over LIVE rows only. A completed, voided, fenced or
  // failed row is history: a plain resume re-enqueues the same key and must be
  // ADMITTED beside it, then settled inert by its reconciler against external
  // truth. A blanket UNIQUE would either swallow the re-enqueue or refuse it.
  const again = () => { try {
    db.prepare(`INSERT INTO outbox(idempotency_key,kind,task_id,task_generation,fence,cancellable,args,created_at,updated_at)
                VALUES('bt:1:g1:SPEC_DRAFT:push:0','git.push.branch','bt:1',1,1,1,'{}',unixepoch(),unixepoch())`).run();
    return true; } catch { return false; } };
  check(again(), "a key is enqueueable once");
  check(!again(), "and refused while the first row is still live");
  db.exec("UPDATE outbox SET status='voided' WHERE idempotency_key='bt:1:g1:SPEC_DRAFT:push:0'");
  check(again(), "but admitted again once the earlier row is voided, because uniqueness is over live rows only");

  for (const s of ["voided","fenced","refused","superseded","forced"]) {
    let ok = true;
    try { db.exec(`UPDATE outbox SET status='${s}' WHERE id=1`); } catch { ok = false; }
    check(ok, `the hub-only outbox status '${s}' is legal`);
  }

  // The measured fact from the shadow week: pull_request.updated_at does NOT
  // change when a review thread is resolved. A column by that name invites
  // exactly the ordering that was blind, so the hub inbox does not have one.
  const inboxCols = new Set(db.prepare("PRAGMA table_info(inbox)").all().map(c => c.name));
  check(!inboxCols.has("updated_at"), "the hub inbox has no updated_at column", [...inboxCols].join(","));
  check(inboxCols.has("edited_at") && inboxCols.has("content_hash") && inboxCols.has("generation"),
    "it carries edited_at, content_hash and generation instead, so an edit is a new generation", [...inboxCols].join(","));
  check(inboxCols.has("complete") && inboxCols.has("payload_hash") && inboxCols.has("delivery_id"),
    "and completeness, payload hash and delivery id, so an incomplete page reads as UNKNOWN", [...inboxCols].join(","));

  // A clone belongs to no task; a worktree always belongs to one. Getting that
  // pairing wrong means a reaper that frees a live task's worktree.
  const dl = (kindV, task) => { try {
    db.prepare(`INSERT INTO directory_lease(path,owner_kind,task,pid,lstart,expires_at)
                VALUES(?,?,?,1,'x',unixepoch()+120)`).run(`/p/${kindV}/${task}`, kindV, task); return true; } catch { return false; } };
  check(dl("worktree", "bt:1"), "a worktree lease names its task");
  check(dl("clone", null), "a clone lease has no task");
  check(!dl("worktree", null), "a worktree lease WITHOUT a task is refused");
  check(!dl("clone", "bt:1"), "and a clone lease WITH one is refused");

  const pl = (owner, status) => { try {
    db.prepare(`INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,priority,status,requested_at,expires_at)
                VALUES(?,1,?,1,'x',0,?,unixepoch(),unixepoch()+120)`).run(owner, `${owner}${status}`, status); return true; } catch { return false; } };
  check(pl("guardian", "held") && pl("builder", "queued"), "both daemons can hold a provider lease row");
  check(!pl("worker", "held"), "and nothing else can");
  check(!pl("builder", "running"), "control: the status set is closed too");

  db.close();
}

// ── hub_event and migration shape ────────────────────────────────────────────
import { hubEvent, migrationPlan } from "../src/build/hubdb.mjs";
{
  const versions = migrationPlan().map(m => m.version);
  check(versions.length > 0, "there is at least one migration");
  check(versions.every((v, i) => v === i + 1), "migration versions are 1..N with no gaps and no reordering", versions.join(","));
  check(Math.max(...versions) === HUB_SCHEMA_VERSION, "HUB_SCHEMA_VERSION is the highest migration", `${Math.max(...versions)} vs ${HUB_SCHEMA_VERSION}`);

  const db = openHub(join(dir, "ev.db"));
  db.exec(`INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,source_kind,source_key,
             repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,created_at,updated_at)
           VALUES('bt:1','p',1,'o/r','t','FILED','founder','k','/p','/f','h','main','private',1,unixepoch(),unixepoch())`);

  // hub_event must join the CALLER's transaction. If it opened its own, a
  // transition that rolled back would still leave its event behind, and the
  // replay would rebuild a fact that never happened.
  // A hubEvent that opened its OWN transaction throws on the nested BEGIN, and a
  // bare catch swallows that -- leaving the row count at 0 for the wrong reason,
  // so the assertion passes against the very implementation it targets.
  let nested = null;
  try { hubTx(db, () => { hubEvent(db, { kind: "approval.recorded", task: "bt:1", payload: { a: 1 } }); throw new Error("SENTINEL"); }); }
  catch (e) { nested = e.message; }
  check(nested === "SENTINEL",
    "hubEvent joins the caller's transaction rather than opening its own",
    `the body's own error should surface; got ${nested} -- a BEGIN error means hubEvent wrapped itself`);
  check(db.prepare("SELECT count(*) c FROM hub_event").get().c === 0,
    "and a hub_event written in a transaction that rolls back leaves nothing");
  const seq = hubTx(db, () => hubEvent(db, { kind: "approval.recorded", task: "bt:1", payload: { b: 2 } }));
  check(typeof seq === "number" && seq > 0, "control: it returns its seq when the transaction commits", String(seq));

  // Payloads are canonical, so a replay compares byte for byte rather than
  // depending on whatever key order the writer happened to use.
  hubTx(db, () => hubEvent(db, { kind: "k", payload: { z: 1, a: 2 } }));
  const p = db.prepare("SELECT payload FROM hub_event ORDER BY seq DESC LIMIT 1").get().payload;
  check(p === '{"a":2,"z":1}', "payloads are canonical JSON with sorted keys", p);
  db.close();
}

// Migration 1 is FROZEN. A store that already applied v1 will never re-run it,
// so an edit here changes what new machines get and leaves every existing one
// behind with no error anywhere. New schema goes in a NEW numbered migration.
//
// BOTH halves. Hashing hub.sql alone freezes the DDL text and leaves the `up`
// function free to add, drop or reorder operations around it -- existing stores
// never re-run an edited migration, fresh ones do, and this test stays green
// while the two diverge. The function source is the other half of what
// migration 1 IS.
//
// `migrationPlan` is NOT re-imported: it is already in scope from the Task 6
// block above, and a second import is a duplicate declaration that would stop
// this file parsing -- a worse failure than the missing binding it would fix.
{
  const frozen = JSON.parse(readFileSync(new URL("./fixtures/hub-schema-v1.json", import.meta.url), "utf8"));
  const sqlNow = createHash("sha256")
    .update(readFileSync(new URL("../src/build/hub.sql", import.meta.url), "utf8")).digest("hex");
  // Through the EXPORT, and the same value the fixture command recorded, so the
  // two cannot compute it differently.
  const upNow = migrationPlan().find(m => m.version === 1).implHash;
  check(frozen.version === 1, "the fixture records which migration it froze", String(frozen.version));
  check(sqlNow === frozen.sha256,
    "migration 1's SQL is frozen: new schema goes in a NEW numbered migration",
    `${sqlNow} vs ${frozen.sha256}\n        If this change is intentional it does not belong in hub.sql: ` +
    `add MIGRATIONS[{version: N+1, up}] and bump HUB_SCHEMA_VERSION.`);
  check(upNow === frozen.up_sha256,
    "and so is its up() implementation, which is the other half of what migration 1 IS",
    `${upNow} vs ${frozen.up_sha256}`);
}

// ── a version-3 snapshot without its columns is NOT usable ─────────────────
// Migration 3 adds no tables, so a table-name inventory cannot describe it. A
// snapshot recording version 3 while missing the new columns satisfies every
// other check -- integrity_check proves the file is structurally sound, the
// inventory proves the tables are present -- and `openHub` would then read the
// migration as completed, skip it, and fail with `no such column` on the first
// pin or provider query, after the snapshot had been chosen for recovery.
{
  const bad = join(dir, "v3-no-cols.db");
  const db = openHub(bad);
  // Exactly the shape the finding describes: version 3 recorded, columns gone.
  db.exec("ALTER TABLE task_territory DROP COLUMN pinned_until");
  db.close();
  const v = validateSnapshot(bad, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION, deep: true });
  check(v.ok === false && /column/i.test(v.why ?? ""),
    "a version-3 snapshot missing a migration-3 column is refused, with the column named",
    JSON.stringify(v));

  // CONTROL: an intact one at the same version passes, or "refuse version 3" has
  // become "refuse everything" and no hub could ever be restored.
  const good = join(dir, "v3-intact.db");
  openHub(good).close();
  const ok = validateSnapshot(good, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION, deep: true });
  check(ok.ok === true, "control: an intact version-3 snapshot is usable", JSON.stringify(ok));

  // AND THE WRONG TYPE, which a name-only inventory cannot see. Every hub table
  // is STRICT, so a column of the wrong declared type does not coerce -- it
  // refuses the write. This snapshot HAS `provider_lease.token`, passes a
  // presence check, is chosen for recovery, and then fails the first
  // `claimProvider` with `cannot store TEXT value in INTEGER column`: the same
  // failure as the missing column, at the same worst moment.
  const typed = join(dir, "v3-wrong-type.db");
  const t = openHub(typed);
  t.exec("ALTER TABLE provider_lease DROP COLUMN token");
  t.exec("ALTER TABLE provider_lease ADD COLUMN token INTEGER");
  t.close();
  const tv = validateSnapshot(typed, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION, deep: true });
  check(tv.ok === false && /token/.test(tv.why ?? "") && /INTEGER/i.test(tv.why ?? ""),
    "a version-3 snapshot with a migration-3 column at the WRONG TYPE is refused",
    JSON.stringify(tv));

  // THE DECLARATION IS CHECKED AGAINST THE MIGRATION, not trusted.
  //
  // COLUMNS_AT now restates the types migration 3's DDL declares, and a restated
  // fact drifts the moment one side changes -- a validator that requires TEXT
  // where the migration produces INTEGER would refuse every healthy snapshot,
  // which is worse than the gap it closes. So the intact store above, which was
  // built by running the migrations, is the authority: what it actually has is
  // what COLUMNS_AT must say.
  {
    const live = openHub(good);
    const drift = [];
    for (const [table, cols] of Object.entries(COLUMNS_AT[HUB_SCHEMA_VERSION] ?? {})) {
      const have = new Map(live.prepare("SELECT name, type FROM pragma_table_info(?)").all(table)
                             .map(r => [r.name, String(r.type ?? "").toUpperCase()]));
      for (const [c, want] of Object.entries(cols))
        if (have.get(c) !== want.toUpperCase())
          drift.push(`${table}.${c}: migration says ${have.get(c) ?? "absent"}, COLUMNS_AT says ${want}`);
    }
    live.close();
    check(drift.length === 0,
      "COLUMNS_AT describes the shape the migrations actually produce", drift.join("; "));
  }
}

rmSync(dir, { recursive: true, force: true });
// ── migration 2 carries a REAL v1 hub forward ──────────────────────────────
// An upgrade that runs on a fresh database proves only that its SQL parses. The
// question a migration exists to answer is whether the rows that were already
// there arrive on the other side -- and this one moves two shapes into one, so
// there are two ways for it to lose something silently.
{
  const dir2 = mkdtempSync(join(tmpdir(), "reeve-upgrade-"));
  const p2 = join(dir2, "hub.db");

  // A GENUINE v1 store: migration 1's own SQL, marked version 1, then seeded in
  // BOTH of the shapes v1 had.
  const v1 = new DatabaseSync(p2);
  v1.exec("PRAGMA journal_mode = WAL"); v1.exec("PRAGMA foreign_keys = ON");
  v1.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY,
             applied_at INTEGER NOT NULL) STRICT`);
  v1.exec(readFileSync(new URL("../src/build/hub.sql", import.meta.url), "utf8"));
  v1.exec("INSERT INTO schema_version(version, applied_at) VALUES(1, unixepoch())");
  v1.exec(`INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,generation,source_kind,
                            source_key,repo_path,profile_path,profile_hash,default_branch,
                            visibility,registry_version,spec_repo_id,spec_pr,spec_head,
                            created_at,updated_at)
           VALUES('bt:1','p',1,'o/r','t','GATE',1,'founder','k1','/r','/p','h','main','private',1,
                  9,42,'specsha',unixepoch(),unixepoch())`);
  v1.exec(`INSERT INTO impl_pr(task,generation,slice,repo_id,pr,head_sha,created_at,merged_sha)
           VALUES('bt:1',1,0,1,7,'implsha',unixepoch(),NULL),
                 ('bt:1',1,1,1,8,'implsha2',unixepoch(),'merged')`);
  v1.close();

  const up = openHub(p2);
  check(up.prepare("SELECT COALESCE(max(version),0) v FROM schema_version").get().v === HUB_SCHEMA_VERSION,
    "a v1 hub is carried to this binary's schema version",
    String(up.prepare("SELECT COALESCE(max(version),0) v FROM schema_version").get().v));

  const rows = up.prepare(
    "SELECT kind, generation, slice, repo_id, pr, head_sha, merged_sha FROM task_pr ORDER BY repo_id, pr").all();
  check(rows.length === 3, "every PR of BOTH old shapes arrives", JSON.stringify(rows));
  const impl = rows.filter(r => r.kind === "impl");
  check(impl.length === 2 && impl[0].generation === 1 && impl[0].slice === 0,
    "implementation PRs keep their generation and slice", JSON.stringify(impl));
  check(impl.some(r => r.merged_sha === "merged"),
    "and a MERGED one stays merged, so history is not resurrected as open",
    JSON.stringify(impl.map(r => r.merged_sha)));
  const spec = rows.find(r => r.kind === "spec");
  check(spec?.repo_id === 9 && spec?.pr === 42 && spec?.head_sha === "specsha",
    "the spec PR arrives as a row, with its repository, number and head",
    JSON.stringify(spec));
  check(spec?.generation === null && spec?.slice === null,
    "carrying no generation or slice, which the CHECK requires of it", JSON.stringify(spec));
  check(up.prepare("SELECT count(*) c FROM task_pr WHERE task='bt:1' AND merged_sha IS NULL").get().c === 2,
    "and 'what is open' is now ONE query returning both kinds");
  check(up.prepare("SELECT count(*) c FROM pragma_table_info('task') WHERE name IN ('spec_pr','spec_head')").get().c === 0,
    "the old columns are gone, so no site can read the shape that caused this");
  check(up.prepare("SELECT count(*) c FROM pragma_table_info('task') WHERE name='spec_repo_id'").get().c === 1,
    "control: spec_repo_id STAYS -- it is which repository holds specs, a project fact, not a PR");

  // RE-RUNNABLE. `openHub` rolls an interrupted migration back, but a store whose
  // schema_version rows are lost while its tables survive replays every migration
  // over tables that already exist. Migration 1 survives that by construction;
  // this asserts migration 2 does too, and `ALTER TABLE ... DROP COLUMN` has no
  // IF EXISTS to lean on.
  up.exec("DELETE FROM schema_version");
  up.close();
  let again = null, reopened = null;
  try { reopened = openHub(p2); } catch (e) { again = e; }
  check(again === null, "replaying migration 2 over an already-migrated store does not throw",
    String(again?.message));
  check(reopened?.prepare("SELECT count(*) c FROM task_pr").get().c === 3,
    "and loses nothing when it does",
    String(reopened?.prepare("SELECT count(*) c FROM task_pr").get().c));
  reopened?.close();
  rmSync(dir2, { recursive: true, force: true });
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
