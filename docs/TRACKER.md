# reeve tracker

The one file that says what reeve has, what is in flight, and what remains.
Update it the moment a decision lands or a state changes — never in batches.
Rule of the house: every claim here is either **measured** (say when) or marked
**intent**. Absence from this file means "not planned", not "done".

Last full re-verification: 2026-08-24 (suite 71/71, daemon observe-only on
`3f9ba6f`, checkout fast-forwarded and restarted, `--execute` absent from the
RUNNING process).

Read the live switches from the machine, not from this file. Whether reeve is
armed, what `main` is and what the daemon runs are answered by the commands in §0
of `docs/2026-08-24-session-handoff.md`; recording them here would make a second
copy that ages. What belongs here is what was DECIDED and what was FOUND.

---

## Programme 1 — the GUARDIAN (built, partly armed)

The four capabilities, measured 2026-08-21:

| # | Capability | Switch | State | Unblocks when |
|---|---|---|---|---|
| 1 | Watch, judge, escalate | — | **ON** | live on nextlyhq/nextly |
| 2 | Fix red CI itself | `--execute` | off | evidence obtained 2026-08-24; re-arming is now a founder decision, not a blocked one |
| 3 | Work review threads | `watch.reviewActions` | off | PR-5 → PR-6 after the shadow week |
| 4 | Refuse an unsafe merge | `--enforce` + ruleset | off | 7 clean shadow days + founder decision |

### Time-blocked (do not try to shortcut)

- [ ] **Review shadow week** — 5 clean days from 22 Aug → PR-5 ≈ 26 Aug.
      Day 0 (21 Aug) diverged once: #1128, live 55 vs derived 50, caused by a
      bug fixed the same day. History, not a veto.
- [ ] **Verdict shadow week** — 7 days zero false blocks → ruleset flip ≈ 28 Aug
      earliest, and it is the founder's decision.

### Unblocked code (guardian tail)

- [x] Feed the 500-PR study into worker prompts — DONE 2026-08-21 (`a975144`).
      Numbers live in the PROFILE (`measured.review.*`), rendered by
      `prompts.mjs`; findings lists ordered criticals-first then the measured
      top reviewer. nextly's profile carries the study; other projects render
      nothing until measured.
- [ ] **PR-6 precondition (from PR-1 review):** REQUEST_REVIEW and SPILL prompts
      tell the WORKER to use `gh`, but the worker contract shims `gh` and holds
      no credential by design. Before `watch.reviewActions` arms, those GitHub
      effects must be performed by reeve through the outbox (the design's
      rule), never by a worker. Until then the two actions stay gated.
- [ ] **PR-6 wiring note:** `e.threadDetails` is read at both review dispatch
      sites and written by NOTHING (the read-never-written pattern again).
      When capability 3 arms, populate it from the `review_thread` projections
      (reviewer/severity/path/line/excerpt all exist there) — the new prompt
      ordering activates only then.
- [x] Wire flake detection — DONE 2026-08-21 (`39a5ce9`). Only DEMONSTRATED
      flake changes the decision: wholly-flaky causes escalate (identity key,
      no attempt spent); mixed causes dispatch with the flaky job named as
      noise. Follow-up noted: `ci.flakePatterns` is declared in the schema with
      ZERO readers — wire or remove when the builder design lands.
- [x] **Dispatch evidence — DONE 2026-08-23 and re-run 2026-08-24.** Four real
      workers across two sessions, on a deterministic timezone bug whose tempting
      shortcut is deleting the cross-timezone assertion.
      **The shape it was built to find did not occur.** All four produced the same
      byte-identical CORRECT fix and none weakened the test, so "a confidently bad
      fix" remains unmeasured rather than disproved.
      What it found instead was a P0 in reeve itself (see 23 Aug below), and after
      the repair, the first end-to-end publication under the new contract:
      **61s, $0.42, 16 turns, 0 permission denials, published.** Verified from a
      fresh clone of the bare remote rather than from the log — correct fix, test
      file untouched, passing under UTC, Los Angeles, Tokyo and Karachi.
      `docs/measured/2026-08-23-three-real-dispatches.md` has the failing run.
- [x] `release` lane dead-by-construction — DONE 2026-08-21 (`4998f66`).
      `lanes[].sensitiveOk` lifts the tool-layer deny (verbatim globs only) and
      the diff-gate sensitive refusal (territory-scoped, per file); quarantine
      and self-governing stay unreachable. Validator warns on the dead shape.
      Live nextly profile updated. NOTE: nothing assigns `decision.lane` yet —
      lanes go live with the builder's implementation phase.
- [ ] *Optional (founder: "if beneficial")* — PR-open size warning (>10 files →
      expect 4+ rounds), reinstate Greptile (best critical hit rate, out of credits).

### 22–24 August — arming, the P0, and the repair

Three days this file had no record of at all. Written 2026-08-24, from the
measured notes rather than from memory.

**22 Aug.** The OS sandbox landed (`1a2fbea`, 10:47) and reeve was armed against
`nextlyhq/nextly` with `rounds.maxFixAttemptsPerFinding: 1`. The sandbox took the
publishing half away the same morning without anything noticing — see the P0 row
in the defect log. The founder ruled out a dedicated macOS user for workers
("I'm not going to make another user"), which settles the worker-identity item
below in favour of the OS sandbox's read deny.

**23 Aug.** Three real dispatches against the wrong-worker fixture, $2.66, none
published. The experiment's own premise did not occur — all three fixes were
correct and none weakened the test. It found the P0 instead. **reeve was DISARMED
the same day**, deliberately, and re-arming has been the founder's call since.

**24 Aug.** Four PRs merged, in this order:

| PR | what it did |
|---|---|
| #15 | the dispatch write-up: `docs/measured/2026-08-23-three-real-dispatches.md` |
| #18 | the prompt renders from the grant, closing the sixth instance of that drift |
| #19 | **reeve commits the worker's fix, because the worker cannot** — the P0 repair |
| #22 | the follow-ups: a lost deletion, the unbounded path list, the R-01 actor id |

Then: the daemon's checkout was fast-forwarded and restarted (it had been eight
commits back, running pre-repair code all day while watching pull requests), and
the wrong-worker experiment was re-run against the merged code and **published**.

