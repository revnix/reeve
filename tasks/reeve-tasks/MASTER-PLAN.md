# reeve builder — MASTER PLAN

**What this file is.** Two things that must not drift apart, so they live in one file:

- **Part A — the roadmap**, S3 through S12. Each stage's scope and *Verify:* clause is
  reproduced **verbatim from `docs/2026-08-21-builder-design.md` §14**, never paraphrased,
  because the *Verify:* clause is the definition of done and a paraphrase of a definition
  of done is a second definition.
- **Part B — the authoring spec.** How a stage plan, a tracker and a measured document are
  written in this repository. Every rule in Part B was derived from a measurement over the
  existing corpus, and each carries the measurement, so the next author does not re-derive it
  and does not overrule it by taste.

**What this file is not.** It holds no live state. Which PR is open, which task is claimed,
what a review found — all of that is in `trackers/`. A fact that changes when someone pushes
does not belong here.

**Authority.** `docs/2026-08-21-builder-design.md` is the spec and outranks this file. Where
this file and the design disagree, the design wins and this file is wrong. Where this file
and a *plan* disagree, this file wins, and the plan is amended.

**Measured against `16cd880`, 2026-08-27.** Every count in this file is a measurement with a
date. Treat any of them older than the current `main` as a claim to re-check, not a fact.

---

## Part A — The roadmap

### A.0 How to read the stage table

§14's preamble binds every stage and is reproduced verbatim
(`docs/2026-08-21-builder-design.md:818`):

> Each stage lands green before the next; each PR within a stage stays within the reviewability budget where possible. New ctx keys default off, following the `ctx.reviewIngest !== false` opt-out pattern, so the existing guardian test files stay green untouched. Capability switches (§1.4) turn on only at the stage that proves them. Nothing merges a PR before S10.

Four rules follow, and they are what the roadmap actually enforces:

1. **The stage order is a hard sequence.** A stage does not begin before the previous one is
   green. There is no "start S4 in parallel while S3 finishes."
2. **A switch turns on at the stage that proves it, and not before.** The switch column below
   is not a plan; it is a permission that the stage's Verify clause purchases.
3. **New `ctx` keys default off** in the opt-out shape, so guardian test files stay green
   untouched. A new key that changes an existing test's result is a defect in the key.
4. **Nothing merges a builder PR before S10.** reeve's *own* PRs merge under the founder's
   explicit per-PR grant; that is a different thing, governed by §B.9.

| Stage | design line | Switch it turns on | State (2026-08-27) |
|---|---|---|---|
| S0 Amend the design and freeze authority | `:820` | none | **COMPLETE** — PR #3 |
| S1 The worker boundary (guardian-shared) | `:822` | none | **COMPLETE** — PRs #3, #4, #5 |
| S2 Hub core (guardian-shared for the scheduler) | `:824` | none | **COMPLETE** — #20, #30, #35, #40, #44, #53 |
| **S3 Founder-filed read/report phases only** | `:826` | **`observe`** | **NEXT** — plans written, no code |
| S4 Private spec PR and the gate, armed | `:828` | `draftSpec` | not started |
| S5 Ledger hardening, then ledger intake | `:830` | `builder.intake.ledger.enabled` | not started |
| S6 Local implementation, controller acceptance and commit | `:832` | `implementLocal` | not started |
| S7 PR publication and guardian receipt import | `:834` | `publishPr` | not started |
| S8 The dark merge coordinator | `:836` | merge code lands **off** | not started |
| S9 Shadow, chaos, and replayable evaluation | `:838` | none | not started |
| S10 Supervised canaries and progressive enablement | `:840` | `mergeBuilderPr` + `--actuate-merges` | not started |
| S11 Ubuntu parity | `:866` | none (per-platform fail-closed matrix) | not started |
| S12 Windows parity | `:868` | none (per-platform fail-closed matrix) | not started |

**Live state for each stage is in `trackers/`, not here.** `trackers/MASTER.md` is the index.

---

### A.1 S3 — Founder-filed read/report phases only

**Switch:** `builder.capabilities.observe`. **Design line:** `:826`. **Tracker:** `trackers/s3.md`.
**Plans:** `plans/2026-08-27-s3{a..f}-*.md`. **Depends on:** S2 (complete).

**Scope, verbatim:**

> **S3. Founder-filed read/report phases only** (`observe` on). `reeve task file` with the territory grammar, SIZING/RESEARCH/DESIGN workers, `reviewArtifact`, `--agents` fan-out, artifacts, dash, why, doctor. No spec PR, no ledger import, no public effect.

**Verify, verbatim:**

> *Verify:* one real scout task through to artifacts; **measure** real phase budgets, alias-to-model resolution, sandbox behaviour under fan-out, `--json-schema` reliability across 20 runs, and the headless-versus-interactive subscription pool (§10.4), each recorded in the profile or the tracker with dates.

**The six obligations that clause contains**, numbered so a tracker row can carry one each.
The numbering is this programme's; the *text* is the design's.

| # | Obligation | Recorded where §14 says |
|---|---|---|
| V1 | one real scout task through to artifacts | evidence + tracker |
| V2 | **measure** real phase budgets | profile (`builder.budgets.<ACTION>`) **or** tracker, with dates |
| V3 | **measure** alias-to-model resolution | profile/tracker, with dates |
| V4 | **measure** sandbox behaviour under fan-out | profile/tracker, with dates |
| V5 | **measure** `--json-schema` reliability across 20 runs | profile/tracker, with dates |
| V6 | **measure** headless-versus-interactive subscription pool (§10.4) | `provider_state.concurrency_limit` + `guardian_reserved` + `measured_at` |

**Gating rules that bind S3**, verbatim, with the design line each sits on:

