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
   until clean (cap 5 → escalate). Once Codex cleans at the current head, a
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
- [ ] **PR-2 (S1 sandbox) — IN REVIEW, branch `feat/s1-sandbox`.** Both CLI
      measurements are recorded (`docs/measured/2026-08-22-claude-print-mode.md`):
      the `sandbox.*` block APPLIES under `-p` (network, outside writes,
      `denyRead` incl. through symlinks, and `Read(...)` denies all hold), and
      an INVALID settings file is dropped WHOLE and silently, deny rules
      included. Shipped:
      · **`sandbox.*` in every worker's settings** (`src/sandbox.mjs`):
        enabled, failIfUnavailable, allowUnsandboxedCommands=false,
        autoAllowBashIfSandboxed=false, no excluded commands; write scope =
        worktree + the run's own tmp; network denied except research; the
        credential paths are `denyRead` at the OS layer AND `Read(...)`-denied
        for the Read tool the OS sandbox doesn't cover.
      · **`validateSettings` before spawn** — a closed key-allowlist with exact
        values; a refusal is a preparation failure (refund + backoff), never a
        launch, because an invalid file would be silently ignored.
      · **The sandbox canary** (`src/canary.mjs`): one throwaway worker per
        (CLI build, block) runs a fixed script; the DAEMON reads the files it
        left (writes outside, network, decoy reads — each with a positive
        control), never the worker's word. Cached while it passes; a failure is
        re-measured.
      · **Measured containment** (`src/containment.mjs`): the static
        `CONTAINMENT` constant is SUPERSEDED. Dispatch under `--execute` is
        gated on `measureContainment` = canary pass **AND** an empty login
        keychain of GitHub items **AND** a measured platform. Anything
        unmeasured is open. Keychain probe is metadata-only (no `-w`/`-g`).
      · **Doctor R-14 (canary) / R-15 (keychain)** — R-14 UNKNOWN with no
        record, BROKEN on a failed canary, OK on a pass; R-15 DEGRADED (not
        broken) while the keychain holds a credential: dispatch is gated,
        observation/review unaffected.
      · **Escape test** (`test/escape.test.mjs`) rewritten to measure every
        shape twice — environment-only and UNDER THE SANDBOX (via the runtime's
        own profile, `@anthropic-ai/sandbox-runtime` as a dev dep, no model).
        The sandbox CLOSES the env-only holes (`--no-verify`,
        `-c core.hooksPath=` pushes cannot land: destination is outside the
        write scope; network denied). **Two KNOWN-OPEN remain under the sandbox
        in a LINKED worktree:** (1) the shared ref store lets a worker move the
        checkout's own branches; (2) `git -c credential.helper=osxkeychain
        credential fill` returns the founder's token (securityd is hard-allowed
        by the runtime's profile; no setting closes it).
      Suite 57/57. **Codex round 1 (10 findings, 7 P1) all worked** — see the
      defect log below. The verdict is now strictly harder to reach: dispatch
      requires canary + platform + keychain-clean **AND** a declared isolated
      worker (`worker.isolation: dedicated-user`), because the keychain probe is
      necessary-not-sufficient (a token can hide under another service name) and
      a linked worktree shares the checkout's git dir. **The ONE closure is a
      dedicated worker OS user** (own empty keychain + own clone); clearing the
      founder's keychain is no longer treated as sufficient. **Not flipped:**
      `worker.isolation` defaults to `none`, so dispatch is refused; the
      dedicated-user DISPATCH TOPOLOGY (per-run standalone clones owned by the
      worker user) is **PR-3** — do not set the flag to `dedicated-user` before
      PR-3 lands it.

### Founder actions pending

- [x] Add `nextly-ops` to App installation 155196718 — DONE by founder
      2026-08-21, verified by probe: the App now reaches nextlyhq/nextly AND
      nextlyhq/nextly-ops (private), token perms include contents:write +
      pull_requests:write + issues:write + checks:write. Guide (kept for the
      next repo): `docs/action-app-install-nextly-ops.md`.

### Known constraints the design must answer (from measurements so far)

- Codex refused **79%** of review requests this week (doctor R-05, 21 Aug) —
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
| 2026-08-22 | PR-2 Codex round 1, 7×P1: canary prompt ran `sh ./canary.sh .` but the grant was exact `Bash(sh ./canary.sh)` → every real canary refused, `--execute` permanently blocked; worker `GIT_CONFIG_GLOBAL` under deny-read `~/.reeve` → sandboxed git can't read its own config → no commits; canary exercised only Bash `cp`, never the Read-tool deny; any nonzero curl read as network-denied (also true offline); two daemons shared one decoy (ENOENT read as denial); keychain probe of two items can't certify a shared account; a linked-worktree worker can plant a hook the daemon's push runs unsandboxed. 3×P2: canary id ignored the binary identity; doctor read the canary from a different dir than the daemon wrote it; measured-closed test only passed on macOS | grant `:*`; git config → run tmp; Read-tool probe with a sentinel; network positive control; per-run decoy + existence check; `worker.isolation` gate (dedicated-user only); `pushWorktree -c core.hooksPath=/dev/null`; binaryId in the canary id; `canaryStateDir` shared by daemon+doctor; test pins the platform |
| 2026-08-21 | Watcher reported "unclassified verdict: gap" for a PR green everywhere but refused by GitHub's approving-review requirement (live on #1129) — a routine needs-a-human state read as a broken classifier | `a5344dd` + `ESCALATIONS.PROTECTION_UNMET` |
| 2026-08-21 | `shadow`'s case label captured `status`/`statusline`/`dash` — all three printed the shadow report since PR-4 landed; no test covered CLI routing | `c80f0a3` + `test/cli-routing.test.mjs` |
