// Doctor classifies rather than lists, because "16 things are wrong" is not a
// report anyone acts on: a configuration error is fixed, a dependency outage is
// waited out, stale evidence is refreshed, and unsafe authority is the only one
// that should stop a merge.
//
// It also must not write repo_gate_state. A reporter that can write what it
// reports can agree with itself, and the row exists precisely so that clause U4
// reads something the LOOP established.
import { openHub, isOperational } from "../src/build/hubdb.mjs";
import { hubFindings, renderHub } from "../src/doctor.mjs";
// The self-audit block at the end of this task needs all of these. The standard
// harness supplies only check, dir, join, tmpdir, mkdtempSync and rmSync.
import { selfAudit, BROKEN } from "../src/selfaudit.mjs";
import { open as openStore } from "../src/db/ops.mjs";
import { hubPathFor } from "../src/paths.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, writeSync, closeSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";   // the CLI drill runs bin/reeve
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// The checkout root, so a spawned CLI is THIS bin/reeve and not one on PATH.
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "reeve-hubdoctor-"));

{
  const db = openHub(join(dir, "d.db"));
  const NOW = 1_800_000_000;

  // no snapshot at all
  let f = hubFindings(db, { root: join(dir, "backups"), now: NOW, snapshotFor: () => null });
  const noSnap = f.find(x => x.id === "H-1");
  check(noSnap && noSnap.severity === "fail", "a hub with no snapshot at all is a failure, not a note", JSON.stringify(noSnap));
  check(noSnap?.classification === "configuration", "classified as configuration", String(noSnap?.classification));

  // a stale snapshot
  f = hubFindings(db, { root: "/b", now: NOW, snapshotFor: () => ({ path: "/b/hub/1.db", at: NOW - 86400 * 3, ok: true, version: 1 }) });
  check(f.find(x => x.id === "H-1")?.classification === "stale-evidence", "a three-day-old snapshot is stale evidence");

  // a fresh, valid one
  f = hubFindings(db, { root: "/b", now: NOW, snapshotFor: () => ({ path: "/b/hub/1.db", at: NOW - 60, ok: true, version: 1 }) });
  check(f.find(x => x.id === "H-1")?.severity === "pass", "control: a fresh valid snapshot passes, so H-1 is not always red");

  // A registry project with NO row is the case doctor was blind to: it emitted
  // nothing at all, which reads as "fine".
  // No repoId: the registry format has none, so a fixture that supplies one
  // tests a lookup the CLI can never perform.
  const PROJECTS = [{ name: "nextly", nwo: "o/r" }, { name: "other", nwo: "o/other" }];
  f = hubFindings(db, { root: "/b", now: NOW, snapshotFor: () => null, projects: PROJECTS });
  // `H-4:<nwo>`, not the bare id. The implementation scopes the identity per
  // project (a failing project and a healthy one both emitting `H-4` is the
  // defect that change fixed), so a filter on the bare id matches NOTHING and
  // every assertion in this block passes vacuously on an empty array.
  const absent = f.filter(x => x.id.startsWith("H-4:"));
  // CONTROL: the bare id is gone. Without it this block goes green again the
  // moment someone reverts the scoping, since `startsWith("H-4:")` and
  // `=== "H-4"` are both satisfied by a set containing only the other one.
  check(f.filter(x => x.id === "H-4").length === 0,
    "control: no finding carries the unscoped H-4 id",
    JSON.stringify(f.map(x => x.id)));
  check(absent.length === 2 && absent.every(x => x.classification === "unsafe-authority"),
    "a registry project with no gate-state row still produces a failing H-4",
    JSON.stringify(absent.map(x => x.title)));

  // repo_gate_state: absent is UNKNOWN and unsafe authority, never a quiet pass
  db.exec(`INSERT INTO repo_gate_state(repo_id,nwo_snapshot,ruleset_requires_check,bound_app_id,expected_app_id,app_installed,verified_at)
           VALUES(1,'o/r',0,NULL,42,'unknown',${NOW - 60})`);
  f = hubFindings(db, { root: "/b", now: NOW, snapshotFor: () => null });
  const gate = f.find(x => x.id.startsWith("H-4:"));
  check(gate?.classification === "unsafe-authority", "a ruleset that does not require the bound check is unsafe authority", JSON.stringify(gate));

  db.exec(`UPDATE repo_gate_state SET ruleset_requires_check=1, bound_app_id=42, app_installed='pass' WHERE repo_id=1`);
  f = hubFindings(db, { root: "/b", now: NOW, snapshotFor: () => null });
  check(f.find(x => x.id.startsWith("H-4:"))?.severity === "pass", "control: a ruleset requiring the bound app passes");

  db.exec(`UPDATE repo_gate_state SET verified_at=${NOW - 3600 * 3} WHERE repo_id=1`);
  f = hubFindings(db, { root: "/b", now: NOW, snapshotFor: () => null });
  check(f.find(x => x.id.startsWith("H-4:"))?.classification === "stale-evidence",
    "a row older than the freshness bound is stale, whatever it says");

  // THE assertion of this task: doctor is a reader.
  const before = db.prepare("SELECT * FROM repo_gate_state WHERE repo_id=1").get();
  hubFindings(db, { root: "/b", now: NOW, snapshotFor: () => null });
  const after = db.prepare("SELECT * FROM repo_gate_state WHERE repo_id=1").get();
  check(JSON.stringify(before) === JSON.stringify(after), "doctor does not write repo_gate_state");
  check(db.prepare("SELECT count(*) c FROM hub_event").get().c === 0, "and appends no hub_event at all: it is a reader");
  db.close();
}

