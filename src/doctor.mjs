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
import { sandboxFor } from "./sandbox.mjs";
import { readCanaryState, policyHashOf } from "./canary.mjs";
import { probeKeychain, isolationTopologyReady, binaryIdentity } from "./containment.mjs";
import { GIT_NEUTRALISE_FOUNDER, founderGitEnv } from "./gitguard.mjs";
import { readOauthToken } from "./workerenv.mjs";
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
// Both answer "may this host dispatch a worker under --execute". The daemon
// refuses until the sandbox canary has passed under the CLI it would launch and
// the policy it would apply, and until the profile declares the isolation reeve
// has actually built. The doctor reads the same facts from the same sources, so
// a refusal in the log can be understood here without the daemon.

/** The last sandbox canary this daemon recorded, if any. */
export function checkCanary(nwo, { stateDir = null, read = readCanaryState, now = () => Date.now(), identity = binaryIdentity, currentPolicyHash = null } = {}) {
  const id = "R-14", title = "worker sandbox canary";
  if (!stateDir) return { id, level: UNKNOWN, title, lines: ["no state directory to read the canary from"] };
  const st = read(stateDir, nwo);
  if (!st) return { id, level: UNKNOWN, title, lines: [`no canary has been recorded for ${nwo}`,
    "the daemon runs one before its first dispatch under --execute; until then every dispatch is refused"] };
  const age = typeof st.at === "number" ? Math.floor((now() - st.at) / 60_000) : null;
  const when = age === null ? "at an unknown time" : age < 1 ? "under a minute ago" : `${age} min ago`;
  if (st.ok !== true) return { id, level: BROKEN, title, lines: [`the last canary FAILED ${when} under ${st.cliVersion ?? "?"}: ${st.why ?? "no reason recorded"}`,
    "the daemon refuses every dispatch under --execute until a canary passes; it re-runs one on the next tick that wants a worker"] };
  // A pass is a pass FOR THE BINARY IT RAN UNDER. The daemon keys containment by
  // the current binary identity, so a replaced executable makes this record
  // historical and the daemon will re-measure; reporting OK from `st.ok` alone
  // would claim a health the daemon does not currently grant. A record that
  // cannot be compared is UNKNOWN, never OK. (Codex #4e-[2].)
  if (!st.bin || !st.binaryId) return { id, level: UNKNOWN, title, lines: [
    `canary ${st.id ?? "?"} passed ${when} under ${st.cliVersion ?? "?"}, but the record names no CLI binary`,
    "so it cannot be checked against the executable in use now; the daemon re-measures before it dispatches"] };
  const live = identity(st.bin);
  if (live !== st.binaryId) return { id, level: DEGRADED, title, lines: [
    `the last canary passed ${when} under a DIFFERENT build of ${st.bin}`,
    `recorded ${st.binaryId}, now ${live} — the daemon re-measures before dispatching under the new one`] };
  // The binary can be unchanged while the POLICY the daemon would generate today
  // has moved (a new deny, a new state root, a changed profile). The daemon keys
  // containment by both, so a record describing an older policy is historical.
  if (!st.policyHash) return { id, level: UNKNOWN, title, lines: [
    `canary ${st.id ?? "?"} passed ${when}, but the record names no sandbox policy`,
    "so it cannot be checked against the policy in force now; the daemon re-measures before it dispatches"] };
  if (currentPolicyHash && currentPolicyHash !== st.policyHash) return { id, level: DEGRADED, title, lines: [
    `the last canary passed ${when} under a DIFFERENT sandbox policy (${st.policyHash}, now ${currentPolicyHash})`,
    "the daemon re-measures before dispatching under the policy in force now"] };
  return { id, level: OK, title, lines: [`canary ${st.id ?? "?"} passed ${when} under ${st.cliVersion ?? "?"}, and the CLI binary is unchanged`,
    "network, outside writes and credential-file reads denied; inside and tmp writes allowed"] };
}

/**
 * Can a worker reach the founder's credentials?
 *
 * The keychain used to BE this check, and used to gate dispatch: a worker ran
 * with the founder's HOME, so it could ask securityd directly, and the OS
 * sandbox cannot deny that (securityd is hard-allowed by the runtime's own
 * profile). "The login keychain holds nothing reeve recognises" was the only
 * proxy available, and it was a weak one -- the probe knows two item shapes and
 * any client can store a token under a third.
 *
 * Workers now run with a scratch HOME. The keychain search list lives in the
 * home directory, so a worker has no login keychain to ask, and the canary
 * (R-14) measures that reach directly, per CLI build and per policy. Evidence
 * about the worker beats a proxy about the host.
 *
 * So the keychain is REPORTED here, not gated on, and the gate is the one thing
 * that still decides: whether the profile declares the isolation reeve built,
 * and whether the worker has a credential of its own to run with.
 */
