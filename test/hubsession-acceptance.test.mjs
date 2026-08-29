// The property issue #50 exists to establish, asserted against the real tick.
//
// THE CLAIM: every scheduler operation acts on the hub that is current AT THAT
// MOMENT, not on one read earlier in the tick. `restoreHub` replaces the hub
// FILE while a tick is running, so a handle taken earlier can address an
// unlinked inode -- a claim then reserves capacity in a database nobody else can
// see while the restored scheduler admits its own.
//
// WHY THIS SHAPE, and not the two obvious ones:
//
//   NOT a name grep. `!/\bopenHub\b/` asserts "this identifier does not appear".
//   The claim needed is "this authority is not reachable", and a rename, a
//   re-export or a handle arriving as a parameter all defeat the first while
//   leaving the second false.
//
//   NOT an unreachability assertion. "The raw handle cannot be obtained" passes
//   for three different reasons -- a TypeError from a missing argument, an
//   unrelated throw, or genuine unreachability -- and only one is the property.
//   It also has no natural positive control: nothing distinguishes "unreachable"
//   from "the code never ran".
//
// PROVENANCE has one. The fixture replaces the hub underneath a running tick, at
// a moment IT chooses, and then asks which database each later operation acted
// on. Both halves are checkable: that operations happened at all, and that they
// happened on the current hub.
//
// FOUR EARLIER FORMULATIONS PASSED WHILE THE DEFECT WAS PRESENT, and the reasons
// are worth keeping:
//
//   "is this handle one the getter ever handed out?" -- a RETAINED handle is
//   still in that set.
//
//   "is it from the most recent acquisition?" -- a retaining session stops
//   ASKING, so the most recent acquisition becomes the retained one. The
//   instrument's baseline moved with the defect it was measuring.
//
//   two more failed because the stub did not reach the path it claimed to break.
//
// The anchor is therefore the FIXTURE'S own clock, which nothing the tick does
// can move.

import { hubSession } from "../src/build/hubsession.mjs";
import { run } from "./fixtures/tick-harness.mjs";
import { openHub } from "../src/build/hubdb.mjs";
import { openHubAsGuest } from "../src/build/hubguest.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

/** Which generation of the hub an operation acted on. */
const GEN = Symbol("generation");
const OPS = new Set(["providerClaim", "providerRelease", "providerBind", "providerHeartbeat",
                     "noteRateLimit", "reapProvider", "cancelQueued", "queuedRequests"]);

// ── THE NEGATIVE CONTROL, first ─────────────────────────────────────────────
//
// Before asking whether the tick satisfies the property, establish that the
// check can FAIL. A session that retains its first handle is the pre-#50 defect
// in one line, and the same reading must catch it. Without this the whole file
// could be passing because it measures nothing.
{
  const generations = [{ [GEN]: 1 }, { [GEN]: 2 }];
  let current = 0;
  const getter = () => ({ hub: generations[current], why: null });
  const seen = [];
  const overrides = { op: (h) => { seen.push(h[GEN]); return { ok: true }; } };

  const sound = hubSession({ getter, onFault: () => {}, overrides });
  sound.perform("op", null, {}, () => {});
  current = 1;                                   // the restore
  sound.perform("op", null, {}, () => {});

  // A session that keeps the first handle it is given.
  let retained;
  const defective = hubSession({
    getter: () => ({ hub: (retained ??= generations[current]), why: null }),
    onFault: () => {}, overrides });
  current = 0; retained = undefined;
  defective.perform("op", null, {}, () => {});
  current = 1;                                   // the same restore
  defective.perform("op", null, {}, () => {});

  check(seen[0] === 1 && seen[1] === 2,
    "control: a sound session's operations follow the hub across a replacement", JSON.stringify(seen));
  check(seen[2] === 1 && seen[3] === 1,
    "control: and a RETAINING session's do not -- so this reading can fail", JSON.stringify(seen.slice(2)));
}

// ── THE PROPERTY, against the real tick ─────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-acceptance-"));
  const generation = (n) => {
    const p = join(dir, `hub${n}.db`);
    openHub(p).close();
    const g = openHubAsGuest(p);
    return new Proxy(g, { get: (t, k) => (k === GEN ? n : t[k]) });
  };
  const before = generation(1), after = generation(2);

  // THE RESTORE HAPPENS WHEN THE FIXTURE SAYS SO, on the tick's first queued
  // read. Anchoring to the tick's own behaviour -- "the most recent
  // acquisition", say -- lets a defect that suppresses acquisitions move the
  // anchor with it, which is how an earlier formulation passed while broken.
  let restored = false;
  const seams = [];
  await run({
    seams,
    hubGetter: () => ({ hub: restored ? after : before, why: null }),
    queuedRequests: () => { restored = true; return []; },
    providerBind: () => ({ ok: true, bound: 1 }),
  });

  let past = false, afterCount = 0;
  const stale = [];
  for (const s of seams) {
    if (past && OPS.has(s.op)) {
      afterCount++;
      if (s.args[0]?.[GEN] !== 2) stale.push(s.op);
    }
    if (s.op === "queuedRequests") past = true;
  }

  check(afterCount > 0,
    "vacuity: the tick performs scheduler operations AFTER the hub is replaced",
    `${afterCount} operation(s)`);
  check(stale.length === 0,
    "every operation after the replacement acted on the CURRENT hub, not the replaced one",
    stale.length ? `${[...new Set(stale)].join(", ")} acted on the pre-restore database` : "");

  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exitCode = fail ? 1 : 0;
