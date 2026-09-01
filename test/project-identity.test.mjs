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
import { openHub, HUB_SCHEMA_VERSION, backfillProjectIdentities } from "../src/build/hubdb.mjs";
import { openHubAsGuest, ALLOWED } from "../src/build/hubguest.mjs";
import { repoIdFromHub } from "../src/build/repoid.mjs";
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
