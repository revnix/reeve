// A query named a status the schema forbids, so it could only ever return
// nothing -- and nothing rendered as "nothing needs you".
//
// `readState` asked for `kind='decision' AND status='pending'` while node.status
// is CHECK-constrained to open/ready/running/blocked/review/done/decided/refuted/
// cancelled/dead_letter. 'pending' has never been storable. The band meant to
// surface founder decisions was structurally incapable of showing one, and looked
// exactly like a band with nothing in it.
//
// This is the cheap guard for the class rather than the instance: any status
// literal compared in a query must be one the schema permits.
import { readFileSync } from "node:fs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const read = f => readFileSync(new URL(f, import.meta.url), "utf8");
const schema = read("../src/db/schema.sql");

// PER TABLE, not unioned. The first version of this guard collected every status
// CHECK in the file into one set -- and 'pending' IS valid on `outbox`, just never
// on `node`, so the union would have passed the exact bug it was written to catch.
// A check that widens its own input reports success.
const vocab = new Map();
// `) STRICT, WITHOUT ROWID;` must match too. Requiring `) STRICT;` silently
// skipped every table declared that way -- including outbox, the one holding the
// status that made the union version of this guard useless. A guard that narrows
// its own input is the defect it exists to catch.
for (const m of schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\)\s*STRICT[^;]*;/g)) {
  const [, table, body] = m;
  const c = body.match(/status\s+TEXT[^,]*?CHECK\s*\(\s*status\s+IN\s*\(([\s\S]*?)\)\s*\)/);
  if (c) vocab.set(table, new Set([...c[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1])));
}

// Derived from the schema, not a number I picked: count how many tables actually
// declare a CHECK-constrained status, and require the parser to have found all of
// them. A magic minimum would pass while quietly missing one.
const EXPECTED = (schema.match(/status\s+TEXT[^,]*?CHECK\s*\(\s*status\s+IN/g) ?? []).length;
check(vocab.size === EXPECTED && EXPECTED > 0,
  `control: parsed all ${EXPECTED} status vocabularies (${[...vocab.keys()].join(", ")})`,
  "a parser that sees fewer tables than the schema declares cannot judge the ones it missed");

check(vocab.get("node")?.has("open"), "control: node permits 'open'", [...(vocab.get("node") ?? [])].join(","));
check(!vocab.get("node")?.has("pending"),
  "control: node has never permitted 'pending' — the defect was real", [...(vocab.get("node") ?? [])].join(","));
check(vocab.get("outbox")?.has("pending"),
  "control: and 'pending' IS valid elsewhere, which is why a unioned guard would have missed it",
  [...(vocab.get("outbox") ?? [])].join(","));

// Each query's status literal, attributed to the table it reads.
const sources = ["../src/status.mjs", "../src/db/ops.mjs", "../src/daemon.mjs", "../src/pr.mjs", "../src/db/reconcile.mjs"];
const bogus = [];
let seen = 0;
for (const f of sources) {
  let text; try { text = read(f); } catch { continue; }
  for (const m of text.matchAll(/FROM\s+(\w+)[\s\S]{0,200}?status\s*=\s*'([a-z_]+)'/gi)) {
    const [, table, status] = m;
    if (!vocab.has(table)) continue;
    seen++;
    if (!vocab.get(table).has(status)) bogus.push(`${table}.status='${status}' in ${f}`);
  }
}

check(seen > 0, `control: ${seen} table-attributed status comparison(s) found`,
  "finding none would make the assertion below prove nothing");
check(bogus.length === 0,
  "every status a query compares against is one THAT TABLE can store",
  bogus.join(", ") +
  "\n        a status the table forbids makes its query permanently empty, which reads as 'nothing to report'");

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