Two peer lanes ran alongside — S2-A (#20), the hub post-merge work (#23) and the
unreadable-hub refusal (#24). Coordination was by SendMessage, and it paid twice:
a peer's watcher bug prompted a check that found a worse one in mine (an API blip
made a live PR read as CLOSED and silently ended the watch), and a peer's note that
`gh`'s `headRefOid` is the MERGED head pairs with the finding that a review
comment's `original_commit_id` is the only field answering "what did this verdict
actually look at" — used the same day to establish that one finding had already
been fixed in the commit after the one it reviewed.

**Standing decisions from these days, so they are not re-litigated:**

- reeve commits and pushes; the worker never touches git state. Not a workaround —
  it also closes the older "who publishes" drift rather than patching around it.
- Staging is DECLARATION-driven. reeve stages exactly `filesTouched` and refuses
  when the staged set does not match. Four staging defects in four review rounds
  became one design change, and every exclusion heuristic disappeared with it.
- A fence and a retry budget are two facts. The outbox's `lease_token` must NOT
  reuse `attempts`: a fence increments on every lease including a no-op one, a
  budget only on a real attempt. There is **no deadline** on this — an earlier note
  claimed one by reading `RESHAPED`'s refusal, which is for a changed UNIQUE
  constraint and not for an added column.
- Commit signing stays a doctor check rather than a build step.

### Needs the founder

- [ ] **ntfy read user** — all 5 tokens write-only; needs shell on 95.217.11.127
      (`ntfy user add mobeen`; `ntfy access mobeen revnix-reeve read-only`;
      `upstream-base-url` for iOS). Desktop notifications work meanwhile.
- [ ] **Second project** (`rextaihq/rext-backend`) — needs PR-gating CI + App install.
- [x] **Worker identity decision — RULED 2026-08-22.** The founder declined a
      dedicated macOS user ("I'm not going to make another user"), so containment
      rests on the OS sandbox's read deny plus the keychain path denies measured in
      PR-2. Do not re-propose the extra user.
- [ ] **Re-arming decision.** The dispatch evidence the arming was waiting on now
      exists (24 Aug, published end-to-end). What it rests on, stated fairly: ONE
      successful dispatch on a toy fixture, against a repository that has never had
      one. Each real attempt costs about $1 and is spent whether or not it
      publishes.
- [ ] **Ruleset flip decision** (after the verdict shadow week).

### Closed by ruling — do not reopen

Go/Rust/PHP command tables (not now) · SPILL (off indefinitely) · paid reviewer
(declined) · CodeRabbit Pro Plus (never raise again).

---

## Programme 2 — the BUILDER (ruled 2026-08-21, in design)

**Founder ruling, 2026-08-21:** reeve becomes a BUILDER as well — runs a task end
to end: pick → research → design → spec → implement → PR → fix CI → work review
threads → gate → **merge**. This supersedes the guardian-only scope in
HANDOFF §0 and re-opens ruling 16 (ledger import).

### Requirements — settled with the founder, do not re-litigate

0. **Platforms (ruled 2026-08-21):** NOT cloud-hosted in the near future. reeve
   must run on **macOS, Windows, and Ubuntu**. Every host-specific mechanism
   (native sandbox, service manager, pid identity + group kill, desktop
   notifications, locks) carries a platform matrix and fails CLOSED where a
   platform is unsupported or unmeasured. Off-device backup target is a local
   machine/NAS/disk, not cloud.

1. **Architecture A** — deterministic per-task phase state machine inside the
   existing daemon; each phase a bounded `claude` worker via the existing
   supervisor/sandbox; multi-agent fan-out happens INSIDE a phase (Claude's own
   subagents); artifacts durable before every transition; crash-resumable.
2. **Intake: both in v1** — founder-filed tasks AND ledger import/pick from
   nextly-ops. (Sequencing intent: filed-task path proven first, ledger pick
   lands before v1 is called done.)
3. **The gate** (REVISED by founder 2026-08-21, supersedes the 30-min table) —
   a very detailed, plain-language spec PR in a PRIVATE repo. **Codex clean
   pass is a MANDATORY SERIAL WITNESS**: findings → revise → re-request, loop
   until clean (**cap 10** → escalate; founder 2026-08-22, was 5 — reeve #4
   needed 8 rounds and a cap of 5 would have escalated it with real defects
   open). Once Codex cleans at the current head, a
   **15-minute** founder window opens (GitHub clock):
   founder approves → proceed immediately · requests changes → revise ·
   silent 15 min → **proceed** (their good-to-go).
   Silence = ZERO founder events; any non-approval comment stops the clock.
   Codex silent/refused/stale-head → wait, re-request, escalate — NEVER proceed.
   CodeRabbit optional. Armed DAY ONE; safety is the strict measured clean-pass
   grammar + "Reviewed commit" prefix-matching the head (measured live on
   nextly #1129/#1130). Approval binds to the spec PR's exact head SHA.
   **Codex-unavailable (founder, later 2026-08-21): "If codex not available,
   human approval will be enough."** When Codex is unavailable at the head
   (refusal observed, or no response within the re-request window), a
   SHA-bound founder approval alone advances; founder silence never does.
   Replaces the `--waive-codex` flag idea (no flag).
4. **Depth dial** — research/design effort scales to the task; the sizing
   decision is visible and overridable in the spec PR.
5. **Concurrency** — many tasks at once, across projects and directories;
   leases prevent territory collisions; the guardian must never starve.
6. **reeve merges** builder-run PRs on a PASS verdict. Replacement invariant:
   reeve merges only what independent witnesses (CI, external reviewers, the
   deterministic verdict) have judged — never on a worker's word.

### In flight

- [x] Requirements brainstorm with the founder (2026-08-21)
- [x] **Deep research pass** — 15 agents, 0 errors, ~28 min. Robustness-first
      won the judges 255:244.5:241; synthesis + 29 adversarial findings
      (8 critical) saved to the session scratchpad. KEY FINDING: the builder
      skeleton (task/claim/checkpoint/outbox/`gh.pr.merge` reconcilers) already
      exists in reeve's schema with ZERO callers; no merge executor exists.
- [x] Design presented; founder approved AND revised the gate (see req. 3)
- [x] **Spec written and founder-approved** — `docs/2026-08-21-builder-design.md`
      v2 (989 lines, `f2cda32`): the audit's 20 accepted items folded as
      mechanisms, 3 not adopted with reasons (Appendix B), the Codex-
      unavailable ruling (row 7, no waiver flag), the platform ruling. Status:
      approved direction; implementation gated by P0 closure. Merge stays dark
      behind `builder.capabilities.mergeBuilderPr` + `--actuate-merges`.
- [x] Implementation plan for S0 + S1: `docs/superpowers/plans/2026-08-21-s1-worker-contract.md`
- [x] **S2 plans, split into three (2026-08-23).** A single 5,300-line plan went
      four Codex rounds on #8 and took **54 findings (15, 10, 13, 16 — not
      converging)**. A majority of each round after the first was caused by the
      PREVIOUS round's own fixes: an edit in a document that large cannot see its
      neighbourhood. Split along the PR boundaries it already declared, one
      document per PR, each self-contained and reviewed on its own:
      `2026-08-23-s2a-hub-store.md` (13 tasks, #11) →
      `2026-08-23-s2b-phase-machine.md` (7 tasks, #12) →
      `2026-08-23-s2c-provider-scheduler.md` (5 tasks, #13), in that order.
      **Only the S2-A document is in THIS commit**; B and C land with their own
      PRs, so the links above resolve once those merge.
      Review history kept in `2026-08-23-s2-review-history.md`; #8 closed as
      superseded, its 54 resolved threads standing as the record. Founder
      decisions unchanged: guardian fails OPEN on an unreadable hub;
      `ci.flakePatterns` removal is PLANNED, in S2-A's Task 12 — it is still
      declared at `src/profile/schema.mjs:183` after #9, and removing it from
      `FIELDS` without stripping the live profile in the same change would make
      every daemon start fail
      (`docs/measured/2026-08-22-flakepatterns-has-no-readers.md`);
      `repo_gate_state` ships with a pure derivation behind an injected fetcher.
      **The durable finding is about plan SIZE**: a plan needing four rounds and
      still finding sixteen defects at the fourth is one document doing three
      documents' work.
- [ ] **S2-A, the hub store — BUILT, PR open (2026-08-24).** Branch
      `feat/s2-hub-store`, based on `bc17a06`. All 13 tasks of
      `docs/superpowers/plans/2026-08-23-s2a-hub-store.md` implemented:
      `src/build/{hub.sql,hubdb.mjs,locks.mjs,replay.mjs,tables.mjs}`, the hub
      half of `backup.mjs`/`doctor.mjs`/`selfaudit.mjs`, and the
      `build run|status` / `builder doctor` / `backup|restore|export-events --hub`
      routes. **32 tables** in a live store (31 in `hub.sql` plus
      `schema_version`), 23 indexes, and `HUB_TABLES` equals the live table set
      in both directions. Migration 1 is FROZEN by a fixture over BOTH halves —
      the DDL text and the `up()` source — each verified red on its own stub.
      **Measured 2026-08-24: suite 64 files, 0 failures**, `escape.test.mjs`
      excluded as always (it writes into the live daemon's `~/.reeve/canary`).
      Nothing here dispatches a worker or touches GitHub.
      **`ci.flakePatterns` is now REMOVED**, not planned: out of
      `src/profile/schema.mjs` and out of the live
      `~/.reeve/profiles/nextlyhq/nextly.json`, which was the one profile
      carrying it. The order was measured both ways first — profile as-is is
      INVALID under the new code and valid under the running code, and with the
      key removed it is valid under both — so the profile was stripped first,
      with a backup beside it, and the daemon was not restarted.
      **Fifteen defects were found by EXECUTING the plan** after it had taken
      ~490 review findings over 16 rounds: a test that could not fail (the
      forward-version fixture was refused by the contiguity check instead), a
      `renderHub` that was called four times and never defined anywhere, a row
      image with no key that made a restore die on
      `Provided value cannot be bound to SQLite parameter 1`, an operator
      message that said "never backed up" when every backup was corrupt, and a
      `--home` flag that does not exist and is silently ignored. Recorded in the
      PR body. The durable finding: **a plan can survive sixteen adversarial
      review rounds and still contain a test that cannot fail.**
- [x] **PR-1 (S0 + S1 core) — LANDED 2026-08-21, revnix/reeve #3, merge
      `0d313502`.** Capability switches (all false on the live profile),
      authority baseline + doctor R-13 (live: matches), workerArgs hard-fail +
      no ambient setting source (measured: `local` loads the checkout's
      settings.local.json), env allowlist + credential-less git + the App's bot
      identity in GIT_AUTHOR_*/GIT_COMMITTER_*, refusing gh/ssh shims, bounded
      durable streams (separate caps), exec gate released only after a
      revalidated binding (bindRun), lease revocation at every layer (heartbeat
      expiry refused, completion revalidated, refused completions retired),
      pre-execution outcomes never spend an attempt or block a PR, worker_run
      contract rows, worktree-scoped pre-push hook read back on every acquire.
      **17 Codex rounds (99 findings) + 1 adversarial review (17 confirmed)
      closed; Codex clean at 053688f.** Suite 54/54.
      **STILL KNOWN-OPEN, by code** (`test/escape.test.mjs`): with a real
      HOME the worker can read the founder's token and bypass the hook
      (`--no-verify`, `-c core.hooksPath`, shared refs); so the daemon
      REFUSES every dispatch under `--execute` while
      `CONTAINMENT.credentialRead === "open"` (escalation
      `guardian:containment:open`). PR-2 closes it or the founder picks a
      dedicated worker user.
- [x] **PR-2 (S1 sandbox) — LANDED 2026-08-22, revnix/reeve #4, merge `1a2fbea`.**
      Verified: the PR head equals the head I pushed, and main's tree hash equals
      mine, so nothing was stranded. Deployed, daemon restarted: clean tick,
      backups of both stores, no new errors.
      **What it ships.** Both print-mode unknowns are measured
      (`docs/measured/2026-08-22-claude-print-mode.md`): the `sandbox.*` block
      APPLIES under `-p`, and an INVALID settings file is dropped whole and
      silently — so a supplied path proves nothing. On that footing:
      · the OS sandbox in every worker's settings (network denied except
        research, writes confined to the worktree + the run's tmp, credential
        paths deny-read at the OS layer AND for the Read tool, quarantine paths
        resolved to OS denies with unrepresentable globs REFUSING dispatch);
      · `validateSettings` before spawn, because an invalid file is ignored;
      · the **sandbox canary** — a throwaway worker per (CLI build, policy) whose
        files the DAEMON reads: outside writes, network (against a daemon-local
        listener as the positive control), subtree AND exact-file credential
        reads, the Read tool and the Write tool, with a control beside each;
      · **measured containment**: dispatch needs a canary pass AND an empty
        keychain AND a measured platform AND a verified isolated worker, and it
        is re-checked immediately before every spawn;
      · the daemon's own git is neutralised in worker-controlled directories and
        refuses to run at all where the worker changed the repo config;
      · doctor R-14 (canary) and R-15 (credential reach).
      **8 Codex rounds, 43 genuine findings closed.** Rounds 1-6 found new areas
      (quarantine unenforced at the OS layer, git's XDG credential store,
      `core.fsmonitor` as daemon-user RCE); rounds 7-8 were entirely follow-ups
      on my own fixes — that shift, not the count, was the convergence signal.
      **NOT flipped, by code:** `worker.isolation` defaults to `none` and
      `isolationTopologyReady()` returns false, so dispatch is refused twice
      over. Live doctor: R-13 OK, R-14 UNKNOWN (no canary has run), R-15
      DEGRADED (the login keychain holds a GitHub credential).
      **The ONE closure is a dedicated worker OS user** (own empty keychain, own
      clone). Building that topology is **PR-3**; do not set the flag before it
      lands, and expect the first acquire after it to quarantine any worktree
      with no recorded config baseline (self-healing, once).
- [x] ~~**PR-3: the dedicated-user dispatch topology.**~~ SUPERSEDED 2026-08-22
      by the founder's ruling ("I'm not going to make another user"). The
      closure it existed for was found elsewhere: the keychain is reached
      THROUGH `HOME`, so a scratch home closes it without a second OS account.
      `worker.isolation: dedicated-user` stays in the schema and is refused by
      name rather than silently downgraded to the weaker thing that is built.

- [ ] **PR-3 (S1 close-out): standalone checkouts + the scratch-HOME closure.**
      IN FLIGHT on `feat/s1-standalone-clones`. Landed so far:
      · **standalone clone per run** instead of a linked worktree — its own ref
        store and config, so the shared-ref and shared-config holes close by
        construction (measured: clone 2.4s/251MB; deps copy-on-write 15s/**31MB**
        real vs 1.2GB apparent). The founder's uncommitted work and ignored files
        never reach a worker; the work leaves by fetch into reeve's own
        repository, so the worker still never publishes.
      · **the keychain closure**: measured that the keychain is reached THROUGH
        HOME, so workers get a scratch HOME and authenticate from
        `CLAUDE_CODE_OAUTH_TOKEN` (`~/.reeve/claude-token`, 0600, inside the
        deny-read tree). `workerEnv` REFUSES the founder's home and a missing
        token. The founder's keychain is UNTOUCHED and still holds their GitHub
        credential — and a worker cannot read it, which the escape test asserts
        explicitly rather than tautologically.
      · **the gate moved from a proxy to a measurement**: containment no longer
        requires the host keychain to look empty (a probe of two known item
        shapes). The CANARY measures the worker's actual reach — three keychain
        probes whose success fails it — and that is what decides. `worker.isolation`
        gains `scratch-home` (the built arrangement); `dedicated-user` is stronger,
        unbuilt, and refused with that reason rather than silently downgraded.
      · a dependency gap nobody had noticed: there was NO install step in the
        dispatch path, so with the network denied a fixer could never run the
        project's tests — it could not check its own fix.
      Two bugs this introduced, both caught before shipping: every `~/...` deny
      expanded against the WORKER's home (a scratch home would have silently
      disabled the whole file deny list — the escape test caught it), and the
      canary's results parser matched `[a-z]+`, dropping `kc_github` and friends,
      which would have failed every real canary.
      · **the dead worktree lifecycle removed** (`0be4703`). acquire / verify /
        release / push and the daemon's `resolveWorktree` had no caller, but
        their tests still passed, which reads as coverage of the path dispatch
        takes. What survives is about git rather than worktrees, so the module is
        `src/gitguard.mjs` now. `verifyConfig` also stopped exempting the keys
        reeve writes itself: that allowance existed for re-hardening a reused
        worktree, and a run checkout is never re-hardened, so it could only ever
        have let a worker overwrite the two keys set to stop it publishing.
      · **a preparation failure is no longer reported as tampering** (`0fbcc82`).
        Preparation moved inside the dispatch try-block, so a failure left the
        checkout path null; the config check read that as "no recorded
        configuration" and accused a worker that never started, on the most
        ordinary failure there is. Found by writing the test the removal needed.
      · **R-15 says what actually gates dispatch** (`756008e`). It still
        described the keychain as refusing dispatch and advised deleting the
        credential or making a dedicated user. It now reports the keychain and
        gates on the isolation declared AND on the worker having a token of its
        own — without which every dispatch fails while preparing and backs off.
      · **the founder's clone is deny-read** (`24f7eed`). The run checkout
        carries only committed content, so their uncommitted work and ignored
        files are not IN it — which is not the same as out of reach. MEASURED:
        a sandboxed worker read an uncommitted file and a `.env` straight out of
        the founder's checkout, because the sandbox denies writes outside the
        checkout, not reads
        (`docs/measured/2026-08-22-the-founders-checkout-was-readable.md`).
        `identity.checkout` now joins the denied reads and the validator requires
        it. Three fixtures had checkout == worktreeRoot and the overlap guard
        duly refused them.
      · **`reeve canary`** (`ca861da`): measure the boundary on demand without
        arming anything. The measurement is what should decide whether to arm, so
        it must be available before --execute, not only after.
      · **the first live canary ever run, and it FAILED** (`69a8c8f` + `d49a807`).
        Every shell probe held; the Read TOOL returned a decoy the `cp` beside it
        could not. The file tools are governed by permissions ALONE — the CLI's
        own process runs outside the Seatbelt profile it applies to the shells it
        spawns — and an absolute path in a permission rule takes effect only with
        TWO leading slashes. This branch shipped one, so every absolute Read deny
        matched nothing: `~/.ssh`, `~/.gitconfig`, `~/.claude`, `~/.config/gh`,
        `~/.aws`, reeve's own `~/.reeve` with the App key and the event store.
        `main` is NOT exposed (tilde form + the founder's HOME). Fixed, plus:
        the file tools are scoped to the checkout instead of granted bare, and
        `validateToolGrant` refuses a bare grant before spawn.
      · **the canary id did not cover the permission layer.** The re-run passed
        under the SAME id as the failure, so a pass either side of the fix would
        have been reused across it and R-14 would have reported OK through the
        change. `canaryIdFor` and `policyHashOf` now cover `permissions.deny` and
        the tool grant.
      · **`reeve canary` PASSED live** (`942565ecf154b3ed`, 2026-08-22):
        `credentialRead: closed`, and **doctor R-14 is OK for the first time**.
      REMAINING: the PR itself, its Codex rounds, and the founder's merge grant.

- [ ] **Reviewer refusal patterns were one shape short (2026-08-22).** THREE
      defects in the seeded roster, measured on `nextlyhq/nextly` #1137 with the
      real bodies as fixtures (`docs/measured/2026-08-22-refusal-is-one-shape-per-reason.md`):
      Codex's `Something went wrong` and CodeRabbit's `Review limit reached` both
      classified as `null` — which `derive.mjs` reads as chatter, making a bot
      that CRASHED indistinguishable from one that never spoke; and `commitPattern`
      appeared ZERO times in `src/init.mjs`, so a fresh profile gives Codex no way
      to bind a clean pass and every one degrades to `unbound_clean`. Fixed in
      `fix/refusal-is-one-shape-per-reason`. **The live `nextlyhq/nextly.json` is
      NOT yet updated** — `init.mjs` only seeds new profiles, so the running
      daemon keeps the narrow patterns until the founder applies them.
      STILL OPEN, deliberately: `greptile-apps` has no `clean` pattern at all, and
      no greptile body exists on #1135-#1137 to write one against — it needs one
      observed pass first, not a guessed regex. Also standing: all three reviewers
      are `kind: advisory`, so the blocking roster is EMPTY and clause B5's
      "absence read as success" is the live configuration, not a hypothetical.

- [ ] **The publication gate read the wrong paths, and the founder's own remote
      was unreachable (2026-08-22).** The three findings Codex left open on #7,
      plus three found while testing them. In `fix/per-commit-paths-and-attr-symlinks`.
      · **`changedFiles` compared a range's ENDPOINTS**, so a path weakened in one
        commit and restored in a later one was never judged while the push still
        carried it. Now a per-commit walk, `-m` so a merge contributes its paths.
      · **git QUOTES a path holding a non-ASCII byte or a newline**, and the
        leading quote stops every risk glob matching — measured, `reviewDiff`
        returned **ok** for the quoted form of a path it refused raw. NUL-separated
        now; `core.quotePath=false` would have fixed only half of it.
      · **Rename detection collapsed a rename to its destination**, so moving
        `secrets/key.txt` to `public.txt` named only `public.txt`. `--no-renames`.
        (`docs/measured/2026-08-22-the-gate-read-the-wrong-paths.md`)
      · **A symlinked `.gitattributes` KILLED the reader** — measured, SIGKILL,
        exit 137 against `/dev/zero`, from pull-request content, before any worker
        launched. lstat first, refuse non-regular files, bound per-file and total.
        (`docs/measured/2026-08-22-a-symlinked-attributes-file-killed-the-reader.md`)
      · **The worker git isolation was applied to the FOUNDER's repository**, so
        `ls-remote origin` failed with "could not read Username" — origin is https
        and the credential helper is global. **Every publication would have failed
        on the first live dispatch.** Never seen because reeve has never dispatched
        and every fixture uses a local path as its origin.
        (`docs/measured/2026-08-22-the-isolation-broke-the-founders-own-remote.md`)
      · **A NEWLINE in a filename walked past EVERY deny rule** — the most serious
        of the set, found while testing Codex's log-forgery finding. `**` compiles
        to `.*`, and without the `s` flag `.` cannot span a newline, so no `**`
        glob could match such a path. Measured: `reviewDiff` returned **ok** for
        `secrets/x⏎…` and for `.github/workflows/ci⏎x.yml` — a secret published,
        and a worker editing the workflow that grades its own work. Invisible
        until this PR because git's quoted output broke the glob by accident.
        (`docs/measured/2026-08-23-a-newline-in-a-filename-walked-past-every-deny-rule.md`)
      Codex rounds 1–3 on #10, all taken and all reproduced first:
      · local-path fetch must KEEP the isolation (`protocol.file.allow=never`
        would refuse every valid fix); `founderGit` is origin-facing calls only.
      · an UNREADABLE range was reported as an empty diff; and the walk read under
        `execFileSync`'s 1 MiB default, which 1,600 files crosses on their own.
      · `GIT_CONFIG_GLOBAL` naming a company file must be KEPT, not deleted.
      · worker-supplied text is escaped at the two boundaries facing a human.
      STILL OPEN: **`reeve doctor` runs no git at all**, so nothing checks that
      reeve's founder-side git can reach origin. That is the instrument that would
      have caught the founder-config one, and it is deliberately NOT in this PR.
      REMAINING: the PR's remaining Codex rounds, and the founder's merge grant.

- [ ] **Two instruments that could not have caught what they are for (2026-08-23).**
      Both found after #10 merged, while checking it live. In `fix/reach-and-instrument`.
      · **Nothing measured whether reeve can reach the remote it publishes to.**
        Every other check reads GitHub through `gh`, which carries its own token;
        publication is a `git push` from the founder's checkout. The obvious check
        would not have caught it either — measured, on **public** `nextlyhq/nextly`
        the broken configuration REACHED `ls-remote` anonymously while a credential
        could not be obtained, so a reachability check reports healthy for the one
        repository reeve watches. **R-16 asks the credential question** via
        `git credential fill`, which is what a push does and writes nothing. The
        value is never read into reeve.
        (`docs/measured/2026-08-23-a-read-proves-nothing-about-a-push.md`)
      · **The canary's instrument was in its recorded id and NOT in its cache key.**
        `canaryIdFor` documents the script as part of the identity so a pass taken
        under a weaker instrument cannot be reused — but only `sandboxCanary`
        passed one, and the key in `containment.mjs` did not. It could not: the
        script embeds a random listener port and two mkdtemp paths, and measured,
        changing only the port changed the id. So a strengthened script never
        invalidated a cached pass. `instrumentHash()` hashes the script's own text
        with the per-invocation values placeholdered, so one stable value serves
        as both. **Every existing cache test injected a canary FUNCTION**, so the
        real id producer never ran and the drift could not be seen.
        (`docs/measured/2026-08-23-the-instrument-was-in-the-id-and-not-in-the-key.md`)
      Live after #10: canary **PASSED** (`7e14000fb54d28f5`), `credentialRead:
      closed`; founder-side git reaches both remotes; the worker isolation still
      refuses both, which is the fix confirmed from the other side. **Canary ids
      recorded before this change identify nothing** — `dae5b2c1f1f59777` and
      `7e14000fb54d28f5` are very likely one measurement.
      REMAINING: the PR's Codex rounds, and the founder's merge grant.

- [ ] **Guardian: the review shadow week RESET on 2026-08-22.** `#1134` diverged
      — `resolved differs: live 13, derived 18` (55 comparisons, 52 agreements;
      every other PR 161/161 that day). The 5-clean-day run for PR-5 restarts
      from the next clean day, and the divergence itself needs investigating: it
      is a real disagreement between reeve's derived review state and GitHub's
      live one, not a flake.

### Founder actions pending

- [x] Add `nextly-ops` to App installation 155196718 — DONE by founder
      2026-08-21, verified by probe: the App now reaches nextlyhq/nextly AND
      nextlyhq/nextly-ops (private), token perms include contents:write +
      pull_requests:write + issues:write + checks:write. Guide (kept for the
      next repo): `docs/action-app-install-nextly-ops.md`.

### Known constraints the design must answer (from measurements so far)

- Codex refused **57%** of review requests (doctor R-05, 22 Aug; 79% on 21 Aug) —
  the gate's "Codex GO" arm will often be absent; the rule table already refuses
  to treat silence as approval.
- The App reaches **one repo** (nextlyhq/nextly). Spec-PR host and builder-PR
  targets need App installs.
- nextlyhq/nextly is **public** — rule 15 forbids reeve's name there; spec PRs
  live in a private repo.
- 500-PR study: crossing ~10 changed files ≈ triples review rounds — the
  implementation phase must bias to small PRs.

---

## Defect log (append-only, newest first)

| Date | Defect | Fix |
|---|---|---|
| 2026-08-24 | **The sandbox had no opinion about CLI tools.** Every rule in it was a SHELL COMMAND rule — `Bash(curl:*)` and 39 others — while the grant's own docblock claimed "it cannot reach the network". `WebFetch` is not a shell command, and neither are `WebSearch`, `Task`, `Workflow`, `SendMessage`, `ListAgents`, `CronCreate`, `ScheduleWakeup`, `RemoteTrigger` or `EnterWorktree`; not one of those names appeared anywhere in `src/`, counted with a positive control. Measured before changing anything, the boundary HELD: a real worker under reeve's own settings called `WebFetch` and got "you haven't granted it yet". It held by CONSEQUENCE — a tool off the allow list falls through to a permission prompt, and a headless run has nobody to answer one. Third instance of that shape after the inert read deny list (22 Aug) and the `.git` block imposed beneath reeve's settings (23 Aug). The worker also spent three of its turns finding out | `NEVER_TOOLS`, grouped by the capability each hands over rather than listed by name, carried into `permissions.deny` AND `--disallowedTools` (a `workerArgs` parameter that had existed with no caller), and rendered into the worker's rules FROM the same constant so prompt and grant cannot drift. It comes from the sandbox, not the prompt spec, so a lane cannot widen it. Measured after: the tool is GONE from the session rather than refused within it — `ToolSearch` reports "No matching deferred tools found" and the worker stops in one call instead of three. Read/Edit/Write/Bash/Grep/Glob deliberately excluded, with the converse asserted: denying a tool a repair needs produces a worker that reports success on work nothing checked |
| 2026-08-24 | **The dirty gate lost a deletion, and then the fix for it was unbounded twice.** A worker removing a copied dependency file produces NO status record at all, so the checkout read clean and the source half of a repair could publish without it. The repair — subtracting the preparation baseline by content — then had to decide which baseline paths were tracked, and did it by naming up to `MAX_COPIED_UNTRACKED` paths as pathspecs, which breaches `ARG_MAX` on macOS (1 MiB) and Windows (32,767 chars). Reading the whole index instead breached the 64 MiB subprocess buffer. Both throw, both return `null`, and both make the caller quarantine a repair that was fine: one defect wearing two limits. A regression test for the first version also asserted a platform's number as a property of the code — green on macOS, red on the Ubuntu runner | the gate keys on what status REPORTED and subtracts the baseline by content, so an untouched tree is not re-hashed after every paid run, and a dependency patch the worker declared and reeve committed is no longer refused as uncommitted work. Neither path list is held now: git streams the index to a file and it is read in fixed 64 KiB chunks, with the carry kept as a Buffer because a multi-byte character split across two reads corrupts a name SILENTLY and the file then reads as untracked. The control probes the platform and PRINTS which of the two happened, rather than asserting one platform's limit — reeve has to run on macOS, Windows and Ubuntu. Stated plainly in the PR: reverting to the buffered read leaves the test green, because a 64 MiB index needs ~1M tracked paths and no fixture builds that. The buffer removal is argued, not demonstrated |
| 2026-08-24 | R-01's bypass caveat named the CLASS of a bypass actor and not the actor. `actor_type` renders `Team:1` and `Team:2` identically, so "unless reeve's identity is inside the bypass" was a question the operator had no way to answer — and for `actor_type: "Integration"` the withheld id IS the App id reeve identifies itself by. The check earns its place by being read BEFORE a worker run is paid for, so a caveat that cannot be acted on is worse than none | one `bypassActorName` behind both renderings, so the fix cannot be half-applied. `baseline.mjs` renders the same field and deliberately does NOT share it — that string is a stored canonical form and rewording it would move every recorded baseline and report drift where nothing changed; the reason is in the helper's comment so the next person does not "finish" the centralisation. An actor with no id degrades to the bare type, because a dangling colon reads as a truncated id |
| 2026-08-23 | **P0 — the worker could not commit, so no dispatch could publish.** The OS sandbox (`1a2fbea`, 22 Aug 10:47) denies every write under `.git` at the Bash layer, BENEATH anything reeve declares: reeve's own settings carried `denyWrite: []` and denied `.git/**` only for the file tools. A worker attempted `git add`/`git commit` seven times, got `Unable to create .git/index.lock: Operation not permitted`, and spent 13 of its 36 tool calls correctly diagnosing an impossible instruction. Publication had been PROVEN working on 21 Aug and broke the next morning with nothing noticing, because the capability was recorded in a handoff as a standing fact rather than a dated one. Found by re-verifying that very line, not by a failure. While it stood, each eligible red PR spent its single attempt for ~$1 and produced an escalation | staging and committing moved to reeve (`commitRunWork`), which stages EXACTLY the paths the worker declared in `filesTouched` via `git --literal-pathspecs add --force --pathspec-from-file=- --pathspec-file-nul` — never `git add --all` — and refuses when what staged does not match what was declared. The worker is told it cannot commit, which is what stops the attempt costing a run; it keeps `status`/`diff`/`log`/`show` and is pointed at `git clean -f --` because `rm` is not granted. `Bash(git add:*)` and `Bash(git commit:*)` added to `NEVER` as DIAGNOSTICS, so the refusal reads as a boundary rather than a broken machine. reeve was DISARMED the same day and the repair verified end-to-end on 24 Aug |
| 2026-08-23 | The prompt promised commands the grant did not carry — the sixth instance of one shape, after four tabulated on 21 Aug. Rule 0 told every worker `pnpm test` was permitted while the fixture granted no `pnpm` at all, and the prompt forbade absolute binary paths while `sandboxFor` grants the interpreter by absolute path as the only route left when a unit's language is unrecognised. Five of the six are drift between two things reeve itself writes; the P0 above is NOT — a generator reading the grant would have cheerfully advertised `git commit` | the prompt renders FROM the grant (`claimedCommands`, `runnableCommands`, `namedRunners`, `exampleCommand`), with the wrapper exemption so a declared `sh test.sh` is not forbidden by the plain-names rule; `test/prompt-sandbox-agreement.test.mjs` drives 15 profiles through one `forbids()` predicate. Closing the class does not reach the P0, and the write-up says so: that needs the EFFECTIVE restrictions probed, not just the declared ones |
| 2026-08-22 | **PR-3 Codex round 3, 8 findings (7×P1), arriving after the merge** — deeper attacks on the checkout and publish path, all real. The publication gates read `HEAD` while `publishRunWork` pushes `e.headRef`, so a worker could commit anything on the branch, check out an auxiliary branch with an allowed change, and have content NO gate inspected pushed. The credential check read the NET patch, so a token committed and then deleted was published in the intermediate commit, and binary blobs never appear in patch text at all. `git clone` copied every one of the founder's local branches and their objects into the worker's checkout, so a private branch arrived as `origin/private` — readable, and copyable into an allowed path, which the path-deny does nothing about. A worker could `git replace <pinned> <fake>` so every diff the daemon took reported an innocuous change while the push carried the real commits. A global `filter.<name>.smudge` in the founder's config runs, unsandboxed, as the daemon, when PR-controlled `.gitattributes` names it — before the worker starts, so no fingerprint can help. A PR-committed symlink where a unit root belongs made the dependency copy write OUTSIDE the checkout as the daemon. Concurrent workers under one worktreeRoot could read each other's checkouts and homes. And (P2) an empty `git ls-remote` read as "unchanged", so a branch the contributor deleted mid-run was RECREATED by the push | every gate judges `refs/heads/<headRef>` and refuses when it cannot be read; the credential check walks every newly reachable object (`rev-list --objects` + `cat-file --batch`), so intermediate commits and binary blobs are covered; the checkout is `git init` plus a single-ref fetch of the pinned revision, not a clone; `--no-replace-objects` and `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_ATTR_NOSYSTEM=1` on every daemon git call in worker-controlled trees; every component of a dependency destination is checked for symlinks and the resolved path must stay under the checkout; the shared worktree root is deny-read with only this run's own checkout carved back out (a root, not a list, because a list goes stale the moment another run starts); an empty ls-remote refuses the publish. The live canary caught TWO regressions from these fixes within a minute each: its own directory denied by the sibling rule, and its readable-neighbour control denied with it |
| 2026-08-22 | The review shadow week's four divergences were the INSTRUMENT, not the derivation. Taken back to back, live and derived agree exactly on all four PRs (#1134 31/26, #1128 55/7, #1131 8/8, #1133 20/19). In a tick they are not taken together: `evaluate()` reads GitHub live, `observe()`+`ingest()` read it AGAIN afterwards, the projection is built from what that ingest wrote, and `compare()` then holds the FIRST reading against the THIRD. Any PR that moved in between was recorded as the derivation disagreeing — the probe's own ingest was still inserting five threads on #1128, which is exactly that PR's reported gap. The instrument that decides whether PR-5 is safe could not tell a moved pull request from a broken derivation | the live read is retaken after the ingest, and only when the ingest wrote something (a quiet PR costs no extra call); a retake that fails makes the tick INCOMPARABLE, which counts as neither agreement nor disagreement. Whether the ingest also MISSES threads is a separate question and is now answerable: a divergence that survives this is a real one |
| 2026-08-22 | **PR-3 Codex round 1, 6 findings, 5 genuine P1.** The one that matters most: **a scratch HOME does not close the keychain** — it empties the keychain SEARCH LIST. Measured: `security find-internet-password -s github.com <login.keychain-db>` returns **0 (FOUND)** from a scratch home, because the file does not move, is unlocked with no timeout, and the worker runs as the same OS user. Every probe reeve had asked the search list, so nothing could see it — **including the canary, which had certified containment on that basis and PASSED**. Also: `git clone --branch <b>` asks the source for a LOCAL head and a PR branch exists only as `origin/<b>`, so **every ordinary dispatch would have failed at the first step** (every fixture created the branch locally first); a finished worker that never committed had its work **deleted** while the log said it was published, because a push carries commits and `changedFiles` counts uncommitted paths; the worker's OAuth token can be written into an ordinary source file that the filename-only diff gate passes and reeve then pushes; dependencies were hard-coded to `node_modules` while every worker got an empty scratch HOME, so python/go/rust checks could not resolve anything; and (P2) the per-invocation canary tree was built before the cache lookup, leaking a directory per tick under a cached pass | `~/Library/Keychains` denied by path (measured with a positive control: 44 under the deny, 0 without) and the canary probes BOTH shapes and refuses to pass if the by-path probes are absent; plain clone plus an explicit remote-tracking refspec; dispatch refuses to publish or release a checkout with uncommitted work, and `publishRunWork` refuses when the fetched head equals the remote head; the diff is scanned for reeve's own token before publishing (a literal match, and the code says so); dependency trees come from the profile's languages with `worker.dependencyPaths` overriding and the unsupported case LOGGED; cached/skipped canary results marked and the tree removed unless the canary holds it for evidence |
| 2026-08-22 | The FIRST live canary failed, and was right to. The file tools (Read/Edit/Write/Grep/Glob) are governed by `permissions.*` alone — the CLI's own process runs outside the Seatbelt profile it applies to the shells it spawns — and a permission rule takes an absolute path only with TWO leading slashes. This branch shipped one slash, so every absolute Read deny matched nothing: `~/.ssh`, `~/.gitconfig`, `~/.claude`, `~/.config/gh`, `~/.aws`, `~/.reeve` (App key, event store, every run's output), the state roots and the founder's checkout. In one run `cp <decoy> .` was refused while `Read(<decoy>)` returned it. Nothing else could have caught it: the escape test drives the OS sandbox through `srt`, which is the layer that held, and there is no CLI in it. `--allowedTools` also granted the file tools BARE, which grants them wherever the deny list does not name. And the canary id covered only the sandbox block, so the re-run passed under the SAME id as the failure — a pass either side of the fix would have been reused across it | `ruleFor` emits the `//` form for permission rules while the OS layer keeps the plain one; `validateSettings` refuses a single-slash absolute rule; the file tools are scoped to the checkout in BOTH forms (creating a file is checked against the directory) with the path resolved first (`/var` → `/private/var`); `validateToolGrant` before spawn and `scopeGrant` for a prompt's own tool list; `canaryIdFor`/`policyHashOf` cover `permissions.deny` and the grant; the canary now takes production's scope AND grants the decoy by name, so only the deny can refuse it |
| 2026-08-22 | A sandboxed worker could READ the founder's checkout — uncommitted work and ignored files, a `.env` among them. The standalone clone keeps them out of the worker's checkout, which is not the same as out of reach: the sandbox denies writes outside the checkout, not reads | `identity.checkout` joins the denied reads and the validator requires it; three fixtures that set checkout == worktreeRoot were separated, the overlap guard having correctly refused them |
| 2026-08-22 | A failed checkout preparation was reported as the worker tampering with git config. Preparation moved inside the dispatch try-block, so a failure left the path null and the config check read that as "no recorded configuration" — accusing a worker that never started, on the most ordinary failure there is | `if (!worktree) continue` before the config check; the case lives in dispatch-e2e with a precondition asserting dispatch was reached |
| 2026-08-22 | PR-2 Codex round 8, 3 genuine (2×P1), all follow-ups on round 7's own fixes: the id normalisation was applied inside `sandboxCanary` but the CACHE key in `measureContainment` was still computed without the worktree, so the cache still never hit and every tick still paid a five-minute canary; the tamper cleanup ran `--unset-all` on a key the worker CHANGED rather than added, so tampering with `remote.origin.url` would have deleted the clone's real origin and left the main checkout unable to fetch or push; and the spawn-time refusal refunded the fix attempt while the pre-execution handler refunded it again, taking a cause from two spent attempts to zero and handing back retries the cap had spent | `worktree` threaded into the cache key; `restoreConfig` puts recorded values back (removing only keys the worker ADDED); the refund left solely to the `finally` handler |
| 2026-08-22 | flake-dispatch and worker-contract asserted dispatch while `capacity()` reads the HOST load average — the same fragility fixed in dispatch-e2e last round, in two tests I had not covered; they passed only because the machine was quiet, and failed as soon as my own test runs loaded it | the `ctx.capacity` seam injected in both; all three dispatch tests proven green under 14 CPU burners |
| 2026-08-22 | PR-2 Codex round 7, 6 genuine (4×P1), each a follow-up on round 6's own fixes. Reproduced by the reviewer: a worktree PRESERVED for tampering was re-acquired on the next tick, and `verifyWorktree`'s `git status` ran BEFORE any config check — a worker-added `.gitattributes` plus `filter.<name>.clean` (a shape `-c` cannot reach) executes as the daemon user. Also: a relative `--db` was opened fine but protected by nothing; the doctor overwrote today's generated `denyRead` with the RECORDED one, so a changed `risk.quarantinePaths` or `notify.credentialFile` left the hash equal and R-14 kept saying OK; `credentialPaths()` re-adds a non-default `REEVE_HOME`, so a layout with worktrees inside it denies the worker its own checkout and containment can never close; quarantine denies are rooted at the canary's per-invocation dir, so the canary id changed every tick and the cache never hit (a 5-minute model call per tick); and the canary only ever exercised DIRECTORY denies while production also relies on exact-FILE denies (the log, the database, ~/.gitconfig, the notify credential) | config verified BEFORE any git command on re-acquire, quarantine by rename with the offending keys stripped from the clone and `worktree prune` (my own test caught that renaming alone strands the branch forever); the check is key-aware, so reeve's own keys moving is a re-harden and anything else is tampering; `resolve()` on `--db`; the record keeps only the non-reconstructable state roots and doctor regenerates the rest from the profile; an overlapping state/worktree layout is named and refused; `normalisePolicy` rebases worktree-derived denies; and an exact-file decoy WITH a readable neighbour as its control, measured to hold under the real Seatbelt sandbox |
| 2026-08-22 | PR-2 Codex round 6, 8 genuine (6×P1). The worst: a worker's `git config core.fsmonitor ./payload` would have been EXECUTED by the daemon's own unsandboxed `git status` before the push, as the daemon user — the hooksPath fix covered only the push. Also: a relative `--log` silently dropped every state deny (they are filtered to absolute) and handed the worker relative run/settings paths consumed after its cwd became the worktree; `Read(<file>/**)` denies descendants, so the log and database files stayed readable to the Read tool; the `--db` store and the `notify.credentialFile` were in no deny list at all; the canary accepted ANY `is_error` as a denial, so a malformed call could certify a boundary it never reached; the canary worker could rewrite `canary.sh` before running it; and R-14 compared only the stored binary, not the policy the daemon would generate now | neutralising `-c` flags on every daemon git call plus a config FINGERPRINT taken at harden and verified before any read/publish (refuses and preserves the worktree); `resolve()` on logPath at the single derivation point; file-and-subtree Read rules per state root; `--db` (+WAL/shm) and the notify credential threaded into the denies and required by the validator; a policy-refusal predicate (`isPolicyRefusal`) replacing bare `is_error`; `Write(./canary.sh)` denied plus a post-run script hash; `policyHashOf` recorded and compared, UNKNOWN when it cannot be reconstructed |
| 2026-08-22 | PR-2 Codex round 5, 8 genuine (3×P1): git's XDG credential store (`~/.config/git/credentials`) was not denied — stripping `XDG_CONFIG_HOME` only restores the default location; `risk.quarantinePaths` were denied to the file TOOLS only, so a fixer holding `cat` could read a production dump and copy it into a source file the diff gate would pass; the canary probed outside-writes only through the shell, never the Write TOOL a real fixer holds; R-14 reported OK from a historical record even after the CLI was replaced; `revalidateContainment` read an async keychain injection as a pending Promise and refused every eligible worker; `dirname(logPath)` as a denied state root can be `$HOME`, which would deny the worktree itself; concurrent canary-state writes shared one `.tmp` path; and the cheap-gate skip still built a per-invocation canary tmp tree every tick that nothing cleaned up | `~/.config/git` denied; `quarantineOsDenies` (unrepresentable globs REFUSE the dispatch); `parseWriteProbe`; R-14 verifies the recorded binary identity, UNKNOWN when it cannot; awaited keychain; `stateRootsFor` names specific subtrees and never an ancestor of the worktree; per-process temp names; cheap gates run before any preparation |
| 2026-08-22 | dispatch-e2e asserted "a worker was dispatched" while `capacity()` reads the HOST's load average, so a busy machine failed the suite for a reason that was not the code (found while chasing an apparent hang: the e2e also makes real `gh` calls per tick, so it is slow rather than hung) | a `ctx.capacity` seam; the e2e injects a deterministic capacity, proven by running it green under 12 CPU burners |
| 2026-08-22 | PR-2 Codex round 4, 6 genuine (4×P1): the network control still bracketed the whole 5-min model run and depended on external reachability → replaced with a daemon-LOCAL listener the sandboxed curl must not reach (positive control, no external dep, no timing window; measured: the sandbox blocks loopback, and the escape test proves it against the real Seatbelt); the Read-path match still accepted any same-basename path → require a normalised EXACT match to the decoy; the per-spawn revalidation ran before `resolveWorktree`'s git fetch → moved to the last moment before `spawnWorker`; R-15 still read the isolation LABEL → now reads `isolationTopologyReady()` (false until PR-3); the run-state root (`dirname(logPath)`) was undenied under a non-default `--log` → threaded `stateRoots` into the worker settings + validator; the canary's working dirs were fixed per repo → per-invocation. (Round-4 findings 1-10 were stale re-reports, verified fixed.) | `netListener` positive control; exact `parseReadProbe`; revalidate-at-spawn; `isolationTopologyReady` in doctor; `stateRoots`; per-invocation canary dirs |
| 2026-08-22 | PR-2 Codex round 3, 5 genuine P1: the `worker.isolation` LABEL was trusted, but dispatch still runs a linked worktree as this user (the dedicated-user topology is PR-3) → the label closes only when a `isolationTopologyReady()` seam says so, which hard-returns false until PR-3; `parseReadProbe` matched an empty path (`decoyPath.endsWith("")`) → require a nonempty exact/basename match; the per-tick verdict was reused for every spawn → `revalidateContainment` re-checks the CLI binary identity AND the keychain immediately before each spawn (`guardian:containment:changed`); the network control ran on the daemon's ambient proxy while the sandboxed curl runs proxy-stripped → run the control under the worker env. (Round-3 findings 1-8 were stale re-reports, verified fixed.) | `isolationTopologyReady`; exact `parseReadProbe`; `revalidateContainment` per spawn; worker-env `netReachable` |
| 2026-08-22 | PR-2 Codex round 2, 6 genuine (4×P1): the Read-tool probe trusted a worker-written file (a model can write `DENIED` without calling Read) → judge it from the event stream (Read tool_use on the decoy + a denied result); the network control was sampled once, 5 min after the sandboxed curl → bracket it before AND after; `CREDENTIAL_PATHS` hard-coded `~/.reeve` while `REEVE_HOME` can move the state root → deny the configured root; the paid canary ran even when a cheaper reason already opened containment → short-circuit; doctor R-15 read OK on an empty keychain though the daemon refuses without `worker.isolation` → R-15 DEGRADED until isolated; `nwo.replace("/","-")` collides (`foo-bar/baz` vs `foo/bar-baz`) → nested `owner/repo.json`. (Round-2 findings 1-7 were stale re-reports of round 1, verified fixed + CI-green.) | `parseReadProbe`; bracketed `netReachable`; `credentialPaths()`; canary short-circuit; `checkKeychain` isolation; injective `canaryStatePath` |
| 2026-08-22 | PR-2 Codex round 1, 7×P1: canary prompt ran `sh ./canary.sh .` but the grant was exact `Bash(sh ./canary.sh)` → every real canary refused, `--execute` permanently blocked; worker `GIT_CONFIG_GLOBAL` under deny-read `~/.reeve` → sandboxed git can't read its own config → no commits; canary exercised only Bash `cp`, never the Read-tool deny; any nonzero curl read as network-denied (also true offline); two daemons shared one decoy (ENOENT read as denial); keychain probe of two items can't certify a shared account; a linked-worktree worker can plant a hook the daemon's push runs unsandboxed. 3×P2: canary id ignored the binary identity; doctor read the canary from a different dir than the daemon wrote it; measured-closed test only passed on macOS | grant `:*`; git config → run tmp; Read-tool probe with a sentinel; network positive control; per-run decoy + existence check; `worker.isolation` gate (dedicated-user only); `pushWorktree -c core.hooksPath=/dev/null`; binaryId in the canary id; `canaryStateDir` shared by daemon+doctor; test pins the platform |
| 2026-08-21 | Watcher reported "unclassified verdict: gap" for a PR green everywhere but refused by GitHub's approving-review requirement (live on #1129) — a routine needs-a-human state read as a broken classifier | `a5344dd` + `ESCALATIONS.PROTECTION_UNMET` |
| 2026-08-21 | `shadow`'s case label captured `status`/`statusline`/`dash` — all three printed the shadow report since PR-4 landed; no test covered CLI routing | `c80f0a3` + `test/cli-routing.test.mjs` |
