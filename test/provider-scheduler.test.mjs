// The subscription is the real choke point, and observation after the fact
// cannot reserve shared quota: two daemons can both see free capacity and both
// launch before either exit is recorded. So admission is a transaction.
//
// The asymmetry between the two owners is deliberate. The guardian is the
// watchman; the builder is the thing being restrained.
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { openHub } from "../src/build/hubdb.mjs";
import { claimProvider, releaseProvider, noteRateLimit, reapProviderLeases,
         cancelQueued, bindProviderLease, heartbeatProvider } from "../src/provider.mjs";
import { acquireMaintenanceLock } from "../src/build/locks.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-provider-"));
const SRC = new URL("../src", import.meta.url).pathname;

const ALIVE = () => true, DEAD = () => false;

// ── the admission rule ───────────────────────────────────────────────────────
{
  const db = openHub(join(dir, "p1.db"));           // defaults: limit 2, reserved 1
  const g = claimProvider(db, { owner: "guardian", repoId: 1, runRef: "pr:1", pid: 1, lstart: "A", isAlive: ALIVE });
  check(g.ok, "a guardian claim is admitted", JSON.stringify(g));

  const b = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:1", pid: 2, lstart: "B", isAlive: ALIVE });
  check(!b.ok && b.reason === "at-limit",
    "a builder claim is refused when held leases reach limit minus guardian_reserved (2-1=1)", JSON.stringify(b));

  // THE CLAIM HANDS BACK WHAT THE RELEASE NEEDS. `claimProvider` returns the
  // identity alongside the id precisely so a caller never has to release by an
  // integer a restore can renumber, and passing the whole result is the shape
  // production should copy.
  releaseProvider(db, g);
  const b2 = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:1", pid: 2, lstart: "B", isAlive: ALIVE });
  check(b2.ok, "control: once the guardian releases, the builder is admitted");
  db.close();
}

// ── an identity is required, and lstart is part of it ────────────────────────
// A lease whose holder has no start time can never be reaped: `isAlive(pid,
// lstart)` is how a dead holder is recognised, and a pid alone is reused.
{
  const db = openHub(join(dir, "p1i.db"));
  const noLstart = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:1", pid: 2, lstart: null, isAlive: ALIVE });
  check(!noLstart.ok && noLstart.reason === "no-identity",
    "a claim with no lstart is refused: an unreapable lease is worse than a refused one", JSON.stringify(noLstart));
  const noRepo = claimProvider(db, { owner: "builder", repoId: null, runRef: "bt:1", pid: 2, lstart: "B", isAlive: ALIVE });
  check(!noRepo.ok && noRepo.reason === "no-identity",
    "and so is one with no repo id, which the live-request index cannot deduplicate without",
    JSON.stringify(noRepo));
  check(db.prepare("SELECT count(*) c FROM provider_lease").get().c === 0,
    "control: neither refusal left a row behind");
  db.close();
}

