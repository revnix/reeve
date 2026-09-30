// @ts-check
// What the merge policy publishes of its decision records (#274): each result it
// posts on a pull request's commit names the record it kept for that verdict,
// and where the pull request's signed order stood. GitHub keeps it, out of reach
// of whoever can change the store, so a copy of the store checked elsewhere,
// away from the host's anchor, is checked against what was published.

import { execFileSync } from "node:child_process";
import { POLICY_APP, POLICY_CONTEXT } from "./github/reconciler.mjs";

/**
 * What one result published: the record kept for its verdict, and the pull
 * request's signed order as it stood, `null` where it had no entry yet.
 * @typedef {{ pr: number, record: string, order: { n: number, names: string } | null }} Evidence
 */

const HEX = /^[0-9a-f]{64}$/;

/**
 * The evidence as a result's text shows it, after the verdict: a heading and two
 * lines, for a person to read and for `readEvidence` to take back.
 * @param {Evidence} e
 */
export function evidenceText(e) {
  if (!Number.isSafeInteger(e.pr) || e.pr < 1 || !HEX.test(e.record)
      || (e.order && (!Number.isSafeInteger(e.order.n) || e.order.n < 1 || !HEX.test(e.order.names))))
    throw new Error(`not evidence to publish: ${JSON.stringify(e)}`);
  return ["", "#### Evidence", "",
    `- record of #${e.pr}: \`${e.record}\``,
    e.order ? `- signed order of #${e.pr}: entry ${e.order.n}, naming \`${e.order.names}\`` : `- signed order of #${e.pr}: no entry yet`,
  ].join("\n");
}

/**
 * The evidence a result's text publishes for pull request `pr`, as `evidenceText`
 * writes it; null where it holds none, or none that reads whole.
 * @param {string | null | undefined} text @param {number} pr
 * @returns {Evidence | null}
 */
export function readEvidence(text, pr) {
  const lines = String(text ?? "").split("\n");
  const record = lines.map((l) => new RegExp(`^- record of #${pr}: \`([0-9a-f]{64})\`$`).exec(l)).find(Boolean)?.[1];
  if (!record) return null;
  const none = lines.includes(`- signed order of #${pr}: no entry yet`);
  const m = lines.map((l) => new RegExp(`^- signed order of #${pr}: entry ([1-9]\\d{0,14}), naming \`([0-9a-f]{64})\`$`).exec(l)).find(Boolean);
  if (none === Boolean(m)) return null;
  return { pr, record, order: m ? { n: Number(m[1]), names: m[2] } : null };
}

/** `gh api`, as the person running this reads GitHub: `out` or `err`. @param {string[]} args */
function ghApi(args) {
  try { return { ok: true, out: execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).trim() }; }
  catch (e) { return { ok: false, out: "", err: String(/** @type {any} */ (e).stderr || /** @type {Error} */ (e).message).trim() }; }
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
      const e = readEvidence(run.summary, pr);
      if (e) evidence.push({ ...e, head });
    }
  }
  return { evidence };
}