- `:5` — *"Every PR from S3 onward (the first one that can dispatch a worker under a switch) is authorized only after S0 through S2 have landed with the evidence each stage names."* Satisfied.
- `:65` — *"A switch may be turned on only at the rollout stage that proves it (§14)"* and *"**A switch is consulted before the transition that would need it, not after.**"*
- `:69`, `:810` — *"Every new profile key (all `builder.*` knobs) is added to the profile `FIELDS` validator **first**, or every daemon start dies at profile load."* **This is what orders S3's first PR**: T1 is FIELDS, and nothing precedes it.
- `:810` — *"Shared-code touches, each verified by running the full guardian suite in its PR."*
- `:231` — *"**A transition commits only after its phase artifact is durable.**"*
- `:572` — *"**Limits are measured before they are chosen.**"*
- `:577` — *"**The builder tick never blocks.**"*
- `:132` — *"**Territory is REQUIRED at filing**"* … *"the absence of a territory claim must never read as the absence of conflict."*
- `:134` — *"**There is no `--fast` flag and no gate skip of any kind.**"*

**S3 is the designated measurement for two §16.2 open questions**: q4 (headless-vs-interactive
pool; *"Defaults until then: limit 2, reserved 1"*) and q7 (*"IMPLEMENT budgets (60-90 min)
are guesses… calibrate from S3 and S6"*).

**Two PRs land before S3's first task**, and they are not S3 tasks:

1. **The test suite's dead network.** Measured with a control: **550.1s → 159.8s**, PASS output
   byte-identical on the four largest files, with a `gh` stub first on `PATH`. S3 is measured
   with this instrument sixteen times and adds ~10 files to it. Standalone, because it touches
   guardian files and the corpus says mixed PRs converge worse.
2. **Issue #50** — extract the provider/hub session from the guardian's `tick()`. Measured at
   `16cd880`: `tick()` is `src/daemon.mjs:975-3225` = **2,251 lines** with **50** provider/hub
   touch points. #50's own acceptance test is *"adding a new call site must not be able to skip
   a rule"*, and S3's T8 **is** that call site — so this is the only moment that test can be
   written honestly rather than asserted.

---

### A.2 S4 — Private spec PR and the gate, armed

**Switch:** `builder.capabilities.draftSpec`. **Design line:** `:828`. **Depends on:** S3.

**Scope, verbatim:**

> **S4. Private spec PR and the gate, armed** (`draft-spec` on). Spec worktree in the dedicated clone, hub outbox push/create/comment/review-request through the Rule-15-checked executor with per-effect visibility re-query, the inbox extended to the spec repo, `gate.mjs` with the §7.3 table, strict-grammar fixtures from the #1129/#1130 corpus, the notice outbox effect and delivery-receipt clock, approval generations, `reeve task go --sha` and `ack`, round-keyed revision pushes, the post-GATE watcher. **The silence path (row 5) is live from the first spec PR this stage handles**: there is no shadow period and no founder-explicit requirement on advances after GATE (§7.3, founder ruling of 2026-08-21); the strict grammar, the head-SHA binding, and the notice receipt are the safeguards. "Supervised" in this programme refers only to human approval on implementation PRs (§9.1) and has no meaning at this stage.

**Verify, verbatim:**

> *Verify:* gate table exhaustively, all seven rows crossed with head-moved and receipt-missing cases, UNKNOWN never proceeds; notice failure never yields silence approval; founder free-text holds; depth override lands in DESIGN; SHA and generation binding; one revision per round across a crash; escalation grammar test extended.

**Carried into S4 by decision**, from the S3 research sweep (brief §5, R-block B):

- **R14** — identity-bound evidence in the verdict, never apparent agreement. Bind each clause
  to a verifiable principal: check-run producer app id, reviewer `author_association`, commit
  signature. §7.3's strict grammar and `builder.founder.userId` are already this idea; S4's
  plan cites the evidence explicitly.
- **R15** — a **throttle** beside the concurrency limiter. GitHub's own guidance: mutative
  requests serially, at least one second between POST/PATCH/PUT/DELETE, honour `retry-after`,
  `x-ratelimit-reset`, `x-poll-interval`. §10.4's scheduler is a slot counter and implements
  none of these; this is a second primitive over the same table.
- **R16** — GitHub has no idempotency keys. Write *at-least-once with idempotent consumers*
  into the docs as a **decided property** so nobody "fixes" it later. `enqueueEffect`'s own
  comment already records the sharper version: a restore rolls back the local proof, so only
  asking GitHub can close it.
- **R17** — **lineage** on outbox rows: which observed results justify this effect, not only
  the idempotency key. reeve's rows carry `fence`, which is half of lineage. The other half
  answers "what did it believe when it decided to", which is the question after a bad comment
  goes out.
- **R18** — a Planning Critic before the spec-PR gate, read-only toolset. S3 already has an
  adversarial-critic subagent at `deep` depth whose findings are input, never a gate; S4 is
  where that pattern may become a gate at SPEC_DRAFT → SPEC_PR_OPEN.

---

### A.3 S5 — Ledger hardening, then ledger intake

**Switch:** `builder.intake.ledger.enabled`, turned on **separately** from the stage.
**Design line:** `:830`. **Depends on:** S4.

**Scope, verbatim:**

> **S5. Ledger hardening, then ledger intake** (`builder.intake.ledger.enabled` on, separately). First, in nextly-ops: event ids, operation ids, `--json`, conditional CAS, fsync, narrow sync, the dedicated clone, the `wx` lock. Then, in reeve: the §2.4 protocol, ownership re-verification, write-back, orphan sweep, the research-gate measurement.

**Verify, verbatim:**

> *Verify:* local race, remote rebase race, crash-after-append replay, and duplicate-operation replay each yield exactly one owner; human-wins-after-reeve leaves the human; doctor refuses to enable intake without the typed CLI.

**Note for the planner.** This is the only stage whose first half lands in a **different
repository** (`nextly-ops`). Its plan family must name the target repo in the
`**Architecture:**` line of each document, and its tracker must carry the repo beside every PR
number — `#N` already overloads three namespaces in this programme's history (measured: 8 of
25 sites), and adding a fourth repository to that ambiguity is how a row stops being
resolvable at all.

---

### A.4 S6 — Local implementation, controller acceptance, controller commit

**Switch:** `builder.capabilities.implementLocal`. **Design line:** `:832`. **Depends on:** S5.

