// @ts-check
// What the merge policy publishes of its decision records (#274): each result it
// posts on a pull request's commit names the record it kept for that verdict,
// and where the pull request's signed order stood. GitHub keeps it, out of reach
// of whoever can change the store, so a copy of the store checked elsewhere,
// away from the host's anchor, is checked against what was published.

import { execFileSync } from "node:child_process";
import { POLICY_APP, POLICY_CONTEXT } from "./github/reconciler.mjs";
import { netTimeoutMs, netFailure } from "./net-bound.mjs";

/**
 * What one result published: the record kept for its verdict; the pull
 * request's signed order as it stood, `null` where it had no entry yet; and how
 * many pull requests' orders, and entries in all, the store held then, so a
 * pull request whose every record and entry is taken away from a copy still
 * shows, in what was published for any other.
 * @typedef {{ pr: number, record: string, order: { n: number, names: string } | null,
 *             store: { prs: number, entries: number } }} Evidence
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
      || !count(e.store?.prs) || !count(e.store?.entries))
    throw new Error(`not evidence to publish: ${JSON.stringify(e)}`);
  const { prs, entries } = e.store;
  return ["", HEADING, "",
    `- record of #${e.pr}: \`${e.record}\``,
    e.order ? `- signed order of #${e.pr}: entry ${e.order.n}, naming \`${e.order.names}\`` : `- signed order of #${e.pr}: no entry yet`,
    `- signed orders of this store: ${prs} pull request${prs === 1 ? "" : "s"}, ${entries} entr${entries === 1 ? "y" : "ies"}`,
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
  const all = /^- signed orders of this store: (0|[1-9]\d{0,14}) pull requests?, (0|[1-9]\d{0,14}) entr(?:y|ies)$/.exec(block[2] ?? "");
  if (block.length !== 3 || !rec || !ord || !all || ord[1] !== rec[1]) return { garbled: true };
  return { pr: Number(rec[1]), record: rec[2], order: ord[2] ? { n: Number(ord[2]), names: ord[3] } : null,
           store: { prs: Number(all[1]), entries: Number(all[2]) } };
}

/**
 * How evidence `e` falls short of `prior`, published before it for the same
 * pull request: an earlier entry of its order, or fewer pull requests' orders
 * or entries in the store, as a store rolled back or restored from before
 * would give. Null where it doesn't.
 * @param {Evidence} e @param {Evidence} prior
 */
export function evidenceBehind(e, prior) {
  const n = e.order?.n ?? 0, was = prior.order?.n ?? 0;
  const short = [
    n < was ? `the store's signed order of #${e.pr} ends at entry ${n}, where entry ${was} was published` : null,
    e.store.prs < prior.store.prs ? `it holds the signed orders of ${e.store.prs} pull request(s), where ${prior.store.prs} were published` : null,
    e.store.entries < prior.store.entries ? `it holds ${e.store.entries} entries in all, where ${prior.store.entries} were published` : null,
  ].filter(Boolean);
  return short.length ? short.join("; ") : null;
}

/** `gh api`, as the person running this reads GitHub, bounded as every read is (#282): `out` or `err`. @param {string[]} args */
function ghApi(args) {
  try { return { ok: true, out: execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
                                                                   timeout: netTimeoutMs(), killSignal: "SIGKILL" }).trim() }; }
  catch (e) { return { ok: false, out: "", err: netFailure(e) }; }
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
