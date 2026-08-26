// prs -- the task's pull requests, asked ONCE.
//
// WHY THIS MODULE EXISTS. Five places in the transition applier ask "what does
// this task have open": the predicate that decides whether a hold is written,
// the hold itself, the close, and the two annotations. The spec PR used to live
// as columns on `task` while implementation PRs were rows, so each of those five
// merged two shapes by hand -- and three of them learned about the spec PR one
// review round at a time, while rounds 2, 3, 4 and 6 produced eight findings of
// that single shape, rising rather than falling.
//
// The schema now holds both kinds as `task_pr` rows. This module is the other
// half: one function to ask the question, so a site added later cannot ask it a
// sixth way. `test/hub-transition.test.mjs` asserts that nothing outside this
// file queries the table directly, because a shared helper nobody is required to
// use is a convention, and conventions are what the eight findings were.

/** The columns every caller needs, in one place so a new one cannot omit head_sha. */
export const PR_COLS = `task, kind, generation, slice, repo_id, pr, head_sha, created_at, merged_sha`;

/**
 * Every pull request this task still has open, of both kinds.
 *
 * OPEN means `merged_sha IS NULL`. `task_pr` is durable history -- rows survive
 * the merge and record it -- so a filter is what distinguishes "has an open PR"
 * from "ever had one". Without it, terminal transitions scheduled holds and
 * closes against a PR that merged weeks ago, and a cancellation that cannot
 * drain is a task that cannot reach a terminal phase.
 *
 * `kind` narrows to one sort when a caller genuinely means one: a redesign
 * closes implementation PRs and must leave the spec PR alone, because a redesign
 * pushes a NEW HEAD to that same PR rather than opening another.
 *
 * Ordered so a caller that enqueues per row produces a stable sequence: two runs
 * over the same task enqueue in the same order, which is what makes an
 * idempotency key derived from position reproducible.
 */
export function openPrs(db, taskId, { kind = null } = {}) {
  return kind === null
    ? db.prepare(
        `SELECT ${PR_COLS} FROM task_pr
          WHERE task = ? AND merged_sha IS NULL
          ORDER BY repo_id, pr`).all(taskId)
    : db.prepare(
        `SELECT ${PR_COLS} FROM task_pr
          WHERE task = ? AND kind = ? AND merged_sha IS NULL
          ORDER BY repo_id, pr`).all(taskId, kind);
}

/** Does this task have anything open at all? The predicate the machine reads. */
export const hasOpenPr = (db, taskId) => openPrs(db, taskId).length > 0;
