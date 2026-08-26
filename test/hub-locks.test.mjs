// Two builder processes ticking one hub is the failure this lease exists to
// make impossible: both would admit tasks, both would enqueue effects, and the
// idempotency keys would only hide half of it.
//
// The lease lives in the DATABASE rather than in an OS lock, because the
// service manager's instance and a founder's terminal instance do not share a
// lock namespace on every platform, and the platform matrix has to fail closed.
import { openHub, HUB_SCHEMA_VERSION } from "../src/build/hubdb.mjs";
import { acquireSingleton, heartbeatSingleton, releaseSingleton,
         withWriterLease, acquireMaintenanceLock, assertWritable } from "../src/build/locks.mjs";
// mkdirSync and readdirSync are the race barrier's; without them the test throws
// a ReferenceError before releasing the gun and the 20-way race never runs.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// `readStart`/`isSameProcess` are what make the seeded holder genuinely alive:
// a made-up pid is reaped as dead and the CLI would take the lease and loop.
import { readStart, isSameProcess } from "../src/supervisor.mjs";
// The checkout root, so the spawned CLI is THIS bin/reeve and not one on PATH.
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const dir = mkdtempSync(join(tmpdir(), "reeve-locks-"));
const NEVER = () => false;   // nothing is alive
const ALWAYS = () => true;   // everything is alive

// ── the ordinary claim, and the refusal that has to be useful ────────────────
{
  const db = openHub(join(dir, "s.db"));
  const a = acquireSingleton(db, { name: "builder", pid: 100, lstart: "L100", command: "reeve build run", isAlive: ALWAYS });
  check(a.ok === true, "the first claim succeeds");

  const b = acquireSingleton(db, { name: "builder", pid: 200, lstart: "L200", command: "reeve build run", isAlive: ALWAYS });
  check(b.ok === false, "a second process is refused while the holder is alive");
  check(b.holder?.pid === 100 && b.holder?.lstart === "L100", "and the refusal names the holder's pid and lstart", JSON.stringify(b.holder));
  check(typeof b.holder?.command === "string" && b.holder.command.length > 0, "and the command it is running", b.holder?.command);
  check(typeof b.holder?.ageSeconds === "number" && typeof b.holder?.expiresAt === "number",
    "and the lease age and expiry", JSON.stringify(b.holder));
  check(/--takeover/.test(b.recovery ?? ""), "and exactly one recovery command", String(b.recovery));

  // Re-entrancy: the SAME process re-claiming is not a second instance.
  const again = acquireSingleton(db, { name: "builder", pid: 100, lstart: "L100", command: "reeve build run", isAlive: ALWAYS });
  check(again.ok === true, "the holder re-claiming its own lease succeeds");

  // A reused pid is not the same process. Without lstart this is the bug where
  // a dead builder's pid gets recycled and the new process inherits authority.
  const reused = acquireSingleton(db, { name: "builder", pid: 100, lstart: "DIFFERENT", command: "x", isAlive: ALWAYS });
  check(reused.ok === false, "a process with the holder's pid but a different lstart is NOT the holder");
  db.close();
}

// ── takeover refuses while the holder is alive, and works once it is dead ────
{
  const db = openHub(join(dir, "t.db"));
  acquireSingleton(db, { name: "builder", pid: 100, lstart: "L100", command: "reeve build run", isAlive: ALWAYS });
  db.exec("UPDATE singleton_lease SET expires_at = unixepoch() - 1");
  const live = acquireSingleton(db, { name: "builder", pid: 300, lstart: "L300", command: "x", isAlive: ALWAYS });
  check(live.ok === false, "an EXPIRED lease whose holder is still alive is not takeable");
  const dead = acquireSingleton(db, { name: "builder", pid: 300, lstart: "L300", command: "x", isAlive: NEVER });
  check(dead.ok === true, "an expired lease whose holder is provably dead is takeable");
  db.close();
}

