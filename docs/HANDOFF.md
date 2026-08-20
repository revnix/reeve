# reeve — handoff

**Written:** 2026-08-20, end of the build session.
**Audience:** the next session, which will have none of this in context.
**Rule for reading it:** every number here was measured, not remembered. Where something is
unproven or uncertain it says so explicitly. Trust the "unproven" labels as much as the numbers.

---

## 1. What this is, in one paragraph

`reeve` is an agent-ops control plane. It watches the pull requests an agent fleet opens, reads
CI and reviewers, root-causes failures, dispatches workers to fix them, computes whether a PR is
genuinely safe to merge, and publishes that verdict to GitHub so that **GitHub does the
refusing**. It replaces `nextly-ops`, a private repo of shell scripts that held programme state
in an append-only JSONL file and whose merge gate had, when audited, merged **zero** of the last
ten pull requests while claiming to be the only sanctioned path.

It is built to serve **many projects of different stacks**, not one. That is the founder's
primary requirement and it shapes everything: a project-agnostic CORE plus a small per-project
PROFILE.

---

## 2. Where everything lives

| Thing | Path | Notes |
|---|---|---|
| **reeve (the core)** | `~/Work/Products/reeve` | git remote `github.com/revnix/reeve`, **private** |
| Product repo | `~/Work/Products/nextly-workspace/nextly` | `nextlyhq/nextly`, public |
| Old ops repo | `~/Work/Products/nextly-workspace/nextly-ops` | `nextlyhq/nextly-ops`, private. **Still live** |
| Profiles | `~/.reeve/profiles/<owner>/<repo>.json` | sidecar; four exist |
| State DBs | `~/.reeve/state/<repo>.db` | SQLite, gitignored |
| Credentials | `~/.reeve/credentials/` | mode 600, **never in a repo** |
| Dashboard | `~/.reeve/<repo>.html` | regenerated each tick |
| Log | `~/.reeve/reeve.log` | |
| Halt marker | `~/.reeve/HALT` | create it to stop everything |

### A path trap that already cost time

There are **two clones** of nextly-ops. `~/Work/Products/nextly-integrations/nextly-ops` is
**DEAD** — 39 commits behind, a 509-line ledger against the live one's 1,022. It carries a
`DEAD-CLONE.md` marker. The live one is under `nextly-workspace/`. The session that wrote this
document began by auditing the wrong one.

### Credentials

- `~/.reeve/credentials/merge-policy.pem` + `.env` — GitHub App, **App ID 4660593**, installed on
  `nextlyhq/nextly` only (installation `155196718`).
- `~/.reeve/credentials/grafana.env` — Grafana admin password.

---

## 3. Founder rulings — do not re-litigate these

These were decided explicitly. A new session should treat them as settled and build on them.

| # | Ruling |
|---|---|
| 1 | **One shared core plus a per-project profile.** Not fork-per-project |
| 2 | A **TypeScript supervisor daemon**, which **shells out to `claude`** |
| 3 | **Local-first** on the Mac, built host-agnostic; cloud (Hetzner + tmux) later |
| 4 | **Foundation first**, then autonomy |
| 5 | Engine name is **reeve** |
| 6 | The Nextly product fleet is **PAUSED** and stays paused until reeve can watch it |
| 7 | Reviewer strategy: **fix the local lenses and cut PR volume. No paid reviewer** (CodeRabbit Pro Plus was explicitly declined; do not raise it again) |
| 8 | Server enforcement on **nextly only** for now |
| 9 | GitHub App identity and ruleset repair are **approved** |
| 10 | PR watcher scope: **CI half now, review-ingest half deferred** |
| 11 | Round cap: soft cap, hard cap, **and a severity gate** (see §6.4) |
| 12 | **No release pressure.** The system serves many parallel projects, not one launch |
| 13 | First worker was allowed to **push** |
| 14 | Fresh minimal agent prompts in reeve; port lessons selectively |
| 15 | Shadow week exits on **a week of data AND zero false blocks** |
| 16 | reeve gets CI now; self-governs after Phase F |

### 3.1 The two operating modes

Every project is **product** or **client**, and the kind changes the defaults:

- **Product** (nextly, ranknaut, rext, ficonz, upkit): best foundation, then fast to market with
  an MVP. Agents should eventually research user problems, competitors and gaps. Higher autonomy
  ceiling.
- **Client** (21century, 4re, marketing-console, tby, comfy): deliver quality, best practices and
  defensible architecture always. Lower ceiling. High-risk work always human.

### 3.2 The anonymity rule — load-bearing

