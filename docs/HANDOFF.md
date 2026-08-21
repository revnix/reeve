# reeve — handoff

**Written:** 2026-08-21, end of the second build session.
**Updated:** 2026-08-21, third session. See §6.5 for what that session changed.
**Audience:** the next session, which will have none of this in context.
**Rule for reading it:** every number here was measured, not remembered. Where
something is unproven it says so. Trust the "unproven" labels as much as the
numbers, and re-measure anything you are about to act on.

---

## 1. What this is, in one paragraph

`reeve` is an agent-ops control plane. It watches the pull requests an agent fleet
opens, reads CI and reviewers, root-causes failures, dispatches workers to fix
them, computes whether a PR is genuinely safe to merge, and publishes that verdict
to GitHub so that **GitHub does the refusing**. It replaces `nextly-ops`, a repo of
shell scripts whose merge gate had, when audited, merged **zero** of the last ten
pull requests while claiming to be the only sanctioned path.

It is built to serve **many projects of different stacks**. That is the founder's
primary requirement and it shapes everything: a project-agnostic CORE plus a small
per-project PROFILE.

`docs/USING-REEVE.md` is the plain-English version for the founder. Read it too —
it is short, and it is the document that states what reeve is *not*.

---

## 2. State, measured 2026-08-21

| | |
|---|---|
| Commits | ~70. The number that matters is **`HEAD == origin/main`, CI green** |
| Source | 23 `.mjs` files, ~5,600 lines |
| Tests | **37 files, 0 failing** |
| Daemon | running as `com.revnix.reeve` on `nextlyhq/nextly`, **observe-only** |
| Ticks | 260+ since 2026-08-20 14:04 UTC |
| Backups | hourly snapshots, restore verified against the live store |
| Dispatch | **three complete clean runs**, all CI-verified, on `revnix/reeve` only |

### Where everything lives

| Thing | Path |
|---|---|
| **core** | `~/Work/Products/reeve` → `github.com/revnix/reeve`, private |
| **profile** | `~/.reeve/profiles/<owner>/<repo>.json` — 4 exist, all sidecar |
| **state** | `~/.reeve/state/<owner>/<repo>.db` — SQLite, keyed by owner AND repo |
| **backups** | `~/.reeve/backups/<owner>-<repo>/<epoch>.db` |
| dashboard | `~/.reeve/dash/<owner>/<repo>.html` |
| credentials | `~/.reeve/credentials/` — mode 600, App ID **4660593** |
| log | `~/.reeve/reeve.log`, errors in `reeve.err.log` |
| **halt** | `~/.reeve/HALT` — create it to stop everything |
| product repo | `~/Work/Products/nextly-workspace/nextly` |
| old ops repo | `~/Work/Products/nextly-workspace/nextly-ops` — **still live, do not delete** |

`~/.reeve` is deliberately **not** a git repo, so a profile or the App key cannot
be committed into a public or client repo by accident.

**Path trap:** `~/Work/Products/nextly-integrations/nextly-ops` is a DEAD clone,
39 commits behind. The live one is under `nextly-workspace/`.

### Source map

| File | What it does |
|---|---|
| `db/schema.sql` | events, graph, runs, leases, checkpoints, outbox, settlement, fix_attempt, escalation |
| `db/ops.mjs` | atomic claim, heartbeat, reap, runs, settlement, fix attempts, JSONL export |
| `db/reconcile.mjs` | idempotency reconcilers for push / PR create / comment / merge |
| `profile/schema.mjs` | the profile schema and a **fail-closed** validator |
| `profile/detect.mjs` | auto-detection; returns *questions* rather than guesses |
| `github/app.mjs` | App JWT, installation token, permission audit |
| `github/reconciler.mjs` | head pinning, check classification, settlement, timeline |
| `verdict.mjs` | the merge decision: PASS / BLOCK / UNKNOWN |
| `watcher.mjs` | a **total** verdict → action function |
| `ci-rootcause.mjs` | annotations tier, log-slice fallback, cause identity |
| `supervisor.mjs` | worker lifecycle, group kill, liveness, capacity |
| `sandbox.mjs` | the deterministic tool policy and the diff gate |
| `worktree.mjs` | acquire / verify / publish / release, with quarantine |
| `prompts.mjs` | worker prompts **generated from the profile** |
| `pr.mjs` | evaluate one PR, publish the verdict |
| `daemon.mjs` | the tick loop |
| `status.mjs` | `status`, `statusline`, `why`, liveness, clean-merge |
| `notify.mjs` | ntfy escalations, redacted |
| `backup.mjs` | snapshots, restore, JSONL export |
| `paths.mjs` | owner-scoped state and dashboard paths |
| `init.mjs` / `doctor.mjs` | detect→preview→merge→prove; what is true right now |

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

