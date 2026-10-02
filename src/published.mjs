// @ts-check
// What the merge policy publishes of its decision records (#274): each result it
// posts on a pull request's commit names the record it kept for that verdict,
// and where the pull request's signed order stood. GitHub keeps it, out of reach
// of whoever can change the store, so a copy of the store checked elsewhere,
// away from the host's anchor, is checked against what was published.

import { POLICY_APP, POLICY_CONTEXT } from "./github/reconciler.mjs";
import { netTimeoutMs, netFailure } from "./net-bound.mjs";

import { gh as runGh } from "./github/calls.mjs";
/**
 * What one result published: the record kept for its verdict; the pull
 * request's signed order as it stood, `null` where it had no entry yet; and a
 * commitment to every signed order the store held up to its event `to` (#285),
 * so a pull request whose orders are taken away from a copy, or swapped for
 * others, still shows, in what was published for any other: `chained`, over
 * every entry of each order (#303), as published since; or over each order's
 * top, as published before.
 * @typedef {{ pr: number, record: string, order: { n: number, names: string } | null,
 *             store: { to: number, orders: string, chained?: boolean } }} Evidence
 */

const HEX = /^[0-9a-f]{64}$/;
const HEADING = "#### Evidence";
const count = (/** @type {unknown} */ n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;

/**
 * The evidence as a result's text shows it, after the verdict: a heading and
 * three lines, for a person to read and for `readEvidence` to take back.
 * @param {Evidence} e
 */
export function evidenceText(e) {
  if (!Number.isSafeInteger(e.pr) || e.pr < 1 || !HEX.test(e.record)
      || (e.order && (!Number.isSafeInteger(e.order.n) || e.order.n < 1 || !HEX.test(e.order.names)))
      || !count(e.store?.to) || !HEX.test(String(e.store?.orders)))
    throw new Error(`not evidence to publish: ${JSON.stringify(e)}`);
  return ["", HEADING, "",
    `- record of #${e.pr}: \`${e.record}\``,
    e.order ? `- signed order of #${e.pr}: entry ${e.order.n}, naming \`${e.order.names}\`` : `- signed order of #${e.pr}: no entry yet`,
    `- signed orders of this store, ${e.store.chained ? "every entry chained, " : ""}to its event ${e.store.to}: \`${e.store.orders}\``,
  ].join("\n");
}

/**
 * The evidence a result's text publishes, as `evidenceText` writes it. Only the
 * block after its last heading is read, as that's where it's written: lines like
 * it that the verdict's own text carries, from a check's name say, are never
 * taken for it. Null where the text has no heading; `garbled` where the block
 * doesn't read whole, one line of each kind and nothing else.
 * @param {string | null | undefined} text
 * @returns {Evidence | { garbled: true } | null}
 */
export function readEvidence(text) {
  const lines = String(text ?? "").split("\n");
  const at = lines.lastIndexOf(HEADING);
  if (at < 0) return null;
  const block = lines.slice(at + 1).filter((l) => l.trim() !== "");
  const rec = /^- record of #([1-9]\d{0,14}): `([0-9a-f]{64})`$/.exec(block[0] ?? "");
  const ord = /^- signed order of #([1-9]\d{0,14}): (?:entry ([1-9]\d{0,14}), naming `([0-9a-f]{64})`|no entry yet)$/.exec(block[1] ?? "");
  const all = /^- signed orders of this store, (every entry chained, )?to its event (0|[1-9]\d{0,14}): `([0-9a-f]{64})`$/.exec(block[2] ?? "");
  if (block.length !== 3 || !rec || !ord || !all || ord[1] !== rec[1]) return { garbled: true };
  return { pr: Number(rec[1]), record: rec[2], order: ord[2] ? { n: Number(ord[2]), names: ord[3] } : null,
           store: { to: Number(all[2]), orders: all[3], ...(all[1] ? { chained: true } : {}) } };
}

/**
 * How evidence `e` falls short of `prior`, published before it for the same
 * pull request: an earlier entry of its order, or another record at the entry
 * published, as a store restored onto a host without its anchor would sign
 * under a number already published; or the store's orders committed to an
 * earlier event than published, or to the published event otherwise than
 * published (#285). `entryAt` gives the record the store's order names at an
 * entry, and `commitAt` the store's commitment to its orders up to an event,
 * where each can say; without them, only an entry, or a commitment, at the same
 * number is compared. And a record published that the store doesn't hold, as
 * one kept by a tick that stopped before its order named it, and taken away
 * since, where `holds` can say: no order or commitment may name it yet, and the
 * result published is all that witnesses it. Null where it doesn't fall short.
 * @param {Evidence} e @param {Evidence} prior @param {((n: number) => string | undefined) | null} [entryAt]
 * @param {((to: number, chained: boolean) => string | null) | null} [commitAt] @param {((digest: string) => boolean) | null} [holds]
 */
export function evidenceBehind(e, prior, entryAt = null, commitAt = null, holds = null) {
  const n = e.order?.n ?? 0, was = prior.order?.n ?? 0;
  const there = !prior.order || n < was ? undefined : entryAt ? entryAt(was) : n === was ? e.order?.names : undefined;
  const short = [
    n < was ? `the store's signed order of #${e.pr} ends at entry ${n}, where entry ${was} was published` : null,
    there !== undefined && there !== prior.order?.names
      ? `the store's entry ${was} of #${e.pr}'s signed order names ${String(there).slice(0, 12)}, where ${String(prior.order?.names).slice(0, 12)} was published` : null,
    e.store.to < prior.store.to ? `its signed orders go to its event ${e.store.to}, where orders to event ${prior.store.to} were published` : null,
    // As the prior committed, over each top or every entry (#303): without a
    // store to ask, a commitment of another kind can't be compared.
    e.store.to >= prior.store.to && (commitAt ? commitAt(prior.store.to, Boolean(prior.store.chained))
      : e.store.to === prior.store.to && Boolean(e.store.chained) === Boolean(prior.store.chained) ? e.store.orders : prior.store.orders) !== prior.store.orders
      ? `its signed orders to event ${prior.store.to} aren't those published` : null,
    holds && prior.record !== e.record && !holds(prior.record)
      ? `the record published there, ${prior.record.slice(0, 12)}, isn't one this store holds` : null,
  ].filter(Boolean);
  return short.length ? short.join("; ") : null;
}

/** `gh api`, as the person running this reads GitHub, bounded as every read is (#282): `out` or `err`. @param {string[]} args */
function ghApi(args) {
  try { return { ok: true, out: runGh(["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
                                                                   timeout: netTimeoutMs(), killSignal: "SIGKILL" }).trim() }; }
  catch (e) { return { ok: false, out: "", err: netFailure(e) }; }
}

/**
 * The pull requests of `nwo` GitHub lists (#285), read from GitHub, not from
 * any copy of the store, so one a copy no longer names is found all the same:
 * the `limit` most recently updated, every one open, and, where `since` is
 * given, in seconds, every one updated since (#308). Read a page at a time,
 * most recently updated first, to the first page that reaches back before
 * `since`. `why` where GitHub couldn't be read.
 * @param {string} nwo
 * @param {{ gh?: (args: string[]) => { ok: boolean, out: string, err?: string }, limit?: number, since?: number | null }} [o]
 * @returns {number[] | { why: string }}
 */
export function listPullRequests(nwo, { gh = ghApi, limit = 100, since = null } = {}) {
  const per = Math.min(100, limit);
  const unread = (/** @type {string | undefined} */ err) => ({ why: `the pull requests of ${nwo} couldn't be listed: ${err}` });
  const unlike = { why: `the pull requests of ${nwo} don't read as GitHub's` };
  const number = (/** @type {string} */ s) => { const n = Number(s); return Number.isSafeInteger(n) && n >= 1 ? n : null; };
  /** @type {Set<number>} */ const prs = new Set();
  for (let page = 1; ; page++) {
    const got = gh([`repos/${nwo}/pulls?state=all&sort=updated&direction=desc&per_page=${per}&page=${page}`, "--jq", '.[] | "\\(.number) \\(.updated_at)"']);
    if (!got.ok) return unread(got.err);
    const rows = got.out.split("\n").filter(Boolean).map((l) => { const [n, at] = l.split(" "); return { n: number(n), at: Date.parse(at) / 1000 }; });
    if (rows.some((r) => r.n === null || !Number.isFinite(r.at))) return unlike;
    for (const r of rows) if ((page === 1 && prs.size < limit) || (since !== null && r.at >= since)) prs.add(/** @type {number} */ (r.n));
    if (since === null || rows.length < per || /** @type {any} */ (rows.at(-1)).at < since) break;
  }
  const open = gh(["--paginate", `repos/${nwo}/pulls?state=open&per_page=100`, "--jq", ".[].number"]);
  if (!open.ok) return unread(open.err);
  for (const s of open.out.split("\n").filter(Boolean)) { const n = number(s); if (n === null) return unlike; prs.add(n); }
  return [...prs];
}

/**
 * What the merge policy published for pull request `pr` of `nwo`: the evidence
 * on its own results, shadow or not, at the pull request's head as GitHub has
 * it now and at each of `heads`. A result another App posted under its name is
 * never taken. `why` where GitHub couldn't be read, which vouches for nothing.
 * @param {string} nwo @param {number} pr @param {string[]} heads
 * @param {{ gh?: (args: string[]) => { ok: boolean, out: string, err?: string } }} [o]
 * @returns {{ evidence: (Evidence & { head: string })[] } | { why: string }}
 */
export function readPublished(nwo, pr, heads, { gh = ghApi } = {}) {
  const pull = gh([`repos/${nwo}/pulls/${pr}`, "--jq", ".head.sha"]);
  if (!pull.ok || !/^[0-9a-f]{40}$/.test(pull.out)) return { why: `#${pr} couldn't be read from GitHub: ${pull.err || pull.out || "no head"}` };
  const names = new Set([POLICY_CONTEXT, `${POLICY_CONTEXT} (shadow)`]);
  /** @type {(Evidence & { head: string })[]} */ const evidence = [];
  for (const head of [...new Set([pull.out, ...heads])]) {
    const runs = gh(["--paginate", `repos/${nwo}/commits/${head}/check-runs?per_page=100&filter=latest`,
      "--jq", ".check_runs[] | {name, app: .app.slug, summary: .output.summary}"]);
    if (!runs.ok) return { why: `the results at ${head.slice(0, 8)} couldn't be read from GitHub: ${runs.err}` };
    for (const line of runs.out.split("\n").filter(Boolean)) {
      let run;
      try { run = JSON.parse(line); } catch { return { why: `the results at ${head.slice(0, 8)} don't read as GitHub's` }; }
      if (run.app !== POLICY_APP || !names.has(run.name)) continue;
      const e = readEvidence(run.summary);
      if (!e) continue;
      // Its own result, with evidence that doesn't read whole, vouches for nothing, and says so.
      if ("garbled" in e) return { why: `the merge policy's result at ${head.slice(0, 8)} carries evidence that doesn't read whole` };
      // Another pull request's, at a commit both are at, is that one's to check.
      if (e.pr === pr) evidence.push({ ...e, head });
    }
  }
  return { evidence };
}