export function checkKeychain({ probe = probeKeychain, isolation = "none", topologyReady = isolationTopologyReady,
                                token = readOauthToken } = {}) {
  const id = "R-15", title = "worker credential reach";
  // Only the arrangement reeve has actually built counts. "dedicated-user" is
  // stronger, unbuilt, and refused by name rather than silently downgraded.
  const isolated = isolation === "scratch-home" && topologyReady();
  const kc = probe();
  const held = !kc.measured ? `the login keychain is unmeasured (${kc.why})`
    : kc.items.length ? `the login keychain holds a GitHub credential: ${kc.items.join("; ")}`
    : "no GitHub credential under the two conventional keychain items";

  if (!isolated) return { id, level: DEGRADED, title, lines: [
    `${held}, and the OS sandbox cannot deny the keychain (securityd is hard-allowed by the runtime's profile)`,
    `worker.isolation is '${isolation ?? "none"}', so a worker would run with the founder's HOME and could ask for it`,
    "dispatch under --execute stays REFUSED until that changes; observation and review are unaffected",
    "-> set worker.isolation: 'scratch-home' in the profile, and the canary (R-14) then measures the reach per CLI build",
  ] };

  // A scratch HOME also takes ~/.claude away, so the worker authenticates from a
  // token instead. Without one every dispatch fails while preparing the worker
  // and backs off -- a refusal that reads like a broken daemon rather than a
  // missing file, which is exactly the state this command exists to name.
  const tk = token();
  if (!tk.ok) return { id, level: DEGRADED, title, lines: [
    `${held} — and a worker cannot read it: its HOME is reeve's own scratch directory`,
    `but it has no credential of its own to run with: ${tk.why}`,
    "every dispatch under --execute would fail while preparing the worker; observation and review are unaffected",
    "-> run `claude setup-token` and write the token to ~/.reeve/claude-token, mode 600",
  ] };

  return { id, level: OK, title, lines: [
    `${held} — and a worker cannot read it: its HOME is reeve's own scratch directory, so no login keychain is in its search list`,
    "it authenticates from a token of its own instead, and R-14 re-measures that reach per CLI build and policy",
  ] };
}

/**
 * The policy hash the daemon would generate for this profile TODAY, when it can
 * be reconstructed. The canary's own state roots are taken from the record (the
 * daemon may run with a --log or --db this command knows nothing about), so a
 * record without them leaves the comparison unmade rather than wrong.
 */
function currentPolicy(profile, { read = readCanaryState, stateDir = null, nwo = null } = {}) {
  try {
    const st = stateDir && nwo ? read(stateDir, nwo) : null;
    // The state roots are the only inputs this command cannot reconstruct (the
    // daemon may run with a --log or --db it knows nothing about), so they are
    // taken from the record and fed BACK IN — everything else, including the
    // quarantine paths and the notification credential, is generated from the
    // profile as it is now. Overwriting the whole denyRead with the record would
    // have hidden exactly those profile changes. (Codex #4g-[3].)
    if (!Array.isArray(st?.stateRoots) || !st?.canaryDir) return null;
    const policy = sandboxFor({ profile, action: "FIX_CI", worktree: st.canaryDir, tmpDir: "<tmp>", stateRoots: st.stateRoots });
    // The permission rules and the tool grant are half the boundary: the file
    // tools are governed by them alone. A hash over the sandbox block only would
    // call a policy whose rules match nothing identical to one whose rules work,
    // and keep reporting OK from a record taken before the difference.
    return policyHashOf(policy.settings.sandbox, st.canaryDir,
                        { permissionsDeny: policy.settings.permissions.deny, allowedTools: policy.allowedTools });
  } catch { return null; }
}

// ── R-16: can reeve reach the remote it would publish to? ─────────────────
//
// Every other check reads GitHub through `gh`, which carries its own token.
// Publication does not: it is a `git push` from the founder's checkout, and it
// needs whatever that checkout's origin needs -- a credential helper, a URL
// rewrite, an ssh key. Nothing measured any of that, and on 2026-08-22 none of
// it worked: the worker isolation had been applied to the founder's own
// repository, so `ls-remote origin` failed with "could not read Username". Every
// publication reeve would have made was going to fail, and no instrument said so.
//
// The instrument has to ask the CREDENTIAL question, not just the reachability
// one. Measured that day, on the public repository reeve actually watches:
//
//   ls-remote, worker isolation      -> REACHED   (public, so anonymous)
//   credential fill, worker isolation -> REFUSED  ("could not read Username")
//
// A read proves nothing about a push on a public repository. `git credential
// fill` is what a push does to obtain the credential, costs no network write,
// and is the only half that can tell those two apart.

