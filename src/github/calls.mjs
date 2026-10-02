// @ts-check
/**
 * Every call reeve makes to GitHub, counted (#168).
 *
 * Each place that runs `gh` runs it here, and reeve's App counts here what it
 * sends with fetch, so the requests a tick makes of GitHub, and those for each
 * pull request it reads, can be measured before they're cut. Requests, not runs of gh: a paged read makes one for each page,
 * which gh says on stderr when GH_DEBUG is set, one `* Request to` line each,
 * with no header or body. Each is counted under the identity it reads as,
 * reeve's App or the login on the machine, and its kind: the command, or the
 * endpoint with its owner, name, numbers and commits taken out, so
 * `repos/o/r/pulls/7` and `repos/o/r/pulls/8` are one kind.
 */
import { execFileSync, spawnSync } from "node:child_process";

/** @typedef {"app" | "ambient"} Who */

/** @type {Map<string, { calls: number, requests: number }>} */ const counted = new Map();
/** @type {typeof spawnSync} */ let runner = spawnSync;
/** The lines gh writes on stderr for each request it makes, with GH_DEBUG set. */
const REQUEST_LINE = /^\* Request (at|to|took) /;

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
 * counts each request it made of GitHub under `who`, whether or not it
 * succeeds: a request refused still spent one. Failing, it throws as
 * execFileSync throws, with what gh said on stderr but the lines saying its
 * requests.
 * @param {string[]} args @param {import("node:child_process").ExecFileSyncOptions} [options]
 * @param {{ who?: Who }} [o]
 * @returns {string}
 */
export function gh(args, options = {}, { who = "ambient" } = {}) {
  const r = runner("gh", args, { ...options, encoding: "utf8", env: { ...(options.env ?? process.env), GH_DEBUG: "1" } });
  const stderr = String(r.stderr ?? "");
  note(who, kindOf(args), (stderr.match(/^\* Request to /gm) ?? []).length);
  const said = stderr.split("\n").filter((line) => !REQUEST_LINE.test(line)).join("\n");
  const failed = { status: r.status, signal: r.signal, stdout: r.stdout, stderr: said };
  if (r.error) throw Object.assign(r.error, failed);
  if (r.status !== 0) throw Object.assign(new Error(`Command failed: gh ${args.join(" ")}\n${said}`), failed);
  return String(r.stdout ?? "");
}

/**
 * One request reeve made of GitHub without gh, to `path`, counted as gh's are,
 * whether or not it was answered: reeve's App signing in, which sends its own
 * JWT with fetch. Each asked again is one more.
 * @param {string} path @param {{ who?: Who }} [o]
 */
export function countRequest(path, { who = "ambient" } = {}) {
  note(who, `api ${shape(path)}`, 1);
}

/** One call, under `who` and of `kind`, that made `requests` requests. @param {Who} who @param {string} kind @param {number} requests */
function note(who, kind, requests) {
  const key = `${who}\u0000${kind}`;
  const was = counted.get(key) ?? { calls: 0, requests: 0 };
  counted.set(key, { calls: was.calls + 1, requests: was.requests + requests });
}

/**
 * `cmd` with `args`, run as execFileSync runs it, and counted here where it's
 * `gh`: for the helpers that run either.
 * @param {string} cmd @param {string[]} args @param {import("node:child_process").ExecFileSyncOptions} [options]
 */
export function runCommand(cmd, args, options = {}) {
  return cmd === "gh" ? gh(args, options) : execFileSync(cmd, args, options);
}

/**
 * The requests counted since they were last taken, and counting begins afresh:
 * how many in all, in how many runs of gh, under each identity, and of each kind.
 * @returns {{ requests: number, calls: number, byWho: Record<string, number>, byKind: Record<string, number> }}
 */
export function takeCalls() {
  /** @type {Record<string, number>} */ const byWho = {};
  /** @type {Record<string, number>} */ const byKind = {};
  let requests = 0, calls = 0;
  for (const [key, n] of counted) {
    const [who, kind] = key.split("\u0000");
    byWho[who] = (byWho[who] ?? 0) + n.requests;
    byKind[kind] = (byKind[kind] ?? 0) + n.requests;
    requests += n.requests;
    calls += n.calls;
  }
  counted.clear();
  return { requests, calls, byWho, byKind };
}

/**
 * Runs `gh` with `run`, as spawnSync runs it, in its place until the next call
 * of this, for a test: the suite fails a file that runs `gh`, so what reaches
 * it is checked here. The one in place before, to put back.
 * @param {typeof spawnSync} run
 */
export function runGhWith(run) {
  const was = runner;
  runner = run;
  return was;
}
