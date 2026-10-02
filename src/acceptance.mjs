// @ts-check
/**
 * Acceptance evidence, as the first customer defines merge-ready (#167): each
 * acceptance criterion of the task a pull request delivers has an entry in the
 * pull request's "Acceptance evidence" section, numbered in the task's order.
 *
 * The task is found from the private side, never named on the pull request,
 * which may be public: the issue, in the repository the profile names as
 * where tasks live (`tasks.repo`), whose latest checkpoint names the pull
 * request. A pull request no task's checkpoint names delivers none.
 */
import { gh as runGh } from "./github/calls.mjs";
import { netTimeoutMs, netFailure } from "./net-bound.mjs";

/** How long the tasks found for a pull request at a head are kept before they're looked for again, in seconds. */
const TASK_KEPT_SECONDS = 3600;
/** The line a checkpoint comment begins with. */
const CHECKPOINT = "<!-- checkpoint v1 -->";
/** @typedef {(args: string[]) => { ok: boolean, out: string, err?: string }} Gh */
/** @typedef {{ head: string, at: number, tasks: number[], criteria: number }} Kept */
/** The tasks found for each pull request, by `owner/name#N`, for as long as this process runs. @type {Map<string, Kept>} */
const KEPT = new Map();

/** `gh api`, as the machine's login reads GitHub, bounded as every read is (#282). @type {Gh} */
function ghApi(args) {
  try { return { ok: true, out: runGh(["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
                                                                   timeout: netTimeoutMs(), killSignal: "SIGKILL" }).trim() }; }
  catch (e) { return { ok: false, out: "", err: netFailure(e) }; }
}

/** The lines of the Markdown section headed `title`, at any level, to the next heading. @param {unknown} body @param {string} title */
function section(body, title) {
  const lines = String(body ?? "").split(/\r?\n/);
  const heading = new RegExp(`^#{1,6}\\s+${title}\\s*$`, "i");
  const at = lines.findIndex((l) => heading.test(l.trim()));
  if (at < 0) return [];
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => /^#{1,6}\s/.test(l.trim()));
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * How many acceptance criteria a task's body names: the top-level items of its
 * "Acceptance criteria" section. Markdown takes a list indented up to three
 * spaces as top-level, so its first item says where that is; an item indented
 * two more is under one, as a line of its "Verified by" is part of it.
 * @param {unknown} body
 */
export function criteriaOf(body) {
  const items = section(body, "Acceptance criteria").map((l) => /^( *)(?:[-*]|\d+[.)])\s+\S/.exec(l)).filter((m) => m !== null);
  const top = items.length ? /** @type {RegExpExecArray} */ (items[0])[1].length : 0;
  if (top > 3) return 0;
  return items.filter((m) => /** @type {RegExpExecArray} */ (m)[1].length < top + 2).length;
}

/**
 * The criteria a pull request's "Acceptance evidence" section gives evidence
 * for: each numbered entry with something after its number.
 * @param {unknown} body @returns {Set<number>}
 */
export function evidenceOf(body) {
  /** @type {Set<number>} */ const given = new Set();
  for (const l of section(body, "Acceptance evidence")) {
    const m = /^ {0,3}(\d+)[.)]\s+\S/.exec(l);
    if (m) given.add(Number(m[1]));
  }
  return given;
}

/** The criteria, from 1 to `count`, with no evidence given. @param {number} count @param {Set<number>} given */
export function missingEvidence(count, given) {
  return Array.from({ length: count }, (_, i) => i + 1).filter((n) => !given.has(n));
}

/** The pull request the latest checkpoint among `comments` names, as it writes it, or null. @param {string[]} comments */
function checkpointNames(comments) {
  const last = comments.filter((c) => c.startsWith(CHECKPOINT)).at(-1);
  const m = last ? /^pr:\s*(\S+)\s*$/m.exec(last) : null;
  return m ? m[1] : null;
}

/** The one JSON string `out` is, or null where it isn't one. @param {string} out */
function one(out) {
  const all = out.trim() ? strings(out) : null;
  return all && all.length === 1 ? all[0] : null;
}

/** `out`, one JSON string to a line, read; null where a line isn't one. @param {string} out */
function strings(out) {
  try { return out.split("\n").filter(Boolean).map((l) => { const v = JSON.parse(l); if (typeof v !== "string") throw new Error(); return v; }); }
  catch { return null; }
}

