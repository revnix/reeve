// open() must produce the complete schema. The fact table used to be created by
// the migrator instead, so a database opened without migrating had no fact table
// and every evidence write failed at runtime rather than at open.
import { open } from "../src/db/ops.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const db = open(join(mkdtempSync(join(tmpdir(), "reeve-")), "s.db"));
const names = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
).all().map(r => r.name).sort();

const required = ["checkpoint","edge","event","fact","inbox","node","outbox","run","task_exec"];
let fail = 0;
for (const t of required) {
  const ok = names.includes(t);
  console.log(`${ok ? "PASS" : "FAIL"}  open() creates ${t}`);
  if (!ok) fail++;
}
// A fact write must succeed against a freshly opened database, not only a migrated one.
try {
  db.exec("INSERT INTO node(id,kind,title,created_at,updated_at) VALUES('t','task','t',0,0)");
  db.prepare("INSERT INTO fact(node_id,evidence,observed_at) VALUES(?,?,unixepoch())").run("t","cmd -> out");
  console.log("PASS  a fact writes against a freshly opened database");
} catch (e) {
  console.log("FAIL  a fact writes against a freshly opened database:", e.message);
  fail++;
}
console.log(`\n${fail ? `failed=${fail}` : "all green"}`);
process.exit(fail ? 1 : 0);