// ── --takeover is advertised as the recovery, so it must recover ─────────────
{
  const db = openHub(join(dir, "to.db"));
  acquireSingleton(db, { name: "builder", pid: 100, lstart: "L100", command: "reeve build run", isAlive: ALWAYS });
  // lease NOT expired, holder dead: the case an operator hits after a crash.
  // The implementation admits only when (expired || takeover) && holderDead, so
  // the flagless call must be REFUSED here -- asserting otherwise contradicts
  // the specified rule and would fail against a correct implementation while
  // never exercising the recovery path the flag exists for.
  const flagless = acquireSingleton(db, { name: "builder", pid: 400, lstart: "L400", command: "x", isAlive: NEVER });
  check(flagless.ok === false,
    "a dead holder with an UNEXPIRED lease is refused without the flag", JSON.stringify(flagless));
  const withFlag = acquireSingleton(db, { name: "builder", pid: 400, lstart: "L400", command: "x", isAlive: NEVER, takeover: true });
  check(withFlag.ok === true, "and --takeover recovers exactly that case", JSON.stringify(withFlag));
  db.exec("DELETE FROM singleton_lease");
  acquireSingleton(db, { name: "builder", pid: 100, lstart: "L100", command: "reeve build run", isAlive: ALWAYS });
  const alive = acquireSingleton(db, { name: "builder", pid: 500, lstart: "L500", command: "x", isAlive: ALWAYS, takeover: true });
  check(alive.ok === false,
    "and --takeover still REFUSES a holder that is alive: it waives expiry, never liveness", JSON.stringify(alive));
  db.close();
}

// ── heartbeat loss must be detectable, because it has to stop the loop ───────
{
  const db = openHub(join(dir, "h.db"));
  acquireSingleton(db, { name: "builder", pid: 100, lstart: "L100", command: "c", isAlive: ALWAYS });
  check(heartbeatSingleton(db, { name: "builder", pid: 100, lstart: "L100" }) === true, "the holder can heartbeat");
  releaseSingleton(db, { name: "builder", pid: 100, lstart: "L100" });
  check(heartbeatSingleton(db, { name: "builder", pid: 100, lstart: "L100" }) === false,
    "a heartbeat after the row is gone returns false, so the loop can stop rather than tick on");
  db.close();
}

// ── the writer lease and the maintenance lock ────────────────────────────────
{
  const db = openHub(join(dir, "w.db"));
  let sawLease = 0;
  withWriterLease(db, { command: "reeve task file", pid: 1, lstart: "A", isAlive: ALWAYS }, () => {
    sawLease = db.prepare("SELECT count(*) c FROM writer_lease").get().c;
  });
  check(sawLease === 1, "a writer lease exists for the duration of the command");
  check(db.prepare("SELECT count(*) c FROM writer_lease").get().c === 0, "and is released when it returns");

  try { withWriterLease(db, { command: "x", pid: 1, lstart: "A", isAlive: ALWAYS }, () => { throw new Error("boom"); }); } catch {}
  check(db.prepare("SELECT count(*) c FROM writer_lease").get().c === 0,
    "and is released even when the command throws, so a crash does not wedge restore forever");

  acquireMaintenanceLock(db, { pid: 9, lstart: "M", isAlive: NEVER });
  let refused = false;
  try { assertWritable(db, { isAlive: ALWAYS }); } catch { refused = true; }
  check(refused, "every writer refuses to begin while a live maintenance lock is held");
  let reaped = true;
  try { assertWritable(db, { isAlive: NEVER }); } catch { reaped = false; }
  check(reaped, "control: a maintenance lock left by a CRASHED restore is reaped like any lease, not honoured forever");
  db.close();
}

