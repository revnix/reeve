# reeve — handoff

**Written:** 2026-08-21, end of the third build session.
**Audience:** the next session, which will have none of this in context.
**Rule for reading:** every number was measured, not remembered. Where something
is unproven it says so. Trust the "unproven" labels as much as the numbers, and
re-measure anything you are about to act on.

`docs/USING-REEVE.md` is the founder-facing version — short, and the document
that states what reeve is NOT. `docs/2026-08-21-review-ingest-design.md` is the
design and adversarial-attack ledger for the review half.

---

## 0. The single most important thing to understand

> **SUPERSEDED IN PART, 2026-08-21 (after this document was written).** The
> founder was shown this section and the recommendation against a builder, and
> ruled the other way: reeve WILL become a builder — task intake, research,
> design, a spec-PR approval gate, implementation, and merging on a PASS
> verdict. Requirements and programme state live in `docs/TRACKER.md`
> ("Programme 2"). What survives unchanged: the guardian capabilities, their
> shadow-week gates, and every invariant in §4 — the builder is being designed
> ON TOP of them, not instead of them. The table below still correctly
> describes what exists TODAY.

**reeve is TODAY a GUARDIAN, not yet a BUILDER.** It does not pick work,
research, design, or write features. It watches pull requests that already
exist and guards them.

The founder asked directly whether reeve would eventually implement a feature end
to end. The answer is no, and not after the remaining work either:

| Step | Who does it | reeve |
|---|---|---|
| Pick what to build | the `ledger` in nextly-ops | ✗ no task import (ruling 16) |
| Research / design it | a Claude session | ✗ never designed |
| **Write the code** | `lane-*` agents in a Claude session | ✗ **not in scope** |
| Open the PR | that session | ✗ |
| Fix red CI | — | ✓ capability 2 |
| Work review threads | the founder, by hand | ✓ capability 3 |
| Refuse an unsafe merge | nobody | ✓ capability 4 |

The shape TODAY is: a Claude session (Prompt A/B) builds and opens the PR, then
reeve takes over. The builder programme that changes this is now founder-ruled
and in design — do not push back on it; see `docs/TRACKER.md` Programme 2.

---

## 1. The four capabilities, and which are on

Everything reeve does is one of four switches. **One of four is on.**

| # | Capability | Switch | State | Unblocks when |
|---|---|---|---|---|
| 1 | Watch, judge, and tell the founder | — | **ON** | live now |
| 2 | Fix red CI itself | `--execute` | off | dispatch evidence — NOT time-bound |
| 3 | Work review threads | `watch.reviewActions` | off | PR-5 → PR-6, after the shadow week |
| 4 | Refuse an unsafe merge | `--enforce` + ruleset | off | 7 clean shadow days + founder decision |

Capability 1 means: reeve pins each head, reads CI and reviewers, computes
PASS/BLOCK/UNKNOWN, publishes a `neutral` (non-blocking) check run, and escalates
what needs a human to ntfy and to this Mac.

---

## 2. State, measured 2026-08-21 (end of session three)

| | |
|---|---|
| Commits | **93**, `HEAD == origin/main`, CI green |
| Source | 27 modules, ~7,200 lines |
| Tests | **44 files, 0 failing** |
| Daemon | `com.revnix.reeve` on `nextlyhq/nextly`, **observe-only** (argv has neither flag) |
| Dispatch | **3 clean CI-verified runs** across 2 failure shapes |
| Review ingest | PR-1..PR-4 built and running in **shadow**; 296 inbox rows, 100 threads, 37 rounds derived |
| Backups | hourly, **every store** (2 stores, 16 snapshots) |
| Self-audit | every tick: store integrity, backups, leases, notify |

### Where everything lives