**In public repos and in every client repo, nothing may name reeve.** Not a check-run context,
not the GitHub App, not a workflow, branch, commit message or committed file. Neutral names only:
`.ops/`, `ops/merge-policy`, `CI Gate`. The App is deliberately called **"Merge Policy"**.

This is enforced by code, not by remembering: `init` derives where a profile is written, and a
client repo or a public repo always gets a sidecar, never a committed file.

---

## 4. The measured reality — why the design is what it is

Every one of these was measured during the session. They are the reason the code is shaped the
way it is, and a new session that forgets them will re-introduce the defects.

### 4.1 About the old system

- The merge gate merged **0 of the last 10** merges. Not a bug in the gate: the ruleset has
  **no `required_status_checks` rule at all**, `enforce_admins: false`, and
  `bypass_actors: [{OrganizationAdmin, always}]`. The founder is the org admin, so every token
  the fleet held bypassed every rule.
- **All seven cached plugin versions shipped one broken `merge-gate`** while the repo held the
  fixed one. `claude plugin update` compares the **version string, not the commit**, so a fix
  without a version bump reaches nobody. This ran for 12 commits.
- `ledger claim` was a read-check-append race. Reproduced: **20 concurrent claims produced 4
  winners**, all told they owned the task, with the projection showing one.
- Eight claims were held with no lease or heartbeat, the oldest 12 hours, two on PRs that had
  merged 12 hours earlier.
- An orphan `lint-staged` stash made **every** worktree reap quarantine instead of clean, because
  the stash stack is shared across all worktrees of a clone.

### 4.2 About reviewers

- **Codex refuses ~93% of requests** ("You have reached your Codex usage limits"). One measurement
  found 65 of 65 comments across 40 merged PRs were refusals.
- **CodeRabbit fails green**: it reports `state=success` with the truth in
  `description="Review rate limited"`. Anything reading `.state` treats an unreviewed PR as
  reviewed.
- **Greptile is not installed.** Tagging it produces mention bookkeeping and nothing else. Qodo is
  configured in `.pr_agent.toml` and has never commented.
- Codex posts **findings** as a `/pulls/N/reviews` object and a **clean pass ONLY as an issue
  comment**. Polling one endpoint cannot distinguish "clean" from "never reviewed".
- Both surfaces name the reviewed revision as `**Reviewed commit:** <10-hex>` — abbreviated, so
  coverage is a prefix comparison, never string equality.
- Codex's own comment body contains the literal string `@codex review`, so a naive round counter
  counts the bot and can self-trigger.

### 4.3 About the platform

- `claude` is a **native arm64 binary**, not a Node script. The Node version is irrelevant to
  spawning workers.
- `--output-format stream-json` **requires `--verbose`** under `-p`. Without it the process exits
  1 having written nothing, which is indistinguishable from a hang.
- A worker whose tools were **denied** still exits 0 with `is_error: false` and writes a plausible
  answer. `permission_denials` is the only signal. `subtype` reads `"success"` even on auth
  failures.
- A **429 hangs the CLI indefinitely** (measured 5m33s, no output) because it retries internally.
  `CLAUDE_CODE_MAX_RETRIES` bounds it.
- **SIGTERM runs claude's SessionEnd hook and exits 143 with `signal === null`.** SIGKILL runs
  nothing. A supervisor inspecting only `signal` calls every timeout a clean exit.
- `spawn(detached:true)` + `process.kill(-pid)` kills the whole group. A plain `kill(pid)`
  **orphans the grandchild onto pid 1** — proven with a control.
- **pid reuse is real here**: pids churn at ~963/s and a genuine wrap-around was forced in 192
  seconds. `ps -o lstart= -p <pid>` is the identity token, not the pid.
- `--bare` will **NOT** become the `-p` default. An earlier claim that it would was searched for
  directly in the binary with a positive control and **refuted**. What is true: `--bare` never
  reads OAuth, so reeve cannot use it.
- `node:sqlite` warns "experimental" on Node 22.18 and is clean on 24.17. **reeve requires Node
  ≥24.** `node` on this machine's PATH is **v22.18.0** (nvm default alias is 22), so the absolute
  path must be pinned: `~/.nvm/versions/node/v24.17.0/bin/node`.
- **A user token cannot create check runs** (403, App only). This is why the App is required.
- launchd never sources a shell profile: a bare `node` in a plist fails **exit 78 with an
  empty stderr log**. Only `launchctl print` reveals it.
- There is **no `timeout` binary** on this machine.
- Machine: Apple M4 Pro, **10 performance cores**, 48 GiB. Concurrency cap 5, ceiling 6, driven by
  observed load.

