// §0's progress row and the code are two statements of ONE fact. This fails when
// they disagree, and deliberately does not say which is right.
//
// §0 exists so a volatile fact has one home. That does not stop the one home
// being wrong, and it was: one commit after the row was added to be the single
// source of which stages had landed, it said stage 4 had not started. Stage 4 had
// landed — out of order, because wiring the review projection gave FIX_FINDINGS
// its real thread list, which IS the stage §3.2 defines. A resumed session would
// have rebuilt finished work, and the single-source test was green throughout,
// because it polices whether a fact is stated TWICE and not whether it is true.
//
// The shape here is the one that catches a stale copy without anyone having to
// notice: do not write a better rule about the prose, write the COMPARISON. Each
// stage in §3.2 has a mechanical witness in the tree — a symbol that exists if
// and only if that stage was built. The row claims a set; the tree shows a set;
// the test fails if they differ. Raising or lowering a claim stays a considered
// act, because the test asserts agreement rather than any particular answer.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// The newest handoff, by filename sort — the same rule the single-source test
// uses, so the two cannot end up reading different documents.
const docs = join(root, "docs");
const newest = readdirSync(docs).filter(f => /^\d{4}-\d\d-\d\d-session-handoff\.md$/.test(f)).sort().pop();
check(Boolean(newest), "control: a handoff was found to read", String(newest));
const handoff = readFileSync(join(docs, newest), "utf8");

// One witness per stage, each tied to what §3.2 says that stage IS.
//
// A witness is a proxy, so it is chosen to be the thing that cannot exist unless
// the stage was built, and it is checked for existence rather than for shape.
const WITNESSES = [
  [1, "the fencing token", "src/db/schema.sql", /\blease_token\b/],
  [2, "the drainer and its first producer", "src/outbox/drain.mjs", /export async function drainOutbox\b/],
  [3, "SPILL onto the durable path", "src/outbox/effects.mjs", /["']gh\.issue\.create["']/],
  [4, "real thread details into FIX_FINDINGS", "src/daemon.mjs", /threads:\s*e\.threadDetails\b/],
];

const built = new Set();
for (const [n, what, file, re] of WITNESSES) {
  const path = join(root, file);
  // A witness whose FILE has gone is not evidence of absence — it is a witness
  // that has rotted, and reporting "not built" on it would be exactly the stale
  // reading this test exists to catch, arriving from the other direction.
  check(existsSync(path), `control: stage ${n}'s witness file is still there (${file})`, path);
  if (existsSync(path) && re.test(readFileSync(path, "utf8"))) built.add(n);
}
check(built.size >= 1, "control: at least one stage's witness matched, so the patterns still bind",
  `matched ${[...built].join(", ")}`);

// What §0 CLAIMS. Read from the row, not from anywhere else.
const row = /^\|\s*the durable-effect stages\s*\|([^|]*)\|/m.exec(handoff)?.[1] ?? "";
check(row.length > 0, "control: §0 has a durable-effect stages row to compare against", row.slice(0, 80));
const landedClause = /([^.]*\bhave landed\b[^.]*)\./i.exec(row)?.[1] ?? row;
const claimed = new Set([...landedClause.matchAll(/\b([1-4])\b/g)].map(m => Number(m[1])));
check(claimed.size >= 1, "control: and the row names at least one stage", landedClause.trim().slice(0, 80));

// THE COMPARISON. Neither side is authoritative here on purpose: if they differ,
// one of them is stale and a person decides which.
const only = (a, b) => [...a].filter(x => !b.has(x));
const claimedNotBuilt = only(claimed, built);
const builtNotClaimed = only(built, claimed);
check(claimedNotBuilt.length === 0 && builtNotClaimed.length === 0,
  "§0's stage row and the tree agree about which stages have landed",
  `§0 claims ${[...claimed].sort().join(", ") || "none"}; the tree shows ${[...built].sort().join(", ") || "none"}` +
  (claimedNotBuilt.length ? ` — claimed but no witness: ${claimedNotBuilt.join(", ")}` : "") +
  (builtNotClaimed.length ? ` — built but not claimed: ${builtNotClaimed.join(", ")}` : ""));

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
