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
- [ ] **PR-3 (S1 close-out): the dedicated-user dispatch topology.** The only
      thing that closes containment: a separate OS user for workers (its own
      empty keychain) and a per-run STANDALONE clone (its own git dir, which
      also closes the shared-ref and shared-config holes). Ships with a real
      `isolationTopologyReady()` (euid differs from the checkout owner; the
      worktree is a standalone clone), replacing today's hard-false. Only after
      it lands may `worker.isolation: dedicated-user` be set.

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
