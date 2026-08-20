// The screen must never present history as status, and must never report a rate
// from an empty sample.
import { spark, needsYou, render, statusline } from "../src/status.mjs";

let fail = 0;
const check = (n, got, want) => { const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) { console.log(`        got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); fail++; } };

const pr = (id, over = {}) => ({ id: `pr:${id}`, at: 1000, stale: false, state: "BLOCK", action: "WAIT", why: "x", ...over });
const st = (prs = [], runs = [], pending = []) => ({ prs, runs, pending });

// ── staleness ─────────────────────────────────────────────────────────────
// A PR that stopped appearing in ticks is closed or unwatched. Its last decision
// is history. Showing it as live is how a screen reports a state that has not
// been true for hours — which it did, with a reason that had already been fixed.
{
  const live = pr(1), old = pr(2, { stale: true, action: "ESCALATE", why: "ancient" });
  const screen = render({ nwo: "o/r", state: st([live, old]), health: {} });
  check("a stale row is absent from FLEET", screen.includes("#2"), false);
  check("a live row is present", screen.includes("#1"), true);
  check("a stale escalation does not reach NEEDS YOU", screen.includes("ancient"), false);
}

// ── shared causes ─────────────────────────────────────────────────────────
// Four PRs on a red base is ONE problem. Pushing it four times is how a channel
// gets muted, after which it is worse than nothing.
{
  const same = "the base branch is red";
  const n = needsYou(st([pr(1, { action: "ESCALATE", why: same }), pr(2, { action: "ESCALATE", why: same }),
                         pr(3, { action: "ESCALATE", why: same })]));
  check("a shared cause collapses to one row", n.length, 1);
  check("and names every PR it blocks", n[0].prs.join(" "), "#1 #2 #3");
  const mixed = needsYou(st([pr(1, { action: "ESCALATE", why: "a" }), pr(2, { action: "ESCALATE", why: "b" })]));
  check("distinct causes stay distinct", mixed.length, 2);
}

// ── an expired lease is something a person must see ────────────────────────
{
  const past = Math.floor(Date.now() / 1000) - 3600;
  const n = needsYou(st([], [{ task_id: "task:x", lane: "l", status: "leased", lease_expires_at: past }]));
  check("an expired lease reaches NEEDS YOU", n.some(x => x.kind === "lease"), true);
  const future = Math.floor(Date.now() / 1000) + 3600;
  const ok = needsYou(st([], [{ task_id: "task:y", lane: "l", status: "leased", lease_expires_at: future }]));
  check("a healthy lease does not", ok.some(x => x.kind === "lease"), false);
}

// ── the empty screen is the good outcome ──────────────────────────────────
{
  const screen = render({ nwo: "o/r", state: st(), health: {} });
  check("an empty NEEDS YOU says so, and states the target", screen.includes("target state: EMPTY"), true);
  check("an idle fleet says idle", screen.includes("(idle)"), true);
  // An unmeasured rate must never render as a number, least of all 100%.
  check("an unmeasured clean-merge rate is not a number", /clean-merge\s+not measurable/.test(screen), true);
}

// ── the statusline ────────────────────────────────────────────────────────
{
  const fakeDb = { prepare: () => ({ all: () => [] }) };
  const line = statusline(fakeDb, { nwo: "o/repo" });
  check("an empty statusline still names the repo", line.includes("repo"), true);
  check("and says idle rather than nothing", line.includes("idle"), true);
  check("with no warning when there is nothing to warn about", line.includes("NEEDS YOU"), false);
}

// ── the sparkline ─────────────────────────────────────────────────────────
check("an empty series renders nothing", spark([]), "");
check("all-clean renders the top block", spark([1, 1, 1]), "███");
check("all-dirty renders the bottom block", spark([0, 0, 0]), "▁▁▁");

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