// ── a QUEUED guardian request blocks the next builder admission ──────────────
{
  const db = openHub(join(dir, "p2.db"));
  // INSERT, not UPDATE: a fresh hub has no provider_state row at all, so an
  // UPDATE changes zero rows and every claim below silently runs on the 2/1
  // fallback instead of 3/0 -- which would make "three builders fit" fail for a
  // reason that has nothing to do with the admission rule.
  db.exec(`INSERT INTO provider_state(provider,concurrency_limit,guardian_reserved)
           VALUES('claude',3,0)
           ON CONFLICT(provider) DO UPDATE SET concurrency_limit=3, guardian_reserved=0`);
  check(db.prepare("SELECT concurrency_limit c, guardian_reserved g FROM provider_state WHERE provider='claude'").get().c === 3,
    "control: the limit really is 3/0 before the claims below run");
  // ALL THREE in the same synthetic epoch, bt:1 oldest, with DISTINCT
  // timestamps. requested_at is integer seconds, so three claims in one tick
  // ordinarily share a value and "the youngest builder" has no defined answer.
  const a = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:1", pid: 1, lstart: "A", isAlive: ALIVE, now: 1000 });
  const c = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:2", pid: 2, lstart: "B", isAlive: ALIVE, now: 1001 });
  const d = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:3", pid: 3, lstart: "C", isAlive: ALIVE, now: 1002 });
  check(a.ok && c.ok && d.ok, "three builders fit under a limit of 3 with nothing reserved");

  // BOTH ORDERINGS. Starting with the guardian proves only that a builder cannot
  // take the reserved slot -- and an implementation that caps EVERY owner at
  // `limit - guardian_reserved` passes all of it. In production that same
  // implementation lets one builder holding the single unreserved slot block the
  // guardian out of the reserved one, which is the reservation inverted.
  {
    const rev = openHub(join(dir, "p1r.db"));
    const b1 = claimProvider(rev, { owner: "builder", repoId: 1, runRef: "bt:9", pid: 1, lstart: "A", isAlive: ALIVE });
    check(b1.ok, "fixture: a builder takes the one unreserved slot under 2/1", JSON.stringify(b1));
    const gr = claimProvider(rev, { owner: "guardian", repoId: 1, runRef: "pr:9", pid: 2, lstart: "B", isAlive: ALIVE });
    check(gr.ok, "and a guardian is admitted CONCURRENTLY into the reserved slot", JSON.stringify(gr));
    const b2 = claimProvider(rev, { owner: "builder", repoId: 1, runRef: "bt:10", pid: 3, lstart: "C", isAlive: ALIVE });
    check(!b2.ok, "control: a second builder is still refused, so the reservation is not just 'admit everything'",
      JSON.stringify(b2));
    rev.close();
  }

  const g = claimProvider(db, { owner: "guardian", repoId: 1, runRef: "pr:9", pid: 4, lstart: "D", isAlive: ALIVE });
  check(!g.ok && g.reason === "queued", "a guardian that cannot be admitted is QUEUED, not simply refused", JSON.stringify(g));
  // A blocked guardian re-asks on every tick. That must not deepen the queue.
  claimProvider(db, { owner: "guardian", repoId: 1, runRef: "pr:9", pid: 4, lstart: "D", isAlive: ALIVE });
  claimProvider(db, { owner: "guardian", repoId: 1, runRef: "pr:9", pid: 4, lstart: "D", isAlive: ALIVE });
  claimProvider(db, { owner: "guardian", repoId: 1, runRef: "pr:9", pid: 4, lstart: "D", isAlive: ALIVE });
  check(db.prepare("SELECT count(*) c FROM provider_lease WHERE owner='guardian' AND status='queued'").get().c === 1,
    "re-asking for the SAME run does not add a second queued row");

  releaseProvider(db, a);
  const e = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:4", pid: 5, lstart: "E", isAlive: ALIVE });
  check(!e.ok && e.reason === "queued",
    "and the freed slot is not taken by the next builder while a guardian is queued", JSON.stringify(e));
  // The preemption WRITE, asserted in the one fixture that can produce it: a
  // queued guardian with every slot builder-held. Without this an implementation
  // that never sets the flag passes the entire scheduler suite, and the
  // phase-boundary reader has no signal to release capacity for the guardian.
  const flagged = db.prepare(
    "SELECT run_ref FROM provider_lease WHERE owner='builder' AND preempt_requested=1").all();
  check(flagged.length === 1, "exactly one builder lease is marked for preemption", JSON.stringify(flagged));
  // The YOUNGEST: bt:2 and bt:3 were claimed after bt:1, and bt:1's slot was
  // released above, so bt:3 is the newest live builder.
  check(flagged[0]?.run_ref === "bt:3",
    "and it is the YOUNGEST builder, not whichever row the query happened to reach first",
    JSON.stringify(flagged));
  // Marked, NOT revoked. Preemption happens at a phase boundary; killing here is
  // the behaviour this flag exists to avoid.
  check(db.prepare("SELECT count(*) c FROM provider_lease WHERE owner='builder' AND status='held'").get().c === 2,
    "and nothing is revoked: both builder leases are still held");

  const g2 = claimProvider(db, { owner: "guardian", repoId: 1, runRef: "pr:9", pid: 4, lstart: "D", isAlive: ALIVE });
  check(g2.ok, "the queued guardian takes it");
  check(db.prepare("SELECT count(*) c FROM provider_lease WHERE owner='guardian' AND status='queued'").get().c === 0,
    "and its queued row became the held one rather than a second row",
    JSON.stringify(db.prepare("SELECT owner,run_ref,status FROM provider_lease").all()));
  db.close();
}

