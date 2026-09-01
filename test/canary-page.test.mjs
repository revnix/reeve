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
import { run, EVAL } from "./fixtures/tick-harness.mjs";
import { CANARY_PAGE } from "../src/daemon.mjs";
import { open } from "../src/db/ops.mjs";
import { rmSync } from "node:fs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// THE IDENTITY THE DESIGN ASSIGNS THIS DAEMON. §4.4 splits it by raising process
// -- `builder:sandbox:canary-failed` from the builder, `guardian:...` from a
// guardian daemon -- and §11.7 forbids either from writing the other's. Imported
// rather than spelled, so a rename cannot leave this suite asserting the old one.
const PAGE = CANARY_PAGE;
// The verdict shape the daemon really receives: `measureContainment` returns the
// canary's own result beside the credential answer. A fixture carrying only
// `credentialRead` cannot exhibit anything here.
const openWith = (canary) => ({ credentialRead: "open", why: `sandbox canary ${canary.id} failed: ${canary.why}`,
                                canary, keychain: { measured: true, items: [], why: null } });
// Takes either a run() result or a single tick's result, so a multi-tick
// scenario can ask the same question of one tick as of the last.
const has = (x, key) => [...((x.r ?? x).escalations?.keys?.() ?? [])].some(k => k.startsWith(key));

// ── the identity itself, spelled out ────────────────────────────────────────
//
// THE ONE PLACE A LITERAL BELONGS. Everything else in this file imports
// `CANARY_PAGE`, which is right -- a rename must not leave the suite asserting a
// name nothing raises. But an imported constant also FOLLOWS a rename, so nothing
// here could notice the identity being changed to the builder's. The design fixes
// this name, so the test states it.
{
  check(PAGE === "guardian:sandbox:canary-failed",
    "the identity is the GUARDIAN's, because this daemon raises it in its own store",
    `it is ${JSON.stringify(PAGE)}; §4.4 assigns builder:sandbox:canary-failed to the builder and guardian:sandbox:canary-failed to a guardian daemon`);
  check(!PAGE.startsWith("builder:"),
    "and it is not a builder identity, which this process may not write",
    "§11.7: the guardian never writes a builder identity and the builder never writes a guardian one, because announceable runs in the process that owns the store it reads");
}

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
  check(out.esc.includes(PAGE) && !out.esc.includes("cn-2"),
    "the KEY is the bare identity, with the canary id kept out of it",
    `a key that moves when the policy changes is retired and re-raised, which is two pushes for one fault; escalations were: ${out.esc}`);
  check(out.log.includes("canary cn-2 FAILED"),
    "and the log names WHICH canary, which is where the detail lives until an alert body exists",
    `log did not name the canary`);
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

// ── a pass clears it even when the tick did not finish looking ───────────────
//
// `announceable` retires a standing cause by inferring repair from ABSENCE, and it
// refuses to infer it on a tick that did not finish -- `complete` is false whenever
// one pull request could not be evaluated. That rule is right for causes derived
// from pull requests and wrong for this one: the canary is a repo-wide measurement
// that does not depend on any pull request. Without an explicit retirement, one
// unreadable PR on the tick that PROVED the sandbox healthy leaves the row standing,
// the next quiet tick re-raises it from the store, and the page never clears again.
// Review found this; it is the reason the passing branch retires the row itself.
{
  const first = await run({ containment: openWith({ ok: false, id: "cn-7", why: "the worker read the decoy" }),
                            keepDir: true });
  check(has(first, PAGE), "control: the page is standing before the passing tick",
    `escalations were: ${first.esc}`);

  const contained = { credentialRead: "closed", why: "contained",
                      canary: { ok: true, id: "cn-7", why: null },
                      keychain: { measured: true, items: [], why: null } };
  // ONE PULL REQUEST THIS TICK COULD NOT READ. `evaluated.size === prs.length` is
  // what the tick hands `announceable` as `complete`, so this is a tick that did
  // not finish looking -- the condition under which absence may not be read as
  // repair. Two PRs listed is NOT that on its own: the first version of this
  // scenario listed two and evaluated both, `complete` was true, `announceable`
  // cleared the row for its own reasons, and the sweep reported the stub
  // NOT_CAUGHT. The fixture has to make a read FAIL.
  const second = await run({ containment: contained, dbPath: first.dbPath,
                             openPrs: () => [42, 43],
                             evaluate: ({ pr }) => (pr === 43 ? { ok: false, why: "unreadable in this fixture" } : EVAL),
                             keepDir: true });
  // MATCHED ON THE REASON THIS FIXTURE SUPPLIED, not on the daemon's wording. The
  // override is consulted for the ANCHOR probe before the evaluation proper, so
  // the refusal surfaces as "could not read" rather than "could not evaluate" --
  // two branches, one outcome, and a control pinned to one of the two phrasings
  // fails while the thing it is checking is working.
  check(second.log.includes("#43") && second.log.includes("unreadable in this fixture"),
    "control: one pull request really was unreadable, so the tick could not be complete",
    second.log.split("\n").filter(l => l.includes("#43")).join(" | "));

  const store = open(first.dbPath);
  const rows = store.prepare("SELECT why FROM escalation").all().map(r => r.why);
  store.close();
  // THE CONTROL AND THE ASSERTION ARE THE SAME TICK. `guardian:containment:open`
  // was raised by the first process and is absent from this one, exactly like the
  // canary page -- so if `announceable` had been willing to retire on absence here
  // it would have taken both. It kept that one, which is the proof the tick was
  // incomplete; the canary page went anyway, which is the explicit retirement.
  check(rows.includes("guardian:containment:open"),
    "control: announceable did NOT retire the other absent cause, because the tick was incomplete",
    `rows were: ${rows.join(" | ")}`);
  check(!rows.includes(PAGE),
    "a canary that PASSED retires the page even on a tick that did not finish looking",
    `the row survived, so the next quiet tick would re-raise it and the page would never clear; rows were: ${rows.join(" | ")}`);

  rmSync(first.dir, { recursive: true, force: true });
  rmSync(second.dir, { recursive: true, force: true });
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
