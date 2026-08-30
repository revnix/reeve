// `reeve task file`: the territory grammar, and the rule that an empty claim is
// the repository ROOT rather than the absence of a claim.
//
// THE TWO ARE ASSERTED SEPARATELY ON PURPOSE. The implementation an author
// reaches for first -- filtering blanks out of the territory list before
// counting it -- collapses them: a whitespace-only `--territory` reads as "no
// territory", which is refused by the grammar, and the refusal looks correct.
// Only the root-claim half turns red on that mistake. Asserting them together
// would let one implementation satisfy both while the root claim, which
// conflicts with everything in its project, silently conflicted with nothing.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHub, hubTx } from "../src/build/hubdb.mjs";
import { acquireMaintenanceLock } from "../src/build/locks.mjs";
import { isSameProcess, readStart } from "../src/supervisor.mjs";
import { fileTask, pinSeconds, TERRITORY_GRAMMAR } from "../src/build/taskfile.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-taskfile-"));

// A real project on disk, because the claim walk lstats every ancestor of every
// claim and a fixture with no directories cannot exhibit a symlink refusal.
const repo = join(dir, "repo");
mkdirSync(join(repo, "packages", "x"), { recursive: true });
writeFileSync(join(repo, "p.json"), "{}\n");

// `resolveSnapshot` takes the registry as an object keyed by project name, with
// a `version`. That is NOT the array the registry loader returns; the route
// converts. Building the object shape here keeps these tests honest about which
// of the two this function actually consumes.
const registry = { version: 1, projects: {
  nextly: { nwo: "nextlyhq/nextly", repoPath: repo, profilePath: join(repo, "p.json") } } };

// Every network read the snapshot needs, injectable, none of them real.
const mkIo = (over = {}) => ({
  lstat: (p) => lstatSync(p),
  lsTree: () => null,
  repoId: async () => 42,
  profileHash: async () => "ph-1",
  defaultBranch: async () => "main",
  visibility: async () => "private",
  specRepoId: async () => 77,
  gateDefinitionHash: async () => "gd-1",
  founderUserId: async () => 9,
  ...over,
});

let n = 0;
const store = () => openHub(join(dir, `h${++n}.db`));
const tasks   = (db) => db.prepare("SELECT count(*) c FROM task").get().c;
const writers = (db) => db.prepare("SELECT count(*) c FROM writer_lease").get().c;
const evseq   = (db) => db.prepare("SELECT COALESCE(MAX(seq),0) s FROM hub_event").get().s;

const base = (db, over = {}) => ({
  db, registry, project: "nextly", title: "a scout task",
  territory: ["packages/x"], io: mkIo(), isAlive: isSameProcess,
  pid: process.pid, lstart: readStart(process.pid), ...over,
});

// ── The control: the fixture can actually admit a filing ─────────────────────
//
// Without this, every refusal below could be passing because the fixture is
// broken rather than because the grammar refused. A refusal is the easiest
// thing in this file to produce by accident.
{
  const db = store();
  const r = await fileTask(base(db, { title: "the control filing" }));
  check(r.ok === true, "control: a well-formed filing IS admitted by this fixture",
    JSON.stringify(r));
  check(tasks(db) === 1, "control: and it wrote exactly one task row", String(tasks(db)));
  db.close();
}

// ── No --territory at all ────────────────────────────────────────────────────
//
// The refusal has to teach the grammar, and it has to arrive before any network
// call: a filing that cannot be admitted must not cost a round trip to find
// that out.
{
  const db = store();
  let touched = false;
  const r = await fileTask(base(db, {
    territory: [], io: mkIo({ repoId: async () => { touched = true; return 42; } }) }));
  check(r.ok === false, "a filing with no --territory is refused", JSON.stringify(r));
  check(r.refusal === TERRITORY_GRAMMAR, "with the one grammar refusal, not an ad-hoc string", r.refusal);
  check(/--territory/.test(r.refusal), "which names the flag", r.refusal);
  check(/packages\/x/.test(r.refusal), "and shows a worked example", r.refusal);
  check(/glob/.test(r.refusal) && /traversal/.test(r.refusal),
    "and states what the grammar refuses", r.refusal);
  check(touched === false, "and nothing reached the network to find that out");
  check(tasks(db) === 0 && writers(db) === 0,
    "and no task row and no writer lease exist afterwards", `${tasks(db)}/${writers(db)}`);
  db.close();
}