| Thing | Path |
|---|---|
| **core** | `~/Work/Products/reeve` → `github.com/revnix/reeve`, private |
| **profile** | `~/.reeve/profiles/<owner>/<repo>.json` — 4 exist, all sidecar |
| **state** | `~/.reeve/state/<owner>/<repo>.db` — SQLite, keyed by owner AND repo |
| **backups** | `~/.reeve/backups/<owner>-<repo>/<epoch>.db` |
| credentials | `~/.reeve/credentials/` — mode 600, App ID **4660593** |
| log | `~/.reeve/reeve.log`, errors in `reeve.err.log` |
| **halt** | `~/.reeve/HALT` — create it to stop everything |
| product repo | `~/Work/Products/nextly-workspace/nextly` |
| old ops repo | `nextly-workspace/nextly-ops` — **still live, ruling 16** |

**Path trap:** `~/Work/Products/nextly-integrations/nextly-ops` is a DEAD clone.

### Source map

| File | What it does |
|---|---|
| `db/schema.sql` | events, graph, runs, leases, settlement, fix_attempt, escalation, **inbox, head_seen, review_\*, projection_meta, review_shadow** |
| `db/ops.mjs` | atomic claim, heartbeat, runs, settlement, fix attempts, **table reshape** |
| `github/reconciler.mjs` | head pinning, check classification, **reviewer-status exclusion**, settlement |
| `verdict.mjs` | PASS / BLOCK / UNKNOWN; `coversHead` prefix rule |
| `watcher.mjs` | verdict → action; the review-action gate |
| `ci-rootcause.mjs` | annotations tier, log slice, **cause identity across every failing check** |
| `sandbox.mjs` | tool policy, diff gate, **test-only-repair refusal** |
| `supervisor.mjs` | worker lifecycle, group kill, **worker report parsing** |
| `review/ingest.mjs` | **observe + land raw observations, generations, head_seen** |
| `review/derive.mjs` | **the pure fold: rounds, threads, severity, supply** |
| `review/shadow.mjs` | **derived-vs-live comparison and the day streak** |
| `selfaudit.mjs` | **reeve checking reeve, every tick** |
| `notify.mjs` | ntfy **and macOS desktop**, redacted |
| `daemon.mjs` | the tick loop |

---

## 3. Founder rulings — settled, do not re-litigate

| # | Ruling |
|---|---|
| 1 | One shared core plus a per-project profile. Not fork-per-project |
| 2 | A supervisor daemon that **shells out to `claude`** — never the Agent SDK with a subscription token |
| 3 | Local-first on the Mac, built host-agnostic |
| 4 | Foundation first, then autonomy |
| 5 | The engine is called **reeve** |
| 6 | The Nextly product fleet is **PAUSED** until reeve can watch it |
| 7 | Fix the local review lenses; **no paid reviewer** (CodeRabbit Pro Plus explicitly declined — do not raise it again) |
| 8 | Server enforcement on nextly only, for now |
| 9 | GitHub App identity and ruleset repair approved |
| 10 | PR watcher: CI half now, review-ingest half deferred |
| 11 | Round cap: soft cap, hard cap, **and a severity gate** — criticals are never spilled |
| 12 | No release pressure |
| 13 | Fresh minimal agent prompts in reeve; port lessons selectively |
| 14 | The shadow week exits on **a week of data AND zero false blocks** |
| 15 | **Nothing may name reeve in a public or client repo** — enforced by code, not memory |
| 16 | `nextly-ops` **stays** until reeve can import its task graph |

### The two operating modes

Every project is **product** or **client**, and the kind changes the defaults.
Product (nextly, ranknaut, rext, ficonz, upkit): best foundation, fast to market,
higher autonomy ceiling. Client (21c, 4re, mc, tby, comfy): quality and best
practice always, lower ceiling, high-risk work always human.

---

## 4. Design invariants — the reasoning that must survive

### 4.1 The governing rule

> An agent may reason probabilistically. **Authorization, state transitions,
> evidence binding and merge decisions must be deterministic, durable and
> independently verifiable.**

### 4.2 UNKNOWN never merges

Three outcomes, one of which merges. **Every fail-open defect found in the old
system was an UNKNOWN silently rendered as a PASS.** So: absence is never success;
"not checkable" blocks; the gate asserts a check run *exists* for the SHA it
judges, not merely that nothing failed.

