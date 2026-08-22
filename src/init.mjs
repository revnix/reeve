// init — detect, confirm, preview, write, prove.
//
// The order matters and it is stolen from tools that get this right. Detect
// rather than interrogate, because a question whose answer is on disk is a
// question that should not be asked. Preview before writing, like `terraform
// plan`, because a config you did not see written is a config you will not
// remember. And prove afterwards with a real probe, like `stripe trigger`,
// because an init that ends by saying "done" has told you nothing.
//
// Exit codes follow the terraform convention the CLI documents:
//   0  nothing to do, the profile already matches
//   2  changes were written (or would be)
//   1  error, including a question that cannot be answered
//
// A question that cannot be answered FAILS. It does not get a default. Every
// unanswerable question here is one where a wrong guess makes a gate judge the
// wrong thing.

import { detect } from "./profile/detect.mjs";
import { validate, withDefaults } from "./profile/schema.mjs";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Where a profile belongs, given what the repo is. */
export function profilePath(nwo, location) {
  return location === "committed"
    ? join(process.cwd(), ".ops", "profile.json")
    : join(homedir(), ".reeve", "profiles", `${nwo}.json`);
}

/** Stable key order, so a rewrite produces a readable diff rather than a reshuffle. */
const ORDER = ["schemaVersion", "project", "identity", "authority", "state", "units",
               "lanes", "ci", "merge", "reviewers", "rounds", "risk", "tools", "watch"];
export function canonical(profile) {
  const out = {};
  for (const k of ORDER) if (profile[k] !== undefined) out[k] = profile[k];
  for (const k of Object.keys(profile)) if (!(k in out)) out[k] = profile[k];
  return out;
}

/**
 * Merge detection into an existing profile.
 *
 * Detection knows what it measured and nothing else. A profile also carries
 * lanes, risk paths, reviewer refusal patterns and tool pins, none of which are
 * detectable — so REPLACING an existing profile silently destroys the part a
 * human wrote, which is most of the part that matters.
 *
 * Detected values win only where detection actually has an opinion.
 */
export function mergeProfile(existing, detected) {
  if (!existing) return detected;
  const out = structuredClone(existing);
  const set = (path, v) => {
    if (v === undefined || v === null) return;
    const parts = path.split("."); let n = out;
    for (const k of parts.slice(0, -1)) n = n[k] ??= {};
    n[parts.at(-1)] = v;
  };
  // Facts about the repo: detection is authoritative.
  set("identity.key", detected.identity?.key);
  set("identity.defaultBranch", detected.identity?.defaultBranch);
  set("identity.visibility", detected.identity?.visibility);
  set("authority.permission", detected.authority?.permission);
  set("ci.provider", detected.ci?.provider);
  set("merge.enforcement", detected.merge?.enforcement);
  if (detected.merge?.method) set("merge.method", detected.merge.method);

  // Units merge per unit id: detected commands refresh, hand-written extras stay.
  const byId = new Map((out.units ?? []).map(u => [u.id, u]));
  out.units = (detected.units ?? []).map(d => {
    const prior = byId.get(d.id);
    if (!prior) return d;
    return { ...prior, language: d.language, packageManager: d.packageManager ?? prior.packageManager,
             commands: { ...(prior.commands ?? {}), ...(d.commands ?? {}) } };
  });
  // A unit that existed and is no longer detected is kept, not deleted: a
  // temporarily unreadable directory must not silently drop a lane's territory.
  for (const [id, u] of byId) if (!out.units.some(x => x.id === id)) out.units.push(u);

  // Reviewers: keep the configured roster, add any newly seen.
  const known = new Set((out.reviewers ?? []).map(r => r.login));
  out.reviewers = [...(out.reviewers ?? []), ...(detected.reviewers ?? []).filter(r => !known.has(r.login))];
  return out;
}

/**
 * A SEMANTIC diff. A line diff of reformatted JSON reports every line as changed
 * and hides the one that actually did.
 */
export function semanticDiff(before, after, path = "") {
  const out = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const k of keys) {
    const a = before?.[k], b = after?.[k];
    const here = path ? `${path}.${k}` : k;
    const plain = v => v === null || typeof v !== "object";
    if (plain(a) && plain(b)) { if (a !== b) out.push({ path: here, from: a, to: b }); continue; }
    if (Array.isArray(a) || Array.isArray(b)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path: here, from: a, to: b });
      continue;
    }
    out.push(...semanticDiff(a ?? {}, b ?? {}, here));
  }
  return out;
}

/** A line diff, so the preview shows what changes rather than the whole file. */
export function diff(before, after) {
  const a = (before ?? "").split("\n"), b = after.split("\n");
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined && b[i] === undefined) out.push(`- ${a[i]}`);
    else if (a[i] === undefined) out.push(`+ ${b[i]}`);
    else { out.push(`- ${a[i]}`); out.push(`+ ${b[i]}`); }
  }
  return out;
}

/**
 * Turn detection plus answers into a complete profile.
 * Returns {profile, unanswered} — unanswered is fatal in headless mode.
 */
