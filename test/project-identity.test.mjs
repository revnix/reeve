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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHub, HUB_SCHEMA_VERSION } from "../src/build/hubdb.mjs";
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
