// The guardian scopes every provider_lease on GitHub's numeric repository id,
// and it deliberately cannot read `task` -- that is the builder's work table and
// the widening the guest allowlist exists to refuse. So the id used to reach it
// through a privileged handle opened in the CLI and closed after one statement,
// which made the guarantee "the tick is restricted" rather than "the guardian
// process is".
//
// This file's central assertion is the one that makes that possible: the GUEST
// connection can read the identity. A test that only checked the table's
// contents through a privileged handle would pass just as well against a table
// the guardian still cannot see, which is the entire defect.
//
// WHAT IT DOES NOT PROVE, stated because the gap is easy to read past. It opens
// the guest connection itself. Production does not yet: `bin/reeve` resolves the
// id through `resolveRepoIdAt`, whose default opener is an unrestricted
// read-only handle, and the daemon resolves outside its hub session. So this
// establishes that the guardian CAN read the identity through its restricted
// surface, not that it DOES. Routing the production read -- and deleting the
// privileged one -- is the second half of issue #46, and until it lands the
// process-level reduction is available rather than applied.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHub, HUB_SCHEMA_VERSION, backfillProjectIdentities,
         identityReconciliation } from "../src/build/hubdb.mjs";
import { openHubAsGuest, ALLOWED } from "../src/build/hubguest.mjs";
import { hubAccess } from "../src/build/hubaccess.mjs";
import { repoIdFromHub, IDENTITY_SINCE } from "../src/build/repoid.mjs";
import { replayableKinds, COMPARISON_SET } from "../src/build/replay.mjs";
import { TABLE_OWNERS, PROSE_TABLES } from "../src/build/tables.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const refuses = (fn, re, name) => {
  let msg = null;
  try { fn(); } catch (e) { msg = e.message; }
  if (msg === null) return check(false, name, "did not throw at all");
  check(re.test(msg), name, re.test(msg) ? null : `threw, but for the wrong reason: ${msg}`);
};

const dir = mkdtempSync(join(tmpdir(), "reeve-identity-"));
const path = join(dir, "hub.db");

