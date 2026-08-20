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

- **16 commits**, CI green
- **3,711 lines of source** across 18 files, **1,067 lines of tests**
- **254 assertions passing, 0 failing**
- **4 profiles** written (nextly, rext-backend, 21century, reeve)
- **0 launchd agents installed** — the daemon has never been run as a service

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

### NOT proven — say so, do not assume

- **The daemon has never run unattended for hours.** This is the entire point of the project. The
  plist is validated but **never installed**. `launchctl list | grep reeve` returns nothing.
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

### 8.2 Real remaining code, roughly in order

1. **Prove the daemon overnight.** Install the launchd agent, run in shadow with `--execute` off,
   read the log in the morning. Needs nothing from the founder.
2. **Fix the three reviewer lenses.** They read `origin/main` instead of the PR diff
   (`git fetch origin main "pull/N/head"` then `FETCH_HEAD` is ambiguous), their frontmatter is
   inert because `review-fleet` invokes plain `claude -p` rather than `--agent`, and two of three
   are proper subsets of the third. **This gates the merge condition**, because Codex is 93%
   refused.
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
- `~/Work/Products/nextly-workspace/nextly-ops/telemetry/README.md` — the telemetry fix and its trap.
