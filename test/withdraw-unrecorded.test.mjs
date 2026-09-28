// Withdraw, once, the results reeve published before it kept a record (#242).
//
// Versions of reeve before #239 kept no record of what they published, and older
// ones published shadow results as `neutral` under the enforcement check's own
// name. A required check reads `neutral` as passing, and #239 withdraws only
// what reeve recorded. Measured on 2026-09-26: 13 of the 16 most recently closed
// pull requests on the repository reeve watches that didn't merge still carried
// one. So before any rule requires the check, reeve withdraws its own results
// under that name at the head of every pull request that didn't merge, once, and
// `--enforce` refuses until it has.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../src/db/ops.mjs";
import { unmergedHeads } from "../src/pr.mjs";
import { withdrawUnrecorded, unrecordedWithdrawn } from "../src/unrecorded.mjs";
import { standingPasses } from "../src/daemon.mjs";
import { tempDir } from "./fixtures/temp.mjs";
import { statePathFor } from "../src/paths.mjs";
import { withDefaults } from "../src/profile/schema.mjs";
import { offlineEnv } from "./fixtures/offline-github.mjs";

const REEVE = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "reeve");
const store = () => open(join(tempDir("reeve-unrecorded-"), "s.db"));
const listed = (prs) => () => ({ ok: true, prs });
/** A withdrawal that records what it was asked, and finds reeve's result at every head but `none`. */
function withdrawals({ fails = [], none = [] } = {}) {
  const asked = [];
  const withdraw = async (a) => {
    asked.push(a);
    if (fails.includes(a.head)) return { ok: false, why: "HTTP 502" };
    return { ok: true, id: none.includes(a.head) ? null : 7 };
  };
  return { asked, withdraw };
}

test("every pull request that didn't merge has reeve's enforcement result withdrawn at its head, and that's recorded", async () => {
  const db = store();
  const { asked, withdraw } = withdrawals({ none: ["b".repeat(40)] });
  const r = await withdrawUnrecorded({ nwo: "o/r", db, list: listed([{ pr: 1, head: "a".repeat(40) }, { pr: 2, head: "b".repeat(40) }]), withdraw });
  assert.deepEqual(asked.map(a => [a.head, a.name]), [["a".repeat(40), "ops/merge-policy"], ["b".repeat(40), "ops/merge-policy"]]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.withdrawn, [1], "only where reeve's result stood");
  assert.equal(unrecordedWithdrawn(db, "o/r"), true);
  db.close();
});

test("once recorded, it isn't done again", async () => {
  const db = store();
  await withdrawUnrecorded({ nwo: "o/r", db, list: listed([{ pr: 1, head: "a".repeat(40) }]), withdraw: withdrawals().withdraw });
  const { asked, withdraw } = withdrawals();
  const again = await withdrawUnrecorded({ nwo: "o/r", db, list: listed([{ pr: 1, head: "a".repeat(40) }]), withdraw });
  db.close();
  assert.equal(again.already, true);
  assert.deepEqual(asked, []);
});

test("a list that couldn't be read is retried, never recorded as done", async () => {
  const db = store();
  const r = await withdrawUnrecorded({ nwo: "o/r", db, list: () => ({ ok: false, why: "HTTP 502" }), withdraw: withdrawals().withdraw });
  assert.equal(r.ok, false);
  assert.match(r.why, /HTTP 502/);
  assert.equal(unrecordedWithdrawn(db, "o/r"), false);
  db.close();
});

test("a withdrawal that failed is retried, never recorded as done", async () => {
  const db = store();
  const { withdraw } = withdrawals({ fails: ["b".repeat(40)] });
  const r = await withdrawUnrecorded({ nwo: "o/r", db, list: listed([{ pr: 1, head: "a".repeat(40) }, { pr: 2, head: "b".repeat(40) }]), withdraw });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed.map(f => f.pr), [2]);
  assert.equal(unrecordedWithdrawn(db, "o/r"), false);
  db.close();
});

