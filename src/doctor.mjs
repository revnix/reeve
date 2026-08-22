// doctor — say out loud what is actually true, before anything acts on it.
//
// Every check here exists because the corresponding state was true for a long
// time while nothing said so: a merge gate that merged 0 of 10, a plugin cache
// running a 41-line binary while the repo held an 84-line one, and a base branch
// red for ten consecutive runs. A check earns its place only if it would have
// printed something on 2026-08-19.
//
// Exit codes follow the terraform/ruff convention the CLI documents:
//   0 healthy · 1 broken · 3 degraded
// A check that cannot answer reports UNKNOWN and degrades; it never passes.

import { checkBaseline } from "./baseline.mjs";
import { readCanaryState } from "./canary.mjs";
import { probeKeychain } from "./containment.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BROKEN = "BROKEN";
const DEGRADED = "DEGRADED";
const OK = "OK";
const UNKNOWN = "UNKNOWN";

/** Shell out without throwing: a failed probe is data, not a crash. */
function sh(cmd, args, opts = {}) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim() };
  } catch (e) {
    return { ok: false, out: "", err: String(e.stderr || e.message).trim() };
  }
}

function gh(path, jq) {
  const args = ["api", path];
  if (jq) args.push("--jq", jq);
  return sh("gh", args);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

/** Hash a directory's files by content, so a version string cannot lie about it. */
function hashTree(dir, filter = () => true) {
  if (!existsSync(dir)) return null;
  const parts = [];
  const walk = d => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (filter(p)) parts.push(name + ":" + sha256(readFileSync(p)));
    }
  };
  walk(dir);
  return sha256(Buffer.from(parts.join("\n")));
}

// ── checks ────────────────────────────────────────────────────────────────

/**
 * The gate can only bind a merge if the actuator cannot step around it. Reads
 * both surfaces because they disagree: classic protection and rulesets are
 * separate systems and a repo can be governed by either, neither, or both.
 */
function checkMergeAuthority(nwo) {
  const lines = [];
  const prot = gh(`repos/${nwo}/branches/main/protection`);
  const rules = gh(`repos/${nwo}/rulesets`);

  if (!prot.ok && /403/.test(prot.err)) {
    return {
      id: "R-01", level: UNKNOWN, title: "merge authority is not interrogable",
      lines: [
        "branch protection and rulesets both return HTTP 403 on this repo.",
        "A private repo on a free plan cannot be asked, let alone enforced.",
        "-> this repo can only ever be ATTESTED, never ENFORCED",
      ],
    };
  }

  // Neither surface readable is NOT "enforced". An earlier revision returned OK
  // when both probes failed, which is the same absence-read-as-success shape this
  // check exists to find.
  if (!prot.ok && !rules.ok) {
    return {
      id: "R-01", level: UNKNOWN, title: "merge authority",
      lines: [
        `branch protection: ${(prot.err || "unreadable").split("\n")[0]}`,
        `rulesets:          ${(rules.err || "unreadable").split("\n")[0]}`,
        "-> not checkable, which is not clean",
      ],
    };
  }

  let level = OK;
  if (prot.ok) {
    const p = JSON.parse(prot.out);
    const contexts = p.required_status_checks?.contexts ?? [];
    const strict = p.required_status_checks?.strict;
    const admins = p.enforce_admins?.enabled;
    if (admins === false) { level = BROKEN; lines.push("enforce_admins: false — the admin identity is exempt from every rule"); }
    if (contexts.length === 0) { level = BROKEN; lines.push("no required status checks — nothing CI reports can block a merge"); }
    else lines.push(`required contexts: ${contexts.join(", ")}`);
    if (strict === false) { if (level === OK) level = DEGRADED; lines.push("strict: false — a branch may merge without being up to date with its base"); }
  }

  if (rules.ok) {
    for (const r of JSON.parse(rules.out)) {
      const detail = gh(`repos/${nwo}/rulesets/${r.id}`);
      if (!detail.ok) continue;
      const d = JSON.parse(detail.out);
      const bypass = d.bypass_actors ?? [];
      const always = bypass.filter(b => b.bypass_mode === "always");
      if (always.length) {
        level = BROKEN;
        lines.push(`ruleset ${d.name}: bypass_actors allow ${always.map(b => b.actor_type).join(", ")} to bypass ALWAYS`);
      }
      const hasChecks = (d.rules ?? []).some(x => x.type === "required_status_checks");
      if (!hasChecks) { level = BROKEN; lines.push(`ruleset ${d.name}: contains no required_status_checks rule at all`); }
    }
  }

  if (level === BROKEN) lines.push("-> every gate written against this repo is decorative until the actuator loses its bypass");
  return { id: "R-01", level, title: "merge authority", lines: lines.length ? lines : ["enforced"] };
}

