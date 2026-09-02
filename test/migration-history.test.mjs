// A maximum is not a history.
//
// `completedVersion` answers `max(version)`, and every guard that compared it
// against the expected version was asking whether the HIGHEST migration recorded
// is the current one -- not whether the hub carries all of them. A hub recording
// 1 and 3 with 2 absent answers 3, satisfies the equality, and then fails on a
// table that migration 2 was supposed to create: the uncaught trace the guard
// exists to replace, arriving through the guard itself.
//
// THE LOAD-BEARING ASSERTION IS THE CONTROL, and it comes first: that
// `completedVersion` still answers the CURRENT version for the holed file. Without
// it this file proves only that the new check refuses something, which a check
// that refuses everything also does. With it, it proves the OLD check would have
// passed this exact hub.
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { openHub, completedVersion, missingMigrations, migrationStateOf, schemaDefectsAt,
         historyGaps, hasHistoryHole, HUB_SCHEMA_VERSION } from "../src/build/hubdb.mjs";
// DERIVED, so a fixture cannot be written at a path the binary does not read.
import { hubPathFor } from "../src/paths.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-mighist-"));

// A REAL hub, built by running the migrations rather than by hand. A fixture
// assembled here would encode what I believe the schema table looks like.
const path = join(dir, "hub.db");
openHub(path).close();

{
  const whole = missingMigrations(path);
  check(whole.readable === true, "control: a real hub's schema_version is readable", JSON.stringify(whole));
  check(whole.have.length === HUB_SCHEMA_VERSION,
    `control: and it carries all ${HUB_SCHEMA_VERSION} migrations, so the fixture can exhibit a gap`,
    JSON.stringify(whole.have));
  check(whole.missing.length === 0, "a fully migrated hub is missing nothing", JSON.stringify(whole.missing));
}

// ── The hole ────────────────────────────────────────────────────────────────
{
  const holed = join(dir, "holed.db");
  writeFileSync(holed, ""); rmSync(holed);
  openHub(holed).close();
  const q = new DatabaseSync(holed);
  q.exec("DELETE FROM schema_version WHERE version = 2");
  q.close();

  // THE CONTROL, FIRST. This is what makes the refusal below mean something.
  check(completedVersion(holed) === HUB_SCHEMA_VERSION,
    "control: completedVersion still answers the CURRENT version for a hub missing migration 2 — " +
    "so an equality against it provably would have passed this file",
    `${completedVersion(holed)} vs ${HUB_SCHEMA_VERSION}`);

  const h = missingMigrations(holed);
  check(h.readable === true, "the holed hub is still readable", JSON.stringify(h));
  check(h.missing.length === 1 && h.missing[0] === 2,
    "and the gap is reported, naming which migration is absent", JSON.stringify(h.missing));
  check(!h.have.includes(2) && h.have.includes(1) && h.have.includes(3),
    "and what it does carry is reported too, so the message can say both", JSON.stringify(h.have));
}

// ── An absent file, and an unreadable one, are different answers ───────────
{
  const gone = join(dir, "nothing-here.db");
  check(!existsSync(gone), "control: the path really does not exist");
  const g = missingMigrations(gone);
  check(g.readable === false && g.missing.length === 0,
    "an absent hub is not readable, and reports no gap rather than every gap — " +
    "'there is nothing here' is not 'this is broken'", JSON.stringify(g));

  const junk = join(dir, "junk.db");
  writeFileSync(junk, "this is not a database");
  const j = missingMigrations(junk);
  check(j.readable === false,
    "and a file that is not a database is unreadable rather than empty", JSON.stringify(j));
}

