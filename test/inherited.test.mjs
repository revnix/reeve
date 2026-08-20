// "Inherited" meant "a check with the same NAME is also failing on the base".
//
// Repositories run one job over many tests, so "Browser tests" failing on main for
// one reason and failing on a pull request for a completely different reason read
// as the same failure. reeve would then refuse to fix a genuine regression the PR
// had introduced, on the grounds that main was already broken — and say so
// confidently.
//
// Both mistakes are costly and in opposite directions: a false INHERITED leaves a
// regression unfixed, and a false CAUSED sends a worker to repair something that
// was never the PR's doing, inside the PR, which hides where it came from. So
// where the causes cannot be compared, this reports UNVERIFIED rather than
// picking the more convenient of the two.
import { inheritedOrCaused } from "../src/github/reconciler.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const row = (name, id) => ({ name, id, conclusion: "failure", state: "completed", source: "check_run" });

// Everything the real function reaches for, injected.
const io = ({ baseRows, causes }) => ({
  pinBase: () => ({ ok: true, sha: "b".repeat(40) }),
  readBase: () => ({ ok: true, rows: baseRows }),
  resolveCause: (_nwo, r) => causes[r.id] ?? { ok: false, why: "no cause" },
});

const SAME = { ok: true, job: "Browser tests", step: "e2e", cause: [{ where: "a.spec.ts:3", message: "timeout" }] };
const OTHER = { ok: true, job: "Browser tests", step: "e2e", cause: [{ where: "z.spec.ts:9", message: "null is not an object" }] };

// --- the defect ---------------------------------------------------------------
{
  const r = inheritedOrCaused("o/r", "main", [row("Browser tests", "H")],
    io({ baseRows: [row("Browser tests", "B")], causes: { H: OTHER, B: SAME } }));
  check(r.verdict === "CAUSED",
    "the same job failing for a DIFFERENT reason is caused by the PR, not inherited", JSON.stringify(r));
  check(r.caused.includes("Browser tests"), "and is named as such", JSON.stringify(r.caused));
}
{
  const r = inheritedOrCaused("o/r", "main", [row("Browser tests", "H")],
    io({ baseRows: [row("Browser tests", "B")], causes: { H: SAME, B: SAME } }));
  check(r.verdict === "INHERITED",
    "control: the same job failing for the SAME reason really is inherited", JSON.stringify(r));
}

// --- the cheap filter still works ---------------------------------------------
{
  const r = inheritedOrCaused("o/r", "main", [row("Lint", "H")],
    io({ baseRows: [row("Browser tests", "B")], causes: {} }));
  check(r.verdict === "CAUSED",
    "a name that does not fail on the base at all needs no cause probe", JSON.stringify(r));
}

// --- what happens when it cannot tell -----------------------------------------
{
  const r = inheritedOrCaused("o/r", "main", [row("Browser tests", "H")],
    io({ baseRows: [row("Browser tests", "B")], causes: { H: SAME } }));   // base cause unresolvable
  check(r.verdict === "UNVERIFIED",
    "when a cause cannot be resolved it says UNVERIFIED rather than guessing", JSON.stringify(r));
  check((r.unverified ?? []).includes("Browser tests"), "naming what it could not compare", JSON.stringify(r));
}
{
  // Probing costs API calls, so it is bounded — and the bound must be VISIBLE,
  // or a truncated comparison reads as a complete one.
  const rows = ["a", "b", "c", "d", "e"].map(n => row("Browser tests " + n, "H" + n));
  const baseRows = rows.map(r => ({ ...r, id: "B" + r.id.slice(1) }));
  const causes = Object.fromEntries(rows.flatMap(r => [[r.id, SAME], ["B" + r.id.slice(1), SAME]]));
  const r = inheritedOrCaused("o/r", "main", rows, { ...io({ baseRows, causes }), maxProbes: 2 });
  check((r.unverified ?? []).length === 3,
    "beyond the probe budget the remainder is UNVERIFIED, not assumed", JSON.stringify(r));
}

// --- the falsy-name rule must survive -----------------------------------------
{
  const r = inheritedOrCaused("o/r", "main", [row("", "H"), row("Lint", "H2")],
    io({ baseRows: [], causes: {} }));
  check(r.dropped === 1, "a nameless failing row is still dropped and counted", JSON.stringify(r));
  check(!r.caused.includes(""), "and never reaches a fixer as an empty name", JSON.stringify(r.caused));
}

// --- an unreadable base is not an answer --------------------------------------
{
  const r = inheritedOrCaused("o/r", "main", [row("Lint", "H")],
    { pinBase: () => ({ ok: false, why: "no ref" }) });
  check(r.verdict === "UNKNOWN", "an unpinnable base is UNKNOWN", JSON.stringify(r));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
