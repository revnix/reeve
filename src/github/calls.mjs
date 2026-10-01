// @ts-check
/**
 * Every call reeve makes to GitHub, counted (#168).
 *
 * Each place that runs `gh` runs it here, so the calls a tick makes, and the
 * calls for each pull request it reads, can be measured before they're cut. A
 * call is counted under the identity it reads as, reeve's App or the login on
 * the machine, and its kind: the command, or the endpoint with its owner, name,
 * numbers and commits taken out, so `repos/o/r/pulls/7` and `repos/o/r/pulls/8`
 * are one kind.
 */
import { execFileSync } from "node:child_process";

/** @typedef {"app" | "ambient"} Who */

/** @type {Map<string, number>} */ const counted = new Map();
/** @type {typeof execFileSync} */ let runner = execFileSync;

/** An endpoint with what varies taken out. @param {string} path */
const shape = (path) => path.split("?")[0]
  .replace(/^repos\/[^/]+\/[^/]+/, "repos/:nwo")
  .replace(/\/[0-9a-f]{40}(?=\/|$)/g, "/:sha")
  .replace(/\/\d+(?=\/|$)/g, "/:n");

/**
 * A call's kind, from the arguments `gh` is run with: `api` and its endpoint,
 * or the command and subcommand, `pr view` say.
 * @param {readonly unknown[]} args
 */
export function kindOf(args) {
  const words = args.filter((a) => typeof a === "string").map(String);
  if (words[0] !== "api") return words.slice(0, 2).join(" ") || "gh";
  const endpoint = words.slice(1).find((w) => /^(repos|orgs|users?|search|app|installation|rate_limit)(\/|$)|^graphql$/.test(w));
  return `api ${endpoint ? shape(endpoint) : "?"}`;
}

/**
 * Runs `gh` with `args`, as execFileSync runs it, its output read as text, and
 * counts the call under `who`, whether or not it succeeds: a call refused still
 * spent a request.
 * @param {string[]} args @param {import("node:child_process").ExecFileSyncOptions} [options]
 * @param {{ who?: Who }} [o]
 * @returns {string}
 */
export function gh(args, options = {}, { who = "ambient" } = {}) {
  const key = `${who}\u0000${kindOf(args)}`;
  counted.set(key, (counted.get(key) ?? 0) + 1);
  return String(runner("gh", args, { ...options, encoding: "utf8" }));
}

/**
 * The calls counted since they were last taken, and counting begins afresh:
 * how many in all, under each identity, and of each kind.
 * @returns {{ total: number, byWho: Record<string, number>, byKind: Record<string, number> }}
 */
export function takeCalls() {
  /** @type {Record<string, number>} */ const byWho = {};
  /** @type {Record<string, number>} */ const byKind = {};
  let total = 0;
  for (const [key, n] of counted) {
    const [who, kind] = key.split("\u0000");
    byWho[who] = (byWho[who] ?? 0) + n;
    byKind[kind] = (byKind[kind] ?? 0) + n;
    total += n;
  }
  counted.clear();
  return { total, byWho, byKind };
}

/**
 * Runs `gh` with `run` in its place until the next call of this, for a test:
 * the suite fails a file that runs `gh`, so what reaches it is checked here.
 * The one in place before, to put back.
 * @param {typeof execFileSync} run
 */
export function runGhWith(run) {
  const was = runner;
  runner = run;
  return was;
}
