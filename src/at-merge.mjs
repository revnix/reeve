// @ts-check
/**
 * A merged pull request judged once after its merge, as it stood at it (#342).
 * The trial counts a merge's verdict, and a merge may come between two ticks,
 * or while the daemon is down; the founder decided on 2026-10-02 that such a
 * merge is judged after it rather than missed.
 *
 * Its head's checks, and its base's at the commit the merge went onto, are
 * read as they stood then. What the base's rules made of it is read from
 * GitHub's own record of them judging its push: passed, or gone past by a
 * bypass. Its reviews are read after it, and what was made since is left out;
 * edits and resolutions are read as they are then, as GitHub keeps no time for
 * them (decided with the founder on 2026-10-03). What can't be read as it
 * stood is unknown, never taken as it reads now.
 */
import { evaluatePr } from "./pr.mjs";
import { observe, ingest, noteHead } from "./review/ingest.mjs";
import { derivePr } from "./review/derive.mjs";

/**
 * The verdict on `merge`'s final head, as it stood at the merge.
 * `hold` is the hold the caller reads for it, as it reads one for a live pull
 * request: null asks none, as for one no builder made.
 * @param {{ nwo: string, merge: { pr: number, head: string, mergedAt: number, mergeCommit: string, baseRef: string, headRef?: string, title?: string },
 *           profile: any, db: any, now?: number, hold?: any }} o
 */
export function judgeAtMerge({ nwo, merge, profile, db, now = Math.floor(Date.now() / 1000), hold = null }) {
  const { pr, head, mergedAt, mergeCommit, baseRef } = merge;
  // Pinned to the head GitHub merged: its branch may be gone.
  const anchor = { ok: true, headRef: merge.headRef ?? "", baseRef, state: "MERGED", title: merge.title ?? "",
                   updatedAt: new Date(mergedAt * 1000).toISOString(), head, pin: { ok: true, sha: head } };
  noteHead(db, nwo, pr, head, mergedAt);
  const seen = observe(nwo, pr);
  ingest(db, nwo, pr, seen.observations, { at: now });
  const folded = derivePr(db, nwo, pr, profile, { at: now, head, complete: !seen.incomplete, until: mergedAt });
  try {
    return evaluatePr({ nwo, pr, profile, db, anchor, hold, io: { foldPrecedesEvaluation: true }, asOf: { at: mergedAt, mergeCommit, unplaced: folded.unplaced } });
  } finally {
    // The fold up to the merge stands in the store only for this judgment. The
    // whole one is put back: what reads reviewers across pull requests, their
    // supply for one, reads the rounds made since too.
    derivePr(db, nwo, pr, profile, { at: now, head, complete: !seen.incomplete });
  }
}