This applies to reporting too, not just verdicts. Four violations were found in
reeve's own surfaces this session — see §6.4.

### 4.3 reeve does not merge

It computes a verdict, publishes it as a check run bound to an exact `head_sha`,
and GitHub refuses. The actuator is a GitHub App installation, which is not an org
admin and therefore *cannot* bypass. A stale reeve fails to publish and the merge
blocks.

### 4.4 The actor is never the only witness

A worker cannot push or merge. **reeve** publishes, after checking what **git**
says changed — not what the worker says it did. This was violated once, by me, and
is now enforced physically rather than by permission patterns (§6.2).

### 4.5 A sandbox for a code fixer cannot restrict execution

A worker holding `Write` can write a script and run it through any granted runner.
What is enforceable is **authority, network and paths** — plus the diff gate,
which sees what happened rather than what was permitted. Measured twice, in two
shapes; see §6.1.

### 4.6 Other load-bearing rules

- **Pin the head once per tick** from `git ls-remote`, never `headRefOid`.
- **Union check-runs with commit statuses** — they demonstrably disagree.
- **`cancelled` and `stale` are absences, not failures.** A cancelled *required*
  check is UNKNOWN; a cancelled *ancillary* one does not veto.
- **Settlement needs three real readings across ticks** with a stable check-name
  set. A missing *required* check settles on the CI provider's suites being
  terminal, never on a count.
- **Inherited vs caused compares FAILURES, not check names.**
- **A shared cause is one escalation, not N**, and an escalation clears only when
  the tick actually looked.
- **Refusal is ABSENT, never PASS.**

---

## 5. Measured reality — why the code is shaped this way

### 5.1 The old system

- The merge gate merged **0 of the last 10** merges. The ruleset has no
  `required_status_checks` rule at all, `enforce_admins: false`, and
  `bypass_actors: [{OrganizationAdmin, always}]`.
- All seven cached plugin versions shipped one broken `merge-gate` while the repo
  held the fixed one — `claude plugin update` compares the **version string, not
  the commit**, so a fix without a bump reaches nobody.
- `ledger claim` was a read-check-append race: 20 concurrent claims produced 4
  winners.

### 5.2 Reviewers

- Codex refuses ~86% of requests (re-measured; an earlier note said 93%).
- CodeRabbit **fails green**: `state=success` with the truth in
  `description="Review rate limited"`. Currently working (4% refused).
- Codex posts findings as a `/pulls/N/reviews` object and a clean pass **only as
  an issue comment**. Polling one endpoint cannot distinguish clean from never-run.
- Both name the reviewed revision abbreviated, so coverage is a **prefix** match.

### 5.3 The platform

- `claude` is a native arm64 binary. `--output-format stream-json` **requires
  `--verbose`** under `-p` or it exits 1 having written nothing.
- **SIGTERM runs claude's SessionEnd hook and exits 143 with `signal === null`.**
- `spawn(detached:true)` + `process.kill(-pid)` kills the group; plain `kill(pid)`
  orphans the grandchild.
- **pid reuse is real here** (~963/s churn); `ps -o lstart=` is the identity token.
- `node:sqlite` is clean on 24.17 and warns on 22.18. **`node` on PATH is v22** —
  always use `~/.nvm/versions/node/v24.17.0/bin/node`.
- **A user token cannot create check runs** (403, App only).
- launchd never sources a profile: a bare `node` fails **exit 78 with an empty
  stderr log**; only `launchctl print` reveals it.
- `permissions.deny: ["Bash"]` removes the tool **entirely**, scoped grants
  included. Scoping via `--allowedTools` is what contains it.
- **`git -C <path> <subcommand>` does not match a `Bash(git <subcommand>:*)`
  rule** — flags precede the subcommand. This is the shape of the mechanism, not
  a gap to patch.
- A worktree **shares the clone's git config** unless `git config --worktree`.

### 5.4 The portfolio — 27 repos surveyed

Full analysis in `docs/2026-08-20-portfolio-readiness.md`.

