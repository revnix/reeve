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
import { readCanaryState, policyHashOf, currentInstrument as instrumentInForce } from "./canary.mjs";
import { probeKeychain, isolationTopologyReady, binaryIdentity } from "./containment.mjs";
import { GIT_NEUTRALISE_FOUNDER, founderGitEnv } from "./gitguard.mjs";
import { readOauthToken } from "./workerenv.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, statSync, realpathSync,
         openSync, readSync, closeSync, fstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// The remediation must name the home the token check actually used.
import { resolveHome } from "./home.mjs";
// `hubFindings`'s healthy-snapshot path evaluates HUB_SCHEMA_VERSION; without
// this import that branch throws a ReferenceError on a working installation.
import { HUB_SCHEMA_VERSION } from "./build/hubdb.mjs";

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
/** How a bypass actor is NAMED in a diagnostic.
 *
 * `actor_type` on its own is a CLASS, not an actor: `Team:1` and `Team:2` both
 * render as `Team`, and an operator is then told a bypass exists with no way to
 * check whether it is reeve's. That is the single question the two lines below
 * exist to answer, and for `actor_type: "Integration"` the id IS the App id reeve
 * identifies itself by, so the id is the half that carries the answer.
 *
 * A missing id degrades to the bare type rather than printing a dangling colon:
 * some types genuinely carry none, `OrganizationAdmin` being a class with one
 * member.
 *
 * `baseline.mjs` renders the same field for its ruleset snapshot and deliberately
 * does NOT share this. That string is a stored canonical form; rewording it would
 * move every recorded baseline and report drift where nothing had changed.
 */
const bypassActorName = b =>
  b.actor_id === undefined || b.actor_id === null
    ? String(b.actor_type)
    : `${b.actor_type}:${b.actor_id}`;

export function checkMergeAuthority(nwo, { api = gh } = {}) {
  const lines = [];
  // Whether the BROKEN verdict, if there is one, is about a gate that can be
  // bypassed. A signature rule also breaks the check, for the opposite reason,
  // and the remedy below only makes sense for the first kind.
  let bypassable = false;
  const prot = api(`repos/${nwo}/branches/main/protection`);
  const rules = api(`repos/${nwo}/rulesets`);

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
    if (admins === false) { level = BROKEN; bypassable = true; lines.push("enforce_admins: false — the admin identity is exempt from every rule"); }
    if (contexts.length === 0) { level = BROKEN; bypassable = true; lines.push("no required status checks — nothing CI reports can block a merge"); }
    else lines.push(`required contexts: ${contexts.join(", ")}`);
    if (strict === false) { if (level === OK) level = DEGRADED; lines.push("strict: false — a branch may merge without being up to date with its base"); }
  }

  if (rules.ok) {
    for (const r of JSON.parse(rules.out)) {
      const detail = api(`repos/${nwo}/rulesets/${r.id}`);
      if (!detail.ok) continue;
      const d = JSON.parse(detail.out);
      const bypass = d.bypass_actors ?? [];
      const always = bypass.filter(b => b.bypass_mode === "always");
      if (always.length) {
        level = BROKEN;
        bypassable = true;
        lines.push(`ruleset ${d.name}: bypass_actors allow ${always.map(bypassActorName).join(", ")} to bypass ALWAYS`);
      }
      const hasChecks = (d.rules ?? []).some(x => x.type === "required_status_checks");
      if (!hasChecks) { level = BROKEN; bypassable = true; lines.push(`ruleset ${d.name}: contains no required_status_checks rule at all`); }
      // reeve commits a worker's repair itself, in a checkout whose global and
      // system configuration are /dev/null, so it has no signing key and cannot
      // acquire one without reaching back into the founder's environment -- which
      // is the isolation this design exists to keep. Under this rule every repair
      // is rejected at the push, AFTER a worker run has been paid for. Said here
      // rather than discovered there.
      // Only when the rule can actually reach a repair. A disabled ruleset, one
      // targeting tags, or one scoped to `release/*` governs nothing reeve pushes,
      // and reporting those as BROKEN would condemn a repository that is fine.
      //
      // The branch a repair lands on is a pull request's head, which is not known
      // here, so the test is whether the ruleset covers EVERY branch: `~ALL` is
      // the only condition guaranteed to include whatever head a PR turns up
      // with. A narrower one is reported as a possibility, not a certainty.
      if ((d.rules ?? []).some(x => x.type === "required_signatures")
          && d.enforcement === "active" && (d.target ?? "branch") === "branch") {
        const cond = d.conditions?.ref_name;
        const everyBranch = !cond || ((cond.include ?? []).includes("~ALL") && !(cond.exclude ?? []).length);
        // Whether it actually refuses also depends on the bypass actors this same
        // loop already read: an actuator inside an `always` bypass pushes straight
        // through the rule. Stating a certain refusal where a bypass exists sends
        // an operator after the wrong problem -- and this check earns its place by
        // being read BEFORE a worker run is paid for, so it has to be right.
        const past = always.length ? ` — unless reeve's identity is inside the bypass (${always.map(bypassActorName).join(", ")}), which this check cannot tell` : "";
        if (everyBranch) {
          level = BROKEN;
          lines.push(`ruleset ${d.name}: requires signed commits on every branch, and reeve commits unsigned — every repair it makes will be refused at the push${past}`);
        } else {
          if (level === OK) level = DEGRADED;
          lines.push(`ruleset ${d.name}: requires signed commits on ${(cond.include ?? []).join(", ") || "some branches"} — reeve commits unsigned, so a repair on a branch it covers will be refused at the push${past}`);
        }
      }
    }
  }

  // Only when a bypass or a missing gate caused it. A repository broken solely by
  // a signature rule has the OPPOSITE problem -- its gates hold and reeve cannot
  // get through them -- and telling an operator to remove a bypass there sends
  // them after something that does not exist.
  if (level === BROKEN && bypassable) lines.push("-> every gate written against this repo is decorative until the actuator loses its bypass");
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
/**
 * Did a run execute any step, or none at all?
 *
 * A workflow whose runner never starts reports `conclusion: failure` with zero
 * executed steps, and from the run list alone that is byte-identical to a genuine
 * test failure. They are opposite problems: one says the code is broken, the
 * other says nothing has been measured. Reading the conclusion answers a narrower
 * question than the caller needs, and this repository lost most of a day to that
 * exact reading on its own CI.
 *
 * The step count is the positive signal, and it only exists on the jobs endpoint.
 * Asked ONLY of runs that report failure: a healthy base spends no extra request,
 * and the cost is paid exactly when the answer matters.
 *
 * A jobs read that fails returns null — unknown, which is neither "failed" nor
 * "never ran", because guessing either way is how this defect happened.
 */
export function runExecutedSteps(nwo, runId, io = null) {
  // PAGINATED. The workflow-jobs endpoint defaults to 30 per page, and a matrix
  // run can exceed that easily. Without this, a run whose first thirty jobs
  // executed nothing but whose thirty-first did would be reported as unmeasured —
  // a check that answers from part of its input and reports the part as the whole,
  // which is the exact defect this whole function was written to correct.
  //
  // `--jq` is applied PER PAGE, so an aggregate like this yields one number per
  // page rather than one overall. Measured, not assumed: with per_page=1 against a
  // two-job run it prints "9" then "3". They are summed here.
  const run = io?.sh ?? sh;
  const j = run("gh", ["api", "--paginate", `repos/${nwo}/actions/runs/${runId}/jobs`,
                      "--jq", "[.jobs[].steps | length] | add // 0"]);
  if (!j.ok) return null;
  const perPage = j.out.split("\n").map(l => l.trim()).filter(Boolean).map(Number);
  if (perPage.some(n => !Number.isFinite(n))) return null;
  return perPage.reduce((a2, b) => a2 + b, 0) > 0;
}

/**
 * No gate downstream of a red base can mean anything, and a base that is red for
 * many runs hides whatever breaks next behind an already-red rollup.
 *
 * "Red" and "never ran" are reported separately, because the remedies have
 * nothing in common: one is a bug to fix, the other is infrastructure to restore,
 * and calling the second one a failing base sends somebody to read a diff that is
 * fine.
 */