// test/hub-doctor.test.mjs, at the end
{
  const home = mkdtempSync(join(tmpdir(), "reeve-cli-"));
  mkdirSync(join(home, "state"), { recursive: true });
  openHub(hubPathFor(home)).close();
  // REEVE_HOME, not `--home`. `bin/reeve` derives its home from
  // `process.env.REEVE_HOME ?? join(homedir(), ".reeve")` and has no --home
  // option, so passing one is silently ignored and the child inspects the
  // DEVELOPER'S real ~/.reeve -- host state deciding the result, and a
  // no-hub H-0 answer loose enough to satisfy the assertions anyway.
  const run = (args) => spawnSync(process.execPath, ["bin/reeve", ...args],
    { encoding: "utf8", env: { ...process.env, REEVE_HOME: home } });
  const j = run(["builder", "doctor", "--json"]);
  check(j.status === 0 || j.status === 1,
    "`reeve builder doctor --json` runs rather than falling through to unknown-command",
    `status=${j.status} stderr=${j.stderr?.slice(0, 200)}`);
  check(!/unknown command|usage:/i.test(j.stderr ?? ""),
    "and is not reported as an unknown command", String(j.stderr).slice(0, 200));
  let parsed = null;
  try { parsed = JSON.parse(j.stdout); } catch {}
  check(Array.isArray(parsed) && parsed.every(f => f.id && f.severity),
    "and --json emits the finding array", String(j.stdout).slice(0, 200));
  // CONTROL: the child really is reading the temporary home, not the
  // developer's. Without this the whole block can pass against ~/.reeve.
  check((parsed ?? []).every(f => !/\/Users\/[^/]+\/\.reeve/.test(JSON.stringify(f))),
    "control: the findings name the temporary home, so REEVE_HOME took effect",
    String(j.stdout).slice(0, 200));
  // CONTROL: a command that really IS unknown must fail differently, or the
  // assertions above pass for any exit status at all.
  const bogus = run(["builder", "nonsense"]);
  check(bogus.status !== 0 && /usage:/i.test(bogus.stderr ?? ""),
    "control: an unknown builder subcommand is refused with usage",
    `status=${bogus.status} stderr=${bogus.stderr?.slice(0, 120)}`);
  rmSync(home, { recursive: true, force: true });
}

// in test/hub-doctor.test.mjs:
{
  // selfAudit(db, opts) -- a DATABASE first, and the machine root as opts.home.
  // Passing a directory as the db argument makes every existing check call
  // dir.prepare(...) and return unrelated store findings, so the assertions
  // below would be scored against an audit that never looked at a hub.
  const machine = mkdtempSync(join(tmpdir(), "reeve-audit-"));
  mkdirSync(join(machine, "state"), { recursive: true });
  const p = hubPathFor(machine); openHub(p).close();
  mkdirSync(join(machine, "state", "o"), { recursive: true });
  const repoDb = openStore(join(machine, "state", "o", "r.db"));   // the audit's own store argument
  const audit = () => selfAudit(repoDb, { nwo: "o/r", home: machine, backupRoot: join(machine, "backups") });

  // A HEALTHY hub contributes NOTHING. Asserting an "ok" finding here is what
  // put an undefined-keyed escalation on every tick: daemon.mjs escalates every
  // item selfAudit returns, without filtering by level.
  check(!audit().some(f => f.id === "hub.integrity"),
    "a healthy hub adds no finding at all, because selfAudit returns faults only",
    JSON.stringify(audit().map(f => `${f.level}:${f.id}`)));
  // CONTROL: the audit is running and producing its ordinary findings, so the
  // absence above is a healthy hub and not an audit that did nothing.
  check(audit().every(f => f.id && f.why && f.level),
    "control: every finding the audit does return carries the id/level/why contract",
    JSON.stringify(audit()));

  // Corrupt a page the database ACTUALLY USES, derived from the file rather
  // than hardcoded. Offset 8192 is page 3, which is live only because openHub
  // creates 32 tables and their indexes (67 pages, measured 2026-08-23); a
  // fixture of two pages or fewer would take the write past the end of the
  // file, integrity_check would still say `ok`, and the assertion below would
  // pass having corrupted nothing. See
  // docs/measured/2026-08-23-sqlite-page-corruption.md.
  const geom = new DatabaseSync(p, { readOnly: true });
  const pageSize  = geom.prepare("PRAGMA page_size").get().page_size;
  const pageCount = geom.prepare("PRAGMA page_count").get().page_count;
  geom.close();
  const fd = openSync(p, "r+");
  writeSync(fd, Buffer.alloc(pageSize, 0x41), 0, pageSize, (pageCount - 1) * pageSize);
  closeSync(fd);

  // CONTROL, and the durable half of this test: prove the file is really broken
  // before asserting that the audit says so. Without it, a technique that stops
  // corrupting anything turns the assertion below into a silent pass.
  const probe = new DatabaseSync(p, { readOnly: true });
  let integrity = null;
  try { integrity = Object.values(probe.prepare("PRAGMA integrity_check").get())[0]; }
  catch (e) { integrity = `threw: ${e.message}`; }
  finally { probe.close(); }
  check(integrity !== "ok", "control: the fixture really is corrupt now", String(integrity));

  const bad = audit().find(f => f.id === "hub.integrity");
  check(bad?.level === BROKEN,
    "and reports the hub as BROKEN when it is corrupt, so a silent audit is not a passing one",
    JSON.stringify(audit().map(f => `${f.level}:${f.id}`)));
  // The escalation key is `why`, and daemon.mjs uses it verbatim. A finding
  // whose why is undefined becomes escalations.set(undefined, 1).
  check(typeof bad?.why === "string" && bad.why.length > 0,
    "carrying a stable `why`, because that string IS the escalation key", JSON.stringify(bad));
  check((bad?.detail ?? "").includes(p), "and a detail naming the file", String(bad?.detail));
  rmSync(machine, { recursive: true, force: true });
}

