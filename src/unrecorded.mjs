// @ts-check
// Withdraw, once, the results reeve published before it kept a record (#242).
//
// Versions of reeve before #239 kept no record of what they published, and older
// ones published shadow results as `neutral` under the enforcement check's own
// name, which a required check reads as passing. #239 withdraws only what reeve
// recorded, and an open pull request's old result is written over by its next
// publication, but a closed one's is never looked at again: reopened once a
// rule requires the check, it could merge on that result, and so could a new
// pull request headed by a merged one's commit, since a check run belongs to its
// commit. So before reeve enforces, it withdraws its own results under that name
// that could pass, at the head of every pull request, once, keeping each in the
// store first, and records that it has.

import { execFileSync } from "node:child_process";
import { POLICY_CONTEXT } from "./github/reconciler.mjs";
import { sweptHeads, withdrawVerdict } from "./pr.mjs";

/** @typedef {import("node:sqlite").DatabaseSync} Db */

/** The event that records it's done, per repository, and each result it kept before withdrawing it. */
export const UNRECORDED_OP = "unrecorded.withdrawn";
export const KEPT_OP = "unrecorded.kept";
const WHY = "the merge policy published it before it kept a record of what it publishes, so it withdraws it once, before it enforces";

/**
 * Whether it's been done for `nwo`.
 * @param {Db} db @param {string} nwo
 */
export function unrecordedWithdrawn(db, nwo) {
  return Boolean(db.prepare("SELECT 1 FROM event WHERE op = ? AND subject = ? LIMIT 1").get(UNRECORDED_OP, `repo:${nwo}`));
}

/**
 * The reeve daemons running for `nwo`, by their command line: `reeve run` or
 * `reeve tick` naming it. Null when the processes can't be listed.
 * @param {string} nwo
 * @param {{ ps?: () => string }} [o]
 * @returns {{ pid: number, args: string }[] | null}
 */
export function reeveRunsFor(nwo, { ps = () => execFileSync("ps", ["-axo", "pid=,args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }) } = {}) {
  let out;
  try { out = ps(); } catch { return null; }
  /** @type {{ pid: number, args: string }[]} */ const found = [];
  for (const line of String(out).split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) === process.pid) continue;
    const words = m[2].split(/\s+/);
    const at = words.findIndex((w) => /(^|\/)reeve$/.test(w));
    if (at >= 0 && ["run", "tick"].includes(words[at + 1]) && words.slice(at + 2).includes(nwo)) found.push({ pid: Number(m[1]), args: m[2] });
  }
  return found;
}

/**
 * Withdraw reeve's own results under the enforcement check's name that could
 * pass, at the head of every pull request, keeping each in the store first, and
 * record that it's done. Once recorded, it isn't done again. It refuses while a
 * reeve daemon for the repository runs, which could publish behind it, and while
 * that can't be told. A list that couldn't be read, or a withdrawal that failed,
 * leaves it unrecorded, to run again.
 * @param {{ nwo: string, db: Db, list?: typeof sweptHeads, running?: (nwo: string) => { pid: number, args: string }[] | null,
 *           withdraw?: (a: { nwo: string, head: string, name: string, why: string, passing: boolean,
 *                            keep: (run: any) => boolean }) => Promise<{ ok: boolean, id?: unknown, why?: string }>,
 *           log?: (line: string) => void }} o
 */
export async function withdrawUnrecorded({ nwo, db, list = sweptHeads, running = reeveRunsFor, withdraw = withdrawVerdict, log = () => {} }) {
  /** @type {number[]} */ const withdrawn = [];
  /** @type {{ pr: number, head: string, why: string }[]} */ const failed = [];
  if (unrecordedWithdrawn(db, nwo)) return { ok: true, already: true, checked: 0, withdrawn, failed, why: null };
  const daemons = running(nwo);
  if (daemons === null) return { ok: false, already: false, checked: 0, withdrawn, failed, why: "whether a reeve daemon for it is running couldn't be told" };
  if (daemons.length)
    return { ok: false, already: false, checked: 0, withdrawn, failed,
             why: `a reeve daemon for ${nwo} is running (${daemons.map((d) => `pid ${d.pid}`).join(", ")}), and could publish behind the sweep: stop it first` };
  const l = list(nwo);
  if (!l.ok) return { ok: false, already: false, checked: 0, withdrawn, failed, why: `the pull requests couldn't be listed: ${l.why}` };
  const prs = l.prs ?? [];
  for (const { pr, head } of prs) {
    let r;
    const keep = (/** @type {any} */ run) => {
      try {
        db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(Math.floor(Date.now() / 1000), "reeve", KEPT_OP, `pr:${pr}`,
          JSON.stringify({ head, run: run?.id ?? null, conclusion: run?.conclusion ?? null, title: run?.title ?? null, summary: run?.summary ?? null }));
        return true;
      } catch { return false; }
    };
    try { r = await withdraw({ nwo, head, name: POLICY_CONTEXT, why: WHY, passing: true, keep }); }
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
