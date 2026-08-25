// Everything in reeve watches pull requests. Nothing watched reeve, and every way
// it stops being useful is silent: a snapshot loop that quietly stops, a store
// that corrupts, a lease that outlives its worker, a push channel that has been
// refusing for a week. Each leaves a daemon that ticks, logs, and does nothing.
//
// Two properties are asserted here as hard as the checks themselves.
//
// The `why` string is an IDENTITY, not a report. A key carrying "3h" changes
// every tick, and a changed key is a NEW escalation -- so a single stopped backup
// would push to a phone every two minutes until it was muted. Durations, paths
// and counts go in `detail`, which is logged and never keyed on.
//
// And the audit must run on EVERY tick. On a slower cadence its findings would be
// absent from most ticks, and absence within a tick is what the escalation layer
// reads as resolved -- the defect already fixed twice in this codebase.
import { selfAudit, BROKEN, DEGRADED } from "../src/selfaudit.mjs";
import { everyStore, snapshotAll, snapshot } from "../src/backup.mjs";
// The hub half of the audit needs a real hub and a real hub snapshot.
import { openHub } from "../src/build/hubdb.mjs";
import { hubPathFor } from "../src/paths.mjs";
import { open } from "../src/db/ops.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const NWO = "revnix/reeve";
const NOW = 1_800_000_000;
const dir = mkdtempSync(join(tmpdir(), "reeve-selfaudit-"));
const db = open(join(dir, "state.db"));

// A profile with a working channel, so notify is not a finding unless made one.
const PROFILE = { notify: { provider: "ntfy", url: "https://x", topic: "t" },
                  watch: { backupIntervalSeconds: 3600 } };

// A snapshot that is fresh and readable: the healthy baseline.
const snapRoot = join(dir, "backups");
mkdirSync(join(snapRoot, "revnix-reeve"), { recursive: true });
const goodSnap = join(snapRoot, "revnix-reeve", "1.db");
{
  const s = open(goodSnap);
  s.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
    .run(NOW, "test", "seed", "x", "{}");
  s.close();
}
const fresh = { statSync: () => ({ mtimeMs: NOW * 1000 }) };

// ── control: a healthy reeve reports nothing ─────────────────────────────────
//
// Without this the assertions below would pass against a checker that always
// fires, which is the same as one that never does.
const healthy = selfAudit(db, { nwo: NWO, profile: PROFILE, backupRoot: snapRoot, at: NOW, io: fresh });
check(healthy.length === 0, "control: a healthy reeve produces no findings", JSON.stringify(healthy));

// ── the backup loop stopping ─────────────────────────────────────────────────
{
  const stale = { statSync: () => ({ mtimeMs: (NOW - 3 * 3600) * 1000 }) };
  const f = selfAudit(db, { nwo: NWO, profile: PROFILE, backupRoot: snapRoot, at: NOW, io: stale });
  const b = f.find(x => x.id === "backup.stale");
  check(!!b && b.level === BROKEN, "a stopped backup loop is BROKEN", JSON.stringify(f));

  // One missed snapshot is a slow tick, not a stopped loop.
  const oneLate = { statSync: () => ({ mtimeMs: (NOW - 5400) * 1000 }) };
  check(selfAudit(db, { nwo: NWO, profile: PROFILE, backupRoot: snapRoot, at: NOW, io: oneLate }).length === 0,
    "but a single late snapshot is not");

  // THE KEY MUST NOT CARRY THE DURATION.
  const at4h = selfAudit(db, { nwo: NWO, profile: PROFILE, backupRoot: snapRoot, at: NOW + 3600, io: stale })
    .find(x => x.id === "backup.stale");
  check(b.why === at4h.why,
    "and the key is stable as the fault ages — otherwise every tick is a new push",
    `${b.why}\n        ${at4h.why}`);
  check(!/\d/.test(b.why), "the key carries no number at all", b.why);
  check(/h old/.test(b.detail), "the age is in the detail, which is logged not keyed", b.detail);
}

