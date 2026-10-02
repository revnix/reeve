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
 *
 * Both are read as GitHub renders them, never as they're written: GitHub's own
 * HTML of the task and of the description, whose headings, lists and numbers
 * are what a reader sees, however the Markdown spelled them.
 */
import { gh as runGh } from "./github/calls.mjs";
import { netTimeoutMs, netFailure } from "./net-bound.mjs";

/**
 * How long the tasks found for a pull request at a head are kept before
 * they're looked for again, in seconds. What they ask is read each time.
 */
const TASK_KEPT_SECONDS = 3600;
/** The line a checkpoint comment begins with. */
const CHECKPOINT = "<!-- checkpoint v1 -->";
/** How a body is asked for as GitHub renders it. */
const RENDERED = "Accept: application/vnd.github.html+json";
/** @typedef {(args: string[]) => { ok: boolean, out: string, err?: string }} Gh */
/** @typedef {{ head: string, at: number, tasks: number[] }} Kept */
/** @typedef {{ tag: string, attrs: string, kids: Node[] }} El @typedef {El | string} Node */
/** The tasks found for each pull request, by `owner/name#N`, for as long as this process runs. @type {Map<string, Kept>} */
const KEPT = new Map();

/** `gh api`, as the machine's login reads GitHub, bounded as every read is (#282). @type {Gh} */
function ghApi(args) {
  try { return { ok: true, out: runGh(["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
                                                                   timeout: netTimeoutMs(), killSignal: "SIGKILL" }).trim() }; }
  catch (e) { return { ok: false, out: "", err: netFailure(e) }; }
}

/** The elements HTML never closes. */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/**
 * A tag as GitHub writes one: lower case, a custom element's name with
 * hyphens (a table comes wrapped in one), each attribute's value in double
 * quotes.
 */