- **Every Revnix org is on GitHub's FREE plan.** Branch protection returns 403 on
  all 23 private repos. reeve can **attest** but never **enforce** outside
  `nextlyhq/nextly`, which is public. A billing decision, not an engineering one.
- The App reaches **one repo**. Every other probe returns `no installation … 404`.
- **Outside nextly and Comfy-Org, no workflow triggers on a pull request.** They
  are deploy-on-push pipelines, so every PR would read UNKNOWN and block forever.
  **Writing PR-gating CI is a prerequisite**, and worth doing regardless of reeve.
- Client work happens in `revnix/*` and is **re-committed** to the client org
  (identical messages, different SHAs). reeve should govern `revnix/*` only — which
  satisfies the anonymity rule structurally.
- Detector coverage: TypeScript ✅ Python ✅ **Go** detected but no commands,
  **Rust** same, **PHP** not detected (8 PHP repos exist).

---

## 6. What session three did

53 commits. Twelve defects found and fixed, **five of them fail-opens live in
production**. Every one was found by RUNNING the system, not by reading it.

### 6.1 The fail-opens that were live

| Defect | What it meant |
|---|---|
| **CodeRabbit rate-limit counted as a passing CI check** | `state=success, description="Review rate limited"` on 8 of 9 sampled heads. `readChecks` carried the description *because* the truth hides there and nothing read it |
| **Cause identity could not tell two failures apart** | Root-caused `failing[0]`, which where CI ends in a gate IS the gate — same sentence whatever broke. The retry brake refused work it had never attempted |
| **`unspilledCritical` was `null`, and `null > 0` is false** | At the hard cap with unknown criticals the rounds clause rendered PASS |
| **A truncated read became a confident projection** | `ctx.lastIngestIncomplete` was read and never assigned |
| **`NOT_INSTALLED` never produced** | An absent blocking reviewer read "not yet run" forever instead of REVIEWERS_DOWN |

### 6.2 The noise defects — a channel that cries wolf is not a channel

Fixed **four separate times**, in four places:

1. The gated escalation key embedded the thread COUNT — three phone pushes in one
   morning for one unchanged condition (13 of 17, then 23 of 27).
2. `WAIT` was read as "resolved", so a standing escalation retired and
   re-announced every time CI went in flight.
3. A MERGED PR could never retire its escalation — NEEDS YOU filled with finished work.
4. The self-audit ran BEFORE the backup step, so it paged about a gap the same
   tick closed 54ms later.

**The rule that came out of it:** an escalation key is an IDENTITY, not a report.
No counts, no durations, no paths. Those go in `detail`, which is logged.

### 6.3 Review ingest: PR-1 to PR-4, in shadow

Built from `docs/2026-08-21-review-ingest-design.md` — a 14-agent research pass
(4 measurers, 3 designs, 3 judges, 1 synthesis, 3 adversarial verifiers), whose
§12 ledgers every hole found and where its fix landed.

- **PR-1** the four fail-now defects above.
- **PR-2** raw observations land append-only in `inbox`, which had existed with
  ZERO writers since the beginning. Its key had to change: an edit is a
  GENERATION, because CodeRabbit rewrites its own history.
- **PR-3** the pure fold — rounds, thread identity, severity, supply — stamped
  with a `classifier_version` so improving a detector re-reads history.
- **PR-4** `reeve shadow`: derived-vs-live comparison, per day, gating PR-5.

**PR-5 is time-blocked** on 5 clean shadow days.

### 6.4 What running it found that no test could

- **One App, two logins.** REST says `coderabbitai[bot]`, GraphQL says
  `coderabbitai`. 71 observations of two reviewers arrived under four sources —
  half of every reviewer's evidence would never have matched the roster.
- **Resolution is a CLAIM.** The first draft cleared four threads
  `coderabbitai[bot]` had resolved by itself. `resolved_at` was the thread's
  BIRTH (GitHub reports who, never when), and the covering-head requirement was
  missing entirely.