export function compose(proposal, questions, answers = {}) {
  const p = structuredClone(proposal);
  const unanswered = [];

  for (const q of questions) {
    const given = answers[q.field];
    if (given === undefined) { unanswered.push(q); continue; }
    // Only the fields detection could not settle are answerable here; everything
    // else came from the repo and is not up for negotiation.
    if (q.field === "project.kind") p.project.kind = given;
    else if (q.field === "authority.policy") p.authority.policy = given;
    else if (q.field === "merge.method") p.merge.method = given;
    else if (q.field === "units[].packageManager") {
      const u = p.units.find(x => x.root === (q.unit ?? "."));
      if (u) u.packageManager = given;
    } else if (q.field === "units[].installCmd") {
      const u = p.units.find(x => x.root === (q.unit ?? "."));
      if (u) u.installCmd = given;
    } else if (q.field === "units[].formatter") {
      const u = p.units.find(x => x.root === (q.unit ?? "."));
      if (u) u.formatter = given;
    }
  }

  // Derived, not asked. A client repo may never carry agent artifacts, and a
  // public repo should not either, so the location follows from what the repo is.
  if (!p.authority.profileLocation) {
    p.authority.profileLocation =
      p.project.kind === "client" ? "sidecar"
      : p.identity.visibility === "public" ? "sidecar"
      : "committed";
  }
  if (!p.state.mode) {
    p.state.mode =
      p.project.kind === "client" ? "hub"
      : p.identity.visibility === "public" ? "sibling"
      : "in-repo";
  }
  // A reviewer without a refusal pattern cannot tell a rate limit from approval,
  // and the schema refuses it, so detection's bare list is completed here.
  //
  // Refusal is one shape per REASON, not one per reviewer. Each bot spells quota,
  // transient error and rate limit differently, so a single-string pattern is
  // one-shape-short by construction rather than by oversight: it matches the one
  // shape that happened to be on screen when it was written, and every other
  // refusal falls through to null -- which derive.mjs reads as chatter, making a
  // bot that crashed indistinguishable from a bot that never spoke. Those want
  // opposite responses. Measured 2026-08-22 on two bots at once; the bodies are
  // fixtures under test/fixtures/reviewer-bodies-2026-08-22/.
  const KNOWN_REFUSALS = {
    "chatgpt-codex-connector": {
      refusal: "You have reached your Codex usage limits|Codex Review: Something went wrong",
      trigger: "@codex review",
      clean: "Didn't find any major issues",
      // Without this, every Codex clean pass degrades to unbound_clean and never
      // counts as coverage. The commit line is the entire structural tell that
      // separates a pass from a refusal -- a refusal never names a reviewed
      // commit -- so a seed that omits it throws away the one discriminator that
      // does not depend on prose staying still.
      commitPattern: "Reviewed commit:\\**\\s*`?([0-9a-f]{7,40})`?",
    },
    coderabbitai: {
      // The second alternative is CodeRabbit's own machine marker, not its
      // visible wording. Its two rate-limit bodies word themselves differently
      // ("Review limit reached" and "Review rate limited") and only the marker
      // is stable across both.
      refusal: "Review rate limited|rate limited by coderabbit\\.ai",
      trigger: "@coderabbitai review",
      clean: "Actionable comments posted: 0",
    },
  };
  p.reviewers = (p.reviewers ?? []).map(r => ({ ...r, kind: r.kind ?? "advisory", ...(KNOWN_REFUSALS[r.login] ?? {}) }))
    .filter(r => r.refusal);   // an unknown reviewer with no refusal pattern is dropped, not guessed at

  return { profile: canonical(withDefaults(p)), unanswered };
}

/** The self-proof: does this profile actually describe a workable project? */
export function prove(profile) {
  const findings = [];
  const units = profile.units ?? [];
  if (!units.length) findings.push({ level: "error", text: "no buildable unit was found; reeve cannot verify anything here" });

  let anyTest = false;
  for (const u of units) {
    const cmds = u.commands ?? {};
    if (cmds.test?.state === "present") anyTest = true;
    for (const [intent, c] of Object.entries(cmds)) {
      if (c.state === "broken") findings.push({ level: "warn", text: `${u.id}: ${intent} is declared but broken — ${c.reason ?? "its tool is not installed"}` });
      if (c.state === "advisory") findings.push({ level: "warn", text: `${u.id}: ${intent} is advisory — a pass from it is not evidence` });
    }
    if (!u.packageManager) findings.push({ level: "error", text: `${u.id}: no package manager was settled` });
    if (u.language === "python" && !u.toolPins) findings.push({ level: "warn", text: `${u.id}: no tool pins — an unpinned linter moves its own verdict between runs` });
  }
  if (!anyTest) findings.push({ level: "warn", text: "no unit declares a test command; a fix here cannot be evidenced by a test that failed first" });

  if (profile.ci?.provider === "none")
    findings.push({ level: "warn", text: "no CI: 'green' is not a reachable state here, so the merge condition rests on local commands alone" });
  if (profile.merge?.enforcement === "attested")
    findings.push({ level: "warn", text: "branch protection is not readable on this repo, so the boundary is attested rather than enforced" });
  if (!(profile.reviewers ?? []).length)
    findings.push({ level: "warn", text: "no reviewer is reachable; review coverage cannot be part of the merge condition" });
  if (profile.authority?.policy === "propose_only")
    findings.push({ level: "note", text: "policy is propose_only: reeve will open PRs and stop, never merge" });

  return { ok: !findings.some(f => f.level === "error"), findings };
}

