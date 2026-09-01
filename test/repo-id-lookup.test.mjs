// The repository-id lookup, and the three states its callers must tell apart.
//
// `resolveRepoId` has a three-outcome contract -- a number, `null` for "no id is
// known", and a THROW for "reeve could not look" -- and every caller that opens
// the connection has to preserve it in its own `catch`. The CLI's copy lived
// inside `bin/reeve`, where the only assertion that could reach it was a regex
// over the CLI's source text: stubbing the decision out broke nothing, because
// the text it read was still there. That is the shape this file exists to end.
//
// Collapsing a damaged store into "no id known" is not a cosmetic error. It
// suppresses `guardian:hub:unreadable` and leaves dispatch fail-closed under a
// message that describes a healthy machine with no builder on it, so the founder
// is told nothing while every dispatch is refused.
import { resolveRepoIdAt, HUB_LOOKUP_OPEN } from "../src/build/repoid.mjs";
import { openHub, completedVersion, HUB_BUSY_TIMEOUT_MS } from "../src/build/hubdb.mjs";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, statSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const threw = async (fn) => { try { await fn(); return null; } catch (err) { return err; } };

const dir = mkdtempSync(join(tmpdir(), "reeve-repoid-"));
const PROJECT = { name: "o/r", nwo: "o/r" };

// ── control: a hub that knows the id answers with it ──────────────────────
{
  const p = join(dir, "known.db");
  const h = openHub(p);
  // THE IDENTITY, not a task. The lookup reads `project_identity` so the guardian
  // can answer it through its restricted connection; a fixture that still wrote
  // only a task would have gone on passing while the read moved, which is the
  // shape this file exists to catch.
  h.exec(`INSERT INTO project_identity(project,repo_id,learned_at) VALUES('o/r',4242,unixepoch())`);
  h.close();
  check(await resolveRepoIdAt(p, PROJECT) === 4242,
    "control: a hub holding the id answers with it");
}

// ── a hub that was never built is BENIGN ──────────────────────────────────
// `project_identity` arrives with migration 5, so `no such table` on a store
// recording no completed migration is a machine with no builder on it -- an
// ordinary state.
{
  const p = join(dir, "unbuilt.db");
  new DatabaseSync(p).close();               // a real SQLite file, zero migrations
  check(completedVersion(p) === 0, "fixture: the store records no completed migration",
    String(completedVersion(p)));
  const r = await threw(() => resolveRepoIdAt(p, PROJECT));
  check(r === null, "an unmigrated hub is 'no id known', not a fault", String(r?.message ?? r));
  check(await resolveRepoIdAt(p, PROJECT) === null, "and the answer is null", "");
  // AND IT DID NOT BUILD ONE. A lookup must never be a schema change: this path
  // holds no builder singleton lease, so migrating here would upgrade the schema
  // underneath a running builder.
  check(completedVersion(p) === 0,
    "and the lookup did not migrate the store to find out", String(completedVersion(p)));
}

// ── a hub that HAD the table and lost it is a FAULT ───────────────────────
// Same error text, opposite diagnosis. This is the case the error-kind test
// alone could not separate, and answering null here is the silent fail-closed.
{
  const p = join(dir, "damaged.db");
  openHub(p).close();
  const w = new DatabaseSync(p);
  w.exec("DROP TABLE project_identity");
  w.close();
  check(completedVersion(p) >= 1, "fixture: the store records a completed migration",
    String(completedVersion(p)));
  const err = await threw(() => resolveRepoIdAt(p, PROJECT));
  check(err != null, "a store that recorded a migration and lost `project_identity` PROPAGATES",
    "it returned instead of throwing");
  check(/no such table/i.test(err?.message ?? ""),
    "and the failure it propagates is the one the store gave", String(err?.message));
}

// ── absent is not unreachable ─────────────────────────────────────────────
{
  check(await resolveRepoIdAt(join(dir, "not-here.db"), PROJECT) === null,
    "a hub that is not there at all is 'no id known'");

  const locked = mkdtempSync(join(tmpdir(), "reeve-repoid-locked-"));
  const p = join(locked, "hub.db");
  openHub(p).close();
  chmodSync(locked, 0o000);
  let reachable = true;
  try { statSync(p); } catch { reachable = false; }
  if (!reachable) {
    const err = await threw(() => resolveRepoIdAt(p, PROJECT));
    check(err != null,
      "but a hub that cannot be REACHED propagates rather than reporting no id",
      "it returned instead of throwing");
    check(err?.code !== "ENOENT",
      "and the failure is the access error, not a fabricated absence", String(err?.code));
  } else {
    check(true, "skipped: this user can stat through a 000 directory, so the case cannot be built here");
  }
  chmodSync(locked, 0o700);
  rmSync(locked, { recursive: true, force: true });
}

// ── the connection the lookup opens ───────────────────────────────────────
// Asserted as AGREEMENT with the shared constant rather than against a number,
// so changing the budget is one edit and cannot leave two homes disagreeing.
{
  check(HUB_LOOKUP_OPEN.readOnly === true,
    "the lookup opens read-only", JSON.stringify(HUB_LOOKUP_OPEN));
  check(HUB_LOOKUP_OPEN.timeout === HUB_BUSY_TIMEOUT_MS,
    "and waits the shared hub contention budget, not SQLite's default of zero",
    JSON.stringify({ lookup: HUB_LOOKUP_OPEN.timeout, shared: HUB_BUSY_TIMEOUT_MS }));
  const src = readFileSync(new URL("../src/build/repoid.mjs", import.meta.url), "utf8");
  check(!/timeout:\s*\d/.test(src),
    "and no connection here restates that budget as a literal", src.match(/timeout:.*/g)?.join(" | ") ?? "");
  // The CLI must DELEGATE, not keep a second copy of either decision. This is
  // the assertion that fails if the catch is ever inlined back.
  const cli = readFileSync(new URL("../bin/reeve", import.meta.url), "utf8");
  const slice = cli.slice(cli.indexOf("const repoIdOnce"), cli.indexOf("const registryProjects"));
  // COMMENTS STRIPPED FIRST. The first version of this read the raw slice and
  // went red on the word "catch" inside the comment explaining why there is no
  // longer a catch -- a check over source text that cannot tell code from prose
  // about the code answers a different question than the one it is named for.
  const code = slice.split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  check(/resolveRepoIdAt\(/.test(code) && !/new DatabaseSync\(/.test(code) && !/\bcatch\b/.test(code),
    "and the CLI delegates the lookup instead of re-deciding it", code);
}

rmSync(dir, { recursive: true, force: true });
console.log(fail === 0 ? "\nall good" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