**Scope, verbatim:**

> **S6. Local implementation, controller acceptance, controller commit** (`implement-local` on). Per-slice worktrees, spec materialization at the approved SHA, territory and weighted budget with the atomicity exception, `gateDefinitionPaths` hashed at base, the controller-run gate wrapper and `gate_run` rows, the controller commit. No push.

**Verify, verbatim:**

> *Verify:* territory-violation, over-budget, and harness-touch refusals; approved bytes win over a stale local design; real tasks run to accepted local commits and are **compared against human review outcomes** on the same diffs.

**Inherited obligation.** S3 provisions `gateDefinitionPaths` in the registry as a placeholder
(founder decision D10). S6 is the stage that hashes it **at the approved base**, and therefore
the stage that replaces S3's value by design. An S6 planner who finds an S3-era value must
treat it as a placeholder, not as configuration to preserve.

---

### A.5 S7 — PR publication and guardian receipt import

**Switch:** `builder.capabilities.publishPr`. **Design line:** `:834`. **Depends on:** S6.

**Scope, verbatim:**

> **S7. PR publication and guardian receipt import** (`publish-pr` on). App-token push and PR create through the hub outbox from the automation clone, attested_push, the one-tx impl_pr write, `guardian_event` in the guardian schema, the receipt importer with git verification, VERDICT_WAIT poller with staleness and liveness escalations.

**Verify, verbatim:**

> *Verify:* a builder PR survives a guardian FIX_CI repair with the chain intact; a withheld import reads UNKNOWN; a foreign commit blocks; duplicate receipt delivery is inert; extend `dispatch-e2e`.

**Known drift the S7 planner must reconcile before writing.** The design specifies
`impl_pr(…, PRIMARY KEY(task,generation,slice), UNIQUE(repo_id,pr))` (`:642`). The code
**dropped** `impl_pr` and replaced it with `task_pr(PRIMARY KEY (repo_id, pr))`
(`src/build/hubdb.mjs:135`, `:100-113`), and §11.4's restore comparison set still names
`impl_pr` (`:725`). This is measured contradiction C1 (§B.11). S7 is where it stops being a
reading hazard and becomes work.

---

### A.6 S8 — The dark merge coordinator

**Switch:** the merge code lands with `builder.capabilities.mergeBuilderPr = false` and **no**
`--actuate-merges`. **Design line:** `:836`. **Depends on:** S7 **and on an event outside this
programme.**

**Scope, verbatim:**

> **S8. The dark merge coordinator, on top of the guardian programme's server flip.** **Dependency, not work**: S8 depends on the guardian programme's capability-4 flip having happened, the founder decision after the verdict shadow week (TRACKER Programme 1) that makes the App-bound `ops/merge-policy` check required on nextly's `protect-main`. This programme never flips that ruleset; the ordinary-PR false-block rate the flip risks is Programme 1's shadow-week question. The only ruleset this programme configures is the disposable canary repository's (`builder.canaryRepo`), which mirrors the flip for the probe. Record the code-owner policy decision (§16 default: retained); land the hub merge coordinator, `merge_decision`, the pre-flight with the VERDICT_WAIT guard (§9.5), the per-tick `repo_gate_state` refresh, the `pr_hold` writes on hold and cancel with the guardian's read-only verdict clause (§9.6, a guardian-shared PR), and `gh.pr.merge` wiring with `builder.capabilities.mergeBuilderPr=false` and no `--actuate-merges`.

**Verify, verbatim:**

> *Verify:* full clause matrix with each witness falsified individually; **live negative merge probes** from `doctor --probe-live` on the canary repo (no check at H, then a failing check doctor itself publishes on the canary only, both refused by GitHub, both recorded as evidence; the canary is watched by no guardian and bound to no task; a probe that merges writes the HALT marker); the §9.6 cancel-versus-in-flight matrix; ruleset drift on the canary shows in the next tick's `repo_gate_state` and stops merges; until nextly's flip has happened, U4 reads UNKNOWN for nextly and doctor reports "unsafe authority"; every evaluation writes a decision row that `why` replays.

**The one stage whose start is not this programme's to schedule.** Everything else in the
roadmap is gated on the previous stage's Verify clause. S8 is additionally gated on a founder
decision in *another* programme. The S8 tracker row must carry that dependency in its STATE,
and nobody may read "S7 green" as "S8 startable."

---

### A.7 S9 — Shadow, chaos, and replayable evaluation

**Switch:** none. **Design line:** `:838`. **Depends on:** S8.

**Scope, verbatim:**

> **S9. Shadow, chaos, and replayable evaluation.** Replay historical PRs and synthetic adversarial cases through the coordinator in shadow. Required cases: stale head, stale approval, cancel after merge lease, founder event after enqueue, missing guardian import, duplicate outbox delivery, GitHub 429, process kill at each effect boundary, full disk, corrupt artifact, invalid silently-ignored settings, App token expiry, ruleset drift, ledger rebase conflict.

**Verify, verbatim:**

> *Verify:* the **false-merge count in the corpus is exactly zero, computed over `witness_outcome`** (§9.3 shadow scoring; `actuation_outcome` is UNKNOWN by design while the switches are off, so a metric over it would prove nothing); false blocks and recovery time are reported separately; guardian tick latency measured unchanged while the builder runs, in both the loaded-machine and the quota-exhausted trial.

**Carried into S9 by decision:**

- **R24** — a private replay eval gating prompt and policy changes, assembled from reeve's own
  history: past red-CI shapes, past review threads, past verdict inputs, storing the expected
  verdict, the expected escalation decision, **and the expected tool-call sequence**. At n=1
  this is the only credible substitute for a public benchmark.
- **R25** — measure **durable outcomes**, not activity: the fraction of dispatched fixes that
  merge *and survive 30 days*, human correction effort per accepted fix, escalation precision
  and recall, cost per durable outcome. Explicitly do **not** track runs started, PRs touched,
  or tokens consumed. And do not accept a felt sense of speedup: METR measured a **39-point
  gap** between forecast (+24%) and measured (−19%) — cited as directional only, because
  METR's own 2026 follow-up withdrew confidence in that study's design.