### 4.4 About the portfolio (10 repos surveyed)

These falsify assumptions that were hard-coded in the old system:

- **5 install toolchains**; 3 pnpm majors with mutually exclusive Node ranges. One repo
  (21century) tracks **two divergent lockfiles** — `package-lock.json` resolves nextly alpha.20
  while `package.json` declares `^0.0.2-alpha.30`, which the pnpm lock satisfies. `npm install`
  there installs the wrong version.
- The typecheck task is `check-types` in nextly and `typecheck` in five others.
- **Only 1 of 10** repos uses changesets, turbo, or three SQL dialects.
- **5 repos have no CI.** 4re's `.github/workflows/` exists and is **empty**. rext's CI fires on
  `pull_request: closed` — after the merge — with every job `continue-on-error`.
- **Branch protection returns HTTP 403 on all 7 private repos** (free plan). They can only ever be
  `attested`, never `enforced`.
- Client-repo hazards, measured: **21century's `next build` reaches a live production database**
  and sits in the same script block as `db:migrate:fresh`; **4re auto-applies migrations on
  container boot**; both commit production dumps and **one commits another client's credentials**;
  upkit-extension can publish an unrecallable browser-store version.

---

## 5. What was built

Six phases, all complete. Measured at the time of writing:

- **21 commits**, CI green *now*. Over the repo's 10 runs, 8 succeeded and 2 failed: one on
  main (fixed by the next commit) and one on PR #1 (the deliberately planted bug). "CI is green"
  is true; "CI has always been green" is not
- **3,711 lines of source** across 18 `.mjs` files — this figure EXCLUDES `src/db/schema.sql`
  (184 lines) and `bin/reeve` (206). All shipped code is ~4,100 lines
- **1,067 lines of tests** across 10 `test/*.test.mjs` — excludes 4 helper files in `test/`
  that are fixtures, not tests (`claimworker2.mjs`, `crashdrain.mjs`, `reconcile.demo.mjs`,
  `seed.mjs`)
- **539 assertions passing, 0 failing** across 33 test files
- **4 profiles** written (nextly, rext-backend, 21century, reeve)
- **The launchd agent is installed and running** as of 2026-08-20 16:29 UTC — shadow mode,
  `--execute` off, watching `nextlyhq/nextly`. See §7.

| File | What it does |
|---|---|
| `src/db/schema.sql` | events, graph, runs, leases, checkpoints, outbox, inbox, facts, views |
| `src/db/ops.mjs` | atomic claim, heartbeat, reap, checkpoint, outbox, JSONL export |
| `src/db/reconcile.mjs` | idempotency reconcilers for push / PR create / comment / merge |
| `src/db/migrate.mjs` | JSONL → SQLite, replaying the event log |
| `src/profile/schema.mjs` | the profile schema and a **fail-closed** validator |
| `src/profile/detect.mjs` | auto-detection; returns *questions* rather than guesses |
| `src/github/app.mjs` | App JWT, installation token, permission audit |
| `src/github/reconciler.mjs` | head pinning, check classification, settlement, timeline |
| `src/verdict.mjs` | the merge decision: PASS / BLOCK / UNKNOWN |
| `src/watcher.mjs` | a **total** verdict → action function |
| `src/ci-rootcause.mjs` | annotations tier, log-slice fallback, fingerprints |
| `src/supervisor.mjs` | worker lifecycle, group kill, liveness, capacity |
| `src/prompts.mjs` | worker prompts **generated from the profile** |
| `src/pr.mjs` | evaluate one PR, publish the verdict |
| `src/daemon.mjs` | the tick loop |
| `src/status.mjs` | `status`, `statusline`, `why` |
| `src/dash.mjs` | the one-page HTML view |
| `src/init.mjs` | detect → preview → merge → prove |
| `src/doctor.mjs` | what is actually true right now |
| `deploy/com.revnix.reeve.plist` | validated launchd agent (**never installed**) |

### Command surface

```
reeve doctor [owner/repo]   0 ok · 1 broken · 3 degraded
reeve init                  --set k=v, --write   (0 no-op · 2 changed · 1 needs an answer)
reeve status [owner/repo]   --health, --json
reeve why <pr>              the decision trail, with the clause table
reeve statusline            one line, reads state only
reeve dash                  --health, --out, --open
reeve run [owner/repo]      --tick, --execute, --enforce, --interval, --halt
```

**Always invoke with `~/.nvm/versions/node/v24.17.0/bin/node`**, or a `node` that is ≥24.

---