/**
 * The running artifact must be the reviewed artifact. Compares content hashes,
 * never version strings: seven cached plugin versions once shared one binary
 * while the repo held a different one, so the version string carried no
 * information at all.
 */
function checkArtifactDrift(pluginCacheRoot, repoPluginDir) {
  if (!existsSync(pluginCacheRoot) || !existsSync(repoPluginDir)) {
    return { id: "R-02", level: UNKNOWN, title: "running artifact vs reviewed artifact", lines: ["no plugin cache or repo copy to compare"] };
  }
  const isCode = p => /\/(bin|hooks|agents|skills)\//.test(p);
  const repoHash = hashTree(repoPluginDir, isCode);
  const versions = readdirSync(pluginCacheRoot).filter(v => statSync(join(pluginCacheRoot, v)).isDirectory()).sort();
  const rows = versions.map(v => ({ v, h: hashTree(join(pluginCacheRoot, v), isCode) }));
  const live = rows[rows.length - 1];
  const lines = [`repo    ${repoHash}`, ...rows.map(r => `cache   ${r.h}  ${r.v}${r === live ? "   <- resolved" : ""}`)];
  const distinct = new Set(rows.map(r => r.h));
  if (distinct.size < rows.length) lines.push(`${rows.length} cached versions share ${distinct.size} distinct hash(es): version strings carry no information`);
  if (!live || live.h !== repoHash) {
    lines.push("-> the code that runs is not the code that was reviewed");
    return { id: "R-02", level: BROKEN, title: "running artifact vs reviewed artifact", lines };
  }
  return { id: "R-02", level: OK, title: "running artifact vs reviewed artifact", lines: [`content hash matches: ${repoHash}`] };
}

/**
 * A gate that pins one merge shape while the repo produces another can never
 * bind. Measured from parent counts rather than from settings, because settings
 * describe what is allowed and parents describe what happened.
 */
function checkMergeShape(nwo, declared) {
  const r = gh(`repos/${nwo}/commits?sha=main&per_page=20`, ".[].parents|length");
  if (!r.ok) return { id: "R-03", level: UNKNOWN, title: "merge shape", lines: ["could not read main's history"] };
  const counts = r.out.split("\n").filter(Boolean).map(Number);
  const twoParent = counts.filter(n => n === 2).length;
  const lines = [`last ${counts.length} commits on main: ${twoParent} merge commits, ${counts.length - twoParent} single-parent`];
  if (!declared) {
    lines.push("the profile names no merge method");
    lines.push("-> a gate cannot pin a shape the profile has not chosen");
    return { id: "R-03", level: DEGRADED, title: "merge shape", lines };
  }
  lines.push(`gate declares: ${declared}`);
  if (declared === "squash" && twoParent > 0) {
    lines.push("-> a squash-matching gate cannot have produced these merges");
    return { id: "R-03", level: BROKEN, title: "merge shape", lines };
  }
  return { id: "R-03", level: OK, title: "merge shape", lines };
}

