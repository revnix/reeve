// @ts-check
// The shadow trial's seeded known-bad cases (#293, #158). A gate that passes
// everything never blocks a good pull request, so the trial also needs cases
// known to be bad, each of which must come out BLOCK, or UNKNOWN only where an
// input can't be read.
//
// Each case is a real pull request as GitHub answered for it, recorded under
// seeded/, and judged through reeve's own reading code, as the daemon judges a
// live one. A stand-in gh and git serve the recording (src/seeded-stand-in.mjs).
// The good case must pass. Each bad one changes one thing about it, and must
// get its verdict for that reason: a case with red CI that blocks only because
// something else went wrong proves nothing about CI.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SEEDED_DIR = join(ROOT, "seeded");
const EVALUATE = join(ROOT, "src", "seeded-evaluate.mjs");
const STAND_IN = join(ROOT, "src", "seeded-stand-in.mjs");
/** The recordings under seeded/, each judged with every case. */
export const RECORDINGS = Object.freeze(["nextly-1963"]);

/**
 * @typedef {{ call: string[], status: number, stdout: string, stderr?: string, edited?: string }} Answer
 * @typedef {{ about: string, repo: string, pr: number, head: string, base: string, at: string, appId: string,
 *             profile: any, answers: Answer[] }} Recording
 * @typedef {{ name: string, why: string, must: "PASS" | "BLOCK" | "UNKNOWN", clauses: Record<string, string>,
 *             edit: (a: Edits, r: Recording) => void }} Case
 * @typedef {{ name: string, why: string, must: string, clauses: Record<string, string>, ran: boolean, at: number | null,
 *             got: string | null, gotClauses: Record<string, string>, ok: boolean, detail: string }} Result
 */

/**
 * Every reading of the time, from `start` in seconds, moved on only by
 * `advance`, until `restore`. A time given to Date is still that time.
 * @param {number} start
 */
export function pinClock(start) {
  const Real = globalThis.Date;
  let t = start * 1000;
  class Pinned extends Real {
    /** @param {any[]} a */
    constructor(...a) { if (a.length) super(...(/** @type {[any]} */ (a))); else super(t); }
    static now() { return t; }
  }
  /** @type {any} */ (globalThis).Date = Pinned;
  return { advance: (/** @type {number} */ seconds) => { t += seconds * 1000; }, restore: () => { globalThis.Date = Real; } };
}

/** A recording, by its name under seeded/. @param {string} name @returns {Recording} */
export function loadRecording(name, dir = SEEDED_DIR) {
  return JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
}

/** The answers of a recording, copied, and ways to change them for a case. */
export class Edits {
  /** @param {Answer[]} answers */
  constructor(answers) { /** @type {Answer[]} */ this.answers = structuredClone(answers); }

  /**
   * Each answer to a call holding every one of `parts`, changed by `fn`. None
   * is an error: an edit that finds nothing would leave the good case standing
   * under a bad case's name.
   * @param {string[]} parts @param {(a: Answer) => Partial<Answer>} fn
   */
  each(parts, fn) {
    const hit = this.answers.filter((a) => parts.every((p) => a.call.some((c) => c.includes(p))));
    if (!hit.length) throw new Error(`no recorded answer to a call with ${parts.join(", ")}`);
    for (const a of hit) Object.assign(a, fn(a));
  }

  /** The answer, a JSON value per line, changed item by item. @param {string[]} parts @param {(items: any[]) => any[]} fn */
  lines(parts, fn) {
    this.each(parts, (a) => ({ stdout: fn(a.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l))).map((x) => JSON.stringify(x)).join("\n") + "\n" }));
  }

  /** The answer, one JSON value, changed. @param {string[]} parts @param {(v: any) => void} fn */
  json(parts, fn) {
    this.each(parts, (a) => { const v = JSON.parse(a.stdout); fn(v); return { stdout: JSON.stringify(v) + "\n" }; });
  }

  /** Tab-separated lines, changed row by row. @param {string[]} parts @param {(row: string[]) => string[] | null} fn */
  rows(parts, fn) {
    this.each(parts, (a) => ({ stdout: a.stdout.split("\n").filter(Boolean).map((l) => fn(l.split("\t"))).filter((r) => r !== null).map((r) => r.join("\t")).join("\n") + "\n" }));
  }
}

// The pattern reeve reads a clean pass's commit by where a reviewer declares
// none, as src/pr.mjs names it.
const CLEAN_COMMIT = "Reviewed commit:\\**\\s*`?([0-9a-f]{7,40})`?";
/** What a body cut to nothing reeve reads says, told from a body that was empty. */
export const LEFT_OUT = "(left out)";