---

### A.8 S10 — Supervised canaries and progressive enablement

**Switch:** `builder.capabilities.mergeBuilderPr` **plus** `--actuate-merges` in the generated
service definition. **Design line:** `:840`. **Depends on:** S9 **and the 21-item go-live gate.**

**Scope, verbatim:**

> **S10. Supervised canaries and progressive enablement.** One founder-filed XS task end to end with human implementation approval retained, then one ledger task; observe notification delivery, the spec gate, guardian repair, the required check, and merge refusal and approval live, with the founder watching. `merge-builder-pr` (`builder.capabilities.mergeBuilderPr` plus `--actuate-merges` in the generated service definition) turns on only after the negative server probe and every item of the go-live gate below passes. Ordinary-PR auto-merge is not enabled as part of this programme.

**The go-live gate is 21 binary items at `docs/2026-08-21-builder-design.md:842-864`.** It is
**not reproduced here**, deliberately: a second copy of a 21-item checklist is a second
inventory, and this programme has measured what second inventories cost (§B.11, W2). The S10
tracker carries one row per item with a link to its evidence, and the design file is the list.

**Carried into S10 by decision:**

- **R22** — progressive autonomy is **per action-class**, not per agent, with a written
  promotion rule and automatic demotion. Meta's RADAR: 535K+ diffs, 60.31% auto-approve, revert
  rate 1/3 and incident rate 1/50 of non-RADAR diffs; widening the human envelope P25→P50
  raised yield *while safety outcomes remained stable* — the initial threshold was
  over-conservative and only measurement revealed it. This is the strongest external
  corroboration of §14's staged-switch design, and S10's gate should cite it.
- **R23** — **land delay.** RADAR's cheapest safeguard: approved diffs land after a
  configurable delay allowing human override. reeve has no equivalent; it converts an
  irreversible-feeling action into a cancellable one at near-zero cost.

---

### A.9 S11 — Ubuntu parity

**Switch:** none; the per-platform matrix is fail-closed. **Design line:** `:866`. **Depends on:** S10.

**Scope, verbatim:**

> **S11. Ubuntu parity** (founder ruling of 2026-08-21, Platforms). Everything through S10 is proven on macOS only; S11 makes Ubuntu a supported host. Work: the bubblewrap row of the Platforms matrix (the sandbox canary of §4.4 passing under bubblewrap with fail-if-unavailable and no unsandboxed fallback), the generated systemd user unit for both daemons with the singleton lease refusing a second instance, `notify-send` delivery with a confirmed `notice_receipt`, POSIX group kill re-measured on Linux (`ps` lstart format differs and is asserted by a fixture), `os.homedir()` paths asserted by doctor, and a local off-device backup destination. **reeve's own CI runs the full suite on macOS, Ubuntu, and Windows from this stage on** (Windows failures are recorded, not yet gating, until S12; a non-gating CI lane relaxes nothing on a Windows host, where the Platforms matrix still refuses every dispatch until the canary passes).

**Verify, verbatim:**

> *Verify:* the same canaries as S1 through S10 (sandbox escape test, settings validation, lease-loss kill, adopt-or-kill, notice receipt, negative merge probe against the canary repo) pass on an Ubuntu host; the full suite is green on Ubuntu CI; doctor on Ubuntu reports every matrix row as measured, none as unsafe authority. Until S11 lands, doctor on an Ubuntu host refuses write-capable dispatch by the fail-closed matrix.

---

### A.10 S12 — Windows parity

**Switch:** none; the per-platform matrix is fail-closed. **Design line:** `:868`. **Depends on:** S11.

**Scope, verbatim:**

> **S12. Windows parity** (same ruling). Work: **measure** a process group kill on Windows (a job object, or `taskkill /T` against the recorded pid, with pid reuse guarded by the recorded start time) and record the result in the Platforms matrix; measure whether the coding CLI's native sandbox is available on Windows and, if it is not, keep **every** dispatch refused there (read-only phases included, exactly as the Platforms matrix states: nothing launches on a host whose canary does not pass); the generated Task Scheduler definition for both daemons; Windows toast delivery with a confirmed `notice_receipt`; path handling (`os.homedir()`, separators, long paths) asserted by doctor; the `wx` lock files and lease rows re-tested for atomicity on NTFS.

> **Transcription note.** The design's own sentence names the CLI vendor where this file writes
> "the coding CLI". Everything else in the quotation is byte-for-byte; read the design line for
> the original phrasing. This is the single place in Part A where a quotation is not literal,
> and it is flagged here rather than left for a reader to discover.

**Verify, verbatim:**

> *Verify:* the same canaries and the full suite on Windows CI, now gating; doctor on Windows reports each matrix row's measured result; any row still unmeasured stays **refused** for the capabilities that depend on it, and the stage is not complete while a write-capable row is unmeasured.

**Decided in S3, spent in S12 (R19).** `ps -o lstart=` is POSIX-only. Windows has no `ps`, and
process creation time must come from `Process.StartTime`/WMI. Without it the pid-reuse guard
**silently degrades to pid-only** — a degradation that reads as working. S3 writes
`phase_run.pid` and `phase_run.lstart` for the first time, so the **column shape is decided at
S3**, and until S12 measures it the platform matrix records the Windows row as unmeasured and
refuses.

---

## Part B — How to write a stage plan

Every rule below is followed by the measurement that produced it. A rule with no measurement
is not in this file.

### B.0 The corpus these rules come from

MEASURED over 40 merged PRs, 1,282 review threads and 273 review rounds, on 2026-08-27:

