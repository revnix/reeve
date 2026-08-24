// Doctor classifies rather than lists, because "16 things are wrong" is not a
// report anyone acts on: a configuration error is fixed, a dependency outage is
// waited out, stale evidence is refreshed, and unsafe authority is the only one
// that should stop a merge.
//
// It also must not write repo_gate_state. A reporter that can write what it
// reports can agree with itself, and the row exists precisely so that clause U4
// reads something the LOOP established.
import { openHub } from "../src/build/hubdb.mjs";
import { hubFindings, renderHub } from "../src/doctor.mjs";
// The self-audit block at the end of this task needs all of these. The standard
// harness supplies only check, dir, join, tmpdir, mkdtempSync and rmSync.
import { selfAudit, BROKEN } from "../src/selfaudit.mjs";
import { open as openStore } from "../src/db/ops.mjs";
import { hubPathFor } from "../src/paths.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";   // the CLI drill runs bin/reeve
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
