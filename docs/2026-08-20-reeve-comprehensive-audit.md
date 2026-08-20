# Reeve comprehensive follow-up audit

**Audit date:** 2026-08-20  
**Audited revision:** [`bc5ee440e1d5d0ada34fbcc41071d3b187420371`](https://github.com/revnix/reeve/commit/bc5ee440e1d5d0ada34fbcc41071d3b187420371)  
**Baseline:** `nextly-ops` audit from earlier on 2026-08-20  
**Scope:** Reeve core, profiles, state layer, supervisor, GitHub reconciliation and verdicts, CI watcher, launchd deployment, status/dashboard, tests, the live Nextly shadow run, and the remaining `nextly-ops` state  
**Product-code changes:** none. This audit adds only this document.

Most line-level source links use commit `5d08b52`, the last behavior-changing commit in the audited range. The intervening `4b2bc09` changed a raw NUL in `src/github/reconciler.mjs` to its source escape without changing the runtime delimiter; `bc5ee44` changed documentation only. Both deltas were inspected, and the final audited head was tested separately.

> This is an independent follow-up audit. Reeve's plans and handoff were treated as claims to test, not as proof that the implementation satisfies them.

## Executive verdict

**Yes. Reeve is materially, substantially better than `nextly-ops`.** This is not merely a rename or a cleaner README. It is a real architectural correction.

The strongest change is conceptual: Reeve separates a project-agnostic core from per-project profiles, makes GitHub—not an agent—the intended enforcement boundary, represents uncertainty explicitly, adds transactional state primitives, supervises process groups, and tests many of the exact failure shapes found in the first audit. The old system was mainly a graph plus prompts and shell orchestration. Reeve contains the beginnings of a real control plane.

The honest qualification is equally important:

**Reeve is currently a useful shadow observer and a promising supervised fixer. It is not yet a safe autonomous execution engine or an enforceable merge policy.**

The main reason is not lack of code. It is that the strongest new primitives are not connected to the live execution path. The daemon dispatches workers without creating durable runs, leases, checkpoints, or outbox effects. Retry state is not persisted—and is not even initialized in the normal CLI path. Risk controls are injected into an LLM prompt but are not enforced by the filesystem, command runner, Git credentials, or diff gate. Real enforcement also contains two decision bugs: Reeve simulates three stable polls from one API read, and its published policy check will become an input to its next verdict and can latch itself red permanently.

My recommendation is therefore:

- Continue the shadow run. It is already producing valuable evidence.
- Keep `--execute` **off** in the unattended launchd service.
- Keep `--enforce` **off** and do not make `ops/merge-policy` required yet.
- Do not call Reeve portfolio-ready because profiles exist. Prove the execution boundary on one second project after the blockers below are fixed.

If the old `nextly-ops` safe-autonomy score was roughly **1/5**, Reeve is now approximately:

| Capability | Score | Honest current state |
|---|---:|---|
| Shadow observation | 3.5/5 | Useful now; live defects are visible rather than swallowed. |
| Deterministic verdict design | 3/5 | Strong model, but integration bugs make enforcement unsafe. |
| Durable state primitives | 4/5 | Good SQLite/lease/outbox foundation in isolation. |
| Durable execution | 1.5/5 | The daemon bypasses those primitives. |
| Cross-project profile design | 3.5/5 | The seam is good; many fields are still descriptive only. |
| Cross-project operation | 1.5/5 | Four profiles, one running project, one watched fixer proof. |
| Security and authority isolation | 1.5/5 | Better intent and App identity; real workers still rely on prompts and broad local credentials. |
| Safe unattended autonomy | 1.5/5 | Not ready for `--execute` or `--enforce`. |

## What is genuinely better

### 1. The architecture now points in the right direction

Core/profile/state is the correct decomposition. Project-specific commands, reviewers, risk paths, merge shape, authority policy, and project kind do not belong in a Nextly-specific fork. The profile validator is fail-closed on unknown and malformed fields, and `init` asks rather than silently guessing on important ambiguities.

This is a major improvement in both architecture and DX.

### 2. The state layer fixes the old claim race in isolation

The SQLite schema has strict tables, foreign keys, a partial unique index for one live run per task, leases, heartbeats, checkpoints, an inbox/outbox, idempotency keys, facts, and canonical views. Mutations use `BEGIN IMMEDIATE`, and the claim is a single statement rather than an unlocked read followed by append.

The concurrency and crash tests are meaningful. This directly addresses one of the earlier P0 findings.

### 3. `PASS / BLOCK / UNKNOWN` is the right verdict model

Absence no longer automatically means success. Reeve explicitly models missing checks, unreadable thread state, unavailable reviewers, stale review coverage, red base state, ledger blockers, and GitHub mergeability. The implementation carries the pinned head SHA through the verdict and publishes against that SHA.

That is much more intellectually honest than the old gate.

### 4. Process supervision is much stronger

The supervisor uses detached process groups deliberately, kills the group rather than only its leader, gives SIGTERM a grace period before SIGKILL, recognizes Claude's exit-143 behavior, treats permission denials as failure, bounds internal provider retries, and records PID start time to distinguish reuse. These are unusually good implementation details.

### 5. Reeve now tests its own important assumptions

At the audited revision, Reeve has its own CI and a sizeable incident-derived suite. The latest run at the audited head is green: [Reeve CI run 32395180927](https://github.com/revnix/reeve/actions/runs/32395180927).

The tests are not generic coverage theater. Many have positive and negative controls around real defects: empty checks, `startup_failure`, cancelled runs, reviewer refusal, PID reuse, orphaned grandchildren, timezone parsing, denied tool calls, stale head coverage, and escalation deduplication.

### 6. The shadow-first rollout is correct

The launchd service is currently installed against `nextlyhq/nextly` with neither `--execute` nor `--enforce`. That is the correct staging decision. The first minutes of the service already exposed wrong-repository targeting, doubled logging, undefined failure names, cancelled-check semantics, and notification spam.

This is exactly what a shadow period is for.

### 7. Several earlier findings are genuinely resolved or removed

- `run-on-either` was removed rather than patched around partial side effects.
- Reeve has CI and a meaningful test suite.
- Session/service health is audible rather than every hook ending in `|| true`.
- The anonymous Grafana admin exposure in the old ops repo was fixed.
- Worker prompts are generated from a profile and are much shorter than the old contradictory reviewer protocol.
- The verdict is a check on the exact head rather than a local script claiming exclusive merge authority.
- The system now distinguishes configured reviewers from substantive evidence and treats quota refusal as absence.

Those are real gains, not cosmetic progress.

## Decision blockers

### P0 — The durable state layer is not connected to live execution

The state layer implements `claim`, `heartbeat`, `reap`, `checkpoint`, `resume`, `enqueue`, `leaseOutbox`, `settleOutbox`, and `recoverOutbox`. The daemon imports and uses none of them.

Instead, the live path:

1. reads PRs;
2. computes a decision;
3. writes a best-effort `pr.decided` event;
4. directly spawns a worker;
5. lets that worker commit and push;
6. writes a best-effort `worker.finished` event.

The relevant path is visible in [`src/daemon.mjs` lines 134-148](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/src/daemon.mjs#L134-L148) and [156-216](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/src/daemon.mjs#L156-L216). Database write failures are explicitly swallowed at [lines 74-83](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/src/daemon.mjs#L74-L83) and again after a worker exits.

Live evidence confirms the disconnect. The Nextly state DB had 1,144 events and 264 nodes at audit time, but:

```text
run        0
checkpoint 0
outbox     0
inbox      0
```

The Reeve DB from the first worker proof likewise had zero runs and zero outbox rows.

This means a hard crash can still leave an unrecorded worker or ambiguous push, and a restart can dispatch the same work again. The service log shows the same Reeve PR fix dispatched at 15:02 and again at 15:12; only the second dispatch has a recorded completion.

**Required fix:** make a durable run the only way a worker may start. In one transaction, create/claim the run, bind PR/head/action/failure fingerprint, and record the intended side effect. Use `onSpawn` to persist PID/start identity immediately. Heartbeat during the worker. Route push/comment/issue effects through a reconciled outbox or prove an equivalent idempotent contract. Refuse execution when the state transition cannot be recorded.

### P0 — The retry brake is non-functional

The plan says one fix attempt per finding. The normal CLI context never creates `ctx.fixAttempts`; [`bin/reeve` lines 162-173](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/bin/reeve#L162-L173) omit it. The daemon therefore gives `nextAction` a fresh temporary map and later uses optional `get`/`set` calls against `undefined` ([`src/daemon.mjs` lines 134-138 and 173-183](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/src/daemon.mjs#L134-L183)). No attempt is retained even within one process.

There is a second logic problem: the fingerprint includes the head SHA ([`src/ci-rootcause.mjs` lines 181-184](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/src/ci-rootcause.mjs#L181-L184)). Every attempted fix normally pushes a new head, so the same surviving failure becomes a “new” fingerprint and gets another attempt indefinitely.

**Required fix:** persist attempts in SQLite against a stable failure identity that excludes the changing head. Store individual occurrences by head separately. A second occurrence of the same root cause after a fix attempt must escalate.

### P0 — Real enforcement will read its own previous failure and latch red

`evaluatePr()` reads every check at the head. `publishVerdict()` creates a check named `ops/merge-policy` at that same head. There is no filter excluding the policy check from the next evaluation ([`src/pr.mjs` lines 98-104 and 151-170](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/src/pr.mjs#L98-L170)).

In shadow mode the check is `neutral`, which the classifier considers passing. In enforcement mode:

- `BLOCK` publishes `failure`;
- `UNKNOWN` publishes `action_required`;
- both are classified as a red check on the next tick.

After the first block or transient unknown, Reeve will see its own prior verdict as a failing CI input and keep publishing failure even when the original condition has cleared.

**Required fix:** exclude the policy context and App identity from input checks. Give the policy check a stable external identity and update it rather than treating old policy outputs as evidence. Add an integration test: underlying CI transitions red → green while the prior policy check is failure; the next verdict must recover to PASS.

### P0 — “Three stable polls” is one API read replayed three times

`evaluatePr()` calls `readChecks()` once, then calls `settle()` three times on the same in-memory rows in a tight loop ([`src/pr.mjs` lines 98-104](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/src/pr.mjs#L98-L104)). The comment says the daemon spaces the readings over time; it does not persist settlement state between ticks.

This defeats the exact protection `settle()` was designed to provide. A partial green check set is declared stable immediately. `MISSING_REQUIRED` is also considered settled on the first reading, so a required job that has not scheduled yet can be reported as “never reported” instead of “still settling.”

The unit tests prove `settle()` works when a caller supplies real sequential readings. There is no integration test proving `evaluatePr()` supplies them correctly.

**Required fix:** persist settlement per `{repo, PR, head}` across real ticks, including the maximum observed check-name set and first/last observation timestamps. Do not call missing “never” until a scheduling deadline or terminal workflow state proves it.

### P0 — Worker safety is still a prompt boundary

Profiles contain sensitive paths, quarantined paths, forbidden commands, authority restrictions, lanes, and territory globs. In live execution, those controls are rendered as prose in the worker prompt ([`src/prompts.mjs` lines 20-46](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/src/prompts.mjs#L20-L46)). Fix workers then receive unrestricted `Read,Edit,Write,Grep,Glob,Bash` ([lines 223-229](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/src/prompts.mjs#L223-L229)).

No deterministic layer:

- prevents a forbidden command;
- prevents reads/writes to quarantine or sensitive paths;
- enforces lane territory;
- blocks edits to `.github` or the gate;
- validates the final diff before commit/push;
- restricts outbound network access;
- prevents `gh pr merge` or a bypass-capable action;
- treats repository/CI/review content as untrusted outside the model's own instruction-following.

The App token is used to publish the verdict, but is not passed as a narrowly scoped worker identity. Workers inherit the local environment and Git/gh/SSH credentials. In other words, the check publisher uses the App; the mutating worker still acts with the founder's machine credentials.

**Required fix:** introduce a non-LLM policy wrapper around tools. Use one resolved per-PR worktree, a write allowlist, a read denylist for quarantined data, an exact command capability set, a diff policy before commit and push, and a narrow worker credential with no merge/ruleset authority. The worker must not be able to author both a risky action and the only claim that it was allowed.

## High-priority findings

### P1 — Worktree dispatch now fails closed, but lifecycle is not implemented

Commit `5d08b52` materially improves this boundary: Reeve now refuses dispatch when `worktreeRoot` is absent, relative, or nonexistent instead of falling back to the daemon's current directory ([`src/daemon.mjs` lines 194-205 and 279-294](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/src/daemon.mjs#L194-L294)). That converts a dangerous fail-open default into a legible fail-closed escalation.

It is still a path guard, not worktree lifecycle. The shipped CLI supplies no per-PR `worktreeFor` callback. An existing absolute directory is accepted without verifying that it is a Git worktree for the intended repository, branch, PR, or head. Current profiles point at a worktree **root directory**, not a specific checkout bound to a PR/head.

The successful Reeve PR proof used a pre-created `reeve-worktrees/pr-1` checkout. The general daemon cannot create, select, verify, quarantine, or reap that checkout itself. The handoff acknowledges that worktree lifecycle remains in the old plugin.

Before execution, Reeve must prove:

- the path is a Git worktree for the intended repository;
- its branch is the intended PR branch;
- its head matches or cleanly advances from the pinned head;
- it contains no unrelated user changes;
- no other run owns it;
- the final push is compare-and-swap against the expected remote head.

### P1 — Cross-project state modes are schema fields, not runtime behavior

Profiles declare `in-repo`, `sibling`, and `hub` state and a `state.location`, but the runtime never consumes those values. `bin/reeve` always opens `~/.reeve/state/<short-repo-name>.db` ([lines 115-124 and 153-173](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/bin/reeve#L115-L173)).

Consequences:

- `owner-a/api` and `owner-b/api` collide on the same `api.db` and `api.html`;
- client hub isolation is not implemented;
- sibling ledger export/sync is not implemented;
- a local disk failure loses authoritative runtime state;
- `state.location` currently communicates intent rather than controlling storage.

The planned `nextlyhq/nextly-ledger` and `nextlyhq/nextly-archive` repositories did not exist at audit time. The old `nextly-ops` checkout remains live, its ledger had 1,026 lines plus four uncommitted lines, `plugins/` still exists, and `_archive` still contains about 2,083 files / 40 MiB. This is a split-brain transition, not yet a completed replacement.

### P1 — The review loop is deferred in the plan but partially active in execution

The plan says review ingest is deferred. The watcher and daemon nevertheless implement `REQUEST_REVIEW`, `FIX_FINDINGS`, and `SPILL` as executable worker actions.

Their data is not ready:

- `rounds.n` is derived from only the latest `reviewedHead` per reviewer, not distinct reviewed heads across history ([`src/pr.mjs` lines 119-123](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/src/pr.mjs#L119-L123)); one reviewer can complete 20 rounds and the value remains one;
- `unspilledCritical` is hard-coded to zero, so the severity brake cannot work;
- reviewer comments and reviews are limited to the first 100 and are not paginated;
- a configured reviewer with no output becomes `NOT_RUN`, not `NOT_INSTALLED`;
- thread details are not actually returned by `evaluatePr()`, so fix/spill prompts receive an empty list and must rediscover them;
- the spill worker is allowed to resolve threads even though the design says one must not resolve another person's thread.

**Recommendation:** feature-gate all review actions off until ingest, round history, severity, thread identity, and current-head coverage are complete and tested end to end.

### P1 — Inherited-versus-caused compares check names, not failures

`inheritedOrCaused()` labels a PR failure inherited when the base has a failing check with the same name. It does not compare the failed test, annotation, step, or failure fingerprint.

Two unrelated failures in “Browser tests” are therefore treated as the same failure. Reeve can refuse to fix a PR-caused regression because base happens to have another failure in the same job.

Compare root-cause fingerprints at the PR and base heads. “Same check name” is a useful first filter, not sufficient evidence of inheritance.

### P1 — Ancillary cancelled checks can make PASS permanently unreachable

The live Nextly base head was classified `UNKNOWN` because one non-required ancillary job, `Dev script starts every watcher (windows-latest)`, was cancelled. The two profile-required checks were green. The daemon then waited on “base verdict UNKNOWN” across every open PR for hours.

Fail-closed is correct, but every cancelled/stale check from every workflow cannot remain a permanent veto. Decide the gate's required evidence set explicitly. A cancelled required check should remain unknown; an obsolete ancillary job should not make the whole base forever uncheckable.

### P1 — CodeRabbit's rate-limit status is carried and then ignored

`readChecks()` preserves a commit-status description because CodeRabbit reports `state=success` with “Review rate limited” in the description. `classify()` never inspects that description. If the comment surface is absent or delayed, a rate-limited review status is still green.

Normalize known refusal patterns at ingestion and remove them from passing CI/review evidence. Add the exact status-only refusal as a regression test.

### P1 — The “clean merge rate” is not the metric its UI claims

The dashboard says a clean merge means every check green at the merged head **and no unresolved threads**. `cleanMergeRate()` checks only check runs and never reads threads, reviews, commit statuses, required contexts, or check-set presence ([`src/status.mjs` lines 38-65](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/src/status.mjs#L38-L65)). An empty check-run set produces zero bad checks and counts as clean.

This repeats the original system's most dangerous measurement mistake: absence becomes success in the hero quality number.

Measure the PR's reviewed head, required check/status set, unresolved threads at merge, policy verdict at that head, and post-merge/base outcome. Return `unjudged` when evidence is absent.

### P1 — Status freshness can lie when the daemon stops

`readState()` marks a PR stale relative to the newest stored decision, not relative to the current clock ([`src/status.mjs` lines 68-85](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/src/status.mjs#L68-L85)). If the daemon stops entirely, its newest decision remains “fresh” forever because every row is compared to another old row.

The dashboard's generated-at timestamp helps a careful reader, but `reeve status` can still present historical decisions as live state. Add daemon heartbeat/last-successful-tick state and compare timestamps to `now`.

### P1 — Founder decisions cannot reach the “Needs you” query

The `node.status` constraint does not allow `pending` ([`src/db/schema.sql` lines 27-40](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/src/db/schema.sql#L27-L40)), while `readState()` queries decisions with `status='pending'`. The migrated Nextly store had one open undecided decision and zero pending decisions, so it never appears in the intended band.

Define a valid decision lifecycle (`pending`/`decided`/`cancelled`, or an equivalent explicit model), migrate legacy decisions intentionally, and test the real DB query rather than injecting a fabricated pending array into a rendering test.

### P1 — Portfolio scaling has hard caps and hard-coded branch assumptions

- The daemon silently watches at most 20 open PRs ([`src/daemon.mjs` lines 62-68](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/src/daemon.mjs#L62-L68)). The portfolio report itself lists a project with 100 open PRs.
- Reviewer comments/reviews and the timeline are not paginated beyond 100.
- `doctor` hard-codes `main` for branch protection and merge history ([`src/doctor.mjs` lines 65-68](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/src/doctor.mjs#L65-L68)).
- The detector scans only the repo root and one directory level for manifests ([`src/profile/detect.mjs` lines 231-247](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/src/profile/detect.mjs#L231-L247)).
- Go and Rust are recognized as languages but get no command intents; PHP is not recognized.
- `identity.prHost`, state modes, lane territories, clone strategy, flake patterns, merge delete behavior, and most authority fields are not used by the live scheduler.

The correct claim today is: **the profile model generalizes better than the old system; the runtime has not yet proven multi-project operation.**

### P1 — GitHub is not yet the real enforcement boundary

Live Nextly settings at audit time:

- classic protection required only `Decide what this commit can affect`;
- strict/up-to-date mode was off;
- admin enforcement was off;
- the active ruleset had an always-on `OrganizationAdmin` bypass;
- the ruleset contained no required status-check rule;
- merge, squash, and rebase were all allowed.

This is deliberately expected during shadow mode, and `doctor` correctly reports it. It still means Reeve is not “governing end to end” yet. A published neutral check is observation, not enforcement.

Do not repair the ruleset until the code blockers in this audit and the shadow acceptance criteria are satisfied.

## Medium-priority findings

### P2 — Publishing creates a new check run on every tick

At audit time each of the four open Nextly PR heads had accumulated 14-17 `ops/merge-policy` checks in roughly two hours. `publishVerdict()` always POSTs a new check run, and the daemon republishes every tick even when head and verdict are unchanged.

Persist the check-run ID and PATCH it, or publish only when `{head, verdict, clause details, mode}` changes. This will reduce API load and make the PR check UI readable.

### P2 — App permissions should be split by role

The declared App permissions include contents, issues, and pull requests write in addition to check publication ([`src/github/app.mjs` lines 112-123](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/src/github/app.mjs#L112-L123)). The core invariant says Reeve publishes a verdict and never merges.

Use separate identities:

- policy publisher: checks write, repository metadata/actions read;
- worker: only the minimum code/PR capabilities for a specific project;
- no general merge identity in Reeve.

Remove `gh.pr.merge` from the outbox schema and `reconcilePrMerge` if “Reeve never merges” is truly an invariant. Rename the watcher action from `MERGE` to `READY_TO_MERGE` to prevent future semantic drift.

### P2 — CLI/documentation contradictions are operational hazards

- Help documents `reeve run --tick`, but only the separate command `reeve tick` performs one pass. `reeve run --tick` starts the long-running daemon ([`bin/reeve` lines 153-175 and 197-202](https://github.com/revnix/reeve/blob/5d08b52b5d2a003afa18dbe1310a018f37e47389/bin/reeve#L153-L202)).
- `docs/github-app-setup.md` says `doctor --as-app`, but `doctor` has no App probe and the flag has no effect.
- `doctor` looks for `profile.statePath`, while the schema defines `state.location`.
- `watch.intervalSeconds` validates but the daemon ignores it in favor of the CLI flag/default.
- The repository has no README, installation guide, architecture overview, or operator runbook at its root. The handoff is excellent session context but is not a stable product manual.

These are small individually, but control-plane CLI surprises are expensive.

### P2 — The lifecycle test pollutes the worktree and is not isolated

`test/lifecycle.test.mjs` writes `./life.db`, and `.gitignore` hides it. This is why the audited checkout contained a 108 KiB state database despite the design saying databases live outside every worktree.

The verification pass reproduced a concrete collision: running the default and `Asia/Karachi` suites concurrently made one lifecycle test fail with `UNIQUE constraint failed: node.id` because both processes delete and recreate the same database. Each suite passes when run alone, which is why sequential CI does not expose the isolation defect.

Use `mkdtemp()` like the other tests and remove it in cleanup. Hidden runtime-looking artifacts make it easier to inspect or operate on the wrong state.

### P2 — No external alert sink exists yet

Escalations are now deduplicated durably, which is good, but the unattended service writes them only to a local log/dashboard. “Needs you” is not yet a phone notification or another acknowledged delivery channel.

Add an outbox-backed notification with deduplication, acknowledgement, retry, and a safe payload. Do not send raw prompts, CI logs, secrets, or customer data.

## Test and evidence audit

The testing direction is strong, but the green suite currently overstates integration confidence.

Well covered:

- pure verdict clause behavior;
- pure watcher decision mapping;
- SQLite claim/lease/outbox primitives;
- process-group and timeout behavior;
- profile validation and merge behavior;
- CI log parsing and failure extraction helpers;
- escalation deduplication;
- deploy artifact validation;
- fail-closed worktree-root path validation;
- status rendering behavior.

Missing decision-critical integration tests:

- `evaluatePr()` across real sequential check polls;
- policy-check self-exclusion and BLOCK → PASS recovery;
- daemon → durable run/lease/checkpoint/outbox wiring;
- hard daemon crash after spawn and before result record;
- restart reconciliation after an ambiguous push/comment;
- retry cap across a new head;
- worker credential and path/command enforcement;
- per-PR worktree repository/head validation and ownership;
- duplicate check publication/update;
- two repositories with the same short name;
- empty ruleset list versus real enforcement;
- more than 20 open PRs and more than 100 comments/reviews;
- CodeRabbit refusal expressed only in status description;
- founder decision state from the actual schema/query;
- clean-merge rate with no checks, unresolved threads, failed commit statuses, and missing policy verdict;
- a full second-project run.

The main lesson is the same one Reeve itself already understands: a correct pure helper does not prove its caller supplies the right state.

## Cross-project verdict

The move from `nextly-ops` to Reeve is the right response to the multi-project requirement. I would keep the core/profile architecture.

What is true now:

- The same schema can describe Nextly, a Python/TypeScript service, a client Next.js site, and Reeve itself.
- Detection identifies several real repo-specific hazards.
- Profiles make implicit project assumptions visible.
- The worker prompt can present project-specific verification commands.

What is not true yet:

- State modes do not control state placement or synchronization.
- One service does not supervise a portfolio; the installed service watches Nextly only.
- A profile's worktree root does not create or bind a PR worktree.
- Several safety and authority fields are not enforced.
- The command detector is incomplete and shallow for larger monorepos.
- The GitHub App is installed on one repo.
- Server enforcement is unavailable on most private repos in the surveyed portfolio.
- Only one watched fix has been demonstrated, on Reeve itself.
- Research, task import, recurring work, learning, and product discovery are not built.

So my honest wording would be:

> **Reeve is designed to support other projects and has a promising profile seam. It does not yet safely operate other projects end to end.**

That is still a large improvement over a Nextly-specific ops repository.

## Recommended sequence

### Before the next unattended worker

1. Integrate daemon dispatch with durable run/lease/checkpoint/outbox state.
2. Make the retry cap real and persistent; remove head SHA from failure identity.
3. Implement exact per-PR worktree selection and ownership.
4. Enforce path, command, diff, and credential policy outside the model.
5. Feature-gate the unfinished review/spill actions off.

### Before `--enforce`

6. Exclude Reeve's policy check from its own inputs and update one check run per head.
7. Persist settlement across real ticks and add a scheduling deadline for missing required checks.
8. Define the exact required evidence set so unrelated cancelled jobs do not block forever.
9. Fix status-only reviewer refusal handling and inherited-failure comparison.
10. Add end-to-end BLOCK → recovery → PASS tests.
11. Complete the shadow acceptance period with measured false-block and missed-block review.

### Before claiming multi-project readiness

12. Key state by full `owner/repo`, and implement state mode/location behavior.
13. Add paginated repository/PR/review reads and remove hard-coded `main` assumptions.
14. Complete worktree lifecycle in Reeve.
15. Prove one supervised fix on `rextaihq/rext-backend` without changing core assumptions.
16. Then add another distinct project type, ideally a client repo under `propose_only`.

### Before retiring `nextly-ops`

17. Reconcile live JSONL changes into the SQLite authority.
18. Make deterministic export/backup operational, not a library-only function.
19. Move archive data to the restricted archive repository after secret/provenance review.
20. Remove the old plugin, dispatcher, ledger writer, gate, worktree scripts, and duplicate telemetry only after Reeve owns their live responsibilities.

## Readiness gates

Keep shadow mode until all of these are true:

- [ ] Reeve does not read its own policy check as CI evidence.
- [ ] Green settlement comes from three real persisted observations.
- [ ] Required checks distinguish “not scheduled yet” from “never reported.”
- [ ] A worker cannot start without a durable run and lease.
- [ ] A worker PID/start token and attempt are persisted before tool activity.
- [ ] Push/comment/issue effects reconcile after an ambiguous crash.
- [ ] The same failure surviving a fix escalates across a new head and restart.
- [ ] A worker cannot read/write quarantined paths or run forbidden commands.
- [ ] Every worker acts in a verified PR-specific worktree.
- [ ] Worker credentials cannot merge, bypass rules, or alter policy.
- [ ] Review/spill actions are disabled until their data model is complete.
- [ ] One check run per policy/head is updated rather than multiplied.
- [ ] Status and clean-merge metrics treat missing evidence as unjudged.
- [ ] The required GitHub rule has no fleet-accessible bypass.
- [ ] A second project completes the same loop without a core patch.

## Bottom line

Reeve is the right rebuild. The architectural taste is much better, the failure analysis is unusually strong, and the code already contains several pieces I would want in a serious control plane. The project is more honest than `nextly-ops`, and the live shadow run is already paying for itself.

The remaining danger is that the documents describe the completed architecture while the runtime currently connects only its observational half. The SQLite store, outbox, risk profile, App identity, and worktree model look like controls on paper; the live worker path goes around most of them.

My candid recommendation is **continue, do not restart or redesign it**, but narrow the claim and keep both autonomy switches off:

> Reeve is ready to observe one project in shadow mode. It is not yet ready to enforce merges or execute unattended repairs. Fix the runtime integration and authority boundary next; do not spend the next cycle on more profiles, agents, dashboards, research features, or portfolio breadth.

That path preserves what is genuinely good here and closes the exact gaps most likely to recreate the old system's failures under a better name.