// ── a 429 stops builder admission entirely ───────────────────────────────────
{
  const db = openHub(join(dir, "p3.db"));
  noteRateLimit(db, { signature: "rate_limit_exceeded", now: 1000, cooldownSeconds: 300 });
  const b = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:1", pid: 1, lstart: "A", isAlive: ALIVE, now: 1100 });
  check(!b.ok && b.reason === "cooldown", "the builder admits nothing while a cooldown is live", JSON.stringify(b));
  check(b.until === 1300, "and is told when it lifts", String(b.until));
  // A guardian under cooldown is QUEUED, not dropped: admission records it so the
  // next builder admission is still blocked behind it. Testing only the builder
  // lets an implementation drop guardian requests during a cooldown, inverting
  // the priority the reservation exists to give them.
  const gq = claimProvider(db, { owner: "guardian", repoId: 1, runRef: "pr:1", pid: 9, lstart: "G", isAlive: ALIVE, now: 1100 });
  check(!gq.ok && gq.reason === "queued", "a guardian request during a cooldown is QUEUED, not dropped", JSON.stringify(gq));
  check(db.prepare("SELECT count(*) c FROM provider_lease WHERE owner='guardian' AND status='queued'").get().c === 1,
    "and the queued row exists, so it still blocks the next builder admission");

  const after = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:1", pid: 1, lstart: "A", isAlive: ALIVE, now: 1400 });
  check(!after.ok && after.reason === "queued",
    "so after the cooldown the QUEUED GUARDIAN is served first, not the builder", JSON.stringify(after));
  check(db.prepare("SELECT last_signature FROM provider_state WHERE provider='claude'").get().last_signature === "rate_limit_exceeded",
    "and the signature that caused it is recorded");
  // CONTROL: a cooldown is not "refuse for ever". With the queued guardian gone
  // the builder is admitted once the clock passes, or "cooldown" above could be
  // satisfied by an implementation that never lifts it.
  cancelQueued(db, { owner: "guardian", repoId: 1, runRef: "pr:1" });
  const lifted = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:1", pid: 1, lstart: "A", isAlive: ALIVE, now: 1400 });
  check(lifted.ok, "control: once the cooldown has passed and nothing is queued, the builder is admitted",
    JSON.stringify(lifted));
  db.close();
}