try {
  const db = openHub(path);
  check(db.prepare(
    `SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='project_identity'`).get().c === 1,
    `migration ${HUB_SCHEMA_VERSION} creates project_identity`);

  db.prepare(`INSERT INTO project_identity(project, repo_id, learned_at) VALUES(?,?,?)`)
    .run("o/r", 4242, 100);
  check(repoIdFromHub(db, { name: "o/r" }) === 4242,
    "control: the resolver reads the identity through a full connection");
  check(repoIdFromHub(db, { name: "never-admitted" }) === null,
    "and a project with no identity is null, which is an ordinary state and not an error");

  // ---- THE POINT OF THE CHANGE. Anything below that passes through the full
  // connection would pass equally against a table the guardian cannot see.
  db.close();
  const guest = openHubAsGuest(path);
  // GUARDED, because a refused read THROWS. Called bare, the assertion below
  // would not merely fail when the grant is missing -- it would abort the file,
  // and the fourteen assertions after it would go unmeasured while reading in a
  // log exactly like fourteen passes. That is the state this test is stubbed
  // into, so the guard is what lets the stub prove anything at all.
  let guestId = null, guestErr = null;
  try { guestId = repoIdFromHub(guest, { name: "o/r" }); }
  catch (e) { guestErr = e.message; }
  check(guestId === 4242,
    "THE GUARDIAN'S RESTRICTED CONNECTION CAN READ THE IDENTITY",
    guestErr ?? String(guestId));
  check(ALLOWED.project_identity?.length === 1 && ALLOWED.project_identity[0] === "read",
    "and the grant is READ ONLY -- the guardian never writes an identity",
    JSON.stringify(ALLOWED.project_identity));
  // The refusals that make that grant mean something. A connection allowed to
  // read everything would satisfy the assertion above while granting nothing.
  refuses(() => guest.prepare(`SELECT repo_id FROM task LIMIT 1`).get(),
    /not authoriz|denied|no such|prohibit/i,
    "control: the same connection is still refused `task`, so the grant is narrow");
  refuses(() => guest.prepare(
    `INSERT INTO project_identity(project, repo_id, learned_at) VALUES('x',1,1)`).run(),
    /not authoriz|denied|readonly|prohibit/i,
    "control: and refused a WRITE to the identity it may read");
  guest.close();

  // ---- the registrations a new table owes, each of which has refused a table
  // that skipped it
  check(TABLE_OWNERS.project_identity?.replayed === true,
    "the owners entry declares it replayed", JSON.stringify(TABLE_OWNERS.project_identity));
  check(PROSE_TABLES.includes("project_identity"), "the prose names it");
  check(replayableKinds().includes("project_identity.learned"),
    "a replay handler exists, so an identity learned after the last snapshot survives a restore");
  check(COMPARISON_SET.includes("project_identity"),
    "and the restore drill compares it, so the handler is proven rather than merely registered");

  // ---- THE RECONCILIATION restoreHub runs after replaying a legacy tail.
  //
  // Migration 5 runs BEFORE the replay, so it sees only the tasks inside the
  // snapshot. A tail written by a pre-v5 binary carries `task.filed` and no
  // `project_identity.learned`, so a project admitted since that snapshot comes
  // back with its task and without its identity -- and the restore reports
  // success while the guardian cannot scope a provider lease for it.
  {
    const r = openHub(join(dir, "reconcile.db"));
    const cols = r.prepare(`SELECT name, type, "notnull" nn, dflt_value d FROM pragma_table_info('task')`).all();
    const ddl = r.prepare(`SELECT sql FROM sqlite_master WHERE name='task'`).get().sql;
    // Allowed values read from the table's own DDL rather than transcribed, so
    // this fixture does not carry a second copy of task's constraints.
    const allowed = {};
    for (const m of ddl.matchAll(/(\w+)\s+IN\s*\(([^)]*)\)/g)) {
      const vals = [...m[2].matchAll(/'([^']*)'/g)].map(x => x[1]);
      if (vals.length) allowed[m[1]] = vals[0];
    }
    const task = (over) => {
      const row = {};
      for (const c of cols) {
        if (c.name in over) { row[c.name] = over[c.name]; continue; }
        if (!c.nn || c.d !== null) continue;
        row[c.name] = c.name in allowed ? allowed[c.name] : (c.type === "INTEGER" ? 1 : "x");
      }
      const k = Object.keys(row);
      r.prepare(`INSERT INTO task(${k.join(",")}) VALUES(${k.map(() => "?").join(",")})`).run(...k.map(x => row[x]));
    };
    task({ id: "r1", project: "replayed", repo_id: 555, updated_at: 10, source_key: "s1" });
    r.prepare(`DELETE FROM project_identity`).run();
    check(r.prepare(`SELECT count(*) c FROM project_identity`).get().c === 0,
      "fixture: a replayed task with no identity, which is what a legacy tail leaves");

    backfillProjectIdentities(r);
    check(r.prepare(`SELECT repo_id FROM project_identity WHERE project='replayed'`).get()?.repo_id === 555,
      "the reconciliation derives the missing identity from the task that carries it");

    // AN UPSERT, not a fill. A legacy tail can carry a repository recreated
    // under the same key, and the newest task is the only record of the new id;
    // filling gaps only would leave the old one standing and every lease
    // scoped to a repository that no longer exists.
    task({ id: "r2", project: "replayed", repo_id: 666, updated_at: 20, source_key: "s2" });
    backfillProjectIdentities(r);
    check(r.prepare(`SELECT repo_id FROM project_identity WHERE project='replayed'`).get()?.repo_id === 666,
      "and a newer task's id REPLACES an older identity, because the newest admission saw the repository");
    check(r.prepare(`SELECT count(*) c FROM project_identity WHERE project='replayed'`).get().c === 1,
      "control: still one row, so the upsert replaced rather than accumulated");
    r.close();
  }

  // ---- WHICH PROJECTS A TAIL LEAVES UNRECONCILED.
  //
  // This existed inline in restoreHub and was WRONG in a way no test could
  // reach: it read `payload.project` off a `task.transitioned` image, and that
  // image carries an explicit column list with no `project` in it. The set was
  // always empty, the reconciliation never ran, and every test passed.
  {
    const ev = (kind, payload, task = null) => ({ kind, task, payload: JSON.stringify(payload) });
    // A TRANSITION IMAGE, shaped as transition.mjs actually emits one: id,
    // repo_id and the rest -- and no `project`. This is the fixture that makes
    // the assertion below mean something.
    const transition = ev("task.transitioned", { id: "bt:9", repo_id: 777, updated_at: 3 }, "bt:9");
    check(!("project" in JSON.parse(transition.payload)),
      "fixture: a transition image genuinely carries no project, which is why the id must resolve it");

    const byId = (id) => (id === "bt:9" ? "rebound-project" : null);
    const r = identityReconciliation([transition], byId);
    check(r.changed.includes("rebound-project"),
      "a legacy adoption is found by resolving the event's task id, not by reading a project it never had",
      JSON.stringify(r));
    check(r.admitted.length === 0,
      "and it is NOT treated as an admission, so no identity is created for it", JSON.stringify(r));

    // A FILING is the other half, and it may create.
    const filing = ev("task.filed", { id: "bt:10", project: "admitted-project", repo_id: 888 }, "bt:10");
    const r2 = identityReconciliation([filing], byId);
    check(r2.admitted.includes("admitted-project") && r2.changed.length === 0,
      "a filing is an admission and may create an identity", JSON.stringify(r2));

    // CARRIED wins over both: a tail that already brought the identity needs no
    // repair, and repairing anyway would overwrite what the tail restored.
    const carried = ev("project_identity.learned", { project: "admitted-project", repo_id: 888 }, "bt:10");
    const r3 = identityReconciliation([filing, carried], byId);
    check(r3.admitted.length === 0 && r3.changed.length === 0,
      "control: a tail that carried the identity needs no reconciliation at all", JSON.stringify(r3));

    // And the MIXED tail the second review round was about: one project filed
    // before the upgrade, another filed after with its identity. A tail-wide
    // test called this modern and skipped the first.
    const other = ev("task.filed", { id: "bt:11", project: "pre-upgrade", repo_id: 999 }, "bt:11");
    const r4 = identityReconciliation([other, filing, carried], byId);
    check(r4.admitted.length === 1 && r4.admitted[0] === "pre-upgrade",
      "a tail SPANNING the upgrade still repairs the project whose identity it did not carry",
      JSON.stringify(r4));
  }

  // ---- A PRE-v5 HUB IS STILL USABLE. Adding the table to ALLOWED puts it in
  // the guardian's schema gate, and an unconditional scan reported it missing on
  // a v3 or v4 store -- so hubAccess returned no hub at all and the guardian was
  // refused outright, taking away the very compatibility the lookup provides.
  // SCHEDULER_MIN_HUB_VERSION is 3, so those versions are supported by design.
  {
    const p4 = join(dir, "v4.db");
    const h = openHub(p4);
    h.exec("PRAGMA foreign_keys = OFF");
    h.exec("DROP TABLE project_identity");
    h.prepare("DELETE FROM schema_version WHERE version >= ?").run(IDENTITY_SINCE);
    h.close();
    const acc = hubAccess(p4, { isAlive: () => true });
    check(acc.hub !== null, "a hub below the identity migration is still usable by the guardian",
      String(acc.why));
    try { acc.hub?.close?.(); } catch { /* the shape varies; the assertion is about `why` */ }
    check(!/project_identity is missing/.test(acc.why ?? ""),
      "and the absent table is not reported as a defect at that version", String(acc.why));
  }

  // ---- THE SCOPED BACKFILL, which is what makes a mixed-version tail work.
  // A tail can span the upgrade: a pre-v5 filing, then a post-v5 filing carrying
  // its own identity event. A tail-WIDE test sees an identity event, calls the
  // whole tail modern and skips the repair, leaving the earlier project with a
  // task and no identity. So the restore names the projects that need it.
  {
    const r2 = openHub(join(dir, "scoped.db"));
    const mk = (id, proj, rid, key) => {
      const cols = r2.prepare(`SELECT name, type, "notnull" nn, dflt_value d FROM pragma_table_info('task')`).all();
      const ddl = r2.prepare(`SELECT sql FROM sqlite_master WHERE name='task'`).get().sql;
      const allowed = {};
      for (const m of ddl.matchAll(/(\w+)\s+IN\s*\(([^)]*)\)/g)) {
        const vals = [...m[2].matchAll(/'([^']*)'/g)].map(x => x[1]);
        if (vals.length) allowed[m[1]] = vals[0];
      }
      const row = { id, project: proj, repo_id: rid, source_key: key, updated_at: 1 };
      for (const c of cols) {
        if (c.name in row) continue;
        if (!c.nn || c.d !== null) continue;
        row[c.name] = c.name in allowed ? allowed[c.name] : (c.type === "INTEGER" ? 1 : "x");
      }
      const k = Object.keys(row);
      r2.prepare(`INSERT INTO task(${k.join(",")}) VALUES(${k.map(() => "?").join(",")})`).run(...k.map(x => row[x]));
    };
    mk("s1", "needs-it", 111, "k1");
    mk("s2", "leave-alone", 222, "k2");
    r2.prepare(`DELETE FROM project_identity`).run();
    backfillProjectIdentities(r2, ["needs-it"]);
    check(r2.prepare(`SELECT repo_id FROM project_identity WHERE project='needs-it'`).get()?.repo_id === 111,
      "a scoped reconciliation repairs the project it names");
    check(r2.prepare(`SELECT count(*) c FROM project_identity WHERE project='leave-alone'`).get().c === 0,
      "and leaves every project it does not, so a restore adds no row the snapshot never held");
    // An empty list is not "all". Reading it as all is how a scoped repair
    // becomes the global one it was narrowed away from.
    backfillProjectIdentities(r2, []);
    check(r2.prepare(`SELECT count(*) c FROM project_identity`).get().c === 1,
      "control: an EMPTY list repairs nothing, rather than everything");

    // UPDATE-ONLY, for a project the tail CHANGED rather than admitted. A legacy
    // `adopt-snapshot` moves task.repo_id and rides on `task.transitioned`, so
    // it never appears among filings -- but a project with no identity is not a
    // gap this may fill, because it was never admitted under this schema and
    // creating one adds a row the snapshot never held.
    backfillProjectIdentities(r2, ["leave-alone"], { updateOnly: true });
    check(r2.prepare(`SELECT count(*) c FROM project_identity WHERE project='leave-alone'`).get().c === 0,
      "update-only creates nothing for a project that has no identity");
    // And it DOES move one that exists and disagrees, which is the adoption case.
    r2.prepare(`UPDATE task SET repo_id = 999 WHERE project = 'needs-it'`).run();
    backfillProjectIdentities(r2, ["needs-it"], { updateOnly: true });
    check(r2.prepare(`SELECT repo_id FROM project_identity WHERE project='needs-it'`).get()?.repo_id === 999,
      "and it DOES move an existing identity whose task now names a different repository");
    r2.close();
  }

  // ---- the schema refuses what the writer would, because the writer is not the
  // only way in and a wrong id mis-scopes every lease the guardian takes
  const db2 = openHub(path);
  const direct = (sql) => { let m = null; try { db2.prepare(sql).run(); } catch (e) { m = e.message; } return m; };
  check(direct(`INSERT INTO project_identity VALUES('a',0,1)`) !== null,
    "the table refuses a zero repository id -- zero is not an id");
  check(direct(`INSERT INTO project_identity VALUES('b',-1,1)`) !== null, "and a negative one");
  check(direct(`INSERT INTO project_identity VALUES('',1,1)`) !== null, "and an empty project key");
  check(direct(`INSERT INTO project_identity VALUES('c',1,0)`) !== null, "and a non-positive learned_at");
  check(direct(`INSERT INTO project_identity VALUES('d',777,1)`) === null,
    "control: the same insert succeeds when every value is valid");
  // ONE ROW PER PROJECT. The previous lookup ordered tasks and took the newest;
  // this replaces that ordering with a key, so the ordering cannot be got wrong.
  check(direct(`INSERT INTO project_identity VALUES('d',888,2)`) !== null,
    "a project cannot hold two identities at once");
  db2.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