// ── renderHub: the human report, which nothing else in this file exercises ──
// `hubFindings` returns data; `renderHub` is what an operator actually reads,
// and it did not exist at all -- four call sites in `bin/reeve` named it, an
// import listed it, prose described it, and no definition anywhere. Every
// `reeve builder doctor` would have died with a ReferenceError.
//
// The grouping is the thing under test. `hubFindings` documents its four
// classifications as "the four different responses", so a renderer that sorts by
// severity and prints the class as a slug throws away the only part of a finding
// that tells the reader what to DO.
{
  const F = [
    { id: "H-1", severity: "pass", classification: "stale-evidence",
      title: "hub snapshot is fresh", detail: "3m old", action: null },
    { id: "H-2", severity: "fail", classification: "configuration",
      title: "snapshot does not validate", detail: "not a usable store", action: "reeve backup --hub" },
    { id: "H-6", severity: "warn", classification: "unsafe-authority",
      title: "a provider lease is past expiry", detail: "2 expired", action: null },
    { id: "H-3", severity: "pass", classification: "configuration",
      title: "schema version matches", detail: null, action: null },
  ];
  const text = renderHub(F);
  const at = (needle) => text.indexOf(needle);

  check(/broken/.test(text.split("\n")[0]),
    "the verdict line leads, and one failing finding makes it broken", text.split("\n")[0]);
  check(/1 failing/.test(text) && /1 warning/.test(text) && /2 ok/.test(text),
    "and counts every severity, so 'is it healthy' is answerable from the first two lines",
    text.split("\n")[1]);

  // EVERY finding survives. A renderer that groups can silently drop one, and
  // a report missing a fault is worse than no report.
  for (const f of F)
    check(at(f.id) !== -1 && at(f.title) !== -1, `renders ${f.id} and its title`, f.id);

  // The classes are ordered by what they demand of the reader.
  check(at("UNSAFE AUTHORITY") !== -1 && at("UNSAFE AUTHORITY") < at("CONFIGURATION"),
    "unsafe authority comes first, because it is the class that stops a merge");
  check(at("CONFIGURATION") < at("STALE EVIDENCE"),
    "and what you fix comes before what you refresh");
  check(/this stops a merge/.test(text) && /fix these/.test(text) && /refresh these/.test(text),
    "and each heading says what the class asks of the reader, rather than printing a slug");

  // Severity orders WITHIN a group, so the fault in a class is not buried under
  // its passes.
  check(at("H-2") < at("H-3"),
    "a failing finding sorts above a passing one in the same class", `${at("H-2")} vs ${at("H-3")}`);

  // The action is the only part of a finding that is not a description.
  check(/-> reeve backup --hub/.test(text),
    "an action renders with the arrow every other reeve command uses", text);
  check((text.match(/-> /g) ?? []).length === 1,
    "control: and only the finding that HAS an action gets one",
    JSON.stringify(text.match(/-> .*/g)));

  // A class this renderer does not know is REPORTED, not dropped. Otherwise the
  // renderer becomes the one place a new classification can be added and never
  // seen -- and an empty report and a swallowed one look identical.
  const odd = renderHub([{ id: "H-9", severity: "fail", classification: "martian",
                           title: "from somewhere else", detail: null, action: null }]);
  check(/H-9/.test(odd) && /from somewhere else/.test(odd),
    "a finding with an unknown classification is still shown", odd);
  check(/martian/.test(odd),
    "and its unknown class is named, so the omission is visible rather than silent", odd);

  check(/nothing to report|no findings/.test(renderHub([])),
    "an empty finding list says so, rather than rendering a bare header", renderHub([]));
}

// ── builder doctor with a snapshot present: the path the fresh-home test misses ─
// The existing CLI drill runs against a home with no hub, so `builder doctor`
// returns at the H-0 guard before it ever reaches `snapshotFor`. That is the
// branch where `basename` and `readdirSync` are called -- so an unimported
// helper there is invisible to every assertion above and appears only on a
// machine that has actually taken a backup, which is every machine that has run
// the builder. The absent-hub guard hides it exactly like the DatabaseSync
// omission it hid before.
{
  const home = join(dir, "doctor-live");
  mkdirSync(join(home, "state"), { recursive: true });
  const db = openHub(hubPathFor(home));
  db.close();
  const env = { ...process.env, REEVE_HOME: home };
  const run = (args) => spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), ...args],
    { encoding: "utf8", env });

  const backup = run(["backup", "--hub"]);
  check(backup.status === 0,
    "fixture: `reeve backup --hub` takes a snapshot so the doctor has one to read",
    `${backup.status} ${(backup.stderr || backup.stdout || "").slice(0, 200)}`);

  const doc = run(["builder", "doctor"]);
  const all = (doc.stdout ?? "") + (doc.stderr ?? "");
  check(!/ReferenceError/.test(all),
    "`reeve builder doctor` runs against a hub that HAS a snapshot, without a ReferenceError",
    all.slice(0, 300));
  // Name the two helpers, so the failure says which import is missing rather
  // than only that something threw.
  check(!/basename is not defined/.test(all), "and `basename` is bound", all.slice(0, 200));
  check(!/readdirSync is not defined/.test(all), "and `readdirSync` is bound", all.slice(0, 200));
  check(/H-1|snapshot/i.test(all),
    "and it reports on the snapshot it found, rather than stopping at the absent-hub guard",
    all.slice(0, 300));
}

// ── `backup --hub` must not report success without a hub snapshot ────────────
// `everyStore` only returns files that exist, so a missing hub is simply absent
// from the results -- and an exit status computed from "did anything fail"
// answers 0 for a run that backed up nothing at all. This is the command an
// operator runs to protect the authority database, including right after
// deleting it by accident.
{
  const home = join(dir, "no-hub-home");
  mkdirSync(join(home, "state"), { recursive: true });
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), "backup", "--hub"],
    { encoding: "utf8", env: { ...process.env, REEVE_HOME: home } });
  const all = (r.stdout ?? "") + (r.stderr ?? "");
  check(r.status !== 0,
    "`reeve backup --hub` fails when there is no hub to back up, rather than exiting 0 on an empty result",
    `status=${r.status} ${all.slice(0, 200)}`);
  check(/hub/i.test(all),
    "and says the hub is what was missing", all.slice(0, 200));
}

