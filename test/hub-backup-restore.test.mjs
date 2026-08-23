// everyStore walks state/<owner>/<repo>.db and skips non-directories. The hub
// is a FILE directly in state/, so before this change backup could not see it
// at all -- the same shape as the measured miss where reeve's own store had
// zero backups and the repo it watched had fourteen. A store that nothing
// reminds you about is exactly the one that is not backed up.
// `snapshot` itself, not only `snapshotAll`: the exclusive-publish assertions
// below call it twice at one timestamp, which is the only way to observe the
// winner/loser split from a single process.
import { snapshot, everyStore, snapshotAll, latestSnapshot, validateSnapshot } from "../src/backup.mjs";
import { open as openStore } from "../src/db/ops.mjs";      // builds the real guardian fixture
import { readFileSync } from "node:fs";                      // reads the durable tail back
import { openHub, HUB_SCHEMA_VERSION } from "../src/build/hubdb.mjs";
import { hubPathFor } from "../src/paths.mjs";
import { DatabaseSync } from "node:sqlite";
// `statSync` reads the inode, which is what tells `link` and `rename` apart.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const home = mkdtempSync(join(tmpdir(), "reeve-home-"));
const root = join(home, "backups");
mkdirSync(join(home, "state", "nextlyhq"), { recursive: true });

// A REAL guardian store, created through the guardian's own open(), not an empty
// SQLite file: the repo validator requires the `event` table, so a bare file
// would be classified unusable, its snapshot deleted, and the retention
// assertions below would fail against a perfectly correct implementation.
openStore(join(home, "state", "nextlyhq", "nextly.db")).close();
openHub(hubPathFor(home)).close();

// ── discovery ────────────────────────────────────────────────────────────────
{
  const stores = everyStore(home);
  const hub = stores.find(s => s.kind === "hub");
  check(!!hub, "everyStore finds the hub", JSON.stringify(stores));
  check(hub?.nwo === "hub", "and labels it 'hub', not an owner/repo pair", String(hub?.nwo));
  check(hub?.path === hubPathFor(home), "at the one path hubPathFor derives", String(hub?.path));
  check(stores.some(s => s.nwo === "nextlyhq/nextly" && s.kind === "repo"),
    "control: the per-repo stores are still discovered", JSON.stringify(stores.map(s => s.nwo)));
  check(stores.filter(s => s.kind === "hub").length === 1, "and the hub appears exactly once");
}

// ── a snapshot is validated before it is trusted ─────────────────────────────
{
  const res = snapshotAll(home, root);
  const hubRes = res.find(r => r.nwo === "hub");
  check(hubRes?.ok === true, "the hub is snapshotted", JSON.stringify(hubRes));
  const snap = latestSnapshot(root, "hub");
  check(!!snap && existsSync(snap), "and the snapshot file exists", String(snap));

  const v = validateSnapshot(snap, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION });
  check(v.ok === true, "a good snapshot validates", JSON.stringify(v));
  // The regression that would otherwise delete every guardian backup on the box.
  const repoSnap = latestSnapshot(root, "nextlyhq/nextly");
  check(validateSnapshot(repoSnap, { kind: "repo" }).ok === true,
    "a per-repository guardian snapshot validates against its OWN marker, not the hub's",
    JSON.stringify(validateSnapshot(repoSnap, { kind: "repo" })));
  check(res.find(r => r.nwo === "nextlyhq/nextly")?.ok === true,
    "and snapshotAll keeps it rather than deleting it as unusable");
  check(v.version === HUB_SCHEMA_VERSION, "and reports the schema version it holds", String(v.version));
  // DEEP, because this line asserts an integrity result and the cheap path does
  // not produce one -- it returns `integrity: null` by design, since skipping
  // the full page scan is the entire point of the split. Asserting it from a
  // cheap call fails against the correct implementation.
  const deepV = validateSnapshot(snap, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION, deep: true });
  check(deepV.integrity === "ok", "and a DEEP validation reports its integrity_check result", String(deepV.integrity));
  check(v.integrity === null,
    "control: the cheap path deliberately reports no integrity at all, rather than a stale 'ok'",
    String(v.integrity));
}

// ── a snapshot at the wrong version is not restorable ────────────────────────
{
  const snap = latestSnapshot(root, "hub");
  const other = snap.replace(/(\d+)\.db$/, (_, n) => `${Number(n) - 1}.db`);
  const d = new DatabaseSync(snap);
  d.exec(`VACUUM INTO '${other.replace(/'/g, "''")}'`);
  d.close();
  const raw = new DatabaseSync(other);
  raw.exec("DELETE FROM schema_version");
  raw.exec(`INSERT INTO schema_version(version, applied_at) VALUES(${HUB_SCHEMA_VERSION + 1}, unixepoch())`);
  raw.close();
  const v = validateSnapshot(other, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION });
  check(v.ok === false, "a snapshot from a NEWER schema does not validate against this binary");
  check(String(v.why).includes(String(HUB_SCHEMA_VERSION + 1)), "and says which version it holds", String(v.why));
}