export function checkBaseHealth(nwo, workflow = "ci.yml", branch = "main", io = null) {
  const run = io?.sh ?? sh;
  const steps = io?.steps ?? runExecutedSteps;
  // COMPLETED RUNS ONLY, because a run that has not finished cannot answer the
  // question and was still counting toward the denominator.
  //
  // `gh run list` returns queued and in-progress runs with an EMPTY conclusion.
  // Nine completed failures beside one running job therefore read as "9 of the
  // last 10" and DEGRADED, when the truth is that every completed run is red and
  // this is BROKEN. The sample was not the sample the caller believed it was.
  //
  // The flag chooses the sample; the filter below refuses a malformed row. That is
  // not two mechanisms for one job — it is a request and a parser, and the parser
  // must not build a denominator out of rows that carry no answer even if the flag
  // one day stops applying.
  const r = run("gh", ["run", "list", "--repo", nwo, "--workflow", workflow, "--branch", branch,
                       "--limit", "10", "--status", "completed", "--json", "conclusion,databaseId",
                       "--jq", ".[] | [.conclusion, (.databaseId|tostring)] | @tsv"]);
  if (!r.ok) return { id: "R-04", level: UNKNOWN, title: "base health", lines: [`could not read ${workflow} runs on ${branch}`] };
  const runs = r.out.split("\n").filter(Boolean).map(l => l.split("\t"))
    // A row with no conclusion has not concluded. It is not a pass, and counting
    // it as one is how a wholly red base reported as merely degraded.
    .filter(([c]) => c && c.trim());
  const reported = runs.filter(([c]) => c === "failure");

  let failed = 0, noStep = 0, unreadable = 0;
  for (const [, id] of reported) {
    const ran = steps(nwo, id);
    if (ran === null) unreadable++;
    else if (ran) failed++;
    else noStep++;
  }

  // TWO SOURCES OF EVIDENCE, AND THEY ANSWER DIFFERENT QUESTIONS.
  //
  // The run LIST says whether anything succeeded. That alone decides whether the
  // base is usable, and it needs no help: a run that concluded failure did not
  // succeed, whatever its steps did.
  //
  // The step reads only explain WHY, and they can be unreadable without changing
  // the first answer. Folding them into the verdict is what produced three
  // successive defects here — an unreadable step read subtracted from an all-red
  // history, and a mix of causes matched no homogeneous test. Both were the same
  // mistake: letting the explanation decide the conclusion.
  const lines = [`${branch}: ${reported.length} of the last ${runs.length} completed ${workflow} runs concluded failure`];
  if (noStep) lines.push(`${noStep} of those executed no steps`);
  if (unreadable) lines.push(`${unreadable} of those could not be read, so why they failed is unknown`);

  if (runs.length > 0 && reported.length === runs.length) {
    // Nothing in this sample succeeded. The wording distinguishes the causes; the
    // verdict does not depend on being able to tell them apart.
    if (noStep === reported.length) {
      lines.push("-> nothing on this branch has been measured; no gate downstream of it means anything");
      lines.push("-> cause is NOT determined here: an exhausted runner quota and a workflow that cannot start look identical from the step count");
    } else if (failed === reported.length) {
      lines.push("-> every PR inherits a red rollup, so a new failure is invisible");
    } else {
      lines.push("-> no completed run in this sample produced a usable result");
    }
    return { id: "R-04", level: BROKEN, title: "base health", lines };
  }
  if (reported.length > 0) return { id: "R-04", level: DEGRADED, title: "base health", lines };
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
/**
 * R-08, exported so the positive control it provides can itself be controlled.
 *
 * A detector reported as demonstrated when it has never fired against the surface
 * it governs is worse than no report: it is the check that exists to catch a
 * changed taxonomy, saying the taxonomy is fine.
 */
/**
 * How many of a reviewer's most recent review bodies the delimiter is judged on.
 *
 * Small enough that a taxonomy change shows up within a handful of reviews, large
 * enough that one body which genuinely contains no findings cannot condemn a
 * working grammar on its own.
 */
const RECENT_BODIES = 10;

export function checkDetectors(db, profile) {
  const reviewers = profile?.reviewers ?? [];
  if (!db) return { id: "R-08", level: UNKNOWN, title: "detectors", lines: ["no state database"] };
  if (!reviewers.length) return null;

  let rows;
  // ORDERED, because one of the detectors below is a claim about the CURRENT
  // grammar rather than about history, and an unordered read cannot tell the two
  // apart. `observed_at` is when reeve first saw that text, so an edited body's
  // new generation sorts after the original.
  try { rows = db.prepare("SELECT source, kind, payload FROM inbox ORDER BY observed_at, id").all(); }
  catch { return { id: "R-08", level: UNKNOWN, title: "detectors", lines: ["inbox is not readable"] }; }
  if (!rows.length) {
    return { id: "R-08", level: UNKNOWN, title: "detectors",
             lines: ["nothing ingested yet — a detector cannot be proven against nothing"] };
  }

  const bodyOf = r => { try { return String(JSON.parse(r.payload)?.body ?? ""); } catch { return ""; } };
  const all = new Map(), findings = new Map(), bodies = new Map();
  for (const r of rows) {
    const body = bodyOf(r);
    if (!body) continue;
    (all.get(r.source) ?? all.set(r.source, []).get(r.source)).push(body);
    // Severity markers classify FINDINGS. Measuring them against trigger comments
    // and carrier reviews made a healthy profile look two-thirds blind.
    if (r.kind === "review_thread") (findings.get(r.source) ?? findings.set(r.source, []).get(r.source)).push(body);
    // Review BODIES, kept apart from everything else. `bodyFindings` delimits ONE
    // surface, and codex uses the same severity badge in inline comments -- so
    // measuring it against every ingested text lets a match in a THREAD report the
    // body grammar as demonstrated. The positive control then passes without the
    // thing it controls ever having fired.
    if (r.kind === "review") (bodies.get(r.source) ?? bodies.set(r.source, []).get(r.source)).push(body);
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

    // `bodyFindings` is measured against review BODIES alone, never `texts`, and
    // against RECENT ones rather than all of them. `false` is a declaration rather
    // than a pattern and has nothing to fire.
    //
    // Two different mistakes, and the second is the one that outlives the first.
    // Scanning every text let a badge in an inline comment vouch for the body
    // grammar. Scanning every BODY ever ingested then let one match from months
    // ago vouch for it for ever -- and this detector has no miss ratio to give it
    // away, because a body the delimiter cannot parse produces no findings rather
    // than an unclassified one. The taxonomy here has already been replaced
    // wholesale once: the strings a previous audit recorded appear zero times in
    // forty current bodies. A check that cannot notice that happening again is not
    // worth running.
    if (typeof rev.bodyFindings === "string") {
      const bodyTexts = bodies.get(rev.login) ?? [];
      const recent = bodyTexts.slice(-RECENT_BODIES);
      let rx = null; try { rx = new RegExp(rev.bodyFindings, "i"); } catch { rx = null; }
      if (!rx) broken.push(`${rev.login}.bodyFindings does not compile`);
      else if (!recent.length) lines.push(`${rev.login.padEnd(26)} no review bodies ingested yet — bodyFindings unproven`);
      else {
        const hit = recent.filter(t => rx.test(t)).length;
        lines.push(`${rev.login.padEnd(26)} ${hit}/${recent.length} recent review body/bodies parsed by bodyFindings`);
        // Idle on the RECENT window, so a grammar that has stopped matching shows
        // up here however long it worked before.
        if (hit === 0) idle.push(`${rev.login}.bodyFindings`);
      }
    }

    // An UNDECLARED reviewer is worth saying out loud, because its consequence is
    // silent: the fold marks the whole pull request's body-finding count as
    // possibly short, and the critical count stops being usable for every pull
    // request this reviewer touches -- not just the ones where it wrote a body.
    if (!(typeof rev.bodyFindings === "string" || rev.bodyFindings === false))
      lines.push(`${rev.login.padEnd(26)} bodyFindings undeclared — the critical count cannot be complete`);

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
export function checkCanary(nwo, { stateDir = null, read = readCanaryState, now = () => Date.now(), identity = binaryIdentity, currentPolicyHash = null, currentInstrument = instrumentInForce() } = {}) {
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
  // And the INSTRUMENT. A record can carry the same binary and the same policy
  // and still describe a weaker measurement, because the canary script itself
  // changed -- which is the whole reason the instrument is in the id. The
  // daemon's in-memory cache notices on its next run, but doctor reads the
  // PERSISTED record, and a record written before this comparison existed has no
  // instrument to compare at all. Neither is OK: a measurement that cannot be
  // matched to today's instrument is UNKNOWN.
  if (!st.instrument) return { id, level: UNKNOWN, title, lines: [
    `canary ${st.id ?? "?"} passed ${when}, but the record names no instrument`,
    "so it cannot be checked against the canary script in use now; the daemon re-measures before it dispatches"] };
  if (currentInstrument && currentInstrument !== st.instrument) return { id, level: DEGRADED, title, lines: [
    `the last canary passed ${when} under a DIFFERENT canary script (${st.instrument}, now ${currentInstrument})`,
    "an older instrument proves less than the one being asked for; the daemon re-measures before dispatching"] };
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
    // THE PATH THAT WAS CHECKED, not the default one. Once `readOauthToken`
    // followed the resolved home, this instruction pointed somewhere the check
    // had not looked -- so an operator under `--home` or a custom REEVE_HOME
    // could follow it exactly and stay degraded, with every --execute dispatch
    // still unable to authenticate.
    `-> run \`claude setup-token\` and write the token to ${tk.path ?? join(resolveHome(), "claude-token")}, mode 600`,
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
/**
 * The launchd job as INSTALLED, or null when nothing is installed to read.
 *
 * Deliberately the file in LaunchAgents rather than the repository's
 * `deploy/com.revnix.reeve.plist`. The repo copy records what someone meant to
 * install; this one is what launchd executes, and macOS rewrites it on load --
 * measured 2026-09-02, the installed copy had the same values in a different key
 * order with every comment stripped.
 *
 * On a machine with no launchd this returns null, and the caller reports UNKNOWN
 * rather than OK: "no job is installed" and "the job is fine" must not be the
 * same answer. reeve is meant to run on Linux and Windows too, where the
 * supervisor is not launchd; until this rule learns those, saying so plainly is
 * the honest reading rather than a silent pass.
 */
/** What launchd currently holds for the job, or null when it holds nothing. */
function readLoadedJob() {
  try {
    return execFileSync("launchctl", ["print", `gui/${process.getuid()}/com.revnix.reeve`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
  } catch { return null; }
}

/**
 * The commit the RUNNING daemon loaded, from its own startup record.
 *
 * Scanned backward in a growing window: the log is append-only and unrotated, so
 * reading it whole is unbounded, and a fixed tail is not the fix either -- the
 * last start can be older than any window you pick.
 */
function daemonStartupCommit(path = join(resolveHome(), "reeve.log")) {
  let fd = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    for (let window = Math.min(256 * 1024, size); ; window = Math.min(window * 4, size)) {
      const buf = Buffer.alloc(window);
      readSync(fd, buf, 0, window, size - window);
      const hits = [...buf.toString("utf8").matchAll(/running commit ([0-9a-f]{7,40})/g)];
      if (hits.length) return hits[hits.length - 1][1];
      if (window >= size || window >= 64 * 1024 * 1024) return null;
    }
  } catch { return null; } finally { if (fd !== null) try { closeSync(fd); } catch { /* gone */ } }
}

function readInstalledPlist(path = join(homedir(), "Library", "LaunchAgents", "com.revnix.reeve.plist")) {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

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
 * Whether a credential can be OBTAINED for this remote.
 *
 * Asked with `url=`, the whole target, rather than protocol and host. With
 * `credential.useHttpPath` set -- which is how a founder keeps separate
 * credentials for repositories on one host -- a host-only question is not the
 * question a push asks. Measured 2026-08-23 against a helper that records what
 * git asked it:
 *
 *   protocol+host      -> git asks without a path, a HOST-WIDE credential answers
 *   url=.../two.git    -> git asks with path=two.git, and nothing answers
 *
 * So the host-only form reports a credential is available while the real
 * path-qualified push has none. `url=` also carries the port and any username.
 *
 * `git credential fill` prints the credential on stdout. Nothing is kept: this
 * returns a boolean and git's own error line, never the value, and the reply is
 * not logged, recorded, or included in any evidence file.
 */
export function founderCredential(cwd, url, { run = founderRun } = {}) {
  // `capability[]=authtype` is advertised, because a helper that negotiates it
  // answers with `authtype=Bearer` and `credential=...` INSTEAD of a password,
  // and git forms the Authorization header from those. A password-only test
  // calls that a missing credential.
  //
  // Measured 2026-08-23 on git 2.50.1 (Apple Git-155): this build does not
  // support the capability -- a helper returning those fields has them
  // discarded -- so the case is not reproducible here and this is forward
  // insurance rather than a fixed defect. Unknown input keys are tolerated
  // silently on that build (exit 0, no warning), but 2.43 on Ubuntu LTS cannot
  // be tested from here, so a call that FAILS is retried without the line. A
  // git that rejects the key gets the plain question rather than a wrong BROKEN.
  let r = run(cwd, ["credential", "fill"], { input: `capability[]=authtype\nurl=${url}\n\n` });
  if (!r.ok) r = run(cwd, ["credential", "fill"], { input: `url=${url}\n\n` });
  if (!r.ok) return { ok: false, why: r.err };
  // `credential=` is as much an answer as `password=`. Neither value is read.
  return { ok: r.out.split("\n").some(l => l.startsWith("password=") || l.startsWith("credential=")),
           why: "the credential helpers returned no password or credential for it" };
}

/**
 * HTTP authentication configured somewhere other than a credential helper.
 *
 * `http.<url>.extraHeader` carrying an Authorization header, and
 * `http.<url>.cookieFile`, are both used by `ls-remote` and by the real push
 * while `git credential fill` knows nothing about them. `--get-urlmatch` is
 * git's own resolution for per-url http config: measured 2026-08-23, it exits 0
 * for a url the section matches and 1 for one it does not.
 *
 * Only the KEY is returned. The value is an Authorization header or a path to a
 * cookie jar, so it is never returned, printed or recorded — the same rule the
 * credential itself gets.
 */
/**
 * Per-url http settings that mean authentication is arranged somewhere `git
 * credential fill` cannot see. Any non-empty value counts.
 *
 * `sslCert` is here without a reviewer having asked: a client certificate is an
 * authentication mechanism exactly as the other two are, and this is the third
 * round in which one of these was found missing. The list is incomplete BY
 * NATURE -- git keeps adding ways to authenticate -- so what matters is which
 * way its incompleteness errs. A mechanism missing from it turns a working
 * checkout BROKEN, which is loud and wrong; a mechanism wrongly in it turns a
 * broken checkout DEGRADED, which is quiet and wrong. Neither is good, and the
 * first is the recoverable one, so the list stays explicit rather than becoming
 * "any http.* key at all" -- `http.postBuffer` says nothing about authentication
 * and would suppress a real refusal.
 */
const HTTP_AUTH_VALUE_KEYS = ["http.extraHeader", "http.cookieFile", "http.sslCert"];

/**
 * And one that is a BOOLEAN, which is not the same question.
 *
 * `http.emptyAuth` tells git to attempt authentication without seeking a
 * username or password -- Kerberos and GSS-Negotiate -- so a push succeeds where
 * `credential fill` returns nothing. But measured 2026-08-23, `--get-urlmatch`
 * returns `false` with EXIT 0 for a url configured `emptyAuth = false`:
 *
 *   http.emptyAuth  https://enterprise.example/o/r.git -> [true]  exit=0
 *   http.emptyAuth  https://other.example/x.git        -> [false] exit=0
 *   http.emptyAuth  https://nowhere.example/x.git      -> []      exit=1
 *
 * Reading presence rather than value would take configuration that says the
 * OPPOSITE as evidence for it, and suppress a refusal that is real.
 */
const HTTP_AUTH_FLAG_KEYS = ["http.emptyAuth"];

/**
 * The founder's netrc, if they have one. Read for one question only -- whether
 * it has an entry for a host -- and no token from it is ever returned.
 *
 * `_netrc` as well as `.netrc`, because reeve has to run on Windows and that is
 * the name curl looks for there.
 */
function readNetrcFile() {
  for (const name of [".netrc", "_netrc"]) {
    try { return readFileSync(join(homedir(), name), "utf8"); } catch { /* the next one, or none */ }
  }
  return "";
}

/**
 * Does the netrc name this host?
 *
 * Tokens are whitespace-separated. `default` matches any host, which is the
 * whole point of it. A `machine` token inside a `macdef` body could match
 * spuriously -- that direction is harmless here, since the consequence is
 * reporting a credential as UNVERIFIED rather than as absent.
 */
function netrcNames(text, host) {
  const bare = String(host ?? "").split(":")[0];
  if (!bare) return false;
  // Quotes come off: curl permits a double-quoted field, and measured
  // 2026-08-23 against a 401 Basic server, `machine "127.0.0.1"` authenticates
  // exactly as the unquoted form does. Comparing the raw token missed it and
  // reported a working checkout BROKEN.
  const unquote = t => (t.startsWith('"') && t.endsWith('"') && t.length > 1 ? t.slice(1, -1) : t);
  const toks = String(text ?? "").split(/\s+/).filter(Boolean).map(unquote);
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] === "default") return true;
    if (toks[i] === "machine" && (toks[i + 1] === bare || toks[i + 1] === host)) return true;
  }
  return false;
}

/**
 * HTTP authentication configured somewhere other than a credential helper.
 *
 * The keys above and `~/.netrc` are all used by `ls-remote` and by the real push
 * while `git credential fill` knows nothing about them. `--get-urlmatch` is
 * git's own resolution for the config ones: measured 2026-08-23, it exits 0 for
 * a url the section matches and 1 for one it does not.
 *
 * netrc is not git configuration at all -- git hands libcurl `CURL_NETRC_
 * OPTIONAL` and curl reads the file itself. Measured 2026-08-23 on git 2.50.1
 * against a local server issuing a 401 Basic challenge:
 *
 *   no netrc              -> exit 128, no Authorization header sent
 *   with a matching netrc -> exit 0, Authorization header SENT
 *   credential fill       -> exit 128, no password
 *
 * Worth recording that it did NOT reproduce against GitHub over https, where
 * git's own credential lookup fails first and the request is never made. So the
 * exposure is real and narrower than the general case: it needs a server that
 * answers with a challenge rather than one git pre-empts. (Codex #14-[15].)
 *
 * Only the KEY, or the name of the file, is returned. The values are an
 * Authorization header, a cookie jar and a password file, and they get the same
 * treatment as the credential itself.
 */
function httpAuthElsewhere(run, cwd, url, { netrc = readNetrcFile } = {}) {
  for (const key of HTTP_AUTH_VALUE_KEYS) {
    const r = run(cwd, ["config", "--get-urlmatch", key, url]);
    if (r.ok && r.out) return key;
  }
  for (const key of HTTP_AUTH_FLAG_KEYS) {
    const r = run(cwd, ["config", "--type=bool", "--get-urlmatch", key, url]);
    if (r.ok && r.out === "true") return key;
  }
  if (netrcNames(netrc(), hostOf(url))) return "~/.netrc";
  return null;
}

/** The authority of an http(s) url, without any userinfo. */
const hostOf = url => String(url).replace(/^https?:\/\//, "").split("/")[0].split("@").pop();

/**
 * A remote URL with its userinfo removed, for printing.
 *
 * `git remote get-url` EXPANDS `url.<base>.insteadOf`, so a rewrite pointing at
 * a credential-bearing URL hands one straight back. Measured 2026-08-23: a
 * rewrite to `https://user:s3cr3t-token@example.com/` made `get-url` return that
 * URL verbatim, token included, and this check prints the URL in its report and
 * its `--json`. Only the part before `@` in an authority is removed; an
 * scp-style `git@host:path` has no authority and is left alone.
 */
const withoutUserinfo = url => String(url).replace(/^([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/)[^/@]*@/, "$1[redacted]@");

export function checkRemoteReach(profile, { run = founderRun, credential = founderCredential, netrc = readNetrcFile } = {}) {
  const id = "R-16", title = "publication reach";
  const checkout = profile?.identity?.checkout;
  if (!checkout) return { id, level: UNKNOWN, title,
    lines: ["the profile names no checkout, so there is nothing to publish from"] };

  const fetchUrl = run(checkout, ["remote", "get-url", "origin"]);
  if (!fetchUrl.ok || !fetchUrl.out) return { id, level: BROKEN, title,
    lines: [`no origin in ${checkout}${fetchUrl.err ? `: ${fetchUrl.err}` : ""}`,
            "-> reeve publishes by pushing to origin; a checkout without one can publish nothing"] };
  // EVERY push url. `git push origin` affects all configured `remote.origin.
  // pushurl` values, and `get-url --push` returns only the first — measured, two
  // pushurls give one value without `--all` and both with it. Each destination
  // gets its own CREDENTIAL question below, so reading only the first would
  // report OK on the strength of a credential for somewhere else.
  // `--push --all` falls back to the fetch url when no pushurl is set, which is
  // git's own behaviour.
  const pushed = run(checkout, ["remote", "get-url", "--push", "--all", "origin"]);
  const pushUrls = (pushed.ok && pushed.out ? pushed.out.split("\n") : [fetchUrl.out]).map(u => u.trim()).filter(Boolean);
  const separate = pushUrls.length > 1 || pushUrls[0] !== fetchUrl.out;

  // An explicitly EMPTY pushurl, read from the configuration rather than from
  // the resolved list -- because the resolved list is exactly where the two
  // gits agree. Measured 2026-08-23 on git 2.50.1: an empty value is dropped,
  // `get-url --push --all` shows only the remaining url, and a real push
  // succeeds. A reviewer reports git 2.43 instead exiting 128 with "no path
  // specified", and 2.43 is what Ubuntu LTS ships, so it is a git reeve has to
  // run on. Either way the configuration is wrong; only its consequence moves.
  // `-z`, because `--get-all` alone loses an empty value to the trim.
  const configured = run(checkout, ["config", "-z", "--get-all", "remote.origin.pushurl"]);
  if (configured.ok && configured.out.split("\0").slice(0, -1).some(v => v.trim() === "")) return { id, level: BROKEN, title,
    lines: [`origin ${withoutUserinfo(fetchUrl.out)}`,
            "remote.origin.pushurl is configured with an EMPTY value",
            "git 2.50.1 ignores it and pushes to the remaining url; git 2.43 fails the push with `no path specified`",
            "-> whichever git is in front of it, the configuration does not say where to publish"] };

  // Nothing left to publish to. `filter(Boolean)` above drops a value that was
  // only whitespace, and if that took the last one the loop below would run zero
  // times and the check would report OK having asked nothing — an absence read
  // as success, from the one direction the empty-value guard does not cover.
  if (!pushUrls.length) return { id, level: BROKEN, title,
    lines: [`origin ${withoutUserinfo(fetchUrl.out)}`,
            "origin resolves to no push destination at all",
            "-> reeve publishes by pushing to origin; there is nowhere for that to go"] };

  // A MIRROR remote refuses the only kind of push reeve makes. `publishRunWork`
  // always names an explicit refspec, and `remote.<name>.mirror` makes a push
  // behave as `--mirror`, which git will not combine with one. Measured
  // 2026-08-23:
  //
  //   $ git config remote.origin.mirror true
  //   $ git push origin HEAD:refs/heads/main
  //   fatal: --mirror can't be combined with refspecs
  //
  // and the same push without the setting succeeds. So every publication fails,
  // for a reason no credential or reachability probe can see. (Codex #14-[18].)
  const mirror = run(checkout, ["config", "--type=bool", "--get", "remote.origin.mirror"]);
  if (mirror.ok && mirror.out === "true") return { id, level: BROKEN, title,
    lines: [`origin ${withoutUserinfo(fetchUrl.out)}`,
            "remote.origin.mirror is set, so a push to origin behaves as --mirror",
            "reeve publishes with an explicit refspec, and git refuses that combination outright",
            "-> every publication would fail with `--mirror can't be combined with refspecs`"] };

  const branch = profile.identity?.defaultBranch ?? "main";
  const lines = [`origin ${withoutUserinfo(fetchUrl.out)}`];
  if (separate) lines.push(`push url(s) ${pushUrls.map(withoutUserinfo).join(", ")}`);

  // Through `origin`, never through a literal url: this is the one probe that
  // carries origin's whole configuration, which is what reeve's own fetch uses.
  // Why the push destinations get no probe of their own is below.
  const reach = run(checkout, ["ls-remote", "origin", `refs/heads/${branch}`]);
  if (!reach.ok) return { id, level: BROKEN, title,
    lines: [...lines, `reeve's git cannot reach it: ${reach.err}`,
            "-> every publication would fail; the reads reeve makes through `gh` are unaffected, so nothing else reports this"] };
  lines.push(`reachable: ${branch} is at ${(reach.out.split(/\s+/)[0] ?? "").slice(0, 10) || "(no such ref)"}`);

  // A push url of its own is NOT probed for reachability, deliberately.
  //
  // `ls-remote <the literal url>` answers a different question from the one
  // publication asks: it drops every remote-scoped setting. Measured 2026-08-23
  // against this repository with an unreachable `remote.origin.proxy`:
  //
  //   ls-remote origin    -> fatal: Failed to connect to 127.0.0.1 port 1
  //   ls-remote <the same url literally> -> e41cd287e2  (the proxy bypassed)
  //
  // So the literal probe can report BROKEN for a checkout that publishes, and
  // report reachable for one that cannot. Making it faithful means reproducing
  // git's own remote resolution -- `remote.<name>.proxy`, `uploadpack`, `vcs`,
  // and whatever the next version adds -- and this is the third round of
  // findings against that probe. The reading is removed rather than tuned; what
  // it was reaching for is stated as not established instead.
  //
  // `ls-remote origin` above still exercises origin's full configuration, which
  // is what reeve's own fetch uses. The credential question below needs no
  // network and no proxy, so it is asked per destination as before.
  const unverified = [], unproven = [];
  for (const url of pushUrls) {
    const shown = withoutUserinfo(url);
    // ssh and local transports authenticate through the transport itself -- but
    // "the reach above exercised it" is only true when the reach WENT there.
    // `ls-remote origin` uses the FETCH url, so an https fetch beside an ssh
    // push url means the ssh transport was never touched: an anonymous public
    // fetch plus an ssh push with no usable key reported healthy. That claim was
    // written while the push destination still had a probe of its own, and
    // survived the round that removed it. (Codex #14-[13].)
    //
    // http and https never authenticate on a read of a PUBLIC repository, so
    // they take the credential path whether or not they are the fetch url --
    // git's credential subsystem covers both schemes.
    if (!/^https?:\/\//.test(url)) {
      // For READING. `ls-remote` speaks to git-upload-pack and a push speaks to
      // git-receive-pack, so a read-only deploy key answers the first and
      // refuses the second — the reach establishes the transport works, not
      // that it may write. (Codex #14-[21].)
      if (url === fetchUrl.out) { unproven.push(shown); lines.push(`${shown} carries its own authentication, and the reach above exercised it for READING`); }
      else { unverified.push(shown); lines.push(`${shown} carries its own authentication, which the reach above did NOT exercise: it went to the fetch url`); }
      continue;
    }
    unproven.push(shown);
    const cred = credential(checkout, url);
    // OBTAINED, not validated. `git credential fill` gets the fields from the
    // helpers; it does not present them to the server, so an expired, revoked,
    // wrong-account or read-only token answers exactly as a working one does.
    // Said in the line rather than only in the docs, because a reader takes OK
    // to mean publication works. (Codex #14-[11].)
    if (cred.ok) { lines.push(`a credential is obtained for ${shown}, though not validated against the server (its value is never read into reeve)`); continue; }
    // A credential helper is not the only way http authenticates. `http.
    // <url>.extraHeader` carrying an Authorization header, and a cookie file,
    // are both used by `ls-remote` and by the real push while `credential fill`
    // knows nothing about them — so reporting BROKEN on the helper's silence
    // alone calls a working checkout broken. What reeve can say is that it
    // cannot verify this one, which is neither of the two confident answers.
    const elsewhere = httpAuthElsewhere(run, checkout, url, { netrc });
    if (elsewhere) { unverified.push(shown); lines.push(`${shown} authenticates through ${elsewhere}, which this check cannot verify`); continue; }
    return { id, level: BROKEN, title,
      lines: [...lines,
              `but no credential can be obtained for ${shown}: ${cred.why}`,
              ...(profile.identity?.visibility === "public"
                ? ["this repository is PUBLIC, so the read above succeeded anonymously and proves nothing about a push"] : []),
              "-> a push authenticates; reeve would fetch, judge and refuse at the last step"] };
  }
  if (separate) lines.push("the push destination(s) are not probed for reachability: a literal-url probe drops remote.origin.proxy and answers a different question");
  // One statement for every destination, whatever its transport. An https
  // credential is obtained rather than validated; an ssh key answered the READ
  // service. Neither says a push would be accepted, and both were previously
  // claimed as though they did.
  if (unproven.length) lines.push(`-> not established: whether a PUSH to ${unproven.join(", ")} would be accepted — ` +
    "`ls-remote` speaks to git-upload-pack and a push to git-receive-pack, so a read-only key or token answers the read and refuses the write, and nothing here can tell them apart without pushing");
  if (unverified.length) return { id, level: DEGRADED, title,
    lines: [...lines, `-> publication to ${unverified.join(", ")} rests on configuration this check cannot exercise without pushing`] };
  return { id, level: OK, title, lines };
}


// ── R-17: what code is the daemon actually running? ───────────────────────
//
// STALE BY ACCIDENT AND PINNED ON PURPOSE LOOKED IDENTICAL FROM OUTSIDE, and that
// ambiguity is the defect this answers. Measured 2026-09-02: the launchd job was
// running a commit from three days and 43 merges earlier, and establishing that
// took reading the plist, grepping the daemon for update logic that does not
// exist, and comparing two checkouts by hand. Nothing reported it, because
// nothing was asking.
//
// THREE FACTS, AND THEY DISAGREE. Review found the first version conflating them:
//
//   the LOADED job      what launchd is running now. launchd caches its
//                       configuration at bootstrap, so an edited plist does not
//                       reach a job until it is reloaded.
//   the INSTALLED plist what the NEXT load will use. Read second, and a
//                       difference between the two is itself the finding.
//   the checkout HEAD   what the next START would load -- not what the running
//                       process holds, which is whatever it read at startup.
//                       Pulling the checkout moves the tree, not the process.
//
// Reporting HEAD alone let a clean checkout certify a daemon executing an older
// commit. The daemon records `running commit <sha>` at startup; that is the only
// evidence of what the live process actually loaded.

const XML_ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };

/** A plist string node's real value. `&` is escaped in any valid plist. */
export function decodeXml(text) {
  return String(text ?? "").replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]);
}

/**
 * The checkout a `.../bin/reeve` argument implies, or null if none does.
 *
 * The entry point is RESOLVED first: launchd may invoke a symlink such as
 * `/usr/local/bin/reeve` whose target lives in the checkout, and stripping the
 * textual path would name `/usr/local` and report BROKEN for a healthy tree.
 */
export function checkoutFromArgs(args, { realpath = (p) => realpathSync(p) } = {}) {
  const bin = (args ?? []).find(a => typeof a === "string" && /(^|\/)bin\/reeve$/.test(a));
  if (!bin) return null;
  let resolved = bin;
  try { resolved = realpath(bin); } catch { /* not on this machine; the textual path is all there is */ }
  return /(^|\/)bin\/reeve$/.test(resolved) ? resolved.replace(/\/bin\/reeve$/, "") : bin.replace(/\/bin\/reeve$/, "");
}

/** ProgramArguments from a launchd plist, decoded. */
export function programArguments(plistText) {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plistText ?? "");
  if (!block) return null;
  return [...block[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map(m => decodeXml(m[1].trim()));
}

/** ProgramArguments as launchd currently holds them, from `launchctl print`. */
export function loadedArguments(printOut) {
  const block = /arguments\s*=\s*\{([\s\S]*?)\n\s*\}/.exec(String(printOut ?? ""));
  if (!block) return null;
  return block[1].split("\n").map(l => l.trim()).filter(Boolean);
}

export function checkDaemonProvenance({ run = founderRun, plist = readInstalledPlist,
                                        launchctl = null, runningCommit = () => null,
                                        defaultBranch = "main" } = {}) {
  const id = "R-17", title = "daemon code provenance";
  const printed = launchctl ? launchctl() : null;
  const loaded = printed === null ? null : loadedArguments(printed);
  const text = plist();
  if (text === null && loaded === null) return { id, level: UNKNOWN, title,
    lines: ["no launchd job is installed for reeve on this machine, and none is loaded",
            "-> nothing runs the guardian here, so there is no code to account for"] };

  const declared = programArguments(text);
  // THE LOADED JOB WINS, because it is what is executing. The plist is what the
  // next load will use, and a difference between them is a finding of its own.
  const args = loaded ?? declared;
  if (!args) return { id, level: UNKNOWN, title,
    lines: ["the launchd job declares no ProgramArguments and none could be read from launchctl",
            "-> what launchd executes cannot be read, so neither can the commit"] };

  const root = checkoutFromArgs(args);
  if (!root) return { id, level: UNKNOWN, title,
    lines: [`the launchd job runs ${args.join(" ") || "(nothing)"}`,
            "none of its arguments resolves to a path ending in bin/reeve",
            "-> the daemon is started some other way, and this rule cannot say from where"] };

  const lines = [`launchd runs reeve from ${root}`];
  const declaredRoot = declared ? checkoutFromArgs(declared) : null;
  if (loaded && declaredRoot && declaredRoot !== root)
    lines.push(`the INSTALLED plist names ${declaredRoot} instead -- the job has not been reloaded since it was edited`);

  const head = run(root, ["rev-parse", "HEAD"]);
  if (!head.ok) return { id, level: BROKEN, title,
    lines: [...lines, `that path is not a readable git checkout${head.err ? `: ${head.err}` : ""}`,
            "-> the guardian would enforce rules from code with no commit behind it"] };
  // NOT "promoted": nothing on this machine records a promotion, and the first
  // version of this line called every readable HEAD a promoted commit -- including
  // a checkout that is merely behind because nobody pulled.
  lines.push(`checkout commit ${head.out.slice(0, 10)}`);

  // WHAT THE LIVE PROCESS LOADED, which is not HEAD. A running Node process holds
  // the modules it read at startup, so a checkout pulled afterwards reports a
  // clean current commit while the daemon executes an older one.
  const started = runningCommit();
  if (started === null) lines.push("what the RUNNING process loaded is unknown: no startup record was readable");
  else if (!head.out.startsWith(started) && !started.startsWith(head.out.slice(0, started.length)))
    return { id, level: DEGRADED, title,
      lines: [...lines, `but the running process loaded ${started}, which is not this checkout's HEAD`,
              "-> the tree moved after the daemon started; restart it to run the code that is here"] };
  else lines.push(`and the running process loaded ${started}`);

  // A FAILED STATUS PROBE IS NOT A CLEAN TREE. `rev-parse` and `rev-list` can
  // succeed with an unreadable index, so falling through here would let the rule
  // return OK having never established whether the executable tree is clean.
  const dirty = run(root, ["status", "--porcelain"]);
  if (!dirty.ok) return { id, level: UNKNOWN, title,
    lines: [...lines, `could not read whether the tree is clean${dirty.err ? `: ${dirty.err}` : ""}`,
            "-> the commit above names a tree nobody has confirmed is the tree on disk"] };
  if (dirty.out) return { id, level: BROKEN, title,
    lines: [...lines, `the tree has ${dirty.out.split("\n").length} uncommitted change(s)`,
            "-> what runs is not that commit and is not any commit; nobody can say what it is"] };

  // THE TRACKING REF MAY PREDATE THE MERGE. `rev-list origin/<branch>..HEAD`
  // reads a LOCAL ref, so a checkout that has not fetched since its commit landed
  // upstream would be reported as carrying commits the branch has never seen --
  // this rule's most alarming verdict, on reviewed code.
  const localRef = run(root, ["rev-parse", `origin/${defaultBranch}`]);
  const liveRef = run(root, ["ls-remote", "origin", `refs/heads/${defaultBranch}`]);
  const live = liveRef.ok ? (liveRef.out.split(/\s+/)[0] ?? "") : "";
  if (!localRef.ok || !live) return { id, level: UNKNOWN, title,
    lines: [...lines, `cannot resolve origin/${defaultBranch} to compare against${liveRef.err ? `: ${liveRef.err}` : ""}`,
            `-> until that resolves, whether this commit is on origin/${defaultBranch} is unknown`] };
  if (localRef.out !== live) return { id, level: UNKNOWN, title,
    lines: [...lines, `this checkout's origin/${defaultBranch} is ${localRef.out.slice(0, 10)} but the remote is at ${live.slice(0, 10)}`,
            `-> fetch in ${root} and re-run; comparing against a stale ref would report reviewed code as unreviewed`] };

  // TWO COUNTS RATHER THAN `merge-base --is-ancestor`, whose FALSE answer and
  // whose FAILURE are both a non-zero exit -- so a git that could not run would
  // read as "not an ancestor" and be reported as unreviewed code.
  const ahead = run(root, ["rev-list", "--count", `origin/${defaultBranch}..HEAD`]);
  const behind = run(root, ["rev-list", "--count", `HEAD..origin/${defaultBranch}`]);
  if (!ahead.ok || !behind.ok) return { id, level: UNKNOWN, title,
    lines: [...lines, `cannot compare against origin/${defaultBranch}${ahead.err ? `: ${ahead.err}` : ""}`,
            `-> until that resolves, this commit's provenance is unknown`] };

  if (Number(ahead.out) > 0) return { id, level: BROKEN, title,
    lines: [...lines, `it carries ${ahead.out} commit(s) that origin/${defaultBranch} has never seen`,
            `-> the guardian would enforce rules from code no review looked at; deploy a commit on origin/${defaultBranch}`] };

  // DISTANCE IS REPORTED; INTENT IS NOT CLAIMED. The first draft said "pinned,
  // not drifting", which asserts a decision nothing on this machine records --
  // and the checkout that produced it was behind by 43 because nobody had pulled.
  return { id, level: OK, title,
    lines: [...lines,
            Number(behind.out) === 0
              ? `which is origin/${defaultBranch}`
              : `which is ${behind.out} commit(s) behind origin/${defaultBranch}`,
            ...(Number(behind.out) === 0 ? [] : [
              "being behind is not itself a fault: a guardian held at a commit you deployed is working as intended",
              "-> but nothing here RECORDS a deployment, so a deliberate pin and an unpulled checkout read identically"])] };
}


// ── driver ────────────────────────────────────────────────────────────────

export function runDoctor({ nwo, profile = {}, db = null, pluginCacheRoot = null, repoPluginDir = null, appCheck = null, baselineIo = {}, stateDir = null, canaryIo = {}, keychainIo = {}, reachIo = {}, provenanceIo = {} }) {
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
    checkDaemonProvenance({
      // THE CONFIGURED BRANCH, like every neighbouring check. A profile whose
      // default branch is not `main` would otherwise be compared against an
      // `origin/main` that either does not resolve or is an unrelated branch.
      defaultBranch: profile.identity?.defaultBranch ?? "main",
      launchctl: readLoadedJob,
      runningCommit: () => daemonStartupCommit(),
      ...provenanceIo }),
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

/**
 * The hub half of doctor. Reads only.
 *
 * Every finding is classified, because a flat list of sixteen problems is not
 * something anyone acts on. The four classes are the four different responses:
 * a configuration error is fixed, a dependency outage is waited out, stale
 * evidence is refreshed, and unsafe authority is the one that must stop a merge.
 *
 * This function never writes repo_gate_state. The builder loop establishes that
 * row; a reporter that could also write it would be agreeing with itself, and
 * clause U4's whole value is that it reads something another actor established.
 */
export function hubFindings(db, { root, now = Math.floor(Date.now() / 1000), snapshotFor,
                                  newestCandidate = () => null,
                                  freshMinutes = 60, snapshotMaxHours = 24, offDevice = null,
                                  projects = [], projectsKnown = false }) {
  const out = [];
  const snap = snapshotFor("hub");
  if (!snap) {
    out.push({ id: "H-1", severity: "fail", classification: "configuration",
      title: "the hub has no snapshot", detail: `nothing under ${root}/hub`,
      action: "reeve backup --hub" });
  } else if (!snap.ok) {
    out.push({ id: "H-1", severity: "fail", classification: "configuration",
      title: "the newest hub snapshot does not validate", detail: String(snap.why), action: "reeve backup --hub" });
  } else if (now - snap.at > snapshotMaxHours * 3600) {
    out.push({ id: "H-1", severity: "warn", classification: "stale-evidence",
      title: "the hub snapshot is stale",
      detail: `${Math.round((now - snap.at) / 3600)}h old, taken ${new Date(snap.at * 1000).toISOString()}`,
      action: "reeve backup --hub" });
  } else {
    out.push({ id: "H-1", severity: "pass", classification: "stale-evidence",
      title: "hub snapshot is fresh", detail: `${Math.round((now - snap.at) / 60)}m old`, action: null });
  }

  // The NEWEST FILE, reported separately from the newest USABLE one. This was
  // added to the interface and to the CLI call and then read by nothing, which
  // is the worst of the three states: the argument arrived, the finding did not,
  // and a repository-wide search for the name found only the call site.
  //
  // They differ exactly when the most recent backup is broken. `latestSnapshot`
  // skips it and returns an older good file, so `snapshotFor` describes the
  // fallback and H-1/H-2/H-3 all answer `pass` -- and the broken newest backup
  // stays invisible for as long as the older recovery point remains fresh, which
  // is precisely the window in which the next backup fails too.
  const newest = newestCandidate("hub");
  if (newest && (!snap || newest.path !== snap.path))
    // `H-2:newest`, not a second bare `H-2`. The fallback's own H-2 is pushed
    // below and PASSES, so a consumer indexing findings by id -- the exact
    // failure this function already scopes H-4 and H-5 against -- keeps whichever
    // came last and hides the broken newest backup. Scoped, like the others.
    out.push({ id: "H-2:newest", severity: newest.ok ? "warn" : "fail", classification: "configuration",
      title: "the newest hub snapshot is not the one a restore would use",
      detail: newest.ok
        ? `${newest.path} is newer than ${snap?.path ?? "(none)"} but was not selected`
        : `${newest.path} does not validate: ${newest.why}`,
      action: "reeve backup --hub, and investigate why the newest snapshot is unusable" });

  // A project with NO row produces no finding at all unless it is asked for by
  // name. That is absence read as success on the clause whose entire job is to
  // refuse absence: on a fresh hub, or where one project has never refreshed,
  // U4 is UNKNOWN and doctor must say so. The registry is the list of what
  // SHOULD be there; the table is only what IS.
  // ONE IDENTITY PER PROJECT. Every push below used a bare `H-4`, so with two
  // projects a failing one and a healthy one both emit `H-4` -- and any consumer
  // that indexes findings by id keeps whichever was appended last, which is
  // whichever project the registry happened to list second. The id carries the
  // repository, exactly as `#<pr>:` scopes the guardian's per-PR escalations.
  // Keyed by `nwo_snapshot`, because that is the field the registry and the
  // table share. Keying on `repo_id` compared a column against a registry field
  // that does not exist -- `proj.repoId` was always null, `have.has(null)` always
  // false, and EVERY project reported "no gate-state row" including ones whose
  // row was present and healthy.
  const have = new Map(db.prepare("SELECT * FROM repo_gate_state").all().map(r => [r.nwo_snapshot, r]));
  for (const proj of projects) {
    if (have.has(proj.nwo)) continue;
    out.push({ id: `H-4:${proj.nwo}`, severity: "fail", classification: "unsafe-authority",
      title: `${proj.nwo} has no gate-state row`,
      detail: "the builder loop has never recorded one; clause U4 reads UNKNOWN, which is never PASS",
      action: "start the builder and let one tick refresh it" });
  }
  // Rows for projects the registry no longer lists are DEAD HISTORY, and a
  // de-registered repository must not keep `builder doctor` failing for ever.
  //
  // But suppression requires POSITIVE KNOWLEDGE. `projects` is `[]` both when
  // the registry legitimately lists nothing and when it could not be read at
  // all, and filtering on an empty set in the second case would silently hide
  // every unsafe-authority finding on the machine -- the exact absence-read-as-
  // success this doctor exists to refuse, committed by the fix for a different
  // problem. So the caller has to SAY that it knows, and the default is that it
  // does not: an unreadable registry reports everything and is noisy, which is
  // the failure direction an authority check should have.
  const registered = new Set(projects.map(p => p.nwo).filter(Boolean));
  for (const r of have.values()) {
    if (projectsKnown && !registered.has(r.nwo_snapshot)) continue;
    const stale = now - r.verified_at > freshMinutes * 60;
    const bound = r.ruleset_requires_check === 1 && r.bound_app_id != null && r.bound_app_id === r.expected_app_id;
    const installed = r.app_installed === "pass";
    if (stale) {
      out.push({ id: `H-4:${r.nwo_snapshot}`, severity: "warn", classification: "stale-evidence",
        title: `gate state for ${r.nwo_snapshot} is stale`,
        detail: `verified ${Math.round((now - r.verified_at) / 60)}m ago; the bound is ${freshMinutes}m`,
        action: "start the builder, or wait one tick" });
    } else if (!bound || !installed || r.permission_diff != null || r.error != null) {
      out.push({ id: `H-4:${r.nwo_snapshot}`, severity: "fail", classification: "unsafe-authority",
        title: `${r.nwo_snapshot} does not enforce the bound check`,
        // permission_diff and error are part of the answer, not colour: a row can
        // name the right app and still record a missing permission, or that the
        // read failed. Both are unsafe authority, and leaving them out of the
        // predicate let a drifted installation report PASS.
        detail: `requires=${r.ruleset_requires_check} bound_app=${r.bound_app_id} expected=${r.expected_app_id} ` +
                `installed=${r.app_installed} permission_diff=${r.permission_diff ?? "none"} error=${r.error ?? "none"}`,
        action: "merge stays dark until the ruleset requires ops/merge-policy from the expected app" });
    } else {
      out.push({ id: `H-4:${r.nwo_snapshot}`, severity: "pass", classification: "unsafe-authority",
        title: `${r.nwo_snapshot} enforces the bound check`, detail: null, action: null });
    }
  }

  // H-2/H-3: the snapshot's own integrity, and whether THIS binary could read it
  // back. Declared in the interface, so they are emitted rather than folded into
  // H-1: "a snapshot exists and is recent" is a different question from "it
  // restores", and a stale-but-valid snapshot and a fresh-but-corrupt one need
  // opposite responses.
  if (snap?.ok) {
    out.push({ id: "H-2", severity: "pass", classification: "stale-evidence",
      title: "the newest hub snapshot passes integrity_check", detail: snap.integrity, action: null });
    // Older is fine: validateSnapshot accepts any version at or below this
    // binary, and openHub applies the forward migrations after the copy. Only a
    // NEWER snapshot is unreadable. Requiring equality would tell an operator to
    // hunt for an old binary in the one case restore already handles.
    const ok = snap.version <= HUB_SCHEMA_VERSION;
    out.push({ id: "H-3", severity: ok ? "pass" : "fail", classification: "configuration",
      title: ok ? "the newest snapshot is restorable by this binary"
                : "the newest snapshot is NOT restorable by this binary",
      detail: `snapshot v${snap.version}, binary v${HUB_SCHEMA_VERSION}`,
      action: ok ? null : "run the matching binary, or take a fresh snapshot" });
  } else if (snap) {
    out.push({ id: "H-2", severity: "fail", classification: "configuration",
      title: "the newest hub snapshot does not read back", detail: String(snap.why), action: "reeve backup --hub" });
    out.push({ id: "H-3", severity: "fail", classification: "configuration",
      title: "restore compatibility is unknown: the snapshot does not open",
      detail: String(snap.why), action: "reeve backup --hub" });
  }

  // H-6: the off-device copy is a REQUIREMENT of this design whose destination is
  // still a founder decision (section 16.2). Reported missing rather than left
  // silent -- an unreported gap in the backup story reads as no gap.
  out.push(offDevice
    ? { id: "H-6", severity: "pass", classification: "configuration",
        title: "an off-device copy is configured", detail: offDevice, action: null }
    : { id: "H-6", severity: "warn", classification: "configuration",
        title: "no off-device copy is configured",
        detail: "same-disk snapshots only; this machine is still a single point of failure",
        action: "choose a destination (LAN machine, NAS or external disk; never cloud, never a git repository)" });

  // A held lease whose holder is gone still occupies a slot until something reaps
  // it, and a scheduler full of dead holders looks exactly like a busy one.
  // 'held' AND 'queued'. A queued guardian request is scheduler authority in its
  // own right -- admission blocks every builder while one is outstanding -- so a
  // request whose daemon died before it was admitted starves builder dispatch
  // indefinitely, while a held-only query reports nothing wrong.
  // ONE H-5, worst-case. Lease freshness and provider-state measurement are two
  // observations about one check, and pushing both produced a report saying the
  // scheduler is stale AND healthy in the same breath -- with any consumer that
  // indexes findings by id keeping whichever came last, which was the pass. A
  // finding id is an identity; it gets one verdict.
  const staleLeases = db.prepare(
    `SELECT count(*) c FROM provider_lease WHERE status IN ('held','queued') AND expires_at < ?`).get(now).c;
  const st = db.prepare("SELECT * FROM provider_state WHERE provider='claude'").get();

  const notes = [];
  if (staleLeases > 0)
    notes.push({ classification: "stale-evidence",
      why: `${staleLeases} held or queued provider request(s) expired; a dead holder starves every claim ` +
           `behind it, and an expired QUEUED request blocks builder admission by itself`,
      action: "the next tick reaps them; if it persists, the reaper is not running" });
  if (!st)
    notes.push({ classification: "configuration",
      why: "the provider scheduler has no state row; limits fall back to the defaults 2/1",
      action: "reeve build measure-provider (S3)" });
  else if (st.measured_at == null)
    notes.push({ classification: "stale-evidence",
      why: `provider limits are the unmeasured defaults: limit=${st.concurrency_limit} reserved=${st.guardian_reserved}`,
      action: "reeve build measure-provider (S3)" });
  // An ACTIVE COOLDOWN is a note too. Measured limits and no expired leases read
  // as healthy while `cooldown_until > now` means the scheduler is deliberately
  // admitting nothing -- so doctor answered "fine" about a builder that was,
  // correctly and invisibly, stopped. `dependency-outage`, not `configuration`:
  // nothing here is misconfigured, the provider is refusing, and the fold below
  // has to carry that classification or the finding degrades into a generic
  // warning that suggests changing something.
  if (st?.cooldown_until != null && st.cooldown_until > now)
    notes.push({ classification: "dependency-outage",
      why: `a provider cooldown is active until ${new Date(st.cooldown_until * 1000).toISOString()}` +
           `${st.last_signature ? ` (${st.last_signature})` : ""}; no new provider work is admitted`,
      action: "wait for the window, or investigate what exhausted it" });

  if (notes.length === 0) {
    out.push({ id: "H-5", severity: "pass", classification: "stale-evidence",
      title: "the provider scheduler is healthy",
      detail: `limit=${st.concurrency_limit} reserved=${st.guardian_reserved}, ` +
              `measured ${new Date(st.measured_at * 1000).toISOString()}; no expired requests`, action: null });
  } else {
    // Every reason is still reported; only the SEVERITY is folded. Dropping the
    // second reason would be this same defect in the other direction.
    out.push({ id: "H-5", severity: "warn",
      // WORST-CASE over every note, not a two-way test. An active provider
      // cooldown is classified `dependency-outage` above and this fold then
      // returned `stale-evidence` for it, so a provider refusing all new work
      // was rendered as old data -- and `dependency-outage` is the one
      // classification that tells an operator the fault is not theirs to fix.
      // Ordered most-severe first; the first match wins.
      classification: ["unsafe-authority", "dependency-outage", "configuration", "stale-evidence"]
        .find(c => notes.some(n => n.classification === c)) ?? "stale-evidence",
      title: "the provider scheduler needs attention",
      detail: notes.map(n => n.why).join("; "),
      action: notes.map(n => n.action).join("; ") });
  }
  return out;
}

/**
 * `hubFindings`' human renderer -- the companion `render` has for the guardian.
 *
 * This function did not exist. Four call sites in `bin/reeve`'s `builder doctor`
 * route named it, an import instruction listed it, and the plan described it as
 * "`hubFindings`' human renderer, added in `src/doctor.mjs` beside the existing
 * `render`" -- so every `reeve builder doctor` invocation would have thrown
 * `ReferenceError: renderHub is not defined`, which is the exact failure the
 * paragraph naming it claimed to prevent.
 *
 * Grouped by CLASSIFICATION rather than by severity, because that is what the
 * classes are for: `hubFindings` documents them as "the four different
 * responses" -- a configuration error is fixed, a dependency outage is waited
 * out, stale evidence is refreshed, and unsafe authority must stop a merge. A
 * renderer that sorted by severity would print a slug and throw that away,
 * leaving an operator to work out for themselves which of sixteen problems they
 * can actually do something about right now.
 *
 * Groups are ordered by what they demand of the reader: authority first because
 * it blocks a merge, then the things you fix, then the things you wait for, then
 * the things you refresh. Passes are kept -- "is it healthy" is a question this
 * command has to answer, and a report that shows only faults cannot answer it --
 * but they sort last inside their group.
 */
const HUB_CLASSES = [
  ["unsafe-authority",  "UNSAFE AUTHORITY   this stops a merge"],
  ["configuration",     "CONFIGURATION      fix these"],
  ["dependency-outage", "DEPENDENCY         wait for these"],
  ["stale-evidence",    "STALE EVIDENCE     refresh these"],
];
const HUB_SEVERITY_RANK = { fail: 0, warn: 1, pass: 2 };
const HUB_MARK = { fail: "FAIL", warn: "warn", pass: "ok  " };

export function renderHub(findings) {
  const all = Array.isArray(findings) ? findings : [];
  const n = (sev) => all.filter(f => f.severity === sev).length;
  const verdict = n("fail") ? "broken" : n("warn") ? "degraded" : all.length ? "ok" : "nothing to report";
  const out = [`reeve builder doctor${" ".repeat(30)}${verdict}`,
               `  ${n("fail")} failing · ${n("warn")} warning · ${n("pass")} ok`];

  const seen = new Set();
  for (const [cls, heading] of HUB_CLASSES) {
    const group = all.filter(f => f.classification === cls)
      .sort((a, b) => (HUB_SEVERITY_RANK[a.severity] ?? 9) - (HUB_SEVERITY_RANK[b.severity] ?? 9)
                   || String(a.id).localeCompare(String(b.id)));
    for (const f of group) seen.add(f);
    if (!group.length) continue;
    out.push("", heading);
    for (const f of group) {
      out.push(`  ${HUB_MARK[f.severity] ?? "?   "}  ${f.id}  ${f.title}`);
      if (f.detail) out.push(`          ${f.detail}`);
      // The house style for "what to do next", the same arrow every other reeve
      // command uses. An action is the only part of a finding that is not a
      // description, so it does not get buried in the detail.
      if (f.action) out.push(`          -> ${f.action}`);
    }
  }

  // A finding whose classification is not one of the four is REPORTED, not
  // dropped. Silently omitting it would make this renderer the one place a new
  // class could be added and never seen -- and the reader would have no way to
  // tell an empty report from a swallowed one.
  const unclassified = all.filter(f => !seen.has(f));
  if (unclassified.length) {
    out.push("", `UNCLASSIFIED       these carry a classification renderHub does not know`);
    for (const f of unclassified)
      out.push(`  ${HUB_MARK[f.severity] ?? "?   "}  ${f.id}  ${f.title}` +
               `  [classification: ${JSON.stringify(f.classification)}]`);
  }
  if (!all.length) out.push("", "  no findings: the hub reported nothing at all");
  return out.join("\n");
}