// ── 20 real processes, one winner ────────────────────────────────────────────
// Not 20 calls in one process: BEGIN IMMEDIATE inside a single connection is
// trivially serial, so a same-process "race" would pass against an
// implementation with no transaction at all.
{
  const p = join(dir, "race.db");
  openHub(p).close();
  const worker = join(dir, "race-worker.mjs");
  writeFileSync(worker, `
import { openHub } from "${join(process.cwd(), "src/build/hubdb.mjs")}";
import { acquireSingleton } from "${join(process.cwd(), "src/build/locks.mjs")}";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const db = openHub(process.argv[2]);          // open BEFORE the barrier, so the
const go = process.argv[4];                   // race is over the write, not over
writeFileSync(join(process.argv[5], process.argv[3]), "");   // ...startup and open
while (!existsSync(go)) {}
const r = acquireSingleton(db, { name: "builder", pid: Number(process.argv[3]),
  lstart: "L" + process.argv[3], command: "reeve build run", isAlive: () => true });
console.log(r.ok ? "WON" : "lost");
`);
  // spawn(), not execFileSync(): execFileSync BLOCKS until each child exits, so a
  // loop of twenty of them starts twenty processes one after another and races
  // nothing. A read-then-insert implementation with no transaction passes that
  // version, because the first process has already committed before the second
  // one opens the database. The barrier file below is what makes it a race: every
  // child opens the store, then spins until `go` appears, so all twenty contend
  // for the same write at once.
  const go = join(dir, "go"), ready = join(dir, "ready");
  mkdirSync(ready, { recursive: true });
  const kids = Array.from({ length: 20 }, (_, i) =>
    new Promise((res) => {
      const c = spawn(process.execPath, [worker, p, String(1000 + i), go, ready], { encoding: "utf8" });
      let out = ""; c.stdout.on("data", d => out += d);
      c.on("exit", () => res(out.trim()));
    }));
  // Wait for every child to ANNOUNCE it is at the barrier rather than sleeping a
  // fixed 300ms and hoping. On a loaded machine some children have not opened
  // the database when the gun fires, so they arrive late, contend with nobody,
  // and the race silently shrinks to however many made it in time.
  for (let i = 0; i < 400 && readdirSync(ready).length < 20; i++)
    await new Promise(r => setTimeout(r, 25));
  check(readdirSync(ready).length === 20,
    `control: all 20 children reached the barrier before the start (${readdirSync(ready).length}/20)`);
  writeFileSync(go, "");
  const results = await Promise.all(kids);
  const winners = results.filter(r => r === "WON").length;
  check(winners === 1, `exactly one of 20 processes takes the lease (got ${winners})`, results.join(","));
  check(db_rows(p) === 1, "and exactly one lease row exists afterwards");
}
function db_rows(p) { const d = openHub(p); const c = d.prepare("SELECT count(*) c FROM singleton_lease").get().c; d.close(); return c; }

// ── the CLI actually TAKES the lease, which no assertion above can reach ─────
// Every block above calls `acquireSingleton` directly, so a perfectly correct
// locks.mjs that `bin/reeve` never imports passes all of them while production
// `build run` takes no lease at all and two builders tick one hub -- the exact
// failure this file exists to make impossible. The route has to be exercised.
//
// Only the REFUSAL path is safe to spawn: `build run` is a heartbeat loop and
// the success path never returns. The refusal exits immediately, which is what
// makes this testable at all, and the timeout below is a hard guard so a
// regression that falls through into the loop fails the suite instead of
// hanging it -- a hanging test is worse than a failing one.
{
  const home = join(dir, "cli-home");
  mkdirSync(join(home, "state"), { recursive: true });
  // A holder that is GENUINELY alive: `isSameProcess` checks pid AND start
  // time, so a made-up pid is reaped as dead and the CLI would take the lease
  // and loop forever. That is not a hypothetical -- it is what happened the
  // first time this was probed by hand.
  const holder = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
  await new Promise(r => setTimeout(r, 200));
  const db = openHub(join(home, "state", "hub.db"));
  const seeded = acquireSingleton(db, {
    name: "builder", pid: holder.pid, lstart: readStart(holder.pid),
    command: "reeve build run", isAlive: isSameProcess });
  db.close();
  check(seeded.ok === true, "fixture: a live holder took the lease", JSON.stringify(seeded));

  // REEVE_HOME, not `--home`. `bin/reeve` resolves its home from the environment
  // and has no --home flag, and unknown flags are IGNORED rather than refused --
  // so `--home <dir>` silently operates on the operator's real ~/.reeve. That is
  // not hypothetical: the first run of this test created a hub there and left a
  // singleton lease in it.
  const kid = spawn(process.execPath, [join(ROOT, "bin", "reeve"), "build", "run"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, REEVE_HOME: home } });
  let out = "", done = false;
  kid.stdout.on("data", d => { out += d; });
  kid.stderr.on("data", d => { out += d; });
  const code = await Promise.race([
    new Promise(r => kid.on("exit", c => { done = true; r(c); })),
    new Promise(r => setTimeout(() => r("TIMEOUT"), 15000)),
  ]);
  if (!done) kid.kill("SIGKILL");
  holder.kill("SIGKILL");

  // The CLI read OUR home. Without this the whole block is satisfied by a run
  // against a different home that happened to refuse for its own reasons -- and
  // the home is the one thing an ignored flag gets wrong silently.
  check(existsSync(join(home, "state", "hub.db")),
    "control: the CLI operated on the test home, not the machine's real one",
    join(home, "state", "hub.db"));
  check(code === 1,
    "`reeve build run` refuses while another builder holds the lease, and exits non-zero",
    `exit=${code}${code === "TIMEOUT" ? " -- it entered the heartbeat loop instead of refusing" : ""}`);
  check(/another builder holds the lease/.test(out),
    "and says so in words rather than by exit status alone", out.slice(0, 200));
  // NAMES the holder. A lock refusal that does not say who holds it turns a
  // two-second problem into an investigation, which is the whole reason the
  // refusal carries a holder block.
  check(out.includes(String(holder.pid)),
    "and names the holding pid", out.slice(0, 300));
  check(/command\s+reeve build run/.test(out),
    "and the command that holds it", out.slice(0, 300));
  check(/-> /.test(out) || /takeover/.test(out),
    "and tells the operator what to do next", out.slice(0, 400));
}