// ── a snapshot that exists but is not a database ─────────────────────────────
{
  const junkRoot = join(dir, "junk");
  mkdirSync(join(junkRoot, "revnix-reeve"), { recursive: true });
  writeFileSync(join(junkRoot, "revnix-reeve", "1.db"), "this is not a sqlite file");
  const f = selfAudit(db, { nwo: NWO, profile: PROFILE, backupRoot: junkRoot, at: NOW, io: fresh });
  check(f.some(x => x.id === "backup.unreadable" || x.id === "backup.empty"),
    "a fresh file that is not a usable store is caught — it is the one a restore reaches for",
    JSON.stringify(f));
  // WHICH fault, and whether the sentence is TRUE. `latestSnapshot` skips
  // candidates that fail validation, so a directory full of corrupt snapshots
  // answers null exactly like an empty one -- and reporting that as "reeve has
  // never backed up X" is false. The backups ARE running; they are producing
  // files that cannot be restored, which is the more urgent fault and sends the
  // operator somewhere completely different.
  const junkFinding = f.find(x => x.id === "backup.unreadable" || x.id === "backup.empty");
  // `junkFinding != null` FIRST. A negative regex over `String(undefined)`
  // matches nothing and passes, so without this the assertion is satisfied by
  // the finding being ABSENT -- which is the exact failure it exists to catch.
  check(junkFinding != null &&
        !/never backed up|nothing under/.test(String(junkFinding.why) + String(junkFinding.detail)),
    "and it is NOT reported as 'never backed up', because a corrupt backup is not an absent one",
    JSON.stringify(junkFinding));
  check(/fails validation|cannot be read|cannot be restored/.test(String(junkFinding?.why) + String(junkFinding?.detail)),
    "and the finding says the snapshots exist and do not validate, which is what an operator has to act on",
    JSON.stringify(junkFinding));
  // CONTROL: a genuinely empty directory still reports absence. Without it, a
  // fix that renames every backup fault to 'unreadable' passes both lines above.
  const emptyRoot = join(dir, "empty-root");
  mkdirSync(join(emptyRoot, "revnix-reeve"), { recursive: true });
  const e = selfAudit(db, { nwo: NWO, profile: PROFILE, backupRoot: emptyRoot, at: NOW, io: fresh });
  check(e.some(x => x.id === "backup.missing"),
    "control: a directory with no snapshots at all is still reported as never backed up",
    JSON.stringify(e.map(x => x.id)));
}

// ── never backed up at all ───────────────────────────────────────────────────
{
  const emptyRoot = join(dir, "none");
  mkdirSync(emptyRoot, { recursive: true });
  const f = selfAudit(db, { nwo: NWO, profile: PROFILE, backupRoot: emptyRoot, at: NOW, io: fresh });
  check(f.some(x => x.id === "backup.missing" && x.level === BROKEN),
    "no snapshot at all is BROKEN, not silence", JSON.stringify(f));
}

