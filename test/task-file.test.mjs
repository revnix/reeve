// `reeve task file`: the territory grammar, and the rule that an empty claim is
// the repository ROOT rather than the absence of a claim.
//
// THE TWO ARE ASSERTED SEPARATELY ON PURPOSE. The implementation an author
// reaches for first -- filtering blanks out of the territory list before
// counting it -- collapses them: a whitespace-only `--territory` reads as "no
// territory", which is refused by the grammar, and the refusal looks correct.
// Only the root-claim half turns red on that mistake. Asserting them together
// would let one implementation satisfy both while the root claim, which
// conflicts with everything in its project, silently conflicted with nothing.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHub } from "../src/build/hubdb.mjs";
import { isSameProcess, readStart } from "../src/supervisor.mjs";
import { fileTask, TERRITORY_GRAMMAR } from "../src/build/taskfile.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-taskfile-"));

// A real project on disk, because the claim walk lstats every ancestor of every
// claim and a fixture with no directories cannot exhibit a symlink refusal.
const repo = join(dir, "repo");
mkdirSync(join(repo, "packages", "x"), { recursive: true });
writeFileSync(join(repo, "p.json"), "{}\n");

// `resolveSnapshot` takes the registry as an object keyed by project name, with
// a `version`. That is NOT the array the registry loader returns; the route
// converts. Building the object shape here keeps these tests honest about which
// of the two this function actually consumes.
const registry = { version: 1, projects: {
  nextly: { nwo: "nextlyhq/nextly", repoPath: repo, profilePath: join(repo, "p.json") } } };

// Every network read the snapshot needs, injectable, none of them real.
const mkIo = (over = {}) => ({
  lstat: (p) => lstatSync(p),
  lsTree: () => null,
  repoId: async () => 42,
  profileHash: async () => "ph-1",
  defaultBranch: async () => "main",
  visibility: async () => "private",
  specRepoId: async () => 77,
  gateDefinitionHash: async () => "gd-1",
  founderUserId: async () => 9,
  ...over,
});

let n = 0;
const store = () => openHub(join(dir, `h${++n}.db`));
const tasks   = (db) => db.prepare("SELECT count(*) c FROM task").get().c;
const writers = (db) => db.prepare("SELECT count(*) c FROM writer_lease").get().c;

const base = (db, over = {}) => ({
  db, registry, project: "nextly", title: "a scout task",
  territory: ["packages/x"], io: mkIo(), isAlive: isSameProcess,
  pid: process.pid, lstart: readStart(process.pid), ...over,
});

// ── The control: the fixture can actually admit a filing ─────────────────────
//
// Without this, every refusal below could be passing because the fixture is
// broken rather than because the grammar refused. A refusal is the easiest
// thing in this file to produce by accident.
{
  const db = store();
  const r = await fileTask(base(db, { title: "the control filing" }));
  check(r.ok === true, "control: a well-formed filing IS admitted by this fixture",
    JSON.stringify(r));
  check(tasks(db) === 1, "control: and it wrote exactly one task row", String(tasks(db)));
  db.close();
}

// ── No --territory at all ────────────────────────────────────────────────────
//
// The refusal has to teach the grammar, and it has to arrive before any network
// call: a filing that cannot be admitted must not cost a round trip to find
// that out.
{
  const db = store();
  let touched = false;
  const r = await fileTask(base(db, {
    territory: [], io: mkIo({ repoId: async () => { touched = true; return 42; } }) }));
  check(r.ok === false, "a filing with no --territory is refused", JSON.stringify(r));
  check(r.refusal === TERRITORY_GRAMMAR, "with the one grammar refusal, not an ad-hoc string", r.refusal);
  check(/--territory/.test(r.refusal), "which names the flag", r.refusal);
  check(/packages\/x/.test(r.refusal), "and shows a worked example", r.refusal);
  check(/glob/.test(r.refusal) && /traversal/.test(r.refusal),
    "and states what the grammar refuses", r.refusal);
  check(touched === false, "and nothing reached the network to find that out");
  check(tasks(db) === 0 && writers(db) === 0,
    "and no task row and no writer lease exist afterwards", `${tasks(db)}/${writers(db)}`);
  db.close();
}

// ── An empty claim is the ROOT, never no-claim ───────────────────────────────
//
// The absence of a territory claim must never read as the absence of conflict.
{
  const db = store();
  const a = await fileTask(base(db, { title: "the root claimant", territory: ["  "] }));
  check(a.ok === true, "an empty claim is admitted as a claim, not dropped", JSON.stringify(a));
  // GUARDED, because the lookup must not abort the file when the filing above
  // was refused. Binding an undefined id throws inside node:sqlite, and a file
  // that dies here reports one failure and never runs the two assertions below
  // -- which is indistinguishable, in the log, from those two having passed.
  const row = a.task
    ? db.prepare("SELECT kind, path FROM task_territory WHERE task=?").get(a.task)
    : null;
  check(row?.kind === "prefix" && row?.path === "",
    "and it is stored as the repository root prefix", JSON.stringify(row));

  const b = await fileTask(base(db, { title: "an unrelated package" }));
  check(b.ok === false,
    "and a root-prefix task blocks every concurrent grant in its project", JSON.stringify(b));
  // BOTH HALVES CHECKED. `String(undefined).includes(undefined)` is true, so
  // asserting containment alone passes when neither filing produced anything --
  // the exact case this is here to catch.
  check(typeof a.task === "string" && String(b.refusal ?? "").includes(a.task),
    "naming the root task as the blocker", `${a.task} / ${b.refusal}`);
  check(tasks(db) === 1, "and the blocked filing inserted nothing", String(tasks(db)));
  db.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