## 6. What this session fixed, and what each cost to find

The Codex audit (`docs/2026-08-20-reeve-comprehensive-audit.md`) is **closed** —
ten of its claims were re-verified by hand and all ten held. Beyond it, twelve
`--execute` dispatch runs against a planted failure on `revnix/reeve` found
**eleven defects, all mine.** The failures matter more than the list.

### 6.1 The sandbox premise was wrong (three corrections)

1. Denying `Write` while granting a bare `Bash` is **theatre** — the model wrote
   the denied file with `printf >` on the next turn.
2. `deny: ["Bash"]` removes the tool entirely, so a worker could edit code and
   **never run a test** — reporting success on work nothing checked.
3. Restricting execution at all is impossible for a code fixer. I made this
   mistake **twice in one session, in two shapes**, having already measured it.

Also: a fixer must be able to **read** the workflow failing it. Quarantine denies
every verb including reads (data that must never be seen); sensitive and
self-governing paths deny writes only (understanding requires reading).

### 6.2 The worker could publish around the gate — the most serious

`git -C <path> push` does not match `Bash(git push:*)`. Having widened the *allow*
to `Bash(git:*)` to fix `-C` matching, I left the *deny* as a subcommand pattern
with the identical blind spot. A worker used it to publish its own fix.

**And I had "verified" the deny with a test that could not fail** — it used the
bare `git push` form, which the pattern does match. The commit message claimed the
property was proven.

Fixed physically: the worktree gets a pushurl git cannot resolve, so no spelling
works, and reeve publishes from the main checkout.

### 6.3 The instrument problem — the lesson that cost the most

> **When a system reports a NUMBER where it holds the DETAIL, whoever reads it
> will guess.**

`runWorker` returned the denied commands from the first failure and the daemon
kept only the count. Two full rounds went into reproducing by hand what the run
already knew, from hand-written prompts that did not match the generated one — so
both reproductions produced wrong conclusions. Printing the refused commands was
fifteen lines and named the cause in one run.

### 6.4 Everything else closed

| Defect | Was |
|---|---|
| Settlement was fake | 3 `settle()` calls on ONE API read; now persisted across ticks |
| MISSING_REQUIRED settled on a count | Now waits for the CI provider's suites to be terminal |
| reeve read its own verdict as CI input | Would latch red forever under `--enforce` |
| Retry brake non-functional | Three independent causes, any one disabling it |
| Durable state not connected | 1,230 events, **zero** runs/leases/checkpoints |
| Worktree lifecycle | Did not exist; a path check only |
| A cancelled ancillary job vetoed the base | Blocked all five open PRs for hours |
| Clean-merge counted absence as clean | And the daemon never computed it |
| Decisions band was a dead query | `status='pending'` is not a value the schema permits |
| State keyed by short repo name | `owner-a/api` and `owner-b/api` collided |
| Review actions inverted a ruling | `unspilledCritical` hard-coded 0 → would spill P0s |
| Escalations retired on absence | A PR a tick could not evaluate read as "resolved" |
| A source file was BINARY to git | One raw NUL; every diff of it showed nothing |
| An existing DB could not gain a column | `CREATE TABLE IF NOT EXISTS` is a no-op |
| Freshness measured against stored rows | A dead daemon looked permanently current |
| A denial disqualified a whole run | Made dispatch impossible: a model always explores |
| A failed worker's dirty worktree stranded the PR | Next attempt refuses a dirty checkout, forever |
| The gate was blind to committed work | Read `status --porcelain`; a committed fix looks like nothing |
| The prompt told the worker to push | The one action the sandbox forbids |
| No backup | One copy on one laptop |
| No alert sink | "Needs you" reached a local log only |

### 6.5 The third session: seven more defects, all found by USING it

The verification in §10, five more `--execute` dispatches and two notifications
arriving on a phone found seven defects that 576 passing assertions did not. Every one was found by running the system
and reading what it actually stored, not by reading code.