| finding | number |
|---|---|
| `changedFiles → findings` correlation | **r = 0.067, ρ = 0.178.** Files predict nothing. |
| `changedLines → findings` correlation | **ρ = 0.790** overall, **0.825** on code-only PRs. Lines predict well. |
| Finding density by artifact kind | `.md` **654/1282 = 51.0%**; `src`/`bin` 561 (43.8%); `test` 67 (5.2%) |
| The three S2 **plan** PRs (#11, #12, #13 — 14 files, all Markdown) | **561 findings — 43.8% of every finding review has ever produced in this repo** |
| The decisive pair | **PR#12 = 1 file, +3,994 lines, 213 findings, 15 rounds.** **PR#20 = 30 files, +8,022/−100 lines, 26 findings, 6 rounds.** |
| Median finding density | 11.0 per 1k changed lines. Docs/plan PRs run **46–70/1k**; #20 ran **3.2/1k**. |
| Worst convergence | **#44 — 29 files / 4,470 lines / 66 findings / 15 rounds / no taper** (rounds 10-12: 5, 3, 5). The PR that touched the running guardian's tick. |
| Merge discipline | **15 of 40** ended on a clean verdict; **25 merged with findings still open.** |

### B.1 Task and PR sizing

1. **Budget changed LINES, not files.** Target **≤ 1,200 changed lines** per code PR; hard stop
   at 2,000. #20 proves 30 files is fine at 3.2 findings/1k when the design is settled first.
2. **A plan document is reviewed as code, at roughly five times the density.** Split a stage
   across a family rather than writing one 6,000-line stage plan: that is precisely the
   artifact measured at 213 findings on a single file. The S2 family exists because a
   5,300-line single document was retired after four rounds found 54 defects, *"a majority of
   them caused by the previous round's own fixes: an edit in a document that large cannot see
   its neighbourhood."*

   **The unit of the cap is TASKS, not lines — corrected 2026-08-27, on measurement.** The
   original rule read *"cap each document at ~1,200 lines"*, and it was computed against the
   wrong denominator: S3's **16 PRs**, when a PR decomposes into three to five *plan tasks*
   and the house style runs **~500 lines per plan task** (MEASURED: S2-A is 6,328 lines over
   13 tasks = 487; S2-C is 2,724 over 5 = 545). At that rate ~1,200 lines buys **two to three
   tasks**, not the eight to twelve a three-or-four-PR document actually contains. Written
   against the line number, the S3 family came out at 1,677–1,957 lines per document, and
   **every one of those lines is house-style content, not padding.**

   **So the rule is: at most three or four plan tasks per document, and never thin a task to
   fit a line count.** The lever is *fewer tasks per document*; it is never *shorter tasks*.
   Thinning the controls is the failure mode this repository has actually measured — the
   worst-converging PR in the corpus took 66 findings over 15 rounds with no taper, and every
   one of them was a control that was not there. A document that needs 1,900 lines to carry
   eleven tasks honestly is correct at 1,900 lines; a document that carries eleven tasks in
   1,200 has removed something.
3. **Isolate every guardian-touching change into its own smallest possible PR.** The two
   worst-converging PRs in the corpus (#44 and #3) both changed the running guardian.
4. **The taper rule** (founder, 2026-08-26): **ten rounds without the findings tapering means
   stop and bring the shape, not the next fix.** Split; do not push an eleventh round.
5. **A task is one commit**, and it is the smallest unit that carries its own test cycle and is
   worth a fresh reviewer's gate. Fold setup, configuration and documentation into the task
   whose deliverable needs them. Split only where a reviewer could reject one task while
   approving its neighbour.

### B.2 Where plans live, and what they are called

**MEASURED, 5/5 existing files:** `docs/superpowers/plans/YYYY-MM-DD-<stage-slug>.md`, date =
authoring date, slug = stage id plus subject. That directory holds exactly five files and no
subdirectories, and only four are plans — `2026-08-23-s2-review-history.md` is a companion
artifact with zero `### Task` and zero `**Files:**` headings. **Do not copy its shape.**

**This programme's own planning documents** — this file, the trackers, the implementation
prompt, the design brief — live under **`tasks/reeve-tasks/`**, and the stage plans under
`tasks/reeve-tasks/plans/`, so a stage's plan family, its tracker and its claims version
together with the code they describe. Both locations are the same repository.

### B.3 The header block

Lines 1–23 of S2-A/B/C are **byte-identical except lines 1, 5, 7, 11 and 21**; line 3 is
byte-identical across all four existing plans. Reproduce it exactly:

```markdown
# <STAGE-ID>: <Title Case Subject>, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** <one sentence, the end state as a property, not a task list>

**Architecture:** <how many PRs, against which repo and branch, what each adds or changes by filename, then a bolded NEGATIVE scope claim>

**Tech Stack:** Node `~/.nvm/versions/node/v24.17.0/bin/node` (PATH node is v22 and `node:sqlite` warns there), `node:sqlite` `DatabaseSync`, plain-script tests under `test/*.test.mjs` (CI runs every file in that glob on ubuntu-latest under three TZs), no dependencies added.

**Spec:** `docs/2026-08-21-builder-design.md` — §14 <stage> is the stage definition and its *Verify:* clause is the definition of done. The sections that bind this plan: §x.y (…), §x.y (…).

**This is one of <n> plans for <STAGE>.** <why it is split, with the measured reason>

| plan | scope |
|---|---|
| `<file>.md` | <one line> |

Their review history — every finding and what each changed — is `<stage>-review-history.md`. **Order matters:** A lands before B, B before C. <this plan's position>

---
```

The **negative scope claim** in `**Architecture:**` is not decoration. S2-A's is *"Nothing here
reads or writes GitHub, and no worker is dispatched."* It is the sentence a reviewer checks the
diff against, and it is what makes an out-of-scope addition visible rather than merely
unmentioned.

Omit the family block when a plan is standalone: `2026-08-21-s1-worker-contract.md:1-12` runs
header straight into `## Global Constraints` at line 13.

### B.4 Sections, in fixed order

| # | heading | required |
|---|---|---|
| 1 | `## What this plan consumes from <prior plans>` (h2, table `\| from \| name \| shape \|`) | every non-first plan in a family |
| 1b | `### Line references in this plan` | mandatory from S3 on (S2-C introduced it) |
| 2 | `## Global Constraints` | always |
| 2a | `### Isolation while this plan is being written or executed` | always |
| 2b | `### What <prior stage> measured, which changes how these tests are written` (table) | always |
| 2c | `### Decisions taken by the founder for this stage, <date>` (numbered) | always |
| 3 | `## The test harness every file in this plan opens with` | always |
| 4 | `## File structure` (two-column `\| File \| Responsibility after this plan \|`, `(new)`/`(PR-A)` inline) | always |
| 5 | `# PR-<n>: <name>` (h1) + `**Branch:** …  **Scope:** …` | one per PR |
| 6 | `### Task N: <a claim about behaviour>` (h3) × N | |
| 7 | `## Self-review` (last, preceded by `---` `---`) | always |

**Not present in any existing plan, and must not be added:** a Risks section, a Rollback
section, a Timeline section, an Open Questions section. Those live in the **tracker**. A plan
that carries open questions is a plan an executor can start before the questions are answered.

### B.5 The consumed-interfaces table

Every non-first plan in a family opens with it. The opener is verbatim in substance:

> <PRIOR> must be merged first. These are the exact names this plan builds on; **if any has changed, stop and reconcile rather than adapting the code here.**

…and it closes with a bolded obligations paragraph beginning
`**The obligation this plan exists to discharge.**`

**Three columns: `| from | name | shape |`.** The `shape` column carries the real signature,
not a description of it. The reason is measured: S2-C's own table records that `pr_hold`
shipped with a guest-allowlist entry for **two rounds** before anyone noticed nothing queried
it — *"permission to read is not a reader."* A shape column reading "the hold table" cannot
surface that. One reading `openPrs(db, taskId, {kind}) -> rows` can.

**And `### Line references in this plan`**, verbatim in substance:

> Every reference to `<file>` names the **anchor text to search for** first and a line number second, with the commit it was true at.

Measured reason: line numbers in `src/daemon.mjs` moved twice *during* S2-C's own review, and
moved again on 2026-08-27 when #49 merged (`tick()` from `:956` to `:975`; `announceable` from
`:3217` to `:3236`; the three `claimProvider` sites from `:2053,:2115,:2302` to
`:2072,:2134,:2321`). **A plan that sends an executor to a line number which has since moved is
worse than one that sends them to a string: the string is still there.**

### B.6 The task template

```markdown
### Task <N>: <a claim about behaviour — "Spawn binding fails closed", never "Implement X">

**Files:**
- Create: `path/a.mjs`, `path/b.json`
- Modify: `path/c.mjs` (`functionName`; the block after `<searchable anchor>`)
- Test: `test/x.test.mjs` (append before the terminator)

**Interfaces:**
- Consumes: `symbol`, `symbol` (Task N / PR-A).
- Produces: `fn(args) -> ReturnShape` — <prose contract>. <who downstream reads it>

- [ ] **Step 1: Write the failing test**

<runnable code block>

- [ ] **Step 2: Run it and watch it fail**

Run: `$N test/x.test.mjs`
Expected: <the literal failure text>

**On the broken implementation** — <the specific wrong implementation being guarded against> — <which named assertions go red, and which stay green because they are controls>.

**The stub loop for this task**: <control green → stub verified applied → the RIGHT assertion red → restore verified by file copy>.

- [ ] **Step 3: Implement <module>**

<code block, in the comment style of the file it lands in>

- [ ] **Step 4: Run it, then commit**

<the full-suite loop, then explicit `git add` paths, then a conventional commit>

---
```

MEASURED conventions:

- **A task title is a claim about behaviour.** "Spawn binding fails closed", not "Implement
  spawn binding". A title that names a module cannot be false; a title that states a property
  can be, and is therefore reviewable.
- **`**On the broken implementation**` appears 19 times across S2-A/B/C — one per non-close-out
  task, and zero in S1.** It is the newer discipline and it is **mandatory**.
- **`**Interfaces:**` is absent from every close-out task.** That is convention, not omission.
- **`Consumes:` on every non-close-out task.** MEASURED: S1 has 2 `Consumes:` against 12
  `Produces:`; S2-A/B/C carry it on every non-close-out task. Consumes-on-every-task is the
  newer discipline.
- Median **four to five steps** per task; late plans collapse steps 2–4 into one
  *run it red, implement, run green, commit*.
- **"Append to `test/x.test.mjs`" always means "insert before that file's terminator."** Every
  test file in this repository ends with a cleanup line and `process.exit(fail ? 1 : 0)`. A
  block pasted after `process.exit` never runs **and the file still reports green** — the worst
  available outcome, because it is indistinguishable from a passing test. Name the terminator
  in the step.

### B.7 Verify, controls, and the stub loop

1. **The spec is the definition of done; a plan never restates the Verify criteria in its own
   words.** Every plan's `**Spec:**` line cites §14's clause. MEASURED 4/4.
2. **One Verify table per stage family, in the FIRST document, re-walked by the LAST.** Shaped
   `| Verify item | Where it is proven |`, where the value is `Task N, <test file>, <named
   assertion block>`. MEASURED: the table exists only at
   `2026-08-23-s2b-phase-machine.md:4365` — **S2-A has none, so a reader of S2-A alone cannot
   find the stage's acceptance criteria at all.** That is the defect this rule closes.
3. **A Verify row is never marked satisfied by a test name alone.** It names a file that exists
   and is green. Naming a property is not covering it.
4. **Every non-close-out task names its stub explicitly.** MEASURED drift to fix: all three S2
   plans promise *"Every task below names the stub explicitly"* and **S2-B contains the word
   `stub` exactly once — in that very bullet.** S2-C's other seven hits are about fixtures.
   Only S2-A kept the promise. **Make the promise a step, or delete the promise.**
5. **The four-check stub loop, and it is four checks, not three:** control green → stub verified
   *applied* → the **right** assertion red → restore verified **by file copy, never
   `git checkout`**. `git checkout` restores to the last *commit*, silently discarding
   uncommitted work; this has cost real lines in this repository.
6. ***A stub that produces no failures means the property is UNTESTED.*** Not "the code is
   right".
7. **Every absence claim carries a positive control**, and any claim about a set prints a
   **count** before any listing. **Never `| head` a search you will reason about as a set.**
8. **Executable fixtures inside a plan are reviewed as code.** The largest single finding shape
   in the corpus is *"the snippet is not runnable as written"* — 176 findings, **137 of them
   inside `.md` files** — because no linter can see code in a Markdown fence.
9. **A fixture that cannot exhibit the defect proves nothing.** A worker that exits immediately
   cannot test adoption. State what each load-bearing fixture can and cannot exhibit.

### B.8 Four conventions that drifted, now settled by ruling

Each had two or three forms in the existing corpus. They are settled here so the next family
does not inherit the drift.

| # | Convention | Ruling |
|---|---|---|
| 1 | **Task numbering** | **Restart at 1 in each document**, and prefix in cross-references (`S3-C Task 2`). S2's continuity across a family (A 1–13, B 14–20, C 21–24) is a **residue of the retired single document**, not a designed property, and it forces a renumber whenever a document is split. A review-inserted task keeps its neighbour's number with a letter suffix (S2-C's `23b`); that part is kept. |
| 2 | **Harness shorthand** | **One vocabulary: `/* ... standard harness ... */`**, with any additions named explicitly afterwards in the task's own words. MEASURED: three vocabularies exist today. |
| 3 | **A corrected founder decision** | **Back-patch it into every plan that states it, in the same commit.** MEASURED: founder decision 2 appears three ways across S2; S2-C corrected the escalation identity and **A and B were never back-patched**. |
| 4 | **Where the Verify table lives** | First document of the family; last document re-walks it (§B.7.2). |

### B.9 The close-out task

**One per PR, always last.** Title form:
`### Task <N>: PR-<x> close-out — <what it freezes>, tracker, PR`.

Contents, in this order, and the order is itself the rule:

1. **Whatever this PR freezes** (a migration hash, a schema fixture, an API surface), with the
   stub loop run **once per half** of whatever is frozen. A freeze verified only against the
   half it already covered proves nothing about the half that was added.
2. **The full-suite loop with the `fail=0` accumulator**, carrying its four-line explanation of
   why `|| echo` is a false green, and ending
   `[ "$fail" -eq 0 ] || { echo "the suite is RED; do not commit"; exit 1; }`.
3. **The tracker line, as the LAST commit.** The tracker conflicts on every branch; one line
   added last makes the conflict trivial. The line says **BUILT**, never MERGED — this commit
   precedes the PR, and merging needs a founder grant, so a MERGED written here claims delivery
   of an unmerged review branch and would incorrectly unblock ordered downstream work.
4. `gh pr create --body-file - <<'BODY' … BODY` with `## What` / `## Decisions taken in this
   PR` / `## Review focus`.
5. `gh pr comment --body "@codex review"`.
6. Verbatim: **`**Do not merge.** Founder grant required.`**

**On merging, which is not the plan's decision.** reeve's own PRs merge only on the founder's
explicit **per-PR** grant. Grants never carry over. CI and threads are re-verified **at the
moment of merge**, and a merge is verified **by CONTENT — compare tree hashes or file blobs —
never by ancestry**, because this repo squash-merges and a branch commit is never an ancestor
of `main`.

**Recorded, not recommended:** every commercial system surveyed keeps merge with a human, and
this programme's measured consequence of the "CI green AND zero open threads" rule is that
**25 of 40 PRs merged with the last verdict still carrying findings**, 47 threads open at
merge, four of those with no reply and no deferral record. The founder reaffirmed the rule on
2026-08-25. It is settled. It is written down here so it stays a decision rather than becoming
an assumption.

### B.10 `## Self-review` — the last section

Three bolded lead-ins, **in this order, always**: **Spec coverage.** / **Placeholder scan.** /
**Type consistency.** Plus zero to two plan-specific paragraphs.

Where the plan carries a known deficit, **state it plainly**;
`2026-08-21-s1-worker-contract.md:1509` is the model. S2-A's self-review is the other model: it
corrects a claim an earlier draft of that *same self-review* had made — *"the kind of claim a
reader believes without checking."*

**No placeholders anywhere.** These are plan failures, not style notes: `TBD`, `TODO`,
"implement later", "add appropriate error handling", "handle edge cases", "write tests for the
above" without the test code, "similar to Task N" without repeating the code (an executor may
read tasks out of order), and any reference to a type or function that no task defines.

### B.11 The reading hazards every stage plan inherits

Seven measured contradictions between `docs/2026-08-21-builder-design.md` and what the code
actually does. **They are not work; they are traps for a planner who quotes the design.** A
plan that quotes §11.5's *"Reused untouched: `worktree.mjs`"* sends an executor after a file
that does not exist. Carry the rows your stage touches into that family's
`### Decisions taken by the founder for this stage` block.

| # | design says | code does | stage that closes it |
|---|---|---|---|
| C1 | `impl_pr(… PRIMARY KEY(task,generation,slice), UNIQUE(repo_id,pr))` (`:642`) | `hubdb.mjs:135` **drops** `impl_pr`; `task_pr` replaces it with `PRIMARY KEY (repo_id, pr)`. §11.4's comparison set still names `impl_pr` (`:725`) | **S7** |
| C3 | *"the territory pin lives on `territory_lease.pinned_until` only; task carries no copy"* (`:599`) | `task_territory.pinned` and `pinned_until` exist; `territory_lease.pinned_until`'s comment still reads *"the ONLY home of the pin"* — now false | S3 reads it |
| C4 | *"The guardian's hub surface is exactly two touches"* (`:40`, `:718`, `:807`) | `hubguest.mjs:29-37` has **three**: `maintenance_lock: ["read","delete"]`, deliberately. The test's own first line still says *"exactly two touches"* | S3 reads it |
| C5 | *"**HOME is not isolated, on purpose.** … No API key variable is passed"* (`:302`) | `workerenv.mjs` throws without a `home`, throws if `home === homedir()`, and **requires** an OAuth token. The design's posture is refused by code, because the keychain was measured readable from inside the sandbox | **S3 T7** |
| C6 | §11.5 lists the intended `profile/schema.mjs` additions (`:731`) | `worker.isolation` and `worker.dependencyPaths` exist and the design names neither | **S3 T1** |
| C7 | *"Reused untouched: `worktree.mjs`"* (`:731`), *"via the existing `acquireWorktree`"* (`:443`) | **Neither exists.** `src/checkout.mjs` replaced them; `src/build/tables.mjs:63` still declares `directory_lease: { writer: "worktree.mjs" }` | **S3 T9** |
| C8 | *"the 7-clause worst-wins verdict"* (`:473,:500,:533,:804`) | `verdict.mjs` — **nine** ids | guardian lane |

Two structural hazards belong beside them:

- **W2 — second inventories.** `TABLES_AT`, `COLUMNS_AT`, `SCHEDULER_COLUMNS`, `HOLD_COLUMNS`
  and `LOCK_COLUMNS` are hand-maintained restatements of the migrations, and they gate **every**
  guardian tick's hub open. `columnDefectsAt` returns `[]` when the version is absent — no loud
  guard, unlike `HUB_TABLES`'s module-load throw. **Issue #43** is exactly this. **A stage that
  adds a column owes three inventory entries; a stage that adds none owes nothing.**
- **W6 — the raw-SQL rule is true of one file and false of twelve.** `src/provider.mjs:9-13`
  states *"the two directories allowed to contain raw SQL"* (`src/db/`, `src/build/`).
  MEASURED at `16cd880`: **12 paths violate it with 102 `.prepare()` calls** (98 at
  `c500cfe` — `src/review/derive.mjs` grew 16 → 19 when reeve#49 merged, so **the violation is
  growing**), and the guard that exists (with a proper positive control) checks **exactly one
  file**. **Do not add a thirteenth.**
  New statements go in `src/build/`; widening the guard is a separate cleanup.

### B.12 The tracker, and what belongs there instead of in the plan

Full format in `trackers/MASTER.md` and `trackers/s3.md`. The division:

| goes in the **plan** | goes in the **tracker** |
|---|---|
| what to build, and the failing test that proves it | what got built, and what review found |
| the consumed interfaces, with shapes | which PR is open, and its STATE |
| the stub each task must run | the defect log, one row per finding **class** |
| the spec clauses that bind the stage | open questions the founder has not answered |
| decisions **already taken**, so no executor re-litigates | decisions **taken during** the stage, with dates |
| — | risks, rollback, timeline |

**The rule that fixes the measured 50% defect: the tracker's STATE column is a projection of
`git log`, not a memory.** MEASURED on `docs/TRACKER.md` (1,205 lines): `[x]` is reliable
(15/15 correct) but `[ ]` is not — **10 of 20 unchecked boxes sit on work already merged** —
because the tracker is edited by the PR that builds the work and **never again after the
merge**. The per-stage tracker therefore uses a four-word STATE field and carries the command
that re-derives it in its own header. A row whose STATE says BUILT and whose PR appears in
`git log --format='%s' | grep '(#'` is stale: fix the row, do not argue with git.

**And the corollary that keeps SHAs usable:** the only SHA a tracker row carries is the
**squash SHA on `main`**. MEASURED: **13 of 18** SHAs recorded on the old tracker are
unreachable from HEAD, because per-round fix SHAs die with the branch.

### B.13 The measured document

Any stage whose Verify clause contains the word **measure** owes one file per measurement under
`docs/measured/`, in the format at `S3-DESIGN-BRIEF.md` §3.3. The structural rule that matters
most:

**Every measured document ends with `## What this does NOT establish`, and it is MANDATORY.**
MEASURED across all 21 existing files: eight carry an explicit limits section by name, and none
of the remaining thirteen omit the limits — they inline them. The section names the population
the measurement does not cover, the second call site a reader must not infer from the first,
any figure that is **withdrawn** and why, and the hypothesis the experiment was built to find
and did **not** observe.

Beside it, five rules every one of the 21 observes, and which a new one must:

- a **COUNT**, never a `head`-ed listing, wherever the claim is about a set;
- a **positive control** beside every absence;
- an **unsandboxed / BEFORE row**, so the fixture is shown to be able to exhibit the shape;
- credentials reported as **booleans, exit codes or lengths** — never the value — and say that
  you did this;
- **which** `git`, **which** `grep`, **which** shell, when it decides the answer.

A correction goes at the **top**, as `> **CORRECTED <date>.**`, states the smaller claim, shows
the probe that found it, and ends by saying what below still survives and is load-bearing.
Later rounds are appended as new sections **with their provenance, never by editing the earlier
text into agreement.**

---

## Appendix — the sequence for a new stage, end to end

1. **Read the design's §14 clause for the stage.** Copy the scope and *Verify:* text verbatim
   into Part A of this file, and split the Verify clause into numbered obligations.
2. **Measure what the stage inherits** from the previous one: every symbol, signature and
   `file:line` it will consume, with the anchor string beside each number and the sha they were
   true at. This becomes the consumed-interfaces table, and it is the single most expensive
   thing to get wrong.
3. **Decompose into tasks**, each one PR, each budgeted in changed **lines**, each with a
   dependency and a Verify criterion. Guardian-touching tasks travel alone.
4. **Ask the founder the questions the decomposition surfaced**, in the required shape:
   plain-English context → options with plain-English pros and cons and a concrete example in
   this codebase → an honest recommendation with reasoning → one clear line stating what needs
   deciding. Record the answers in the stage tracker §4 before writing any plan.
5. **Write the plan family**, at most ~1,200 lines per document, in dependency order, all from
   one style reference so the family does not drift.
6. **Create the stage tracker** from the template, with the Verify table pre-seeded from step 1
   and every row naming the task that will satisfy it.
7. **Land the plan family**, then execute it task by task under the claim protocol in
   `IMPLEMENTATION-PROMPT.md`.
8. **Close the stage** only when every Verify row names a file that exists and is green — and,
   for a `measure` clause, a document under `docs/measured/` that carries its own
   *What this does NOT establish* section.
