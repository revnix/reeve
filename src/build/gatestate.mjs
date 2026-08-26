// gatestate -- what GitHub says about the merge gate, derived purely.
//
// Clause U4 reads this row at merge time, and the whole value of a derivation
// this small is that EVERY way of not knowing lands on `unknown` rather than on
// a default that happens to look like a pass. A row that says the ruleset
// requires the check while the app state is unknown is a half-pass, and the
// clause would read it as evidence.
import { hubTx, hubEvent, canonicalHub } from "./hubdb.mjs";
import { assertWritable } from "./locks.mjs";

/** The check the merge gate is bound to. */
export const GATE_CHECK = "ops/merge-policy";

/**
 * The permissions the bound App must have -- EXACTLY, in both directions.
 *
 * `administration` is READ deliberately: administration write is refused in
 * code, so requiring write would be wrong in the other direction, and an
 * installation carrying it is a finding rather than a convenience.
 */
export const EXPECTED_PERMISSIONS = Object.freeze({
  actions: "read", administration: "read", checks: "write", contents: "write",
  issues: "write", metadata: "read", pull_requests: "write", statuses: "write",
});

const unknownRow = (repoId, nwo, expectedAppId, now, why) => ({
  repo_id: repoId, nwo_snapshot: nwo,
  // BOTH, not either. Absent input yields unknown AND not-required: a row
  // claiming the ruleset requires the check while the app state is unknown is
  // the half-pass this shape exists to make impossible.
  ruleset_requires_check: 0, bound_app_id: null, expected_app_id: expectedAppId ?? null,
  app_installed: "unknown", permission_diff: null, ruleset_snapshot: null,
  verified_at: now, error: why,
});

/**
 * Pure. Reads a ruleset and an installation and returns the exact
 * `repo_gate_state` row shape. No database, no clock, no network.
 */
export function gateStateFrom({ ruleset, installation, expectedAppId, repoId, nwo, now, error = null }) {
  // Every shape of not-knowing, first and together. A fetch error, a missing
  // ruleset and a missing installation are all "reeve could not establish the
  // gate", and each records WHY -- an unknown with no reason cannot be acted on.
  if (error) return unknownRow(repoId, nwo, expectedAppId, now, String(error));
  if (!ruleset && !installation)
    return unknownRow(repoId, nwo, expectedAppId, now, "neither the ruleset nor the installation could be read");
  if (!ruleset) return unknownRow(repoId, nwo, expectedAppId, now, "the ruleset could not be read");
  if (!installation) return unknownRow(repoId, nwo, expectedAppId, now, "the app installation could not be read");

  const required = (ruleset.required_status_checks ?? []).find(c => c?.context === GATE_CHECK) ?? null;

  // EXACT, in both directions. The negative cases removing required entries
  // leave an installation carrying `workflows: write` reporting a pass -- and
  // permission drift IS excess authority. The gate's whole claim is that the
  // bound App can do exactly what the ruleset requires and nothing more.
  const have = installation.permissions ?? null;
  const diff = [];
  if (!have) diff.push("no permissions reported");
  else {
    for (const [key, want] of Object.entries(EXPECTED_PERMISSIONS)) {
      if (!(key in have)) diff.push(`${key}: missing (expected ${want})`);
      else if (have[key] !== want) diff.push(`${key}: ${have[key]} (expected ${want})`);
    }
    for (const key of Object.keys(have))
      if (!(key in EXPECTED_PERMISSIONS)) diff.push(`${key}: ${have[key]} (unexpected)`);
  }

  return {
    repo_id: repoId, nwo_snapshot: nwo,
    ruleset_requires_check: required ? 1 : 0,
    // A check required from ANY source records a null bound app: it is
    // satisfiable by something other than the App reeve expects, which is a
    // different fact from being bound to the wrong one.
    bound_app_id: required ? (required.integration_id ?? null) : null,
    expected_app_id: expectedAppId ?? null,
    // FAIL is not UNKNOWN. reeve looked and the answer was no, which is a
    // different thing to report and a different thing to act on.
    app_installed: diff.length ? "fail" : "pass",
    permission_diff: diff.length ? canonicalHub(diff) : null,
    ruleset_snapshot: canonicalHub(ruleset),
    verified_at: now,
    error: null,
  };
}

const ROW = `repo_id, nwo_snapshot, ruleset_requires_check, bound_app_id, expected_app_id,
             app_installed, permission_diff, ruleset_snapshot, verified_at, error`;

/**
 * Fetch, THEN write. The ordering is the point, not a style preference.
 *
 * The hub has one writer. An implementation that opens BEGIN IMMEDIATE and then
 * awaits an API call holds that writer for as long as GitHub takes to answer, so
 * a 30-second timeout stalls every transition and every outbox settlement on the
 * machine.
 */
export async function refreshGateState(db, project, fetch, { now = null, isAlive = () => true } = {}) {
  const { name, repoId, nwo, expectedAppId } = project;
  let fetched = null, error = null;
  // BOTH failure shapes. The live fetcher is async, so a rejected promise is the
  // one that will actually happen -- and a try/catch around a call that RETURNS a
  // promise catches neither. `await` inside the try is what covers both.
  try { fetched = await fetch?.(project); }
  catch (e) { error = e?.message ?? String(e); }

  // A fetcher that throws must still write a row. Letting it propagate leaves U4
  // with nothing and doctor reporting the project as never refreshed -- which is
  // indistinguishable from a fresh hub, and hides an outage.
  if (!error && !fetched)
    error = `reeve has not looked: no gate-state fetcher is wired for ${name}`;

  const at = now ?? Math.floor(Date.now() / 1000);
  const row = gateStateFrom({
    ruleset: fetched?.ruleset ?? null, installation: fetched?.installation ?? null,
    expectedAppId, repoId, nwo, now: at, error });

  return hubTx(db, () => {
    // This runs on EVERY tick, so without the check a loop that never stops on
    // its own keeps upserting rows and appending events while a restore is
    // replacing the file underneath it.
    assertWritable(db, { isAlive, inTx: true });
    db.prepare(
      `INSERT INTO repo_gate_state(${ROW})
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(repo_id) DO UPDATE SET
         nwo_snapshot=excluded.nwo_snapshot,
         ruleset_requires_check=excluded.ruleset_requires_check,
         bound_app_id=excluded.bound_app_id, expected_app_id=excluded.expected_app_id,
         app_installed=excluded.app_installed, permission_diff=excluded.permission_diff,
         ruleset_snapshot=excluded.ruleset_snapshot, verified_at=excluded.verified_at,
         error=excluded.error`)
      .run(row.repo_id, row.nwo_snapshot, row.ruleset_requires_check, row.bound_app_id,
           row.expected_app_id, row.app_installed, row.permission_diff, row.ruleset_snapshot,
           row.verified_at, row.error);
    // The row image, so the restore drill can replay it. `repo_gate_state` is
    // declared non-replayed -- the next tick re-derives it -- but the EVENT is
    // the record of what reeve saw and when, which a re-derivation cannot
    // recover after the fact.
    const wrote = db.prepare(`SELECT ${ROW} FROM repo_gate_state WHERE repo_id = ?`).get(row.repo_id);
    hubEvent(db, { kind: "repo_gate_state.refreshed", payload: wrote });
    return wrote;
  });
}
