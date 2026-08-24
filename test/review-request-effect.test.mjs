// REQUEST_REVIEW stops being a worker task.
//
// It posts each reviewer's trigger comment verbatim. No judgement, no reading of
// the diff, nothing a model is needed for -- it was a paid dispatch only because
// reeve could not act on GitHub itself, and the worker's own `gh` was then refused
// when it tried. Now reeve enqueues the comment and the drainer posts it.
//
// Two things have to hold: the gate is OFF unless a profile says otherwise, and a
// repeated tick at one head must not ask twice while a NEW head must ask again.
import { reviewActionsOn } from "../src/daemon.mjs";
import { open, tx, enqueue } from "../src/db/ops.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// --- the gate is off unless a profile says otherwise --------------------------
{
  check(reviewActionsOn({}) === false, "a profile that says nothing leaves review actions OFF", "");
  check(reviewActionsOn({ watch: {} }) === false, "and so does an empty watch block", "");
  check(reviewActionsOn(undefined) === false, "and so does no profile at all", "");
  check(reviewActionsOn(null) === false, "and null", "");
  // Not truthy -- exactly true. A string "false" from a hand-edited profile is the
  // shape that turns a safety flag on by accident.
  for (const v of ["true", "false", 1, {}, []])
    check(reviewActionsOn({ watch: { reviewActions: v } }) === false,
      `a ${JSON.stringify(v)} does not arm it — only the boolean does`, "");
  check(reviewActionsOn({ watch: { reviewActions: true } }) === true,
    "control: the boolean true does arm it", "");
}

// --- asking twice at one head is one ask; a new head is a new one -------------
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-rr-"));
  const db = open(join(dir, "state.db"));
  // The key the daemon builds, reproduced here so the property is asserted rather
  // than the daemon's private string.
  const keyFor = (pr, head, login) => `review-request:o/r:${pr}:${head}:${login}`;
  const ask = (pr, head, login) => tx(db, () => enqueue(db, {
    idemKey: keyFor(pr, head, login), kind: "gh.pr.comment",
    args: { nwo: "o/r", pr, body: `@${login} review` },
  }));

  const first = ask(1, "aaa", "codex");
  check(first !== null, "the first ask at a head enqueues", String(first));
  const repeat = ask(1, "aaa", "codex");
  check(repeat === null, "a repeated tick at the SAME head enqueues nothing", String(repeat));
  const moved = ask(1, "bbb", "codex");
  check(moved !== null, "a NEW head is a new round and asks again", String(moved));
  const other = ask(1, "aaa", "coderabbit");
  check(other !== null, "and a second reviewer at the same head is its own effect", String(other));

  const rows = db.prepare(`SELECT count(*) n FROM outbox WHERE kind='gh.pr.comment'`).get().n;
  check(rows === 3, "so three effects exist, not four and not one", String(rows));
  // The enqueue must be a real row with the body in it, or the dedup above is
  // measuring an empty table.
  const one = db.prepare(`SELECT args FROM outbox WHERE idem_key=?`).get(keyFor(1, "aaa", "codex"));
  check(JSON.parse(one.args).body === "@codex review", "control: carrying the trigger verbatim", one.args);

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
