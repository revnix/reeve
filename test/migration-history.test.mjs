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
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openHub, completedVersion, missingMigrations, HUB_SCHEMA_VERSION } from "../src/build/hubdb.mjs";

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

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
