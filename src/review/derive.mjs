// review/derive — the pure fold from raw observations to what the gate reads.
//
// Nothing here talks to GitHub. It reads inbox rows that ingest already landed
// and writes projections, so improving a classifier means re-reading history
// rather than only affecting whatever happens next. That is not tidiness:
// CodeRabbit's finding taxonomy has ALREADY been replaced once -- the
// "Potential issue"/"Refactor suggestion" strings that a previous audit recorded
// appear zero times in forty current bodies -- so a detector set that cannot be
// re-run over the past is a detector set that silently stops seeing things.
//
// Three rules run through all of it.
//
//   Unknown fails CLOSED. An unclassifiable finding counts as critical, because
//   the founder ruling is that criticals are never spilled, and a finding whose
//   severity nobody can read is exactly the one not to gamble on.
//
//   A round is a SUBSTANTIVE answer at a bound revision. Every inline reply mints
//   a 0-byte COMMENTED review -- nine at a single commit on #1124 -- so counting
//   review objects, or distinct commit_ids across them, overstates rounds by an
//   order of magnitude.
//
//   Resolved is a CLAIM. coderabbitai resolves its own threads, including ones
//   nobody replied to, and `@coderabbitai resolve` is author-invokable and
//   bulk-resolves. A thread is CLEARED only when a later substantive round by the
//   same reviewer has been and gone -- the round that FILED it cannot clear it.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const SEVERITIES = ["critical", "major", "minor", "nit", "unknown"];

/** Severities that block and are never spillable. `unknown` is here on purpose. */
export const BLOCKING_SEVERITIES = new Set(["critical", "unknown"]);

/**
 * The version of "how this was derived": the fold's own source plus every
 * detector the profile supplies. A stored projection under a different version
 * was produced by something that no longer exists, so it is rebuilt rather than
 * trusted -- which is what makes a taxonomy change reach history.
 */
export function classifierVersion(profile) {
  const code = readFileSync(new URL("./derive.mjs", import.meta.url), "utf8");
  const detectors = (profile?.reviewers ?? []).map(r => ({
    login: r.login, kind: r.kind, refusal: r.refusal, clean: r.clean,
    cleanReaction: r.cleanReaction, commitPattern: r.commitPattern,
    severityMarkers: r.severityMarkers, bodyFindings: r.bodyFindings,
  }));
  return createHash("sha256")
    .update(code).update(JSON.stringify(detectors))
    .digest("hex").slice(0, 16);
}

/**
 * Severity of one finding body, by the reviewer's own markers.
 *
 * Markers are ORDERED and first-match-wins, so a profile can put the specific
 * before the general. No match is `unknown`, which blocks: guessing "probably
 * minor" about text nobody could read is how a P0 gets spilled.
 */
export function severityOf(body, markers = []) {
  const text = String(body ?? "");
  for (const [pattern, severity] of markers) {
    try { if (new RegExp(pattern, "i").test(text)) return severity; }
    catch { /* an uncompilable marker is refused at profile validation */ }
  }
  return "unknown";
}

/**
 * Split one review BODY into the individual findings it states.
 *
 * `start` matches where each finding BEGINS; the finding runs from there to the
 * next match, or to the end. Prose before the first match is not a finding --
 * codex opens with a summary paragraph and CodeRabbit's whole body is one -- so
 * a body with no match yields nothing rather than yielding itself.
 *
 * Returns [] for a reviewer with no declaration. That is not "this reviewer has
 * no findings": the caller records separately that the count could be short, and
 * conflating the two is exactly what would let a body-only P0 through as a zero.
 *
 * Zero-length matches are dropped. `matchAll` advances past them rather than
 * looping, so they cost nothing here, but a pattern that can match empty would
 * otherwise mint one finding per character. Profile validation refuses such a
 * pattern outright; this is the second half of the same guard, because the fold
 * also runs against stored history whose profile is long gone.
 */