// ── a corrupt snapshot is deleted, not left looking usable ───────────────────
{
  const corruptDir = join(root, "hub");
  // Snapshot filenames are unix-epoch SECONDS and latestSnapshot sorts numerically
  // descending, so 999999.db (1970) is far OLDER than the good snapshot taken a
  // moment ago -- the assertion below would pass without anything ever being
  // deleted. The corrupt file has to be the newest candidate to be a test.
  const newest = Math.floor(Date.now() / 1000) + 60;
  const path = join(corruptDir, `${newest}.db`);
  writeFileSync(path, "this is not a database");
  // The control is a FILESYSTEM fact, deliberately, not a latestSnapshot() call.
  // Asserting `latestSnapshot(...) === path` here would contradict the assertion
  // below it in the same block with no code in between, so one of the two could
  // never be green -- and the read path is the very thing Step 3 changes.
  const candidates = readdirSync(corruptDir).filter(f => /^\d+\.db$/.test(f))
    .sort((a, b) => Number(b.split(".")[0]) - Number(a.split(".")[0]));
  check(candidates[0] === `${newest}.db`,
    "control: the corrupt file IS the newest candidate on disk, so skipping it is observable",
    JSON.stringify(candidates.slice(0, 3)));
  const v = validateSnapshot(path, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION });
  check(v.ok === false, "a file that is not a database does not validate");
  // The deletion is snapshotAll's job, so the test has to RUN snapshotAll.
  // Calling validateSnapshot alone leaves the corrupt file in place and the
  // assertion below passes for the wrong reason -- it never exercised the
  // code that is supposed to remove it.
  // snapshotAll only validates the snapshot IT takes this second, so a corrupt
  // file planted at a future timestamp is never its candidate and is never
  // deleted. What actually protects a restore is the READ path: latestSnapshot
  // must not hand back a file that fails validation. Step 3 changes it to skip
  // candidates that do not validate instead of trusting the filename, which is
  // what these three assertions are about.
  // An invalid snapshot must not cost a retention slot. Before this change
  // `snapshot()` pruned on the way out, so each failed backup evicted the
  // oldest GOOD one and then deleted itself -- a run of failures erasing every
  // recovery point while each looked self-contained.
  {
    const hubDir = join(root, "hub");
    const kept = () => readdirSync(hubDir).filter(f => /^\d+\.db$/.test(f)).length;
    const goodBefore = kept();
    // Force a failing validation by snapshotting a hub that is not one.
    const notAHub = join(home, "state", "notahub.db");
    openStore(notAHub).close();                      // a REPO store, so hub validation fails
    const r = snapshotAll(home, root, { at: Math.floor(Date.now() / 1000) + 5, keep: 1,
                                        open: () => new DatabaseSync(notAHub) });
    check(r.some(x => x.nwo === "hub" && x.ok === false),
      "a hub snapshot that fails validation is reported as failed", JSON.stringify(r));
    check(kept() === goodBefore,
      "and costs no retention slot: the good snapshots that existed before it are all still there",
      `${goodBefore} -> ${kept()}`);
  }

  const before = latestSnapshot(root, "hub");
  check(before !== path,
    "latestSnapshot never returns a candidate that fails validation, whatever its timestamp",
    `returned ${before}`);
  check(validateSnapshot(path, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION }).ok === false,
    "control: the planted file really is invalid, so the assertion above is not vacuous");
  // and it falls THROUGH to a good one rather than giving up. Without this line
  // a `latestSnapshot` "fixed" by returning null whenever anything is wrong
  // passes the assertion above while making every restore impossible.
  check(before !== null && validateSnapshot(before, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION }).ok === true,
    "and it returns the newest snapshot that DOES validate, rather than null",
    String(before));
}