// ── An empty claim is the ROOT, never no-claim ───────────────────────────────
//
// The absence of a territory claim must never read as the absence of conflict.
{
  const db = store();
  const a = await fileTask(base(db, { title: "the root claimant", territory: ["  "] }));
  check(a.ok === true, "an empty claim is admitted as a claim, not dropped", JSON.stringify(a));
  // GUARDED, because the lookup must not abort the file when the filing above
  // was refused. Binding an undefined id throws inside node:sqlite, and a file
  // that dies here reports one failure and never runs the two assertions below
  // -- which is indistinguishable, in the log, from those two having passed.
  const row = a.task
    ? db.prepare("SELECT kind, path FROM task_territory WHERE task=?").get(a.task)
    : null;
  check(row?.kind === "prefix" && row?.path === "",
    "and it is stored as the repository root prefix", JSON.stringify(row));

  const b = await fileTask(base(db, { title: "an unrelated package" }));
  check(b.ok === false,
    "and a root-prefix task blocks every concurrent grant in its project", JSON.stringify(b));
  // BOTH HALVES CHECKED. `String(undefined).includes(undefined)` is true, so
  // asserting containment alone passes when neither filing produced anything --
  // the exact case this is here to catch.
  check(typeof a.task === "string" && String(b.refusal ?? "").includes(a.task),
    "naming the root task as the blocker", `${a.task} / ${b.refusal}`);
  check(tasks(db) === 1, "and the blocked filing inserted nothing", String(tasks(db)));
  db.close();
}

// ── A conflict is a refusal, not a queue ─────────────────────────────────────
//
// Founder filings are never queued behind a lease. What matters as much is that
// the refused filing leaves NOTHING: `admitTask` writes the task row before it
// grants leases, so a refusal that escaped the transaction would leave a task
// with no territory, holding no lease and blocking nothing -- which reads as a
// filed task in every later view.
//
// A refusal that is RETURNED and a refusal that CHANGED NOTHING are two
// different facts, and only the count assertions can tell them apart.
{
  const db = store();
  const a = await fileTask(base(db, { title: "holds packages/x" }));
  check(a.ok === true, "the first filing is admitted", JSON.stringify(a));

  const before = tasks(db), seqBefore = evseq(db);
  const b = await fileTask(base(db, { title: "wants packages/x/deep", territory: ["packages/x/deep"] }));
  check(b.ok === false, "an overlapping filing is refused", JSON.stringify(b));
  check(typeof a.task === "string" && String(b.refusal ?? "").includes(a.task),
    "and the refusal names the blocking task", `${a.task} / ${b.refusal}`);
  check(/overlaps/.test(String(b.refusal)), "and says what overlapped what", b.refusal);
  check(tasks(db) === before, "and the task-row COUNT is unchanged", `${tasks(db)} vs ${before}`);
  check(evseq(db) === seqBefore, "and no hub_event was appended", `${evseq(db)} vs ${seqBefore}`);
  check(db.prepare("SELECT count(*) c FROM territory_lease").get().c === 1,
    "and exactly one lease still exists, the first task's");

  // A DISJOINT claim in the same project is not a conflict. Without this the
  // count assertions above would also pass against an implementation that
  // refuses every second filing.
  const c = await fileTask(base(db, { title: "wants packages/y", territory: ["packages/y"] }));
  check(c.ok === true, "control: a disjoint claim in the same project is admitted", JSON.stringify(c));
  check(tasks(db) === before + 1, "and it is the only thing that grew the table", String(tasks(db)));
  db.close();
}

// ── The successful path's own control ────────────────────────────────────────
//
// One task, N territory rows, N leases, and the events, all from one call.
{
  const db = store();
  const r = await fileTask(base(db, { title: "two claims", territory: ["packages/x", "packages/y"] }));
  check(r.ok === true, "a filing with two claims is admitted", JSON.stringify(r));
  check(db.prepare("SELECT count(*) c FROM task_territory WHERE task=?").get(r.task).c === 2,
    "and writes one task_territory row per claim");
  check(db.prepare("SELECT count(*) c FROM territory_lease WHERE task=?").get(r.task).c === 2,
    "and one territory_lease row per claim");
  const kinds = db.prepare("SELECT kind FROM hub_event WHERE task=? ORDER BY seq").all(r.task).map(e => e.kind);
  check(kinds[0] === "task.filed", "with the parent event first, so a replay can rebuild it", kinds.join(","));
  check(kinds.filter(k => k === "task_territory.claimed").length === 2 &&
        kinds.filter(k => k === "territory_lease.granted").length === 2,
    "and a claimed and a granted event for each claim", kinds.join(","));
  db.close();
}

// ── The pin duration ─────────────────────────────────────────────────────────
//
// Asserted here rather than left to the task that wires the flag: an exported
// function with no caller and no test is indistinguishable from one that works.
// A bare number is the whole point -- guessing its unit is a promise the founder
// cannot see, so it is refused.
{
  check(pinSeconds(null) === null, "no --pin-territory is not a pin", String(pinSeconds(null)));
  check(pinSeconds(undefined) === null, "and neither is an absent one", String(pinSeconds(undefined)));
  check(pinSeconds("48h") === 48 * 3600, "48h is hours", String(pinSeconds("48h")));
  check(pinSeconds("3d") === 3 * 86400, "3d is days", String(pinSeconds("3d")));
  check(pinSeconds(" 12h ") === 12 * 3600, "and surrounding space is not a syntax error",
    String(pinSeconds(" 12h ")));
  for (const bad of ["48", "48m", "h", "-2h", "1.5d", ""]) {
    const r = pinSeconds(bad);
    check(r?.refusal !== undefined, `${JSON.stringify(bad)} is refused rather than guessed at`,
      JSON.stringify(r));
  }
  check(/48h/.test(String(pinSeconds("48").refusal)),
    "and the refusal shows the grammar it wanted", pinSeconds("48").refusal);
}