/** Render the whole flow for a human. */
export function renderPlan({ nwo, proposal, questions, notes, profile, unanswered, path, existing }) {
  const L = [];
  L.push(`reeve init  ${nwo}`, "");

  L.push("DETECTED");
  L.push(`  visibility     ${proposal.identity.visibility}`);
  L.push(`  permission     ${proposal.authority.permission}`);
  L.push(`  ci             ${proposal.ci.provider}`);
  L.push(`  merge          ${proposal.merge.method ?? "(mixed history — cannot be inferred)"}`);
  L.push(`  enforcement    ${proposal.merge.enforcement}`);
  for (const u of proposal.units)
    L.push(`  unit ${u.id.padEnd(10)} ${u.language}/${u.packageManager ?? "?"}  ${Object.entries(u.commands ?? {}).filter(([, c]) => c.state === "present").map(([i]) => i).join(" ") || "(no commands)"}`);

  if (notes?.length) {
    L.push("", "NOTED");
    for (const n of notes) L.push(`  ${n}`);
  }

  if (unanswered?.length) {
    L.push("", "NEEDS AN ANSWER  (each one changes what the gate judges, so none is defaulted)");
    for (const q of unanswered) {
      L.push(`  ${q.field}${q.unit && q.unit !== "." ? ` [${q.unit}]` : ""}`);
      L.push(`      ${q.why}`);
      L.push(`      evidence: ${q.evidence}`);
      if (q.options?.length) L.push(`      options:  ${q.options.join(" | ")}`);
      L.push(`      answer:   --set ${q.field}=<value>`);
    }
    return L.join("\n");
  }

  L.push("", existing ? `PLAN  ${path}` : `PLAN  ${path}  (new)`);
  if (!existing) {
    for (const line of JSON.stringify(profile, null, 2).split("\n").slice(0, 40)) L.push(`  + ${line}`);
  } else {
    const changes = semanticDiff(JSON.parse(existing), profile);
    if (!changes.length) L.push("  no changes");
    for (const c of changes.slice(0, 40)) {
      const f = JSON.stringify(c.from), t = JSON.stringify(c.to);
      L.push(`  ${c.path}`);
      L.push(`    - ${f === undefined ? "(absent)" : String(f).slice(0, 100)}`);
      L.push(`    + ${t === undefined ? "(removed)" : String(t).slice(0, 100)}`);
    }
    if (changes.length > 40) L.push(`  … ${changes.length - 40} more`);
  }

  const p = prove(profile);
  L.push("", "PROOF");
  if (!p.findings.length) L.push("  nothing to flag");
  for (const f of p.findings) L.push(`  ${f.level.toUpperCase().padEnd(6)} ${f.text}`);
  return L.join("\n");
}

/** The whole flow. `write` is false for a plan-only run. */
export function init({ root = process.cwd(), answers = {}, write = false }) {
  const { proposal, questions, notes } = detect(root);
  if (!proposal) return { code: 1, output: `reeve init: ${notes.join("; ")}` };

  const nwo = proposal.identity.key;
  const { profile: detectedProfile, unanswered } = compose(proposal, questions, answers);
  const path = profilePath(nwo, detectedProfile.authority.profileLocation);
  const existingRaw = existsSync(path) ? readFileSync(path, "utf8") : null;
  let existingObj = null;
  if (existingRaw) {
    try { existingObj = JSON.parse(existingRaw); }
    catch (e) { return { code: 1, output: `reeve init: ${path} is not valid JSON — ${e.message}` }; }
  }
  // Merge, never replace: lanes, risk paths and reviewer patterns are not
  // detectable, and overwriting them is how an init destroys the part that matters.
  const profile = canonical(withDefaults(mergeProfile(existingObj, detectedProfile)));
  const existing = existingRaw;

  const output = renderPlan({ nwo, proposal, questions, notes, profile, unanswered, path, existing });
  if (unanswered.length) return { code: 1, output, unanswered };

  const v = validate(profile);
  if (!v.ok) return { code: 1, output: output + "\n\nREFUSED\n" + v.errors.map(e => "  " + e).join("\n") };

  const after = JSON.stringify(profile, null, 2) + "\n";
  if (existing === after) return { code: 0, output: output + "\n\nnothing to do", path };
  if (!write) return { code: 2, output: output + `\n\n-> reeve init --write   to apply`, path };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, after);
  return { code: 2, output: output + `\n\nwrote ${path}`, path, profile };
}
