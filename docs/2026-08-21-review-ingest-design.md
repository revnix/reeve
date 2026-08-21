# Review ingest — design

**Date:** 2026-08-21.
**Status:** designed, not built. Produced by a 14-agent research pass — four
parallel measurers (code audit, live thread data, reviewer behavior, prior art),
three independent designs, three judges, one synthesis, three adversarial
verifiers — then edited by hand against the verifiers' findings. Every verifier
returned **SOUND-WITH-FIXES**; every fix is folded in below and listed in §12 so
nothing is silently patched.
**Rule for reading:** claims marked *measured* were established on live GitHub
data on 2026-08-21 and cite where. Claims marked **PROVISIONAL** name the
measurement that would settle them.

---

## 1. What this is

Review ingest is the half of reeve that reads what reviewers said — findings,
threads, rounds, clean passes, refusals — into durable state the verdict can
consume, so that the three gated actions (FIX_FINDINGS, REQUEST_REVIEW, SPILL)
can be turned on. Today the verdict's review clauses run on partial live reads:
rounds are latest-head-only, severity is `null`, threads are counted but never
identified, and `watch.reviewActions` correctly forces every review action to
ESCALATE.

**Goals:** durable, recomputable review evidence; a review clause that can
honestly move off UNKNOWN; FIX_FINDINGS payloads with real thread identity;
round and severity accounting that honors the founder rulings (soft cap, hard
cap, criticals are NEVER spilled).

**Non-goals:** a paid reviewer (ruled out); reeve reviewing PRs itself; replacing
the human trigger loop that exists on nextly (a teammate summons the bots and
resolves threads — ingest must read that world, not fight it).

---

## 2. Measured reality — what shapes every decision below

From live measurement of nextlyhq/nextly PRs #308–#1128 (10+ PRs sampled, three
bots observed):

1. **Codex reviews carry the FULL 40-hex `commit_id` in the API.** Only comment
   *bodies* abbreviate (10-hex). The long-standing note "both bots abbreviate"
   is true only of bodies. → Coverage binding for review objects is exact string
   match; prefix matching survives only for body-bound clean passes.
2. **Codex's clean pass has TWO shapes by trigger.** Command-triggered: an issue
   comment with stable prefix "Codex Review: Didn't find any major issues" naming
   an abbreviated commit. Push-triggered: **a +1 reaction on the PR issue** — no
   comment, no review, no commit binding, and GitHub reactions are unique per
   (user, emoji, item), so a second push-triggered clean pass leaves NO new
   event at all.
3. **Codex refusals are a quota BAND, not a rate.** Measured: 15/15 refusals in
   one 7-hour band, then ~30 straight answers over 29 hours. The historical
   "79–86% refused" is a property of when we sampled, not of the reviewer.
   → Supply is a state machine, not a percentage.
4. **CodeRabbit fails green rampantly**: commit status `state=success`,
   `description="Review rate limited"` on **8 of 9** sampled final heads; a
   second variant reports success with "Review completed" on a path-filter SKIP.
   A merged PR's final head can be green-but-never-reviewed (#1127).
5. **CodeRabbit's finding taxonomy has ALREADY been replaced once.** The
   "Potential issue"/"Refactor suggestion" strings appear ZERO times in ~40
   current bodies; today's grammar is a category|severity|effort triple. Any
   hard-coded taxonomy will rot; classification must be versioned and re-runnable.