export function bodyFindingsOf(body, start) {
  if (typeof start !== "string" || !start) return { findings: [], readable: false };
  const text = String(body ?? "");
  let re;
  try { re = new RegExp(start, "gi"); } catch { return { findings: [], readable: false }; }
  const all = [...text.matchAll(re)];
  const at = all.filter(m => m[0].length > 0).map(m => m.index);
  // ANY zero-width match condemns the whole delimiter set, not merely a set where
  // every match is zero-width.
  //
  // A pattern can be zero-width WITHOUT matching the empty string: `(?=!\[P\d
  // Badge\])` returns false for test("") and passes profile validation. Requiring
  // ALL of them to be zero-width then left a worse hole than the one it closed --
  // `(?=!\[P2 Badge\])|!\[P\d Badge\]` matches the P2 at zero width and the P1 at
  // full width, so the P2 match is dropped, the P1 keeps the body "readable", and
  // the slice that should have been the P2 finding is swallowed into the text
  // before it. One finding silently gone, and a confident count over the rest.
  //
  // `every` over an empty list is true, which is the right answer for a pattern
  // that simply found nothing: that body has no findings, and reeve could read it.
  const readable = all.every(m => m[0].length > 0);
  return {
    readable,
    findings: readable
      ? at.map((i, k) => text.slice(i, k + 1 < at.length ? at[k + 1] : text.length).trim()).filter(Boolean)
      : [],
  };
}

/** Reviewer config by normalised login, or null when unrostered. */
const rosterOf = profile => new Map((profile?.reviewers ?? []).map(r => [r.login, r]));

/**
 * Classify ONE observation into a round outcome, or null when it is not a round.
 *
 * The ordering matters and is measured. A refusal is checked before a clean pass
 * because Codex's refusal text also contains the word "review"; a review object
 * is trusted over a comment because its commit_id is the full forty-hex sha while
 * bodies abbreviate.
 */
export function classifyObservation(o, rev, resolve) {
  const payload = o.payload ?? {};
  const body = String(payload.body ?? "");

  if (o.kind === "issue_comment") {
    if (rev?.refusal && new RegExp(rev.refusal, "i").test(body)) {
      return { outcome: "refusal", head_full: null, head10: null };
    }
    if (rev?.clean && new RegExp(rev.clean, "i").test(body)) {
      const abbrev = rev.commitPattern ? body.match(new RegExp(rev.commitPattern, "i"))?.[1] : null;
      const full = abbrev ? resolve(abbrev) : null;
      // A clean pass that names no revision, or names one reeve never pinned, has
      // not demonstrated coverage of anything. Recorded, never coverage.
      return full
        ? { outcome: "clean", head_full: full, head10: full.slice(0, 10) }
        : { outcome: "unbound_clean", head_full: null, head10: null };
    }
    return null;   // a trigger command, a human comment, chatter
  }

  if (o.kind === "review") {
    // A 0-byte COMMENTED review is a carrier for an inline reply, not an answer.
    if (!body.trim()) return null;
    const full = payload.commit_id && payload.commit_id.length === 40 ? payload.commit_id : null;
    if (!full) return { outcome: "unbound_clean", head_full: null, head10: null };
    // APPROVED with no findings is a clean pass; anything else that says
    // something at a revision is findings. CHANGES_REQUESTED is emphatically not
    // "covered and fine", which is what discarding .state used to make it.
    const outcome = payload.state === "APPROVED" ? "clean" : "findings";
    return { outcome, head_full: full, head10: full.slice(0, 10) };
  }

  if (o.kind === "reaction") {
    // Codex's push-triggered clean pass. It binds to no revision, and reactions
    // are unique per (user, emoji, item) so a SECOND one produces no event at
    // all -- it can never be load-bearing evidence.
    if (rev?.cleanReaction && payload.content === rev.cleanReaction) {
      return { outcome: "unbound_clean", head_full: null, head10: null };
    }
    return null;
  }

  return null;
}

/**
 * Rebuild every projection for one pull request from the inbox, in one
 * transaction.
 *
 * TOTAL, not incremental: the PR's rows are deleted and re-derived. Measured
 * volumes are small (at most 29 threads and 5 rounds per PR), so an incremental
 * cursor would buy nothing and cost the one property that matters -- a full fold
 * cannot half-apply, and a half-applied projection is a gate reading a review
 * whose thread is not there yet.
 */