- **A stale settlement floor** — excluding reviewer statuses dropped every head's
  count below its stored floor, the exact incident `CHECK_ACCOUNTING` exists for.
  The mechanism was correct; nobody bumped the number.

### 6.5 The pattern worth carrying: optional parameters that switch off their own rule

**Four times in one day**, an optional parameter defaulted in a way that silently
disabled the safety rule it guarded: `reviewDiff.action`, `announceable.waiting`,
`announceable.finished`, and `derivePr.complete`. Each was caught only by a
call-site guard written AFTER the previous one bit.

**Standing rule for the next session: any new optional parameter guarding a
safety rule ships with its call-site assertion in the same commit.**

### 6.6 Hardening added

- **Self-audit** (`selfaudit.mjs`) — store integrity, backup freshness AND
  readability, wedged leases, notify reachability. Every tick, because a slower
  cadence would make findings absent from most ticks and absence reads as resolved.
- **Backups cover every store.** A store no daemon watches was unbacked AND
  unaudited — reeve's own store had zero backups while nextly had fourteen.
- **Desktop notifications.** All five ntfy tokens are write-only; the phone half
  is genuinely blocked on the founder. A native macOS banner cannot be blocked by
  a server nobody can log into.
- **`CHECK_ACCOUNTING` is guarded by a fingerprint**, so changing what counts as
  a check fails the suite until the version moves with it.

---

## 7. The 500-PR study — measured, and what it says

500 merged PRs, 11 days (2026-08-10..21), 3,405 review threads, 92.6% resolved.
Data at `scratchpad/prstudy/` (regenerate with `fetch.mjs`; **request `body`, not
`bodyText` — the latter strips image markdown and both bots put severity in an
image**. That error made a first pass report 92% unknown severity).

**Severity:** critical 992 (29.1%) · major 2,202 (64.7%) · minor 174 · unknown 37 (1.1%).
Roughly **90 critical findings caught per day**.

