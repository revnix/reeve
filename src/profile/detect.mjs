// detect — propose a profile from what the repo actually is.
//
// Detection never guesses silently. Anything ambiguous is returned as a
// `question` with the evidence that made it ambiguous, because a wrong default
// here is a gate judging the wrong thing. `reeve init` shows these before writing.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

/** Package manager from lockfiles. Two lockfiles is a QUESTION, never a pick. */
export function detectPackageManager(dir) {
  const locks = [
    ["pnpm", "pnpm-lock.yaml"], ["npm", "package-lock.json"],
    ["yarn", "yarn.lock"], ["bun", "bun.lockb"],
    ["uv", "uv.lock"], ["poetry", "poetry.lock"], ["pdm", "pdm.lock"],
  ].filter(([, f]) => existsSync(join(dir, f)));

  if (locks.length === 0) return { value: null, question: null };
  if (locks.length === 1) return { value: locks[0][0], question: null };
  return {
    value: null,
    question: {
      field: "units[].packageManager",
      why: `${locks.length} lockfiles are tracked and they can disagree`,
      evidence: locks.map(([m, f]) => `${f} (${m})`).join(", "),
      options: locks.map(([m]) => m),
    },
  };
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

export function detectCommands(dir, language, packageManager) {
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
      // A declared script whose tool is not a dependency is BROKEN, not present.
      const body = scripts[hit];
      const tool = String(body).trim().split(/\s+/)[0];
      const deps = fromJson(pkg.dependencies, pkg.devDependencies);
      const localBin = existsSync(join(dir, "node_modules", ".bin", tool));
      if (!deps[tool] && !localBin && !/^(node|tsc|pnpm|npm|yarn|turbo|nx)$/.test(tool)) {
        out[intent].state = "broken";
        out[intent].reason = `script '${hit}' runs '${tool}', which is neither a dependency nor installed`;
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
 * CI. An empty workflows directory is `none`, not `github-actions`: 4re's
 * .github/workflows exists and contains nothing, so presence proves nothing.
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

  // Units: the repo root, plus any directory holding its own manifest.
  const roots = new Set(["."]);
  for (const d of readdirSync(root)) {
    const p = join(root, d);
    if (!statSync(p).isDirectory() || d.startsWith(".") || d === "node_modules") continue;
    if (existsSync(join(p, "package.json")) || existsSync(join(p, "pyproject.toml"))) roots.add(d);
  }
  const units = [];
  for (const rel of roots) {
    const dir = rel === "." ? root : join(root, rel);
    const language = detectLanguage(dir);
    if (!language) continue;
    const pm = detectPackageManager(dir);
    if (pm.question) questions.push({ ...pm.question, unit: rel });
    const { commands, questions: cq } = detectCommands(dir, language, pm.value);
    for (const q of cq) questions.push({ ...q, unit: rel });
    units.push({ id: rel === "." ? "root" : rel, root: rel, language, packageManager: pm.value, commands });
  }
  if (units.length === 0) notes.push("no recognised manifest: this repo has no buildable unit");

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