export function derivePr(db, nwo, pr, profile, { at = Math.floor(Date.now() / 1000), complete = true, head = null } = {}) {
  const version = classifierVersion(profile);
  const roster = rosterOf(profile);
  const heads = db.prepare("SELECT sha FROM head_seen WHERE nwo=? AND pr=?").all(nwo, pr).map(r => r.sha);
  const resolve = abbrev => {
    if (!abbrev || abbrev.length < 7) return null;
    const hit = heads.filter(h => h.startsWith(String(abbrev).toLowerCase()));
    return hit.length === 1 ? hit[0] : null;   // ambiguous resolves to nothing
  };

  // When reeve FIRST saw each thread claiming to be resolved. GitHub reports who
  // resolved a thread but never WHEN, and the thread's own createdAt is its BIRTH
  // -- using that made "a later round exists" trivially true for every thread,
  // which collapsed the rule this exists to enforce. The flip from unresolved to
  // resolved changes the content hash, so it lands as a new generation, and that
  // generation's observed_at is the earliest moment reeve can prove it was true.
  const resolvedSince = new Map();
  for (const r of db.prepare(
    `SELECT external_id, payload, observed_at FROM inbox
      WHERE pr_number = ? AND kind = 'review_thread' ORDER BY generation`).all(pr)) {
    if (resolvedSince.has(r.external_id)) continue;
    let p; try { p = JSON.parse(r.payload); } catch { continue; }
    if (p?.is_resolved) resolvedSince.set(r.external_id, r.observed_at);
  }

  // Latest generation per object: an edit supersedes, and the fold reads what the
  // object says NOW while the earlier text stays on record in inbox.
  // CURRENT, not newest, and the difference is the whole reason `inbox_current`
  // exists. MAX(generation) answers "which text arrived last", which is the same
  // question only while content never repeats. A body edited A -> B -> A stores no
  // third row -- A's hash is already there -- so the newest generation is still B,
  // and the fold reads text the reviewer has already taken back.
  //
  // The pointer is written on EVERY observation, so it is correct from the first
  // tick after this lands. LEFT JOIN with a MAX() fallback for a store written
  // before it existed: that store self-heals on its next observation, and until
  // then it behaves exactly as it did before rather than reading nothing.
  const rows = db.prepare(`
    SELECT i.source, i.external_id, i.kind, i.payload, i.event_at, i.generation, i.observed_at
      FROM inbox i
      JOIN (SELECT m.source, m.external_id,
                   COALESCE(c.generation, m.g) AS g
              FROM (SELECT source, external_id, MAX(generation) g FROM inbox
                     WHERE pr_number = ? GROUP BY source, external_id) m
              LEFT JOIN inbox_current c
                ON c.pr_number = ? AND c.source = m.source AND c.external_id = m.external_id) sel
        ON sel.source = i.source AND sel.external_id = i.external_id AND sel.g = i.generation
     WHERE i.pr_number = ?
     ORDER BY i.event_at, i.id`).all(pr, pr, pr);

  const rounds = [], threads = [], bodyFindings = [];
  // Which reviewers wrote a review body at all, and whether every one of them had
  // declared how their bodies carry findings. Both are needed: the count is only
  // trustworthy when nobody wrote a body reeve could not read.
  const bodyAuthors = new Set();
  let bodyComplete = true;
  for (const r of rows) {
    const o = { kind: r.kind, payload: JSON.parse(r.payload) };
    const rev = roster.get(r.source) ?? null;

    if (r.kind === "review_thread") {
      const p = o.payload;
      threads.push({
        thread_id: p.thread_id, reviewer: r.source,
        path: p.path ?? null, line: p.line ?? null,
        severity: severityOf(p.body, rev?.severityMarkers ?? []),
        is_resolved: p.is_resolved ? 1 : 0, is_outdated: p.is_outdated ? 1 : 0,
        resolved_by: p.resolved_by ?? null,
        resolved_at: p.is_resolved ? (resolvedSince.get(r.external_id) ?? at) : null,
        excerpt: String(p.body ?? "").slice(0, 400),
        event_at: r.event_at ?? null,
      });
      continue;
    }

    const c = classifyObservation(o, rev, resolve);
    if (!c) continue;
    // The round's ORDINAL, taken before the push so it indexes the round itself.
    // Body findings clear by ordinal rather than by timestamp because the round
    // that files a finding shares its instant exactly -- they are the same
    // observation -- and `>` on equal seconds is a coin toss decided by whichever
    // GitHub timestamp happens to round which way.
    const ord = rounds.length;
    // DISMISSED is carried ON the round rather than keeping the round out.
    //
    // It still happened, so it still counts toward the round budget and toward
    // coverage — rewriting those is a bigger question than this. What it must not
    // be is EVIDENCE THAT THE REVIEWER LOOKED AGAIN. Suppressing only its own
    // findings left it clearing everyone else's: dismiss a review and the earlier
    // findings it was never about quietly went away.
    const dismissed = String(o.payload?.state ?? "").toUpperCase() === "DISMISSED";
    rounds.push({ reviewer: r.source, source_id: r.external_id, event_at: r.event_at ?? at, dismissed, ...c });

    // A substantive review BODY is the only place a body finding can come from.
    // `classifyObservation` already returned null for a 0-byte review -- the
    // carrier GitHub mints for every inline reply -- so reaching here with
    // kind 'review' IS the definition of one.
    if (r.kind !== "review") continue;
    bodyAuthors.add(r.source);
    // COMPLETENESS is decided per pull request against what was actually posted,
    // not against the roster. A profile can be fully configured and still miss a
    // body finding from a human reviewer nobody rostered, and a roster check
    // would report complete for exactly that pull request. Asking "did everyone
    // who actually wrote a review body declare how their bodies work" is the
    // question the count depends on, and it fails closed on a stranger.
    // WHEN THIS TEXT ARRIVED, and the two generations answer it differently.
    //
    // A first generation's text arrived WITH the review, so its submission time is
    // the honest answer. Only an EDIT adds text later than its container, and only
    // then is reeve's own observation the earliest moment the text can be proved
    // to have existed.
    //
    // Using observation for both looked conservative and was a wedge. When reeve
    // first watches an existing pull request it ingests all of its history in one
    // batch, so every historical review shares one observed_at of `now` -- and no
    // historical round can then be later than any historical finding. Every old
    // body finding would stay open until some future review arrived, on a pull
    // request whose reviewers had long since finished with it.
    const edited = (r.generation ?? 1) > 1;
    const seenAt = (r.generation ?? 1) > 1
      ? (r.observed_at ?? r.event_at ?? at)
      : (r.event_at ?? r.observed_at ?? at);
    // A DISMISSED review is a maintainer saying that review no longer counts.
    // Recreating its findings would put a worker to work implementing feedback
    // somebody explicitly discarded, and no later round can clear them because the
    // dismissal is not a round. Its ROUND classification is left alone: it still
    // happened, and rewriting coverage history is a larger question than this.
    if (dismissed) continue;

    const declared = typeof rev?.bodyFindings === "string" || rev?.bodyFindings === false;
    if (!declared) bodyComplete = false;
    // `false` is a declaration that this reviewer's bodies carry no findings, so
    // it is READ, not skipped. Anything else is read by the splitter, which
    // reports separately whether it could read it at all.
    const split = rev?.bodyFindings === false
      ? { readable: true, findings: [] }
      : bodyFindingsOf(o.payload?.body, rev?.bodyFindings);

    // AN UNREADABLE BODY BECOMES ONE UNKNOWN FINDING, rather than nothing.
    //
    // Withholding the count instead was silent: `computeVerdict` reads a null
    // critical count as no reason to stop, so an undeclared reviewer writing a
    // P0 in a body left every clause passing and the pull request mergeable.
    // Absence read as success, in the exact place the count exists to prevent it.
    //
    // A sentinel is also what this codebase already does one layer down: a thread
    // whose severity nobody can read is `unknown`, and `unknown` blocks. A body
    // nobody can read is the same statement about a different surface, so it gets
    // the same answer rather than a new kind of silence.
    if (!split.readable) {
      bodyFindings.push({
        finding_id: `${r.external_id}#unreadable`, reviewer: r.source, severity: "unknown",
        excerpt: `reeve cannot read this reviewer's review bodies (no usable bodyFindings declaration), ` +
                 `so this body is counted as one finding of unknown severity: ` +
                 String(o.payload?.body ?? "").replace(/\s+/g, " ").slice(0, 240),
        event_at: r.event_at ?? at, head_full: c.head_full ?? null, ord,
        seen_at: seenAt, edited, unreadable: 1,
      });
      continue;
    }
    for (const [n, text] of split.findings.entries()) {
      bodyFindings.push({
        finding_id: `${r.external_id}#${n}`, reviewer: r.source,
        // Severity is read from the FINDING, never the whole body. Markers are
        // first-match-wins, so classifying the body would give every finding in
        // it the severity of whichever appeared first -- a P0 below a P3 would
        // be filed as a nit.
        severity: severityOf(text, rev?.severityMarkers ?? []),
        excerpt: text.slice(0, 400), event_at: r.event_at ?? at,
        head_full: c.head_full ?? null, ord, seen_at: seenAt, edited, unreadable: 0,
      });
    }
  }

  // A thread is CLEARED only when a LATER substantive round by the SAME reviewer,
  // AT THE HEAD UNDER JUDGEMENT, has been and gone.
  //
  // Both halves are load-bearing and both were got wrong first time. Without
  // "later", the round that FILED the finding clears it, so an author who resolves
  // without changing a line passes immediately. Without "at this head", a round
  // from three pushes ago clears threads for code it never saw.
  //
  // The consequence is deliberate: a new push un-clears everything until the
  // reviewer answers again. An unreviewed revision has confirmed nothing, and
  // saying so is the same rule that governs coverage.
  const covers = round => head ? round.head_full === head : false;
  const clearedBy = (reviewer, ts) => rounds.some(
    x => x.reviewer === reviewer && (x.outcome === "findings" || x.outcome === "clean") &&
         covers(x) && x.event_at > ts);
  for (const t of threads) {
    t.is_cleared = t.is_resolved && t.resolved_at != null && clearedBy(t.reviewer, t.resolved_at) ? 1 : 0;
  }

  // A BODY finding carries only the second half of that rule, and the founder
  // ruled on 2026-08-27 that this is what clearing one means: the same reviewer
  // reviewed this same revision again, whatever it said that time.
  //
  // The first half cannot exist here. There is no thread, so there is nothing to
  // resolve and no resolve to observe, and a rule requiring one would leave every
  // body finding open forever -- which does not fail closed, it fails STUCK, and
  // a pull request nothing can ever clear is not a safety property.
  //
  // The weakness is named rather than hidden: a reviewer whose second pass was
  // cut short clears the finding by not repeating it. What limits the damage is
  // that the reviewer is looking at the same code, so a problem still there is
  // restated and returns as a new finding.
  //
  // Measured from when the finding's TEXT was first seen, not from when its review
  // object was submitted. CodeRabbit edits its own bodies in place, and an edit
  // keeps the original `submitted_at` -- so a finding ADDED by an edit inherited
  // the position of the review it was added to, and a round that happened before
  // the edit cleared text that did not exist when that round ran. A newly added P0
  // could leave the count without anybody having looked at it.
  //
  // The timestamp is asked ONLY of an edit, and that restriction is the whole
  // point of it. For a first generation `seen_at` IS the review's own event_at, so
  // two same-second rounds give `x.event_at === seenAt` and a strict comparison
  // rejects the very case the ordinal exists to decide — the timestamp vetoing
  // the tiebreak it was supposed to accompany. The comment here used to claim the
  // ordinal still decided ties; it did not.
  //
  // A DISMISSED round is excluded outright: a maintainer saying a review no longer
  // counts is not that reviewer having looked again.
  const roundClearsAfter = (reviewer, ord, seenAt, edited) => rounds.some(
    (x, i) => i > ord && x.reviewer === reviewer && !x.dismissed &&
              (x.outcome === "findings" || x.outcome === "clean") && covers(x) &&
              (!edited || (x.event_at ?? 0) > seenAt));
  for (const f of bodyFindings)
    // A SENTINEL IS NEVER CLEARED BY A ROUND, because a round is not what would
    // fix it. It does not say "this reviewer raised something"; it says reeve
    // cannot parse this reviewer's bodies at all — a fact about the profile, not
    // about the pull request. An ordinary clearance let a later clean comment
    // retire it while reeve was exactly as unable to read as before, and since
    // sentinels are minted only from review OBJECTS, that round created no
    // replacement. The count fell to zero and the pull request was free to merge.
    //
    // It leaves by being re-derived without one: declaring `bodyFindings` for that
    // reviewer changes the classifier version, which makes the projection stale
    // and rebuilds it. So the escape is the operator action the escalation asks
    // for, and nothing else.
    f.is_cleared = f.unreadable ? 0
                 : (roundClearsAfter(f.reviewer, f.ord, f.seen_at, f.edited) ? 1 : 0);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM review_round WHERE nwo=? AND pr=?").run(nwo, pr);
    db.prepare("DELETE FROM review_thread WHERE nwo=? AND pr=?").run(nwo, pr);
    db.prepare("DELETE FROM review_body_finding WHERE nwo=? AND pr=?").run(nwo, pr);
    const ir = db.prepare(`INSERT INTO review_round
      (nwo,pr,reviewer,source_id,outcome,head_full,head10,event_at,classifier_version)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const r of rounds) ir.run(nwo, pr, r.reviewer, r.source_id, r.outcome, r.head_full, r.head10, r.event_at, version);
    const it = db.prepare(`INSERT INTO review_thread
      (nwo,pr,thread_id,reviewer,path,line,severity,is_resolved,is_outdated,
       resolved_by,resolved_at,is_cleared,excerpt,event_at,classifier_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const t of threads) it.run(nwo, pr, t.thread_id, t.reviewer, t.path, t.line, t.severity,
      t.is_resolved, t.is_outdated, t.resolved_by, t.resolved_at, t.is_cleared, t.excerpt, t.event_at, version);
    const ib = db.prepare(`INSERT INTO review_body_finding
      (nwo,pr,finding_id,reviewer,severity,is_cleared,excerpt,event_at,head_full,unreadable,classifier_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const f of bodyFindings) ib.run(nwo, pr, f.finding_id, f.reviewer, f.severity,
      f.is_cleared, f.excerpt, f.event_at, f.head_full, f.unreadable ?? 0, version);
    // The head is stored WITH the projection, in the same transaction as the rows
    // it explains. Clearing was computed against it, so a projection and the head
    // it describes are one fact and must not be able to drift apart.
    db.prepare(`INSERT INTO projection_meta (nwo,scope,classifier_version,derived_at,complete,head,body_derived)
                VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(nwo,scope) DO UPDATE SET
                  classifier_version=excluded.classifier_version,
                  derived_at=excluded.derived_at, complete=excluded.complete,
                  head=excluded.head, body_derived=excluded.body_derived`)
      .run(nwo, `pr:${pr}`, version, at, complete ? 1 : 0, head ?? null, bodyComplete ? 1 : 0);
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }

  return { rounds: rounds.length, threads: threads.length,
           bodyFindings: bodyFindings.length, bodyComplete, bodyAuthors: [...bodyAuthors], version };
}

/**
 * Reviewer availability, folded from every round on the repository.
 *
 * Repo-scoped, though the quota behind it is account-level. That is a known and
 * recorded limitation, not an oversight: it becomes wrong the day a second
 * project shares the account, and the fix is a home-level store.
 */
export function deriveSupply(db, nwo, profile, { at = Math.floor(Date.now() / 1000) } = {}) {
  const version = classifierVersion(profile);
  const logins = [...new Set(db.prepare("SELECT DISTINCT reviewer FROM review_round WHERE nwo=?").all(nwo).map(r => r.reviewer))];
  const out = [];
  for (const login of logins) {
    const last = db.prepare(
      `SELECT outcome, event_at FROM review_round WHERE nwo=? AND reviewer=?
        ORDER BY event_at DESC, rowid DESC LIMIT 1`).get(nwo, login);
    if (!last) continue;
    const state = last.outcome === "refusal" ? "down" : "up";
    const prev = db.prepare("SELECT state, supply_epoch FROM reviewer_supply WHERE nwo=? AND reviewer=?").get(nwo, login);
    // The epoch advances on RECOVERY, which is what lets a re-request that was
    // spent during a refusal band be issued again once the band ends.
    const epoch = (prev?.supply_epoch ?? 0) + (prev?.state === "down" && state === "up" ? 1 : 0);
    db.prepare(`INSERT INTO reviewer_supply (nwo,reviewer,state,since,supply_epoch,classifier_version)
                VALUES (?,?,?,?,?,?)
                ON CONFLICT(nwo,reviewer) DO UPDATE SET
                  state=excluded.state,
                  since=CASE WHEN reviewer_supply.state=excluded.state THEN reviewer_supply.since ELSE excluded.since END,
                  supply_epoch=excluded.supply_epoch,
                  classifier_version=excluded.classifier_version`)
      .run(nwo, login, state, at, epoch, version);
    out.push({ reviewer: login, state, epoch });
  }
  return out;
}

/**
 * Is what is stored still derivable by the code and detectors in force now?
 *
 * A projection under another version was produced by something that no longer
 * exists. Rebuilding covers EVERY row, not only open pull requests: supply and
 * the audit aggregate over merged ones too, so a rebuild scoped to open PRs
 * leaves a permanent island of rows nothing can re-derive.
 */
export function staleScopes(db, nwo, profile) {
  const version = classifierVersion(profile);
  return db.prepare("SELECT scope FROM projection_meta WHERE nwo=? AND classifier_version != ?")
    .all(nwo, version).map(r => r.scope);
}

/** What the gate reads: one snapshot, already derived. */
export function reviewState(db, nwo, pr, profile, { at = Math.floor(Date.now() / 1000), head = null } = {}) {
  const version = classifierVersion(profile);
  const meta = db.prepare("SELECT * FROM projection_meta WHERE nwo=? AND scope=?").get(nwo, `pr:${pr}`);
  const stale = profile?.watch?.staleSeconds ?? 900;
  // Ways to have no honest answer, and every one of them is UNKNOWN rather than
  // an empty one: never derived, derived by something else, derived from an
  // incomplete read, derived too long ago, or derived for a DIFFERENT REVISION.
  if (!meta) return { readable: false, why: "no projection for this pull request" };
  if (meta.classifier_version !== version) return { readable: false, why: "projection predates the current classifier" };
  if (!meta.complete) return { readable: false, why: "the observation behind this projection was incomplete" };
  if (at - meta.derived_at > stale) return { readable: false, why: `projection is older than ${stale}s` };
  // The revision check, and it is the one a caller is most likely to skip because
  // the projection looks perfectly fresh without it.
  //
  // Clearing is computed against a head: the same threads under a different head
  // give a different answer to "what is still open". A projection derived for the
  // previous head is not stale by the clock and is still wrong, and the two facts
  // it feeds -- how many criticals are open, and which threads they are -- are
  // exactly the ones that license spilling a finding or sending a worker at it.
  //
  // Asked only when the caller names a head. A caller that does not care about a
  // revision (the shadow log) keeps the old behaviour; a caller that is going to
  // DECIDE something passes one, and gets UNKNOWN rather than a confident answer
  // about the wrong commit.
  if (head) {
    if (!meta.head) return { readable: false, why: "the projection does not record which head it was derived for" };
    if (meta.head !== head) return { readable: false, why: `projection was derived for ${String(meta.head).slice(0, 10)}, not ${String(head).slice(0, 10)}` };
  }

  const threads = db.prepare("SELECT * FROM review_thread WHERE nwo=? AND pr=?").all(nwo, pr);
  const open = threads.filter(t => !t.is_cleared);
  const blocking = open.filter(t => BLOCKING_SEVERITIES.has(t.severity));
  const body = db.prepare("SELECT * FROM review_body_finding WHERE nwo=? AND pr=?").all(nwo, pr);
  const bodyOpen = body.filter(f => !f.is_cleared);
  const bodyBlocking = bodyOpen.filter(f => BLOCKING_SEVERITIES.has(f.severity));
  // The two populations are counted together and ROUTED apart. Both keep a spill
  // from happening; only one of them is work a worker can do.
  const unreadable = bodyOpen.filter(f => f.unreadable);
  const realBody = bodyOpen.filter(f => !f.unreadable);
  const rounds = db.prepare(
    `SELECT reviewer, COUNT(DISTINCT head10) n FROM review_round
      WHERE nwo=? AND pr=? AND outcome IN ('findings','clean') AND head10 IS NOT NULL
      GROUP BY reviewer`).all(nwo, pr);
  const blockingLogins = new Set((profile?.reviewers ?? []).filter(r => r.kind === "blocking").map(r => r.login));
  // MAX over blocking reviewers, never the sum: two reviewers each answering once
  // is round one, not round two.
  const n = rounds.filter(r => blockingLogins.has(r.reviewer)).reduce((m, r) => Math.max(m, r.n), 0);

  return {
    readable: true,
    // Whether the count below can be COMPLETE, which today it cannot.
    //
    // The fold classifies severity for `review_thread` rows only. A substantive
    // review BODY is classified into a round outcome and its individual findings
    // are never projected -- so a P0 stated in a body with no matching inline
    // thread is invisible here. Every other reader of this number tolerates that;
    // one does not. A known zero is what licenses SPILL, and spilling a critical
    // is the single thing the standing ruling forbids outright, so a zero that
    // might be missing a body-only critical is worse than no answer at all.
    //
    // Reported rather than assumed by callers. A caller that only wants to SHOW
    // the open findings may use them regardless; a caller about to spend the
    // number on a decision must not.
    bodyFindingsDerived: !!meta.body_derived,
    // THREAD counts, and they stay thread-only however many body findings there
    // are. `compare` measures these three against a live read of GitHub's review
    // threads, so a body finding counted here is a disagreement that can never
    // resolve -- and a permanent disagreement turns every downstream answer
    // UNKNOWN, which would take the whole review path dark to add a number.
    total: threads.length, open: open.length,
    // What GitHub itself calls resolved, which is a DIFFERENT question from
    // cleared and is the one a live read can be compared against.
    resolved: threads.filter(t => t.is_resolved).length,
    // Severity counts every reviewer, rostered or not, blocking or advisory: a
    // P0 is a P0 whoever filed it, and blocking-ness gates coverage not severity.
    // TWO COUNTS, because two different questions are asked of them.
    //
    // `unspilledCritical` counts EVERY reviewer: spilling a critical is forbidden
    // whoever filed it, so an advisory reviewer's P0 must still stop a spill.
    //
    // `blockingCritical` counts only reviewers whose opinion gates a merge, and it
    // is what the round cap reads. One number serving both made an advisory
    // reviewer's critical BLOCK at the cap while every gating clause passed — the
    // pull request escalating on an opinion the profile says is advisory.
    unspilledCritical: blocking.length + bodyBlocking.length,
    blockingCritical: blocking.filter(t => blockingLogins.has(t.reviewer)).length +
                      bodyBlocking.filter(f => blockingLogins.has(f.reviewer)).length,
    // The body population, reported on its own as well as folded into the count
    // above, so a reader can tell WHICH kind of finding is holding a pull request.
    bodyTotal: body.length, bodyOpen: bodyOpen.length,
    rounds: n,
    // ONE list, because everything downstream of it -- what blocks a merge, what
    // a worker is sent at -- treats both kinds the same way. `anchor` is what
    // stops them being treated the same where they differ: a thread can be
    // replied to and resolved, a body finding has no GitHub object at all, and a
    // worker told to resolve one would be given an instruction that cannot
    // succeed.
    threads: [
      ...open.map(t => ({ id: t.thread_id, reviewer: t.reviewer, path: t.path,
                          line: t.line, severity: t.severity, excerpt: t.excerpt,
                          anchor: "thread" })),
      // Sentinels are NOT here. This list is what a worker is dispatched at, and
      // there is nothing in "reeve cannot parse this reviewer" for a worker to do:
      // no code is wrong, no thread exists, and the fix is a line of profile only
      // the operator can write. It travels as its own fact below instead.
      ...realBody.map(f => ({ id: f.finding_id, reviewer: f.reviewer, path: null,
                              line: null, severity: f.severity, excerpt: f.excerpt,
                              anchor: "body" })),
    ],
    // Bodies reeve could not read, whoever wrote them. Deliberately NOT scoped to
    // blocking reviewers the way findings are: blocking-ness answers whose opinion
    // gates a merge, and this is not an opinion — it is reeve saying it does not
    // know what was said. A stranger's unread body is exactly as unread as a
    // configured reviewer's.
    unreadableBodies: unreadable.map(f => ({ reviewer: f.reviewer, excerpt: f.excerpt })),
  };
}