// ── a de-registered project's gate-state row, and the trap in suppressing it ─
// A `repo_gate_state` row outlives the project's entry in projects.json, and a
// doctor that reports every row keeps failing for a repository the builder no
// longer manages. But `projects: []` means BOTH "the registry lists nothing" and
// "the registry could not be read", and filtering on the second would hide every
// unsafe-authority finding on the machine -- the absence-read-as-success this
// whole command exists to refuse. So suppression takes positive knowledge.
{
  const db = openHub(join(dir, "dereg.db"));
  const NOW = 1_800_000_000;
  const row = (id, nwo) => db.exec(
    `INSERT INTO repo_gate_state(repo_id,nwo_snapshot,ruleset_requires_check,bound_app_id,
                                 expected_app_id,app_installed,verified_at)
     VALUES(${id},'${nwo}',0,NULL,42,'fail',${NOW})`);
  row(1, "o/current");
  row(2, "o/removed");
  const args = { root: join(dir, "backups"), now: NOW, snapshotFor: () => null };
  const idsOf = (f) => f.filter(x => String(x.id).startsWith("H-4")).map(x => x.id).sort();

  // The registry was READ and lists only o/current.
  const known = hubFindings(db, { ...args, projects: [{ name: "cur", nwo: "o/current" }], projectsKnown: true });
  check(!idsOf(known).includes("H-4:o/removed"),
    "a gate-state row for a project the registry no longer lists is not reported",
    JSON.stringify(idsOf(known)));
  check(idsOf(known).includes("H-4:o/current"),
    "control: the row for a project that IS registered is still reported",
    JSON.stringify(idsOf(known)));

  // The registry could NOT be read. Same rows, same empty-looking project list,
  // and the opposite answer: report everything.
  const blind = hubFindings(db, { ...args, projects: [], projectsKnown: false });
  check(idsOf(blind).includes("H-4:o/removed") && idsOf(blind).includes("H-4:o/current"),
    "but with the registry unreadable every row is reported, because an empty list is not evidence",
    JSON.stringify(idsOf(blind)));

  // And the DEFAULT is the safe one. A caller that says nothing gets the noisy
  // answer, not the silent one.
  const dflt = hubFindings(db, { ...args, projects: [] });
  check(idsOf(dflt).length === 2,
    "control: `projectsKnown` defaults to false, so an unaware caller cannot silently suppress authority findings",
    JSON.stringify(idsOf(dflt)));
  db.close();
}

// ── two CLI options that could destroy a backup set or crash a report ───────
{
  const home = join(dir, "opts-home");
  mkdirSync(join(home, "state"), { recursive: true });
  const env = { ...process.env, REEVE_HOME: home };
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), ...args],
    { encoding: "utf8", env });

  // `--keep` reaches `prune`, and `Number()` alone accepts 0, negatives,
  // fractions and NaN. Each ERASES EVERY RECOVERY POINT while the command
  // prints `snapshot hub -> ...` and exits 0 -- `keep: 0` prunes to nothing, and
  // `slice(NaN)` is `slice(0)` in JavaScript, so a typo deletes the whole set.
  // Measured before the fix: all four reported success.
  openHub(hubPathFor(home)).close();
  for (const bad of ["0", "-1", "aa", "2.5"]) {
    const r = run("backup", "--hub", "--keep", bad);
    check(r.status !== 0 && /--keep must be a positive whole number/.test((r.stderr ?? "") + (r.stdout ?? "")),
      `\`--keep ${bad}\` is refused before anything is written`,
      `status=${r.status} ${((r.stderr ?? "") + (r.stdout ?? "")).slice(0, 120)}`);
  }
  // CONTROL, and it is the one that matters: `opt()` returns NULL for an absent
  // flag, so a strict `=== undefined` check rejected the DEFAULT path and broke
  // every plain `backup --hub`. That regression was introduced by the fix above
  // and caught only by running the command.
  const dflt = run("backup", "--hub");
  check(dflt.status === 0,
    "control: with no --keep at all the default is used, not rejected",
    `status=${dflt.status} ${((dflt.stderr ?? "") + (dflt.stdout ?? "")).slice(0, 140)}`);
  const good = run("backup", "--hub", "--keep", "3");
  check(good.status === 0, "control: and a valid --keep still works", `status=${good.status}`);

  // `build status` on a hub whose first migration never completed. `openHub`
  // commits `schema_version` as plain DDL before migration 1's transaction, so
  // the version query succeeds and returns 0 while `singleton_lease` does not
  // exist -- and the command died with an uncaught SQLite stack trace instead of
  // reporting the builder state, which is the one thing it is for.
  const v0 = join(dir, "v0-home");
  mkdirSync(join(v0, "state"), { recursive: true });
  const half = new DatabaseSync(join(v0, "state", "hub.db"));
  half.exec(`CREATE TABLE IF NOT EXISTS schema_version (
               version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT`);
  half.close();
  const st = spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), "build", "status"],
    { encoding: "utf8", env: { ...process.env, REEVE_HOME: v0 } });
  const out = (st.stdout ?? "") + (st.stderr ?? "");
  check(!/no such table|SqliteError|at Database/.test(out),
    "`build status` reports on a hub whose first migration never completed, rather than throwing",
    out.slice(0, 200));
  check(/first migration never completed/.test(out),
    "and says what is wrong in words", out.slice(0, 200));
  check(/recover/.test(out),
    "and tells the operator what to do next", out.slice(0, 240));
}