// ── a renumbered id is not an identity ───────────────────────────────────────
// A restore replaces the database, clears `provider_lease` and lets SQLite
// renumber it, so an integer key can come back pointing at somebody else's
// request. Two silent failures follow from trusting it: a stale rebind
// overwrites the NEW holder's pid and lstart so the reaper can never match
// either row, and a stale heartbeat renews an unrelated row for as long as the
// old worker lives.
{
  const db = openHub(join(dir, "p6.db"));
  const old = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:old", pid: 11, lstart: "OLD", isAlive: ALIVE });
  check(old.ok, "fixture: the first request is admitted", JSON.stringify(old));
  db.exec("DELETE FROM provider_lease");                      // what restoreHub does
  const fresh = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:new", pid: 22, lstart: "NEW", isAlive: ALIVE });
  check(fresh.ok && fresh.id === old.id,
    "fixture: the next request INHERITS the cleared row's id, which is the whole hazard",
    JSON.stringify({ old: old.id, fresh: fresh.id }));

  const staleBind = bindProviderLease(db, { id: old.id, owner: "builder", repoId: 1,
                                            runRef: "bt:old", pid: 999, lstart: "GHOST" });
  check(staleBind.bound === 0, "a rebind carrying the OLD identity changes nothing",
    JSON.stringify(staleBind));
  const staleBeat = heartbeatProvider(db, { id: old.id, owner: "builder", repoId: 1, runRef: "bt:old" });
  check(staleBeat.beat === 0, "and neither does a heartbeat carrying it", JSON.stringify(staleBeat));
  const row = db.prepare("SELECT pid, lstart, run_ref FROM provider_lease WHERE id = ?").get(fresh.id);
  check(row.pid === 22 && row.lstart === "NEW" && row.run_ref === "bt:new",
    "so the new holder's pid and lstart are untouched, and it stays reapable",
    JSON.stringify(row));

  // CONTROL: the CURRENT owner's rebind and heartbeat still work, so the match
  // is a fence and not a blanket refusal.
  const good = bindProviderLease(db, { id: fresh.id, owner: "builder", repoId: 1,
                                       runRef: "bt:new", pid: 33, lstart: "SPAWNED" });
  check(good.bound === 1, "control: the current holder's rebind is applied", JSON.stringify(good));
  check(heartbeatProvider(db, { id: fresh.id, owner: "builder", repoId: 1, runRef: "bt:new" }).beat === 1,
    "control: and so is its heartbeat");
  db.close();
}

// ── releasing by an id alone is refused ─────────────────────────────────────
// The id is a fast path, never an identity. A restore clears `provider_lease`
// and SQLite reuses the integer, so a cleanup running in a `finally` after that
// deletes an unrelated LIVE lease -- and the scheduler then undercounts held
// capacity and admits work past the provider limit. The dangerous call is the
// easy one to write, so it has to be refused rather than discouraged.
{
  const db = openHub(join(dir, "p7.db"));
  const held = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:1", pid: 1, lstart: "A", isAlive: ALIVE });
  const bare = releaseProvider(db, { id: held.id });
  check(!bare.ok && bare.reason === "no-identity",
    "a release carrying only an id is refused", JSON.stringify(bare));
  check(db.prepare("SELECT count(*) c FROM provider_lease").get().c === 1,
    "control: and the lease is still there, so the refusal was not a silent delete");

  // FORCE is the named way to say it anyway, for a caller that has genuinely
  // lost the identity. It has to be typed at the call site so it shows up in a
  // review rather than being reached by omission.
  const forced = releaseProvider(db, { id: held.id, force: true });
  check(forced.ok && forced.released === 1,
    "control: `force` still deletes by id, explicitly", JSON.stringify(forced));

  // And the ordinary path: the whole claim result, which carries the identity.
  const again = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:2", pid: 2, lstart: "B", isAlive: ALIVE });
  check(releaseProvider(db, again).released === 1,
    "control: releasing with the identity the claim returned works");
  // A WRONG identity with a RIGHT id deletes nothing, which is the fence.
  const third = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:3", pid: 3, lstart: "C", isAlive: ALIVE });
  check(releaseProvider(db, { id: third.id, owner: "builder", repoId: 1, runRef: "bt:WRONG" }).released === 0,
    "and an id whose identity does not match deletes nothing");
  check(db.prepare("SELECT count(*) c FROM provider_lease").get().c === 1,
    "control: that lease survived, so the id alone did not carry the delete");
  db.close();
}