## 6. Design invariants — the reasoning that must survive

### 6.1 The governing rule

> An agent may reason probabilistically. **Authorization, state transitions, evidence binding and
> merge decisions must be deterministic, durable and independently verifiable.**

The CLI is the deterministic half and contains no LLM call that decides anything. The prompts and
agents are the probabilistic half and cannot merge anything.

### 6.2 UNKNOWN never merges

Three outcomes, one of which merges. **Every fail-open defect found in the old system was an
UNKNOWN silently rendered as a PASS**: an absent gate script read as a pass, a rate-limited
reviewer reporting success, a fork PR with zero check runs. So:

- absence is never success;
- "not checkable" blocks;
- the gate asserts a check run **exists** for the SHA it judges, not merely that nothing failed.

### 6.3 reeve does not merge

It computes a verdict, publishes it as a check run bound to an exact `head_sha`, and **GitHub
refuses**. The actuator runs as a GitHub App installation, which is not an org admin and therefore
*cannot* bypass. This inverts the failure mode: a stale reeve fails to publish and the merge
blocks, where the old design merged on stale logic.

### 6.4 The round cap has a severity gate

| Phase | Condition | Behaviour |
|---|---|---|
| Rounds 1 to soft cap (5) | any finding | fix everything |
| Past soft, up to hard (10) | **P0/P1 open** | keep going; criticals are never spilled |
| Past soft | only P2 and below | spill to one follow-up, then gate |
| At the hard cap | P0/P1 open | **escalate** |

Plus: **one fix attempt per finding fingerprint**. A second attempt at the same failure escalates
rather than guessing again.

### 6.5 Other rules that are load-bearing

- **Pin the head once per tick** from `git ls-remote`, never `headRefOid` (which reports the
  merged head).
- **Union check-runs with commit statuses** — they demonstrably disagree.
- **`cancelled` and `stale` are absences of information, not failures.** A cancelled run is almost
  always a superseded one. Both still refuse a merge; the difference is RED escalates to a human
  and UNKNOWN waits.
- **Settlement needs three consecutive readings with a stable check-name set**, because a workflow
  that has not scheduled its jobs reports an empty, unfailing set identical to a clean run.
- **Inherited vs caused**: a failure that also exists on the base is never repaired inside a
  feature PR, because that hides where it came from.
- **A shared cause is one escalation, not N.** Four PRs on a red base is one phone push.
- **Refusal is ABSENT, never PASS.**

---

## 7. Proven, and unproven

### Proven

- **The full worker loop ran autonomously.** A planted bug on `revnix/reeve` PR #1: red CI → root
  cause → fix → push → **green CI**, in 185 seconds for $1.51, no human. The worker's own commit
  explained *why* the default had to be positive, added a test pinning the count, and carried no
  attribution trailer.
- The state layer passes its lifecycle suite including exactly-once-across-crash.
- The migration replays the real 1,022-event ledger.
- `doctor`, `status`, `why`, `init`, `dash` all run against real repos.
- The GitHub App authenticates and publishes check runs.
- The shadow check is live on the open PRs.

### Found by an independent fact-check at the end of the session, and FIXED

Two defects that a fresh session would otherwise have hit immediately:

- **`reeve doctor` refused its own profile.** `daemon.mjs` and `watcher.mjs` read
  `profile.watch.*`, and the schema never declared those keys, so the validator rejected them
  and `doctor` exited before doing anything. A test now asserts that every profile key the code
  reads is declared in the schema, so this cannot silently regress.
- **The CLI help advertised four working commands as "not yet built"** (`status`, `why`, `init`,
  `dash`). Corrected.

Also noted, not fixed: a stray `life.db` (110 KB) sits at the repo root; `reeve status` reads
the local store, so it can show a PR state that GitHub has since moved past. Neither is a defect,
but do not cite a `status` screen as current truth without re-ticking.

### NOT proven — say so, do not assume