/**
 * No gate downstream of a red base can mean anything, and a base that is red for
 * many runs hides whatever breaks next behind an already-red rollup.
 */
function checkBaseHealth(nwo, workflow = "ci.yml", branch = "main") {
  const r = sh("gh", ["run", "list", "--repo", nwo, "--workflow", workflow, "--branch", branch,
                      "--limit", "10", "--json", "conclusion", "--jq", ".[].conclusion"]);
  if (!r.ok) return { id: "R-04", level: UNKNOWN, title: "base health", lines: [`could not read ${workflow} runs on ${branch}`] };
  const runs = r.out.split("\n").filter(Boolean);
  const failures = runs.filter(c => c === "failure").length;
  const lines = [`${branch}: ${failures} of the last ${runs.length} ${workflow} runs failed`];
  if (failures === runs.length && runs.length > 0) {
    lines.push("-> every PR inherits a red rollup, so a new failure is invisible");
    return { id: "R-04", level: BROKEN, title: "base health", lines };
  }
  if (failures > 0) return { id: "R-04", level: DEGRADED, title: "base health", lines };
  return { id: "R-04", level: OK, title: "base health", lines };
}

/**
 * Reviewer availability is a first-class state, because a rate-limited reviewer
 * reports success and an uninstalled one reports nothing, and both are
 * byte-identical to "found no problems" unless something counts.
 */
function checkReviewerSupply(nwo, reviewers) {
  const lines = [];
  let level = OK;
  const prs = sh("gh", ["pr", "list", "--repo", nwo, "--state", "merged", "--limit", "40", "--json", "number", "--jq", ".[].number"]);
  if (!prs.ok) return { id: "R-05", level: UNKNOWN, title: "reviewer supply", lines: ["could not list merged PRs"] };
  const numbers = prs.out.split("\n").filter(Boolean).slice(0, 20);

  for (const rev of reviewers) {
    let seen = 0, refused = 0, real = 0;
    for (const n of numbers) {
      const c = gh(`repos/${nwo}/issues/${n}/comments`,
        `[.[]|select(.user.login|test("${rev.login}";"i"))]|length`);
      const rl = gh(`repos/${nwo}/issues/${n}/comments`,
        `[.[]|select((.user.login|test("${rev.login}";"i")) and (.body|test("${rev.refusal}";"i")))]|length`);
      if (c.ok) seen += Number(c.out || 0);
      if (rl.ok) refused += Number(rl.out || 0);
    }
    real = seen - refused;
    const pct = seen ? Math.round((refused / seen) * 100) : 0;
    if (seen === 0) { level = level === BROKEN ? BROKEN : DEGRADED; lines.push(`${rev.login.padEnd(14)} NOT SEEN in ${numbers.length} PRs — declared but silent`); }
    else if (pct >= 80) { level = BROKEN; lines.push(`${rev.login.padEnd(14)} ${refused}/${seen} comments are refusals (${pct}%) — effectively DOWN`); }
    else lines.push(`${rev.login.padEnd(14)} ${real}/${seen} substantive (${pct}% refused)`);
  }
  if (level === BROKEN) lines.push("-> the merge condition must require N REACHABLE reviewers, never N configured");
  return { id: "R-05", level, title: "reviewer supply", lines };
}

/** A lease with no expiry is a claim that outlives its worker. */
function checkLeases(db) {
  if (!db) return { id: "R-06", level: UNKNOWN, title: "leases", lines: ["no state database"] };
  const now = Math.floor(Date.now() / 1000);
  const rows = db.prepare(
    `SELECT id, task_id, lane, status, lease_expires_at, heartbeat_at FROM run
     WHERE status IN ('leased','running','blocked_on_ci','blocked_on_review','awaiting_founder')`
  ).all();
  const expired = rows.filter(r => r.lease_expires_at < now);
  const lines = [`${rows.length} live run(s); ${expired.length} past lease expiry`];
  for (const r of expired.slice(0, 5)) {
    lines.push(`  ${r.task_id} (${r.lane}) expired ${Math.round((now - r.lease_expires_at) / 60)}m ago`);
  }
  if (expired.length) { lines.push("-> reeve lane reap --dry-run"); return { id: "R-06", level: DEGRADED, title: "leases", lines }; }
  return { id: "R-06", level: OK, title: "leases", lines };
}