// ── a cooldown queue is not a capacity queue ────────────────────────────────
// A guardian queued behind a cooldown is not waiting for a SLOT. Asking a
// builder to surrender one suspends running work to produce capacity that then
// sits idle until the cooldown lifts.
{
  const db = openHub(join(dir, "p8.db"));
  db.exec(`INSERT INTO provider_state(provider,concurrency_limit,guardian_reserved)
           VALUES('claude',1,0)
           ON CONFLICT(provider) DO UPDATE SET concurrency_limit=1, guardian_reserved=0`);
  const b = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:1", pid: 1, lstart: "A", isAlive: ALIVE, now: 1000 });
  check(b.ok, "fixture: the single slot is builder-held", JSON.stringify(b));
  noteRateLimit(db, { signature: "429", now: 1000, cooldownSeconds: 300 });

  const gq = claimProvider(db, { owner: "guardian", repoId: 1, runRef: "pr:1", pid: 2, lstart: "G", isAlive: ALIVE, now: 1100 });
  check(!gq.ok && gq.reason === "queued", "fixture: the guardian queues during the cooldown", JSON.stringify(gq));
  check(db.prepare("SELECT count(*) c FROM provider_lease WHERE preempt_requested=1").get().c === 0,
    "no builder is asked to give up a slot the guardian could not use anyway",
    JSON.stringify(db.prepare("SELECT owner,run_ref,preempt_requested FROM provider_lease").all()));

  // CONTROL: once the cooldown has passed, the SAME starved state does request
  // preemption -- or "skip while cooling" has become "never preempt".
  const after = claimProvider(db, { owner: "guardian", repoId: 1, runRef: "pr:1", pid: 2, lstart: "G", isAlive: ALIVE, now: 1400 });
  check(!after.ok && after.reason === "queued", "control: still queued after the cooldown, since the slot is held",
    JSON.stringify(after));
  check(db.prepare("SELECT count(*) c FROM provider_lease WHERE preempt_requested=1").get().c === 1,
    "control: and NOW the youngest builder is asked to yield",
    JSON.stringify(db.prepare("SELECT owner,run_ref,preempt_requested FROM provider_lease").all()));
  db.close();
}