/** git in the founder's own checkout, exactly as `founderGit` runs it. */
function founderRun(cwd, args, { input = null, timeout = 20_000 } = {}) {
  try {
    return { ok: true, out: execFileSync("git", ["-C", cwd, ...GIT_NEUTRALISE_FOUNDER, ...args],
      { encoding: "utf8", stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
        ...(input === null ? {} : { input }), env: founderGitEnv(), timeout }).trim() };
  } catch (e) {
    const line = String(e.stderr || e.message).split("\n").filter(Boolean).pop() ?? "git failed";
    return { ok: false, out: "", err: line.slice(0, 140) };
  }
}

/**
 * Whether a credential can be OBTAINED for this remote's host.
 *
 * `git credential fill` prints the credential on stdout. Nothing is kept: this
 * returns a boolean and git's own error line, never the value, and the reply is
 * not logged, recorded or included in any evidence file.
 */
function founderCredential(cwd, host) {
  const r = founderRun(cwd, ["credential", "fill"], { input: `protocol=https\nhost=${host}\n\n` });
  if (!r.ok) return { ok: false, why: r.err };
  return { ok: r.out.split("\n").some(l => l.startsWith("password=")),
           why: "the helper returned no password for this host" };
}

export function checkRemoteReach(profile, { run = founderRun, credential = founderCredential } = {}) {
  const id = "R-16", title = "publication reach";
  const checkout = profile?.identity?.checkout;
  if (!checkout) return { id, level: UNKNOWN, title,
    lines: ["the profile names no checkout, so there is nothing to publish from"] };

  const url = run(checkout, ["remote", "get-url", "origin"]);
  if (!url.ok || !url.out) return { id, level: BROKEN, title,
    lines: [`no origin in ${checkout}${url.err ? `: ${url.err}` : ""}`,
            "-> reeve publishes by pushing to origin; a checkout without one can publish nothing"] };

  const branch = profile.identity?.defaultBranch ?? "main";
  const reach = run(checkout, ["ls-remote", "origin", `refs/heads/${branch}`]);
  const lines = [`origin ${url.out}`];
  if (!reach.ok) return { id, level: BROKEN, title,
    lines: [...lines, `reeve's git cannot reach it: ${reach.err}`,
            "-> every publication would fail; the reads reeve makes through `gh` are unaffected, so nothing else reports this"] };
  lines.push(`reachable: ${branch} is at ${(reach.out.split(/\s+/)[0] ?? "").slice(0, 10) || "(no such ref)"}`);

  // ssh and local transports authenticate through the transport itself, so the
  // reach above already exercised it. https does not, on a PUBLIC repository.
  const https = /^https:\/\//.test(url.out);
  if (!https) {
    lines.push("the transport carries its own authentication, so the reach above exercised it");
    return { id, level: OK, title, lines };
  }

  const host = url.out.replace(/^https:\/\//, "").split("/")[0].split("@").pop();
  const cred = credential(checkout, host);
  if (!cred.ok) return { id, level: BROKEN, title,
    lines: [...lines,
            `but no credential can be obtained for ${host}: ${cred.why}`,
            ...(profile.identity?.visibility === "public"
              ? ["this repository is PUBLIC, so the read above succeeded anonymously and proves nothing about a push"] : []),
            "-> a push authenticates; reeve would fetch, judge and refuse at the last step"] };
  lines.push(`a credential is available for ${host} (its value is never read into reeve)`);
  return { id, level: OK, title, lines };
}

// ── driver ────────────────────────────────────────────────────────────────

export function runDoctor({ nwo, profile = {}, db = null, pluginCacheRoot = null, repoPluginDir = null, appCheck = null, baselineIo = {}, stateDir = null, canaryIo = {}, keychainIo = {}, reachIo = {} }) {
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
    checkCanary(nwo, { stateDir, currentPolicyHash: currentPolicy(profile, { ...canaryIo, stateDir, nwo }), ...canaryIo }),
    checkKeychain({ isolation: profile.worker?.isolation, ...keychainIo }),
    checkRemoteReach(profile, reachIo),
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