/**
 * Can the App actually act here?
 *
 * docs/github-app-setup.md has always told the operator to run
 * `reeve doctor <repo> --as-app` and promised it would report the installation
 * id, the granted permissions, and that check-run creation succeeds. The flag was
 * inert and did nothing at all, so the one verification step after a fiddly manual
 * setup silently confirmed nothing. Making the code honour the documented contract
 * is the safer direction of the two.
 *
 * Async because it mints a JWT and exchanges it; the driver stays synchronous and
 * takes the result.
 */
export async function checkAppIdentity(nwo) {
  const { authenticate, checkPermissions } = await import("./github/app.mjs");
  const auth = await authenticate(nwo).catch(e => ({ ok: false, why: e.message }));
  if (!auth.ok) return {
    id: "R-07", level: BROKEN, title: "App identity",
    lines: [String(auth.why).split("\n")[0],
            "-> the verdict cannot be published, so nothing reeve decides can reach GitHub"],
  };

  // Synchronous, and it takes the GRANTED map that authenticate() returns on the
  // installation token -- not the auth object.
  const perms = checkPermissions(auth.permissions ?? {});
  const lines = [`installation ${auth.installationId}`,
                 `repository selection: ${auth.repositorySelection ?? "unknown"}`];

  if (perms.missing.length) {
    for (const m of perms.missing) lines.push(`missing: ${m}`);
    lines.push("-> reinstall the App with these granted, or publishing fails at the moment it matters");
    return { id: "R-07", level: BROKEN, title: "App identity", lines };
  }

  // An over-grant is a finding in its own right, not a convenience. The whole
  // safety argument is that the actuator CANNOT bypass the rules that judge it,
  // and administration:write would hand it exactly that.
  if (perms.excess.length) {
    for (const e of perms.excess) lines.push(`over-granted: ${e}`);
    lines.push("-> reeve is meant to be unable to change the rules that judge it; narrow these");
    return { id: "R-07", level: DEGRADED, title: "App identity", lines };
  }

  lines.push("every required permission granted, and nothing beyond them");
  return { id: "R-07", level: OK, title: "App identity", lines };
}

/**
 * Are the profile's detectors still able to read what the reviewers write?
 *
 * A regex that matches nothing is indistinguishable from a reviewer that found
 * nothing, and CodeRabbit has ALREADY replaced its taxonomy once -- so this is a
 * thing that has happened, not a thing that might.
 *
 * Two failures live here and they are NOT the same, which the first version of
 * this check got wrong by reporting both as broken:
 *
 *   A detector that CANNOT fire -- uncompilable -- is broken now.
 *   A detector that has not fired YET is merely unproven. A P0 marker on a repo
 *   with no P0 findings, or a clean-pass pattern for a reviewer that has never
 *   passed clean, is correct and idle. Calling that broken trains an operator to
 *   ignore the check, which is the failure it exists to prevent.
 *
 * The signal that actually detects rot is the RATIO: how much of a reviewer's
 * finding text no marker could read. Those findings block as critical, so a
 * rotted taxonomy shows up as a repository that stops merging.
 */
