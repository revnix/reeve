// A sandbox canary that failed must reach a phone, and must keep standing.
//
// The founder's page list names three identities that may interrupt a human. Two
// are raised somewhere. `builder:sandbox:canary-failed` existed only inside a
// comment in `build/dash.mjs`: nothing minted it, so the one condition under
// which NOTHING may dispatch reached the daily digest and never a phone.
//
// The assertions here are about the tick, driven through the real `tick()` with
// a real store, because the defect was never in a function that could be called
// in isolation -- it was that no caller raised anything. A unit test over a
// helper would have passed against the broken tree.
//
// THE STANDING HALF IS THE HALF THAT IS EASY TO GET WRONG. Containment is
// measured only when a worker task actually wants dispatching, so a quiet tick
// runs no canary at all -- and `announceable` treats an escalation absent from a
// complete tick as resolved. An escalation raised only where the measurement
// happens would therefore announce CLEARED on the next quiet tick, for a sandbox
// nobody re-measured. That is why several of these run more than one tick.
import { run } from "./fixtures/tick-harness.mjs";
import { rmSync } from "node:fs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const PAGE = "builder:sandbox:canary-failed";
// The verdict shape the daemon really receives: `measureContainment` returns the
// canary's own result beside the credential answer. A fixture carrying only
// `credentialRead` cannot exhibit anything here.
const openWith = (canary) => ({ credentialRead: "open", why: `sandbox canary ${canary.id} failed: ${canary.why}`,
                                canary, keychain: { measured: true, items: [], why: null } });
// Takes either a run() result or a single tick's result, so a multi-tick
// scenario can ask the same question of one tick as of the last.
const has = (x, key) => [...((x.r ?? x).escalations?.keys?.() ?? [])].some(k => k.startsWith(key));

// ── the control comes first ───────────────────────────────────────────────────
//
// Its expected answer is an ABSENCE, and an absence proves nothing on its own:
// a harness that never reaches the canary branch at all would satisfy it. It is
// here so the positive cases below are known to be measuring the difference
// between a passing canary and a failing one, rather than the difference between
// a wired fixture and an unwired one.
{
  const out = await run({ containment: { credentialRead: "closed", why: "contained",
                                         canary: { ok: true, id: "cn-1", why: null },
                                         keychain: { measured: true, items: [], why: null } } });
  check(!has(out, PAGE), "control: a canary that PASSED raises no page",
    `escalations were: ${out.esc}`);
}

// ── a canary that ran and failed pages ────────────────────────────────────────
{
  const out = await run({ containment: openWith({ ok: false, id: "cn-2", why: "the worker read the decoy" }) });
  check(has(out, PAGE), "a canary that ran and FAILED raises the page identity",
    `escalations were: ${out.esc}`);
  check(out.esc.includes("cn-2"),
    "the page names WHICH canary failed, so a second failure under a new policy is a new page",
    `escalations were: ${out.esc}`);
  // THE WHOLE LINE, not just the reason. The containment verdict's own `why`
  // already carries the canary's reason, and the dispatch refusal logs that --
  // so asserting the reason appears ANYWHERE in the log passed with this line
  // deleted. Measured: the sweep reported NOT_CAUGHT for exactly that stub.
  check(out.log.includes("canary cn-2 FAILED — the worker read the decoy"),
    "the REASON is in the log rather than in the key, because the key is what the phone renders",
    "a reason that moves between runs of one broken sandbox would retire and re-raise the same fault");
}

