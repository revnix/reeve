// Record a seeded case's pull request (#293): every gh and git read reeve makes
// to judge it, answered by GitHub, and written to seeded/<name>.json. The
// cases in src/seeded.mjs are edits of these answers.
//
//   node scripts/capture-seeded.mjs
//
// It reads GitHub with the gh you're signed in as, and writes nothing there:
// the recorder that stands in for gh and git refuses any call that could.
// Reeve itself runs with a home of its own, and the profile is read from the
// repository's in the reeve home, keeping only what an evaluation reads.
//
// The pull request has merged since, so what changed with the merge is set
// back to how it stood, each with its reason, at the moment of reeve's last
// verdict on it before the merge.
import { spawnSync } from "node:child_process";
import { accessSync, appendFileSync, chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactBodies } from "../src/seeded.mjs";

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), "..");

const REPO = "nextlyhq/nextly", PR = 1963, NAME = "nextly-1963";
const HEAD = "fae4c95bd6387a5c220152a2436ce69ff6a97386";
const BRANCH = "ci/review-bot-leaner-protocol";
// main from #1962's merge at 03:23 UTC until this one merged at 06:10.
const BASE = "cbd24130debf432be3537ae7ae71307936346792";
// Reeve's last verdict on it before the merge.
const AT = "2026-09-30T06:07:27Z";
// Reeve's App, as its check runs on the repository name it.
const APP_ID = "4660593";
const ABOUT = `${REPO}#${PR} at ${HEAD.slice(0, 10)}, as GitHub answered for it, and as it stood at ${AT}: approved by a person, ` +
  "every check green, and merged through the queue at 06:10 UTC. Its review tools are renamed. Recorded with scripts/capture-seeded.mjs.";

const at = Date.parse(AT);
/** Rows of a JSON array, or JSON values one per line, dated after the moment, left out. */
const before = (/** @type {any} */ x, /** @type {string[]} */ keys) => keys.every((k) => !x?.[k] || Date.parse(x[k]) <= at);