// ── every mutation refuses while a restore holds the lock ────────────────────
// The restore-safety invariant is "assertWritable inside each mutation's own
// transaction", and nothing tested it: a scheduler that omitted the check
// entirely passed every assertion above.
{
  const db = openHub(join(dir, "p5.db"));
  // Seed the rows the mutators need BEFORE the lock is taken -- a mutator that
  // no-ops because it found nothing to change is indistinguishable from one that
  // refused, and would satisfy the assertion below without ever calling
  // assertWritable. Room for TWO builders, so the second claim is not refused at
  // the builder limit, which would leave no dead row and make the reaper's
  // deleting path unreachable by the very test that claims to cover it.
  db.exec(`INSERT INTO provider_state(provider,concurrency_limit,guardian_reserved)
           VALUES('claude',2,0)
           ON CONFLICT(provider) DO UPDATE SET concurrency_limit=2, guardian_reserved=0`);
  const held = claimProvider(db, { owner: "builder", repoId: 1, runRef: "seed", pid: 1, lstart: "A", isAlive: ALIVE });
  const dead = claimProvider(db, { owner: "builder", repoId: 1, runRef: "dead", pid: 999, lstart: "GONE", isAlive: ALIVE });
  check(held.ok && dead.ok, "fixture: two live rows exist for the mutators to act on",
    JSON.stringify({ held, dead }));
  // And the dead one must be EXPIRED. Reaping requires expiry AND failed
  // liveness, so a dead-but-unexpired row leaves the reaper's delete unreached
  // and its refusal below would be "nothing to reap" wearing the costume of
  // "the lock stopped me".
  db.exec(`UPDATE provider_lease SET expires_at = unixepoch() - 1 WHERE id = ${dead.id}`);

  acquireMaintenanceLock(db, { pid: 4242, lstart: "L4242", isAlive: ALIVE });
  // ALL SEVEN mutators, including the three that mutate or DELETE rows --
  // otherwise an implementation could reap a live worker's lease mid-restore and
  // still pass a suite advertised as proving "every mutation calls assertWritable".
  //
  // THE PREDICATE IS TARGETED, not a blanket `() => false`. `assertWritable` asks
  // `isAlive` about the LOCK HOLDER and reaps the lock when it answers no -- so a
  // reaper passed `() => false` would declare the restore dead, take the lock,
  // and proceed, and this assertion would fail against a CORRECT implementation.
  // One predicate answers two different questions here; it has to distinguish
  // the lock holder (4242, alive) from the dead lease holder (999, gone).
  //
  // AND EVERY MUTATOR IS GIVEN IT, not just the first. The default is
  // `isSameProcess`, which answers honestly that pid 4242 is not a running
  // process -- so the first mutator to fall back to the default REAPS THE LOCK
  // and every assertion after it measures an unlocked hub. A loop that supplies
  // the predicate to one entry and lets six default is not testing six of the
  // seven mutators; it is testing that the lock it deleted is gone.
  const lockAliveWorkerDead = (pid) => pid !== 999;
  const L = { isAlive: lockAliveWorkerDead };
  for (const [name, run] of [
    ["claimProvider",     () => claimProvider(db, { ...L, owner: "builder", repoId: 1, runRef: "r", pid: 1, lstart: "A" })],
    ["releaseProvider",   () => releaseProvider(db, { ...L, id: held.id, owner: "builder", repoId: 1, runRef: "seed" })],
    ["noteRateLimit",     () => noteRateLimit(db, { ...L, signature: "x", cooldownSeconds: 1 })],
    ["cancelQueued",      () => cancelQueued(db, { ...L, owner: "builder", repoId: 1, runRef: "r" })],
    ["bindProviderLease", () => bindProviderLease(db, { ...L, id: held.id, owner: "builder", repoId: 1, runRef: "seed", pid: 4321, lstart: "W" })],
    ["heartbeatProvider", () => heartbeatProvider(db, { ...L, id: held.id, owner: "builder", repoId: 1, runRef: "seed" })],
    ["reapProviderLeases", () => reapProviderLeases(db, L)],
  ]) {
    // The refusal must be the MAINTENANCE one. A bare `catch { refused = true }`
    // counts every throw as success -- including the ReferenceError from a
    // mutator that was never imported, which is exactly how one of these sat in
    // this list unimported and green.
    let refused = false, unexpected = null;
    try {
      const r = run();
      refused = r?.ok === false && r.reason === "maintenance";
      if (!refused) unexpected = `returned ${JSON.stringify(r)}`;
    } catch (e) {
      if (/restore|maintenance/i.test(e.message)) refused = true;
      else unexpected = `${e.constructor.name}: ${e.message}`;
    }
    check(refused, `${name} refuses while a live restore holds maintenance_lock`, String(unexpected));
  }
  // THE LOCK IS STILL HELD. Without this the whole loop above can pass
  // vacuously: any mutator that reaps the lock leaves the rest measuring an
  // unlocked hub, and "refused" would then be a claim about nothing.
  check(db.prepare("SELECT count(*) c FROM maintenance_lock WHERE name='restore'").get().c === 1,
    "control: the restore lock survived every refusal, so the loop measured a LOCKED hub");

  // Control: with the lock gone the same calls succeed -- otherwise "refuses
  // everything" satisfies every assertion above.
  db.exec("DELETE FROM maintenance_lock");
  // Reap FIRST. `held` and the expired `dead` row occupy both configured slots,
  // so a claim could not be admitted until one is freed and the control below
  // would return `at-limit` against a correct implementation, reading as "the
  // lock is still refusing". This doubles as the reaper's own control: its
  // refusal under the lock could equally have been "there was nothing to reap".
  const { reaped } = reapProviderLeases(db, L);
  check(reaped >= 1,
    "control: with the lock released the reaper really does delete the dead holder's lease",
    String(reaped));
  check(claimProvider(db, { ...L, owner: "builder", repoId: 1, runRef: "r2", pid: 1, lstart: "A" }).ok,
    "control: and the slot the reaper freed is claimable, so the refusals above were the lock");
  db.close();
}

// ── a dead holder's lease is reaped ──────────────────────────────────────────
{
  const db = openHub(join(dir, "p4.db"));
  const a = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:1", pid: 999, lstart: "GONE", isAlive: ALIVE });
  db.exec(`UPDATE provider_lease SET expires_at = unixepoch() - 1 WHERE id = ${a.id}`);
  const blockedWhileAlive = claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:2", pid: 2, lstart: "B", isAlive: ALIVE });
  check(!blockedWhileAlive.ok, "an expired lease whose holder is still ALIVE is not reaped: a busy process may miss a heartbeat");
  const { reaped } = reapProviderLeases(db, { isAlive: DEAD });
  check(reaped === 1, `a crashed worker's slot is freed (reaped ${reaped})`);
  check(claimProvider(db, { owner: "builder", repoId: 1, runRef: "bt:2", pid: 2, lstart: "B", isAlive: DEAD }).ok,
    "and the next claim is admitted");
  db.close();
}