// ── and it STANDS across a tick that measured nothing ─────────────────────────
{
  // Two ticks against one ctx. The second carries no canary in its verdict --
  // exactly what a tick that wanted no worker produces -- so it re-raises from
  // the standing value or it does not raise at all.
  // THE SECOND VERDICT CARRIES NO CANARY. Passing one verdict for both ticks
  // re-measured the same failing canary on tick two, so the standing value was
  // never what raised it and the stub that removes the standing raise stayed
  // green -- the sweep reported NOT_CAUGHT, which is what a fixture that cannot
  // exhibit the defect looks like from outside.
  const quiet = { credentialRead: "closed", why: "contained",
                  keychain: { measured: true, items: [], why: null } };
  const out = await run({ containment: [openWith({ ok: false, id: "cn-3", why: "no sandbox" }), quiet], ticks: 2 });
  check(has(out.all[0], PAGE), "control: the first tick raised it, so the second tick is the question",
    `first tick's escalations were: ${[...(out.all[0].escalations?.keys?.() ?? [])].join(" | ")}`);
  check(!("canary" in quiet), "control: the second tick's verdict carries no canary, so nothing re-measured it");
  check(out.all.length === 2, "control: two ticks really ran", `ran ${out.all.length}`);
  check(has(out, PAGE),
    "the page still stands on a second tick, so a quiet tick cannot announce it CLEARED",
    `second tick's escalations were: ${out.esc}`);
}

// ── and it survives a RESTART, which ctx cannot ──────────────────────────────
//
// The first version of this kept the standing failure on `ctx`, and review found
// the hole: `bin/reeve` builds a fresh context per process, so a daemon restart
// or a one-shot `reeve tick` arrives with an empty latch while the escalation ROW
// is still in the store. The next complete tick then finds that row standing and
// absent from the tick, and RETIRES it -- a restart announcing that a sandbox
// nobody re-measured is fine.
//
// Two runs, two ctx objects, one store. That is what a restart is.
{
  const first = await run({ containment: openWith({ ok: false, id: "cn-6", why: "the worker read the decoy" }),
                            keepDir: true });
  check(has(first, PAGE), "control: the first process raised the page",
    `escalations were: ${first.esc}`);

  const quiet = { credentialRead: "closed", why: "contained",
                  keychain: { measured: true, items: [], why: null } };
  const after = await run({ containment: quiet, dbPath: first.dbPath });
  check(after.ctx.db !== first.ctx.db, "control: the second run really is a different context");
  check(has(after, PAGE),
    "the page survives a RESTART, because the row is the latch and not the process",
    `the restarted process's escalations were: ${after.esc}`);
  rmSync(first.dir, { recursive: true, force: true });
}

// ── a canary that PASSES afterwards clears it ─────────────────────────────────
//
// Clearing has to be possible, or the identity is a latch a human can only
// silence by restarting the daemon -- and an operator who is never told a fault
// is over cannot tell "resolved" from "reeve stopped looking".
{
  const failed = { ok: false, id: "cn-4", why: "the worker read the decoy" };
  const contained = { credentialRead: "closed", why: "contained",
                      canary: { ok: true, id: "cn-4", why: null },
                      keychain: { measured: true, items: [], why: null } };
  // ONE VERDICT PER TICK: it fails, then the same canary passes.
  const out = await run({ containment: [openWith(failed), contained], ticks: 2 });
  check(has(out.all[0], PAGE), "control: the first tick really did raise it, so the clear below is a change",
    `first tick's escalations were: ${[...(out.all[0].escalations?.keys?.() ?? [])].join(" | ")}`);
  check(!has(out, PAGE), "a canary that passes afterwards clears the page",
    `escalations after the passing tick were: ${out.esc}`);
}

// ── the two cases that are NOT a failed sandbox ───────────────────────────────
{
  const skipped = await run({ containment: openWith({ ok: false, id: "cn-5", why: "not run: containment is already open for a cheaper reason", skipped: true }) });
  check(!has(skipped, PAGE),
    "a SKIPPED canary raises no page: it never ran, and the fault is the cheaper reason",
    `escalations were: ${skipped.esc}`);

  const noId = await run({ containment: openWith({ ok: false, id: null, why: "no CLI version or sandbox block to run a canary under" }) });
  check(!has(noId, PAGE),
    "a canary with no id raises no page: there was nothing to run one under, which is not a sandbox that stopped containing",
    `escalations were: ${noId.esc}`);
  // ...and the generic identity still covers both, so neither goes unsaid.
  check([...(noId.r.escalations?.keys?.() ?? [])].some(k => k === "guardian:containment:open"),
    "control: dispatch is still refused and said, by the generic containment identity",
    `escalations were: ${noId.esc}`);
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
