// holds -- the one place the guardian asks whether the builder has parked a PR.
//
// `pr_hold` is written by `transition.mjs` when a builder task is held, and the
// guardian's verdict is its only reader (see `tables.mjs`). The SQL lives here
// rather than in the guardian because raw SQL belongs under `src/db/` or
// `src/build/`: a `SELECT ... FROM pr_hold` embedded in `src/daemon.mjs` is a
// second definition of the guest connection's surface, and it drifts from this
// one the first time the allowlist or the schema changes.

/**
 * The columns this module's query names. Part of the guardian's required shape:
 * a hub whose `pr_hold` has lost one of these does not throw until the first
 * held pull request is evaluated, which is the worst moment to find out.
 */
// COLUMN TO DECLARED TYPE, because `pr_hold` is STRICT and a name-only check
// passes a store whose types are wrong -- which then refuses the read. The test
// compares this against a freshly migrated hub in both directions.
export const HOLD_COLUMNS = Object.freeze({
  repo_id: "INTEGER", pr: "INTEGER", cleared_at: "INTEGER",
  reason: "TEXT", detail: "TEXT", head_sha: "TEXT",
});

/**
 * The open hold on one pull request, if any.
 *
 * THREE ANSWERS, NOT TWO. "no hold" and "reeve could not look" are different
 * facts and the caller renders them differently -- a missing hold lets the PR
 * proceed, an unreadable one must not. Collapsing them to a boolean makes an
 * unreachable hub read as "nothing is held", which is the fail-open the whole
 * connection exists to prevent.
 *
 * `cleared_at IS NULL` is the open predicate, and `one_open_hold` is a partial
 * UNIQUE over `(repo_id, pr)` on exactly that condition -- so at most one row
 * can come back and `LIMIT 1` is a statement of that, not a truncation.
 */
export function openHold(hub, { repoId, pr }) {
  if (!hub) return { readable: false, why: "no hub connection" };
  if (repoId == null) return { readable: false, why: "the repository numeric id is unknown" };
  try {
    const row = hub.prepare(
      `SELECT reason, detail, head_sha FROM pr_hold
        WHERE repo_id = ? AND pr = ? AND cleared_at IS NULL
        LIMIT 1`).get(repoId, pr);
    return row
      ? { readable: true, held: true, reason: row.reason, detail: row.detail ?? null, headSha: row.head_sha }
      : { readable: true, held: false };
  } catch (err) {
    return { readable: false, why: err.message };
  }
}