// ── Network first, transaction second ────────────────────────────────────────
//
// Asserted as a property of the DATABASE rather than as a claim about call
// order. node:sqlite throws on a nested BEGIN, so a hubTx that succeeds from
// inside the io proves no transaction was open while the network half ran. A
// test that merely recorded the order of two callbacks would pass against an
// implementation that opened the transaction first and did its I/O inside it.
{
  const db = store();
  let nested = null;
  const r = await fileTask(base(db, { title: "network first",
    io: mkIo({ repoId: async () => { try { hubTx(db, () => 1); nested = "open"; }
                                     catch (e) { nested = String(e.message); } return 42; } }) }));
  check(r.ok === true, "the filing succeeds", JSON.stringify(r));
  check(nested === "open",
    "and no transaction was open while the network reads ran", String(nested));
  db.close();
}

// ── The lease exists for the duration and is gone afterwards, on BOTH paths ──
{
  const db = store();
  const ok = await fileTask(base(db, { title: "leases and releases" }));
  check(ok.ok === true, "a successful filing returns", JSON.stringify(ok));
  check(writers(db) === 0, "and leaves no writer lease behind", String(writers(db)));

  const bad = await fileTask(base(db, { title: "refused, still releases", territory: ["packages/x"] }));
  check(bad.ok === false, "control: the second filing is refused as a conflict", JSON.stringify(bad));
  check(writers(db) === 0,
    "and a REFUSED filing leaves no writer lease behind either", String(writers(db)));
  db.close();
}

// ── A live restore makes the hub read-only ───────────────────────────────────
//
// The filing must say so rather than write into a file that is being replaced.
{
  const db = store();
  const held = acquireMaintenanceLock(db,
    { pid: process.pid, lstart: readStart(process.pid), isAlive: isSameProcess });
  check(held.ok === true, "control: the maintenance lock was actually taken", JSON.stringify(held));
  const r = await fileTask(base(db, { title: "during a restore" }));
  check(r.ok === false, "a filing during a live restore is refused", JSON.stringify(r));
  check(/restore is in progress/.test(String(r.refusal)),
    "and the refusal names the restore, not a generic failure", r.refusal);
  check(tasks(db) === 0, "and nothing was written", String(tasks(db)));
  check(writers(db) === 0, "and no writer lease was left behind", String(writers(db)));
  db.close();
}

// ── Liveness is never defaulted ──────────────────────────────────────────────
//
// A production path that omits it fails OPEN: the filing above would have been
// admitted during the restore.
{
  const db = store();
  const { isAlive, ...noLiveness } = base(db, { title: "no predicate" });
  let threw = null;
  try { await fileTask(noLiveness); } catch (e) { threw = String(e.message); }
  check(threw !== null && /liveness/.test(threw),
    "fileTask throws rather than defaulting isAlive", String(threw));
  check(tasks(db) === 0, "and wrote nothing on the way to throwing", String(tasks(db)));
  db.close();
}

// ── The restore refusal is keyed on the holder being ALIVE, not on a row ─────
//
// `assertWritable` throws exactly when the predicate says the holder is alive,
// and REAPS the row when it says the holder is dead. Without this control the
// refusal above would also pass against an implementation that refused whenever
// a maintenance_lock row existed at all -- which would wedge the hub read-only
// after any crashed restore, permanently, with no way to file anything.
//
// This is also what makes the missing-predicate throw more than tidiness:
// neither default is safe. `() => true` never reaps and never recovers;
// `() => false` reaps a live restore and admits into a file being replaced.
{
  const db = store();
  const stale = acquireMaintenanceLock(db,
    { pid: 999999, lstart: "a-start-no-live-process-has", isAlive: isSameProcess });
  check(stale.ok === true, "control: a lock held by a DEAD holder was recorded",
    JSON.stringify(stale));
  check(db.prepare("SELECT count(*) c FROM maintenance_lock").get().c === 1,
    "control: and the row is really there before the filing runs");

  const r = await fileTask(base(db, { title: "after a crashed restore" }));
  check(r.ok === true, "a filing proceeds once the dead holder's lock is reaped",
    JSON.stringify(r));
  check(db.prepare("SELECT count(*) c FROM maintenance_lock").get().c === 0,
    "and the stale lock is gone rather than blocking every future write");
  db.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