- **The daemon is running unattended as of 2026-08-20 16:29 UTC**, but a full night has not yet
  elapsed. Installed via `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.revnix.reeve.plist`.
  Read `~/.reeve/reeve.log` and confirm `launchctl list | grep reeve` shows a live pid before
  claiming anything about it.

  Installing it exposed **five real defects that only appear when it actually runs**, all now fixed:

  1. **The plist watched the wrong repository.** It passed no positional, so `reeve run` detected the
     repo from `WorkingDirectory`'s git remote and spent every tick on `revnix/reeve`, where the App
     is not installed, so every publish returned HTTP 404. "Validated" had meant `plutil -lint`
     passed, which proves nothing about the command inside. `test/deploy.test.mjs` now asserts the
     agent names a repo that has a profile and a state database.
  2. **Every log line was written twice**, because `StandardOutPath` names the file `log()` already
     appends to. `log()` now compares stdout's `(dev, ino)` against the log's.
  3. **`src/github/reconciler.mjs` was a BINARY file to git.** One raw NUL byte at offset 7114 —
     a `names.join("\0")` delimiter written as the literal byte instead of the escape. `git diff`
     rendered it as "Binary files differ", `git grep` skipped it, and every review lens reading a
     diff saw an empty change. The file that decides whether a check run counts was invisible to
     review, in a system whose whole purpose is judging diffs. Found only because `git grep` said
     "Binary file … matches" while searching for something else. `test/source-is-text.test.mjs`
     now asserts no tracked source file contains a NUL **and** that git itself treats each as text.
  4. **`identity.worktreeRoot` was relative in all four profiles**, and the dispatch fallback was
     `process.cwd()`. Under launchd that meant a worker fixing a nextly PR would have run inside
     the reeve checkout. The schema now refuses a relative value and dispatch refuses rather than
     defaulting. Only reachable with `--execute` on, which is the next milestone.

  5. **The same escalation was announced on every tick** — five ticks, five notifications per PR,
     which is ~576 overnight for two unchanged conditions. The standing set is now durable in the
     store, and clearing is announced as well as arrival.
- **The ops CI guard has never fired.** It triggers on PRs touching `plugins/**` and everything was
  pushed to main directly.
- **`--execute` has only ever run once**, on one PR, watched.
- Nothing has been proven on a **second project**. Three profiles exist; only nextly has been
  driven.

---

## 8. What remains

### 8.1 Time, not code

- **The shadow week.** Seven days of the gate publishing `neutral`, with zero false blocks, before
  it goes enforcing. One false block already occurred and was fixed (`cancelled` read as red), so
  the clock starts from a clean tick.
- **The ruleset flip**, after that plus green main. This is the riskiest remaining step: work in
  flight starts blocking and it will feel like the system got worse. That is the moment a bypass
  gets reopened and the programme dies. Do not skip the shadow week.

### 8.1b The Codex audit — what is closed and what is not

`docs/2026-08-20-reeve-comprehensive-audit.md` is an independent audit of this
repo. **Ten of its claims were re-verified by hand and all ten held.** It is
accurate; treat its remaining items as real.

**Closed 2026-08-20**, each with a test that failed on the broken code first:

| Audit finding | State |
|---|---|
| P0 settlement was one API read replayed three times | **fixed** — persisted per PR, folded once per tick, proven live |
| P0 reeve read its own verdict as CI evidence | **fixed** inside `readChecks`, so no caller can forget |
| P0 the retry brake was non-functional | **fixed** — durable, counted against a head-independent cause |
| P0 durable state not connected to execution | **fixed** — a run is now the only way a worker may start |
| P1 status freshness lied when the daemon stopped | **fixed** — measured against the clock, plus a liveness banner |
| P2 a new check run every tick | **fixed** — the run at the head is updated |
| P2 the lifecycle test could not fail CI | **fixed** — it printed FAIL and exited 0 |

**A verification pass then found the fixes themselves were partly wrong**, which
is the single most useful thing that happened all session:

- `cause`/`fp` were declared in the per-PR loop and read from the dispatch loop —
  **every `FIX_CI` would have thrown a ReferenceError** under `--execute`. Every
  unit test around it was green, because nothing drove the dispatch path at all.
  `test/dispatch-e2e.test.mjs` now does, with the collaborators injectable.
- The settlement **floor carried across heads**, so a PR whose new revision runs
  fewer workflows could never settle. Both my new test and an older one had
  pinned that latch as if it were the intent.
- Excluding the policy check **dropped every head's count by one**, below floors
  recorded when it still counted — measured live on all five open PRs. Floors now
  carry a `CHECK_ACCOUNTING` version and are discarded when it changes.
- That exposed a general gap: `schema.sql` is all `CREATE ... IF NOT EXISTS`, so
  **an existing database can never gain a COLUMN**. `open()` now adds declared
  missing columns.
- Escalations were **retired on absence** — a PR a tick could not evaluate read as
  resolved.

**Closed later the same day**, after the verification pass:

| Audit finding | State |
|---|---|
| P0 worker safety was a prompt boundary | **fixed** — `src/sandbox.mjs`, measured against the CLI before it was designed |
| P1 a cancelled ancillary job vetoed the base forever | **fixed** — the required set decides which absences veto |
| P1 the review actions were executable on data that is not real | **gated off**, and `unspilledCritical` no longer claims a zero it cannot know |
| P1 MISSING_REQUIRED settled on a count | **fixed** — settles on the CI provider's suites being terminal |

The sandbox is the one worth reading the code for. Five things were measured
against the installed CLI *before* designing it:

- `permissions.deny` blocks in headless mode.
- Denying `Write`/`Edit` while allowing bare `Bash` is **theatre** — asked to write
  a denied file the model used `printf > file` and succeeded next turn.
- A **scoped allowlist contains Bash on its own**: granted only
  `Bash(git status:*)`, `git status` ran while `git push`, `printf >`,
  `printf | tee` and a chained `git remote -v` were each refused.
- Path-scoped denies work, verified with a control file that *did* change.
- **`deny: ["Bash"]` removes the tool entirely, scoped grants included.** The first
  version of the sandbox did that and would have shipped a fixer that could edit
  code but never run a test — reporting success on work nothing had checked. That
  cost a redesign and is recorded in the file rather than smoothed over.

The worker also no longer holds push or merge authority. reeve pushes after
`reviewDiff` checks what **git** says changed — not what the worker says it did —
against quarantine, sensitive paths, the files that judge the work, and the lane's
territory. An empty diff refuses; an unreadable one refuses with its own reason.

**Also closed:**

| Audit finding | State |
|---|---|
| P1 worktree lifecycle | **built** — acquire / verify / publish / release, driven against real git repos |
| P1 clean-merge counted an empty check set as clean, and the daemon never computed it | **fixed** — unjudged is reported; computed when the open set shrinks |
| P1 `node.status` had no `pending`, so the decisions band was a dead query | **fixed** — it now surfaces a real open decision that had been invisible |
| P1 state keyed by short repo name | **fixed** — owner-scoped, with a one-time move of the existing store |
| P1 the 20-PR cap was silent | **fixed** — it says when it bites |
| P2 `run --tick` inert, `doctor --as-app` inert, `statePath` vs `state.location` | **fixed** — the code now honours what the docs promised |
| P2 no README or runbook | **written** |

Three of these were harder than they looked, and the difficulty is the useful part:

- **Quarantining a worktree moved the directory and told git nothing**, so git
  still believed the branch was checked out there and refused every later worktree
  on it. One quarantine would have wedged that branch permanently. Found by the
  test, which drives real repositories rather than mocks.
- **The status-vocabulary guard took three attempts**, and each earlier version
  would have passed the bug it was written to catch: unioning every table's
  vocabulary (`pending` is valid on `outbox`, just never on `node`), then a table
  regex that silently skipped everything declared `) STRICT, WITHOUT ROWID;`, then
  a magic-minimum control instead of a count derived from the schema.
- **The deploy guard hard-coded the state path**, so when state moved it checked a
  location the code had stopped using and reported the daemon broken while it was
  fine.

**The audit list is closed.** The last two — an external alert sink and
`inheritedOrCaused` comparing names rather than failures — landed 2026-08-20.
Escalations now push to ntfy on the topic `revnix-reeve`, redacted, and only when
they arrive.

**What the first real `--execute` dispatch taught, which no test had:**

The worker failed with **eleven denied tool calls**, and the sandbox was the
reason. reeve's own profile declares `npm test`, but that script is a shell loop
over `node <file>`, and the worker reasonably reached for the file directly to
check a one-line change. A fixer that cannot run one test gives up, and it did.

The premise was wrong, not just the list. The sandbox was built as if restricting
**execution** were the control. It is not and cannot be: a worker holding `Write`
can write a script and run it through any granted runner, so denying `node -e`
bought nothing and made the failure illegible. That is the same error as denying
`Write` while granting a bare shell — which had already been measured, and which I
had thought I had learned.

What a sandbox can enforce against a process whose job is to change code is
**authority, network and paths**, and those are unchanged. Each unit now gets its
own language's runtime.

Two smaller findings from the same run:

- A refusal reported git's **progress** line as its reason, because git narrates on
  stderr and the first line is rarely the failure. A wrong reason is worse than a
  vague one.
- A denied dispatch **consumed the PR's single repair**, so the next tick escalated
  "the same failure survived a second fix" when no fix had been attempted. DENIED
  is now refunded: nothing was attempted, so nothing is charged.

Worth recording that the failure was legible at all only because the layers around
it held: the denial was detected, the run was marked failed rather than
successful, and nothing was pushed.

### What eight `--execute` dispatches taught

