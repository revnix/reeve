// Clause U4 reads this row at merge time. The whole value of a derivation this
// small is that every way of not knowing lands on UNKNOWN rather than on a
// default that happens to look like a pass.
import { openHub, hubTx } from "../src/build/hubdb.mjs";
import { gateStateFrom, refreshGateState } from "../src/build/gatestate.mjs";
import { buildTick } from "../src/build/loop.mjs";
import { DatabaseSync } from "node:sqlite";
// The writer-exclusion block reaches across every writer in the plan, so it
// names them all -- and the imports are EXECUTABLE. Left as comments they are
// the same as absent: the first `applyTransition` raises a ReferenceError and
// the block stops before checking a single writer, reporting itself as a green
// suite with one broken file rather than as an unenforced rule.
import { applyTransition } from "../src/build/transition.mjs";
import { enqueueEffect, leaseEffect, settleEffect, recoverEffects,
         voidPending } from "../src/build/outbox.mjs";
import { admitTask, normalizeClaim } from "../src/build/registry.mjs";
import { acquireMaintenanceLock } from "../src/build/locks.mjs";
import { isSameProcess, readStart } from "../src/supervisor.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `resolveSnapshot` returns the claims it WALKED as `snapshot.claims`, and
// `admitTask` now grants only those -- it refuses a snapshot that carries none,
// because a fallback to the filing's own list is the unchecked-territory hole
// with a longer path to it. These blocks assemble snapshots by hand, so this
// stands in for that half of resolveSnapshot: the resolved list IS the declared
// one when nothing in the walk objected, which is what every fixture here means.
const admitResolved = (db, snapshot, filing) =>
  admitTask(db, { ...snapshot, claims: filing.claims }, filing);


let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { fail++; if (detail !== undefined) console.log(`        ${detail}`); }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-gatestate-"));
const NOW = 1_800_000_000;
const allOn = {
  "builder.capabilities.observe": true, "builder.capabilities.draftSpec": true,
  "builder.capabilities.implementLocal": true, "builder.capabilities.publishPr": true,
  "builder.capabilities.mergeBuilderPr": true,
};
const seed = (db, { id, phase, generation = 1, events = 12 }) => {
  db.prepare(
    `INSERT INTO task(id, project, repo_id, nwo_snapshot, title, phase, generation,
                      source_kind, source_key, repo_path, profile_path, profile_hash,
                      default_branch, visibility, registry_version, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch(),unixepoch())`)
    .run(id, "p", 1, "o/r", "t", phase, generation, "founder", `k:${id}`,
         "/repo", "/profile.json", "hash", "main", "private", 1);
  for (let i = 0; i < events; i++)
    db.prepare(
      `INSERT INTO phase_event(task, at, op, from_phase, to_phase, from_generation, to_generation, detail)
       VALUES(?, unixepoch(), 'phase.advanced', ?, ?, ?, ?, '{}')`)
      .run(id, phase, phase, generation, generation);
};
const EXPECTED = 42;
// The COMPLETE section 1.8 contract, defined ONCE at file scope and shared by
// the positive fixture and the per-permission negative loop below. When `FULL`
// was widened to eight and `ok` was left at three, a correct gateStateFrom
// returned `app_installed: "fail"` on the first assertion that claims to be a
// pass: two fixtures for one contract, disagreeing.
//
// Administration is READ deliberately -- administration write is refused in
// code, so requiring write would be wrong in the other direction.
const FULL = { actions: "read", administration: "read", checks: "write",
               contents: "write", issues: "write", metadata: "read",
               pull_requests: "write", statuses: "write" };
const ok = { ruleset: { required_status_checks: [{ context: "ops/merge-policy", integration_id: EXPECTED }] },
             installation: { permissions: { ...FULL } } };