// ── a wedged lease ───────────────────────────────────────────────────────────
{
  db.prepare("INSERT INTO node(id,kind,title,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run("task:z", "task", "z", NOW, NOW);
  db.prepare(`INSERT INTO run (id,task_id,lane,status,lease_expires_at,heartbeat_at,owner_host,started_at)
              VALUES(?,?,?,?,?,?,?,?)`).run("run-z", "task:z", "L", "leased", NOW - 10, NOW - 10, "h", NOW - 99);

  const f = selfAudit(db, { nwo: NWO, profile: PROFILE, backupRoot: snapRoot, at: NOW, io: fresh });
  const l = f.find(x => x.id === "lease.expired");
  check(!!l && l.level === DEGRADED, "a run past its lease is a finding", JSON.stringify(f));

  // The COUNT is the signal here, so it rides `count` where the escalation layer
  // re-announces on a change, rather than in the key where it would look new.
  check(l.count === 1, "carrying how many, separately from the key", String(l.count));
  check(!/\d/.test(l.why), "so the key itself stays stable as more wedge", l.why);

  // A task carries at most one live run, so a second wedged one needs its own.
  db.prepare("INSERT INTO node(id,kind,title,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run("task:z2", "task", "z2", NOW, NOW);
  db.prepare(`INSERT INTO run (id,task_id,lane,status,lease_expires_at,heartbeat_at,owner_host,started_at)
              VALUES(?,?,?,?,?,?,?,?)`).run("run-y", "task:z2", "L", "running", NOW - 10, NOW - 10, "h", NOW - 99);
  const two = selfAudit(db, { nwo: NWO, profile: PROFILE, backupRoot: snapRoot, at: NOW, io: fresh })
    .find(x => x.id === "lease.expired");
  check(two.count === 2 && two.why === l.why, "two wedged runs: same key, higher count", JSON.stringify(two));

  db.exec("DELETE FROM run");
}

// ── the channel to the human ─────────────────────────────────────────────────
{
  const f = selfAudit(db, { nwo: NWO, profile: {}, backupRoot: snapRoot, at: NOW, io: fresh });
  check(f.some(x => x.id === "notify.unconfigured"),
    "no channel configured is a finding, not a default", JSON.stringify(f));

  // Read from the event log, so a restart does not forget a week of refusals.
  db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
    .run(NOW, "daemon", "notify.failed", "repo:x", JSON.stringify({ why: "HTTP 403" }));
  const bad = selfAudit(db, { nwo: NWO, profile: PROFILE, backupRoot: snapRoot, at: NOW, io: fresh })
    .find(x => x.id === "notify.unreachable");
  check(!!bad && bad.level === BROKEN, "a refused push is BROKEN", JSON.stringify(bad));
  check(/403/.test(bad.detail), "and the server's reason survives to the log", bad.detail);

  // A later success clears it: the newest event wins, not any failure ever seen.
  db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
    .run(NOW + 1, "daemon", "notify.sent", "repo:x", "{}");
  check(!selfAudit(db, { nwo: NWO, profile: PROFILE, backupRoot: snapRoot, at: NOW, io: fresh })
          .some(x => x.id === "notify.unreachable"),
    "and a later success retires it");
}

// ── worst first ──────────────────────────────────────────────────────────────
{
  db.prepare("INSERT INTO node(id,kind,title,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run("task:w", "task", "w", NOW, NOW);
  db.prepare(`INSERT INTO run (id,task_id,lane,status,lease_expires_at,heartbeat_at,owner_host,started_at)
              VALUES(?,?,?,?,?,?,?,?)`).run("run-w", "task:w", "L", "leased", NOW - 10, NOW - 10, "h", NOW - 99);
  const emptyRoot = join(dir, "none2");
  mkdirSync(emptyRoot, { recursive: true });
  const f = selfAudit(db, { nwo: NWO, profile: PROFILE, backupRoot: emptyRoot, at: NOW, io: fresh });
  check(f.length >= 2 && f[0].level === BROKEN,
    "findings come back worst first, so a log tail shows the worst thing", JSON.stringify(f.map(x => x.level)));
}

// ── the wiring: it must run on EVERY tick ────────────────────────────────────
{
  const src = readFileSync(new URL("../src/daemon.mjs", import.meta.url), "utf8");
  check(/selfAudit\)\(db, \{/.test(src) || /runSelfAudit \?\? selfAudit/.test(src),
    "the tick calls the audit", (src.match(/selfAudit[^\n]*/) ?? ["(no call)"])[0]);

  // If it were ever put behind an interval the way backups are, its findings would
  // be missing from most ticks and the layer below would clear them as resolved.
  // Anchored on the CALL, not on the condition guarding it -- anchoring on the
  // condition meant changing that condition made the control fail instead of the
  // assertion below, which reports the wrong thing about the right problem.
  const call = (src.match(/if \(ctx\.selfAudit[\s\S]{0,400}/) ?? [""])[0];
  check(call.length > 0, "control: found the audit block", call.slice(0, 80));
  check(!/lastAuditAt|auditInterval|>= *\(profile\.watch\?\.audit/.test(call),
    "and it is NOT gated behind an interval — absence within a tick reads as resolved",
    call.slice(0, 200));

  check(/notify\.failed/.test(src) && /notify\.sent/.test(src),
    "and the tick records push outcomes, which the audit reads back");
}

// ── a store nothing watches ──────────────────────────────────────────────────
//
// Backups happen inside a tick and a tick is per repository, so a store no daemon
// watches is never snapshotted — and the audit could not see it either, because
// it only looked at the repository it was running FOR. Measured: reeve's own
// store, holding every dispatch experiment and the whole fix-attempt ledger, had
// zero backups while the watched repository had fourteen. Unwatched meant
// unaudited AND unbacked, which is the pair that loses data.
{
  const twoStores = join(dir, "home-two");
  mkdirSync(join(twoStores, "state", "owner-a"), { recursive: true });
  mkdirSync(join(twoStores, "state", "owner-b"), { recursive: true });
  for (const [o, r] of [["owner-a", "watched"], ["owner-b", "forgotten"]]) {
    const s2 = open(join(twoStores, "state", o, `${r}.db`));
    s2.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(NOW, "t", "seed", "x", "{}");
    s2.close();
  }
  // Only the watched one has a snapshot.
  const root = join(twoStores, "backups");
  mkdirSync(join(root, "owner-a-watched"), { recursive: true });
  const snap = open(join(root, "owner-a-watched", "1.db"));
  snap.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(NOW, "t", "seed", "x", "{}");
  snap.close();

  // Control: WITHOUT the home, the audit is blind to the other store — which is
  // exactly the state this fixes, so the fixture must reproduce it.
  const blind = selfAudit(db, { nwo: "owner-a/watched", profile: PROFILE, backupRoot: root, at: NOW, io: fresh });
  check(!blind.some(f => f.id === "backup.missing"),
    "control: without the home, an unwatched store is invisible", JSON.stringify(blind));

  const seeing = selfAudit(db, { nwo: "owner-a/watched", profile: PROFILE, backupRoot: root,
                                 at: NOW, io: fresh, home: twoStores });
  const miss = seeing.find(f => f.id === "backup.missing");
  check(!!miss && miss.level === BROKEN,
    "with it, a store that has never been backed up is BROKEN", JSON.stringify(seeing));
  check(/owner-b\/forgotten/.test(miss.detail) && !/owner-a\/watched/.test(miss.detail),
    "and it names the forgotten store, not the healthy one", miss.detail);
}

// ── snapshotAll covers what a per-repo backup misses ─────────────────────────
{
  const home3 = join(dir, "home-all");
  mkdirSync(join(home3, "state", "o1"), { recursive: true });
  mkdirSync(join(home3, "state", "o2"), { recursive: true });
  for (const [o, r] of [["o1", "a"], ["o2", "b"]]) {
    const s3 = open(join(home3, "state", o, `${r}.db`));
    s3.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(NOW, "t", "seed", "x", "{}");
    s3.close();
  }
  check(everyStore(home3).length === 2,
    "control: both stores are discovered", JSON.stringify(everyStore(home3).map(s => s.nwo)));

  const out = snapshotAll(home3, join(home3, "backups"), { at: NOW });
  check(out.length === 2 && out.every(r => r.ok),
    "snapshotAll snapshots every store, not only a watched one", JSON.stringify(out.map(r => [r.nwo, r.ok])));

  const after = selfAudit(db, { nwo: "o1/a", profile: PROFILE, backupRoot: join(home3, "backups"),
                                at: NOW, io: fresh, home: home3 });
  check(!after.some(f => f.id === "backup.missing"),
    "and afterwards the audit is satisfied — the loop closes");
}

// ── the ORDER of the tick ────────────────────────────────────────────────────
//
// Measured in production, 54 milliseconds apart:
//
//   13:24:30.870  self: BROKEN  revnix/reeve has never been backed up
//   13:24:30.924  backup: 2 store(s) — nextlyhq/nextly, revnix/reeve
//   13:24:30.926  NEEDS YOU: a state store has never been backed up
//
// The audit ran BEFORE the backup, so it reported a gap the same tick then
// closed, and paged a human about it. The next tick would have cleared it —
// a ping followed by a retraction, for a problem that never outlived one pass.
//
// An audit must describe the state a tick LEAVES, not the state it found. And
// the announce step must come after the audit, or findings the audit adds are
// reduced before they exist and never reach anyone at all.
{
  const src = readFileSync(new URL("../src/daemon.mjs", import.meta.url), "utf8");
  const at = needle => {
    const i = src.indexOf(needle);
    return i < 0 ? Number.NaN : i;
  };
  const backup   = at("if (ctx.backupRoot !== false) {");
  const audit    = at("if (ctx.selfAudit !== false) {");
  // The CALL in the ordinary path, not the definition. `announceable` is invoked
  // from a helper now, because a tick that cannot list pull requests still has to
  // announce what its drain found -- and a helper is necessarily defined before
  // both of its callers. Measuring the definition made the order read backwards
  // while the runtime order was unchanged.
  const announce = at("const { fresh, cleared } = announce({ covered:");

  check(Number.isFinite(backup) && Number.isFinite(audit) && Number.isFinite(announce),
    "control: found all three steps in the tick",
    JSON.stringify({ backup, audit, announce }));

  check(backup < audit,
    "the audit runs AFTER the backup — or it reports gaps the same tick closes",
    `backup@${backup} audit@${audit}`);
  check(audit < announce,
    "and the announce runs after the audit — or its findings are reduced before they exist",
    `audit@${audit} announce@${announce}`);
}

// ── a hub that DISAPPEARS is reported, and one that never existed is not ───
// `existsSync(hub)` guarded the only hub finding, so deleting `hub.db` after the
// builder had been initialised produced NOTHING from the audit that runs on
// every guardian tick -- and `everyStore` enumerates only files that exist, so
// the same tick snapshotted every repository store and said nothing about the
// missing authority database. The CLI half was closed (`backup --hub` refuses
// without a hub result); this is the automatic half.
//
// The discriminator is the EVIDENCE: a retained hub snapshot. Absence of
// snapshots means the builder has genuinely never run, which is not a fault --
// reporting it would be the same absence-read-as-a-fault the `projectsKnown`
// default exists to avoid, in the other direction.
{
  const h = mkdtempSync(join(tmpdir(), "reeve-hubgone-"));
  mkdirSync(join(h, "state"), { recursive: true });
  const root = join(h, "backups");

  // NEVER EXISTED: no hub, no snapshots. Silence is correct here.
  const never = selfAudit(null, { nwo: "o/r", home: h, backupRoot: root });
  check(!never.some(f => f.id === "hub.missing"),
    "a hub that has never been created raises nothing, because the builder simply has not run",
    JSON.stringify(never.map(f => f.id)));

  // EXISTED, then gone: a snapshot on disk is the proof.
  openHub(hubPathFor(h)).close();
  const snap = snapshot(openHub(hubPathFor(h)), root, "hub");
  check(snap.ok, "fixture: a hub snapshot was taken", JSON.stringify(snap));
  rmSync(hubPathFor(h), { force: true });
  const gone = selfAudit(null, { nwo: "o/r", home: h, backupRoot: root });
  const f = gone.find(x => x.id === "hub.missing");
  check(f != null, "a hub that existed and is gone IS reported", JSON.stringify(gone.map(x => x.id)));
  check(f != null && f.level === BROKEN,
    "and as BROKEN, because the authority database is the one thing the builder cannot proceed without",
    f?.level);
  check(f != null && String(f.detail).includes(hubPathFor(h)) && /restore --hub/.test(String(f.detail)),
    "and it names the path and the way back", String(f?.detail));

  // CONTROL: put the hub back and the finding clears, so the assertion above is
  // about the hub being absent rather than about this home always failing.
  openHub(hubPathFor(h)).close();
  const back = selfAudit(null, { nwo: "o/r", home: h, backupRoot: root });
  check(!back.some(x => x.id === "hub.missing"),
    "control: and it clears when the hub is restored", JSON.stringify(back.map(x => x.id)));
  rmSync(h, { recursive: true, force: true });
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
