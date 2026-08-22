// A reviewer's refusal is one shape per REASON, not one per reviewer.
//
// The profile carries a single `refusal` regex per bot, and the schema comment
// beside it says exactly why it is required: "a rate-limited CodeRabbit reports
// byte-identical to 'found no problems' unless something counts refusals". The
// mechanism is right. The seeded patterns were one shape short of it, for two
// separate bots, because each bot spells each REASON differently -- quota,
// transient error, rate limit, already-reviewed -- and only one spelling per bot
// was ever observed when the pattern was written.
//
// What that costs: a refusal that matches nothing classifies as null, which
// derive.mjs treats as "a trigger command, a human comment, chatter". A bot that
// crashed and a bot that has not spoken become the same reading, and those want
// opposite responses -- re-request one, keep waiting on the other.
//
// The bodies below are the real ones, byte for byte, from nextlyhq/nextly #1137.
// See PROVENANCE.md. They are fixtures rather than strings in this file because
// a retyped copy of the Codex error loses its curly quotes and a summarised copy
// of the CodeRabbit rate-limit loses its machine markers -- and the markers are
// the most stable discriminator either body has.
import { compose } from "../src/init.mjs";
import { classifyObservation } from "../src/review/derive.mjs";
import { readFileSync } from "node:fs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const body = (f) => readFileSync(new URL(`./fixtures/reviewer-bodies-2026-08-22/${f}`, import.meta.url), "utf8");

// The patterns AS SHIPPED. Driving compose() rather than copying the literals
// means this test fails when the seed regresses, which a copy would not.
const { profile } = compose({
  schemaVersion: 1,
  project: { kind: "product" },
  identity: { key: "o/r", defaultBranch: "main", visibility: "private" },
  authority: { permission: "admin", policy: "propose_only" },
  state: {},
  reviewers: [{ login: "chatgpt-codex-connector" }, { login: "coderabbitai" }],
}, []);
const rev = Object.fromEntries((profile.reviewers ?? []).map(r => [r.login, r]));

check(!!rev["chatgpt-codex-connector"] && !!rev["coderabbitai"],
  "control: compose() seeds both reviewers, so this test is reading the shipped patterns",
  JSON.stringify(Object.keys(rev)));

// classifyObservation resolves an abbreviated sha to a full one. The clean
// fixture names 00f2867b31; anything else is a revision reeve never pinned.
const resolve = (abbrev) => (abbrev === "00f2867b31" ? "00f2867b31" + "0".repeat(30) : null);
const outcomeOf = (login, text) =>
  classifyObservation({ kind: "issue_comment", payload: { body: text } }, rev[login], resolve)?.outcome ?? "null";

// ── the two defects, on real bodies ──────────────────────────────────────────
{
  const o = outcomeOf("chatgpt-codex-connector", body("codex-errored.txt"));
  check(o === "refusal",
    "Codex 'Something went wrong / Unknown error' classifies as a refusal, not as chatter",
    `got ${o} -- a crashed review and a silent one are the same reading unless this is a refusal`);
}
{
  const o = outcomeOf("coderabbitai", body("coderabbit-limit-reached.txt"));
  check(o === "refusal",
    "CodeRabbit 'Review limit reached' classifies as a refusal",
    `got ${o} -- this is the shape whose PROSE differs from the configured string`);
}

// ── the controls, without which the two above are satisfied by "refuse all" ──
{
  const o = outcomeOf("coderabbitai", body("coderabbit-rate-limited.txt"));
  check(o === "refusal", "control: the shape that already worked still works", `got ${o}`);
}
{
  const o = outcomeOf("chatgpt-codex-connector", body("codex-clean.txt"));
  check(o === "clean",
    "control: a real Codex CLEAN pass is still clean, and is not swallowed by the widened refusal",
    `got ${o} -- refusal is tested BEFORE clean in derive.mjs, so a greedy refusal silently eats every pass`);
}

// ── synthetic, and labelled: CodeRabbit was rate-limited across #1135-#1137,
//    so no real clean or findings body exists to capture.
{
  const o = outcomeOf("coderabbitai", "**Actionable comments posted: 7**\n\nfindings follow");
  check(o === "null", "SYNTHETIC control: a findings summary is not read as a refusal", `got ${o}`);
}
{
  const o = outcomeOf("coderabbitai", "**Actionable comments posted: 0**\n\nnothing to flag");
  check(o === "unbound_clean",
    "SYNTHETIC control: a CodeRabbit clean still reaches the clean branch (unbound, as it has no commitPattern)",
    `got ${o}`);
}

// ── the invariant, stated so the next reviewer added inherits it ─────────────
// Every seeded reviewer must recognise more than one refusal reason. This is the
// generalisation the two defects share: a single-string refusal is one-shape-
// short by construction, not by oversight.
for (const [login, r] of Object.entries(rev)) {
  const alternatives = String(r.refusal).split("|").filter(Boolean).length;
  check(alternatives >= 2,
    `${login}'s refusal pattern covers more than one reason`,
    `refusal=${JSON.stringify(r.refusal)} -- each bot spells quota, transient error and rate limit differently`);
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