{
  let r = gateStateFrom({ ...ok, expectedAppId: EXPECTED, repoId: 1, nwo: "o/r", now: 100 });
  check(r.ruleset_requires_check === 1 && r.bound_app_id === EXPECTED && r.app_installed === "pass",
    "a ruleset requiring the check from the expected app, with the app installed, is a pass", JSON.stringify(r));
  check(r.verified_at === 100 && r.error === null, "and records when it was verified");

  // bound to a DIFFERENT app: the check would be satisfiable by another source
  r = gateStateFrom({ ruleset: { required_status_checks: [{ context: "ops/merge-policy", integration_id: 99 }] },
                      installation: ok.installation, expectedAppId: EXPECTED, repoId: 1, nwo: "o/r", now: 100 });
  check(r.bound_app_id === 99 && r.bound_app_id !== r.expected_app_id,
    "a check bound to another app is recorded as drift, not as a pass", JSON.stringify(r));

  // required but bound to NOTHING: any source could satisfy it
  r = gateStateFrom({ ruleset: { required_status_checks: [{ context: "ops/merge-policy" }] },
                      installation: ok.installation, expectedAppId: EXPECTED, repoId: 1, nwo: "o/r", now: 100 });
  check(r.bound_app_id === null, "a check required from ANY source records a null bound app", JSON.stringify(r));

  // the check is not required at all
  r = gateStateFrom({ ruleset: { required_status_checks: [{ context: "CI Gate", integration_id: 7 }] },
                      installation: ok.installation, expectedAppId: EXPECTED, repoId: 1, nwo: "o/r", now: 100 });
  check(r.ruleset_requires_check === 0, "a ruleset that does not require ops/merge-policy is recorded as such");

  // every shape of not-knowing
  for (const [label, input] of [
    ["no ruleset",        { ruleset: null, installation: ok.installation }],
    ["no installation",   { ruleset: ok.ruleset, installation: null }],
    ["neither",           { ruleset: null, installation: null }],
    ["a fetch error",     { ruleset: null, installation: null, error: "403" }],
  ]) {
    const u = gateStateFrom({ ...input, expectedAppId: EXPECTED, repoId: 1, nwo: "o/r", now: 100 });
    // BOTH, not either. The interface says any absent or unreadable input yields
    // app_installed 'unknown' AND ruleset_requires_check 0; an `||` is satisfied
    // by a row that claims the ruleset requires the check while the app state is
    // unknown, which is a half-pass the clause would read as evidence.
    check(u.app_installed === "unknown" && u.ruleset_requires_check === 0,
      `${label} yields unknown AND not-required, never a half-pass`, JSON.stringify(u));
    check(typeof u.error === "string" && u.error.length > 0, `${label} records WHY it is unknown`, String(u.error));
  }

  // missing a permission is a fail, distinct from unknown: reeve looked and the
  // answer was no, which is a different thing to report and to act on.
  // One permission at a time. A fixture missing several at once is satisfied by
  // an implementation that checks only the first, which then passes an
  // installation with read-only contents or no pull_requests write.
  // FULL is the file-scope constant the positive `ok` fixture is built from, so
  // the two cannot drift: this loop removes one permission at a time from the
  // SAME contract the pass case asserts.
  for (const missing of Object.keys(FULL)) {
    const perms = { ...FULL }; delete perms[missing];
    const p = gateStateFrom({ ruleset: ok.ruleset, installation: { permissions: perms },
                              expectedAppId: EXPECTED, repoId: 1, nwo: "o/r", now: 100 });
    check(p.app_installed === "fail", `a missing ${missing} permission is a fail, not an unknown`, JSON.stringify(p));
    check((p.permission_diff ?? "").includes(missing), `and the diff names ${missing}`, String(p.permission_diff));
  }
  // AN INSTALLATION WITH NO PERMISSIONS AT ALL. The four not-knowing cases above
  // all pass `installation: null`, which is caught before the permission
  // comparison is reached -- so nothing here exercised an installation that is
  // PRESENT and reports nothing. That is the exact broken implementation this
  // derivation is warned about: `app_installed` defaulting to a pass when the
  // permissions key is absent, which reads as "the App can do what it needs"
  // from an answer that said nothing at all.
  for (const [label, inst] of [["an empty permissions object", { permissions: {} }],
                               ["no permissions key at all",   {}]]) {
    const none = gateStateFrom({ ruleset: ok.ruleset, installation: inst,
                                 expectedAppId: EXPECTED, repoId: 1, nwo: "o/r", now: 100 });
    check(none.app_installed !== "pass",
      `an installation reporting ${label} is never a pass`, JSON.stringify(none));
    check((none.permission_diff ?? "").length > 0,
      `and records what is missing (${label})`, String(none.permission_diff));
  }

  const downgraded = gateStateFrom({ ruleset: ok.ruleset, installation: { permissions: { ...FULL, contents: "read" } },
                                     expectedAppId: EXPECTED, repoId: 1, nwo: "o/r", now: 100 });
  check(downgraded.app_installed === "fail",
    "and a permission present but downgraded to read is also a fail", JSON.stringify(downgraded));
  // The other direction: administration must NOT be write. The design refuses
  // administration write in code, so an installation carrying it is a finding.
  const over = gateStateFrom({ ruleset: ok.ruleset, installation: { permissions: { ...FULL, administration: "write" } },
                               expectedAppId: EXPECTED, repoId: 1, nwo: "o/r", now: 100 });
  check(over.app_installed === "fail",
    "and administration WRITE is a fail: the contract is read, and more is not better", JSON.stringify(over));
}