function checkDetectors(db, profile) {
  const reviewers = profile?.reviewers ?? [];
  if (!db) return { id: "R-08", level: UNKNOWN, title: "detectors", lines: ["no state database"] };
  if (!reviewers.length) return null;

  let rows;
  try { rows = db.prepare("SELECT source, kind, payload FROM inbox").all(); }
  catch { return { id: "R-08", level: UNKNOWN, title: "detectors", lines: ["inbox is not readable"] }; }
  if (!rows.length) {
    return { id: "R-08", level: UNKNOWN, title: "detectors",
             lines: ["nothing ingested yet — a detector cannot be proven against nothing"] };
  }

  const bodyOf = r => { try { return String(JSON.parse(r.payload)?.body ?? ""); } catch { return ""; } };
  const all = new Map(), findings = new Map();
  for (const r of rows) {
    const body = bodyOf(r);
    if (!body) continue;
    (all.get(r.source) ?? all.set(r.source, []).get(r.source)).push(body);
    // Severity markers classify FINDINGS. Measuring them against trigger comments
    // and carrier reviews made a healthy profile look two-thirds blind.
    if (r.kind === "review_thread") (findings.get(r.source) ?? findings.set(r.source, []).get(r.source)).push(body);
  }

  const lines = [], broken = [], idle = [];
  let unclassified = 0, total = 0;

  for (const rev of reviewers) {
    const texts = all.get(rev.login) ?? [];
    const found = findings.get(rev.login) ?? [];
    if (!texts.length) { lines.push(`${rev.login.padEnd(26)} nothing ingested from this reviewer yet`); continue; }

    const fires = pattern => {
      let rx; try { rx = new RegExp(pattern, "i"); } catch { return -1; }
      return texts.filter(t => rx.test(t)).length;
    };
    const named = [["refusal", rev.refusal], ["clean", rev.clean], ["commitPattern", rev.commitPattern],
                   ...(rev.severityMarkers ?? []).map(([pat], i) => [`severityMarkers[${i}]`, pat])];
    for (const [name, pattern] of named) {
      if (!pattern) continue;
      const n = fires(pattern);
      if (n === -1) broken.push(`${rev.login}.${name} does not compile`);
      else if (n === 0) idle.push(`${rev.login}.${name}`);
    }

    const markers = rev.severityMarkers ?? [];
    if (markers.length && found.length) {
      const hit = found.filter(t => markers.some(([pat]) => {
        try { return new RegExp(pat, "i").test(t); } catch { return false; }
      })).length;
      total += found.length; unclassified += found.length - hit;
      lines.push(`${rev.login.padEnd(26)} ${hit}/${found.length} finding(s) classified`);
    }
  }

  if (idle.length) lines.push(`not yet demonstrated: ${idle.slice(0, 8).join(", ")}${idle.length > 8 ? ` (+${idle.length - 8})` : ""}`);

  if (broken.length) {
    lines.push(...broken.map(b => `-> ${b}`));
    return { id: "R-08", level: BROKEN, title: "detectors", lines };
  }
  if (total && unclassified / total > 0.3) {
    lines.push(`-> ${unclassified} of ${total} findings unreadable; each blocks as critical`);
    lines.push("-> a reviewer's marker grammar has probably changed");
    return { id: "R-08", level: DEGRADED, title: "detectors", lines };
  }
  return { id: "R-08", level: OK, title: "detectors", lines };
}

// ── R-14 / R-15: worker containment ───────────────────────────────────────
//
// Both answer "may this host dispatch a worker under --execute": the daemon
// refuses until the sandbox canary has passed under the CLI it would launch
// AND the login keychain holds no GitHub credential. The doctor reports the
// same two facts from the same sources, so that a refusal in the log can be
// read here without the daemon.

