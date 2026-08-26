// The guardian's hub connection answers THREE ways, and the difference between
// them is what decides whether model work runs scheduled.
//
// This file exists because the logic lived in `bin/reeve`, where the only
// assertions available were structural -- and a stub loop proved what that was
// worth: disabling the schema gate with `if (false && ...)` left the source text
// intact and every assertion green. The property was asserted and untested at
// the same time. It is exercised here instead.
import { hubAccess } from "../src/build/hubaccess.mjs";
import { openHub, SCHEDULER_MIN_HUB_VERSION } from "../src/build/hubdb.mjs";
import { mkdtempSync, rmSync, writeFileSync, renameSync, copyFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-hubaccess-"));

// ── absent is an ORDINARY state ───────────────────────────────────────────
// A guardian can run on a machine with no builder. That must not read as a
// fault, or every such machine escalates for ever.
{
  const a = hubAccess(join(dir, "nope.db"))();
  check(a.hub === null && a.why === null,
    "an absent hub is no hub and no complaint", JSON.stringify(a));
}

// ── a healthy hub opens, and opens RESTRICTED ─────────────────────────────
{
  const p = join(dir, "good.db");
  openHub(p).close();
  const get = hubAccess(p);
  const a = get();
  check(a.hub != null && a.why === null, "a current hub opens", JSON.stringify({ why: a.why }));
  // It is the GUEST: the allowlist refuses the builder's work table.
  let why = null;
  try { a.hub.prepare("SELECT 1 FROM task"); } catch (err) { why = err.message; }
  check(why != null && /not authorized|prohibited|not permitted/i.test(why),
    "and it is the restricted connection, not a privileged one", String(why));
  // The same handle comes back while the file is unchanged, or every call would
  // pay a reopen.
  check(get().hub === a.hub, "the handle is reused while the file is unchanged");
  a.hub.close();
}

// ── a hub BELOW the scheduler's floor is refused, WITH a reason ───────────
// Every claim names `provider_lease.token`, which arrives with migration 3. On
// an older hub each claim throws, and the guardian's fail-open path then runs
// model work outside the shared limit -- beside an older builder still using its
// own. Passing this off as an absent hub is the dangerous answer.
{
  const p = join(dir, "old.db");
  openHub(p).close();
  // Wind the recorded version back: the tables are current, the STATED version
  // is not, which is exactly the shape a newer guardian meets beside an older
  // builder.
  const w = new DatabaseSync(p);
  w.exec(`DELETE FROM schema_version WHERE version >= ${SCHEDULER_MIN_HUB_VERSION}`);
  w.close();
  const a = hubAccess(p)();
  check(a.hub === null, "a hub below the scheduler's floor does NOT open for dispatch", JSON.stringify(a));
  check(typeof a.why === "string" && a.why.length > 0,
    "and it says so rather than passing as absent — silence here is unscheduled work", JSON.stringify(a));
  check(/schema version/.test(a.why ?? "") && new RegExp(String(SCHEDULER_MIN_HUB_VERSION)).test(a.why ?? ""),
    "naming the version it found and the one it needs", String(a.why));

  // CONTROL: the same file at the current version DOES open, or this check has
  // become "refuse everything" and no guardian could ever schedule.
  const q = join(dir, "old-control.db");
  openHub(q).close();
  check(hubAccess(q)().hub != null, "control: the same store at the current version still opens");
}

// ── an existing hub that cannot be READ is a fault, not an absence ────────
{
  const p = join(dir, "corrupt.db");
  writeFileSync(p, "this is not a sqlite database at all, but it does exist");
  const a = hubAccess(p)();
  check(a.hub === null && typeof a.why === "string",
    "a corrupt hub is refused WITH a reason", JSON.stringify(a));
  check(/could not be read/.test(a.why ?? ""),
    "and the reason says the read failed, not that nothing was there", String(a.why));
}

// ── a restore replaces the file, and the connection follows it ────────────
// `restoreHub` renames a new database over the old path. A handle opened before
// that keeps its descriptor on the UNLINKED inode -- so the guardian would go on
// scheduling in a database nobody else can see while the builder used the new
// one, and both would admit up to the global limit.
{
  const p = join(dir, "restored.db");
  openHub(p).close();
  const get = hubAccess(p);
  const first = get();
  check(first.hub != null, "fixture: the connection is open before the restore");
  // A DIFFERENT inode at the same path, which is what a rename installs.
  const replacement = join(dir, "replacement.db");
  openHub(replacement).close();
  renameSync(replacement, p);
  const second = get();
  check(second.hub != null && second.hub !== first.hub,
    "the connection is REOPENED after the file is replaced, not reused",
    JSON.stringify({ same: second.hub === first.hub, why: second.why }));
  second.hub.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