// ── An empty schema_version is not "nothing to check" ──────────────────────
//
// The guard this replaces carried `at !== 0 &&`, so a hub answering 0 was waved
// through. Zero migrations recorded is not a hub yet, and it is the one case
// where the old check's two holes overlapped.
{
  const empty = join(dir, "empty.db");
  openHub(empty).close();
  const q = new DatabaseSync(empty);
  q.exec("DELETE FROM schema_version");
  q.close();
  check(completedVersion(empty) === 0, "control: an emptied schema_version answers zero",
    String(completedVersion(empty)));
  const e = missingMigrations(empty);
  check(e.readable === true && e.missing.length === HUB_SCHEMA_VERSION,
    "and every migration is reported missing, rather than none", JSON.stringify(e));
}

// ── A HOLE AND A TAIL ARE DIFFERENT FAULTS, and only one of them migrates ───
//
// Both reach a caller as a non-empty `missing`, and one remedy was named for
// both: run the writing command to migrate. That is right for a history that is
// merely short and wrong for a holed one -- `openHub` refuses a hole outright,
// because a migration beneath an applied one cannot be re-run over a store that
// has already moved past it. An operator with a holed hub was sent to a second
// refusal, and the second refusal was the one naming the actual repair.
//
// THE DISCRIMINATION IS MEASURED AGAINST `openHub`, not against the message. A
// fixture built from what I believe the command prints would agree with the
// command and with nothing else.
const refusal = (p) => { try { openHub(p).close(); return null; } catch (e) { return String(e.message); } };
// A REAL hub with one version row removed, so the store's shape and its recorded
// history disagree exactly as they do after a hand-repair or a bad restore.
const holeAt = (p, v) => {
  openHub(p).close();
  const q = new DatabaseSync(p);
  q.exec(`DELETE FROM schema_version WHERE version = ${v}`);
  q.close();
};
{
  // THE FIXTURE HAS TO BE ABLE TO EXHIBIT BOTH FAULTS. With a single migration
  // there is no version beneath a higher one, so every assertion below would be
  // about the same case while reading as two.
  check(HUB_SCHEMA_VERSION >= 2,
    "precondition: this binary carries at least two migrations, so a hole and a tail are distinguishable",
    String(HUB_SCHEMA_VERSION));

  // DERIVED FROM THE VERSION, never written as 2 and 3. A sibling test already
  // carried `/migration 2 is missing/` beside a fixture that stopped containing
  // a 2 the moment the schema moved, and a constant that no longer describes its
  // own fixture is an assertion about nothing.
  const holed = join(dir, "hole-vs-tail-holed.db");
  holeAt(holed, HUB_SCHEMA_VERSION - 1);
  const hh = missingMigrations(holed);
  check(hh.missing.length > 0 && hh.holed === true,
    "a hub missing a version BENEATH one it carries is reported as holed", JSON.stringify(hh));
  const holedWhy = refusal(holed);
  check(holedWhy !== null && /missing migration/.test(holedWhy),
    "control: openHub really does refuse that file for its hole, so migrating is not a remedy it can perform",
    String(holedWhy));

  const tail = join(dir, "hole-vs-tail-short.db");
  holeAt(tail, HUB_SCHEMA_VERSION);
  const th = missingMigrations(tail);
  check(th.missing.length > 0 && th.holed === false,
    "a hub missing only its TOP version is missing something and is NOT holed -- the exact pair the route branches on",
    JSON.stringify(th));
  // NOT "openHub succeeds". Re-running the top migration over a store that
  // already carries its effects can fail for reasons of its own, and that is a
  // different subject. What has to hold is that it is not refused for a HOLE,
  // because that refusal is what makes migrating impossible. The control above
  // is what stops this being satisfied by an openHub that refuses nothing.
  const tailWhy = refusal(tail);
  check(tailWhy === null || !/missing migration/.test(tailWhy),
    "and openHub does not refuse it for a hole, so the migrate-and-retry advice is reachable",
    String(tailWhy));
}

