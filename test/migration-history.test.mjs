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
import { openHub, completedVersion, missingMigrations, HUB_SCHEMA_VERSION } from "../src/build/hubdb.mjs";
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
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