// ── the tick writes it; S2 makes no network call ─────────────────────────────
{
  const db = openHub(join(dir, "g.db"));
  // A fetcher that THROWS is the live case: a 403, a network drop, a rate limit.
  // If refreshGateState lets it propagate, the row is never written, U4 finds
  // nothing, and doctor reports the project as having never refreshed -- which
  // is indistinguishable from a fresh hub and hides an outage. It must catch,
  // record the error on the row, and leave the state unknown.
  // Both failure shapes: a synchronous throw and a REJECTED promise. The live
  // fetcher is async, so the rejected case is the one that will actually happen,
  // and a try/catch around a call that returns a promise catches neither.
  const threw = await refreshGateState(db, { name: "nextly", repoId: 1, nwo: "o/r", expectedAppId: EXPECTED },
    () => { throw new Error("403 from the rulesets API"); });
  const rejected = await refreshGateState(db, { name: "nextly", repoId: 2, nwo: "o/other", expectedAppId: EXPECTED },
    () => Promise.reject(new Error("ECONNRESET")));
  check(rejected.app_installed === "unknown" && /ECONNRESET/.test(rejected.error ?? ""),
    "a fetcher whose promise REJECTS also writes an unknown row carrying why", JSON.stringify(rejected));
  check(threw.app_installed === "unknown" && /403/.test(threw.error ?? ""),
    "a fetcher that throws still writes an unknown row, carrying WHY", JSON.stringify(threw));

  // Awaited: refreshGateState must be async to catch a rejected fetcher, so an
  // unawaited call yields a Promise and every field read off it is undefined.
  const row = await refreshGateState(db, { name: "nextly", repoId: 1, nwo: "o/r", expectedAppId: EXPECTED },
    () => null);                                   // the S2 default: reeve has not looked
  check(row.app_installed === "unknown", "with no fetcher wired, the row reads unknown rather than absent");
  check(db.prepare("SELECT count(*) c FROM repo_gate_state WHERE repo_id=1").get().c === 1, "and the row is written");
  // Count the events for THIS repo: the caught-error and rejected refreshes
  // above already wrote rows, so an unqualified count of 1 is wrong by exactly
  // the number of failure cases the block just exercised.
  // A DELTA, not a floor. Repository 1 already has an event from the
  // caught-error refresh above, so `>= 1` stays green even if the unknown and
  // successful upserts append nothing at all -- and replay would then restore an
  // older gate-state row while the live projection had moved on.
  const eventsFor1 = () => db.prepare(
    `SELECT count(*) c FROM hub_event WHERE kind='repo_gate_state.refreshed'
     AND json_extract(payload,'$.repo_id') = 1`).get().c;
  const beforeRefresh = eventsFor1();
  await refreshGateState(db, { name: "nextly", repoId: 1, nwo: "o/r", expectedAppId: EXPECTED }, () => ok);
  check(eventsFor1() === beforeRefresh + 1,
    "every refresh appends exactly one hub_event, so the restore drill can replay it",
    `${beforeRefresh} -> ${eventsFor1()}`);
  await refreshGateState(db, { name: "nextly", repoId: 1, nwo: "o/r", expectedAppId: EXPECTED }, () => ok);
  check(db.prepare("SELECT count(*) c FROM repo_gate_state WHERE repo_id=1").get().c === 1,
    "control: a second refresh upserts rather than inserting a second row for the same repo");

  // The block is labelled "the tick writes it", so it has to run the TICK.
  // Calling refreshGateState directly proves the function works and says nothing
  // about whether `build run` ever reaches it -- which is the wiring that would
  // actually be missing.
  db.exec("DELETE FROM repo_gate_state");
  await buildTick({ hub: db, projects: [{ name: "nextly", repoId: 1, nwo: "o/r", expectedAppId: EXPECTED }],
                    fetchGateState: () => ok, once: true });
  check(db.prepare("SELECT count(*) c FROM repo_gate_state WHERE repo_id=1").get().c === 1,
    "one pass of the builder tick writes the gate-state row");

  // And with NO fetcher at all, which is the S2 default and therefore the only
  // configuration that actually ships in this stage. An implementation that
  // calls ctx.fetchGateState blindly passes the assertion above and throws on
  // every real tick, where no live GitHub client is wired.
  db.exec("DELETE FROM repo_gate_state");
  await buildTick({ hub: db, projects: [{ name: "nextly", repoId: 1, nwo: "o/r", expectedAppId: EXPECTED }],
                    once: true });
  const dflt = db.prepare("SELECT * FROM repo_gate_state WHERE repo_id=1").get();
  check(dflt?.app_installed === "unknown",
    "a tick with no fetchGateState wired writes an UNKNOWN row rather than throwing",
    JSON.stringify(dflt));
  check(typeof dflt?.error === "string" && dflt.error.length > 0,
    "and records why it is unknown: reeve has not looked", String(dflt?.error));

  // WIRING, which neither assertion above can reach. Both call `buildTick`
  // directly, so an implementation with a correct loop.mjs and no CLI import
  // leaves production `build run` with no `repo_gate_state` writer at all while
  // every behavioural assertion here passes. The route is read as TEXT because
  // `build run` is a heartbeat loop -- invoking it from a test starts a daemon.
  const cli = readFileSync(new URL("../bin/reeve", import.meta.url), "utf8");
  check(/\bbuildTick\b/.test(cli) && /build\/loop\.mjs/.test(cli),
    "bin/reeve imports buildTick from build/loop.mjs");
  // Scoped to the ROUTE, not the file: an import with no call site is the exact
  // half-wiring this assertion exists to catch, and a whole-file search cannot
  // tell the two apart.
  // The BRANCH, not everything after the first mention of it. `cli.slice(at)`
  // runs to end-of-file, so an implementation that imports `buildTick` and calls
  // it from any later command or helper satisfied this while `build run` itself
  // never refreshed gate state -- the exact half-wiring the assertion exists to
  // catch. Bounded at the next `case`/`break` at the same nesting, which is where
  // this CLI's routes end.
  // `case "build"`, not `case "run"`. The builder has no nested `case "run"`:
  // S2-A adds a TOP-LEVEL `case "build"` and dispatches on `const sub =
  // process.argv[3]` with `sub === "run"`. Searching for `case "run"` finds the
  // pre-existing GUARDIAN route instead -- `bin/reeve:320` on `16769e7`, where
  // `buildTick` must not appear -- so the assertion below inspected the wrong
  // branch entirely and could never establish that `reeve build run` is wired.
  const at = cli.indexOf('case "build"');
  check(at !== -1, "fixture: the `build` route exists to scan", String(at));
  // Two spaces, which is this CLI's actual top-level case indentation (`  case
  // "doctor":`, `  case "backup":`, `  case "run":`). The six-space delimiter
  // matched nothing, so `nxt` was -1 and the slice ran to end-of-file -- the
  // unbounded scan the control below exists to rule out, reintroduced by the
  // very line meant to bound it. Nested cases sit at four spaces or deeper and
  // cannot match this pattern, so the slice ends at the next ROUTE.
  const branch = cli.slice(at, (() => {
    const nxt = cli.indexOf("\n  case ", at + 1);
    return nxt === -1 ? cli.length : nxt;
  })());
  // CONTROL: it is the BUILDER's route that was scanned. `sub` is the builder
  // subcommand dispatch and appears in no other case, so its presence is what
  // distinguishes this branch from the guardian's `case "run"`.
  check(/\bsub\b/.test(branch),
    "control: the scanned branch is the builder's `build` route, not the guardian's `run` route",
    branch.slice(0, 120));
  // ROUTE-level, and the assertion says so rather than claiming more. The build
  // route dispatches `run`, `status` and `pause` from one case body with no
  // delimiter a text scan can trust, so "somewhere in the build route" is the
  // honest granularity here. It still rules out the failure this exists to catch
  // -- a correct loop.mjs that bin/reeve imports and never calls -- which is what
  // no behavioural assertion in this file can see.
  check(/\bbuildTick\s*\(/.test(branch),
    "and the `build` route CALLS it, so the tick runs in production and not only here");
  // CONTROL: the slice really is bounded. If it reached end-of-file the two
  // lengths would match, and the assertion above would be the old one again.
  check(branch.length > 0 && branch.length < cli.length - at,
    "control: the scanned branch is a bounded slice, not the rest of the file",
    `${branch.length} of ${cli.length - at}`);
  // CONTROL: the same pattern over text that only NAMES buildTick must fail. A
  // regex that matches a mention reports every implementation as wired,
  // including one that imports the symbol and never calls it.
  check(!/\bbuildTick\s*\(/.test('import { buildTick } from "../src/build/loop.mjs";'),
    "control: the scan does not match an import that never calls it");

  // ── the tick refreshes the shape PRODUCTION actually passes it ─────────────
  //
  // Every assertion above hands `buildTick` a project with `repoId` already on
  // it. `registryProjects` returns `{name, nwo}` and nothing else, so in the real
  // `build run` path every registered project reached the no-id guard and was
  // skipped on every heartbeat: the wiring was proved, the behaviour was proved,
  // and not one gate-state row was ever written for a real project. A fixture
  // richer than production cannot exhibit that, however many assertions it
  // carries.
  //
  // So the id is resolved from the hub, and this block passes the production
  // shape verbatim.
  // ASSERTED BY CALLING THE PRODUCER, not by grepping its source.
  //
  // This read `bin/reeve` for the literal `{ name, nwo: p.nwo }`, which stopped
  // being true the moment the loader moved into `src/build/registryio.mjs` and
  // grew the two path fields -- a text scan of one file standing in for a
  // property of another. The property is what matters: THE FIXTURE MUST NOT BE
  // RICHER THAN PRODUCTION, so it is compared against a row the real parser
  // actually produces.
  const { parseRegistry } = await import("../src/build/registryio.mjs");
  const produced = parseRegistry(
    JSON.stringify({ nextly: { nwo: "o/r", repoPath: "/p", profilePath: "/f" } }), "/x").projects[0];
  const producedKeys = Object.keys(produced ?? {}).sort();
  check(producedKeys.length > 0,
    "control: the registry parser really produced a row, so the comparison below is not vacuous",
    JSON.stringify(producedKeys));
  check(!producedKeys.includes("repoId"),
    "the registry supplies NO repoId, which is the whole reason the tick must resolve it from the hub",
    JSON.stringify(producedKeys));
  {
    const db2 = openHub(join(dir, "g-prod.db"));
    // The snapshot `resolveSnapshot` would have taken through the API client;
    // `repoId` is the value the hub records at admission and the one this block
    // expects the tick to find without being handed it.
    const admitted = { repoId: 1, nwo: "o/r", repoPath: "/p", profilePath: "/f", profileHash: "h",
                       defaultBranch: "main", visibility: "private", specRepoId: 9,
                       gateDefinitionHash: "g", registryVersion: 3, founderUserId: 4242 };
    admitResolved(db2, admitted, { id: "bt:prod", project: "nextly", title: "t",
                           claims: [normalizeClaim("packages/x")] });
    // The fixture is checked against the producer rather than trusted: a project
    // carrying a key the registry never supplies is a fixture richer than
    // production, and that is exactly what hid this defect before -- every real
    // project reached the no-id guard and was skipped on every heartbeat while
    // the wiring and the behaviour both looked proved.
    const fixtureProject = { name: "nextly", nwo: "o/r" };
    const richer = Object.keys(fixtureProject).filter((k) => !producedKeys.includes(k));
    check(richer.length === 0,
      "fixture: the project handed to buildTick carries no key the registry does not supply",
      richer.join(", "));
    const tick = await buildTick({ hub: db2, projects: [fixtureProject] });
    check(tick.refreshed === 1 && tick.skipped.length === 0,
      "a registry-shaped project is refreshed, not skipped", JSON.stringify(tick));
    const row = db2.prepare("SELECT repo_id, nwo_snapshot FROM repo_gate_state").get();
    check(row?.repo_id === admitted.repoId,
      "and the row is keyed on the id the hub recorded at admission, not an invented one",
      JSON.stringify(row));

    // CONTROL: a project the hub has never admitted a task for still has no id,
    // and skipping it remains the honest answer -- or "resolves the id" has
    // become "invents one".
    const unknown = await buildTick({ hub: db2, projects: [{ name: "other", nwo: "o/never" }] });
    check(unknown.refreshed === 0 && unknown.skipped.includes("other"),
      "control: a project the hub has never seen is still skipped", JSON.stringify(unknown));
    check(db2.prepare("SELECT count(*) c FROM repo_gate_state").get().c === 1,
      "control: and no row was fabricated for it");
    db2.close();
  }
  // AND THE PRODUCTION CALLER READS THE SKIP LIST. `buildTick` returns it
  // because a pass that refreshed nothing is indistinguishable from one that
  // refreshed everything -- and `build run` discarded the whole result, so a
  // tick skipping every project looked healthy from outside.
  check(/=\s*await buildTick\s*\(/.test(branch),
    "the build route keeps the tick's result rather than discarding it",
    (branch.match(/[^\n]*buildTick\s*\([^\n]*/) ?? ["(not found)"])[0]);
  check(/tick\.skipped/.test(branch),
    "and reads what the tick could not refresh");
  // AND A BROKEN REGISTRY IS NOT AN EMPTY ONE. `registryProjects` returns
  // `{ projects: [], error }` for a file that is unreadable, invalid JSON, or
  // carries a malformed entry, and reading only `.projects` turned all three into
  // a clean pass over nothing -- neither a failure nor a skipped project, while
  // every existing gate-state row aged into staleness.
  check(/registry\.error/.test(branch),
    "the build route reads the registry's ERROR, not only its projects",
    (branch.match(/[^\n]*registry\.error[^\n]*/) ?? ["(not found)"])[0]);
  check(/registryProjects\(HOME\)[\s\S]{0,200}registry\.error/.test(branch),
    "and reads it from the same call, so a broken file cannot arrive as an empty one",
    "checked");

  // ── a RENAMED repository is still resolved ────────────────────────────────
  // The first version keyed on `nwo_snapshot` while its own comment said a
  // repository can be renamed and that column is only ever a snapshot. So the
  // moment a repository was renamed or transferred, projects.json supplied the
  // new name, every existing task still carried the old one, and the lookup
  // returned null for a repository whose numeric id the hub was holding all
  // along -- skipped on every heartbeat until some new task happened to be
  // admitted under the new name. `task.project` IS the registry key, written at
  // admission from the same entry this lookup resolves, and it does not move.
  {
    const db4 = openHub(join(dir, "g-renamed.db"));
    const base = { repoPath: "/p", profilePath: "/f", profileHash: "h", defaultBranch: "main",
                   visibility: "private", specRepoId: 9, gateDefinitionHash: "g",
                   registryVersion: 3, founderUserId: 4242 };
    admitResolved(db4, { ...base, repoId: 77, nwo: "o/old-name" },
      { id: "bt:renamed", project: "nextly", title: "t", claims: [normalizeClaim("packages/a")] });
    // The registry now carries the NEW name for the same project key.
    const tick = await buildTick({ hub: db4, projects: [{ name: "nextly", nwo: "o/new-name" }] });
    check(tick.refreshed === 1 && tick.skipped.length === 0,
      "a renamed repository is still resolved and refreshed", JSON.stringify(tick));
    check(db4.prepare("SELECT repo_id FROM repo_gate_state").get()?.repo_id === 77,
      "and keyed on the numeric id the hub already held, which the rename did not change",
      JSON.stringify(db4.prepare("SELECT repo_id, nwo_snapshot FROM repo_gate_state").get()));
    // CONTROL: a DIFFERENT project key is still unresolvable, or "resolves by
    // project" has become "resolves anything".
    const other = await buildTick({ hub: db4, projects: [{ name: "not-a-project", nwo: "o/old-name" }] });
    check(other.refreshed === 0 && other.skipped.includes("not-a-project"),
      "control: an unknown project key is still skipped", JSON.stringify(other));

    // AND A QUERY FAILURE IS NOT "NEVER ADMITTED". A catch that returned null
    // said the two were the same, so a structurally damaged hub -- a file whose
    // `task` table is gone, which still passes `quick_check` because the pages it
    // does have are intact -- reported "no repository id" on every tick while
    // gate state aged into staleness. The one failure a diagnostic must never
    // render as a benign absence.
    // Foreign keys OFF for the drop only: `repo_gate_state` and friends reference
    // `task`, so the drop itself would fail the constraint rather than producing
    // the damaged-hub state this asserts about.
    db4.exec("PRAGMA foreign_keys = OFF");
    db4.exec("DROP TABLE task");
    let broke = null;
    try { await buildTick({ hub: db4, projects: [{ name: "nextly", nwo: "o/r" }] }); }
    catch (e) { broke = e; }
    check(broke !== null, "a hub whose task table is missing makes the tick FAIL",
      String(broke?.message));
    check(/task/.test(broke?.message ?? ""), "naming what could not be read",
      String(broke?.message));
    db4.close();
  }

  // ── the daemon tick answers the liveness question itself ──────────────────
  // `refreshGateState` defaults `isAlive` to `() => true`, which is right for a
  // pure unit test and wrong for `build run`: a maintenance lock left by a
  // CRASHED restore then reads as live for ever, every refresh throws, the daemon
  // catches the tick failure and continues, and no gate-state row is written
  // again until some unrelated writer reaps it. The tick runs on the machine that
  // holds the lock, so it is exactly the caller that can answer.
  check(/isAlive = isSameProcess/.test(readFileSync(new URL("../src/build/loop.mjs", import.meta.url), "utf8")),
    "buildTick defaults isAlive to the real process predicate, not to true", "checked");
  {
    const db5 = openHub(join(dir, "g-deadlock.db"));
    const base = { repoPath: "/p", profilePath: "/f", profileHash: "h", defaultBranch: "main",
                   visibility: "private", specRepoId: 9, gateDefinitionHash: "g",
                   registryVersion: 3, founderUserId: 4242 };
    admitResolved(db5, { ...base, repoId: 55, nwo: "o/r" },
      { id: "bt:lock", project: "nextly", title: "t", claims: [normalizeClaim("packages/a")] });
    // A restore that DIED: the row is there, its process is not. `lstart` is what
    // distinguishes a dead pid from a recycled one, so a value no process can
    // have is the honest fixture.
    const putLock = () => db5.prepare(
      `INSERT OR REPLACE INTO maintenance_lock(name, pid, lstart, acquired_at)
       VALUES('restore', 999999, 'not-a-real-start', unixepoch())`).run();

    // With the DEFAULT that shipped -- everything is alive -- the lock stands and
    // the refresh throws, which is the state the daemon sat in for ever.
    putLock();
    let stuck = null;
    try { await buildTick({ hub: db5, projects: [{ name: "nextly", nwo: "o/r" }], isAlive: () => true }); }
    catch (e) { stuck = e.message; }
    check(stuck !== null && /restore|maintenance/i.test(stuck),
      "fixture: treating every lock as live makes the refresh throw", String(stuck));

    // With the real predicate the dead lock is reaped and the tick proceeds.
    putLock();
    let threw = null, tick = null;
    try { tick = await buildTick({ hub: db5, projects: [{ name: "nextly", nwo: "o/r" }] }); }
    catch (e) { threw = e; }
    check(threw === null, "a lock left by a CRASHED restore does not stop the tick",
      String(threw?.message));
    check(tick?.refreshed === 1, "and the gate-state row is refreshed", JSON.stringify(tick));
    check(db5.prepare("SELECT count(*) c FROM maintenance_lock").get().c === 0,
      "control: the dead lock was reaped rather than merely ignored");
    db5.close();
  }

  // ── a MIXED list in ONE pass ───────────────────────────────────────────────
  // The two blocks above call `buildTick` once per project, so `refreshed` and
  // `skipped` are never both populated by the same pass -- and a loop that
  // `continue`s, one that `return`s, and one that throws away everything after
  // the first skip all satisfy single-project calls identically. The rule is
  // per-project, so the fixture has to hold projects that must be scored
  // differently, with the unresolvable one in the MIDDLE.
  {
    const db3 = openHub(join(dir, "g-mixed.db"));
    const base = { repoPath: "/p", profilePath: "/f", profileHash: "h", defaultBranch: "main",
                   visibility: "private", specRepoId: 9, gateDefinitionHash: "g",
                   registryVersion: 3, founderUserId: 4242 };
    admitResolved(db3, { ...base, repoId: 11, nwo: "o/one" },
      { id: "bt:one", project: "one", title: "t", claims: [normalizeClaim("packages/a")] });
    admitResolved(db3, { ...base, repoId: 33, nwo: "o/three" },
      { id: "bt:three", project: "three", title: "t", claims: [normalizeClaim("packages/c")] });

    const tick = await buildTick({ hub: db3, projects: [
      { name: "one",   nwo: "o/one" },
      { name: "two",   nwo: "o/never" },     // the hub has never seen this one
      { name: "three", nwo: "o/three" },
    ]});
    check(tick.refreshed === 2 && tick.skipped.length === 1,
      "one pass both refreshes and skips, and counts each separately", JSON.stringify(tick));
    check(tick.skipped[0] === "two",
      "the unresolvable project is the one named", JSON.stringify(tick.skipped));
    const ids = db3.prepare("SELECT repo_id FROM repo_gate_state ORDER BY repo_id").all().map(r => r.repo_id);
    check(JSON.stringify(ids) === "[11,33]",
      "and BOTH resolvable projects got their own row: the skip in the middle did not end the pass",
      JSON.stringify(ids));
    // Each row is keyed on ITS project's id, not on whichever was resolved last.
    const rows = db3.prepare("SELECT repo_id, nwo_snapshot FROM repo_gate_state ORDER BY repo_id").all();
    check(rows[0].nwo_snapshot === "o/one" && rows[1].nwo_snapshot === "o/three",
      "each row carries its own project's nwo, so the ids were not crossed",
      JSON.stringify(rows));
    db3.close();
  }
  db.close();
}

// ── the fetch finishes before the write transaction opens ────────────────────
{
  const p = join(dir, "order.db");
  const db = openHub(p);
  // A fetcher that is still PENDING while we look. Inspecting the returned row
  // cannot distinguish the two orderings -- both produce the same row -- so the
  // observation has to happen while the call is in flight.
  let release;
  const pending = new Promise(res => { release = res; });
  const inflight = refreshGateState(db, { name: "nextly", repoId: 3, nwo: "o/slow", expectedAppId: EXPECTED },
    () => pending.then(() => ok));

  // A SECOND connection with no patience at all: busy_timeout 0 turns "another
  // writer holds the lock" into an immediate SQLITE_BUSY instead of a wait, so
  // this reads the lock state rather than queueing behind it.
  const probe = new DatabaseSync(p);
  probe.exec("PRAGMA busy_timeout = 0");
  let acquired = false;
  try { probe.exec("BEGIN IMMEDIATE"); acquired = true; probe.exec("ROLLBACK"); } catch { /* SQLITE_BUSY */ }
  probe.close();
  check(acquired,
    "the hub write lock is NOT held while the gate-state fetch is in flight: network first, transaction second");

  release();
  const row = await inflight;
  check(row.repo_id === 3 && row.app_installed === "pass",
    "and the row is written once the fetch resolves", JSON.stringify(row));
  db.close();
}

// ── every hub writer refuses while a restore holds the maintenance lock ──────
// S2-A's rule is "every hub writer calls assertWritable", and a rule stated once
// in prose is honoured by whichever writers the author remembered. Two were
// missed -- admitTask and refreshGateState -- so this asserts the rule over the
// whole set instead of trusting each site.
//
// The list is the obligation: a writer added later that is not in it is not
// covered, so extending this list is part of adding a writer.
// This block reaches across every writer in the plan, so it names them all, and
// the imports are EXECUTABLE. Left as a comment they are the same as absent: the
// file's own import block declares only the hub, gate-state, loop and SQLite
// APIs, so the first `applyTransition` here raised a ReferenceError and the
// block stopped before checking a single writer -- reporting itself as a green
// suite with one broken file rather than as an unenforced rule.
// These belong at the TOP of the file with the rest of its imports; they are
// written here only so the block reads as one unit.
// (hoisted to the file's import block)
// (hoisted to the file's import block)
// (hoisted to the file's import block)
// (hoisted to the file's import block)
// (hoisted to the file's import block)
// (hoisted to the file's import block)
{
  const p = join(dir, "excl.db");
  const db = openHub(p);
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  // ALL ELEVEN fields, like every other snapshot fixture in this plan. Ten made
  // the admitTask call below a refusal for the missing `founderUserId`, so the
  // writer-exclusion assertion it feeds would have been satisfied by a refusal
  // that never reached assertWritable at all.
  const snap = { repoId: 1, nwo: "o/r", repoPath: "/p", profilePath: "/f", profileHash: "h",
                 defaultBranch: "main", visibility: "private", specRepoId: 9,
                 gateDefinitionHash: "g", registryVersion: 3, founderUserId: 4242 };

  // Someone else's live restore, held by a pid that is REALLY ALIVE. A
  // fabricated pid+lstart pair cannot match the writers' default
  // `isSameProcess`, so every one of them reaps the lock as stale and proceeds --
  // and the assertions below then report that no writer honours the restore
  // lock, against an implementation that honours it perfectly.
  //
  // A DIFFERENT process, because a lock held by this one is exactly the case
  // assertWritable is allowed to permit. A sleeping child is the cheapest real
  // one, and `readStart` gives the same lstart token the writers compare against.
  const holder = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
  for (let i = 0; i < 200 && readStart(holder.pid) == null; i++) await new Promise(r => setTimeout(r, 10));
  const holderStart = readStart(holder.pid);
  check(holderStart != null, "fixture: the lock holder is a real live process", String(holder.pid));
  acquireMaintenanceLock(db, { pid: holder.pid, lstart: holderStart, isAlive: isSameProcess });

  // Every writer below is synchronous. refreshGateState is the one async writer
  // and is awaited separately, so this helper deliberately does not accept a
  // promise: a rejected promise arriving here would be swallowed and read as a
  // writer that did not throw.
  const refused = (name, fn) => {
    let threw = null, returned;
    try { returned = fn(); } catch (e) { threw = e.message; }
    check(!(returned instanceof Promise),
      `control: ${name} is synchronous, so a throw is observable here`, String(returned));
    check(threw !== null && /restore|maintenance/i.test(threw),
      `${name} refuses while a restore holds the lock`, String(threw));
  };

  refused("applyTransition", () => applyTransition(db, { taskId: "bt:1", expectedPhase: "IMPLEMENTING",
    expectedGeneration: 1, evidence: { kind: "hold", reason: "over_budget" }, op: "task.blocked" }));
  refused("enqueueEffect", () => hubTx(db, () => enqueueEffect(db, { idempotencyKey: "x", kind: "notify",
    taskId: "bt:1", generation: 1, fence: 1, args: {} })));
  refused("leaseEffect", () => leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW }));
  // Deliberately id-only, and deliberately a row that does not exist: this probe
  // asserts the write is REFUSED while maintenance_lock is held, so it must fail
  // at the lock and not at the lease fence -- a call that never reaches the write
  // proves nothing about whether the write is guarded.
  refused("settleEffect", () => settleEffect(db, { id: 1, ok: true, result: {} }));
  refused("voidPending", () => voidPending(db, "bt:1"));
  refused("admitTask", () => admitResolved(db, snap, { id: "bt:9", project: "p", title: "t",
    claims: [normalizeClaim("packages/z")] }));

  // The async one is awaited, because a rejected promise from an unawaited call
  // is an unhandled rejection rather than a failing assertion.
  let asyncThrew = null;
  try { await refreshGateState(db, { name: "nextly", repoId: 1, nwo: "o/r", expectedAppId: EXPECTED }, () => ok); }
  catch (e) { asyncThrew = e.message; }
  check(asyncThrew !== null && /restore|maintenance/i.test(asyncThrew),
    "refreshGateState refuses while a restore holds the lock", String(asyncThrew));

  // `recoverEffects` joined the async ones when its reconciler moved OUTSIDE the
  // write transaction. It refuses BEFORE consulting anything, which is the part
  // that matters here: a restore must not send a reconciler to GitHub on behalf
  // of a hub that is about to be replaced.
  let recovered = null, recoverThrew = null, asked = 0;
  try { recovered = await recoverEffects(db, { reconcile: () => { asked++; return { settled: false }; } }); }
  catch (e) { recoverThrew = e.message; }
  check(recoverThrew !== null && /restore|maintenance/i.test(recoverThrew),
    "recoverEffects refuses while a restore holds the lock", String(recoverThrew ?? recovered));
  check(asked === 0, "and refuses before asking the reconciler anything", String(asked));

  // CONTROL: release the lock and one of them must succeed. Without it, a
  // writer that throws for an unrelated reason -- a missing table, a bad
  // fixture -- satisfies every assertion above.
  db.exec("DELETE FROM maintenance_lock");
  const after = await refreshGateState(db, { name: "nextly", repoId: 1, nwo: "o/r", expectedAppId: EXPECTED }, () => ok);
  check(after.app_installed === "pass",
    "control: with the lock released the same call succeeds, so the refusals above were the lock",
    JSON.stringify(after));
  holder.kill("SIGKILL");
  db.close();
}

// ── an EXTRA permission is drift, and drift is excess authority ──────────────
// The negative cases only removed required entries, so an installation carrying
// everything expected PLUS `workflows: write` reported `pass`. The gate's whole
// claim is that the bound App can do exactly what the ruleset requires and
// nothing more, and a minima-only comparison cannot make it.
{
  const db = openHub(join(dir, "g9.db"));
  const extra = {
    ...ok,
    installation: { ...ok.installation,
      permissions: { ...ok.installation.permissions, workflows: "write" } },
  };
  const row = await refreshGateState(db, { name: "nextly", repoId: 1, nwo: "o/r", expectedAppId: EXPECTED },
    () => extra);
  check(row.app_installed !== "pass",
    "an otherwise-valid installation with one EXTRA permission is not a pass",
    JSON.stringify(row));
  check(/workflows/.test(row.permission_diff ?? ""),
    "and permission_diff names the excess key, so the founder can see what to remove",
    String(row.permission_diff));
  // CONTROL: the same fetcher without the extra key IS a pass, so the assertion
  // above is about the excess permission and not about the fixture.
  const clean = await refreshGateState(db, { name: "nextly", repoId: 2, nwo: "o/two", expectedAppId: EXPECTED },
    () => ok);
  check(clean.app_installed === "pass" && clean.permission_diff == null,
    "control: the exact expected set still passes with no diff", JSON.stringify(clean));
  db.close();
}

// ── the tick, fed by the LOADER rather than by a literal ────────────────────
//
// The block above already proves a registry-shaped project is refreshed. It
// does so with a HAND-WRITTEN `{ name, nwo }`, and a fixture richer or poorer
// than production is exactly what let the original defect survive every
// assertion: every registered project reached the no-id guard and was skipped
// on every heartbeat while the wiring and the behaviour both read as proved.
//
// So this feeds the tick the loader's REAL output, parsed from registry text by
// the same function `bin/reeve` calls.
{
  const { parseRegistry } = await import("../src/build/registryio.mjs");
  const db3 = openHub(join(dir, "g-loader.db"));
  const reg = parseRegistry(JSON.stringify(
    { nextly: { nwo: "o/r", repoPath: "/repo", profilePath: "/p.json" } }), "/x/projects.json");
  check(reg.error === null, "control: the fixture registry parses", String(reg.error));

  const admitted = { repoId: 1, nwo: "o/r", repoPath: "/repo", profilePath: "/p.json", profileHash: "h",
                     defaultBranch: "main", visibility: "private", specRepoId: 9,
                     gateDefinitionHash: "g", registryVersion: reg.registry.version, founderUserId: 4242 };
  admitResolved(db3, admitted, { id: "bt:loader", project: "nextly", title: "t",
                                 claims: [normalizeClaim("packages/x")] });

  const tick = await buildTick({ hub: db3, projects: reg.projects });
  check(tick.refreshed === 1 && tick.skipped.length === 0,
    "the loader's own rows are refreshed, not skipped", JSON.stringify(tick));
  const row = db3.prepare("SELECT repo_id, nwo_snapshot FROM repo_gate_state").get();
  check(row?.repo_id === 1, "and the row is keyed on the id the hub recorded at admission",
    JSON.stringify(row));

  // The loader's row carries two fields the tick does not read. Asserting it is
  // UNBOTHERED by them is the difference between "production's shape works" and
  // "a narrower shape works and production was never tried".
  check(Object.keys(reg.projects[0]).length === 4,
    "control: and those rows really do carry four fields, not two", JSON.stringify(reg.projects[0]));

  // A project the loader lists and the hub has never seen is still skipped, or
  // "resolves the id" has quietly become "invents one".
  const two = parseRegistry(JSON.stringify(
    { nextly: { nwo: "o/r", repoPath: "/repo", profilePath: "/p.json" },
      other:  { nwo: "o/never", repoPath: "/repo2", profilePath: "/p2.json" } }), "/x/projects.json");
  check(two.error === null && two.projects.length === 2,
    "control: the two-project registry parses, so the mixed case is really mixed", String(two.error));
  const mixed = await buildTick({ hub: db3, projects: two.projects });
  check(mixed.refreshed === 1 && mixed.skipped.includes("other"),
    "control: an unknown project is skipped and NAMED, not fabricated", JSON.stringify(mixed));
  db3.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
