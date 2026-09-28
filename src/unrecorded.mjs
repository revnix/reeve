// @ts-check
// Withdraw, once, the results reeve published before it kept a record (#242).
//
// Versions of reeve before #239 kept no record of what they published, and older
// ones published shadow results as `neutral` under the enforcement check's own
// name, which a required check reads as passing. #239 withdraws only what reeve
// recorded, and an open pull request's old result is written over by its next
// publication, but a closed one's is never looked at again: reopened once a
// rule requires the check, it could merge on that result. So before reeve
// enforces, it withdraws its own results under that name at the head of every
// pull request that didn't merge, once, and records that it has.

import { POLICY_CONTEXT } from "./github/reconciler.mjs";
import { unmergedHeads, withdrawVerdict } from "./pr.mjs";

/** @typedef {import("node:sqlite").DatabaseSync} Db */

/** The event that records it's done, per repository. */
export const UNRECORDED_OP = "unrecorded.withdrawn";
const WHY = "the merge policy published it before it kept a record of what it publishes, so it withdraws it once, before it enforces";

/**
 * Whether it's been done for `nwo`.
 * @param {Db} db @param {string} nwo
 */
export function unrecordedWithdrawn(db, nwo) {
  return Boolean(db.prepare("SELECT 1 FROM event WHERE op = ? AND subject = ? LIMIT 1").get(UNRECORDED_OP, `repo:${nwo}`));
}

/**
 * Withdraw reeve's own results under the enforcement check's name at the head of
 * every pull request that didn't merge, and record that it's done. Once recorded,
 * it isn't done again. A list that couldn't be read, or a withdrawal that failed,
 * leaves it unrecorded, to run again.
 * @param {{ nwo: string, db: Db, list?: typeof unmergedHeads,
 *           withdraw?: (a: { nwo: string, head: string, name: string, why: string }) => Promise<{ ok: boolean, id?: unknown, why?: string }>,
 *           log?: (line: string) => void }} o
 */
export async function withdrawUnrecorded({ nwo, db, list = unmergedHeads, withdraw = withdrawVerdict, log = () => {} }) {
  /** @type {number[]} */ const withdrawn = [];
  /** @type {{ pr: number, head: string, why: string }[]} */ const failed = [];
  if (unrecordedWithdrawn(db, nwo)) return { ok: true, already: true, checked: 0, withdrawn, failed, why: null };
  const l = list(nwo);
  if (!l.ok) return { ok: false, already: false, checked: 0, withdrawn, failed, why: `the pull requests that didn't merge couldn't be listed: ${l.why}` };
  const prs = l.prs ?? [];
  for (const { pr, head } of prs) {
    let r;
    try { r = await withdraw({ nwo, head, name: POLICY_CONTEXT, why: WHY }); }
    catch (err) { r = { ok: false, why: /** @type {Error} */ (err).message }; }
    if (!r?.ok) {
      failed.push({ pr, head, why: String(r?.why ?? "unknown") });
      log(`  #${pr}: COULD NOT WITHDRAW reeve's result at ${head.slice(0, 8)} — ${r?.why}`);
      continue;
    }
    if (r.id != null) {
      withdrawn.push(pr);
      log(`  #${pr}: withdrew reeve's result at ${head.slice(0, 8)}, published before it kept a record`);
    }
  }
  if (failed.length)
    return { ok: false, already: false, checked: prs.length, withdrawn, failed,
             why: `${failed.length} of ${prs.length} pull request(s) couldn't be checked, so it isn't recorded as done` };
  db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
    .run(Math.floor(Date.now() / 1000), "reeve", UNRECORDED_OP, `repo:${nwo}`, JSON.stringify({ name: POLICY_CONTEXT, checked: prs.length, withdrawn }));
  return { ok: true, already: false, checked: prs.length, withdrawn, failed, why: null };
}