const TAG = /<(\/?)([a-z][a-z0-9-]*)((?: [a-z][a-z0-9-]*(?:="[^"]*")?)*)>/y;

/**
 * The elements of `html`, as GitHub renders a body, or null where it isn't as
 * GitHub writes it: a "<" that opens no tag, as GitHub escapes every other, or
 * tags that don't close in the order they opened.
 * @param {string} html @returns {El | null}
 */
function tree(html) {
  /** @type {El} */ const root = { tag: "", attrs: "", kids: [] };
  const open = [root];
  for (let at = 0; at < html.length;) {
    const lt = html.indexOf("<", at);
    const text = lt < 0 ? html.slice(at) : html.slice(at, lt);
    if (text) open[open.length - 1].kids.push(text);
    if (lt < 0) break;
    TAG.lastIndex = lt;
    const m = TAG.exec(html);
    if (!m) return null;
    at = TAG.lastIndex;
    if (m[1]) {
      if (open.length < 2 || open[open.length - 1].tag !== m[2]) return null;
      open.pop();
      continue;
    }
    const el = { tag: m[2], attrs: m[3], kids: [] };
    open[open.length - 1].kids.push(el);
    if (!VOID.has(m[2])) open.push(el);
  }
  return open.length === 1 ? root : null;
}

/** The text a node shows, its tags aside. @param {Node} n @returns {string} */
const textOf = (n) => (typeof n === "string" ? n : n.kids.map(textOf).join(""));

/** Whether a node shows a reader anything: text, or an image. Formatting with nothing in it shows nothing. @param {Node} n @returns {boolean} */
const shows = (n) => (typeof n === "string" ? n.trim() !== "" : n.tag === "img" || n.kids.some(shows));

/**
 * What every section headed `title`, at any level, holds: the body's blocks
 * after its heading, through its own subsections, to the next heading of its
 * level or above. A heading inside another block, a list item, is part of it.
 * @param {El} root @param {string} title @returns {Node[]}
 */
function sections(root, title) {
  /** @type {Node[]} */ const held = [];
  let level = 0;
  for (const n of root.kids) {
    const h = typeof n === "string" ? null : /^h([1-6])$/.exec(n.tag);
    if (h && Number(h[1]) <= level) level = 0;
    if (h && !level && textOf(n).toLowerCase() === title.toLowerCase()) { level = Number(h[1]); continue; }
    if (level) held.push(n);
  }
  return held;
}

/** A whole-number attribute, as GitHub writes one, or null. @param {string} attrs @param {string} name */
function numberIn(attrs, name) {
  const m = new RegExp(` ${name}="(-?\\d+)"`).exec(attrs);
  return m ? Number(m[1]) : null;
}

/**
 * The list items among `nodes` that no other item holds, whatever block holds
 * them, each with the number a reader sees beside it: an ordered list's,
 * counted from its start or from an item's own value; none for a bullet.
 * @param {Node[]} nodes @returns {{ item: El, number: number | null }[]}
 */
function topItems(nodes) {
  /** @type {{ item: El, number: number | null }[]} */ const items = [];
  const walk = (/** @type {Node} */ n) => {
    if (typeof n === "string") return;
    if (n.tag === "li") { items.push({ item: n, number: null }); return; }
    const ordered = n.tag === "ol";
    let next = numberIn(n.attrs, "start") ?? 1;
    for (const k of n.kids) {
      if (!ordered || typeof k === "string" || k.tag !== "li") { walk(k); continue; }
      const number = numberIn(k.attrs, "value") ?? next;
      items.push({ item: k, number });
      next = number + 1;
    }
  };
  for (const n of nodes) walk(n);
  return items;
}

/**
 * How many acceptance criteria a task names, from GitHub's HTML of its body:
 * the items of its "Acceptance criteria" section. Null where the HTML isn't
 * GitHub's.
 * @param {unknown} html @returns {number | null}
 */
export function criteriaOf(html) {
  const root = tree(String(html ?? ""));
  return root && topItems(sections(root, "Acceptance criteria")).length;
}

/**
 * The criteria a pull request's "Acceptance evidence" section gives evidence
 * for, from GitHub's HTML of its description: each numbered entry that
 * shows something, by the number a reader sees. Null where the HTML isn't
 * GitHub's.
 * @param {unknown} html @returns {Set<number> | null}
 */
export function evidenceOf(html) {
  const root = tree(String(html ?? ""));
  if (!root) return null;
  /** @type {Set<number>} */ const given = new Set();
  for (const { item, number } of topItems(sections(root, "Acceptance evidence")))
    if (number !== null && shows(item)) given.add(number);
  return given;
}

/** The criteria, from 1 to `count`, with no evidence given. @param {number} count @param {Set<number>} given */
export function missingEvidence(count, given) {
  return Array.from({ length: count }, (_, i) => i + 1).filter((n) => !given.has(n));
}

/**
 * The pull request the task's checkpoints say it's delivered by, as they write
 * it, or null: the latest that names one, as a checkpoint written before a
 * pull request, or by a step that doesn't say, names none.
 * @param {string[]} comments
 */
function checkpointNames(comments) {
  const named = comments.filter((c) => c.startsWith(CHECKPOINT)).map((c) => /^pr:\s*(\S+)\s*$/m.exec(c)?.[1] ?? null).filter((n) => n !== null);
  return named.at(-1) ?? null;
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
 * Why the acceptance evidence couldn't be read. Said on a pull request that
 * may be public, so never naming the private repository or a task in it; what
 * went wrong is kept with the input, which stays in the store.
 * @param {string} why @param {string | undefined} detail
 */
const unread = (why, detail) => ({ ok: /** @type {const} */ (false), why, detail: detail ?? "" });

/**
 * The tasks in `tasksRepo` whose latest checkpoint names `nwo#pr`, by number.
 * Found by a search, and each checked by reading its checkpoints, as the
 * search matches one naming the pull request once and another since.
 * @param {{ nwo: string, pr: number, tasksRepo: string, gh: Gh }} o
 * @returns {{ ok: true, tasks: number[] } | { ok: false, why: string, detail: string }}
 */
function tasksOf({ nwo, pr, tasksRepo, gh }) {
  const named = `${nwo}#${pr}`;
  // Each page says whether GitHub searched everything, then its issues.
  const found = gh(["--paginate", `search/issues?q=${encodeURIComponent(`repo:${tasksRepo} is:issue "${named}" in:comments`)}&per_page=100`, "--jq", ".incomplete_results, .items[].number"]);
  if (!found.ok) return unread("the task it delivers couldn't be looked for", found.err);
  const lines = found.out.split("\n").filter(Boolean);
  if (!lines.some((l) => l === "false" || l === "true")) return unread("the task it delivers couldn't be looked for", "the search didn't read as GitHub's");
  if (lines.includes("true")) return unread("the task it delivers couldn't be looked for", "the search came back incomplete");
  const numbers = lines.filter((l) => l !== "false").map(Number);
  if (numbers.some((n) => !Number.isSafeInteger(n) || n < 1)) return unread("the task it delivers couldn't be looked for", "the search didn't read as GitHub's");
  /** @type {number[]} */ const tasks = [];
  for (const n of [...new Set(numbers)].sort((a, b) => a - b)) {
    const comments = gh(["--paginate", `repos/${tasksRepo}/issues/${n}/comments?per_page=100`, "--jq", ".[].body | @json"]);
    const bodies = comments.ok ? strings(comments.out) : null;
    if (!bodies) return unread("the checkpoints of the task it may deliver couldn't be read", comments.err ?? "they don't read as GitHub's");
    // GitHub's names are the same whatever their letters' case.
    if (checkpointNames(bodies)?.toLowerCase() === named.toLowerCase()) tasks.push(n);
  }
  return { ok: true, tasks };
}

/**
 * How many acceptance criteria `tasks` in `tasksRepo` name between them, each
 * read as GitHub renders it now: none where one names none.
 * @param {{ tasks: number[], tasksRepo: string, gh: Gh }} o
 * @returns {{ ok: true, criteria: number } | { ok: false, why: string, detail: string }}
 */
function criteriaIn({ tasks, tasksRepo, gh }) {
  let criteria = 0, blank = false;
  for (const n of tasks) {
    const issue = gh(["-H", RENDERED, `repos/${tasksRepo}/issues/${n}`, "--jq", ".body_html // \"\" | @json"]);
    const html = issue.ok ? one(issue.out) : null;
    const c = html === null ? null : criteriaOf(html);
    if (c === null) return unread("the task it delivers couldn't be read", issue.err ?? "it doesn't read as GitHub's");
    if (!c) blank = true;
    criteria += c;
  }
  return { ok: true, criteria: blank ? 0 : criteria };
}

/**
 * The acceptance evidence of pull request `pr` of `nwo` at `head`, `html` its
 * description as GitHub renders it, against the tasks it delivers in
 * `tasksRepo`: which it delivers, how many criteria they name, and which have
 * no evidence. Not `readable` where the tasks couldn't be looked for, which is
 * never "none", or either couldn't be read. Which tasks it delivers is kept
 * per pull request, and looked for again on a new head, or an hour on; none
 * found is looked for again each time. What they ask is read each time, as a
 * task may gain a criterion while it's delivered.
 * @param {{ nwo: string, pr: number, head: string, html: unknown, tasksRepo: string, gh?: Gh, cache?: Map<string, Kept>, now?: number }} o
 * @returns {{ readable: true, tasks: number[], criteria: number, missing: number[] } | { readable: false, why: string, detail: string }}
 */
export function acceptanceOf({ nwo, pr, head, html, tasksRepo, gh = ghApi, cache = KEPT, now = Math.floor(Date.now() / 1000) }) {
  // What's an hour old goes, a closed pull request's with it.
  for (const [k, v] of cache) if (now - v.at > TASK_KEPT_SECONDS) cache.delete(k);
  const key = `${nwo}#${pr}`;
  let kept = cache.get(key);
  if (!kept || kept.head !== head) {
    const t = tasksOf({ nwo, pr, tasksRepo, gh });
    // Kept only once read: one that couldn't be is looked for again next time.
    if ("why" in t) return { readable: false, why: t.why, detail: t.detail };
    kept = { head, at: now, tasks: t.tasks };
    // And only once found: a checkpoint naming the pull request may be
    // written after it, and is read on the next tick.
    if (t.tasks.length) cache.set(key, kept);
  }
  if (!kept.tasks.length) return { readable: true, tasks: [], criteria: 0, missing: [] };
  const c = criteriaIn({ tasks: kept.tasks, tasksRepo, gh });
  if ("why" in c) return { readable: false, why: c.why, detail: c.detail };
  const given = evidenceOf(html);
  if (!given) return { readable: false, why: "its description couldn't be read", detail: "it doesn't read as GitHub's" };
  return { readable: true, tasks: kept.tasks, criteria: c.criteria, missing: missingEvidence(c.criteria, given) };
}

/**
 * Pull request `pr`'s description, as GitHub renders it now, for its
 * acceptance evidence: `html`, or why it couldn't be read.
 * @param {string} nwo @param {number} pr @param {{ gh?: Gh }} [o]
 * @returns {{ ok: true, html: string } | { ok: false, why: string }}
 */
export function pullBody(nwo, pr, { gh = ghApi } = {}) {
  const got = gh(["-H", RENDERED, `repos/${nwo}/pulls/${pr}`, "--jq", ".body_html // \"\" | @json"]);
  const html = got.ok ? one(got.out) : null;
  return html === null ? { ok: false, why: `its description couldn't be read: ${got.err ?? "it doesn't read as GitHub's"}` } : { ok: true, html };
}