// ── AND THE ROUTE READS IT ──────────────────────────────────────────────────
//
// The rule being right is not the same as the command using it. This spawns
// `reeve task file --dry-run` against both hubs and reads what an operator is
// actually told, because that sentence is the whole of the finding.
{
  const HOME = join(dir, ".reeve");                // literally `.reeve`, as init's tests require
  const repo = join(HOME, "repo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(HOME, "state"), { recursive: true });
  // A profile the SCHEMA ACCEPTS, not merely one that parses: the route
  // validates it and exits BEFORE the hub check when it does not, so a thinner
  // fixture would exercise the profile failure while claiming to test this one.
  writeFileSync(join(repo, "p.json"), JSON.stringify({
    schemaVersion: 1, project: { kind: "product" },
    identity: { key: "o/a", defaultBranch: "main", visibility: "private" },
    authority: { permission: "admin", policy: "propose_and_merge", profileLocation: "committed" },
    state: { mode: "in-repo" },
    units: [{ id: "root", root: ".", language: "typescript", packageManager: "pnpm" }],
    ci: { provider: "github-actions" }, merge: { method: "squash", enforcement: "enforced" },
  }) + "\n");
  writeFileSync(join(HOME, "projects.json"), JSON.stringify({
    alpha: { nwo: "o/a", repoPath: repo, profilePath: join(repo, "p.json") },
  }) + "\n");

  const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const hub = hubPathFor(HOME);
  const dryRun = () => {
    const r = spawnSync(process.execPath,
      [join(ROOT, "bin", "reeve"), "task", "file", "--project", "alpha",
       "--title", "t", "--territory", "packages/x", "--dry-run"],
      { encoding: "utf8", env: { ...process.env, REEVE_HOME: HOME } });
    return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  };

  rmSync(hub, { force: true });
  holeAt(hub, HUB_SCHEMA_VERSION - 1);
  const holedRun = dryRun();
  check(holedRun.status === 1 && /\bHOLE\b/.test(holedRun.out) && /restore a snapshot/i.test(holedRun.out),
    "the route tells an operator with a HOLED hub to restore a snapshot", holedRun.out.slice(0, 500));
  check(!/without --dry-run/.test(holedRun.out),
    "and does not send them to the writing command, which openHub would refuse for the same hole",
    holedRun.out.slice(0, 500));

  rmSync(hub, { force: true });
  holeAt(hub, HUB_SCHEMA_VERSION);
  const tailRun = dryRun();
  // THE CONTROL FOR THE PAIR. Without it, advice that said "restore a snapshot"
  // unconditionally would pass every assertion above.
  check(tailRun.status === 1 && /without --dry-run/.test(tailRun.out),
    "control: a hub that is merely SHORT is still told to migrate -- the advice was not replaced, it was split",
    tailRun.out.slice(0, 500));
  check(!/\bHOLE\b/.test(tailRun.out),
    "and a short history is not called a hole", tailRun.out.slice(0, 500));

  // AND A NEWER HUB IS REFUSED WITHOUT BEING OPENED AT ALL.
  //
  // This is the case neither `missing` nor `holed` can see: a contiguous history
  // one version above this binary is missing nothing it expects and has no hole,
  // so the guard fell through to `openHub` -- which writes before it refuses.
  // The byte comparison is the assertion that matters; the message is only how
  // the operator learns why.
  rmSync(hub, { force: true });
  openHub(hub).close();
  {
    const q = new DatabaseSync(hub);
    q.exec(`INSERT INTO schema_version(version, applied_at) VALUES(${HUB_SCHEMA_VERSION + 1}, unixepoch())`);
    q.exec("PRAGMA journal_mode = DELETE");   // the state a restored snapshot is in; see below
    q.close();
  }
  const digestOf = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
  const beforeRun = digestOf(hub);
  const newerRun = dryRun();
  check(newerRun.status === 1 && /schema version/.test(newerRun.out) && /newer binary/.test(newerRun.out),
    "the route refuses a hub NEWER than this binary and names the remedy", newerRun.out.slice(0, 500));
  check(digestOf(hub) === beforeRun,
    "and leaves it byte-identical, which is the whole promise of --dry-run",
    `${beforeRun.slice(0, 12)} -> ${digestOf(hub).slice(0, 12)}`);

  // AND A HEALTHY, CURRENT HUB IS NOT WRITTEN EITHER.
  //
  // The version checks stop `openHub` from MIGRATING, which was the
  // irreversible write. They do not stop it writing at all: its first act is
  // `PRAGMA journal_mode = WAL`, which rewrites the header of a database in
  // DELETE mode. A hub restored from a snapshot is in delete mode, because
  // `VACUUM INTO` writes it that way -- so the ordinary case, a fully migrated
  // hub with nothing wrong with it, was the one still being modified.
  rmSync(hub, { force: true });
  openHub(hub).close();
  {
    const q = new DatabaseSync(hub);
    q.exec("PRAGMA journal_mode = DELETE");
    q.close();
  }
  const beforeHealthy = digestOf(hub);
  const healthy = dryRun();
  // THE CONTROL IS THAT THE HUB WAS REACHED, not that the whole command
  // succeeded. This fixture has no git repository, so the run stops further
  // along -- and that is what proves it got PAST the hub guard and opened the
  // store, which is what makes the byte comparison below mean something. Without
  // it, a route that exited before touching the hub would satisfy it too.
  check(!/reeve task: the hub at/.test(healthy.out),
    "control: a healthy current hub is not refused by the dry-run guard, so the store is opened",
    healthy.out.slice(0, 300));
  check(digestOf(hub) === beforeHealthy,
    "and does not write to it -- the version checks stopped the migration, not the pragma",
    `${beforeHealthy.slice(0, 12)} -> ${digestOf(hub).slice(0, 12)}`);

  // WHAT THE PROMISE DOES NOT COVER, asserted rather than left to a comment.
  //
  // Measured: a read-only open of a WAL hub CREATES hub.db-wal and hub.db-shm
  // and leaves them behind. That is what reading a WAL database costs, and every
  // read route in this binary pays it. `immutable=1` removes them and is wrong:
  // with a live writer holding the WAL it reads the main file alone and reports
  // `no such table: schema_version` for a healthy hub. So the promise is about
  // the hub's CONTENT, and this records the boundary so nobody later reads the
  // byte assertion above as "touches nothing at all".
  // ON A WAL HUB, which is the state openHub leaves one in. The case above put
  // the fixture into DELETE mode deliberately, so that the byte comparison could
  // see a write -- and a DELETE-mode database has no sidecars at all, which is
  // why this needs its own hub rather than sharing that one.
  rmSync(hub, { force: true });
  openHub(hub).close();                      // WAL, and no sidecars once closed
  check(!existsSync(hub + "-wal") && !existsSync(hub + "-shm"),
    "control: a closed WAL hub has no sidecars, so their appearance below is this run's",
    `wal=${existsSync(hub + "-wal")} shm=${existsSync(hub + "-shm")}`);
  const beforeWal = digestOf(hub);
  dryRun();
  check(existsSync(hub + "-wal") || existsSync(hub + "-shm"),
    "the read leaves SQLite's sidecars, which is what reading a WAL database costs",
    `wal=${existsSync(hub + "-wal")} shm=${existsSync(hub + "-shm")}`);
  check(digestOf(hub) === beforeWal,
    "and the hub's own bytes are still untouched, which is what the promise covers",
    `${beforeWal.slice(0, 12)} -> ${digestOf(hub).slice(0, 12)}`);

  // AN INVALID MARKER IS ITS OWN FAULT. schema_version is an INTEGER PRIMARY
  // KEY, so -1 is valid SQLite: every expected version reads as missing and
  // nothing reads as a hole, so the route would have said "migrate" -- and
  // openHub refuses that same store, because historyGaps will not take a
  // negative bound. The advertised remedy could not have worked.
  rmSync(hub, { force: true }); rmSync(hub + "-wal", { force: true }); rmSync(hub + "-shm", { force: true });
  openHub(hub).close();
  {
    const q = new DatabaseSync(hub);
    q.exec("DELETE FROM schema_version");
    q.exec("INSERT INTO schema_version(version, applied_at) VALUES(-1, unixepoch())");
    q.close();
  }
  const bad = dryRun();
  check(bad.status === 1 && /not a migration number/.test(bad.out),
    "a marker that is not a version is named as the fault", bad.out.slice(0, 400));
  check(/restore a snapshot/.test(bad.out) && !/without --dry-run/.test(bad.out),
    "and the remedy is a snapshot, not the writing command that would refuse it", bad.out.slice(0, 400));
  let openWhy = null;
  try { openHub(hub).close(); } catch (e) { openWhy = String(e.message); }
  check(openWhy !== null,
    "control: and openHub really does refuse it, so migrating was never a remedy", String(openWhy).slice(0, 160));

  // A FULL HISTORY IS NOT A HEALTHY SHAPE. The history says which migrations
  // RAN; it does not say the tables they created are still there. The same
  // hand-repaired store these checks exist for can carry a complete history over
  // a dropped table, and `liveLeases` would then throw a bare `no such table`
  // from inside a command that had already reported the hub healthy.
  rmSync(hub, { force: true }); rmSync(hub + "-wal", { force: true }); rmSync(hub + "-shm", { force: true });
  openHub(hub).close();
  {
    const q = new DatabaseSync(hub);
    q.exec("DROP TABLE territory_lease");
    q.close();
  }
  const shape = dryRun();
  check(shape.status === 1 && /tables do not match it/.test(shape.out),
    "a hub whose tables do not match its recorded version is refused before any application query",
    shape.out.slice(0, 400));
  check(!/no such table/.test(shape.out),
    "and the operator gets that sentence rather than SQLite's bare no-such-table",
    shape.out.slice(0, 400));

  // AND A CORRECT CATALOGUE IS NOT AN INTACT FILE. The history says the
  // migrations ran and `schemaDefectsAt` says the tables are all there; neither
  // of them reads a data or index PAGE. `openHub` runs `quick_check(1)` for
  // exactly that reason -- and the dry run, which must not go through `openHub`
  // because `openHub`'s first act is a write, took the read-only route around
  // the check as well as around the write. A hub damaged in a page then passed
  // every probe here and surfaced later out of `liveLeases`, as a raw `database
  // disk image is malformed` from a command that had already called it healthy.
  rmSync(hub, { force: true }); rmSync(hub + "-wal", { force: true }); rmSync(hub + "-shm", { force: true });
  openHub(hub).close();
  {
    const q = new DatabaseSync(hub);
    // DELETE mode, so the damage is in the file the next open reads rather than
    // in a WAL frame that a checkpoint may or may not have written yet.
    q.exec("PRAGMA journal_mode=DELETE");
    for (let i = 0; i < 400; i++)
      q.prepare("INSERT INTO hub_event(seq, kind, at, payload) VALUES(?,?,?,?)")
        .run(i + 1, "k".repeat(40), 1, "x".repeat(300));
    q.close();
  }
  {
    // Page 1 holds `sqlite_schema`, so leaving it alone is what keeps the
    // CATALOGUE readable while the b-tree beneath it is not -- which is the
    // whole case. Page 2 is the first table's root.
    const raw = readFileSync(hub);
    const pageSize = raw.readUInt16BE(16) || 65536;
    raw.fill(0xa5, pageSize + 8, pageSize * 2);
    writeFileSync(hub, raw);
  }
  // THE FIXTURE IS CHECKED BEFORE IT IS USED. A corruption that also broke the
  // catalogue would make the dry run refuse for the PREVIOUS reason, and this
  // test would pass without ever reaching the integrity check it is here for.
  {
    const q = new DatabaseSync(hub, { readOnly: true });
    let verdict = null;
    try { verdict = Object.values(q.prepare("PRAGMA quick_check(1)").get() ?? {})[0]; }
    catch (e) { verdict = `threw ${e.message}`; }
    let defects = null;
    try { defects = schemaDefectsAt(q, HUB_SCHEMA_VERSION); } catch (e) { defects = `threw ${e.message}`; }
    q.close();
    check(verdict !== "ok", "precondition: the fixture really is damaged in a page", String(verdict).slice(0, 120));
    check(Array.isArray(defects) && defects.length === 0,
      "precondition: and its catalogue still reads clean, so the shape check cannot be what refuses it",
      JSON.stringify(defects).slice(0, 200));
  }
  const damaged = dryRun();
  // THE INTEGRITY CHECK'S OWN SENTENCE, not two common words. `/is damaged/`
  // matched any message containing them -- and it began doing exactly that when
  // the unreadable-history remedy gained "the store is damaged", so this assertion
  // passed while the check it names was stubbed out and something else refused.
  // `quick_check` reports the FIRST problem it finds, and saying so is unique to
  // that refusal.
  check(damaged.status === 1 && /The first problem found is:/.test(damaged.out),
    "a hub damaged in a page is refused by the dry run, on the integrity check openHub would have run",
    damaged.out.slice(0, 400));
  // EITHER REMEDY, because which one is right depends on whether a snapshot
  // exists -- and this fixture has none. Asserting only the restore command
  // would demand the wrong sentence for the case the fixture actually builds.
  check(/ {2}recover {2}/.test(damaged.out) &&
        /reeve restore --hub --force|no snapshot was found/.test(damaged.out),
    "and the operator is given a remedy in reeve's words",
    damaged.out.slice(0, 400));
  check(!/database disk image is malformed/.test(damaged.out),
    "rather than SQLite's raw malformed-image error", damaged.out.slice(0, 400));
  check(!/^\s*\{/.test(damaged.out),
    "control: and no plan is emitted over the damaged store", damaged.out.slice(0, 200));

  // ONE CONNECTION, so the history and the tables describe one store. The
  // history used to be read through a connection of its own, closed before the
  // one that read the tables ever opened -- two moments, and a newer reeve
  // migrating between them made the version check answer about a hub that no
  // longer existed. `migrationStateOf` reads through the connection it is
  // handed; that is what lets the route hold one.
  //
  // Proven by taking the PATH away: an open handle keeps its inode, so a reader
  // that goes through the connection still answers, and one that re-opens the
  // path cannot.
  {
    const solo = join(dir, "one-connection.db");
    openHub(solo).close();
    { const q = new DatabaseSync(solo); q.exec("PRAGMA journal_mode=DELETE"); q.close(); }
    const held = new DatabaseSync(solo, { readOnly: true });
    check(migrationStateOf(held).readable === true,
      "control: the history reads through a caller's connection");
    rmSync(solo, { force: true });
    rmSync(solo + "-wal", { force: true }); rmSync(solo + "-shm", { force: true });
    check(migrationStateOf(held).readable === true,
      "and it still reads it once the path is gone, because it reads the CONNECTION");
    check(missingMigrations(solo).readable === false,
      "control: while the path form cannot, which is the difference the route depends on");
    held.close();
  }
}

// ── THE RECORDED VERSION IS NOT A LOOP BOUND ────────────────────────────────
//
// `schema_version` is the one table an operator is most likely to have edited by
// hand, and the contiguity rule read its maximum as the number of iterations to
// perform. Measured on node v24.17.0: a hub whose only row is version 1000000000
// killed `missingMigrations` with a V8 heap OOM -- so `reeve task file --dry-run`
// crashed on the corrupt marker it exists to REPORT.
//
// RUN IN A CHILD WITH A HARD TIMEOUT, not inline. A regression here does not
// fail, it exhausts memory: inline, it would take the whole suite down with a
// V8 fatal error and no assertion line at all. In a child, the kill is the
// answer.
const HUGE = 1000000000;
{
  // EVERY PROBE THAT TOUCHES THE LARGE VALUE RUNS IN THE CHILD, none in this
  // process. A regression here does not fail an assertion, it exhausts memory --
  // so run inline it would abort this file with a V8 fatal error partway
  // through, and the assertions that never ran would be indistinguishable in the
  // log from assertions that passed. In the child, the kill IS the answer.
  const probe = join(dir, "huge.db");
  openHub(probe).close();
  {
    const q = new DatabaseSync(probe);
    q.exec("DELETE FROM schema_version");
    q.exec(`INSERT INTO schema_version(version, applied_at) VALUES(${HUGE}, unixepoch())`);
    q.close();
  }
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { missingMigrations, hasHistoryHole, historyGaps } from ${JSON.stringify(new URL("../src/build/hubdb.mjs", import.meta.url).href)};
     const r = missingMigrations(${JSON.stringify(probe)});
     const holed = hasHistoryHole([${HUGE}]);
     let bound = null;
     try { historyGaps([1, ${HUGE}], ${HUGE}); } catch (e) { bound = String(e.message); }
     process.stdout.write(JSON.stringify({ version: r.version, holed: r.holed, missing: r.missing.length,
                                           direct: holed, bound }));`],
    { encoding: "utf8", timeout: 20000, maxBuffer: 1 << 20 });
  check(child.status === 0,
    "missingMigrations returns on a hub recording a very large version, rather than exhausting memory",
    `status=${child.status} signal=${child.signal} ${String(child.stderr).slice(-300)}`);
  let answer = null;
  try { answer = JSON.parse(child.stdout); } catch { /* reported by the check above */ }
  check(answer !== null && answer.version === HUGE && answer.holed === true
        && answer.missing === HUB_SCHEMA_VERSION,
    "and it reports the recorded version, the hole, and every expected migration as absent",
    JSON.stringify(answer));
  check(answer !== null && answer.direct === true,
    "and hasHistoryHole answers the same question directly without enumerating", JSON.stringify(answer));
  // THE ENUMERATING FORM REFUSES AN UNTRUSTED BOUND. `historyGaps` still
  // enumerates, because a message has to NAME the missing versions. What changed
  // is that the bound is the CALLER'S and is refused above this binary's own
  // version -- which is what makes the ordering in `openHub` and in
  // `validateSnapshot`, both of which refuse a newer store first, load-bearing
  // rather than incidental. A future reordering fails with this message instead
  // of silently exhausting memory.
  check(answer !== null && answer.bound !== null
        && new RegExp(`0 to ${HUB_SCHEMA_VERSION}`).test(String(answer.bound)),
    "historyGaps refuses to enumerate up to a version this binary does not know",
    JSON.stringify(answer && answer.bound));

  // The ordinary cases, in this process, where they cost nothing.
  check(hasHistoryHole([1, 2, 3]) === false && hasHistoryHole([1, 3]) === true,
    "control: and it still answers ordinary histories correctly");
  check(JSON.stringify(historyGaps([1, HUB_SCHEMA_VERSION], HUB_SCHEMA_VERSION)) ===
        JSON.stringify(Array.from({ length: HUB_SCHEMA_VERSION - 2 }, (_, i) => i + 2)),
    "control: and within its own bound it still names exactly the absent versions",
    JSON.stringify(historyGaps([1, HUB_SCHEMA_VERSION], HUB_SCHEMA_VERSION)));
}

// ── A NEWER hub is refused before anything is opened for writing ────────────
//
// A contiguous history one version above this binary is missing none of what
// this binary expects, so `missing` is empty and `holed` is false. The dry-run
// guard read only those two and fell through to `openHub` -- whose first acts
// are `PRAGMA journal_mode = WAL` and the `schema_version` DDL. Both are writes,
// to a database written by a NEWER binary, from the command whose whole promise
// here is that it writes nothing.
{
  const newer = join(dir, "newer.db");
  openHub(newer).close();
  {
    const q = new DatabaseSync(newer);
    q.exec(`INSERT INTO schema_version(version, applied_at) VALUES(${HUB_SCHEMA_VERSION + 1}, unixepoch())`);
    q.close();
  }
  const h = missingMigrations(newer);
  check(h.missing.length === 0 && h.holed === false && h.version === HUB_SCHEMA_VERSION + 1,
    "a contiguous hub one version NEWER is missing nothing and is not holed -- only `version` says so",
    JSON.stringify(h));

  // IN DELETE JOURNAL MODE, because that is the state the write is visible in
  // and it is not a contrived one: `VACUUM INTO` writes a snapshot in delete
  // mode, so a restored hub is in delete mode until `openHub` converts it. On a
  // store already in WAL, openHub's opening pragma and its `CREATE TABLE IF NOT
  // EXISTS` are both no-ops, and a byte comparison would report no write while
  // the file was still opened read-write -- a control that passes for the wrong
  // reason on the fixture that happens to be handy.
  {
    const q = new DatabaseSync(newer);
    q.exec("PRAGMA journal_mode = DELETE");
    q.close();
  }
  const digest = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
  const beforeOpen = digest(newer);
  let refused = null;
  try { openHub(newer).close(); } catch (e) { refused = String(e.message); }
  check(refused !== null && /is schema version/.test(refused),
    "control: openHub does refuse a newer store", String(refused));
  check(digest(newer) !== beforeOpen,
    "control: but only AFTER writing to it, so reaching openHub at all is the defect",
    `${beforeOpen.slice(0, 12)} -> ${digest(newer).slice(0, 12)}`);
}

// ── A REFUSED MARKER DOES NOT LEAK THE HANDLE ──────────────────────────────
//
// `historyGaps` refuses a bound it cannot trust, and `schema_version` is an
// INTEGER PRIMARY KEY, so a hand-edited marker may hold a NEGATIVE number --
// which reaches that refusal rather than the hole branch below it, where the
// close lives. A long-running process that catches and retries the open then
// leaks one SQLite descriptor per attempt until unrelated file operations start
// failing, which is a failure nobody would trace back to a corrupt marker.
//
// MEASURED AS A RATE, not a total. Descriptor counts move for reasons that have
// nothing to do with this loop, so the assertion is that the count does not grow
// in PROPORTION to the attempts -- and the control is the same loop over a
// healthy hub, which closes properly, so a growing number there would mean the
// instrument and not the defect.
{
  const openFds = () => { try { return readdirSync("/dev/fd").length; } catch { return -1; } };
  check(openFds() > 0, "control: this platform reports open descriptors, so the leak is observable",
    String(openFds()));
  const ATTEMPTS = 120;
  const drill = (p) => {
    const before = openFds();
    for (let i = 0; i < ATTEMPTS; i++) { try { openHub(p).close(); } catch { /* the point */ } }
    return openFds() - before;
  };
  const negative = join(dir, "negative.db");
  openHub(negative).close();
  {
    const q = new DatabaseSync(negative);
    q.exec("DELETE FROM schema_version");
    q.exec("INSERT INTO schema_version(version, applied_at) VALUES(-1, unixepoch())");
    q.close();
  }
  let refused = null;
  try { openHub(negative); } catch (e) { refused = String(e.message); }
  check(refused !== null, "control: a negative version marker is refused, so the drill exercises the throw",
    String(refused).slice(0, 120));
  const leaked = drill(negative);
  const healthy = join(dir, "healthy-drill.db");
  openHub(healthy).close();
  const baseline = drill(healthy);
  check(leaked < ATTEMPTS / 4,
    "a refused marker does not leak a descriptor per attempt", `${leaked} over ${ATTEMPTS} attempts`);
  check(baseline < ATTEMPTS / 4,
    "control: and neither does the same loop over a healthy hub, so the count is the defect and not the instrument",
    `${baseline} over ${ATTEMPTS} attempts`);
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