/**
 * A recording's review and comment bodies cut to what reeve's reading matches
 * in them (#298's review): for a reviewer the profile declares, what its
 * refusal, clean, commit, body-finding and severity rules match, and in anyone's
 * body, each reviewer's trigger. The rest, a bot's account of what it found
 * say, reeve reads none of, so it's left out, and so is the App a comment was
 * made through. A body with nothing left reads LEFT_OUT: an empty body is a
 * carrier to reeve, and one cut isn't.
 * @param {Answer[]} answers @param {any} profile @returns {Answer[]}
 */
export function redactBodies(answers, profile) {
  const roster = /** @type {any[]} */ (profile?.reviewers ?? []);
  const byLogin = new Map(roster.map((r) => [String(r.login).toLowerCase(), r]));
  const triggers = roster.map((r) => r.trigger).filter((t) => typeof t === "string" && t);
  /** @param {unknown} body @param {unknown} login */
  const cut = (body, login) => {
    if (typeof body !== "string" || !body) return body;
    const rev = byLogin.get(String(login ?? "").replace(/\[bot\]$/i, "").toLowerCase());
    const rules = rev ? [rev.refusal, rev.clean, rev.commitPattern ?? CLEAN_COMMIT, typeof rev.bodyFindings === "string" ? rev.bodyFindings : null,
                         ...(rev.severityMarkers ?? []).map((/** @type {any[]} */ m) => m[0])].filter(Boolean) : [];
    /** @type {[number, string][]} */ const kept = [];
    for (const rule of rules) for (const m of body.matchAll(new RegExp(rule, "gi"))) if (m[0]) kept.push([m.index ?? 0, m[0]]);
    for (const t of triggers) for (let i = body.indexOf(t); i >= 0; i = body.indexOf(t, i + 1)) kept.push([i, t]);
    return kept.length ? kept.sort((a, b) => a[0] - b[0]).map(([, text]) => text).join("\n") : LEFT_OUT;
  };
  /** One line of tab-separated values, its column `i` cut as `login`'s body, kept on one line. @param {string} line @param {number} i */
  const row = (line, i) => { const f = line.split("\t"); if (f.length > i) f[i] = String(cut(f[i], f[0])).replace(/\n/g, " "); return f.join("\t"); };
  return answers.map((a) => {
    if (a.status !== 0) return a;
    const path = a.call.find((c) => /^repos\//.test(c)) ?? "";
    const jq = a.call.includes("--jq");
    const comments = /^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments\?/.test(path), reviews = /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews\?/.test(path);
    if ((comments || reviews) && !jq) {
      const v = JSON.parse(a.stdout);
      // And the App it was made through, which reeve doesn't read either.
      return { ...a, stdout: JSON.stringify(v.map((/** @type {any} */ { performed_via_github_app: _app, ...x }) => ({ ...x, body: cut(x.body, x.user?.login) }))) + "\n" };
    }
    if ((comments || reviews) && jq) {
      const lines = a.stdout.split("\n");
      return { ...a, stdout: lines.map((l) => (l ? row(l, comments ? 2 : 3) : l)).join("\n") };
    }
    if (a.call[2] === "graphql" && a.call.some((c) => c.includes("comments(first"))) {
      const v = JSON.parse(a.stdout);
      for (const n of v?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [])
        for (const c of n?.comments?.nodes ?? []) c.body = cut(c.body, c.author?.login);
      return { ...a, stdout: JSON.stringify(v) + "\n" };
    }
    return a;
  });
}

/** The check runs at a commit. @param {Recording} r @param {string} sha */
const runsAt = (r, sha) => [`repos/${r.repo}/commits/${sha}/check-runs`];
/** GraphQL's pull request, in both reads that carry it. */
const PR_GRAPHQL = ["graphql", "pullRequest(number:$n)"];

/** @type {Case[]} */
export const CASES = [
  { name: "good", why: "the pull request as it stood, approved, with every check green", must: "PASS", clauses: {},
    edit: () => {} },
  { name: "red CI", why: "a required check failed", must: "BLOCK", clauses: { ci: "BLOCK" },
    edit: (a, r) => a.lines(runsAt(r, r.head), (runs) => runs.map((x) => (x.name === "CI gate" ? { ...x, conclusion: "failure" } : x))) },
  { name: "a required check never reported", why: "a check the base's rules require isn't there at all", must: "BLOCK", clauses: { ci: "BLOCK" },
    edit: (a, r) => a.lines(runsAt(r, r.head), (runs) => runs.filter((x) => x.name !== "CI gate")) },
  { name: "a required check skipped", why: "a required check that doesn't run only in the queue was skipped", must: "BLOCK", clauses: { ci: "BLOCK" },
    edit: (a, r) => a.lines(runsAt(r, r.head), (runs) => runs.map((x) => (x.name === "CI gate" ? { ...x, conclusion: "skipped" } : x))) },
  { name: "a queue-only check skipped with no queue", why: "the check that runs only in the merge queue was skipped, where the base's rules have no queue", must: "BLOCK", clauses: { ci: "BLOCK" },
    edit: (a, r) => a.lines([`repos/${r.repo}/rules/branches/`], (rules) => rules.filter((x) => x.type !== "merge_queue")) },
  { name: "a required check from another App", why: "a check with a required name, from an App the rule doesn't name", must: "BLOCK", clauses: { ci: "BLOCK" },
    edit: (a, r) => a.lines(runsAt(r, r.head), (runs) => runs.map((x) => (x.name === "CI gate" ? { ...x, app: { id: 999999, slug: "not-the-ci", name: "Not the CI" } } : x))) },
  { name: "an unresolved thread", why: "a review thread left unresolved", must: "BLOCK", clauses: { threads: "BLOCK" },
    edit: (a) => a.json(PR_GRAPHQL, (v) => { const n = v.data.repository.pullRequest.reviewThreads.nodes; n[n.length - 1].isResolved = false; }) },
  // The base requires an approval, so GitHub holds the merge for each of
  // these two, and says so in its merge state as well as its review decision.
  { name: "changes requested", why: "the person's review requests changes rather than approving", must: "BLOCK", clauses: { mergeable: "BLOCK" },
    edit: (a) => {
      a.json(["graphql", "mergeStateStatus"], (v) => { Object.assign(v.data.repository.pullRequest, { mergeStateStatus: "BLOCKED", reviewDecision: "CHANGES_REQUESTED" }); });
      a.json(["/reviews?per_page=100&page=1"], (v) => { for (const x of v) if (x.state === "APPROVED") x.state = "CHANGES_REQUESTED"; });
      a.rows(["/reviews?per_page=100", "--jq"], (row) => (row[2] === "APPROVED" ? [row[0], row[1], "CHANGES_REQUESTED", ...row.slice(3)] : row));
    } },
  { name: "no approval", why: "nobody has approved it, where the base requires an approval", must: "BLOCK", clauses: { mergeable: "BLOCK" },
    edit: (a) => {
      a.json(["graphql", "mergeStateStatus"], (v) => {
        const p = v.data.repository.pullRequest;
        Object.assign(p, { mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", reviews: { ...p.reviews, totalCount: p.reviews.totalCount - 1 } });
      });
      a.json(["/reviews?per_page=100&page=1"], (v) => { v.splice(0, v.length, ...v.filter((/** @type {any} */ x) => x.state !== "APPROVED")); });
      a.rows(["/reviews?per_page=100", "--jq"], (row) => (row[2] === "APPROVED" ? null : row));
    } },
  { name: "a conflict with the base", why: "the branch conflicts with its base", must: "BLOCK", clauses: { mergeable: "BLOCK" },
    edit: (a) => a.json(["graphql", "mergeStateStatus"], (v) => { Object.assign(v.data.repository.pullRequest, { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" }); }) },
  { name: "a red base the head doesn't repair", why: "a required check fails on the base, and the head doesn't contain the base's commit", must: "BLOCK", clauses: { base: "BLOCK" },
    edit: (a, r) => {
      a.lines(runsAt(r, r.base), (runs) => runs.map((x) => (x.name === "CI gate" ? { ...x, conclusion: "failure" } : x)));
      a.each([`repos/${r.repo}/compare/${r.base}...${r.head}`], () => ({ stdout: "diverged\n" }));
    } },
  { name: "GitHub not answering the checks", why: "the read of the head's check runs fails", must: "UNKNOWN", clauses: { ci: "UNKNOWN" },
    edit: (a, r) => a.each(runsAt(r, r.head), () => ({ status: 1, stdout: "", stderr: "HTTP 502: Bad Gateway\n" })) },
  { name: "a checks read cut short", why: "the head's check runs come back cut off mid-answer", must: "UNKNOWN", clauses: { ci: "UNKNOWN" },
    edit: (a, r) => a.each(runsAt(r, r.head), (x) => ({ stdout: x.stdout.slice(0, Math.floor(x.stdout.length / 2)) })) },
];

/**
 * A case, judged as the daemon would judge it, in a process of its own. A read
 * its recording doesn't hold makes it unrunnable, never judged.
 * @param {Recording} r @param {Case} c @returns {Promise<Result>}
 */
export async function runCase(r, c) {
  const base = { name: c.name, why: c.why, must: c.must, clauses: c.clauses };
  const dir = mkdtempSync(join(tmpdir(), "reeve-seeded-"));
  try {
    const edits = new Edits(r.answers);
    try { c.edit(edits, r); }
    catch (e) { return { ...base, ran: false, at: null, got: null, gotClauses: {}, ok: false, detail: `its recording couldn't be changed for it: ${/** @type {Error} */ (e).message}` }; }
    const bin = join(dir, "bin"), home = join(dir, "home");
    mkdirSync(bin);
    mkdirSync(join(home, "credentials"), { recursive: true, mode: 0o700 });
    for (const tool of ["gh", "git"]) {
      writeFileSync(join(bin, tool), `#!/bin/sh\nexec "${process.execPath}" "${STAND_IN}" ${tool} "$@"\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    // The App's id, so its own check is told from another's. No key: the case
    // publishes nothing, and the file named only has to be there.
    writeFileSync(join(home, "credentials", "no-key"), "", { mode: 0o600 });
    writeFileSync(join(home, "credentials", "merge-policy.env"), `APP_ID=${r.appId}\nPRIVATE_KEY=${join(home, "credentials", "no-key")}\n`, { mode: 0o600 });
    const answers = join(dir, "answers.json"), misses = join(dir, "misses"), profile = join(dir, "profile.json");
    writeFileSync(answers, JSON.stringify(edits.answers));
    writeFileSync(profile, JSON.stringify(r.profile));
    const out = await evaluate({ PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, REEVE_HOME: home, TMPDIR: dir, TZ: process.env.TZ ?? "",
                                 SEEDED_REPO: r.repo, SEEDED_PR: String(r.pr), SEEDED_PROFILE: profile, SEEDED_STORE: join(dir, "store.db"),
                                 SEEDED_ANSWERS: answers, SEEDED_MISSES: misses, SEEDED_CLOCK: String(Math.floor(Date.parse(r.at) / 1000)) });
    if (existsSync(misses)) {
      const calls = [...new Set(readFileSync(misses, "utf8").split("\n").filter(Boolean))].map((l) => JSON.parse(l).join(" "));
      return { ...base, ran: false, at: null, got: null, gotClauses: {}, ok: false, detail: `it made a read its recording doesn't hold: ${calls.join("; ")}` };
    }
    /** @type {any} */ let v = null;
    try { v = JSON.parse(out.stdout.trim().split("\n").at(-1) ?? ""); } catch { /* read below as not judged */ }
    if (!v?.ok) return { ...base, ran: false, at: null, got: null, gotClauses: {}, ok: false,
                         detail: `it wasn't judged: ${v?.why ?? (out.stderr.trim().split("\n").at(-1) || `the evaluation exited ${out.status}`)}` };
    /** @type {Record<string, string>} */
    const gotClauses = Object.fromEntries(v.clauses.map((/** @type {any} */ x) => [x.id, x.state]));
    const wrong = Object.entries(c.clauses).filter(([id, state]) => gotClauses[id] !== state);
    const ok = v.state === c.must && !wrong.length;
    const why = v.clauses.filter((/** @type {any} */ x) => x.state !== "PASS").map((/** @type {any} */ x) => `${x.id} ${x.state}: ${x.detail}`).join("; ");
    return { ...base, ran: true, at: v.at, got: v.state, gotClauses, ok,
             detail: ok ? (why || "every clause satisfied")
               : v.state !== c.must ? `it came out ${v.state}${why ? ` (${why})` : ""}, where it must be ${c.must}`
               : `it came out ${v.state}, but not for its reason: ${wrong.map(([id, state]) => `${id} is ${gotClauses[id] ?? "absent"}, not ${state}`).join("; ")}${why ? ` (${why})` : ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The evaluation, in a process of its own with `env` alone.
 * @param {Record<string, string>} env @returns {Promise<{ status: number | null, stdout: string, stderr: string }>}
 */
function evaluate(env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [EVALUATE], { env, timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; });
    child.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; });
    child.on("error", (e) => { stderr += e.message; });
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

/**
 * Every case of every recording, a few at a time.
 * @param {{ dir?: string, cases?: Case[], parallel?: number }} [o] @returns {Promise<Result[]>}
 */
export async function runSeeded({ dir = SEEDED_DIR, cases = CASES, parallel = Math.max(1, Math.min(6, availableParallelism() - 1)) } = {}) {
  const jobs = RECORDINGS.filter((n) => existsSync(join(dir, `${n}.json`)))
    .flatMap((n) => { const r = loadRecording(n, dir); return cases.map((c) => () => runCase(r, c)); });
  /** @type {Result[]} */ const out = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  }));
  return out;
}