test("the record is kept per repository", async () => {
  const db = store();
  await withdrawUnrecorded({ nwo: "o/r", db, list: listed([]), withdraw: withdrawals().withdraw });
  assert.equal(unrecordedWithdrawn(db, "o/r"), true);
  assert.equal(unrecordedWithdrawn(db, "o/other"), false);
  db.close();
});

test("the pull requests listed are every one that didn't merge, open or closed, past the first page", () => {
  const asked = [];
  const gh = (args) => {
    asked.push(args.join(" "));
    return { ok: true, out: [
      JSON.stringify({ pr: 1, head: "a".repeat(40) }),
      JSON.stringify({ pr: 3, head: "c".repeat(40) }),
    ].join("\n") };
  };
  const r = unmergedHeads("o/r", { gh });
  assert.deepEqual(r, { ok: true, prs: [{ pr: 1, head: "a".repeat(40) }, { pr: 3, head: "c".repeat(40) }] });
  assert.match(asked[0], /--paginate/);
  assert.match(asked[0], /state=all/);
  assert.match(asked[0], /merged_at == null/, "a merged pull request keeps its result, as the record of why it merged");
  assert.equal(unmergedHeads("o/r", { gh: () => ({ ok: false, err: "HTTP 502" }) }).ok, false);
  assert.equal(unmergedHeads("o/r", { gh: () => ({ ok: true, out: "not json" }) }).ok, false, "an answer that can't be read");
});

test("reeve run --enforce refuses until the unrecorded results are withdrawn", () => {
  const NWO = "acme/widget";
  const home = tempDir("reeve-unrecorded-home-");
  const dbPath = statePathFor(home, NWO);
  mkdirSync(dirname(dbPath), { recursive: true });
  open(dbPath).close();
  mkdirSync(join(home, "profiles", "acme"), { recursive: true });
  writeFileSync(join(home, "profiles", "acme", "widget.json"), JSON.stringify(withDefaults({ schemaVersion: 1, project: { kind: "product" },
    identity: { key: NWO, defaultBranch: "main", visibility: "public" },
    authority: { permission: "admin", policy: "propose_only", profileLocation: "sidecar" },
    state: { mode: "in-repo" }, units: [{ id: "root", root: ".", language: "javascript", packageManager: "npm", commands: {} }],
    ci: { provider: "github-actions" }, merge: { method: "squash", enforcement: "attested" }, reviewers: [] })));
  // Halted, so a run that didn't refuse would sleep rather than reach GitHub.
  writeFileSync(join(home, "HALT"), "");
  const run = () => spawnSync(process.execPath, [REEVE, "run", NWO, "--enforce", "--interval", "600"],
                              { cwd: home, encoding: "utf8", env: { ...offlineEnv(), REEVE_HOME: home }, timeout: 20_000 });
  const refused = run();
  assert.equal(refused.signal, null, "it exited by itself, rather than running");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /reeve withdraw acme\/widget --unrecorded/);
});

// ── from #239's review ────────────────────────────────────────────────────────

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

test("reeve withdraw --unrecorded that can't list the pull requests says so, exits 1, and leaves it to run again", () => {
  const NWO = "acme/widget";
  const home = tempDir("reeve-unrecorded-cli-");
  const dbPath = statePathFor(home, NWO);
  mkdirSync(dirname(dbPath), { recursive: true });
  open(dbPath).close();
  // GitHub is out of reach, so the list can't be read.
  const r = spawnSync(process.execPath, [REEVE, "withdraw", NWO, "--unrecorded"],
                      { cwd: home, encoding: "utf8", env: { ...offlineEnv(), REEVE_HOME: home }, timeout: 60_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /couldn't be listed.*Run it again/s);
  const db = open(dbPath);
  assert.equal(unrecordedWithdrawn(db, NWO), false);
  db.close();
});
