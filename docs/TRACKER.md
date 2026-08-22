# reeve tracker

The one file that says what reeve has, what is in flight, and what remains.
Update it the moment a decision lands or a state changes — never in batches.
Rule of the house: every claim here is either **measured** (say when) or marked
**intent**. Absence from this file means "not planned", not "done".

Last full re-verification: 2026-08-21 (suite 45/45, daemon observe-only,
`HEAD == origin/main`).

---

## Programme 1 — the GUARDIAN (built, partly armed)

The four capabilities, measured 2026-08-21:

| # | Capability | Switch | State | Unblocks when |
|---|---|---|---|---|
| 1 | Watch, judge, escalate | — | **ON** | live on nextlyhq/nextly |
| 2 | Fix red CI itself | `--execute` | off | dispatch evidence (not time-bound) |
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
- [ ] Dispatch evidence: the wrong-worker shape (a confidently bad fix). ~$2, 1h.
- [x] `release` lane dead-by-construction — DONE 2026-08-21 (`4998f66`).
      `lanes[].sensitiveOk` lifts the tool-layer deny (verbatim globs only) and
      the diff-gate sensitive refusal (territory-scoped, per file); quarantine
      and self-governing stay unreachable. Validator warns on the dead shape.
      Live nextly profile updated. NOTE: nothing assigns `decision.lane` yet —
      lanes go live with the builder's implementation phase.
- [ ] *Optional (founder: "if beneficial")* — PR-open size warning (>10 files →
      expect 4+ rounds), reinstate Greptile (best critical hit rate, out of credits).

### Needs the founder

- [ ] **ntfy read user** — all 5 tokens write-only; needs shell on 95.217.11.127
      (`ntfy user add mobeen`; `ntfy access mobeen revnix-reeve read-only`;
      `upstream-base-url` for iOS). Desktop notifications work meanwhile.
- [ ] **Second project** (`rextaihq/rext-backend`) — needs PR-gating CI + App install.
- [ ] **Worker identity decision** — a dedicated macOS user for workers (the only
      non-sandbox way to make the keychain and `~/.config/gh` unreachable) vs
      relying on the OS sandbox's read deny once measured in PR-2. Until one is
      proven, no worker dispatches (`guardian:containment:open`).
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
- [ ] **S2 (hub core) plan written 2026-08-22:**
      `docs/superpowers/plans/2026-08-22-s2-hub-core.md` — 24 tasks, split into
      THREE PRs because S2 is ~20 files against a 10-file budget: PR-A hub store
      (32-table STRICT schema, forward-only migrations, three locks, hub-aware
      backup, destructive restore drill, the prose-versus-DDL cross-check),
      PR-B the pure phase machine and the fenced outbox, PR-C the provider
      scheduler — last, because it is the only one that changes the running
      guardian. Founder decisions, do not re-litigate: the guardian fails **OPEN**
      when hub.db is unreadable (the scheduler restrains the BUILDER; it must not
      become a new way to silence the watchman); `ci.flakePatterns` is **REMOVED**
      and the live nextly profile stripped in the same change
      (`docs/measured/2026-08-22-flakepatterns-has-no-readers.md` — zero readers,
      and the validator refuses unknown keys including empty arrays, so removing
      it alone would kill every daemon start); `repo_gate_state` ships with a pure
      derivation behind an injected fetcher, the live client staying in S8.

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