// ── EVERY hub route survives an interrupted first migration ────────────────
// `openHub` commits `schema_version` as plain DDL BEFORE migration 1's
// transaction, so a store can exist, open, answer the version query with 0, and
// have none of the 31 tables. Existence is not readiness, and neither is
// openability.
//
// This has been the shape of FIVE findings. `build run`, `restoreHub` and
// `build status` were each fixed on their own; `builder doctor` was reported as
// the fourth; and running every hub route against a version-0 store -- rather
// than fixing the one that was named -- turned up `export-events --hub` as the
// fifth, dying with an uncaught `no such table: hub_event` on the command an
// operator reaches for when they no longer trust the hub.
//
// So the assertion is the INVARIANT, over the routes, rather than one more
// site: no hub route may answer an interrupted store with a stack trace.
{
  const home = join(dir, "v0-home");
  mkdirSync(join(home, "state"), { recursive: true });
  const env = { ...process.env, REEVE_HOME: home };
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), ...args],
    { encoding: "utf8", env });

  // A store in exactly the state an interrupted first run leaves: schema_version
  // created and committed, EMPTY, and no other table.
  const hub = hubPathFor(home);
  {
    const d = new DatabaseSync(hub);
    d.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT`);
    d.close();
  }
  // POSITIVE CONTROL: the fixture really is version 0 and really is openable --
  // otherwise every route below refuses it for being absent or corrupt and the
  // sweep proves nothing about this state.
  {
    const d = new DatabaseSync(hub, { readOnly: true });
    const v = d.prepare("SELECT COALESCE(max(version),0) v FROM schema_version").get().v;
    const tables = d.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c;
    d.close();
    check(v === 0 && tables === 1,
      "fixture: the hub opens, records no completed migration, and has only schema_version",
      `version=${v} tables=${tables}`);
  }

  const ROUTES = [
    ["builder", "doctor"],
    ["builder", "doctor", "--json"],
    ["build", "status"],
    ["export-events", "--hub", join(home, "tail.jsonl")],
    ["backup", "--hub"],
    ["restore", "--hub"],
  ];
  check(ROUTES.length >= 6, "control: the sweep covers every route that opens the hub", `${ROUTES.length} routes`);
  const crashed = [];
  for (const args of ROUTES) {
    const r = run(...args);
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    // A stack trace, by its own shape: node prints `    at ` frames, and the
    // missing-table message is the specific one this class produces.
    if (/no such table|^\s+at .*\(.*:\d+:\d+\)$/m.test(out)) crashed.push(`${args.join(" ")}: ${out.split("\n").find(l => /no such table|Error/.test(l)) ?? ""}`);
  }
  check(crashed.length === 0,
    "no hub route answers an interrupted first migration with a stack trace",
    crashed.join("  |  "));

  // And the two that were fixed here say what to do, rather than only refusing.
  const doc = run("builder", "doctor");
  check(/first migration never completed/.test(doc.stdout + doc.stderr) &&
        /reeve build run finishes it/.test(doc.stdout + doc.stderr),
    "`builder doctor` reports it as an H-0 finding with a recovery",
    (doc.stdout + doc.stderr).slice(0, 240));
  const exp = run("export-events", "--hub", join(home, "tail.jsonl"));
  check(exp.status !== 0 && /holds no event log/.test(exp.stdout + exp.stderr),
    "`export-events --hub` refuses instead of querying a table that does not exist",
    (exp.stdout + exp.stderr).slice(0, 240));
  check(!existsSync(join(home, "tail.jsonl")),
    "and writes no file, so a refused export cannot be mistaken for an empty history", "");
}

// ── a malformed registry is an ERROR, not a set of rows silently dropped ───
// `{ "prod": "bad" }` parsed, so the loader returned `error: null` and filtered
// the entry away. Doctor then set `projectsKnown: true` over a project set the
// registry did not describe, and `hubFindings` SUPPRESSES gate-state rows absent
// from that set -- so a broken registry reported a clean hub while hiding the
// H-4 authority findings the H-7 path exists to preserve. Narrowing the input
// answers a smaller question than the one that was asked.
{
  const home = join(dir, "registry-home");
  mkdirSync(join(home, "state"), { recursive: true });
  const env = { ...process.env, REEVE_HOME: home };
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), ...args],
    { encoding: "utf8", env });
  const db = openHub(hubPathFor(home));
  // A gate-state row with no matching project is the H-4 case being hidden.
  db.prepare(`INSERT INTO repo_gate_state(repo_id, nwo_snapshot, ruleset_requires_check,
                                        app_installed, verified_at)
              VALUES(1,'o/orphan',1,'pass',unixepoch())`).run();
  db.close();

  const reg = join(home, "projects.json");
  const idsOf = out => { try { return JSON.parse(out.slice(out.indexOf("["))).map(f => f.id); } catch { return null; } };

  writeFileSync(reg, JSON.stringify({ prod: "bad" }));
  const bad = run("builder", "doctor", "--json");
  const badIds = idsOf(bad.stdout);
  check(badIds !== null, "control: builder doctor --json parsed", (bad.stdout + bad.stderr).slice(0, 200));
  check(badIds?.includes("H-7"),
    "a malformed registry entry is reported as a registry error", JSON.stringify(badIds));
  // THE EXACT ID, `H-4:o/orphan`. A prefix match is what a weak version of this
  // assertion looks like, and it passed against the old loader: measured, the
  // old behaviour emits `H-4:null` -- a finding about the malformed entry's
  // absent `nwo` -- while SUPPRESSING `H-4:o/orphan`, the row that actually
  // has unsafe authority. Both start with "H-4". Which finding, not whether one.
  check(badIds?.includes("H-4:o/orphan"),
    "and the authority finding it used to hide is reported, for the project it is about",
    JSON.stringify(badIds));
  check(!badIds?.includes("H-4:null"),
    "and not a finding about the malformed entry's missing name, which is what replaced it",
    JSON.stringify(badIds));

  // CONTROL: a WELL-FORMED registry is not reported as an error, so the
  // assertion above is about the malformed entry rather than about H-7 always
  // firing.
  writeFileSync(reg, JSON.stringify({ prod: { nwo: "o/orphan" } }));
  const good = run("builder", "doctor", "--json");
  const goodIds = idsOf(good.stdout);
  check(goodIds !== null && !goodIds.includes("H-7"),
    "control: a well-formed registry raises no registry error", JSON.stringify(goodIds));

  // And a top level that is not an object at all.
  writeFileSync(reg, JSON.stringify(["prod"]));
  const arr = run("builder", "doctor", "--json");
  check(/must be an object/.test(arr.stdout + arr.stderr) || idsOf(arr.stdout)?.includes("H-7"),
    "a registry that is an array is refused rather than read as empty",
    (arr.stdout + arr.stderr).slice(0, 240));
}

// ── a malformed recovery tail refuses; it does not throw a stack trace ─────
// A partial copy is the likeliest damage to a recovery tail -- it is the case
// the manifest check exists to diagnose -- and a file that stopped mid-line got
// there first, as an uncaught SyntaxError, from the one command an operator runs
// when the hub is already gone.
{
  const home = join(dir, "badtail-home");
  mkdirSync(join(home, "state"), { recursive: true });
  const env = { ...process.env, REEVE_HOME: home };
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), ...args],
    { encoding: "utf8", env });
  openHub(hubPathFor(home)).close();
  const snap = run("backup", "--hub");
  check(snap.status === 0, "fixture: a snapshot exists to restore from", (snap.stdout + snap.stderr).slice(0, 160));

  const cut = join(home, "cut.jsonl");
  writeFileSync(cut, `{"seq":1,"at":1,"kind":"task.transitioned","task":null,"payload":"{}"}\n{"seq":2,"at":1,"kin`);
  const r = run("restore", "--hub", "--tail", cut, "--force");
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  check(r.status !== 0, "a tail that stops mid-line is refused", `status=${r.status}`);
  check(!/^\s+at .*:\d+:\d+$/m.test(out) && !/SyntaxError/.test(out),
    "and not with an uncaught stack trace", out.slice(0, 300));
  check(/line 2 of 2/.test(out), "and it names WHICH line, so the file can be inspected", out.slice(0, 300));
  check(/re-export it with reeve export-events --hub/.test(out),
    "and says how to get a good one", out.slice(0, 300));

  // CONTROL: a well-formed tail gets past the parse and is judged on its merits.
  const okTail = join(home, "ok.jsonl");
  writeFileSync(okTail, `{"seq":1,"at":1,"kind":"task.transitioned","task":null,"payload":"{}"}\n{"_manifest":{"count":1,"first":1,"last":1,"sha256":"x"}}\n`);
  const ok = run("restore", "--hub", "--tail", okTail, "--force");
  const okOut = (ok.stdout ?? "") + (ok.stderr ?? "");
  check(!/could not be parsed/.test(okOut),
    "control: a parseable tail reaches the manifest checks instead", okOut.slice(0, 240));
}

// ── NO hub route answers a broken hub with a stack trace ──────────────────
// The version-zero sweep above covers ONE broken state. Sites six and seven were
// found in a different one -- an UNREADABLE hub -- because that sweep was a list
// of routes against a single fixture rather than a matrix.
//
//   build status  ->  Error: file is not a database   at bin/reeve:1109
//   build run     ->  Error: file is not a database   at openHub (hubdb.mjs:72)
//
// Both live on main when this was written, and both are the two commands an
// operator reaches for WHEN SOMETHING IS ALREADY WRONG. Six earlier findings of
// this class were each fixed at the site reported, and each declared it swept.
//
// So the assertion is the MATRIX, and it is the thing that fails when an eighth
// site appears rather than a reviewer noticing.
{
  const mHome = join(dir, "matrix-home");
  const env = { ...process.env, REEVE_HOME: mHome };
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), ...args],
    { encoding: "utf8", env });

  // The broken states a hub can actually be in, each built the way it really
  // arises. `build run` is excluded from the matrix and driven separately below:
  // it is a heartbeat LOOP, and a route that does not exit cannot be in a table
  // of exit codes.
  const STATES = {
    absent:     () => { rmSync(join(mHome, "state"), { recursive: true, force: true }); mkdirSync(join(mHome, "state"), { recursive: true }); },
    versionZero: () => { const d = new DatabaseSync(hubPathFor(mHome));
                         d.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT`);
                         d.close(); },
    unreadable: () => writeFileSync(hubPathFor(mHome), "this is not a database"),
    truncated:  () => { const d = openHub(hubPathFor(mHome)); d.close();
                        const buf = readFileSync(hubPathFor(mHome));
                        writeFileSync(hubPathFor(mHome), buf.subarray(0, Math.floor(buf.length / 3))); },
  };
  const ROUTES = [
    ["builder", "doctor"],
    ["builder", "doctor", "--json"],
    ["build", "status"],
    ["export-events", "--hub", join(mHome, "tail.jsonl")],
    ["backup", "--hub"],
    ["restore", "--hub"],
  ];
  check(Object.keys(STATES).length >= 4 && ROUTES.length >= 6,
    "control: the matrix covers every broken state against every hub route",
    `${Object.keys(STATES).length} states x ${ROUTES.length} routes`);

  const crashed = [];
  let cells = 0;
  for (const [state, build] of Object.entries(STATES)) {
    rmSync(mHome, { recursive: true, force: true });
    mkdirSync(join(mHome, "state"), { recursive: true });
    build();
    for (const args of ROUTES) {
      cells++;
      const r = run(...args);
      const out = (r.stdout ?? "") + (r.stderr ?? "");
      // A Node stack frame, by its own shape: `    at <thing> (<file>:<line>:<col>)`
      // or the bare `    at <file>:<line>:<col>` form.
      if (/^\s+at\s+.*:\d+:\d+\)?$/m.test(out))
        crashed.push(`${state}/${args.join(" ")}: ${out.split("\n").find(l => /Error/.test(l))?.trim() ?? "(stack)"}`);
    }
  }
  check(cells === Object.keys(STATES).length * ROUTES.length,
    "control: every cell of the matrix ran", `${cells} cells`);
  check(crashed.length === 0,
    "no hub route answers a broken hub with a stack trace",
    crashed.slice(0, 4).join("  |  "));

  // And an unreadable hub is a FAULT, not "no builder is running". Before the
  // guard the uncaught throw exited 1; catching it and breaking like the other
  // not-running cases would have turned a loud failure into a quiet success.
  rmSync(mHome, { recursive: true, force: true });
  mkdirSync(join(mHome, "state"), { recursive: true });
  STATES.unreadable();
  const bad = run("build", "status");
  check(bad.status === 1, "`build status` exits 1 on an unreadable hub, not 0", `status=${bad.status}`);
  check(/cannot be read/.test(bad.stdout + bad.stderr),
    "and says so in words", (bad.stdout + bad.stderr).slice(0, 160));
  check(/reeve restore --hub --force/.test(bad.stdout + bad.stderr),
    "and names the way back", (bad.stdout + bad.stderr).slice(0, 200));

  // AND `build run`, which the matrix cannot hold. It is a heartbeat LOOP, so a
  // table of exit codes has no cell for it on a healthy hub -- which is exactly
  // why site seven hid there. On a BROKEN hub it must refuse and exit, and that
  // is testable: a `timeout` on the spawn turns "it hung" into a failure rather
  // than into a suite that never finishes.
  //
  // Site seven was `build run` dying inside `openHub` with a raw
  // `file is not a database`, because `bootstrapping` is
  // `completedVersion(...) === 0` and an UNREADABLE file answers 0 as well --
  // the same conflation between "no completed migration" and "cannot be read"
  // that `restoreHub` had, not carried across when that one was fixed.
  for (const [state, build] of [["unreadable", STATES.unreadable], ["truncated", STATES.truncated]]) {
    rmSync(mHome, { recursive: true, force: true });
    mkdirSync(join(mHome, "state"), { recursive: true });
    build();
    const r = spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), "build", "run"],
      { encoding: "utf8", env, timeout: 20_000 });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    check(r.signal !== "SIGTERM",
      `\`build run\` on a ${state} hub exits instead of entering the loop`, `signal=${r.signal}`);
    check(r.status !== 0, `and refuses (${state})`, `status=${r.status}`);
    check(!/^\s+at\s+.*:\d+:\d+\)?$/m.test(out),
      `and not with a stack trace (${state})`, out.split("\n").slice(0, 3).join(" | "));
    check(/cannot be read/.test(out), `and says the hub cannot be read (${state})`, out.slice(0, 160));
  }

  // CONTROL: a hub that is merely NOT RUNNING still exits 0, so the line above
  // is about the fault rather than about `build status` having become noisy.
  rmSync(mHome, { recursive: true, force: true });
  mkdirSync(join(mHome, "state"), { recursive: true });
  openHub(hubPathFor(mHome)).close();
  const ok = run("build", "status");
  check(ok.status === 0 && /not running/.test(ok.stdout),
    "control: a healthy hub with no builder still exits 0", `status=${ok.status} ${ok.stdout.slice(0, 60)}`);
}