/**
 * The tasks in `tasksRepo` whose latest checkpoint names `nwo#pr`, by number,
 * and how many acceptance criteria they name between them: none where one
 * names none. Found by a search, and each checked by reading its checkpoints,
 * as the search matches one naming the pull request once and another since.
 * @param {{ nwo: string, pr: number, tasksRepo: string, gh: Gh }} o
 * @returns {{ ok: true, tasks: number[], criteria: number } | { ok: false, why: string, detail: string }}
 */
function tasksOf({ nwo, pr, tasksRepo, gh }) {
  const named = `${nwo}#${pr}`;
  // Said on a pull request that may be public, so never naming the private
  // repository or a task in it; what went wrong is kept with the input, which
  // stays in the store.
  const unread = (/** @type {string} */ why, /** @type {string | undefined} */ detail) => ({ ok: /** @type {const} */ (false), why, detail: detail ?? "" });
  const found = gh(["--paginate", `search/issues?q=${encodeURIComponent(`repo:${tasksRepo} "${named}" in:comments`)}&per_page=100`, "--jq", ".items[].number"]);
  if (!found.ok) return unread("the task it delivers couldn't be looked for", found.err);
  const numbers = found.out.split("\n").filter(Boolean).map(Number);
  if (numbers.some((n) => !Number.isSafeInteger(n) || n < 1)) return unread("the task it delivers couldn't be looked for", "the search didn't read as GitHub's");
  /** @type {number[]} */ const tasks = [];
  let criteria = 0, blank = false;
  for (const n of [...new Set(numbers)].sort((a, b) => a - b)) {
    const comments = gh(["--paginate", `repos/${tasksRepo}/issues/${n}/comments?per_page=100`, "--jq", ".[].body | @json"]);
    const bodies = comments.ok ? strings(comments.out) : null;
    if (!bodies) return unread("the checkpoints of the task it may deliver couldn't be read", comments.err ?? "they don't read as GitHub's");
    if (checkpointNames(bodies) !== named) continue;
    const issue = gh([`repos/${tasksRepo}/issues/${n}`, "--jq", ".body // \"\" | @json"]);
    const body = issue.ok ? one(issue.out) : null;
    if (body === null) return unread("the task it delivers couldn't be read", issue.err ?? "it doesn't read as GitHub's");
    const c = criteriaOf(body);
    if (!c) blank = true;
    tasks.push(n);
    criteria += c;
  }
  return { ok: true, tasks, criteria: blank ? 0 : criteria };
}

/**
 * The acceptance evidence of pull request `pr` of `nwo` at `head`, its
 * description `body`, against the tasks it delivers in `tasksRepo`: which it
 * delivers, how many criteria they name, and which have no evidence. Not
 * `readable` where the tasks couldn't be looked for, which is never "none".
 * The tasks found are kept per pull request, and looked for again on a new
 * head, or an hour on.
 * @param {{ nwo: string, pr: number, head: string, body: unknown, tasksRepo: string, gh?: Gh, cache?: Map<string, Kept>, now?: number }} o
 * @returns {{ readable: true, tasks: number[], criteria: number, missing: number[] } | { readable: false, why: string, detail: string }}
 */
export function acceptanceOf({ nwo, pr, head, body, tasksRepo, gh = ghApi, cache = KEPT, now = Math.floor(Date.now() / 1000) }) {
  const key = `${nwo}#${pr}`;
  let kept = cache.get(key);
  if (!kept || kept.head !== head || now - kept.at > TASK_KEPT_SECONDS) {
    const t = tasksOf({ nwo, pr, tasksRepo, gh });
    // Kept only once read: one that couldn't be is looked for again next time.
    if ("why" in t) return { readable: false, why: t.why, detail: t.detail };
    kept = { head, at: now, tasks: t.tasks, criteria: t.criteria };
    cache.set(key, kept);
  }
  if (!kept.tasks.length) return { readable: true, tasks: [], criteria: 0, missing: [] };
  return { readable: true, tasks: kept.tasks, criteria: kept.criteria, missing: missingEvidence(kept.criteria, evidenceOf(body)) };
}

/**
 * Pull request `pr`'s description, as GitHub has it now, for its acceptance
 * evidence: `body`, or why it couldn't be read.
 * @param {string} nwo @param {number} pr @param {{ gh?: Gh }} [o]
 * @returns {{ ok: true, body: string } | { ok: false, why: string }}
 */
export function pullBody(nwo, pr, { gh = ghApi } = {}) {
  const got = gh([`repos/${nwo}/pulls/${pr}`, "--jq", ".body // \"\" | @json"]);
  const body = got.ok ? one(got.out) : null;
  return body === null ? { ok: false, why: `its description couldn't be read: ${got.err ?? "it doesn't read as GitHub's"}` } : { ok: true, body };
}
