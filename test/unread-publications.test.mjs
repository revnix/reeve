// A publication record reeve can't read (#242, from #239's review).
//
// Reeve reads what it has standing from its own log, per pull request and check
// name. A `pr.published` record whose payload can't be parsed may be a PASS
// under either name at any head, so it stands until a merge ends everything
// standing there: a later record under some name at some head, even one that
// can't be read either, says nothing of what it was.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { open } from "../src/db/ops.mjs";
import { standingPasses } from "../src/daemon.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const store = () => open(join(tempDir("reeve-unread-"), "s.db"));

test("a publication record reeve can't read stays standing until a merge, whatever is recorded after it there", () => {
  const db = store();
  const put = (op, payload) => db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(1, "daemon", op, "pr:9", payload);
  put("pr.published", "{not json");
  // A later record at #9, under another name: it says nothing of what the unreadable one was.
  put("pr.withdrawn", JSON.stringify({ head: "d".repeat(40), name: "ops/merge-policy (shadow)", id: 3, why: "moved on" }));
  assert.ok(standingPasses(db).some(x => x.pr === 9 && x.unread), JSON.stringify(standingPasses(db)));
  put("pr.merged", JSON.stringify({ head: "d".repeat(40) }));
  assert.ok(!standingPasses(db).some(x => x.pr === 9), "control: a merge ends everything standing there");
  db.close();
});

test("a publication record reeve can't read stays standing past a later record it can't read either", () => {
  const db = store();
  const put = (op, payload) => db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(1, "daemon", op, "pr:9", payload);
  put("pr.published", "{not json");
  put("pr.withdrawn", "{not json either");
  assert.ok(standingPasses(db).some(x => x.pr === 9 && x.unread), JSON.stringify(standingPasses(db)));
  db.close();
});