Run against `revnix/reeve` PR #2 with a deliberately planted failure, so that a
mistake cost nothing. **Seven of eight failed, every one a defect in reeve.** The
list matters less than the pattern at the end of it.

| Failure | Cause |
|---|---|
| Wrong reason reported | git narrates on stderr; the FIRST line is progress, not the error |
| 11 denials | The sandbox restricted **execution**, which is impossible for a code fixer |
| 11 denials | Denied **reading** `.github`, and the matcher rejects compound commands |
| 5 denials | The **prompt instructed a push the sandbox denies** — two halves of reeve disagreeing about who publishes |
| 6 denials | **`git -C <path> log` does not match `Bash(git log:*)`** — the flag precedes the subcommand |

**The real lesson is not about sandboxes.** `runWorker` returned the denied
commands from the very first failure and the daemon **kept only the count**. Two
whole rounds were spent reproducing by hand what the run already knew, from
hand-written prompts that did not match the generated one — and both reproductions
produced a wrong conclusion. Printing the refused commands was fifteen lines and
named the cause immediately.

> When a system reports a number where it holds the detail, whoever reads it will
> guess. `4 tool call(s) denied` is a number to guess at; the commands are the
> diagnosis.

**Two design corrections worth keeping:**

- **A sandbox for a code fixer cannot restrict execution.** A worker holding
  `Write` can write a script and run it through any granted runner. What is
  enforceable is authority, network and paths — and the diff gate, which sees what
  actually happened rather than what was permitted.
- **Quarantine and sensitive are different.** Quarantine denies every verb, reads
  included: it is data that must never be seen. Sensitive and self-governing paths
  deny writes only — reading the failing workflow is how a fixer diagnoses;
  changing it is what needs a human.

**And a verification note:** the check that `deny` still beats a broadened `git`
grant was, in its first form, **incapable of showing a difference** — the worktree
sat at the remote's head, so a push was a no-op whether refused or allowed. Rebuilt
with a local commit that would have moved the remote, it gave a real answer: both
attempts refused, remote unchanged.

**Still open:**

4. P1 `inheritedOrCaused` compares check NAMES, not failures.
9. P1 caps: 20 open PRs silently, no pagination past 100, `doctor` hard-codes `main`.
11. P2 no external alert sink — "needs you" reaches a local log and nothing else.

### 8.2 Real remaining code, roughly in order

1. ~~**Prove the daemon overnight.**~~ **IN PROGRESS since 2026-08-20 16:29 UTC.** Installed, in
   shadow, `--execute` off. Read `~/.reeve/reeve.log` in the morning. Three service-only defects
   were found and fixed in the first fifteen minutes (§7).
2. ~~**Fix the three reviewer lenses.**~~ **DONE 2026-08-20** (`nextly-ops` `ce9606d`,
   plugin `0.4.3`). Two of this item's three original claims were **wrong**, and re-measuring
   mattered:

   - **TRUE and proven:** `git fetch origin main "pull/N/head"` leaves `FETCH_HEAD` holding both
     refs, and `git show FETCH_HEAD:<path>` resolves to the **first** — `main`. Measured on PR
     #925: `FETCH_HEAD` was `6c9a5ab0`, the PR head `45b423a5`. Every lens following that
     instruction read the base while believing it read the PR. Fixed by fetching into
     `refs/review/pr-<N>`, verified to equal the PR head.
   - **Misstated:** `reviewer-correctness` did *not* read the base as its primary path — line 100
     already used `gh pr diff`, which is correct. The bug was confined to file-content reads and
     re-review diffs. The other two lenses had **no acquisition instructions at all** — both begin
     "for every test the diff adds or changes" without saying how to obtain it, or to pin a head.
     Both now carry it.
   - **REFUTED:** "two of three are proper subsets of the third". Measured: 6 of 29 and 6 of 26
     substantive lines overlap, and **all six are the citation boilerplate plus the `tools:`
     frontmatter line**. Substantive overlap is zero; the lenses are genuinely distinct.
   - **Deliberately not changed:** `review-fleet` still passes an explicit tool allowlist rather
     than `--agent`. The frontmatter declares unrestricted `Bash` while the allowlist scopes it to
     `gh pr`, `gh api`, `git`, `ledger` and `node`. Making the frontmatter live would *widen* the
     trust boundary for agents whose input is untrusted PR and CI text. The frontmatter being inert
     is the safer of the two states, so the invocation stays as it is.
3. **The state migration.** JSONL → reeve's SQLite store. This is what makes the deletion of
   `bin/ledger` (371 lines), `dispatch`, `merge-gate` and `dashboard` possible. Until then they
   cannot be removed even though reeve supersedes them.