// ── `deep` is forwarded, and this pair is what proves it ─────────────────────
// Two calls, same directory, same newest file, two answers. A snapshot carrying
// an ORPHANED row passes every cheap check -- the markers are there and the
// table set is complete -- and fails only `foreign_key_check`, which is what the
// deep path adds. `integrity_check` reads such a file as `ok` (measured, SQLite
// 3.53.0, with a positive control), so it is invisible to everything except
// `deep`. On the broken implementation -- `deep` destructured in the signature
// and never placed into `opts`, which is what shipped once -- both calls return
// the orphan, the control stays green and the assertion below it goes red.
{
  const at = Math.floor(Date.now() / 1000) + 30;      // newer than the good snapshots, older than the junk at +60
  const good = latestSnapshot(root, "hub");
  const orphan = join(root, "hub", `${at}.db`);
  const src = new DatabaseSync(good, { readOnly: true });
  src.exec(`VACUUM INTO '${orphan.replace(/'/g, "''")}'`);
  src.close();
  const o = new DatabaseSync(orphan);
  // foreign_keys OFF is what lets the offending row exist at all: this is the
  // write the constraint is there to stop, planted so the validator has
  // something real to catch.
  o.exec("PRAGMA foreign_keys=OFF");
  o.exec("INSERT INTO impl_pr(task,generation,slice,repo_id,pr,head_sha,created_at) " +
         "VALUES('bt:nosuchtask',1,0,1,1,'h',unixepoch())");
  o.close();
  check(validateSnapshot(orphan, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION }).ok === true,
    "control: the orphaned snapshot PASSES cheap validation, so only `deep` can reject it");
  check(validateSnapshot(orphan, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION, deep: true }).ok === false,
    "control: and deep validation DOES reject it, so the fixture can exhibit the defect");
  check(latestSnapshot(root, "hub", { deep: false }) === orphan,
    "control: it is the newest cheap-valid candidate, so a skip is observable",
    String(latestSnapshot(root, "hub", { deep: false })));
  const deepPick = latestSnapshot(root, "hub", { deep: true });
  check(deepPick !== orphan,
    "latestSnapshot forwards `deep` and skips a snapshot only foreign_key_check can reject",
    String(deepPick));
  check(deepPick !== null && deepPick !== orphan,
    "and falls THROUGH to an older snapshot rather than giving up, which is the fallback restore advertises",
    String(deepPick));
}

// ── two writers, one second: the publish is exclusive, not last-wins ─────────
// `mine` is only meaningful if the publish can actually be LOST. The inode is
// what discriminates the two implementations, and nothing else does: under
// `renameSync` the second writer's file replaces the first's, so the path
// survives, the bytes are valid, `validateSnapshot` passes, and every assertion
// that looks at content stays green while the first writer's snapshot is gone.
// Under `linkSync` the second writer gets EEXIST and the published inode cannot
// change. So: same path, same second, two calls, and the file must not move.
{
  const at = Math.floor(Date.now() / 1000) + 120;   // its own second, clear of every other fixture
  const db = openHub(hubPathFor(home));
  const first = snapshot(db, root, "hub", at, { keep: Infinity });
  check(first.ok === true && first.mine === true,
    "the first writer at a fresh timestamp publishes and owns the snapshot", JSON.stringify(first));
  const inoBefore = statSync(first.path).ino;
  const second = snapshot(db, root, "hub", at, { keep: Infinity });
  db.close();
  check(second.ok === true && second.mine === false,
    "a second writer at the SAME timestamp loses the publish rather than replacing it",
    JSON.stringify(second));
  check(second.path === first.path,
    "control: the loser still reports the canonical path, so callers need no special case",
    `${second.path} vs ${first.path}`);
  check(statSync(first.path).ino === inoBefore,
    "and the published file is the same inode afterwards: the loser did not overwrite the winner",
    `${inoBefore} -> ${statSync(first.path).ino}`);
  // The temporaries are the writers' own business and must not survive as
  // pseudo-snapshots. They are named to stay outside every reader's filter, but
  // leaving them behind fills the backup directory one failed race at a time.
  check(readdirSync(join(root, "hub")).filter(f => f.endsWith(".tmp")).length === 0,
    "control: neither writer left a temporary behind",
    JSON.stringify(readdirSync(join(root, "hub"))));
}

// ── and snapshotAll REPORTS a lost publish rather than claiming it ───────────
// A loser that falls through to the ordinary success push reports `ok: true`
// for a file it never validated and does not own -- and the winner deletes that
// file if its own deep validation fails, so this process has reported a
// successful backup for a path that no longer exists. The third outcome is
// `deferred`: not a success, and not a failure that escalates.
{
  const at2 = Math.floor(Date.now() / 1000) + 200;
  // Claim the second first, so snapshotAll's own snapshot() is the loser.
  const claimDb = openHub(hubPathFor(home));
  const claimed = snapshot(claimDb, root, "hub", at2, { keep: Infinity });
  claimDb.close();
  check(claimed.ok === true && claimed.mine === true,
    "fixture: the pre-claim won the publish, so snapshotAll below must lose it", JSON.stringify(claimed));
  const res = snapshotAll(home, root, { at: at2, keep: Infinity });
  const hub = res.find(r => r.nwo === "hub");
  check(hub?.ok === false && hub?.deferred === true,
    "snapshotAll reports a lost publish as deferred, not as a backup it can vouch for",
    JSON.stringify(hub));
  check(hub != null && !hub.escalate,
    "control: and does NOT escalate -- a same-second race is not a backup failure",
    String(hub?.escalate));
  check(existsSync(claimed.path),
    "control: and the winner's file is untouched, because a loser may not judge or delete it",
    String(claimed.path));
}

rmSync(home, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
