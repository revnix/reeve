// detect — propose a profile from what the repo actually is.
//
// Detection never guesses silently. Anything ambiguous is returned as a
// `question` with the evidence that made it ambiguous, because a wrong default
// here is a gate judging the wrong thing. `reeve init` shows these before writing.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { runnerShells, scriptOutcome, scriptShells, listed } from "./shellscript.mjs";

function sh(cmd, args, cwd) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (e) { return { ok: false, out: "", err: String(e.stderr || e.message).trim() }; }
}
const ghJson = (path, jq, cwd) => {
  const a = ["api", path]; if (jq) a.push("--jq", jq);
  return sh("gh", a, cwd);
};
const readJson = p => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

/** owner/repo from the REMOTE. One repo can sit at two paths on two commits. */
export function detectIdentity(root) {
  const r = sh("git", ["remote", "get-url", "origin"], root);
  const key = r.ok ? (r.out.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? null) : null;
  const head = sh("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
  const defaultBranch = head.ok ? head.out.replace(/^origin\//, "") : "main";
  return { key, defaultBranch };
}

/**
 * Package manager from lockfiles. Two managers' lockfiles is a QUESTION, never a
 * pick. bun 1.2 and later write bun.lock, and earlier ones bun.lockb: both are bun.
 */
export function detectPackageManager(dir) {
  const locks = [
    ["pnpm", "pnpm-lock.yaml"], ["npm", "package-lock.json"],
    ["yarn", "yarn.lock"], ["bun", "bun.lock"], ["bun", "bun.lockb"],
    ["uv", "uv.lock"], ["poetry", "poetry.lock"], ["pdm", "pdm.lock"],
  ].filter(([, f]) => existsSync(join(dir, f)));
  const managers = [...new Set(locks.map(([m]) => m))];

  if (managers.length === 0) return { value: null, question: null };
  if (managers.length === 1) return { value: managers[0], question: null };
  return {
    value: null,
    question: {
      field: "units[].packageManager",
      why: `${locks.length} lockfiles are tracked and they can disagree`,
      evidence: locks.map(([m, f]) => `${f} (${m})`).join(", "),
      options: managers,
    },
  };
}

/**
 * The member globs of the workspace the root declares, for the manager that owns
 * it: pnpm keeps them in pnpm-workspace.yaml; npm, yarn and bun in package.json's
 * `workspaces`, as a list or as `{ packages: [...] }`. Null when the list is one
 * the manager's versions read differently.
 */
export function workspaceGlobs(root, manager) {
  if (manager === "pnpm") {
    let text;
    try { text = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"); } catch { return []; }
    return yamlList(text, "packages");
  }
  if (manager === "npm" || manager === "yarn" || manager === "bun") {
    const ws = readJson(join(root, "package.json"))?.workspaces;
    const list = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
    return list.filter(g => typeof g === "string");
  }
  return [];
}

/**
 * The majors of yarn that may own a root, among those measured (1 to 4):
 *   - each one `packageManager` or `.yarnrc.yml`'s `yarnPath` names, since a
 *     yarnPath runs in place of the version packageManager names;
 *   - 2 to 4 for a `.yarnrc.yml`, or a lockfile that yarn 2 or later wrote;
 *   - 1 for yarn 1's lockfile;
 *   - all four when nothing says.
 */
function yarnMajors(root) {
  const declared = readJson(join(root, "package.json"))?.packageManager;
  let rc = "", lock = "";
  try { rc = readFileSync(join(root, ".yarnrc.yml"), "utf8"); } catch { /* none */ }
  try { lock = readFileSync(join(root, "yarn.lock"), "utf8").slice(0, 500); } catch { /* none */ }
  const byManager = typeof declared === "string" ? /^yarn@(\d+)\./.exec(declared)?.[1] : undefined;
  const byPath = /yarn-(\d+)\.\d+\.\d+\.c?js/.exec(rc)?.[1];
  const berry = [2, 3, 4];
  const named = [byManager, byPath].filter(v => v !== undefined).map(Number);
  if (named.length) return [...new Set(named.flatMap(m => (m >= 1 && m <= 4 ? [m] : berry)))];
  if (rc || /^__metadata:/m.test(lock)) return berry;
  return /yarn lockfile v1/.test(lock) ? [1] : [1, ...berry];
}

/**
 * Whether a folder the root holds is a member of its workspace, as the manager
 * that owns it reads the patterns. They read an exclusion (`!`) in four ways,
 * measured in docs/measured/2026-09-27-workspace-membership.md:
 *   npm            it stands until a later pattern's own text matches it (`listed`);
 *   pnpm, yarn 4   it wins, wherever it stands;
 *   yarn 2 and 3   the last pattern that matches decides;
 *   yarn 1         it's no pattern at all;
 *   bun            differently from one version to the next.
 * Only npm drops a leading slash; the others keep it, so it matches no folder.
 * True, false, or null when it can't be told: a list the manager's versions
 * read differently, a yarn whose possible versions disagree, or bun where an
 * exclusion or an extglob could matter.
 */
function isMember(rel, globs, manager, root) {
  if (manager === "npm") return listed(globs, rel);
  if (globs === null) return null;
  try {
    const hit = g => matchesGlob(rel, g.replace(/^!/, "").replace(/^\.\//, "").replace(/\/+$/, ""));
    const extglob = g => /[?*+@!]\(/.test(g.replace(/^!/, ""));
    // What a manager reads unlike Node's matcher leaves its answer unknown: a
    // backslash, an escape to each manager and a separator to the matcher; an
    // extglob, which pnpm 12 refuses and pnpm 10 reads; a leading slash, for
    // which bun refuses the whole list.
    if (globs.some(g => g.includes("\\"))) return null;
    if (manager === "pnpm" && globs.some(extglob)) return null;
    if (manager === "bun" && globs.some(g => /^!?\//.test(g))) return null;
    const exclusions = globs.filter(g => g.startsWith("!"));
    const included = globs.some(g => !g.startsWith("!") && hit(g));
    const exclusionWins = included && !exclusions.some(hit);
    if (manager === "pnpm") return exclusionWins;
    if (manager === "bun") {
      // bun matches no extglob, so a folder only one lists is unknown.
      const plainly = globs.some(g => !g.startsWith("!") && !extglob(g) && hit(g));
      if (plainly && !exclusions.some(hit)) return true;
      return exclusions.length || included ? null : false;
    }
    if (manager !== "yarn") return false;
    const lastWins = globs.reduce((member, g) => (hit(g) ? !g.startsWith("!") : member), false);
    const reading = { 1: included, 2: lastWins, 3: lastWins, 4: exclusionWins };
    const readings = new Set(yarnMajors(root).map(m => reading[m]));
    return readings.size === 1 ? [...readings][0] : null;
  } catch { return null; }
}

/**
 * Where a flow list's own closing bracket is: the first `]` outside quotes, so a
 * quoted glob such as `"packages/[ab]"` doesn't end the list. -1 when it isn't
 * there yet.
 * @param {string} s
 */
function flowEnd(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "]") return i;
  }
  return -1;
}

/**
 * A YAML flow list's items, split at the commas outside quotes: `'{foo,bar}'` is
 * one glob, not two.
 * @param {string} body
 */
function flowItems(body) {
  const out = [];
  let item = "", quote = null;
  for (const ch of body) {
    if (quote) { item += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; item += ch; continue; }
    if (ch === ",") { out.push(item); item = ""; continue; }
    item += ch;
  }
  out.push(item);
  return out;
}

/**
 * The string items of a top-level list, in YAML as pnpm-workspace.yaml writes it:
 * a block list under the key, with comments and blank lines among the items, or a
 * flow list on the key's own line. Anything else reads as no list, and a flow
 * list that pnpm 12 refuses, and pnpm 10 reads, as null.
 */
function yamlList(text, key) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex(l => l.startsWith(`${key}:`));
  if (at < 0) return [];
  const unquote = s => s.trim().replace(/^(['"])(.*)\1$/, "$2");
  const rest = lines[at].slice(key.length + 1).replace(/\s#.*$/, "").trim();
  if (rest.startsWith("[")) {
    // A flow list may run across lines, so read on to its closing bracket.
    let flow = rest, unindented = false;
    for (let n = at + 1; flowEnd(flow) < 0 && n < lines.length; n++) {
      // A line that is only a comment is skipped, indented or not.
      if (/^\s*#/.test(lines[n])) continue;
      // An item with no indent, which pnpm 10 reads and pnpm 12 refuses.
      if (/^[^\s\]]/.test(lines[n])) unindented = true;
      flow += " " + lines[n].replace(/\s#.*$/, "").trim();
    }
    const end = flowEnd(flow);
    if (end < 0) return [];
    // Which pnpm owns the checkout isn't known, so neither reading is taken.
    if (unindented) return null;
    return flowItems(flow.slice(1, end)).map(unquote).filter(Boolean);
  }
  const out = [];
  for (const line of lines.slice(at + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const m = /^\s*-\s+(.*)$/.exec(line);
    if (!m) break;
    const item = /^['"]/.test(m[1]) ? m[1].replace(/^(['"])(.*?)\1.*$/, "$2") : m[1].replace(/\s#.*$/, "").trim();
    if (item) out.push(item);
  }
  return out;
}

/** Language from manifests present, not from file extensions. */
export function detectLanguage(dir) {
  if (existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "requirements.txt"))) return "python";
  if (existsSync(join(dir, "package.json"))) return "typescript";
  if (existsSync(join(dir, "go.mod"))) return "go";
  if (existsSync(join(dir, "Cargo.toml"))) return "rust";
  return null;
}

/**
 * Commands, by intent rather than by name. The same intent is `check-types` in
 * one repo and `typecheck` in five others, so a core that greps one name reports
 * the other as absent.
 */
// A lookup table built from PARSED JSON, keyed by strings the file chooses.
//
// `deps[tool]` was a plain object literal and `tool` comes from a script BODY,
// so a script reading `constructor lint .` found `Object` on the prototype,
// `!deps[tool]` was false, and the "runs a tool that is not a dependency" check
// silently skipped -- the one case it exists to report. `toString` and
// `valueOf` do the same.
//
// `scripts` is not exposed today, because no INTENT name collides with
// `Object.prototype`. It is built the same way anyway: that non-collision is a
// fact someone would have to re-verify every time an intent is added, and
// nothing would tell them if they got it wrong.
const fromJson = (...objects) => Object.assign(Object.create(null), ...objects);

const INTENTS = {
  lint:      ["lint", "lint:check", "eslint", "ruff", "check:lint", "biome:check"],
  typecheck: ["typecheck", "check-types", "type-check", "tsc", "types", "mypy"],
  test:      ["test", "test:unit", "tests", "pytest", "vitest", "jest"],
  build:     ["build", "compile", "bundle"],
};

/**
 * `shell` is the shell the package's runner runs its scripts with, as
 * `runnerShells` names it and `scriptShells` asks it: it decides which words
 * are the shell's own. Given, as by a test, it is used as is. A runner whose
 * shell isn't one the reader models, yarn 2 and later say, has no script
 * judged, and nor has one whose shell can't be asked: npm's `script-shell=true`
 * runs nothing of a script.
 */
export function detectCommands(dir, language, packageManager, options = {}) {
  const given = Object.hasOwn(options, "shell");
  const shells = given ? null : runnerShells(dir, packageManager);
  const shell = given ? options.shell : shells && scriptShells(shells);
  const judged = given || shell !== null;
  const out = {};
  const questions = [];

  if (language === "typescript") {
    const pkg = readJson(join(dir, "package.json"));
    const scripts = fromJson(pkg?.scripts);
    for (const [intent, names] of Object.entries(INTENTS)) {
      const hit = names.find(n => scripts[n]);
      if (!hit) { out[intent] = { cmd: null, state: "absent" }; continue; }
      const runner = packageManager ?? "npm";
      out[intent] = { cmd: `${runner} run ${hit}`, state: "present", script: hit };
      // A declared script that can't pass is BROKEN, not present: it runs a
      // program that isn't there, or it always fails. Only when that is certain;
      // a script that can't be read with confidence stays present.
      const verdict = judged ? scriptOutcome(scripts[hit], { dir, deps: fromJson(pkg.dependencies, pkg.devDependencies) }, shell) : { broken: false };
      if (verdict.broken) {
        out[intent].state = "broken";
        out[intent].reason = `script '${hit}' ${verdict.why}`;
      }
    }
  } else if (language === "python") {
    const py = existsSync(join(dir, "pyproject.toml")) ? readFileSync(join(dir, "pyproject.toml"), "utf8") : "";
    const runner = packageManager === "uv" ? "uv run" : packageManager === "poetry" ? "poetry run" : "python -m";
    out.lint = /\[tool\.ruff/.test(py) ? { cmd: `${runner} ruff check .`, state: "present" } : { cmd: null, state: "absent" };
    out.typecheck = /\[tool\.mypy/.test(py) ? { cmd: `${runner} mypy .`, state: "present" } : { cmd: null, state: "absent" };
    out.test = existsSync(join(dir, "tests")) || /pytest/.test(py) ? { cmd: `${runner} pytest`, state: "present" } : { cmd: null, state: "absent" };
    out.build = { cmd: null, state: "absent" };

    // Two formatters that disagree is a ping-pong an agent cannot escape.
    const hasBlack = /\[tool\.black/.test(py);
    const hasRuffFmt = /\[tool\.ruff\.format/.test(py) || /\[tool\.ruff/.test(py);
    if (hasBlack && hasRuffFmt) {
      questions.push({
        field: "units[].formatter",
        why: "black and ruff-format are both configured and they disagree on output",
        evidence: "pyproject.toml declares [tool.black] and [tool.ruff]",
        options: ["black", "ruff-format"],
      });
    }
    // `uv sync` without extras can install no test runner at all.
    if (/\[project\.optional-dependencies\]|\[dependency-groups\]/.test(py) && packageManager === "uv") {
      questions.push({
        field: "units[].installCmd",
        why: "optional dependency groups exist, so a plain `uv sync` may install no test runner",
        evidence: "pyproject.toml declares optional-dependencies or dependency-groups",
        options: ["uv sync", "uv sync --extra dev", "uv sync --all-extras"],
      });
    }
  }
  return { commands: out, questions };
}

/**
 * CI. An empty workflows directory is `none`, not `github-actions`: one client
 * repo's .github/workflows exists and contains nothing, so presence proves nothing.
 */
export function detectCi(root) {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return { provider: "none", workflows: [], notes: [] };
  const files = readdirSync(dir).filter(f => /\.ya?ml$/.test(f));
  if (files.length === 0) return { provider: "none", workflows: [], notes: [".github/workflows exists but is empty"] };

  const notes = [];
  for (const f of files) {
    const body = readFileSync(join(dir, f), "utf8");
    // CI that fires only on close runs AFTER the merge, so it can never gate one.
    if (/pull_request:[\s\S]{0,200}?types:\s*\[?[^\]\n]*closed/.test(body) && !/opened|synchronize/.test(body))
      notes.push(`${f}: pull_request fires only on 'closed', so it runs after the merge and cannot gate it`);
    if (/continue-on-error:\s*true/.test(body))
      notes.push(`${f}: contains continue-on-error, so a failing step still reports success`);
  }
  return { provider: "github-actions", workflows: files, notes };
}

/** Merge method MEASURED from parent counts. Settings say what is allowed. */
export function detectMergeMethod(nwo) {
  const r = ghJson(`repos/${nwo}/commits?per_page=30`, ".[].parents|length");
  if (!r.ok) return { value: null, evidence: "could not read history" };
  const counts = r.out.split("\n").filter(Boolean).map(Number);
  const two = counts.filter(n => n === 2).length;
  const ratio = counts.length ? two / counts.length : 0;
  const evidence = `${two} of the last ${counts.length} commits are two-parent`;
  // Only a near-unanimous history identifies the method. Anything mixed means the
  // repo allows several and a gate pinned to one can never bind.
  if (ratio > 0.1 && ratio < 0.9) {
    return {
      value: null, evidence,
      question: {
        field: "merge.method",
        why: "the history is mixed, so no single method can be inferred",
        evidence,
        options: ["squash", "merge", "rebase"],
      },
    };
  }
  return { value: ratio >= 0.9 ? "merge" : "squash", evidence };
}

/** Can the server enforce anything here at all? 403 means never. */
export function detectEnforcement(nwo) {
  const prot = ghJson(`repos/${nwo}/branches/main/protection`);
  const rules = ghJson(`repos/${nwo}/rulesets`);
  if (!prot.ok && !rules.ok) {
    const why = /403/.test(prot.err) ? "HTTP 403: the plan does not expose branch protection on this repo" : (prot.err.split("\n")[0] || "unreadable");
    return { value: "attested", evidence: why };
  }
  return { value: "enforced", evidence: "branch protection or rulesets are readable" };
}

/** Reviewers: configured is not installed. Probe for actual output. */
export function detectReviewers(root, nwo) {
  const configured = [];
  if (existsSync(join(root, ".coderabbit.yaml")) || existsSync(join(root, ".coderabbit.yml"))) configured.push("coderabbitai");
  if (existsSync(join(root, ".pr_agent.toml"))) configured.push("qodo");
  // Count actual comment authors on recent PRs. The search API does not reliably
  // index bot comments, so it reported "never commented" for reviewers that
  // comment on every PR.
  const prs = sh("gh", ["pr", "list", "--repo", nwo, "--state", "all", "--limit", "15",
                        "--json", "number", "--jq", ".[].number"], root);
  const tally = new Map();
  for (const n of (prs.ok ? prs.out.split("\n").filter(Boolean) : [])) {
    const c = ghJson(`repos/${nwo}/issues/${n}/comments?per_page=100`, ".[].user.login");
    if (!c.ok) continue;
    for (const login of c.out.split("\n").filter(Boolean)) tally.set(login, (tally.get(login) ?? 0) + 1);
  }
  // Only reviewer-shaped bots. github-actions and pkg-pr-new comment on every PR
  // but review nothing, and counting them as coverage is the same
  // absence-read-as-presence error as trusting a rate-limited green check.
  const REVIEWERISH = /codex|coderabbit|greptile|qodo|sourcery|korbit|bugbot|ellipsis/i;
  const byName = new Map();
  for (const [login, count] of tally) {
    if (!REVIEWERISH.test(login)) continue;
    const norm = login.replace(/\[bot\]$/, "");
    byName.set(norm, (byName.get(norm) ?? 0) + count);
  }
  for (const c of configured) if (!byName.has(c)) byName.set(c, 0);
  return [...byName].map(([login, comments]) => ({
    login,
    configured: configured.some(c => login.includes(c)),
    everCommented: comments > 0,
    comments,
  }));
}

/**
 * Units: the repo root, plus any directory holding its own manifest. Reads the
 * checkout alone, never the network. Returns {units, questions, notes}.
 */
export function detectUnits(root) {
  const questions = [];
  const notes = [];
  const roots = new Set(["."]);
  for (const d of readdirSync(root)) {
    const p = join(root, d);
    if (!statSync(p).isDirectory() || d.startsWith(".") || d === "node_modules") continue;
    if (existsSync(join(p, "package.json")) || existsSync(join(p, "pyproject.toml"))) roots.add(d);
  }
  // A workspace keeps one lockfile, at its root, so a member without one of its
  // own uses the root's package manager. A folder the workspace doesn't list
  // stays unsettled, as before, and so does one that isn't a JavaScript package:
  // those managers know only packages, whatever a broad glob matches.
  const rootPm = detectPackageManager(root);
  const globs = rootPm.value ? workspaceGlobs(root, rootPm.value) : [];
  const units = [];
  for (const rel of roots) {
    const dir = rel === "." ? root : join(root, rel);
    const language = detectLanguage(dir);
    if (!language) continue;
    let pm = rel === "." ? rootPm : detectPackageManager(dir);
    const member = rel !== "." && pm.value === null && !pm.question && language === "typescript" ? isMember(rel, globs, rootPm.value, root) : false;
    if (member === true) {
      pm = { value: rootPm.value, question: null };
      notes.push(`unit ${rel}: no lockfile of its own, and a member of the root's ${rootPm.value} workspace, so it uses ${rootPm.value}`);
    } else if (member === null) {
      notes.push(`unit ${rel}: whether the root's ${rootPm.value} workspace lists it can't be told, so it has no package manager; name one in the profile if it has`);
    }
    if (pm.question) questions.push({ ...pm.question, unit: rel });
    const { commands, questions: cq } = detectCommands(dir, language, pm.value);
    for (const q of cq) questions.push({ ...q, unit: rel });
    units.push({ id: rel === "." ? "root" : rel, root: rel, language, packageManager: pm.value, commands });
  }
  if (units.length === 0) notes.push("no recognised manifest: this repo has no buildable unit");
  return { units, questions, notes };
}

/** Full detection pass. Returns {proposal, questions, notes}. */
export function detect(root) {
  const questions = [];
  const notes = [];
  const { key, defaultBranch } = detectIdentity(root);
  if (!key) return { proposal: null, questions: [], notes: ["no git remote named origin"] };

  const visRes = ghJson(`repos/${key}`, ".visibility");
  const permRes = ghJson(`repos/${key}`, ".permissions | to_entries | map(select(.value)) | map(.key) | join(\",\")");
  const perms = permRes.ok ? permRes.out.split(",") : [];
  const permission = perms.includes("admin") ? "admin" : perms.includes("push") ? "write" : perms.includes("triage") ? "triage" : "read";

  const found = detectUnits(root);
  const units = found.units;
  questions.push(...found.questions);
  notes.push(...found.notes);

  const ci = detectCi(root);
  notes.push(...ci.notes);
  const merge = detectMergeMethod(key);
  if (merge.question) questions.push(merge.question);
  const enf = detectEnforcement(key);
  const reviewers = detectReviewers(root, key);
  for (const r of reviewers) {
    if (r.configured && !r.everCommented) notes.push(`${r.login} is configured but has never commented: configured is not installed`);
  }

  const proposal = {
    schemaVersion: 1,
    project: { kind: null },                      // never guessed: it changes every ceiling
    identity: { key, defaultBranch, visibility: visRes.ok ? visRes.out : "private" },
    authority: { permission, policy: null, profileLocation: null },
    state: { mode: null },
    units,
    ci: { provider: ci.provider, requiredChecks: [] },
    merge: { method: merge.value, enforcement: enf.value },
    reviewers: reviewers.filter(r => r.everCommented).map(r => ({ login: r.login, kind: "advisory", refusal: null })),
  };

  questions.unshift(
    { field: "project.kind", why: "sets every autonomy ceiling and whether discovery runs", evidence: "not detectable", options: ["product", "client"] },
    { field: "authority.policy", why: `detected permission is '${permission}', but CAN is not MAY`, evidence: `permissions: ${perms.join(", ") || "none"}`, options: ["owner", "propose_and_merge", "propose_and_wait", "propose_only"] },
  );

  notes.push(`merge.method measured: ${merge.evidence}`);
  notes.push(`merge.enforcement: ${enf.evidence}`);
  return { proposal, questions, notes };
}