**What they are about** (CodeRabbit's own categories):

| Category | Share |
|---|---|
| **Functional Correctness** | **39.9%** |
| Maintainability & Code Quality | 30.2% |
| **Data Integrity & Integration** | **15.7%** |
| Stability & Availability | 9.7% |
| Security & Privacy | 4.1% |
| Performance | 0.4% |

**Correctness plus data integrity is 56% of everything.** Not style.

**The reviewers have different lenses, and Codex is the workhorse:**

| Reviewer | Threads | Critical | Note |
|---|---|---|---|
| **chatgpt-codex-connector** | **3,042** | **946** | volume AND severity. **Founder ruling: give Codex more weight** |
| coderabbitai | 268 | 1 | categorises well, rarely alarms |
| greptile-apps | 58 | 45 (78%) | best hit rate, **paused — out of credits** |

**Size predicts pain, sharply:**

| PR size | Avg rounds | Avg threads |
|---|---|---|
| 1–3 files | 1.34 | 4.3 |
| 4–10 files | 1.72 | 6.1 |
| **11–30 files** | **4.29** | **15.9** |
| 31+ files | 5.71 | 26.9 |

Crossing ~10 files roughly **triples** review cost. Worst PR: 19 rounds. Another
drew 149 threads.

---

## 8. Proven, and unproven

### Proven

- The daemon runs unattended for days, survives outages, restarts cleanly.
- **Three complete dispatches**, CI-verified on GitHub: red CI → root cause → fix
  in an isolated worktree → diff gate → reeve published → green.
- **The retry brake, the diff-gate refusal and REPEATED_FAILURE have all fired on
  a real dispatch**, exercised by planting a failure whose fix lands in a
  sensitive path so the worker had to decline.
- Backups restore; a snapshot matched the live store exactly.
- The self-audit catches real gaps — it found reeve's own unbacked store.
- Ingest is idempotent on live data; re-derivation is byte-identical.

### NOT proven — say so

- **Dispatch: 3 clean runs, 2 shapes.** Untested: an INTERMITTENT failure, a
  failure with two independent causes, and **what happens when a worker is
  WRONG** — every run so far produced a correct fix, so the second-attempt path
  has never been exercised by a genuinely bad one.
- **`--enforce` has never been on.**
- **The review shadow week has 0 clean days** (today diverged, from a bug since
  fixed). The clock starts 22 Aug.
- **Nothing proven on a second project.**
- **`flakeEvidence` is written and called by NOTHING** — zero callers, zero log
  mentions. nextly's main is red on 6 of its last 9 runs, so on the day
  capability 2 is armed, reeve will pay an agent to "fix" randomness and then
  page about a failure that never existed.
- reeve cannot pick work, research, or review a PR.

---

## 9. What remains

### 9.1 Unblocked code — roughly 2 days

1. **Feed the study into the worker prompts** — FOUNDER-APPROVED. Correctness and
   data integrity are 56% of findings; Codex gets more weight. Measured guidance
   into `prompts.mjs`, not guesses.
2. **Wire flake detection** — `flakeEvidence` exists; nothing calls it. ~2h.
3. **Dispatch evidence: the wrong-worker shape** — ~$2, 1h.
4. **`release` lane is dead by construction** — its whole territory
   (`.changeset/**`, `scripts/release/**`) is in `sensitivePaths`, and sensitive
   refuses BEFORE territory is checked. ~30m.
5. *Optional, founder said "if beneficial":* a size warning at PR-open (>10 files
   → expect 4+ rounds), and reinstating Greptile (78% critical hit rate, dark for
   want of credits).

### 9.2 Time-blocked

- **Review shadow week** — 5 clean days from 22 Aug → PR-5 ≈ **26 Aug**.
- **Verdict shadow week** — 7 days zero false blocks. The clock starts NOW, not
  earlier: what the verdict SEES changed today (reviewer-status exclusion, check
  accounting bumped twice). → **~28 Aug earliest**.
- **The ruleset flip** — the riskiest step. Work in flight starts blocking and it
  WILL feel like reeve got worse. That is the moment a bypass gets reopened and
  the programme dies. **Do not skip the shadow week.**

### 9.3 Needs the founder

- **ntfy read user.** All 5 tokens are write-only, account role `user`, no read
  grants; `/v1/users` returns 401. Needs shell on `95.217.11.127`:
  `ntfy user add mobeen` then `ntfy access mobeen revnix-reeve read-only`, plus
  `upstream-base-url: "https://ntfy.sh"` in server.yml for iOS background push.
  Desktop notifications work meanwhile.
- **Second project** (`rextaihq/rext-backend`) — needs PR-gating CI written and
  the App installed.
- **The ruleset flip decision.**

### 9.4 Closed by ruling

Go / Rust / PHP command tables (**founder: not now**) · SPILL (off indefinitely) ·
task import (deferred; `nextly-ops` stays) · paid reviewer (declined).

---

## 10. Traps that will bite a fresh session

1. **The archive guard hook refuses any Bash command containing the frozen-history
   directory name**, even in a `grep -v`. Build searches that avoid naming it, or
   use the Write tool.
2. **`grep` is shadowed by ugrep** and skips some files; `git grep` is blind to
   ignored files. Use both, always with a positive control.
3. **Node on PATH is v22.** Always the absolute v24 path.
4. **A fresh `git worktree` cannot commit**: husky's lint-staged needs
   `node_modules`. Never `--no-verify`.
5. **The Bash tool's 2-minute timeout** kills a long dispatch — use
   `run_in_background`. §10's block exceeds it if run as one command.
6. **Timezone is +05:00.** CI runs the suite twice, once under `TZ=Asia/Karachi`.
7. **A worktree shares the clone's git config** unless you use `--worktree`.
8. **Do not raise CodeRabbit Pro Plus again.**
9. **`git config --get` exits 1 when a key is unset** — that is not an error.
10. **Scripted multi-line edits to `daemon.mjs` have tangled it twice.** Prefer the
    Edit tool with a unique anchor, and re-read after.
11. **An edit that silently changes nothing usually means an invisible byte.**
    `ci-rootcause.mjs` held a literal ESC inside an ANSI stripper: both the editor
    and a hand-written anchor matched the VISIBLE characters and found nothing.
    `od -c` on the line names it in one command. `test/source-is-text.test.mjs`
    now guards NUL and ESC, but only under `src bin test deploy`.
12. **`od -c | grep 033` is a BROKEN detector** -- it matches byte offsets, so it
    reports a hit for every file. Scan bytes in python and carry a positive
    control. This one cost a wrong conclusion about 68 files.
13. **`launchctl kickstart -k` leaves last-exit `-9`.** That is the documented
    restart, not a crash. Do not read `-9` in `launchctl list` as a fault.
14. **Re-planting the SAME failure trips the retry brake**, which is correct
    behaviour: reeve escalates rather than dispatching. Vary the failure, or the
    PR, when gathering dispatch evidence.
15. **Grep the ProgramArguments ARRAY, not the whole plist.** The plist carries a
    comment reading "Neither --enforce nor --execute appears", and a naive grep
    matches that comment and reports the daemon as ARMED when it is not. This
    produced a false alarm in session three.
16. **GraphQL `bodyText` strips image markdown.** Both review bots put severity in
    an image (`![P1 Badge]`, `<img alt="P1">`), so `bodyText` loses it entirely.
    Request `body` whenever classifying findings — this made a first pass of the
    500-PR study report 92% unknown severity.
17. **`gh run list --commit` needs the FULL sha**, and reading "the latest run on
    main" reads the PREVIOUS commit's run. Always
    `select(.headSha=="$SHA")` against your own pushed head.

---

## 11. How to verify the whole thing still works

**Run these separately.** Together they exceed the two-minute tool timeout.

```sh
N=~/.nvm/versions/node/v24.17.0/bin/node
cd ~/Work/Products/reeve

# the suite
for f in test/*.test.mjs; do $N "$f" >/dev/null || echo "FAILED $f"; done

# the daemon, and that it is still observe-only (grep the ARRAY, not the file)
launchctl list | grep reeve
python3 -c "import re,pathlib; s=pathlib.Path('$HOME/Library/LaunchAgents/com.revnix.reeve.plist').read_text(); m=re.search(r'ProgramArguments</key>\s*<array>(.*?)</array>',s,re.S); print(re.findall(r'<string>(.*?)</string>',m.group(1)))"
tail -20 ~/.reeve/reeve.log

# the commands
$N bin/reeve doctor nextlyhq/nextly --as-app     # BROKEN on nextly is EXPECTED
$N bin/reeve status nextlyhq/nextly
$N bin/reeve shadow nextlyhq/nextly              # exit 3 until 5 clean days
$N bin/reeve backup nextlyhq/nextly
```

`doctor` reports **BROKEN** on nextly because the ruleset genuinely is
unenforced. That stays true until §9.2 is done. **R-08 detectors** should read
"N/N classified" for each reviewer; anything else means a marker grammar changed.

### Re-arming the dispatch proof

```sh
cd ~/Work/Products/reeve
git worktree add -q --detach /tmp/rearm origin/main
# plant a failure, commit, then: git push --force origin HEAD:test/execute-proof
# wait for CI red, then:
$N bin/reeve tick revnix/reeve --execute --log /tmp/proofN.log
```

Read the **whole** log; check the remote moved and CI went green. A partial read
is how run 11 was reported as a success when a worker had bypassed the gate.
**The brake refuses a repeat** — vary the failure or use a different PR.

---

## 12. Related documents

- `docs/USING-REEVE.md` — the founder-facing guide. What reeve is, what it is not.
- `docs/2026-08-20-reeve-comprehensive-audit.md` — the independent audit. Closed,
  but its reasoning is worth reading.
- `docs/2026-08-20-portfolio-readiness.md` — whether reeve can serve the other 27
  repos. Short answer: the engine generalises, the environment does not.
- `docs/github-app-setup.md` — App setup, already done.
- `~/Work/Products/nextly-workspace/nextly-ops/docs/2026-08-20-reeve-plan.md` —
  the original plan. Its "net line count goes down" claim is **known wrong**.