// ── an interrupted first migration is RECOVERED, not a permanent crash ──────
// `openHub` creates `schema_version` as plain DDL, committed immediately, and
// only then opens the transaction that applies migration 1. A process killed
// between those two points leaves a file that exists, carries `schema_version`,
// records no version, and has none of the lease tables. A `build run` that
// decides "is this a first run" by asking whether the FILE exists sends that
// store down the non-bootstrap path, where acquireSingleton queries
// singleton_lease and throws `no such table` -- every run, for ever, with no
// way out but deleting the file by hand.
{
  const home = join(dir, "interrupted");
  mkdirSync(join(home, "state"), { recursive: true });
  const p = join(home, "state", "hub.db");
  const half = new DatabaseSync(p);
  half.exec(`CREATE TABLE IF NOT EXISTS schema_version (
               version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT`);
  half.close();

  const probe = new DatabaseSync(p, { readOnly: true });
  const tablesBefore = probe.prepare(
    "SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c;
  const versionBefore = probe.prepare("SELECT COALESCE(max(version),0) v FROM schema_version").get().v;
  probe.close();
  check(tablesBefore === 1 && versionBefore === 0,
    "fixture: the store exists, carries schema_version, and has completed no migration",
    `${tablesBefore} table(s), version ${versionBefore}`);

  // `build run` is a heartbeat loop, so it is started and killed rather than
  // awaited. What matters is what it did to the store before it settled, and
  // that it did not die naming a missing table.
  const kid = spawn(process.execPath, [join(ROOT, "bin", "reeve"), "build", "run"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, REEVE_HOME: home } });
  let out = "";
  kid.stdout.on("data", d => { out += d; });
  kid.stderr.on("data", d => { out += d; });
  await new Promise(r => setTimeout(r, 3000));
  kid.kill("SIGKILL");

  check(!/no such table/.test(out),
    "`build run` does not die on a missing lease table when the first migration was interrupted",
    out.slice(0, 240));

  const after = new DatabaseSync(p, { readOnly: true });
  const tablesAfter = after.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c;
  const versionAfter = after.prepare("SELECT COALESCE(max(version),0) v FROM schema_version").get().v;
  after.close();
  // The BINARY's version, not a literal. This pinned 1 and broke the moment
  // migration 2 landed -- the assertion is that the store was carried all the way
  // forward, and "all the way" moves with the binary.
  check(versionAfter === HUB_SCHEMA_VERSION,
    "and it COMPLETES the interrupted migration rather than refusing the store",
    `version ${versionBefore} -> ${versionAfter}, binary at ${HUB_SCHEMA_VERSION}`);
  check(tablesAfter > tablesBefore,
    "control: the store really was incomplete before, so the recovery is observable",
    `${tablesBefore} -> ${tablesAfter} tables`);
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