4. **Worktree lifecycle in reeve.** `worktree-sweep`/`worktree-reap` have no equivalent and are
   still served by the old plugin.
5. **Dogfood, rebuilt safely.** The old one was deleted from the hooks, not ported: it ran
   `pkill -f "next start"` (matching any project), stamped before success, and ran `@latest` at
   session start.
6. **Second project.** Prove the core/profile seam with rext-backend or 21century. Anything that
   must be edited in the core to make it work was misfiled.

### 8.3 Deferred by ruling (Phase G)

Review ingest with round counting and spillover; founder-preference learning; product-mode
discovery; contributor mode beyond the four fields already in the schema.

---

## 9. Traps that will bite a fresh session

1. **The archive guard hook refuses any Bash command containing the frozen-history directory
   name**, even in a `grep -v` exclusion. Build searches that avoid naming it literally.
2. **`grep` is shadowed by ugrep** and skips some files; `git grep` is blind to ignored files.
   Use both, and **always run a positive control** — an absence search that reports zero for
   everything is broken, not conclusive.
3. **Node on PATH is v22.** Always use the absolute v24 path.
4. **A fresh `git worktree` cannot commit**: husky's lint-staged spawns eslint from an absent
   `node_modules`. Budget the install, and never use `--no-verify`.
5. **The Bash tool's own 2-minute timeout** will kill a long dispatch. Use `run_in_background`.
6. **`GF_SECURITY_ADMIN_PASSWORD` only applies at first provisioning.** Rotating Grafana's password
   needs `docker exec ... grafana cli admin reset-admin-password`, and must be verified with the
   old password returning 401, not just the new one returning 200.
7. **Timezone**: this machine is +05:00. A test that compares against a naive local parse passes
   here and fails on a UTC runner. reeve's CI runs the suite twice, once under `TZ=Asia/Karachi`.
8. **Do not raise CodeRabbit Pro Plus again.** It was explicitly declined.

---

## 10. How to verify the whole thing still works

**Run these separately, not as one block.** Two `doctor` calls plus a `tick` exceed the Bash
tool's two-minute timeout — a full tick against nextly's four open PRs takes ~60s on its own.

```sh
N=~/.nvm/versions/node/v24.17.0/bin/node
cd ~/Work/Products/reeve

# the suite
for f in test/*.test.mjs; do $N "$f" || echo "FAILED $f"; done

# the commands, against real repos
cd ~/Work/Products/nextly-workspace/nextly
$N ~/Work/Products/reeve/bin/reeve doctor nextlyhq/nextly --db ~/.reeve/state/nextly.db
$N ~/Work/Products/reeve/bin/reeve status nextlyhq/nextly --db ~/.reeve/state/nextly.db --health
$N ~/Work/Products/reeve/bin/reeve tick   nextlyhq/nextly --db ~/.reeve/state/nextly.db

# the App
$N -e 'import("/Users/mobeen/Work/Products/reeve/src/github/app.mjs").then(async m=>{
  const a=await m.authenticate("nextlyhq/nextly");
  console.log(a.ok?"App ok, installation "+a.installationId:"App FAILED: "+a.why);})'
```

`doctor` is expected to report **BROKEN** on nextly. That is correct: the ruleset genuinely is
unenforced, the merge shape genuinely is mixed, and Codex genuinely is down. It will keep saying so
until §8.1 is done.

---

## 11. Related documents

- `~/Work/Products/nextly-workspace/nextly-ops/docs/2026-08-20-reeve-plan.md` — the full plan,
  revision 2. **Note:** its "net line count goes down" claim is **wrong** and known to be wrong;
  reeve is ~3,700 lines and the old plugin's superseded scripts are still present.
- `~/Work/Products/nextly-workspace/nextly-ops/docs/2026-08-20-nextly-ops-comprehensive-audit.md` —
  the original independent audit that started this.
- `~/Work/Products/reeve/docs/github-app-setup.md` — App setup, already done.
- `~/Work/Products/reeve/docs/2026-08-20-portfolio-readiness.md` — whether reeve can serve the other
  27 active repos. Short answer: the engine generalises, the environment does not. Every org is on
  GitHub's **free plan**, so enforcement is impossible outside the one public repo; the App reaches
  one repo; and outside nextly and Comfy-Org **no workflow triggers on a pull request**, so every PR
  would read UNKNOWN and block forever.
- `~/Work/Products/nextly-workspace/nextly-ops/telemetry/README.md` — the telemetry fix and its trap.