6. **CodeRabbit edits instead of appending.** Its summary comment is a living
   document; it retro-edits inline findings to record resolution ("✅ Addressed
   in commit <7-hex>") and edits statuses. An append-only ingest that keys on
   comment id alone loses history.
7. **A CodeRabbit clean pass was NEVER observed** ("Actionable comments posted:
   0" occurs zero times in 20 PRs). On this repo, absence of a CodeRabbit
   review means skipped or limited — never clean.
8. **Thread node ids (`PRRT_…`) are stable across pushes AND force pushes**
   (measured on force-pushed PRs). A force push at most marks a thread outdated.
   → The thread id is the identity anchor.
9. **coderabbitai[bot] resolves its OWN threads**, including single-comment
   threads nobody replied to (8 on #1121), and `@coderabbitai resolve` is
   author-invokable and bulk-resolves. → `isResolved` testifies nothing about a
   human accepting a finding.
10. **0-byte COMMENTED reviews are everywhere** — every inline reply by bot or
    human mints one (nine at a single commit on #1124). → Counting review
    objects or distinct commit_ids overstates rounds.
11. **Committer-date is a wrong push proxy** (913-minute false latency measured
    on #1123/#1124). GitHub's timeline has push-time only for force pushes.
    → Windows must come from reeve's own head-first-seen watermark.
12. **Both bots auto-review every push**; #1125 saw 5 rounds in one day with no
    human trigger. → Raw round counts inflate on active PRs; cap semantics must
    account for it (§15a).
13. **A third bot exists**: greptile-apps[bot], currently paused ("used its 100
    free credits"). Generality is not hypothetical.
14. **Post-merge reviews happen**: #1123 got CHANGES_REQUESTED twelve minutes
    AFTER merging, flipping `reviewDecision` on a merged PR. → Audit evidence
    must be pinned at merge time.
15. **reeve's own check concludes `neutral` in shadow — and GitHub treats
    neutral/skipped required checks as PASSING.** → Enforcement day must switch
    BLOCK→`failure` and UNKNOWN→`action_required` (§12, E-1).
16. The repo's review protocol lives at `.github/review-prompt.md`;
    `tasks/pr-review-prompt.md` no longer exists (stale memory).

---

## 3. Defects in the CURRENT system, independent of ingest — fix first

Found by the code audit; each is live today.

| # | Defect | Where | Fix |
|---|---|---|---|
| F-1 | **CodeRabbit fail-green counts as a passing check.** `readChecks` carries the status description *because* the rate-limit truth hides there, but `classify()` never reads it | reconciler.mjs:128–137 | New profile key `ci.reviewerStatusContexts`; contexts listed there are excluded from check classification entirely. Reviewer signals belong to the review pipeline, never to CI. Kills both fail-green shapes |
| F-2 | `NOT_INSTALLED` is promised, consumed by the verdict, and **never produced** — a declared-but-absent blocking reviewer reads "not yet run" forever instead of escalating REVIEWERS_DOWN | pr.mjs:74 vs verdict.mjs:91 | Produce it: no event from a rostered reviewer across N ticks after first trigger → NOT_INSTALLED |
| F-3 | **Refusal detection reads only the LAST own comment** — a refusal followed by any later own comment goes invisible | pr.mjs:77–80 | Scan all comments in the window; supersede a refusal only by a later *substantive* event (feeds the §7.5 band model) |
| F-4 | Review `.state` and `.body` are fetched and **discarded** — CHANGES_REQUESTED and APPROVED both read as "covered" | pr.mjs:83–84 | Ingest keeps them (§5); the verdict distinguishes outcome (§8) |
| F-5 | The gated escalation key embedded the thread COUNT — three phone pushes in one morning for one unchanged condition | watcher.mjs | **FIXED 2026-08-21** (`c21ace0`): key = which action is gated; count rides `detail` |
| F-6 | `watch.staleSeconds` has no default, and the freshness spine will hang on it | schema.mjs | `withDefaults`: 900. A missing default is Infinity, and Infinity is fail-open |

F-1/F-2/F-3/F-6 are **PR-1** in the rollout (§13) — small, independently
testable, and they de-risk everything after.

---

## 4. Architecture

```
GitHub  ──ingest──▶  inbox (append-only raw observations, already in schema)
                        │  pure fold, one tx per PR, full re-fold
                        ▼
              projections (review_round, review_thread, finding,
                           reviewer_supply, projection_meta)
                        │  stamped with classifier_version
                        ▼
              evaluatePr reads PROJECTIONS ONLY (single snapshot)
                        ▼
              verdict clauses (typed causes)  ──▶  watcher  ──▶  actions
```

Three load-bearing choices, each earned by a measured failure:

**The unwired `inbox` table is the spine.** It already exists in `schema.sql`
(source/external_id dedup, kinds `review_comment|check_run|review`) with zero
writers. Raw observations land append-only; everything the gate consumes is a
*projection* that can be dropped and rebuilt. Because CodeRabbit's taxonomy has
already changed once (§2.5), re-derivation is not hygiene — it is the only way a
classifier improvement reaches history.

**Edited objects are generations, not updates.** CodeRabbit edits constantly
(§2.6). An observation whose `content_hash` changed appends a new generation row
(same source/external_id, generation+1); the fold reads the latest generation
but history survives. `event_at` is GitHub's timestamp; a retro-edit's only
honest time is `updated_at`, stored as such and never used as an event ordering
(verifier hole, §12 V-11).

**The fold is total, per-PR, transactional.** One tx per PR per tick: DELETE
that PR's projection rows, re-fold from inbox. Measured volumes (≤29 threads,
≤5 rounds, ≤66 comments per PR) make incremental cursors a complexity with no
payoff — and a full re-fold cannot half-apply. `processed_at` on inbox stays
unused; full-refold is the contract (verifier hole, §12 V-9).

---

## 5. Data model

New tables (STRICT, like everything else in schema.sql):

```sql
-- Every head reeve has ever pinned, with when IT first saw it. This is the
-- push-time watermark (committer-date measured 913 min wrong, §2.11) and the
-- resolver for abbreviated shas (§7.1).
CREATE TABLE IF NOT EXISTS head_seen (
  nwo TEXT NOT NULL, pr INTEGER NOT NULL,
  sha TEXT NOT NULL CHECK (length(sha) = 40),
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (nwo, pr, sha)) STRICT;

-- One substantive answer by one reviewer at one revision. NOT one review object:
-- 0-byte COMMENTED carriers (every inline reply mints one, §2.10) never land here.
CREATE TABLE IF NOT EXISTS review_round (
  nwo TEXT NOT NULL, pr INTEGER NOT NULL,
  reviewer TEXT NOT NULL,               -- login, rostered or not
  head_full TEXT,                       -- 40-hex when the API gave it (§2.1)
  head_abbrev TEXT,                     -- 7-40 hex from a body, when that is all there is
  head10 TEXT,                          -- resolved via head_seen; NULL = unbound
  outcome TEXT NOT NULL CHECK (outcome IN
    ('findings','clean','refusal','skip','unbound_clean')),
  event_at INTEGER NOT NULL,            -- GitHub's timestamp
  source_id TEXT NOT NULL,              -- review id / comment id / reaction key
  classifier_version TEXT NOT NULL,
  PRIMARY KEY (nwo, pr, reviewer, source_id)) STRICT;

-- One review thread, identity = GitHub's stable node id (§2.8).
CREATE TABLE IF NOT EXISTS review_thread (
  nwo TEXT NOT NULL, pr INTEGER NOT NULL,
  thread_id TEXT NOT NULL,              -- PRRT_...
  reviewer TEXT NOT NULL,               -- author of the first comment
  path TEXT, line INTEGER,
  severity TEXT NOT NULL CHECK (severity IN
    ('critical','major','minor','nit','unknown')),
  is_resolved INTEGER NOT NULL,
  is_outdated INTEGER NOT NULL,
  resolved_by TEXT,                     -- login; NULL while unresolved
  resolved_at INTEGER,
  first_comment_excerpt TEXT NOT NULL,  -- for prompts and `reeve why`
  filed_in_round TEXT,                  -- review_round.source_id
  classifier_version TEXT NOT NULL,
  PRIMARY KEY (nwo, pr, thread_id)) STRICT;

-- Findings that never become threads: review-BODY findings (Codex P-badges,
-- CodeRabbit body-only nitpicks/outside-diff findings). Verifier-critical §12 V-3.
CREATE TABLE IF NOT EXISTS body_finding (
  nwo TEXT NOT NULL, pr INTEGER NOT NULL,
  reviewer TEXT NOT NULL,
  round_source_id TEXT NOT NULL,        -- the round that filed it
  ordinal INTEGER NOT NULL,             -- position within that body
  severity TEXT NOT NULL CHECK (severity IN
    ('critical','major','minor','nit','unknown')),
  title TEXT NOT NULL,
  classifier_version TEXT NOT NULL,
  PRIMARY KEY (nwo, pr, reviewer, round_source_id, ordinal)) STRICT;

-- Per-reviewer availability as a BAND state machine, not a rate (§2.3).
CREATE TABLE IF NOT EXISTS reviewer_supply (
  nwo TEXT NOT NULL, reviewer TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('up','down','never_seen')),
  since INTEGER NOT NULL,
  reset_hint INTEGER,                   -- parsed when the bot names one
  supply_epoch INTEGER NOT NULL DEFAULT 0,  -- bumps on down->up; keys re-requests
  PRIMARY KEY (nwo, reviewer)) STRICT;

-- What derived the projections, so a classifier change is detectable.
CREATE TABLE IF NOT EXISTS projection_meta (
  nwo TEXT NOT NULL, scope TEXT NOT NULL,   -- 'pr:<n>' or 'repo'
  classifier_version TEXT NOT NULL,
  derived_at INTEGER NOT NULL,
  ingest_complete INTEGER NOT NULL,     -- 0 = a fetch failed or truncated
  PRIMARY KEY (nwo, scope)) STRICT;
```

`classifier_version = hash(derivation source files + the profile's detector
block)`. On mismatch: projections rebuild from inbox — **all rows, not only open
PRs** (reviewer_supply and the audit aggregate over merged PRs too; verifier
hole §12 V-10).

---

## 6. Profile schema additions

All reviewer-specific text lives here. Core knows only the neutral vocabulary
`critical|major|minor|nit|unknown`.

```
reviewers[].clean            regex for a clean-pass comment (Codex: the stable prefix)
reviewers[].cleanReaction    "+1" — the push-triggered reaction shape (§2.2), or absent
reviewers[].commitPattern    regex extracting the revision a body names
reviewers[].severityMarkers  ordered [ [regex, severity], ... ]  (P-badges; category|severity|effort)
reviewers[].bodyFindings     regex splitting a findings body into finding blocks
reviewers[].failGreen        regex on status descriptions that voids a success ("Review rate limited", "Review completed" on skip)
reviewers[].trigger          comment that summons a round ("@codex review")
reviewers[].resolveCommand   author-invokable bulk-resolve ("@coderabbitai resolve") — recorded so its resolutions are never trusted
ci.reviewerStatusContexts    status contexts excluded from CI classification (F-1)
watch.staleSeconds           default 900 (F-6)
watch.reviewActions          becomes per-action: { fixFindings, requestReview, spill } — three switches, thrown in order (§9)
```

**Cross-field validation (ERROR, not warning):** a `kind:"blocking"` reviewer
must declare `clean` or `cleanReaction`, and `commitPattern` — a blocking
reviewer whose clean pass cannot be detected is UNKNOWN forever, and that must
be a refused profile, not a silent one.

**Doctor positive controls:** for every detector regex, doctor proves it matches
at least one historical inbox event (or reports "detector has never matched
anything — broken or new"). A detector that matches nothing is how the taxonomy
change (§2.5) stays invisible for a month.

**Unrostered reviewers degrade gracefully:** threads by a login not in the
profile still ingest (severity `unknown` unless core-recognizable), still count
in `unspilledCritical` (fail closed — §8), and surface in `status` as
"unrostered reviewer active: greptile-apps[bot]".

---

## 7. Algorithms

### 7.1 Revision binding
A review object's `commit_id` (full 40-hex, §2.1) binds exactly. A body-named
abbreviated sha resolves against `head_seen` for that PR: unique prefix match →
bound to that full sha; ambiguous or unknown → **unbound** (never covers, never
counts as a round; surfaces as `unbound_clean` in the audit). `head10 =
substr(resolved_full, 1, 10)` always — the 7-hex-vs-10-char mismatch cannot
arise because head10 is never derived from an abbreviation directly (verifier
holes §12 V-7).

### 7.2 Rounds
A round is a **substantive** answer: `outcome IN ('findings','clean')`, bound to
a head. Refusals, skips, carriers (0-byte replies) and unbound cleans are
recorded but are not rounds. `rounds.n` = MAX over blocking reviewers of
`COUNT(DISTINCT head10)` of that reviewer's substantive rounds. Auto-review
inflation is real (§2.12) and makes n a measure of PR churn, not of reeve's fix
loop — consequences and the founder decision in §15a.

### 7.3 Severity
Thread severity: first comment matched against the author's `severityMarkers`,
first hit wins; no hit → `unknown`. Body findings: split by `bodyFindings`,
each block classified the same way. **`unknown` is treated as critical by every
gate** — an unclassifiable finding is never spillable and always blocks past the
cap. This is the founder's severity ruling made mechanical: fail closed on
ignorance.

```
unspilledCritical =
    COUNT(review_thread WHERE NOT cleared (§7.6) AND severity IN ('critical','unknown'))
  + COUNT(body_finding  WHERE round is the reviewer's LATEST substantive round
                        AND severity IN ('critical','unknown'))
```

— from **any rostered or unrostered reviewer**, blocking or advisory. A P0 is a
P0 whoever filed it; blocking-ness gates coverage, never severity (verifier
hole §12 V-8). Body findings clear by supersession: a newer substantive round by
the same reviewer restates what still stands (measured Codex behavior), so only
the latest round's body findings count.

### 7.4 Clean pass
Per reviewer, in priority order: (1) a review object with zero findings at a
bound head — never observed from CodeRabbit (§2.7) but the general shape;
(2) a `clean`-matching comment with a body-bound revision; (3) a
`cleanReaction` — which binds to NO revision and therefore lands as
`unbound_clean`: recorded, shown in `why`, **never coverage**. The verifier
proved a second push-triggered clean leaves no event at all (§2.2), so
reaction-cleans cannot be load-bearing evidence; the profile's `trigger` exists
precisely to summon a bindable answer instead.

### 7.5 Reviewer supply (the band model)
`down` on a refusal event (with `reset_hint` when the text names one);
`up` on any substantive event; `never_seen` until the first event ever.
DOWN→UP bumps `supply_epoch`. REQUEST_REVIEW is suppressed while `down`
(feeds REVIEWERS_DOWN instead), and its outbox idem key is
`(pr, head10, reviewer, supply_epoch)` — so a refusal does not permanently
starve the re-request (the old key is spent; recovery mints a new epoch and
with it a fresh key). Deterministic, no timers (verifier hole §12 V-5).
**PROVISIONAL:** supply is repo-scoped though Codex quota is account-level;
correct once a second project exists (§15c).

### 7.6 Resolution trust — the rule three verifiers converged on
`isResolved` is a **claim**, whoever made it: the author can bulk-resolve via
the bot's own command (§2.9), the bot resolves its own threads unprompted, and
reeve's worker resolves under the founder's token. A resolved thread is
**cleared** only when:

> resolved, AND a substantive round by the SAME reviewer exists with
> `event_at > resolved_at`, bound to a head that covers the current pinned head.

The first design's version ("resolved counts once a covering round exists") was
killed by two verifiers independently: the round that FILED the finding is
itself a covering round, so author-resolve-without-fixing passed immediately.
The subsequent-round requirement closes it, and composes with the worker flow:
FIX_FINDINGS fixes → pushes → REQUEST_REVIEW summons a round → the new round
clears what was genuinely fixed and re-files what was not.

### 7.7 Freshness and the single snapshot
Ingest runs first in the tick; the verdict reads projections only. The review,
threads, rounds and findings clauses all answer from ONE snapshot, killing the
intra-tick race a verifier constructed (review lands between two live reads —
§12 V-4). Two guards on top: `projection_meta.ingest_complete = 0` or
`derived_at` older than `watch.staleSeconds` → every review-family clause
answers UNKNOWN with cause `stale`; and coverage PASS requires the covering
round to have been present in **two consecutive snapshots** (the CI settlement
pattern reused) — one extra tick of latency, bought as insurance against
half-landed review+thread writes.

---

## 8. Verdict integration

The review clause consumes typed evidence, not strings:

```
{ reviewer, kind, state,            -- CLEAN | VERDICT | REFUSED | NOT_INSTALLED | NOT_RUN
  outcome,                          -- findings | clean  (F-4: CHANGES_REQUESTED ≠ covered-clean)
  boundHead, coveredAtPinned,       -- exact match for API-bound, resolved-prefix for body-bound
  cause }                           -- 'not_run' | 'unreachable' | 'stale' | 'unbound'
```

and the watcher branches on `cause`, never on regex-matching the detail string
(today's `/not yet run/` match is one wording change from silently dead).

Clause rules (all existing states preserved, three sharpened):

- A reviewer whose latest substantive outcome is `findings` at the pinned head
  is **covered but not clean**: review clause PASSes coverage, while its
  findings live in the threads/findings clauses — which now actually see them.
- The rounds clause reads real `unspilledCritical`. Its old `null > 0` shape —
  at the hard cap with UNKNOWN criticals it rendered PASS — becomes: criticals
  unknowable (stale ingest) at or past the soft cap → **UNKNOWN**, never PASS.
- "No blocking reviewer configured → PASS" survives (nextly today), but the
  threads/findings clauses still consume projections behind the freshness gate,
  so an advisory-only repo with dead ingest reads UNKNOWN, not clean
  (verifier hole §12 V-6).

**Escalation keys** stay a closed, enumerated, tested set — including the three
gated-action keys that already exist (`c21ace0`), plus `review ingest is stale`
(emitted with count=1 always: it is one condition however many PRs it touches)
and the existing CAP_WITH_CRITICAL / REVIEWERS_DOWN. The test walks every
watcher path and asserts no key outside the set can reach the notifier, and no
key contains a digit.

---

## 9. Worker enablement — three switches, thrown in order

`watch.reviewActions` becomes `{ fixFindings, requestReview, spill }`; the gate
checks per action; absent keys stay OFF (the strict-boolean lesson kept).

1. **FIX_FINDINGS** first. Payload per thread: `{thread_id, path, line,
   severity, first_comment_excerpt, reviewer}`. The worker fixes and replies;
   it may resolve, but §7.6 means only the next round clears the thread — the
   worker's own resolution is structurally untrusted, as it must be (it runs
   under the founder's identity; verifier hole §12 V-12).
2. **REQUEST_REVIEW** second: posts `reviewers[].trigger` through the outbox
   with the supply-epoch idem key; suppressed while supply is `down`.
3. **SPILL** last, and **only after the founder decision in §15a** — under
   auto-reviewing bots, round counts inflate with push activity, and SPILL's
   precondition (`n >= softCap AND unspilledCritical === 0`) fires *more*
   eagerly on exactly the busiest PRs. Until decided, SPILL stays gated and the
   cap escalates instead. Criticals are never spilled is already mechanical:
   `unknown` counts as critical, and the strict `=== 0` survives.

---

## 10. Operator surfaces

- `reeve status`: per PR, a review line — `codex ✓@34952fb  coderabbit ✗rate-limited
  since 06:14  threads 18/22 open (2 critical)  round 3/5`.
- `reeve why <pr>`: the thread table (id, path, severity, resolved-but-uncleared
  flag with WHY it has not cleared), rounds per reviewer with bound heads, the
  supply band, and which clause each fact fed.
- The phone: only the closed key set. Counts and paths live in `detail`.
- Dash: same projections, no extra reads.

## 11. API budget (verifier-critical: it was unbudgeted)

Ingest adds ~5 REST + 1–2 GraphQL per PR per tick *if run unconditionally*. It
is not: the PR list call gains `updatedAt`, and ingest for a PR is skipped
entirely unless `updatedAt` moved past the last ingest watermark (backstop: full
ingest every 20th tick). Measured fleet shape (5 open PRs, mostly quiet):
steady-state ≈ 1 active PR × 7 calls ≈ **7 extra calls/tick**, ~170/hour against
the App's 5,000/hour — under 4%. Exhaustion → `ingest_complete=0` → UNKNOWN,
never silence.

## 12. The attack ledger — every verifier hole and its disposition

| # | Hole (severity) | Disposition |
|---|---|---|
| V-1 | Resolution rule satisfied by the filing round (critical ×2) | §7.6 subsequent-round requirement |
| V-2 | Bot/author bulk-resolve trusted (critical) | §7.6: resolution is a claim regardless of resolver |
| V-3 | Body-only findings escape the severity gate (critical) | `body_finding` table + supersession clearing (§7.3) |
| V-4 | Intra-tick read race: review lands between thread-read and verdict (critical) | Single snapshot + two-tick coverage settle (§7.7) |
| V-5 | Idem key permanently starves re-request after a refusal (serious) | supply_epoch in the key (§7.5) |
| V-6 | Advisory-only repo bypasses freshness via the no-blocking PASS (minor) | Threads/findings clauses gate on freshness independently (§8) |
| V-7 | 7-hex binding can never equal a 10-char head10 (serious ×2) | head10 only ever derived from a head_seen-resolved full sha (§7.1) |
| V-8 | Advisory criticals excluded from unspilledCritical (minor) | Severity counts every reviewer (§7.3) |
| V-9 | Fold transactional unit unstated; incremental cursor ambiguity (serious) | Full re-fold per PR in one tx; processed_at retired (§4) |
| V-10 | classifier_version rebuild scoped to open PRs only (minor ×2) | Rebuild covers all rows (§5) |
| V-11 | Retro-edits have no event timestamp (minor) | Generations store updated_at as updated_at; never an event ordering (§4) |
| V-12 | The worker resolves under the founder's identity (serious) | §7.6 makes it structurally irrelevant; §9.1 documents it |
| V-13 | "review ingest stale" key would count-flap (serious) | Emitted count=1 constant (§8) |
| V-14 | staleSeconds unset = Infinity (minor) | Default 900 in withDefaults (F-6) |
| V-15 | Push-time from committer-date is wrong (serious) | head_seen watermark (§5, §2.11) |
| V-16 | Round counts inflate under auto-review (serious) | Escalate-not-spill until §15a is decided |
| V-17 | reviewer_supply repo-scoped vs account-level quota (serious ×2) | PROVISIONAL §15c |
| E-1 | Shadow `neutral` conclusion counts as PASSING for required checks (serious) | Enforcement-day switch: BLOCK→failure, UNKNOWN→action_required, with a test; added to the ruleset-flip checklist |

## 13. Rollout — PR sequence, each with its own verification

1. **PR-1 fix-now — DONE** (`80aeac1`, `94f13f7`). F-1/F-2/F-3/F-6, each with a
   stub-verified test. Confirmed live: `CodeRabbit state=success desc=Review rate
   limited` on #1128's head no longer reaches classification. It also
   reintroduced the stale-settlement-floor incident within a minute of shipping,
   so CHECK_ACCOUNTING is now held by a fingerprint over the code that decides
   what counts, rather than by remembering to bump it.
2. **PR-2 ingest writers — DONE** (`5754691`). head_seen, inbox generations, and
   the reshape of a table that had existed with zero writers since the beginning.
   Live on nextly: 159 observations across five PRs; a tick over unchanged PRs
   writes nothing; a tick where Codex filed a new review with three P2 threads
   captured exactly those four objects, and rows still equal distinct objects, so
   no re-hash churn. It also caught a defect no unit test would have found — one
   App answering to two logins (`coderabbitai[bot]` over REST, `coderabbitai`
   over GraphQL), which would have halved every reviewer's evidence at derivation
   time and errored nowhere.
3. **PR-3 projections + fold** + classifier_version + doctor detector controls.
   Verify: DELETE projections, re-fold, byte-identical; taxonomy-change drill
   (edit a marker regex → version changes → rebuild observed).
4. **PR-4 shadow-compare**: `status --review-shadow` prints projection-derived
   counts beside today's live-read counts for every open PR. Runs until they
   agree for **5 consecutive days** where comparable (thread totals/unresolved),
   with every divergence explained in writing. This is the CI-settlement proof
   pattern applied to review data.
5. **PR-5 verdict consumes projections** (§7.7, §8, typed causes, real
   unspilledCritical). Still all actions gated. Verify: #1128's verdict
   recomputed from projections matches the hand-read truth; the V-1 and V-4
   attack scenarios replayed as tests.
6. **PR-6 FIX_FINDINGS on** (nextly, founder watching, one worker).
7. **PR-7 REQUEST_REVIEW on** (supply-epoch keys, band suppression).
8. **PR-8 SPILL** — only after §15a.

## 14. Test plan — property and the stub that must fail it

| Property | Stub that must go red |
|---|---|
| A filing round cannot clear its own thread | Drop the `event_at > resolved_at` term |
| Bot bulk-resolve clears nothing | Mark resolver trusted for reviewer_bot |
| An unclassifiable finding blocks past the cap | Map `unknown` to `minor` |
| Body findings feed unspilledCritical | Count threads only |
| A stale projection answers UNKNOWN, never PASS | Force `derived_at = now` |
| Two ticks, same GitHub state → zero new inbox rows | Break content_hash |
| Re-fold after DELETE is byte-identical | Introduce a Date.now() into the fold |
| An unbound clean never covers | Let `unbound_clean` satisfy coverage |
| A 7-hex body sha binds only via head_seen | Substr the abbreviation directly |
| A refusal then recovery re-requests exactly once | Remove supply_epoch from the key |
| No escalation key outside the closed set, none with a digit | Add a count to any key |
| Reviewer status contexts never classify as CI | Empty `reviewerStatusContexts` on the fixture profile |
| Enforcement mode never publishes neutral | Flip the conclusion map |

Every test lands with the stub run recorded (control green → stub applied →
the RIGHT assertion red → restore green), per the standing verification rule.

## 15. Founder decisions — SETTLED 2026-08-21

Taken on the founder's instruction to proceed on recommendations.

a. **SPILL stays OFF indefinitely.** Bots auto-review every push, so round counts
   measure PR churn rather than reeve's fix loop, and SPILL's precondition fires
   most eagerly on the busiest PRs. Escalation at the cap was always the honest
   behaviour. Revisit only if FIX_FINDINGS running for a while shows a real need.
b. **Advisory criticals block.** A P0 is a P0 whoever filed it; blocking-ness
   gates coverage, never severity. As specified in §7.3.
c. **Supply stays repo-scoped**, revisited when a second project exists (§16).
d. **No human resolution override.** The cost of strictness is one bot round,
   which REQUEST_REVIEW automates.
e. **Greptile stays unrostered.** Measured: it publishes no commit-status context
   at all, and graceful degradation already counts its threads at severity
   `unknown`, which fails closed.

### The options as originally posed

a. **SPILL semantics under auto-review.** Rounds now measure PR churn, not
   reeve's loop. Options: (1) keep SPILL off indefinitely — escalation at the
   cap has been the honest behavior all along; (2) redefine the cap to count
   only reeve-initiated fix→review cycles. Recommendation: **(1)** until reeve
   has run FIX_FINDINGS for a while and the real need is measured.
b. **Advisory criticals block** (design says yes — a P0 is a P0). Confirm.
c. **Account-level supply sharing** — when the second project arrives, supply
   moves to a home-level store. Timing decision only.
d. **Human resolution override** — a founder-only fast-path past §7.6 (e.g. a
   magic token in the resolving comment). Recommendation: defer; the cost of
   strictness is one bot round, which REQUEST_REVIEW automates.
e. **Greptile**: roster as advisory with its own markers, or leave unrostered
   (it still counts via graceful degradation). Cheap either way.

## 16. Provisional register

| Decision | Settling measurement |
|---|---|
| Supply repo-scoping (V-17) | First refusal band observed from a second project's store |
| Two-tick coverage settle margin | Distribution of review→thread visibility lag over a week of ingest |
| Backstop full-ingest every 20th tick | Rate of updatedAt-invisible changes (measured zero so far) |
| CodeRabbit clean-pass shape | First observed "Actionable comments posted: 0" on this repo |