// ── two daemons racing for the last slot: real processes ─────────────────────
// This is the ONLY check that admission is transactional: every single-process
// assertion above passes against a read-then-write implementation with no
// transaction at all, because a same-process loop over one connection is serial
// by construction.
{
  const p = join(dir, "race.db");
  {
    // ONE free slot, explicitly. On the documented defaults (limit 2, reserved 1)
    // the alternating owners can admit two guardians, or a builder plus a
    // guardian, so "exactly one winner" would be a property of the numbers
    // rather than of the code, and the assertion would be flaky rather than wrong.
    const seed = openHub(p);
    seed.exec(`INSERT INTO provider_state(provider,concurrency_limit,guardian_reserved)
               VALUES('claude',1,0)
               ON CONFLICT(provider) DO UPDATE SET concurrency_limit=1, guardian_reserved=0`);
    seed.close();
  }
  const worker = join(dir, "provider-race-worker.mjs");
  writeFileSync(worker, `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openHub } from "${SRC}/build/hubdb.mjs";
import { claimProvider } from "${SRC}/provider.mjs";
const db = openHub(process.argv[2]);
const [, , , id, go, ready] = process.argv;
writeFileSync(join(ready, id), "");
while (!existsSync(go)) {}
const r = claimProvider(db, { owner: Number(id) % 2 ? "guardian" : "builder", repoId: 1,
  runRef: "r:" + id, pid: 1000 + Number(id), lstart: "L" + id, isAlive: () => true });
console.log(r.ok ? "HELD" : "no");
`);
  const go = join(dir, "go"), ready = join(dir, "ready");
  mkdirSync(ready, { recursive: true });
  // Capture stderr and the exit code, not just stdout. A child that throws prints
  // nothing to stdout and exits non-zero; collecting only stdout turns that into
  // the empty string, which reads as "not HELD" -- indistinguishable from an
  // orderly refusal.
  const kids = Array.from({ length: 20 }, (_, i) => new Promise((res) => {
    const c = spawn(process.execPath, [worker, p, String(i), go, ready], { encoding: "utf8" });
    let out = "", err = "";
    c.stdout.on("data", d => out += d);
    c.stderr.on("data", d => err += d);
    c.on("exit", (code) => res({ out: out.trim(), err: err.trim(), code }));
  }));
  for (let i = 0; i < 400 && readdirSync(ready).length < 20; i++) await new Promise(r => setTimeout(r, 25));
  check(readdirSync(ready).length === 20, "control: all 20 children reached the barrier before the start");
  writeFileSync(go, "");
  // Every contender must COMPLETE, with a recognised answer. Counting only "HELD"
  // treats a crash -- a lock error, a constraint violation, a throw from a
  // read-then-insert implementation -- as if it were a legitimate refusal, so a
  // broken non-transactional admission where one child wins and nineteen die
  // still reports "exactly one holder".
  const results = await Promise.all(kids);
  const unrecognised = results.filter(r => r.out !== "HELD" && r.out !== "no");
  check(unrecognised.length === 0,
    "control: all 20 contenders completed with a recognised answer, so a crash cannot read as a refusal",
    JSON.stringify(unrecognised.slice(0, 3)));
  const crashed = results.filter(r => r.code !== 0);
  check(crashed.length === 0,
    "control: and none of them exited non-zero",
    JSON.stringify(crashed.slice(0, 3).map(r => ({ code: r.code, err: String(r.err).slice(0, 120) }))));
  const held = results.filter(r => r.out === "HELD").length;
  check(held === 1, `exactly one of 20 racing processes holds the last slot (got ${held})`);
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