**The failure identity could not tell two failures apart.** The daemon
root-caused `failing[0]`, which where CI ends in an aggregate gate is the GATE.
Its annotation is the same sentence whatever broke -- measured in the
`fix_attempt` table as `CI Gate refuses: test concluded 'failure'`. So every
failure in the repository shared one identity. Two things followed: the retry
brake refused work it had never attempted (run 13 escalated "the same failure
survived a second fix" about a fix it had not tried), and the worker's WHAT
FAILED section was a tautology. Run 12 succeeded only because the prompt
separately tells a worker to reproduce the failure itself, so the most
engineered tier in the pipeline had contributed nothing to the one dispatch that
had ever worked. Every failing check is now read, caused ones first.

**`doctor` could not find its own state database.** It resolved the path from
`profile.state.location`, which the schema defines as the sibling REPOSITORY
holding a project's ledger -- `nextlyhq/nextly-ledger`. `existsSync` said no and
doctor rendered that as UNKNOWN `no state database`, with 3,600 events sitting at
the canonical path. The lease check had therefore never run against a real store.
This is the fifth instance of §4.2's class in reeve's own surfaces, and it was in
the command the founder-facing guide tells you to run. Five commands resolved
that path independently; there is now one resolver. `loadProfile` was also
reading `homedir()` rather than `REEVE_HOME`, so a scratch home moved a project's
state but not the profile describing it.

**A PASSING test was recorded as the cause of a red build.** The salience
patterns match on words and a test NAME may contain them: this suite asserts
"cancelled is an absence, failed is a fact", so its PASS line matched
`/failed/i`. A worker told to change the least that fixes the cause was being
pointed at green code, and the identity churned whenever an unrelated test was
renamed -- refunding the brake an attempt.

Beside it, an ANSI stripper written with a **literal ESC byte**. Invisible to an
editor, unmatchable by search: two separate attempts to edit that line silently
found nothing, and the second only resolved because an octal dump showed the
byte. Same family as the raw NUL in §6.4. The guard that keeps NUL out of source
now keeps ESC out with it.

**A fourth, found by probing rather than by accident.** Run 15's fixture was
chosen so the cheapest way out was to delete the failing assertion --
`SELF_GOVERNING` was `[".github/**", ".git/**"]`, so tests, which judge the work
exactly as the workflow does, were unprotected. The worker did not take it. The
gate now refuses a repair whose entire diff is tests, because the design rule is
that the actor is never the only witness, and "the worker chose well" is the
actor being the only witness. Adding a test beside a source fix stays allowed:
the prompt requires one.

**A fifth, delivered by the notification channel itself.** An escalation was
retired whenever a tick evaluated its PR and produced no escalation that round.
But `WAIT` means "something is in flight; check again later", not "the thing a
human was needed for is resolved". nextly #834 ran ESCALATE, seven ticks of WAIT
while CI was in flight, then ESCALATE again -- so one unchanged condition was
announced, retired and re-announced twice, four and twenty-five minutes apart,
with the reason string identical each time. #1011 and #1127 did the same, and a
third instance arrived while the fix was being written. Two pushes for one
unchanged condition is how a channel earns being muted. **Sixth instance of the
§4.2 class**: absence within one tick read as resolution.

**A sixth, the exact mirror of the fifth.** The guard above refuses to retire an
escalation for a PR a tick did not look at. A MERGED pull request leaves the open
list and is never looked at again -- so its escalation had no way out at all.
nextly #1127 merged and its cause stood on in NEEDS YOU with the PR long gone. A
surface whose target state is EMPTY, filling with finished work, stops being read:
the same muting as the flap, arriving from the other direction. Absence from the
open list is not the evidence used, because that list is capped and a PR beyond
the cap is unread rather than gone; each orphan is confirmed against GitHub and
only a clear MERGED or CLOSED retires it. **Verified in production**, not only in
a test: `#1127: is merged or closed — retiring what it was escalating`.

Worth noting what the two together mean. Escalation retirement had a defect in
BOTH directions -- retiring what still stood, and never retiring what was over --
and neither was reachable by any test written against the function, because both
needed a real PR moving through real states over real ticks.

**A seventh, found by deliberately making a worker unable to succeed.** Every
prompt ends by asking the worker for a fenced json block -- what was wrong, what
changed, and `needsHuman` when the work belongs to a person. **Nothing parsed it.**
It was written into every prompt and read by no code at all.

Measured by planting a failure in `src/verdict.mjs`, a sensitive path, so the
worker had to decline. It did exactly what rule 8 requires and said why. reeve
discarded that and pushed *"a fix was produced but refused publication -- the
worker produced an empty diff"*: two statements that cannot both be true, about a
worker that had behaved correctly. The next tick's retry cap replaced it with
*"the same failure survived a second fix"*, and because a clearing retires the
earlier message, the ONLY one left standing claimed a fix had been tried when none
ever was.

The report is now trusted for exactly one question -- **why did you stop**. What
was fixed is still answered by git and by CI, because the actor is never the
witness; but nothing else witnesses a worker's reason for stopping. The same
scenario now pushes: *"needs a human — the fix is confined to src/verdict.mjs, a
path this task forbids editing... A human should revert line 36 to `if (a ===
UNKNOWN || b === UNKNOWN) return UNKNOWN;`"* -- one push, `announced=1`, and the
retry cap quotes it rather than contradicting it.

Writing that fix introduced a ReferenceError on every FIX_CI -- the attempt is
spent at DISPATCH, before any worker exists, so the result was read in its
temporal dead zone. `test/dispatch-e2e.test.mjs` caught it. That test exists
because the same shape shipped once before.

**What that says about the shape of the remaining risk.** Three sessions have now
produced the same pattern: the defects that matter are not found by reading code
or by adding assertions, but by running the thing and reading what it wrote down.
Two of these three were only visible in stored state -- the `fix_attempt` row and
doctor's rendered output. Budget for use, not for review.

### 6.6 Verification lessons worth keeping

- **A fixture that cannot exhibit the defect proves nothing.** Two of my
  verifications were like this — the push deny, and a diff-gate check where the
  worktree sat at the remote's head so a push was a no-op either way.
- **Check that a stub actually applied.** One stub silently did not, and the guard
  looked blind when it was fine.
- **A guard that narrows its own input reports success.** The status-vocabulary
  guard took three attempts: a unioned vocabulary would have passed the bug, then
  the table regex skipped every `) STRICT, WITHOUT ROWID;` table, then the control
  was a magic number instead of a count derived from the schema.
- **Environment-dependent tests fail for the wrong reason.** The backup suite
  failed because a real daemon was running; the daemon check is now injectable.
- **Read the WHOLE log before claiming an outcome.** I reported run 11 as a
  success from a partial read. The branch had moved because the worker bypassed
  the gate, and the tick had crashed.

---

## 7. Proven, and unproven

### Proven

- The daemon runs unattended: **252 ticks since 2026-08-20 14:04 UTC**, survived a
  network outage to `api.github.com`, escalated to ntfy overnight.
- **Three complete dispatches**: red CI → root cause → fix in an isolated
  worktree → commit → diff gate → **reeve published** → **CI green**. Runs 12
  (202s/$1.92), 14 (159s/$1.50) and 15 (153s/$2.01). All verified on GitHub --
  the remote head, the published diff and the check conclusions -- never from
  reeve's own account of itself.
- **Run 15 was a genuinely harder shape** and is the one worth trusting: a logic
  inversion in `src/db/ops.mjs` failing THREE assertions in
  `test/lifecycle.test.mjs`, so the failing test did not name the module at
  fault. The worker fixed the source and **added two assertions** covering the
  case the bug created. It did not weaken the test, though nothing at the time
  stopped it.
- **The retry brake fires, and correctly refuses.** Run 13 declined to dispatch
  and escalated rather than guessing. It was refusing for the WRONG reason (§6.5),
  but the mechanism itself was exercised end to end for the first time.
- Backups restore: a real snapshot restored to a scratch path matched the live
  store exactly (3,637 events, 265 nodes, 5 settlements, 5 escalations).
- The state layer passes its lifecycle suite including exactly-once-across-crash.
- The GitHub App authenticates and publishes check runs.
- ntfy receives escalations on topic `revnix-reeve`.

### NOT proven — say so, do not assume

- **`--execute` has THREE clean runs out of fifteen**, across two failure shapes.
  Still untested: an INTERMITTENT failure, a failure with two independent causes,
  a failure whose fix spans several files, and any failure a worker cannot
  reproduce locally. Also untested: what happens when a worker is WRONG -- every
  run so far produced a correct fix, so the second-attempt path and the escalation
  after it have never been exercised by a genuine bad fix.
- **The App reaches nextly only.** Every dispatch run on `revnix/reeve` logs
  `could not publish: no installation ... 404`, so those runs exercise the WORKER
  chain and never the verdict-publication chain. The two halves have never been
  proven together on one repository.
- **`--enforce` has never been on.** The shadow week has not completed.
- **Nothing proven on a second project.** Four profiles exist; only nextly and
  reeve have been driven.
- **The ops CI guard has never fired.**
- reeve cannot pick its own work, research, or review a PR.

---

## 8. What remains

### 8.1 Time, not code

- **The shadow week.** Seven days of `neutral` verdicts with zero false blocks.
  The clock should run from **2026-08-21**, because settlement was fake until then
  and anything earlier cannot count.
- **The ruleset flip**, after that plus green main. The riskiest remaining step:
  work in flight starts blocking and it will feel like the system got worse. That
  is the moment a bypass gets reopened and the programme dies. **Do not skip the
  shadow week.**

### 8.2 Code, roughly in order

1. **Dispatches against DIFFERENT failure shapes on `revnix/reeve`.** Repeating
   the one planted failure is now cheap evidence: two clean runs used it and the
   third revealed the brake trips on a repeat by design. What is untested is a
   failure whose fix is in a different file from the failing test, a failure with
   two independent causes, and an intermittent one. Re-arm, run, read the WHOLE
   log. §10 has the recipe and the caveat about the brake.
2. **Self-audit on a schedule** — reeve running `doctor` on itself and escalating
   when its own health degrades. The first real step toward "watch its own work".
3. **Second project**: `rextaihq/rext-backend` — 85 merges in 90 days, real
   workflows, a different stack (python/uv + typescript). Anything that must be
   edited in the core to make it work was misfiled.
4. **Go and PHP command tables** in `detectCommands`. Roughly a day each.
5. **Review ingest** — round counting from distinct reviewed heads, severity from
   finding text, thread identity. Until then `watch.reviewActions` stays false.
6. **Task import** — the thing that would let `nextly-ops` retire. **Deliberately
   deferred**: the ledger works, the two systems track different things, and the
   trigger for doing it is reeve needing to pick its own work.
7. **Recurring cadences** — only needed when ranknaut starts.

### 8.3 Deferred by ruling

Founder-preference learning; product-mode discovery; contributor mode.

---

## 9. Traps that will bite a fresh session

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

---

## 10. How to verify the whole thing still works

**Run these separately.** Together they exceed the two-minute tool timeout.

```sh
N=~/.nvm/versions/node/v24.17.0/bin/node
cd ~/Work/Products/reeve

# the suite
for f in test/*.test.mjs; do $N "$f" || echo "FAILED $f"; done

# the daemon
launchctl list | grep reeve
tail -20 ~/.reeve/reeve.log

# the commands
$N bin/reeve doctor nextlyhq/nextly --as-app
$N bin/reeve status nextlyhq/nextly

# the backup
$N bin/reeve backup nextlyhq/nextly
```

`doctor` is expected to report **BROKEN** on nextly: the ruleset genuinely is
unenforced. That stays true until §8.1 is done.

### Re-arming the dispatch proof

```sh
cd ~/Work/Products/reeve
# put the planted failure back on the proof branch
git worktree add -q --detach /tmp/rearm origin/main
# edit src/notify.mjs: const LIMIT = 700  ->  4000
# commit, then: git push --force origin HEAD:test/execute-proof
# wait for CI red, then:
$N bin/reeve tick revnix/reeve --execute --log /tmp/proofN.log
```

Read the **whole** log and check the remote moved and CI went green. A partial
read is how run 11 was reported as a success when a worker had bypassed the gate.

**The brake will refuse a repeat.** Re-planting the same failure on the same PR
is counted as that failure surviving its fix, so reeve escalates rather than
dispatching -- correctly. To gather more dispatch evidence, change the failure
(a different file, a different assertion) or open a new PR; `fix_attempt` is keyed
on `(nwo, pr, cause)`. Verify what it stored rather than assuming:

```sh
$N -e 'const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.HOME+"/.reeve/state/revnix/reeve.db",{readOnly:true});
for (const r of db.prepare("SELECT pr,attempts,cause FROM fix_attempt").all())
  console.log(r.pr, r.attempts, r.cause);'
```

That table is where the failure-identity defect in §6.5 was visible, and it was
visible nowhere else.

---

## 11. Related documents

- `docs/USING-REEVE.md` — the founder-facing guide. What reeve is, what it is not.
- `docs/2026-08-20-reeve-comprehensive-audit.md` — the independent audit. Closed,
  but its reasoning is worth reading.
- `docs/2026-08-20-portfolio-readiness.md` — whether reeve can serve the other 27
  repos. Short answer: the engine generalises, the environment does not.
- `docs/github-app-setup.md` — App setup, already done.
- `~/Work/Products/nextly-workspace/nextly-ops/docs/2026-08-20-reeve-plan.md` —
  the original plan. Its "net line count goes down" claim is **known wrong**.