// ── a hub that REFUSES A WRITE is not a hub that is damaged ───────────────
// `openHub`'s pragmas WRITE, and taking the builder lease writes, so both fail
// for reasons that have nothing to do with the file being broken. Measured
// against node:sqlite: NOTADB is errcode 26, CORRUPT 11, BUSY 5, READONLY 8.
// Calling all four corruption told an operator to RESTORE over a healthy
// authority database because someone else was reading it.
//
// The fixture is a BUSY hub, not a read-only one. chmod does nothing as root,
// which is ordinary in containerised CI: the mode bits would be inert, both
// `build run` children would enter the heartbeat loop until their timeouts, and
// these assertions would fail for the environment rather than the code. An
// exclusive transaction produces SQLITE_BUSY for any user.
{
  const bHome = join(dir, "busy-home");
  mkdirSync(join(bHome, "state"), { recursive: true });
  const env = { ...process.env, REEVE_HOME: bHome };
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), ...args],
    { encoding: "utf8", env, timeout: 30_000 });
  const hub = hubPathFor(bHome);
  { const d = openHub(hub); d.exec("PRAGMA journal_mode = DELETE"); d.close(); }

  const blocker = new DatabaseSync(hub, { timeout: 100 });
  blocker.exec("PRAGMA busy_timeout = 100");
  blocker.exec("BEGIN EXCLUSIVE");
  let outs;
  try {
    outs = { "build status": run("build", "status"), "build run": run("build", "run") };
  } finally { try { blocker.exec("ROLLBACK"); } catch { /* the close still frees it */ } blocker.close(); }

  for (const [label, r] of Object.entries(outs)) {
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    check(r.signal !== "SIGTERM", `\`${label}\` on a busy hub exits instead of hanging`, `signal=${r.signal}`);
    check(!/^\s+at\s+.*:\d+:\d+\)?$/m.test(out),
      `and not with a stack trace (${label})`, out.split("\n").slice(0, 3).join(" | "));
    // THE DECISIVE ONE: it must not point at replacing a database that is fine.
    check(!/reeve restore --hub/.test(out) || /Do NOT restore/.test(out),
      `and does not tell the operator to restore over a healthy hub (${label})`, out.slice(0, 300));
    check(/locked|not available|read-only|permissions/.test(out),
      `and names the actual cause (${label})`, out.slice(0, 200));
    // AND `build status` says UNKNOWN. A status that could not be READ is not a
    // reading of "not running" -- an exclusive transaction stops the command
    // before the singleton lease can be consulted, and a live builder's lease
    // may say otherwise. Asserted on the word, because "not running (… cannot be
    // read)" also mentions the cause and would satisfy the line above.
    if (label === "build status")
      check(/builder: UNKNOWN/.test(out),
        "and a status that could not be read is reported as UNKNOWN, not as not-running",
        out.split("\n")[0]);
  }

  // AND THE OTHER DIRECTION, which the first version of this got wrong: a
  // version-1 hub whose LOCK TABLE is gone answers the version probe, so the
  // lease write throws `no such table: maintenance_lock` -- errcode 1, which is
  // damage. Claiming "the hub reads fine, do NOT restore" there withholds the
  // one thing that recovers it.
  {
    rmSync(join(bHome, "state"), { recursive: true, force: true });
    mkdirSync(join(bHome, "state"), { recursive: true });
    { const d = openHub(hub); d.exec("DROP TABLE maintenance_lock"); d.close(); }
    const r = run("build", "run");
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    check(r.status !== 0, "a hub whose lock table is gone refuses", `status=${r.status}`);
    check(/reeve restore --hub --force/.test(out),
      "and IS told to restore, because a missing table is damage", out.slice(0, 260));
    check(!/Do NOT restore/.test(out),
      "and not told the opposite", out.slice(0, 260));
  }
}

