// status — the one screen, and the one line.
//
// Answers exactly two questions: what is happening right now, and what should I
// do next. Everything else belongs somewhere else.
//
// Three bands, in priority order. The first band's target state is EMPTY, so a
// glance that shows nothing there is the good outcome. The health band is a
// ROLLING window rather than a lifetime average, because a lifetime clean-merge
// rate would have stayed comfortable while the real one went to zero.
//
// Deliberately absent: lines changed, PR count, token count. All three reward
// churn, and all three were headline stats on the board this replaces.

import { execFileSync } from "node:child_process";

const SPARK = "▁▂▃▄▅▆▇█";

function sh(args) {
  try { return { ok: true, out: execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() }; }
  catch (e) { return { ok: false, out: "", err: String(e.stderr || e.message).trim() }; }
}

/** Rolling sparkline from a series of 0..1 values. */
export function spark(values) {
  if (!values.length) return "";
  return values.map(v => SPARK[Math.min(SPARK.length - 1, Math.max(0, Math.round(v * (SPARK.length - 1))))]).join("");
}

function ago(seconds) {
  if (seconds == null) return "?";
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * Clean-merge rate over the trailing N merged PRs.
 *
 * "Clean" means merged with every check green at the MERGED head and no
 * unresolved threads. This is the hero number precisely because it was 0% when
 * measured on the system this replaces, while every vanity metric looked healthy.
 */
/**
 * How often a merge landed with its evidence actually green.
 *
 * The previous version asked how many check runs at the merge commit were NOT
 * passing and called zero "clean" — so a merge with no check runs at all scored
 * identically to one that passed everything. That is absence read as success, in
 * the single number the dashboard leads with, and it is the same shape as every
 * fail-open defect in the gate this replaces.
 *
 * A merge is now UNJUDGED unless there is evidence to judge: at least one check,
 * and every required context present. Unjudged merges are counted and reported
 * rather than folded into either side, because "we do not know" is a finding in
 * its own right.
 *
 * `probe` exists so this can be driven without the network.
 */
export function cleanMergeRate(nwo, n = 20, probe = null, { required = [] } = {}) {
  const io = probe ?? {
    merged: () => {
      const list = sh(["pr", "list", "--repo", nwo, "--state", "merged", "--limit", String(n),
                       "--json", "number,mergeCommit", "--jq", ".[] | [.number, (.mergeCommit.oid // \"\")] | @tsv"]);
      if (!list.ok) return null;
      return list.out.split("\n").filter(Boolean)
        .map(l => l.split("\t")).filter(([, sha]) => sha)
        .map(([number, sha]) => ({ number: Number(number), sha }));
    },
    checks: sha => {
      const r = sh(["api", `repos/${nwo}/commits/${sha}/check-runs?per_page=100&filter=latest`,
                    "--jq", "[.check_runs[] | {name, conclusion}]"]);
      if (!r.ok) return null;
      try { return JSON.parse(r.out || "[]"); } catch { return null; }
    },
  };

  const rows = io.merged();
  if (!rows) return { ok: false, why: "could not list merged pull requests" };

  let clean = 0, judged = 0, unjudged = 0;
  const series = [];
  for (const { sha } of rows) {
    const checks = io.checks(sha);
    // null is "could not ask". Skipping it silently would let a rate be computed
    // from whichever merges happened to be readable.
    if (checks === null) { unjudged++; continue; }
    // No checks is no evidence. It is not a pass.
    if (!checks.length) { unjudged++; continue; }
    const names = new Set(checks.map(c => c.name));
    if (required.some(c => !names.has(c))) { unjudged++; continue; }

    judged++;
    const bad = checks.filter(c => !["success", "skipped", "neutral"].includes(String(c.conclusion))).length;
    const isClean = bad === 0;
    if (isClean) clean++;
    series.push(isClean ? 1 : 0);
  }

  // An empty sample is not 100%.
  if (!judged) return { ok: false, unjudged, why: `no merged PR could be judged (${unjudged} had no usable evidence)` };
  return { ok: true, clean, judged, unjudged, rate: clean / judged, series: series.reverse() };
}


/** Everything the screen needs, read from the store. Fast, no network. */

/**
 * Record that a tick completed. Without this there is no way to distinguish a
 * quiet fleet from a stopped daemon, and those look identical on every screen.
 */
export function noteTick(db, at = Math.floor(Date.now() / 1000)) {
  try {
    db.prepare(`INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)`)
      .run(at, "daemon", "daemon.tick", null, "{}");
  } catch { /* a store that cannot record must not stop the loop */ }
}

/**
 * Is the daemon alive? Returns `alive: null` when it has never recorded a tick,
 * because "no record" is not "healthy" -- it is the absence of information, and
 * absence is never success.
 */
function daemonLiveness(db, now, window) {
  let row = null;
  try { row = db.prepare("SELECT MAX(at) at FROM event WHERE op='daemon.tick'").get(); }
  catch { return { lastTickAt: null, alive: null, why: "the store could not be read" }; }
  const at = row?.at ?? null;
  if (!at) return { lastTickAt: null, alive: null, why: "no tick has ever been recorded" };
  const age = now - at;
  return age <= window
    ? { lastTickAt: at, alive: true, why: null, ageSeconds: age }
    : { lastTickAt: at, alive: false, ageSeconds: age,
        why: `the daemon has not ticked for ${Math.floor(age / 60)} minute(s) — everything below is history, not status` };
}

export function readState(db, { limit = 12, freshWindow = 900, now = Math.floor(Date.now() / 1000) } = {}) {
  const prs = new Map();
  try {
    const rows = db.prepare(
      `SELECT subject, at, payload FROM event WHERE op = 'pr.decided' ORDER BY seq DESC LIMIT 400`
    ).all();
    // A PR that stopped appearing in ticks is closed, merged, or no longer being
    // watched. Its last decision is history, not status, and showing it as live
    // is how a screen reports a state that has not been true for hours.
    for (const r of rows) {
      if (prs.has(r.subject)) continue;           // most recent decision per PR wins
      let p; try { p = JSON.parse(r.payload); } catch { continue; }
      // Against the CLOCK, not against the newest stored row. Comparing rows to
      // each other meant that when the daemon stopped, every decision stayed
      // "fresh" forever -- the screen looked calmest exactly when the thing that
      // watches had died.
      const stale = now - r.at > freshWindow;
      prs.set(r.subject, { id: r.subject, at: r.at, stale, ...p });
      if (prs.size >= limit) break;
    }
  } catch { /* an unreadable store is reported by the caller, not guessed around */ }

  let runs = [];
  try {
    runs = db.prepare(
      `SELECT r.id, r.task_id, r.lane, r.status, r.lease_expires_at, r.heartbeat_at, r.step
       FROM run r WHERE r.status IN ('leased','running','blocked_on_ci','blocked_on_review','awaiting_founder')`
    ).all();
  } catch { /* same */ }

  let pending = [];
  try {
    // 'open', not 'pending'. The node.status CHECK constraint permits
    // open/ready/running/blocked/review/done/decided/refuted/cancelled/dead_letter
    // and has never permitted 'pending', so this query could only ever return
    // nothing -- and an empty result rendered as "nothing needs you". A band that
    // is structurally incapable of showing anything is worse than no band.
    pending = db.prepare(`SELECT id, title FROM node WHERE kind='decision' AND status='open'`).all();
  } catch { /* same */ }

  return { prs: [...prs.values()], runs, pending, daemon: daemonLiveness(db, now, freshWindow) };
}

/** The escalations band: what genuinely needs a person. */
export function needsYou(state) {
  const out = [];
  for (const d of state.pending) out.push({ kind: "decision", id: d.id, why: d.title });
  // A shared cause is one row, not N. Four PRs on a red base is one problem.
  const shared = new Map();
  for (const p of state.prs) {
    if (p.action !== "ESCALATE" || p.stale) continue;
    const key = p.why ?? "escalated";
    if (!shared.has(key)) shared.set(key, []);
    shared.get(key).push(p.id.replace("pr:", "#"));
  }
  for (const [why, prs] of shared) out.push({ kind: "escalation", why, prs });
  const now = Math.floor(Date.now() / 1000);
  for (const r of state.runs) {
    if (r.lease_expires_at < now) out.push({ kind: "lease", id: r.task_id, why: `lease expired ${ago(now - r.lease_expires_at)} ago` });
  }
  return out;
}

/** Render the full screen. */
export function render({ nwo, state, health, width = 78 }) {
  const L = [];
  const bar = label => `┌ ${label} ${"─".repeat(Math.max(0, width - label.length - 4))}`;
  const mid = label => `├ ${label} ${"─".repeat(Math.max(0, width - label.length - 4))}`;

  const needs = needsYou(state);
  // A dead watcher is the first thing to say. Everything under it is history
  // rather than status, and a screen that does not lead with that is inviting
  // someone to act on a picture that stopped being true hours ago.
  if (state.daemon && state.daemon.alive === false) L.push(`  ⚠ ${state.daemon.why}`);
  if (state.daemon && state.daemon.alive === null) L.push(`  ⚠ daemon liveness unknown: ${state.daemon.why}`);
  L.push(bar("NEEDS YOU") + (needs.length ? "" : "   target state: EMPTY"));
  if (!needs.length) L.push("│  (nothing)");
  for (const n of needs) {
    if (n.kind === "escalation") L.push(`│  ${n.prs.join(" ")}  ${n.why}`);
    else L.push(`│  ${n.id}  ${n.why}`);
  }

  L.push(mid("FLEET"));
  const active = state.prs.filter(p => p.action !== "ESCALATE" && !p.stale);
  if (!active.length && !state.runs.length) L.push("│  (idle)");
  for (const r of state.runs) {
    const now = Math.floor(Date.now() / 1000);
    L.push(`│  ${r.lane.padEnd(12)} ${String(r.task_id).slice(0, 28).padEnd(29)} ${r.status.padEnd(16)} lease ${ago(r.lease_expires_at - now)} left`);
  }
  for (const p of active.slice(0, 8)) {
    // The subtitle is always what it is WAITING ON, precisely. "In progress" is
    // not information; "waiting: coderabbit, 41m" is.
    L.push(`│  ${p.id.replace("pr:", "#").padEnd(7)} ${String(p.state).padEnd(7)} ${String(p.action).padEnd(15)} ${String(p.why ?? "").slice(0, width - 36)}`);
  }

  L.push(mid("HEALTH"));
  if (health?.clean?.ok) {
    const pct = Math.round(health.clean.rate * 100);
    L.push(`│  clean-merge  last ${health.clean.judged}  ${spark(health.clean.series)}  ${pct}%`);
  } else {
    L.push(`│  clean-merge  not measurable${health?.clean?.why ? ` (${health.clean.why})` : ""}`);
  }
  if (health?.base) L.push(`│  base         ${health.base}`);
  if (health?.reviewers?.length) {
    // Four states, never two. A rate-limited reviewer reports success, and an
    // uninstalled one reports nothing; both look like "found no problems".
    const chips = health.reviewers.map(r => {
      const mark = r.state === "CLEAN" || r.state === "VERDICT" ? "●" : r.state === "REFUSED" ? "◐" : "○";
      return `${r.login.split("-")[0]} ${mark}${r.state}`;
    });
    L.push(`│  reviewers    ${chips.join("   ")}`);
  }
  L.push("└" + "─".repeat(width - 1));
  return L.join("\n");
}

/**
 * One line for the terminal statusline. Refreshed every ten seconds, so it must
 * be cheap: reads the store only, never the network.
 */
export function statusline(db, { nwo } = {}) {
  const state = readState(db, { limit: 20 });
  const needs = needsYou(state);
  const running = state.runs.length;
  const live = state.prs.filter(p => !p.stale);
  const blocked = live.filter(p => p.state === "BLOCK").length;
  const waiting = live.filter(p => p.action === "WAIT").length;
  const bits = [];
  bits.push(nwo ? nwo.split("/")[1] : "reeve");
  bits.push(running ? `${running} run${running > 1 ? "s" : ""}` : "idle");
  if (blocked) bits.push(`${blocked} blocked`);
  if (waiting) bits.push(`${waiting} waiting`);
  // The one thing that must be impossible to miss.
  if (needs.length) bits.push(`⚠ ${needs.length} NEEDS YOU`);
  return bits.join("  ·  ");
}

/** `reeve why <id>`: the decision trail for one PR, newest first. */
export function why(db, id, { limit = 12 } = {}) {
  const subject = id.startsWith("pr:") ? id : `pr:${String(id).replace(/^#/, "")}`;
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT at, actor, op, payload FROM event WHERE subject = ? ORDER BY seq DESC LIMIT ?`
    ).all(subject, limit);
  } catch (e) { return `could not read the store: ${e.message}`; }
  if (!rows.length) return `nothing recorded for ${subject}. reeve has not looked at it yet.`;

  const out = [`${subject} — most recent first`, ""];
  for (const r of rows) {
    let p = {}; try { p = JSON.parse(r.payload); } catch { /* show what we can */ }
    const when = new Date(r.at * 1000).toISOString().replace("T", " ").slice(0, 19);
    if (r.op === "pr.decided") {
      out.push(`${when}  ${p.state} -> ${p.action}`);
      out.push(`              ${p.why ?? ""}`);
      // The clause table is the answer to "why did it say that", which is the
      // question a bare verdict never answers.
      const cl = (p.clauses ?? []).map(c => `${c.id}=${c.state}`).join("  ");
      if (cl) out.push(`              ${cl}`);
      if (p.head) out.push(`              at ${String(p.head).slice(0, 8)}`);
    } else if (r.op === "worker.finished") {
      out.push(`${when}  worker ${p.action} -> ${p.outcome}  (${p.why})${p.cost != null ? `  $${Number(p.cost).toFixed(3)}` : ""}`);
    } else {
      out.push(`${when}  ${r.op}  ${JSON.stringify(p).slice(0, 90)}`);
    }
    out.push("");
  }
  return out.join("\n");
}