/** The last sandbox canary this daemon recorded, if any. */
export function checkCanary(nwo, { stateDir = null, read = readCanaryState, now = () => Date.now() } = {}) {
  const id = "R-14", title = "worker sandbox canary";
  if (!stateDir) return { id, level: UNKNOWN, title, lines: ["no state directory to read the canary from"] };
  const st = read(stateDir, nwo);
  if (!st) return { id, level: UNKNOWN, title, lines: [`no canary has been recorded for ${nwo}`,
    "the daemon runs one before its first dispatch under --execute; until then every dispatch is refused"] };
  const age = typeof st.at === "number" ? Math.floor((now() - st.at) / 60_000) : null;
  const when = age === null ? "at an unknown time" : age < 1 ? "under a minute ago" : `${age} min ago`;
  if (st.ok !== true) return { id, level: BROKEN, title, lines: [`the last canary FAILED ${when} under ${st.cliVersion ?? "?"}: ${st.why ?? "no reason recorded"}`,
    "the daemon refuses every dispatch under --execute until a canary passes; it re-runs one on the next tick that wants a worker"] };
  return { id, level: OK, title, lines: [`canary ${st.id ?? "?"} passed ${when} under ${st.cliVersion ?? "?"}`,
    "network, outside writes and credential-file reads denied; inside and tmp writes allowed"] };
}

/** GitHub credentials in the login keychain, by metadata only. */
export function checkKeychain({ probe = probeKeychain } = {}) {
  const id = "R-15", title = "worker credential reach";
  const kc = probe();
  if (!kc.measured) return { id, level: UNKNOWN, title, lines: [`unmeasured: ${kc.why}`, "an unmeasured keychain keeps dispatch refused"] };
  if (kc.items.length) return { id, level: DEGRADED, title, lines: [
    `the login keychain holds a GitHub credential a sandboxed worker could read: ${kc.items.join("; ")}`,
    "the OS sandbox cannot deny the keychain (securityd is hard-allowed by the runtime's profile), so write-capable",
    "worker dispatch under --execute stays REFUSED until this is closed; observation and review are unaffected",
    "-> run workers as a dedicated user (closes this AND the shared-ref hole), or log gh in with --insecure-storage",
    "   and delete the git osxkeychain internet-password item for github.com (closes the keychain only)",
  ] };
  return { id, level: OK, title, lines: ["no GitHub credential in the login keychain; file credentials are deny-read by the sandbox"] };
}

// ── driver ────────────────────────────────────────────────────────────────

export function runDoctor({ nwo, profile = {}, db = null, pluginCacheRoot = null, repoPluginDir = null, appCheck = null, baselineIo = {}, stateDir = null, canaryIo = {}, keychainIo = {} }) {
  const checks = [
    checkMergeAuthority(nwo),
    pluginCacheRoot ? checkArtifactDrift(pluginCacheRoot, repoPluginDir) : null,
    checkMergeShape(nwo, profile.merge?.method ?? null),
    checkBaseHealth(nwo, profile.ci?.workflow ?? "ci.yml",
                    profile.identity?.baseBranch ?? profile.identity?.defaultBranch ?? "main"),
    profile.reviewers?.length ? checkReviewerSupply(nwo, profile.reviewers) : null,
    checkLeases(db),
    profile.reviewers?.length ? checkDetectors(db, profile) : null,
    appCheck,
    checkBaseline(nwo, profile, baselineIo),
    checkCanary(nwo, { stateDir, ...canaryIo }),
    checkKeychain(keychainIo),
  ].filter(Boolean);

  const broken = checks.filter(c => c.level === BROKEN);
  const degraded = checks.filter(c => c.level === DEGRADED || c.level === UNKNOWN);
  const verdict = broken.length ? BROKEN : degraded.length ? DEGRADED : OK;
  return { verdict, checks, exitCode: broken.length ? 1 : degraded.length ? 3 : 0 };
}

export function render({ verdict, checks }, nwo) {
  const out = [];
  out.push(`reeve doctor  ${nwo}${" ".repeat(Math.max(1, 48 - nwo.length))}${verdict.toLowerCase()}`);
  for (const level of [BROKEN, DEGRADED, UNKNOWN, OK]) {
    const group = checks.filter(c => c.level === level);
    if (!group.length) continue;
    out.push("", level);
    for (const c of group) {
      out.push(`  ${c.id}  ${c.title}`);
      for (const l of c.lines) out.push(`        ${l}`);
      out.push("");
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