// ── CONTROL: a genuinely CORRUPT hub still gets the restore advice ────────
// Without this, a fix that simply never recommends restoring satisfies every
// assertion in the block above.
{
  const cHome = join(dir, "corrupt-advice-home");
  mkdirSync(join(cHome, "state"), { recursive: true });
  const env = { ...process.env, REEVE_HOME: cHome };
  writeFileSync(hubPathFor(cHome), "this is not a database");
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), "build", "status"],
    { encoding: "utf8", env, timeout: 30_000 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  check(/reeve restore --hub --force/.test(out),
    "control: a corrupt hub IS told to restore", out.slice(0, 200));
  check(/--tail/.test(out),
    "and told to pass --tail, so the first recovery is not the lossy one", out.slice(0, 320));
  check(!/Do NOT restore/.test(out),
    "and not told the opposite", out.slice(0, 260));
}

// ── the classifier's edges, and the guard's reach ─────────────────────────
// The table itself first, because the CLI paths only exercise the codes they
// happen to produce: measured, forcing an errcode-less error to "damage" left
// every end-to-end assertion below green, because `build run` catches the
// restore-in-progress case by name before the classifier is consulted.
{
  const cases = [
    [{ errcode: 3 },  true,  "SQLITE_PERM"],
    [{ errcode: 5 },  true,  "SQLITE_BUSY"],
    [{ errcode: 6 },  true,  "SQLITE_LOCKED"],
    [{ errcode: 8 },  true,  "SQLITE_READONLY"],
    [{ errcode: 14 }, true,  "SQLITE_CANTOPEN"],
    [{ errcode: 11 }, false, "SQLITE_CORRUPT"],
    [{ errcode: 26 }, false, "SQLITE_NOTADB"],
    [{ errcode: 1 },  false, "SQLITE_ERROR (no such table)"],
    [{ errcode: 10 }, false, "SQLITE_IOERR — a failing device is not 'the file is fine'"],
    [new Error("a restore is in progress"), true, "reeve's own refusal, which carries no errcode"],
  ];
  const wrong = cases.filter(([e, want]) => isOperational(e) !== want).map(([, , name]) => name);
  check(wrong.length === 0,
    "every SQLite code is classified as damage or not on purpose, including CANTOPEN and errcode-less",
    wrong.join(", "));
  check(cases.filter(([, w]) => w).length >= 6 && cases.filter(([, w]) => !w).length >= 4,
    "control: the table covers both answers, so a constant-true or constant-false fails it",
    `${cases.filter(([, w]) => w).length} operational / ${cases.filter(([, w]) => !w).length} damage`);
}
{
  const eHome = join(dir, "edges-home");
  mkdirSync(join(eHome, "state"), { recursive: true });
  const env = { ...process.env, REEVE_HOME: eHome };
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), ...args],
    { encoding: "utf8", env, timeout: 30_000 });
  const hub = hubPathFor(eHome);

  // 1. CORRUPTION IN THE SCHEMA PAGE, not the header. All four pragmas succeed,
  // so the first version read threw OUTSIDE the guard and `build run` printed a
  // bare `database disk image is malformed` with none of the recovery this
  // guard exists to give. The guard has to reach as far as the first read that
  // can find damage, not stop at the first write.
  {
    rmSync(join(eHome, "state"), { recursive: true, force: true });
    mkdirSync(join(eHome, "state"), { recursive: true });
    { const d = openHub(hub); d.close(); }
    const meta = new DatabaseSync(hub, { readOnly: true });
    const page = meta.prepare("SELECT pageno FROM dbstat WHERE name='schema_version' ORDER BY pageno LIMIT 1").get();
    const ps = meta.prepare("PRAGMA page_size").get().page_size;
    meta.close();
    check(page != null && page.pageno > 1,
      "fixture: schema_version lives past the header page", `page ${page?.pageno}`);
    const buf = readFileSync(hub);
    buf.fill(0x5a, (page.pageno - 1) * ps, page.pageno * ps);
    writeFileSync(hub, buf);

    const r = run("build", "run");
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    check(r.status !== 0, "a hub corrupt in its schema page refuses", `status=${r.status}`);
    check(!/^\s+at\s+.*:\d+:\d+\)?$/m.test(out),
      "and not with a stack trace", out.split("\n").slice(0, 3).join(" | "));
    check(/restore --hub --force/.test(out),
      "and IS given the recovery, which it lost by throwing outside the guard", out.slice(0, 260));
    check(/--tail/.test(out), "including --tail", out.slice(0, 300));
  }

  // 2. AN EXPECTED REFUSAL IS AN ANSWER, not a storage failure. `assertWritable`
  // throws `a restore is in progress` deliberately, and that error carries no
  // SQLite errcode — so it was routed through the damage branch and a normal
  // concurrent `build run` was told its lock tables had failed and pointed at a
  // second forced restore. The correct advice is to WAIT.
  {
    rmSync(join(eHome, "state"), { recursive: true, force: true });
    mkdirSync(join(eHome, "state"), { recursive: true });
    { const d = openHub(hub); d.close(); }
    // A holder that is genuinely ALIVE: it takes the lock with its OWN pid and
    // lstart, so reeve's `isSameProcess` agrees it is running. A dead pid is
    // reaped by `assertWritable` and the refusal never fires — measured, on the
    // first attempt at this fixture.
    const holderSrc = join(eHome, "holder.mjs");
    writeFileSync(holderSrc, `
import { openHub } from ${JSON.stringify(pathToFileURL(join(ROOT, "src", "build", "hubdb.mjs")).href)};
import { acquireMaintenanceLock } from ${JSON.stringify(pathToFileURL(join(ROOT, "src", "build", "locks.mjs")).href)};
import { readStart, isSameProcess } from ${JSON.stringify(pathToFileURL(join(ROOT, "src", "supervisor.mjs")).href)};
const d = openHub(${JSON.stringify(hub)});
acquireMaintenanceLock(d, { pid: process.pid, lstart: readStart(process.pid), isAlive: isSameProcess });
d.close();
process.stderr.write("held\\n");
setTimeout(() => {}, 45000);
`);
    const holder = spawnSync(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const h = spawn(process.execPath, [${JSON.stringify(holderSrc)}], { stdio: ["ignore","ignore","pipe"], detached: true });
      h.stderr.once("data", () => { console.log(h.pid); h.unref(); process.exit(0); });
      setTimeout(() => { console.log(h.pid); process.exit(0); }, 8000);
    `], { encoding: "utf8", timeout: 15_000 });
    const holderPid = Number((holder.stdout ?? "").trim());
    try {
      const r = run("build", "run");
      const out = (r.stdout ?? "") + (r.stderr ?? "");
      check(r.status !== 0, "a concurrent build run is refused while a restore holds the lock", `status=${r.status}`);
      check(/restore is in progress/.test(out), "and told what is holding it", out.slice(0, 200));
      check(/wait for it to finish/.test(out),
        "and told to WAIT, which is the only correct action", out.slice(0, 240));
      check(!/permissions|restore --hub --force/.test(out),
        "and NOT sent at permissions or a second forced restore", out.slice(0, 300));
    } finally {
      if (Number.isFinite(holderPid) && holderPid > 0) { try { process.kill(holderPid, "SIGKILL"); } catch { /* already gone */ } }
    }
  }
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