/** The path a gh api call reads, without its query. @param {string[]} call */
const pathOf = (call) => String(call.find((c, i) => i > 1 && /^repos\//.test(c)) ?? "").replace(/\?.*$/, "");
/** @param {string[]} call @param {string} path @param {boolean} [jq] */
const reads = (call, path, jq) => call[0] === "gh" && pathOf(call) === `repos/${REPO}/${path}` && (jq === undefined || call.includes("--jq") === jq);

// What the merge changed, set back, each with why.
const EDITS = [
  { match: (/** @type {string[]} */ c) => reads(c, `pulls/${PR}`), why: "merged since: its state as it stood, open",
    edit: (/** @type {string} */ out) => out.replace(/\tclosed\t/, "\topen\t") },
  { match: (/** @type {string[]} */ c) => c[0] === "git" && c.includes(`refs/heads/${BRANCH}`), why: "its branch was deleted after the merge: the head it stood at",
    edit: () => `${HEAD}\trefs/heads/${BRANCH}\n` },
  { match: (/** @type {string[]} */ c) => c[0] === "git" && c.includes("refs/heads/main"), why: "main as it stood while the pull request was open",
    edit: () => `${BASE}\trefs/heads/main\n` },
  { match: (/** @type {string[]} */ c) => c[2] === "graphql" && c.some((x) => x.includes("mergeStateStatus")), why: "merged since, so GitHub no longer computes it: as reeve recorded it open, from 05:48 to 06:07 UTC, CLEAN and MERGEABLE",
    edit: (/** @type {string} */ out) => { const v = JSON.parse(out); Object.assign(v.data.repository.pullRequest, { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" }); return JSON.stringify(v) + "\n"; } },
  { match: (/** @type {string[]} */ c) => reads(c, `issues/${PR}/timeline`), why: `what happened after ${AT} left out`,
    edit: (/** @type {string} */ out) => out.split("\n").filter((l) => { const t = l.split("\t")[1]; return !t || Date.parse(t) <= at; }).join("\n") },
  { match: (/** @type {string[]} */ c) => reads(c, `issues/${PR}/comments`, false), why: `comments after ${AT} left out`,
    edit: (/** @type {string} */ out) => JSON.stringify(JSON.parse(out).filter((/** @type {any} */ x) => before(x, ["created_at"]))) + "\n" },
  { match: (/** @type {string[]} */ c) => reads(c, `issues/${PR}/comments`, true), why: `comments after ${AT} left out`,
    edit: (/** @type {string} */ out) => out.split("\n").filter((l) => { const t = l.split("\t")[1]; return !t || Date.parse(t) <= at; }).join("\n") },
  { match: (/** @type {string[]} */ c) => reads(c, `pulls/${PR}/reviews`, false), why: `reviews after ${AT} left out`,
    edit: (/** @type {string} */ out) => JSON.stringify(JSON.parse(out).filter((/** @type {any} */ x) => before(x, ["submitted_at"]))) + "\n" },
  { match: (/** @type {string[]} */ c) => reads(c, `issues/${PR}/reactions`), why: `reactions after ${AT} left out`,
    edit: (/** @type {string} */ out) => JSON.stringify(JSON.parse(out).filter((/** @type {any} */ x) => before(x, ["created_at"]))) + "\n" },
];

/**
 * The review tools, and the agent App that opened the pull request, renamed
 * throughout the recording (#298's review): in its calls, its answers and its
 * profile alike, so every rule still reads what it read, and no tool is named
 * with what it found. Longest first, so a name inside another is renamed with it.
 */
export const NAMES = Object.freeze([
  ["chatgpt-codex-connector", "reviewer-one"], ["Codex Review", "Reviewer One review"], ["ChatGPT", "Reviewer One"], ["chatgpt", "reviewer-one"],
  ["Codex", "Reviewer One"], ["codex", "reviewer-one"], ["OpenAI", "Vendor One"], ["openai", "vendor-one"],
  ["coderabbitai", "reviewer-two"], ["CodeRabbit", "Reviewer Two"], ["coderabbit", "reviewer-two"],
  ["greptile-apps", "reviewer-three"], ["Greptile Apps", "Reviewer Three"], ["greptileai", "vendor-three"], ["Greptile", "Reviewer Three"], ["greptile", "reviewer-three"],
  ["nextly-review-bot", "reviewer-four"], ["Nextly Review Bot", "Reviewer Four"], ["@nextly-bot", "@reviewer-four"], ["pr-review-agent", "reviewer-four-round"],
  ["review-bot", "reviewer"], ["review agent", "reviewer"], ["nextly-agent", "agent-app"],
  ["Anthropic", "Vendor Five"], ["anthropics", "vendor-five"], ["Claude", "App Five"], ["claude", "app-five"], ["Copilot", "App Six"], ["copilot", "app-six"],
].sort((a, b) => b[0].length - a[0].length));

/** `text` with every name in NAMES renamed. @param {string} text */
export const renamed = (text) => NAMES.reduce((t, [from, to]) => t.split(from).join(to), text);

// Reads the cases make that the good one doesn't: the provider's suites,
// asked when a required check is missing, and whether the head contains the
// base's commit, asked when the base is red.
const ALSO = [
  ["gh", "api", "--paginate", `repos/${REPO}/commits/${HEAD}/check-suites?per_page=100`, "--jq", ".check_suites[]"],
  ["gh", "api", `repos/${REPO}/compare/${BASE}...${HEAD}`, "--jq", ".status"],
];


/**
 * Where `tool` is on `path`: the first file of that name that can be run, as a
 * shell finds it, or null. Read before the recorder is put first on PATH, so
 * it runs the real one wherever that's installed.
 * @param {string} tool @param {string} [path]
 */
export function realTool(tool, path = process.env.PATH ?? "") {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const at = join(dir, tool);
    try { if (statSync(at).isFile()) { accessSync(at, constants.X_OK); return resolve(at); } } catch { /* not here */ }
  }
  return null;
}

/**
 * The recording's answers from the recorder's log: each call once, with what
 * reeve doesn't read left out, or `why` where a read failed, as a recording of
 * a read GitHub didn't answer judges nothing.
 * - a check run's output, and its App's description: most of the size;
 * - a check suite's head commit, and a branch's latest commit, which carry
 *   people's names and addresses. The branch's is also its commit now, not as
 *   it stood: the read is for the branch's protection;
 * - the check suites of Apps other than the CI provider, whose alone reeve reads;
 * - review and comment bodies past what reeve's reading matches (redactBodies).
 * @param {string[]} lines @param {any} profile
 * @returns {{ answers: any[] } | { why: string }}
 */
export function answersFrom(lines, profile) {
  /** @type {Map<string, any>} */ const byCall = new Map();
  for (const line of lines.filter(Boolean)) { const a = JSON.parse(line); byCall.set(JSON.stringify(a.call), a); }
  const failed = [...byCall.values()].filter((a) => a.status !== 0);
  if (failed.length) return { why: `reads that failed, so no recording is written: ${failed.map((a) => `${a.call.join(" ")} (${String(a.stderr).trim().split("\n")[0] || `exit ${a.status}`})`).join("; ")}` };
  const provider = String(profile?.ci?.provider ?? "github-actions");
  const app = (/** @type {any} */ app) => app && { id: app.id, slug: app.slug, name: app.name, owner: app.owner && { login: app.owner.login } };
  const perLine = (/** @type {any} */ a, /** @type {(x: any) => any} */ fn) =>
    ({ ...a, stdout: a.stdout.split("\n").filter(Boolean).map((/** @type {string} */ l) => fn(JSON.parse(l))).filter((/** @type {any} */ x) => x != null).map((/** @type {any} */ x) => JSON.stringify(x)).join("\n") + "\n" });
  const answers = [...byCall.values()].map((a) => {
    if (a.call.some((/** @type {string} */ c) => /\/check-runs\?/.test(c))) return perLine(a, ({ output: _output, app: a0, ...rest }) => ({ ...rest, app: app(a0) }));
    if (a.call.some((/** @type {string} */ c) => /\/check-suites\?/.test(c)))
      return perLine(a, ({ head_commit: _head, app: a0, ...rest }) => (a0?.slug === provider ? { ...rest, app: app(a0) } : null));
    if (a.call.some((/** @type {string} */ c) => /^repos\/[^/]+\/[^/]+\/branches\/[^/]+$/.test(c))) {
      const { commit: _commit, ...rest } = JSON.parse(a.stdout);
      return { ...a, stdout: JSON.stringify(rest) + "\n" };
    }
    return a;
  });
  return { answers: redactBodies(answers, profile) };
}

// ── the recorder: gh or git, as the evaluation calls them ─────────────────────
if (process.argv[2] === "--record") {
  const [tool, ...args] = process.argv.slice(3);
  const refuse = (/** @type {string} */ why) => { process.stderr.write(`capture refuses ${why}: ${tool} ${args.join(" ")}\n`); process.exit(1); };
  if (tool === "gh") {
    const method = args.find((a, i) => args[i - 1] === "-X" || args[i - 1] === "--method") ?? args.find((a) => /^--method=/.test(a))?.slice(9);
    if (method && method.toUpperCase() !== "GET") refuse("a write");
    if (args[0] !== "api") refuse("a command that isn't an API read");
    const graphql = args[1] === "graphql";
    if (graphql && args.some((a) => /\bmutation\b/i.test(a))) refuse("a mutation");
    // Fields make gh api send a POST, which only a GraphQL query may.
    if (!graphql && !method && args.some((a) => ["-f", "-F", "--field", "--raw-field", "--input"].includes(a) || /^--(raw-)?field=/.test(a)))
      refuse("a call with fields, which gh sends as a POST");
  } else if (tool !== "git" || args[0] !== "ls-remote") refuse("a git command other than ls-remote");
  const real = process.env[tool === "gh" ? "CAPTURE_GH" : "CAPTURE_GIT"];
  if (!real) refuse("a call with no real tool to make it with");
  const r = spawnSync(String(real), args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const call = [tool, ...args];
  const e = EDITS.find((x) => x.match(call));
  const answer = { call, status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  if (e && (answer.status === 0 || tool === "git")) Object.assign(answer, { status: 0, stdout: e.edit(answer.stdout), edited: e.why });
  appendFileSync(String(process.env.CAPTURE_LOG), JSON.stringify(answer) + "\n");
  // Exit only once both are written: a pipe takes a large answer in pieces.
  process.stderr.write(answer.stderr, () => process.stdout.write(answer.stdout, () => process.exit(answer.status)));
} else if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  // The real gh and git, found before the recorder stands in for them.
  const tools = { CAPTURE_GH: realTool("gh"), CAPTURE_GIT: realTool("git") };
  for (const [k, v] of Object.entries(tools)) if (!v) { console.error(`capture-seeded: no ${k === "CAPTURE_GH" ? "gh" : "git"} on PATH`); process.exit(1); }
  const dir = mkdtempSync(join(tmpdir(), "reeve-capture-"));
  try {
    const bin = join(dir, "bin"), home = join(dir, "home"), log = join(dir, "calls.jsonl");
    mkdirSync(bin);
    mkdirSync(join(home, "credentials"), { recursive: true, mode: 0o700 });
    for (const tool of ["gh", "git"]) {
      writeFileSync(join(bin, tool), `#!/bin/sh\nexec "${process.execPath}" "${SELF}" --record ${tool} "$@"\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    writeFileSync(join(home, "credentials", "no-key"), "", { mode: 0o600 });
    writeFileSync(join(home, "credentials", "merge-policy.env"), `APP_ID=${APP_ID}\nPRIVATE_KEY=${join(home, "credentials", "no-key")}\n`, { mode: 0o600 });
    // Only what an evaluation reads: not notifications, the builder or the worker.
    const reeveHome = process.env.REEVE_HOME ?? join(homedir(), ".reeve");
    const [owner, repo] = REPO.split("/");
    const full = JSON.parse(readFileSync(join(reeveHome, "profiles", owner, `${repo}.json`), "utf8"));
    const profile = Object.fromEntries(["schemaVersion", "project", "identity", "authority", "state", "units", "ci", "merge", "reviewers", "rounds", "watch"]
      .filter((k) => k in full).map((k) => [k, full[k]]));
    writeFileSync(join(dir, "profile.json"), JSON.stringify(profile));
    const env = { ...process.env, ...tools, PATH: `${bin}${delimiter}${process.env.PATH}`, REEVE_HOME: home, CAPTURE_LOG: log,
                  SEEDED_REPO: REPO, SEEDED_PR: String(PR), SEEDED_PROFILE: join(dir, "profile.json"), SEEDED_STORE: join(dir, "store.db"),
                  SEEDED_CLOCK: String(Math.floor(at / 1000)) };
    const judged = spawnSync(process.execPath, [join(ROOT, "src", "seeded-evaluate.mjs")], { encoding: "utf8", env });
    const verdict = String(judged.stdout).trim().split("\n").at(-1);
    console.error(`judged: ${verdict}`);
    for (const [tool, ...args] of ALSO) spawnSync(join(bin, tool), args, { encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024 });
    const got = answersFrom(readFileSync(log, "utf8").split("\n"), profile);
    if ("why" in got) { console.error(`capture-seeded: ${got.why}`); process.exitCode = 1; }
    else {
      const answers = got.answers;
      const out = { about: ABOUT, repo: REPO, pr: PR, head: HEAD, base: BASE, at: AT, appId: APP_ID, capturedAt: new Date().toISOString(),
                    ...JSON.parse(renamed(JSON.stringify({ profile, answers }))) };
      const dest = join(ROOT, "seeded", `${NAME}.json`);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, JSON.stringify(out, null, 1) + "\n");
      console.error(`wrote ${dest}: ${answers.length} answers, ${answers.filter((/** @type {any} */ a) => a.edited).length} set back to how they stood`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
