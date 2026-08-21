# reeve Builder Programme: The Design (final)

**Status**: THE final design document for the builder programme. Revision of the synthesis (v1) after 29 adversarial findings, the founder's gate revision of 2026-08-21, and the founder's approval of the design as presented. Spec-writing is authorized against this document. Every finding's fix is folded into the section it belongs to; Appendix A maps each finding to its home.

**Settled requirements honored, not re-litigated**: Architecture A (per-task phase state machine in the existing daemon family, phases are bounded `claude` CLI workers through the existing supervisor/sandbox, fan-out only inside a phase via Claude's own subagents); dual intake (founder files plus ledger import); the spec-PR gate with the founder's revised rules (§7, encoded exactly); the depth dial, visible and overridable, with no gate skip at any depth; multi-task multi-project concurrency with leases; reeve merges on PASS with independent witnesses only; Rule 15.

**Standing invariants**: deterministic, durable, verifiable transitions; the model reasons only inside a phase; UNKNOWN never merges and absence is never success; escalation keys are identities, never reports; no optional safety parameter without same-commit call-site assertions (this design removes the parameter instead, §4); the actor is never the only witness; sandboxes restrict authority, network, and paths, never execution; nothing names reeve in a public or client repo; `claude` CLI on the founder's subscription, never the SDK.

**Post-synthesis code facts reflected here (on main as of 2026-08-21)**: `lanes[].sensitiveOk` (tool-layer deny lift by verbatim territory glob plus per-file diff-gate exemption scoped to the declaring lane; quarantine and self-governing unreachable by any declaration); `flakeAssessment()` wired at FIX_CI dispatch (wholly-flaky escalates on an identity key with no attempt spent, mixed dispatches with the flaky job named as noise); `ESCALATIONS.PROTECTION_UNMET` for merges GitHub refuses beyond the clauses; profile `measured.review.*` rendering the 500-PR study into worker prompts with criticals-first findings ordering.

---

## 0. What this buys the founder

- File a task in one line (`reeve task file`) or file nothing and let reeve import from the nextly-ops ledger.
- One thing to read per task: a plain-language spec PR in a **private** repo, with the sizing decision printed at the top and overridable by one comment. Every spec PR is reviewed by Codex until Codex finds nothing; then you get 15 minutes to approve, object, or say nothing. Silence after a Codex clean pass advances the task; silence without one never advances anything.
- One screen: `reeve dash` shows every task's state, what it is waiting on, and the single next action, from durable rows, never from a model's memory. UNKNOWN renders as UNKNOWN, never as quiet green.
- Notifications that name the one action needed: "spec PR nextly-ops#12 clean by Codex, 15 minutes before reeve proceeds; approve or comment to hold."
- Full audit: `reeve task why bt:x` replays who approved which SHA, which Codex clean pass covered it, which witnesses passed, and why a merge fired, the last from the merge decision row the merge executor writes for every evaluation (§9).

---

## 1. Topology: a second process, one hub store

The guardian's dispatch loop is serial and awaits workers inline; a 20-minute worker already freezes verdict publishing for every other PR (M1: daemon.mjs:430-441, `ctx.running` never set). A one-hour IMPLEMENTING phase inside that loop would blind the guardian for an hour. So the builder is **its own launchd job**, `com.revnix.reeve.builder` running `bin/reeve build run`, node pinned to `~/.nvm/versions/node/v24.17.0/bin/node` (PATH node is v22). Guardian daemons (one per watched repo, per-repo DBs) are untouched except for the merge executor (§9), which they gain behind a dark flag, and the shared sandbox containment fix (§4), which repairs a live hole they already have.

**Single instance, enforced**: `reeve build run` takes an exclusive flock on `~/.reeve/state/builder.lock` at startup and refuses to run without it. launchd's instance and a founder-run terminal instance can never tick hub.db simultaneously; the second invocation prints who holds the lock and exits.

**Stores.** (a) Per-repo guardian DBs: untouched except one additive table, `merge_decision` (§9, §11), owned and written solely by the guardian's merge executor; the builder reads these DBs read-only (same-host WAL permits this) and never writes them. Two builder reads matter by name: the quota derivation (§10) and the `reeve task why` merge-decision replay (§9). (b) **Hub DB** `~/.reeve/state/hub.db`: tasks, phase events, approvals, gate rows, attested pushes, directory and territory leases, quota ledger, builder outbox. Cross-project leases have no home in per-repo DBs (M1 §2); the profile schema already anticipates `state.mode: "hub"`. (c) The nextly-ops ledger (JSONL), written through its own CLI exactly as human lanes do. The guardian gains exactly two narrow hub touches, both inside the merge executor: read-only `mergeEligible` reads, and the witnessed attested-push append (§8), which flows through the guardian's own outbox.

**Project registry** `~/.reeve/projects.json`: `{name: {repoPath, nwo, profilePath, worktreeRoot, ledger?}}`. Required because repo is NOT a ledger field; the ledger name is the project (M3 §3), and profiles are per-repo. Every new profile key (all `builder.*` knobs) is added to the profile `FIELDS` validator **first**, or every daemon start dies at profile load (M1 §3).

**Determinism as code layout**: `src/build/phases.mjs` exports `nextPhase(state, evidence)` returning a transition or a refusal, pure and total, unit-tested over the full transition matrix, held-state exits included (§3.4). Illegal transitions are refused and logged (`transition.refused` events; absence is never success). The model reasons only inside a phase worker.

**Rule 15 as code, at the moment of effect, not only at boot.** The boot-time check remains as the fast path: at builder startup, query `builder.specRepo` visibility via the GitHub API; anything other than exactly `private` refuses to run, and UNKNOWN visibility is not private. But a long-running daemon cannot trust a Monday answer on Thursday, so the check that actually protects Rule 15 lives in the **outbox executor**: every effect targeting the spec repo (push, pr-create, comment, review-request) re-probes visibility (cached with a short TTL); anything but exactly `private` refuses the effect, moves the task to BLOCKED, and escalates `bt:<id>:spec:visibility`. A repo flipped public mid-operation stops reeve at the very next effect, not at the next restart.

**Rule-15 lint for public repos.** Spec hosting was only half the exposure: builder work also touches the public project repo (§8). A lint runs on every outbox effect whose target repo is not verified private: deny-pattern on the token `reeve` in branch names, PR titles and bodies, commit messages, and comments; the effect is refused on a hit. Branch and actor naming is neutral by construction (§8): impl branches use the `mp/` prefix (after the App's own neutral slug `merge-policy`), and the App author line reads `merge-policy[bot]`. `reeve builder doctor` asserts the App slug and branch templates contain no reeve token.

---

## 2. Task intake

### 2.1 Identity and dedup

- Task id `bt:<ulid>` minted by the hub. Provenance is a durable fact: founder-filed `{source:"founder", filed_via:"cli", text_hash}` or ledger import `{source:"ledger", ledger:"nextly", node_id:"task:x", claim_event_offset}`.
- `UNIQUE(source_kind, source_key)`: ledger node id for imports (collision is a hard refusal; the node is already owned), normalized-title sha256 for founder filings (collision is a warning plus `--anyway`; humans legitimately re-file near-twins). `--anyway` coexists with the constraint by salting: the re-filed task's `source_key` becomes `<title-hash>:<its own ulid>`, so the UNIQUE holds, the near-twin admits, and the provenance records that the collision was seen and accepted.

### 2.2 `reeve task file`

```
reeve task file --project nextly --title "..." --territory "packages/x/**" \
  [--body-file f.md] [--depth trivial|standard|deep] [--priority p1|p2]
```

One `BEGIN IMMEDIATE` tx: task row, `task.filed` event, **and the territory lease grant with the full intersection check** (§10); filing and import run the identical check and produce the identical refusal message. `--project` must resolve in the registry.

**Territory is REQUIRED at filing.** A filing without `--territory` is refused with a message showing the flag. An empty or unparseable territory, wherever one slips in, is treated as `**` (it conflicts with every lease in the project), never as no-claim: the absence of a territory claim must never read as the absence of conflict. Admission tests: a territory-less insert is refused; a `**` task blocks all concurrent grants in its project.

There is **no `--fast` flag and no gate skip of any kind** (§15.4): every task, however small, gets a spec PR; a trivial task just gets a short one. Pre-authorization at filing time binds to no head SHA, which is exactly the binding the gate exists to provide.

### 2.3 Ledger import and the claim protocol (hub row first, claim as an outbox effect)

`reeve task import [--ledger nextly] [--limit N] [--pick <node-id>]`, and the builder loop's auto-pick, share one function. The synthesis performed the ledger claim inline and inserted the hub row afterward; a crash between the two orphaned a claimed task forever, invisible to both humans and reeve. The ordering is therefore inverted to obey this design's own rule (side effects run only through the outbox, never inline):

1. **Candidate selection.** `ledger sync` in the LIVE clone `~/Work/Products/nextly-workspace/nextly-ops` (the nextly-integrations clone is dead and never touched). Candidates are unblocked plus unclaimed tasks (38 today, M3 §4), P1 bucket first, then `task:scout-*` (natural small work).
2. **Territory pre-check**: glob-intersection of the candidate's territory against every active hub lease and every currently claimed ledger task's territory. Overlap: skip, and record a durable `candidate.skipped(territory, blocking_task)` row in `intake_event` (§11; a skipped candidate was never admitted, so it has no task id for `phase_event` to hold) so starvation is visible in dash, never silent. Enforcement is reeve-side because ledger territory is advisory only; `claim` never checks it (M3 §1).
3. **Hub tx FIRST**: insert the task row in phase **CLAIMING**, with provenance, resolved copies of `{territory, body, research and decision refs}` from `DEPENDS_ON`/`DECIDED_BY` edges into `OPS/research/` and `OPS/decisions/` files (all live; `_archive/` is hook-blocked and never read), the territory lease grant, and an outbox row `ledger.claim` for the task. The durable intent now exists before any external write.
4. **The outbox executor performs the ledger protocol** under `flock` on `OPS/ledgers/.nextly.lock` (the interim the ledger audit itself endorses): append the advisory intent note (`ledger note <id> "reeve intends to build this"`), acquire the lock, re-read, re-project, verify still unclaimed and unblocked, append the claim (`--by reeve --lane reeve:bt:<ulid>`; 24 reeve-actor events are already precedent), fsync, release the lock, `ledger sync` push.
5. **Verify-after-push CAS**: re-pull, re-read the tail. The claim op overwrites owner unconditionally in append order (M3: ledger line 105-108), so if any later claim line exists for the same node, reeve **lost**.
6. **On a lost race, reeve appends NOTHING to the ledger.** The earlier design "released its own claim", but release verifies nothing and applies to the node's current state, which now belongs to the human winner: releasing would un-claim the task under them and invite a second lane onto it. The human's later claim already supersedes reeve's line in projection; reeve's stale claim line is inert history. reeve marks the task **LOST** purely hub-side (quiet terminal state, no alarm; a human winning a race is normal, not an incident) and releases the territory lease in the same tx. If the ledger's projection semantics ever require an explicit retraction, it is done under the flock with a re-projection precondition checked after acquiring the lock (current owner is reeve), and skipped otherwise. PR-5's 20-way race test includes the human-wins-after-reeve case: the human must remain projected owner.
7. **Crash anywhere in 4-6**: the outbox reconciler re-reads the ledger tail on recovery and finishes the story from ledger truth: claim present and reeve owns it, complete the protocol and settle; claim present but a later owner exists, LOST; claim absent, retry or release the hub row. A startup sweep in `reeve build run` and a probe in `reeve builder doctor` cross-check the other direction: any ledger claim owned by reeve with no matching hub task escalates as `bt:unknown:intake:orphan-claim`. No window remains in which the ledger says reeve owns a task the hub has never heard of.
8. **The research gate, resolved empirically** (§15.1): the ledger's `claim` refuses any kind=task lacking a `DEPENDS_ON research:*` edge, and 0 of the 38 importable tasks have one. Two candidate protocols exist: (a) append `research:reeve-<task>` (status open) plus link, then claim without `--force` (conforms to the ledger's own discipline but may self-block the task, because `blockers()` blocks any task whose DEPENDS_ON target is not done or decided); (b) claim `--force true` with `force_reason:"research gate satisfied by builder RESEARCH phase"` recorded in the hub. **The intake PR ships with a measurement**: run protocol (a) against a copy of the live ledger and observe the projection. If (a) does not self-block, it is the protocol; if it does, (b) is, with the reason durably recorded and the RESEARCH phase back-filling the real `research:` node, link, and `OPS/research/` file either way.
9. On claim success: CLAIMING transitions to SIZING; the claim event's byte offset is stored so `reeve task why` points at the exact ledger line.

### 2.4 Ownership re-verification, every transition

Humans can `release` anyone's claim at any later moment (M3: release verifies nothing). So: **before every phase transition** of a ledger-sourced task, reeve re-projects the local ledger file (cheap, in-memory). Before every transition that makes work visible outside this machine, it runs a full `ledger sync` first; that list is: **SPEC_PR_OPEN and every spec revision push, the start of each IMPLEMENTING slice, IMPL_PR_OPEN (the push and PR-create), and every `reeve task resume` (§3.4)**. Merge time is covered by a division of labour, because the merge is enqueued by the guardian, which never runs ledger syncs: during VERDICT_WAIT the **builder's poller** repeats the full-sync ownership re-verification each cycle and upserts the result as a durable `ownership_check` row in the hub (owner, sync timestamp); the merge boundary consumes that row as clause **B6** (§9) with a freshness bound. The check lives with the actor that can run `ledger sync`; the evidence lives where the merge executor can read it. The earlier draft omitted IMPL_PR_OPEN, which is the single most network-visible transition: a human re-claim during a 90-minute slice must yield a cheap pre-PR BLOCKED, not a public cleanup. If the projected owner is not reeve, the task goes to **BLOCKED** with escalation `bt:<id>:intake:ownership-lost`. reeve yields; it never fights a human for a claim. Test: remote re-claim mid-slice yields BLOCKED with no PR opened.

### 2.5 Write-back on DONE

Exactly the lane grammar (M3 §2): `fact <id> --evidence '<cmd> → <out>'`, `status done` (which releases), `add pr:N` plus `link --implements`, `ledger sync`. Corrections are new events (REFUTES/SUPERSEDES), never edits.

---

## 3. The task state machine

### 3.1 States

```
FILED → SIZING                          (founder-filed)
FILED → CLAIMING → SIZING | LOST        (ledger-sourced)
SIZING → RESEARCH → DESIGN → SPEC_DRAFT → SPEC_PR_OPEN → GATE
SIZING → DESIGN                         (trivial depth, §5: RESEARCH skipped by
                                         a recorded research.skipped event)
GATE → APPROVED | REVISING (→ SPEC_DRAFT) | DESIGN (depth override, §5)
SPEC_DRAFT → DESIGN                     (depth override, §5)
SPEC_PR_OPEN → DESIGN                   (depth override, §5)
APPROVED → IMPLEMENTING(slice k) → IMPL_PR_OPEN(k) → VERDICT_WAIT(k) → SLICE_MERGED(k)
SLICE_MERGED(k) → IMPLEMENTING(k+1) | FINALIZING → DONE
any active → PHASE_FAILED(retryable) → same-phase retry | ESCALATED
any → BLOCKED (reason recorded with held_from; a HELD state)
BLOCKED → held_from phase | DESIGN      (founder: reeve task resume [--redesign], §3.4)
ESCALATED → failed phase (fresh budget) (founder: reeve task resume, §3.4)
any → INFEASIBLE (reason required; a success state)
any → CANCELLED (founder)               claim race lost → LOST (quiet terminal)
```

**Terminal states**: DONE, CANCELLED, LOST, INFEASIBLE; no transition leaves them. **Held states**: BLOCKED and ESCALATED; each has exactly one founder exit verb (§3.4), so the machine is total: every state either advances by evidence, is terminal, or is held with a specified exit.

DESIGN must emit an ordered list of PR-sized slices (§8); the slice cursor is durable. This is how the 500-PR finding (crossing about 10 changed files roughly triples review rounds, 1.34 to 4.29) becomes structure rather than prompt hope.

### 3.2 Transition discipline: one shape, everywhere

Every transition is exactly one `BEGIN IMMEDIATE` tx that:

1. **CAS-updates the projection**: `UPDATE task SET phase=:to WHERE id=:task AND phase=:expected`. Zero rows changed means a concurrent actor won: a no-op, never an error.
2. Appends the `phase_event` row (new builder op names only; guardian event ops are never reused or renamed).
3. Records the artifact sha256 that justified the transition.
4. Enqueues any side effect as an outbox row, never performing it inline.
5. **For transitions into CANCELLED, BLOCKED, LOST, or INFEASIBLE**: voids the task's pending outbox rows in the same tx and enqueues the compensating effects (close an open PR with an explanatory comment for terminal states; annotate-and-hold for BLOCKED), records `held_from` for BLOCKED (the phase resume re-enters, §3.4), and releases the task's territory lease (§10). A cancelled task's already-enqueued push or pr-create must never fire afterward, and its open PR must never march on to merge (§9 clause B3 is the belt to this suspender).

**A transition commits only after its phase artifact is durable**: written tmp+rename+fsync to `~/.reeve/tasks/<bt>/artifacts/<phase>.{md,json}`, sha256 in the event, and (RESEARCH onward) committed to the spec branch. Temporal's boundary rule: persist completed execution boundaries so recovery never repeats side effects.

**Side effects** run only through the hub outbox: same DDL and `enqueue/leaseOutbox/settleOutbox/recoverOutbox` plus external-truth reconcilers as the guardian schema (fully tested today, zero callers; this programme is their first caller). Idempotency keys: `bt:<id>:<phase>:<kind>:<n>` generally, `bt:<id>:<phase>:<kind>:<sha>` for push and merge kinds so re-delivery after a head change is inert by key, and **`bt:<id>:SPEC_REVISE:push:<round>` for spec revision pushes**, keyed by the gate round being answered rather than by content: a crash-rerun of REVISING re-derives different file bytes and therefore a different commit SHA, so a content-keyed push would duplicate the revision; a round-keyed push maps the rerun to the same key and is inert. The revision cap likewise counts distinct findings-rounds (gate_request rows minted per round), never raw pushes, so launchd restarts on a flaky afternoon cannot burn the cap toward a spurious escalation. Test: kill between push settle and transition commit; exactly one revision exists for that round.

### 3.3 Resume after crash or restart

On builder start (launchd relaunch):

1. `recoverOutbox`: every leased-but-unsettled side effect is settled by its **reconciler against external truth** (push via ls-remote, pr-create via search by head branch, comment via list by marker, merge via `mergedAt`, ledger claim via tail re-read per §2.3.7). Never from what the process remembered.
2. **Adopt-or-kill for surviving workers.** Workers spawn detached (process-group leaders), so a builder crash does not kill them; a naive restart would either wedge on the still-live run row or dispatch a second worker into a worktree the orphan is still editing. Neither is acceptable, so restart logic is explicit: for each recorded live run, check pid+lstart. If the process is **alive**, adopt it: heartbeat its lease, poll its durable output file (below) to completion, then parse and proceed as if never interrupted; or, if adoption is not possible (session ambiguity, budget exceeded), SIGTERM then SIGKILL the recorded process **group**, and only after confirmed death mark the run failed and touch the worktree. **Never dispatch into a worktree whose recorded owner pid is alive.** If the process is dead, `reap()` semantics apply (pid+lstart liveness with grace): the run becomes `phase.attempt_failed(cause:crash)`.
3. **Durable worker output files** make adoption possible: every builder worker's stdout and stderr are redirected to a run-scoped file under `~/.reeve/tasks/<bt>/runs/<phase>-<attempt>.out`, so the fenced-json report survives supervisor death instead of dying in a broken pipe. `parseReport` reads the file, not the pipe. Workers also carry a parent-independent bound: `--max-turns` and `--max-budget-usd` are enforced by the CLI itself, so an orphan cannot burn the subscription indefinitely even with no parent watching.
4. Each non-terminal task resumes **at its current phase from its durable artifacts**: fresh worker session, artifacts as input, never a resumed conversation. Exception: an attempt interrupted by rate-limit or timeout may `--resume <sessionId>` within the same attempt window, and that resume goes through the same dispatch seam as a fresh launch (§4): full argv rebuilt, sandbox settings asserted.
5. A crash mid-phase re-runs the whole phase (LangGraph's honest granularity). Safe because phases are idempotent-on-rerun: report phases overwrite their artifact; code phases re-derive the diff in a fresh worktree; side effects are outbox-deduped, with the round-keyed exception of §3.2 covering the one place content-keying would betray us.

Tests: kill -9 mid-RESEARCH and mid-`gh.pr.create` (exactly one PR, phase completes); kill -9 mid-IMPLEMENT with the worker surviving (restart adopts, report parsed from file); kill -9 with adoption refused (group killed, worktree touched only after death).

### 3.4 Held states: BLOCKED, ESCALATED, and `reeve task resume`

BLOCKED and ESCALATED are **held**, not terminal, and each has a specified exit, so `phases.mjs` stays pure and total over the full matrix.

- **BLOCKED entry** records `blocked_reason` and `held_from` (the phase resume re-enters) in the entry tx, with the §3.2.5 compensations: pending outbox rows voided, annotate-and-hold effects enqueued, territory lease released.
- **`reeve task resume <id> [--redesign]`** (founder-only; the CLI's exit verb for both held states) runs one `BEGIN IMMEDIATE` tx that re-establishes the admission preconditions before any CAS:
  1. **Territory lease re-grant** through the identical §10 intersection check. If the territory now conflicts (someone claimed an overlapping task while this one was held), resume refuses and names the blocking task; nothing transitions and no lease is granted.
  2. For ledger-sourced tasks, **ownership re-verification with a full `ledger sync` first** (§2.4 lists resume among the externally visible transitions): if the projected owner is not reeve, resume refuses. This is the correct exit for an `ownership-lost` BLOCKED only after the founder has re-established the claim.
  3. CAS transition `BLOCKED → held_from`, or `BLOCKED → DESIGN` with `--redesign` (used after `spec:reopened` and post-approval depth overrides, §5 and §7.5). `--redesign` converts the hold annotations into terminal-style compensations in the same tx: any open slice PR is closed with an explanatory comment, and the redesigned spec goes through the full gate again as a new head.
  4. A `task.resumed` event, plus a compensating "resumed" annotation enqueued for any hold comment the BLOCKED entry left.
- **Voided rows stay voided.** The re-entered phase re-derives and re-enqueues its own effects under the standard §3.2 idempotency keys; where an effect already happened externally before the hold (a PR already open, a comment already posted), the reconcilers settle the re-enqueued row as inert against external truth, never as a duplicate.
- **ESCALATED** (from PHASE_FAILED after bounded retries) is held with its escalation standing until the founder acts. Exits: `reeve task resume <id>` re-enters the failed phase with a **fresh attempt budget** (the escalation retires via the hub-state witness, §11), or `reeve task cancel`. Unlike BLOCKED, ESCALATED does not void outbox rows and keeps its territory lease: the phase merely stopped, and the builder loop keeps heartbeating held leases so the reaper never mistakes a held task for a dead one. Starvation caused by a long-held lease stays visible through `candidate.skipped` events and `bt:<id>:lease:starved`.

Tests: resume re-grants the lease and is refused when the territory now conflicts, naming the blocker; resume of an ownership-lost task refuses while a human is still projected owner and succeeds after the founder re-establishes reeve's claim; resume with `--redesign` closes the open slice PR and lands the task in DESIGN; the PR-4 transition-matrix test covers every held-state exit.

---

## 4. Per-phase worker contracts

All workers dispatch through the existing supervisor (`workerArgs`/`runWorker`: repo-agnostic cwd, detached group, SIGTERM-then-SIGKILL budget, halt-poll failing closed, retry bound). Builder actions are new cases in `sandboxFor`'s per-action switch and new cases in `promptFor`, the intended extension seams (M1 §1).

| Phase | action | cwd | tools beyond profile base | budget | turns | model/effort | product |
|---|---|---|---|---|---|---|---|
| SIZING | `BUILD_SIZE` | read-only clone of project repo | Read/Grep/Glob only | 8 min | 15 | sonnet / low | `sizing.json` |
| RESEARCH | `BUILD_RESEARCH` | read-only clone plus `--add-dir` OPS research/decisions | read tools, `Agent(*)`, WebSearch | 20-60 min by depth | 60 | fable / high | `research.md` |
| DESIGN | `BUILD_DESIGN` | same | read tools, `Agent(*)` | 20-60 min | 60 | fable / high | `design.md` with slice list |
| SPEC_WRITE / REVISE | `BUILD_SPEC` | spec worktree (nextly-ops clone) | read plus Write/Edit scoped to `specs/bt-<id>/**` | 20 min | 30 | fable / high | spec files on disk |
| IMPLEMENT | `BUILD_IMPL` | per-(task,slice) worktree | Write/Edit/Bash(test/build/lint pnpm scripts) | 60-90 min | 120 | fable / high | diff plus report |

- **Per-action knobs** in the profile: `builder.budgets.<action> = {budgetMinutes, maxTurns, model, effort}`. Added to `FIELDS` first, same PR.
- **Every prompt states its own budget, turn cap, and file cap in-text**: the documented OpenHands gap is a budget the agent cannot see and therefore cannot plan within. Prompts follow the proven prompts.mjs pattern (invariants-from-profile, honest current state with verification commands, full prior artifacts inlined, never summaries of summaries, OUTPUT_CONTRACT ending with one fenced json block), and render `measured.review.*` where the profile carries it, exactly as the guardian's prompts now do. Prompts also state: "BLOCKED or INFEASIBLE with a reason is a success outcome; salvage is not."
- **Acceptance is machine-checked, never self-reported**: `parseReport` extracts the last fenced json block from the durable output file; reeve validates it against the phase schema. The report is trusted only for "why did you stop". Success means the artifact exists, parses, meets minima (research.md: at least one file:line citation per claim), and for IMPLEMENT, **reeve itself re-runs the gate commands** in the worktree and records exit codes plus raw output as evidence (§8 says which gate definitions those are; the worker does not get to author them).
- **Malformed output**: `BAD_REPORT`, one retry resuming the same session with the schema and parse error quoted, then PHASE_FAILED and escalate. No transition on absent output, ever.
- **`reviewArtifact` is a sibling function, not a parameter**: report phases (SIZING/RESEARCH/DESIGN) are gated by `reviewArtifact({phase, dir, expect})`; diff phases (`BUILD_IMPL`, `BUILD_SPEC`) keep `reviewDiff` with their own action names and territory globs. Two functions, each mandatory for its dispatch path, each asserted at the dispatch seam. No optional gate parameter exists to be forgotten.
- **Resume goes through the same seam as launch.** `--settings` does not survive `--resume` (M2 §5), and `workerArgs` today defaults `settings` to null: a naive resume would relaunch a worker with no NEVER denylist at all, the exact optional-safety-parameter class this design exists to remove. So: every resume dispatch rebuilds the complete argv (settings, allowedTools, model, maxTurns) from the phase contract, and `workerArgs` **hard-fails, not defaults**, when a builder action passes no settings. Test: a resumed worker's argv contains the same `--settings` payload as the original attempt.
- **Containment is by authority, not string patterns; the honest version.** The sandbox's subcommand-prefix denies (`Bash(git push:*)`) compare from the start of the command and therefore cannot gate git once `-C`, `--git-dir`, or direct-URL forms exist (`git -C . push https://<token>@github.com/... HEAD:x` slips every pattern while `Bash(git:*)` permits it), and git's https transport is not covered by the curl/wget/ssh denies. String patterns are documentation here, not enforcement, and the design says so plainly. Publishing is made impossible by **authority**: builder (and guardian) workers run with a credential-less git environment (isolated HOME, `GIT_CONFIG_GLOBAL` pointing at a config with `credential.helper=""`, no keychain access), so no token exists for git's transport to use; each worktree carries a pre-push hook that refuses all pushes; and the bogus per-worktree `pushurl` stays as the third layer. This lands in the same commit as any builder git grant, and as a shared fix it repairs the guardian's existing exposure too (rollout PR-1). The `NEVER` list still strips `gh` publishing surfaces for every action; workers that need GitHub effects don't get grants; reeve performs the effect through the outbox.
- Builder lanes may use the shipped `lanes[].sensitiveOk` mechanism where a task's territory legitimately sits inside `sensitivePaths` (verbatim glob, per-file exemption scoped to the declaring lane); quarantine and self-governing paths remain unreachable by any declaration, exactly as on main today.

---

## 5. The depth classifier

`BUILD_SIZE` emits `sizing.json`: `{depth: trivial|standard|deep, est_files, est_slices, risk_paths_touched, rationale}`.

**Deterministic floors applied by reeve after the worker** (the model proposes, code disposes): territory intersects profile risk paths, minimum `standard`; territory spans more than one package or `est_files > 10`, minimum `standard` and `est_slices >= 2`; `scout-*` verification tasks may be `trivial`. Floors are code and are listed in the spec so the founder sees which fired. Territory always exists by this point (§2.2), so the floors always have something to intersect.

Depth drives research and design budgets and fan-out width (§6), whether RESEARCH runs at all, and spec length expectations. At `trivial` depth the machine takes the explicit `SIZING → DESIGN` edge (§3.1), recording a `research.skipped` event: there is no merged half-state, DESIGN is dispatched directly, its prompt requires a short "measured context" section at the top of `design.md` standing in for the absent `research.md`, and `reviewArtifact`'s expectations adjust by depth (no research.md expected at trivial; the measured-context section required instead). **No depth skips the gate**: trivial shrinks phases and shortens the spec; the spec PR always exists.

**Visible and overridable, with a defined transition for every phase** (the machine edges are in §3.1): `sizing.json` renders as the spec PR's "Sizing" section, floors included, with the line: "Override: comment `/reeve depth <level>` on this PR, or run `reeve task depth <id> <level>`." The comment path accepts only the founder login (`mobeenabdullah`, the sole gh identity on this machine). Every accepted override is recorded as a durable `sizing.overridden` event before anything acts on it. What it then does depends on where the task is:

- **During SIZING, RESEARCH, or DESIGN**: the current phase is re-dispatched (same phase, fresh attempt) with the new depth's budgets and fan-out width. No backward edge is needed.
- **During SPEC_DRAFT, SPEC_PR_OPEN, or GATE**: the task takes the explicit backward edge to **DESIGN** (§3.1). Depth changes the slice plan, so the design is redone at the new depth, and the spec revision that follows re-enters the gate as a new head. During GATE the comment is first a founder event under §7.3: it **stops the 15-minute clock and never counts as silence**. It is also the single non-approval founder event reeve fully classifies (§7.3's note under the table), so instead of the `founder-unclassified` hold it takes this GATE → DESIGN edge; the pending gate decision is void with the window, and the next spec push mints a new gate_request.
- **After APPROVED** (IMPLEMENTING onward): never automatic. The approved spec was gated at a depth, and silently redesigning approved work would discard slices the founder approved. The override is recorded, the task moves to **BLOCKED** with escalation `bt:<id>:depth:post-approval`, and the founder chooses the exit (§3.4): `reeve task resume <id>` continues as approved (the override stays recorded but inert), or `reeve task resume <id> --redesign` re-enters DESIGN at the new depth, closing any open slice PR with a comment; the new design goes through the full gate again.

**Floors versus overrides**: the deterministic floors bind the classifier's proposal, never the founder. A founder override always wins, but the acknowledgment notification names any floor the override crossed, so the choice is informed. No override skips the gate at any depth.

---

## 6. Research and design: fan-out inside one worker

reeve never orchestrates multi-agent workflows (settled requirement 1). Fan-out is Claude's own subagent machinery, which works under `-p` (M2 §1):

- Workers launch with `--agents <json>` carrying purpose-built subagent definitions (measurer, prior-art-scout, adversarial-critic, judge): explicit definitions, versioned in reeve, identical in any cwd; no dependence on `.claude/agents/` discovery, and no dependence on `--settings` surviving resume (it does not).
- `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` set to the phase budget so background subagents aren't killed at the 10-minute default. Nesting stays within the default 3 layers.
- **Fan-out is for measurement, not decisions**: parallel researchers gather facts; the single main agent writes the artifact and makes every design choice (parallel decision-makers produce conflicting implicit decisions; Cognition). Judge-panel fan-out only scores alternatives the main agent enumerated. Depth sets width: trivial none, standard up to 3 subagents, deep up to 6 plus one adversarial-critic pass whose findings are input to the lead, never a gate; the real gate is the spec PR.
- Artifacts: `research.md` (facts with command-and-output evidence, file:line citations) and `design.md` (chosen approach; alternatives rejected with reasons; **ordered slice list**: each slice has a title, expected files (10 or fewer), test plan, and a machine-checkable done-condition). Both land in the artifacts dir (durable before transition) and are committed to the spec branch so the founder reads them rendered next to the spec, and so the approved head SHA pins them (§8 reads them back from that SHA, never from the local dir).
- For ledger tasks, RESEARCH also writes `OPS/research/reeve-bt-<id>.md` plus the real `research:` node and `DEPENDS_ON` link, closing the loop opened at claim time.

---

## 7. The spec PR and the gate

This section encodes the founder's gate revision of 2026-08-21 exactly. It supersedes every earlier version of the gate table.

### 7.1 Host and mechanics

- **Host: `nextlyhq/nextly-ops`**, private by design (M4 §4; Rule 15), the ledger's own home, covered by the Codex connector's installation (selection=all). **Prerequisite satisfied**: the founder added nextly-ops to App installation 155196718 on 2026-08-21, verified by probe the same hour (the App reaches nextlyhq/nextly and nextlyhq/nextly-ops, and the installation token carries contents:write, pull_requests:write, issues:write, checks:write). `reeve builder doctor` keeps asserting it, and the escalation `builder:app-install:<repo>` exists for any future spec-repo configuration whose install is missing. Per-project `builder.specRepo` override exists for future revnix projects (revnix needs a fresh App installation). The §1 visibility checks (boot fast path plus outbox-executor probe) guard every configuration of this field.
- Branch `reeve/spec/bt-<id>` (the spec repo is private, so the name is permitted; the outbox Rule-15 lint would refuse it on any non-private target), files `specs/bt-<id>/{spec.md, sizing.json, research.md, design.md}`. Push and `gh pr create` are **reeve-performed outbox effects with the App installation token** (contents:write plus pull_requests:write confirmed), never a worker grant. Then `gh.review.request` for Codex **plus** the trigger comment (standing rule: trigger Codex on every new PR and every push).
- Every reader of Codex matches the REST login **`chatgpt-codex-connector[bot]`** (the missing `[bot]` suffix produced a false zero during measurement itself) and reads **both endpoints**: findings arrive as review objects; clean passes and quota refusals arrive only as issue comments.
- CodeRabbit is **optional and advisory** on spec PRs: reeve may fold a useful CodeRabbit finding into a revision, but CodeRabbit's silence never blocks, its findings never force REVISING by themselves, and its clean never approves anything.

### 7.2 Spec template (plain language; the founder reads this)

`spec.md`, sections in order: **What and why** (two plain paragraphs; task provenance and ledger links) · **Sizing** (classifier JSON, floors, override instructions) · **Current behaviour** (measured, with commands) · **Proposed behaviour** (concrete before/after examples: code, CLI output, or screenshots) · **Slices** (steps, files, tests, done-condition each) · **What we will NOT do** (explicit non-goals) · **How we'll know it worked** (machine-checkable commands per planned PR) · **References** (research and decision files, prior art) · **Approval instructions**: how to approve, in the committed file; where to find the SHA, everywhere else. A committed file cannot contain the SHA of the commit it is part of, so `spec.md` never carries a head SHA: it says "To approve: approve this PR review, or run `reeve task go bt:<id> --sha <prefix>`, copying the prefix from this PR's description or from the notification. Approval binds to exactly the revision you are reading." The live prefix itself lives in the **PR description body**, an API-editable surface outside any commit, refreshed by the same outbox effect that pushes each revision (idempotency-keyed with the push), and in every notification.

### 7.3 The gate state machine (Codex is a mandatory serial witness; head-SHA-bound throughout)

The rule, in the founder's own framing: every spec PR must first be clean by Codex. Codex never says "approved"; it keeps reviewing until it finds nothing, and the comment saying it found no issues is the go-ahead from Codex. Only after that does the founder's 15-minute window start. If the founder approves, the task proceeds immediately; if the founder objects, reeve revises; if the founder says nothing for 15 minutes after the Codex clean pass, reeve proceeds. This is armed **from day one**; there is no dark row and no calibration period.

**Durable rows.** `gate_request(task, spec_pr, head_sha, round, requested_at)`: one per pushed revision, so binding is structural; a decision on revision 1 physically cannot attach to revision 3. `approval(spec_pr, head_sha, actor, kind, verdict, observed_at, source_id)` records founder approvals AND Codex clean passes (actor `codex`, kind `clean_pass`, source_id the comment id), so every grant is independently replayable forever. A GitHub-review approval's `source_id` is the review id; a CLI-path approval (`reeve task go`) has no GitHub object to point at, so it mints its own durable one, `cli:<ulid>`, recorded with the invoked command line and the timestamp of the live head re-read the command performed. All timestamps are **GitHub's** (`created_at`/`submitted_at`/Date header), never the local clock (local calendar is PKT, a measured failure).

**Gate results and states.** WAIT and HOLD are results, not states: the task remains in **GATE** with the named escalation standing, re-evaluated each tick. Exactly one gate outcome leaves GATE without APPROVED or a revision: the revision cap (row 1, five distinct rounds) moves the task to **ESCALATED** (held, §3.4), where the founder either resumes with a fresh round budget or cancels.

**The Codex clean-pass matcher is a strict grammar, not a heuristic.** Measured live 2026-08-21 on nextlyhq/nextly #1129 and #1130: a clean pass is an **issue comment** by `chatgpt-codex-connector[bot]` whose body matches the template "Codex Review: Didn't find any major issues." followed by a sign-off ("Hooray!" and "Delightful!" both observed), and which contains the line "**Reviewed commit:** `<10-hex>`". The named reviewed commit must **prefix-match the current head**. A refusal never names a reviewed commit, which is the structural tell that separates the two. **Anything that does not match the strict grammar is NOT a clean pass**: not a paraphrase, not "no issues" inside a longer sentence, not a partial-scan disclaimer, nothing. The matcher fails closed: an unmatched comment classifies as Codex-silent and the task WAITs. Phrasing drift therefore degrades to safety (more WAIT, never a false clean), and `reeve builder doctor` surfaces a repo where requests go out but nothing ever matches. A review object with findings covering the head always disqualifies the comment path for that head.

**Founder events.** Silence means **ZERO founder events of any kind on the spec PR**: reviews, issue comments, inline comments, review dismissals, and `/reeve depth` overrides all count as events, read with GitHub timestamps. Any founder event that is not a SHA-bound approval and not an explicit changes-request **stops the clock**. Of these, exactly one is classified with defined handling: a `/reeve depth <level>` comment, which after stopping the clock takes the GATE → DESIGN edge per §5 (the override is recorded, the window and every pending decision are void, and the next spec push restarts the cycle at a new head). Every other non-approval founder event holds the task and escalates `bt:<id>:gate:founder-unclassified`, so a comment like "hold off, I want to check the index-migration angle tomorrow" can never fall through to the silence branch. Test: founder free-text comment plus Codex clean pass still leaves the task in GATE; founder depth-override comment plus Codex clean pass lands the task in DESIGN, never APPROVED.

**The decision table.** Each builder tick, for a task in GATE: pin `head_sha`, classify Codex at that head (strict grammar, both endpoints, sha-prefix coverage), read all founder events. First matching row wins:

| # | Codex at current head | Founder | Result |
|---|---|---|---|
| 1 | Findings (review objects covering head) | any | **REVISING**: push revision, re-request Codex, mint the next gate_request; loop until clean. Revision cap: 5 distinct rounds, then escalate `bt:<id>:gate:revision-loop` |
| 2 | Clean pass naming this head | Approval bound to this head (review `commit_id`, or `reeve task go --sha`), whenever it arrives | **APPROVED** immediately (path: codex-clean plus founder) |
| 3 | Clean pass naming this head | Requests changes (review or explicit changes comment) | **REVISING** |
| 4 | Clean pass naming this head | Any other founder event reeve cannot classify (free-text comment, dismissal, anything unclassified; a `/reeve depth` comment instead takes its classified GATE → DESIGN handling, above) | **HOLD**: clock stopped, escalate `bt:<id>:gate:founder-unclassified`, wait for an explicit approval or changes-request |
| 5 | Clean pass naming this head | Zero founder events for **15 minutes**, measured from the clean-pass comment's GitHub `created_at`, and the clean still covers the current head for that whole window | **APPROVED** (path: codex-clean plus founder-silence; the authorizing comment id is in the approval row) |
| 6 | Silent, refused, or clean only for an OLDER head | any | **WAIT**: re-request review (outbox, idempotency-keyed per head, so restarts never spam) at `builder.gate.rerequestMinutes` (default 60), escalate `bt:<id>:gate:unreviewed` at `escalateMinutes` (default 120), hold forever. **Never proceed on silence.** A founder approval observed here is recorded, SHA-bound, and takes effect the instant Codex cleans this head (row 2); it does not skip Codex. A founder **changes-request** observed here triggers **REVISING immediately**: a founder objection never waits for Codex. Expect this row often: Codex refused 79% of requests this week |

**Properties that hold by construction:**

- **Codex clean is a mandatory serial witness for every spec PR, not a fallback.** Founder approval alone does not skip it (row 6's last clause). There is no path to APPROVED that does not pass through a strict-grammar clean pass at the current head.
- **The 15-minute window belongs to the Codex clean pass**: it starts at that comment's GitHub timestamp and runs only while the clean covers the current head. Any push voids the window and every pending decision; the new revision mints a new gate_request and the cycle restarts.
- Approval bindings, each its own test: an approval row whose `head_sha` does not match the current head authorizes nothing; the founder's approval SHA comes from the review's own `commit_id`, never `headRefOid` (which reports the merged head, a measured gh trap).
- **When Codex cleans, the founder is notified immediately**: "spec PR <url> clean by Codex, 15 minutes before reeve proceeds; approve or comment to hold." The silence path never fires on a founder who was never told the clock started.
- **Armed from day one.** The replacement for a calibration period is the strict grammar plus fail-closed matching plus the notification above. The worst failure of a too-strict matcher is WAIT, which is safe.
- **Emergency waiver (designed, not yet authorized).** If Codex never responds on nextly-ops at all (open question 1), every spec PR would wait forever, founder approval included. The designed escape hatch is a loud, spelled-out flag: `reeve task go bt:<id> --sha <prefix> --waive-codex "<reason>"`, founder-only, recorded as a durable waiver row quoted in the APPROVED event and in the impl PR body, and escalated so it is never quiet. **Whether this flag ships at all, ships dark, or is refused is a new open question for the founder (§16.2). Until ruled, it does not exist and the answer to a Codex-dead spec repo is the escalation path.**

### 7.4 `reeve task go`: SHA required, always

Rows 1 and 3 can revise the spec **without founder involvement** (Codex findings alone trigger a revision), so the head can move between the founder reading the spec in a browser and typing `go` in a terminal. Therefore `reeve task go <id> --sha <prefix>` **requires the prefix**: go re-reads the current head from the API, compares, and refuses on mismatch with "spec has moved, re-read: <url> <new sha prefix>". A bare `go` without `--sha` always refuses and prints the current head and the instruction. The prefix the founder needs is in every notification and in the PR description body, which reeve refreshes through the API on every revision push; it is never inside the committed spec files (§7.2), because a committed file cannot name its own commit. The structural guarantee this preserves: an approval means a human read this exact revision, not merely that a SHA got bound.

### 7.5 After the gate: the spec PR stays live

APPROVED does not end reeve's reading of the spec PR. For every non-terminal task past GATE, a **post-GATE spec-PR watcher** runs each tick: a founder CHANGES_REQUESTED, a review dismissal, or any new founder comment on the spec PR moves the task to **BLOCKED** with escalation `bt:<id>:spec:reopened` (the founder exits via `reeve task resume [--redesign]`, §3.4), and the merge boundary independently re-checks it (§9 clause B4: no founder-negative event on the spec PR newer than the approval row's `observed_at`). The founder acting on exactly the artifact reeve called the control surface must always work, at any hour, without knowing any CLI command.

---

## 8. Implementation

- **One worktree per (task, slice)** under the project's worktreeRoot, via the existing `acquireWorktree`, deliberately disjoint from the guardian's per-PR worktree namespace so the two machines can never collide on a directory. Credential-less environment, pre-push hook, and bogus pushurl apply (§4).
- **The plan is read at the approved SHA, never from local artifacts.** A REVISING loop edits `design.md` in the spec worktree, so the local artifacts-dir copy can be stale relative to what the founder and Codex actually approved. IMPLEMENT (and the slice cursor logic) therefore materializes `spec.md` and `design.md` via `git show <approved_spec_head>:specs/bt-<id>/design.md`: the exact bytes at the approved SHA. The sha256 of the materialized slice text is recorded in the phase_event, so the built plan is provably the approved one.
- Worker input: the materialized spec and slice k verbatim (full-trace handoff), the approved spec head SHA, gate commands, and the hard rules: this slice only; 10 changed files or fewer; lint and build must pass before declaring OK; BLOCKED or INFEASIBLE with a reason is a success outcome.
- **Acceptance (reeve, not the worker)**: `reviewDiff` with builder territory glob = task territory union the slice's declared files; sensitive, quarantine, and self-governing path refusal as shipped (with `lanes[].sensitiveOk` honored where declared); hard changed-file ceiling (10), over-cap means REVISING (the split was wrong), not a bigger PR. Then reeve re-runs the profile gates itself and records exit codes plus raw output.
- **The verification harness is not the worker's to edit.** Both reeve's gate re-run and CI resolve through files an IMPLEMENT worker could otherwise modify (a one-line `--passWithNoTests --exclude` in a test script silences the very tests that would fail it). So `reviewDiff` for builder diffs carries a categorical **gate-definition denylist**: package.json script blocks (lockfile-only changes excepted), test runner configs (vitest, jest, playwright), turbo.json, `.github/workflows/**`, husky hooks. Any touch escalates `bt:<id>:impl:harness-touched` and requires founder review; it never auto-merges. Additionally, reeve's own acceptance gates run from the **base revision's** gate definitions overlaid on the worker's source where feasible, so even an undetected tamper does not choose what reeve executes.
- **Neutral naming on the public repo.** Impl branches are `mp/<taskid>-s<k>` (after the App's neutral slug `merge-policy`; never a reeve token), PRs are authored by `merge-policy[bot]`, and PR bodies pass the Rule-15 lint (§1): the spec-PR link renders as a plain private-repo URL, and the approval quote names the bound SHA and the approval path without naming reeve. Rule 15 holds on every public artifact the builder produces, not only on spec hosting.
- **Push and the attested head chain.** The worker never pushes (physical). reeve enqueues `git.push.branch` (expected-remote CAS, idempotency key carries the SHA) then `gh.pr.create`, both with the App token. The push settle appends an **attested_push row** `(task, slice, pr, sha, pusher, outbox_key, at)` in the hub, and the pr-create settle and the `impl_pr` write are **one hub tx** (a crash between them cannot leave an open PR the hub has never heard of; the reconciler completes both together). From then on, **every legitimate head advance appends to the chain**: when the guardian's FIX_CI or review-thread worker pushes a repair to a builder PR, that push settles through the guardian's outbox and appends its own attested_push row (the one narrow guardian-to-hub write, witnessed by the outbox record and verifiable against git). The merge boundary (§9 clause B1) verifies the chain, so guardian repairs keep builder PRs mergeable while a commit smuggled by anyone else still blocks. This resolves what would otherwise be a fatal contradiction: the common case (a slice needing one CI fix) must not dead-end on the founder, and the smuggle check must not decay into "head equals head".
- **Handover to the guardian**: once the PR exists, the guardian daemon for that repo owns it (pin head, publish verdict, FIX_CI with the shipped `flakeAssessment` semantics, work review threads), exactly the intended handoff. The builder's live run for the slice **ends at IMPL_PR_OPEN**: it never holds a live run while the guardian holds `pr:<n>`, and it releases the slice worktree; guardian repairs use their own per-PR worktree. The task sits in VERDICT_WAIT, polled read-only.
- **VERDICT_WAIT is never a silent forever.** It is the modal state (Codex refuses 79% of requests, so UNKNOWN verdicts are expected and correct), and fail-closed must not mean fail-quiet: a slice whose VERDICT_WAIT exceeds `builder.verdict.staleBudgetMinutes` escalates `bt:<id>:verdict:stale` (identity only; the body names which witness is absent), and the builder probes the owning guardian daemon's heartbeat each tick, escalating `bt:<id>:guardian:dead` when it is not fresh. The founder learns about a three-day stall from a notification, not from choosing to open dash.
- Slices are serial within a task (review-round economics), parallel only across tasks.

---

## 9. Merge actuation on PASS

The entirely-unbuilt piece: `ACTIONS.MERGE` is decided but nothing executes it; outbox kind `gh.pr.merge` and `reconcilePrMerge` (with `--match-head-commit` semantics) exist with zero callers. Wiring lands **in the guardian daemon** (it owns PRs; builder-run PRs benefit automatically), dark behind profile authority (§14, §15.3).

**One function, both stores.** The synthesis stated builder preconditions but left them homeless: the guardian decides MERGE from the verdict and profile alone and has no concept of the hub, so clauses about approval rows and pushed heads would never have executed anywhere. The fix is structural: a single `mergeEligible(pr)` runs where actuation runs (the guardian's merge executor) and **reads both stores**: the per-repo guardian DB and hub.db, read-only, same-host WAL. Every clause below names its evidence source; a clause that cannot read its evidence yields UNKNOWN, and UNKNOWN never merges.

**Two clause sets, scoped by PR kind; the detection is structural and stated.** The executor is general: it owns every PR on a repo whose profile grants merge authority. Any PR whose head branch matches `mp/*` **or** whose author is the App **or** that has a matching `impl_pr` row is a **builder PR**, categorically; everything else is an **ordinary PR**. Kind decides which clauses bind: the universal clauses (U1-U4) bind every PR; the builder clauses (B1-B6) bind builder PRs in addition. For an ordinary PR the builder clauses are out of scope **by kind**, never "skipped for missing evidence": the fail-closed rule (a clause that cannot read its evidence yields UNKNOWN) applies to every clause in the PR's own set, and the kind determination itself fails closed. A builder-shaped PR (branch or author matches) with an incomplete chain (no impl_pr row, no approval row, no attested chain: for example after a crash between effects, before the reconciler has caught up) **never merges** and escalates `bt:unknown:merge:unbound`. "No hub row" is never read as "ordinary PR" for a builder-shaped head; a crash cannot reroute an unapproved PR down the plain merge path. An ordinary guardian PR therefore merges on the universal clauses alone, which is exactly the behaviour today's `ACTIONS.MERGE` decision promises; builder-run PRs carry the full chain on top.

**Universal clauses (every PR), all durable, all re-checked at enqueue time AND encoded in the merge command itself:**

- **U1.** Guardian verdict `PASS` at pinned head H (7-clause worst-wins; UNKNOWN never PASS, therefore UNKNOWN never merges). For ordinary PRs the verdict's existing reviewer semantics apply unchanged; the builder-specific roster rule is B5.
- **U2.** Live GitHub state agrees at H: CI rollup success (`conclusion == ""` is in-progress, not success), zero unresolved threads, reviewer states clean per the 4-state read.
- **U3.** Zero open ledger BLOCKS edges against `pr:<n>`, **with a stated freshness contract**: mergeEligible performs a `ledger sync` (or verifies sync recency within `builder.merge.ledgerFreshMinutes`) before counting, fails to UNKNOWN (never to zero) on sync error, wrong clone, or parse failure, and records the sync timestamp in the merge decision row (below). A zero produced by not-looking is the fail-open this system exists to kill.
- **U4.** Repo authority is `propose_and_merge`/`owner` in the profile, and the App is installed there (probe; failure escalates, **never** falls back to the founder token).

**Builder clauses (builder PRs only, in addition):**

- **B1.** **Attested head chain intact**: H equals the latest attested_push sha for this (task, slice), and every commit between the first attested push and H is reachable via attested pushes (builder outbox pushes and guardian repair outbox pushes alike), verified from git log plus the outbox and attested_push records, never from a worker report. reeve's own repairs merge; anyone else's commit blocks. Companion test: guardian FIX_CI push then PASS must still merge.
- **B2.** **Approval chain valid**: an `approval` row exists for the governing spec head, and a Codex clean-pass row (strict grammar, §7.3) exists for that same head; if the emergency waiver ever ships and was used, the waiver row stands in for the clean-pass row and is quoted in the merge decision row.
- **B3.** **Task liveness**: the hub task is in the active post-approval state for exactly this slice, `VERDICT_WAIT(k)`. CANCELLED, BLOCKED, LOST, or anything else blocks the merge; a founder's cancel must stop a PR that is already green. (§3.2.5's compensating effects close the PR too; this clause is the independent belt.)
- **B4.** **No founder-negative event on the spec PR newer than the approval row's `observed_at`** (the merge-boundary half of the post-GATE watcher, §7.5).
- **B5.** **Review witness non-vacuous**: the verdict's review clause emits PASS on an empty blocking-reviewer roster ("no blocking reviewer configured"); at the merge boundary for builder PRs that is absence read as success on the very witness requirement 6 names. So for builder PRs an empty or vacuous roster yields UNKNOWN, and a bt-owned PR merges only with a real external review witness at H, or with an explicit per-project founder acknowledgment recorded as a durable authority row (a founder ruling per repo, not a default). Ordinary PRs keep the guardian verdict's existing semantics, unchanged.
- **B6.** **Ownership fresh (ledger-sourced tasks only)**: the hub's `ownership_check` row for this task shows reeve as the projected owner, from a full `ledger sync` no older than `builder.merge.ownershipFreshMinutes` (default 15; the builder's VERDICT_WAIT poller writes this row each cycle, §2.4). Stale, absent, or human-owned yields UNKNOWN and blocks, with `bt:<id>:intake:ownership-lost` standing. Founder-filed tasks have no ledger owner, so this clause is out of scope for them **by source kind**, recorded as such in the merge decision row, never "skipped for missing evidence".

**The merge decision row.** Every `mergeEligible` evaluation, MERGE and refusal alike, writes one durable **`merge_decision`** row in the **per-repo guardian DB** (the store where the executor runs; this is a guardian-owned write to its own DB, so the guardian's hub surface stays exactly the two §13 touches): `(pr, head_sha, decided_at, pr_kind, outcome, clause_results, ledger_sync_at, approval_head_sha, approval_source_id, codex_clean_source_id, waiver_id, outbox_key)`, DDL in §11. `clause_results` names every evaluated clause with its result and evidence reference; `ledger_sync_at` is U3's recorded sync timestamp; the approval and clean-pass (or waiver) identifiers make B2 independently replayable. `reeve task why` reads guardian DBs read-only (a read the builder already performs, §1) and joins through `impl_pr(nwo, pr)` to replay exactly why a merge fired or was refused; the `bt:<id>:merge:refused` escalation body cites the row. This is the schema home of the durable-replayability claim (Appendix finding 24).

**Actuation**: outbox `gh.pr.merge` `{pr, method: profile merge.method, match_head_commit: H}`, idempotency key `merge:<nwo>:<pr>:<H>`, executed with an App installation token, the merge-boundary identity. `--match-head-commit` makes the binding atomic server-side: a head that moved between check and click fails the merge rather than merging the wrong code. Settle only via `reconcilePrMerge`. An API refusal beyond the clauses raises the shipped `ESCALATIONS.PROTECTION_UNMET`; a builder-clause or universal-clause failure on a builder PR raises `bt:<id>:merge:refused`; a universal-clause failure on an ordinary PR simply leaves the PR unmerged under the guardian's existing escalation grammar (`#<n>:` subjects; `bt:` identities are minted only for builder PRs). Nothing is retried blind.

**Independent-witness invariant, structural**: the worker produced code; CI, external reviewers, and the deterministic verdict judged it; `mergeEligible` reads only those witnesses plus git, GitHub, hub, and ledger state. No worker report field appears anywhere in its inputs. Prior art says "never let the pipeline merge"; the founder's settled requirement 6 overrides it, and the compensating control is this exact stack: a mandatory Codex-clean spec gate with SHA-bound founder consent upstream, independent witnesses and the attested chain downstream.

After merge: SLICE_MERGED (witness: the reconciler's `mergedAt`), merged head compared to the latest attested head, then the next slice or FINALIZING.

**FINALIZING is a reeve-code phase, not a worker phase**: no claude session runs. It executes the §2.5 ledger write-back through the outbox, posts a completion comment on the spec PR linking every merged slice PR (and closes it), releases the task's remaining leases and worktrees, and CAS-transitions to DONE only when every enqueued effect has settled through its reconciler. A crash mid-FINALIZING resumes it like any phase: the effects are outbox-deduped, so the write-back happens exactly once.

---

## 10. Concurrency: N tasks, M projects, one machine

- **Leases live in the hub, and the two kinds have different lifetimes on purpose**: `directory_lease(path, task, pid, lstart, expires)` with an absolute-path unique index, covering worktrees and the OPS clone (ledger sync and claim serialized per ledger), is **process-scoped**: heartbeat at lease/4, LEASE_SECONDS=120, reaper with pid+lstart grace, all copied from proven ops.mjs machinery, because the thing it protects dies with a process. `territory_lease(project, glob, task, expires)` is **task-scoped**: granted and released by task transitions (below), its expiry refreshed by the builder loop's per-task heartbeat rather than by any worker pid, and reaped only when its task is provably dead, because a territory belongs to a task that may sit in GATE for a day with no process attached.
- **Territory leases have a full lifecycle, spelled out.** Grant happens inside the same `BEGIN IMMEDIATE` tx as task admission, for both intake paths identically: import step §2.3.3 and `reeve task file` alike run the same intersection check and the same refusal (founder filings do not bypass it; two founder-filed tasks with overlapping territories cannot both admit). Release happens inside every terminal transition's CAS tx (LOST, CANCELLED, DONE, INFEASIBLE) and on BLOCKED, so a lease can never outlive its task and silently starve every future candidate that overlaps it; **re-grant on `reeve task resume` runs the identical intersection check** (§3.4), and an ESCALATED hold keeps its lease, heartbeated by the builder loop. Validity is additionally tied to task liveness by the reaper (expiry plus heartbeat), belt and suspenders. The intersection is re-run against current ledger claims at each IMPLEMENTING slice start (piggybacking on the §2.4 sync), catching a human who claimed an overlapping ledger task after reeve's one-time import check. Skips emit the durable `candidate.skipped` row (§2.3.2), and the intake loop raises `bt:<id>:lease:starved` (identity: the HOLDING task, never the skipped candidates) when one task's lease has produced skips across more than `builder.lease.starvedHours` (default 24): a lease that quietly locks out a day of candidates is a founder decision waiting to be made, not a queue. Test: a LOST task's territory is claimable by the next import.
- **Admission**: `builder.maxConcurrentTasks` (default 2), max 1 worker per task, at most one IMPLEMENTING slice per project at a time (keeps builder and guardian-FIX_CI worktrees from crowding one repo), and the existing load-aware `capacity()` so builder workers yield to machine load.
- **The subscription is the real choke point, and the guardian owns it.** Two fable/high IMPLEMENT workers can exhaust the shared claude subscription's rate window; the guardian's serial tick then blocks inside its inline `await` on a rate-limited FIX_CI for however long the window takes, freezing verdicts for every PR on that repo. Machine-load admission cannot see this, so the hub carries a **quota ledger**: a `quota_window` table **written only by the builder**. The builder's worker-exit path appends its own attempts, usage, and rate-limit signatures directly; guardian usage enters through the read path the builder already has (§1): each builder tick reads the per-repo guardian DBs read-only over same-host WAL and folds in the attempts, outcomes, and rate-limit classifications the guardian's worker-exit path already records in its own run and fix-attempt rows (429 classifies RATE_LIMITED there today). Live guardian FIX_CI runs are visible the same read-only way, from the guardian DB's live run rows. **The guardian gains no hub write for quota**: its hub surface stays exactly the two §13 merge-executor touches, and the quota ledger is still never blind to guardian usage. Admission rule, guardian priority: the builder admits **no new phase worker** while quota pressure is high or while any guardian FIX_CI run is live (read from the guardian DBs). The guardian side gains a rate-limit fast-fail: the dispatch path detects the CLI's rate-limit signature and fails the attempt in seconds instead of awaiting the window, so the serial tick is never quota-blocked for hours. The rollout's latency proof (§14 PR-9) includes a quota-exhausted trial, not just a loaded-machine one.
- **The builder tick never blocks**: phase workers spawn detached (pid+lstart recorded via `onSpawn`); the tick polls run rows in the DB rather than awaiting; liveness is counted from rows, not a variable, so the guardian's `ctx.running` bug is not inherited.
- **Multi-project**: phases carry their project's profile and checkout explicitly from the registry rather than deriving from a watched repo. Filing against a repo with no guardian instance is refused at filing time with a clear message: refuse rather than default.

---

## 11. Schema DDL (hub.db plus the guardian addition), modules, CLI

```sql
CREATE TABLE task(id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL,
  territory TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'FILED', depth TEXT,
  slice_cursor INTEGER DEFAULT 0, source_kind TEXT NOT NULL, source_key TEXT NOT NULL,
  blocked_reason TEXT, held_from TEXT, spec_pr INTEGER, spec_head TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(source_kind, source_key));
CREATE TABLE phase_event(id INTEGER PRIMARY KEY, task TEXT NOT NULL, at TEXT NOT NULL,
  op TEXT NOT NULL, from_phase TEXT, to_phase TEXT, artifact_sha TEXT, detail TEXT);
CREATE TABLE phase_run(task TEXT NOT NULL, phase TEXT NOT NULL, attempt INTEGER NOT NULL,
  status TEXT NOT NULL, pid INTEGER, lstart TEXT, session_id TEXT, started_at TEXT,
  heartbeat_at TEXT, output_path TEXT, outcome TEXT, evidence TEXT,
  PRIMARY KEY(task, phase, attempt));
CREATE UNIQUE INDEX one_live_run ON phase_run(task) WHERE status='live';
CREATE TABLE gate_request(task TEXT, spec_pr INTEGER, head_sha TEXT, round INTEGER,
  requested_at TEXT, PRIMARY KEY(task, head_sha));
CREATE TABLE approval(spec_pr INTEGER, head_sha TEXT, actor TEXT, kind TEXT,
  verdict TEXT, observed_at TEXT, source_id TEXT,
  PRIMARY KEY(spec_pr, head_sha, actor, source_id));
CREATE TABLE impl_pr(task TEXT, slice INTEGER, nwo TEXT, pr INTEGER,
  merged_sha TEXT, PRIMARY KEY(task, slice));
CREATE TABLE attested_push(task TEXT, slice INTEGER, pr INTEGER, sha TEXT,
  pusher TEXT, outbox_key TEXT, at TEXT, PRIMARY KEY(task, slice, sha));
CREATE TABLE directory_lease(path TEXT PRIMARY KEY, task TEXT, pid INTEGER, lstart TEXT, expires TEXT);
CREATE TABLE territory_lease(project TEXT, glob TEXT, task TEXT, expires TEXT,
  PRIMARY KEY(project, glob));
CREATE TABLE quota_window(window_start TEXT PRIMARY KEY, attempts INTEGER,
  tokens INTEGER, rate_limited INTEGER, last_signature TEXT);
  -- written ONLY by the builder (§10): its own worker exits directly, guardian
  -- usage folded in from read-only reads of the per-repo guardian DBs.
  -- rate_limited counts; last_signature keeps the most recent raw rate-limit
  -- marker so the fast-fail detector has an example to match, not a number.
CREATE TABLE ownership_check(task TEXT PRIMARY KEY, owner TEXT NOT NULL,
  synced_at TEXT NOT NULL, at TEXT NOT NULL);
  -- upserted by the builder's VERDICT_WAIT poller after a full ledger sync
  -- (§2.4); consumed by merge clause B6 with a freshness bound (§9)
CREATE TABLE intake_event(id INTEGER PRIMARY KEY, at TEXT NOT NULL, ledger TEXT,
  node_id TEXT, op TEXT NOT NULL, detail TEXT);
  -- intake decisions that precede a task: candidate.skipped rows land here,
  -- because a skipped candidate was never admitted and has no task id for
  -- phase_event (whose task column is NOT NULL) to hold
-- outbox + escalation: identical DDL to guardian schema.sql (proven shapes),
-- plus one hub-only outbox status value 'voided' (written by §3.2.5's terminal
-- transitions; a voided row is never leased and never retried). The guardian's
-- own outbox is untouched.
```

```sql
-- Guardian per-repo schema, one additive table (lands with the merge executor, PR-3).
-- Written only by the guardian's merge executor; the builder reads it read-only.
CREATE TABLE merge_decision(id INTEGER PRIMARY KEY, pr INTEGER NOT NULL,
  head_sha TEXT NOT NULL, decided_at TEXT NOT NULL,
  pr_kind TEXT NOT NULL,          -- 'builder' | 'ordinary'
  outcome TEXT NOT NULL,          -- 'MERGE' | 'REFUSE' | 'UNKNOWN'
  clause_results TEXT NOT NULL,   -- JSON: each evaluated clause (U1-U4, B1-B6) with result + evidence ref
  ledger_sync_at TEXT, approval_head_sha TEXT, approval_source_id TEXT,
  codex_clean_source_id TEXT, waiver_id TEXT, outbox_key TEXT);
```

`task.territory` is NOT NULL (§2.2); `task.held_from` records where a BLOCKED task resumes (§3.4). The head chain lives in `attested_push`, not in a single mutable column, so "the pushed head" is an append-only history with a named pusher and outbox key per row (§8). WAL, `BEGIN IMMEDIATE` everywhere, busy_timeout 10s: the guardian's discipline verbatim. All transitions use the §3.2 CAS shape against `task.phase`.

**Modules**: `src/build/{loop.mjs, phases.mjs (pure), intake.mjs, ledger.mjs (flock claim reconciler, re-verify), sizing.mjs, gate.mjs (rule table plus strict-grammar matcher), specpr.mjs, impl.mjs, merge.mjs (shared with guardian; writes merge_decision in the per-repo DB), hubdb.mjs, registry.mjs, artifact.mjs (reviewArtifact), rule15.mjs (lint plus visibility probe)}`. Extended: `sandbox.mjs` (new action cases, credential-less env, gate-definition denylist), `supervisor.mjs` (durable output files, settings hard-fail), `prompts.mjs` (new promptFor cases), `profile/schema.mjs` (`builder.*` FIELDS). Reused untouched: `notify.mjs`, `worktree.mjs`, `db/reconcile.mjs`, `github/app.mjs`.

**CLI**: `reeve task file|import|list|show|why|go|depth|resume|cancel` (`resume` is §3.4's held-state exit; `why` joins hub rows, the ledger claim offset, and the guardian DB's merge_decision rows read-only), `reeve build run|status|pause`, **`reeve dash`** (every task: state, age-in-state from the event log with server-clock elapsed, waiting-on including `held_from` for held tasks, the single next action, spec and impl PR links; every UNKNOWN rendered as UNKNOWN, never quiet green), **`reeve builder doctor`** (probes every rollout precondition: App installed on nextly-ops? spec repo private? Codex connector installed, and has any strict-grammar clean pass ever been observed on the spec repo? live ledger clone present, clean, syncing? flock works on the jsonl? any reeve-owned ledger claim without a hub task? node v24 pinned? guardian daemon heartbeat fresh for each registry project? App slug and branch templates free of the reeve token?).

**Escalations are two-field, enforced.** The guardian's existing code sometimes embeds detail in the dedup key; the builder must not inherit that breach. For every builder subject, the escalation Map key is the **bare identity** and the report rides only in the alert body; a test asserts no builder `escalations.set` call interpolates variable detail into the key. Identities, each with a named producer: `bt:<id>:gate:unreviewed` (§7.3 row 6), `bt:<id>:gate:revision-loop` (§7.3 row 1), `bt:<id>:gate:founder-unclassified` (§7.3 row 4), `bt:<id>:spec:reopened` (§7.5), `bt:<id>:spec:visibility` (§1), `bt:<id>:depth:post-approval` (§5), `bt:<id>:phase:failed:<phase>` (§4), `bt:<id>:impl:harness-touched` (§8), `bt:<id>:verdict:stale` (§8), `bt:<id>:guardian:dead` (§8), `bt:<id>:merge:refused` (§9), `bt:unknown:merge:unbound` (§9), `bt:<id>:intake:ownership-lost` (§2.4, §9 B6), `bt:unknown:intake:orphan-claim` (§2.3.7), `bt:<id>:infeasible` (§3.1), `bt:<id>:lease:starved` (§10), `builder:app-install:<repo>` (§7.1). An identity with no producing section does not belong in this list; the synthesis carried one (`merge:witness-mismatch`) and it is gone, because clause failures already raise `merge:refused` with the clause named in the body. Builder subjects get their own retirement witness (hub task state, not `gh pr view`) via subject-grammar dispatch in `announceable` (`^bt:` routes to hub; guardian grammar unchanged). Every alert names the single founder action needed: "approve or comment on nextly-ops#12 within 15 minutes", "run `reeve task resume bt:x` or `reeve task resume bt:x --redesign`", "install the App on nextly-ops now; the first spec PR is waiting on it".

---

## 12. Failure-mode matrix (each row is at least one test)

| Failure | Handling |
|---|---|
| Crash mid-phase | Relaunch, recoverOutbox reconcilers, adopt-or-kill surviving workers, re-run phase fresh from artifacts; side effects deduped by outbox key. Tests: kill -9 mid-RESEARCH and mid-`gh.pr.create` (exactly one PR); kill -9 with worker surviving (adopted, report read from file; or group-killed before worktree touch) |
| Worker returns garbage | Schema-validated report from the durable output file; BAD_REPORT, one resumed retry, then PHASE_FAILED, escalate; no transition on absence |
| Worker lies (fake success) | reviewArtifact / reviewDiff plus reeve re-runs gates itself from base-revision gate definitions; self-report never gates. Test: report claims pass, gates fail, no transition |
| Worker tampers with the harness | Gate-definition denylist: package.json scripts, test configs, workflows, husky. Test: script-block edit escalates `harness-touched`, never merges |
| Worker resumed without sandbox | Resume rebuilds full argv through the dispatch seam; workerArgs hard-fails on null settings. Test: resumed argv carries the original `--settings` payload |
| Worker pushes via `git -C` or direct URL | Credential-less git env plus pre-push hook plus bogus pushurl: no token exists to use. Test: token-URL push from fixture worktree fails on auth and on hook |
| Approval race (GO on rev1, head now rev3) | `--sha` required on go; approval bound to review `commit_id`; head change mints new gate_request. Tests: approve at H1, push H2, still GATE; bare `go` refuses |
| Founder comments something unclassifiable | Any non-approval founder event stops the clock: HOLD plus `founder-unclassified`. Test: free-text comment plus Codex clean, still GATE |
| Founder overrides depth mid-flight | Recorded `sizing.overridden`, then phase-scoped handling (§5): during GATE the clock stops and the task takes GATE → DESIGN (never APPROVED, never silence); post-approval the task goes BLOCKED plus `depth:post-approval` and clause B3 blocks any green PR meanwhile. Tests: depth comment plus Codex clean lands in DESIGN; override during IMPLEMENTING yields BLOCKED, no merge; `resume --redesign` closes the open slice PR |
| Founder revokes after APPROVED | Post-GATE watcher: BLOCKED plus `spec:reopened`; mergeEligible clause B4 blocks independently. Test: CHANGES_REQUESTED after approval, merge refused |
| Founder resumes a held task | `reeve task resume` re-grants the territory lease through the full intersection check and re-verifies ledger ownership (full sync) before the CAS; voided rows stay void, the phase re-enqueues, reconcilers keep external effects single. Tests: resume refused naming the blocker when territory now conflicts; resume of ownership-lost refused while a human owns; ESCALATED resume re-enters the failed phase with a fresh attempt budget |
| Fake or drifted Codex clean pass | Strict grammar only; refusal never names a reviewed commit; unmatched comments classify as silent (WAIT). Test: partial-scan "no issues" comment, still GATE |
| Refusing-reviewer deadlock | Refusals detected; re-request at rerequestMinutes (idempotent), escalate, wait forever |
| Claim race (reeve vs human, reeve vs reeve) | Hub row first, claim via outbox under flock, tail re-read CAS; later claim wins; reeve LOST quietly, appends nothing. Tests: 20-way race, one winner; human-wins-after-reeve leaves human as owner |
| Crash between claim push and hub state | Cannot occur by ordering (hub row exists first); reconciler finishes from ledger truth; orphan sweep escalates `orphan-claim` |
| Human releases or re-claims mid-flight | Pre-transition re-verify, full sync before every externally visible transition (incl. IMPL_PR_OPEN and resume); BLOCKED (`ownership-lost`), reeve yields. Test: re-claim mid-slice, no PR opened |
| Builder vs guardian on one PR | Builder run ends at IMPL_PR_OPEN; disjoint worktree namespaces. Test: no live `bt:` run while `pr:` run live for the same PR |
| Guardian repairs the builder's PR | Repair push appends attested_push via outbox; chain verification (clause B1) keeps the PR mergeable. Test: FIX_CI push then PASS still merges; foreign commit blocks |
| Cancel during VERDICT_WAIT | Terminal tx voids pending outbox rows and closes the PR; mergeEligible clause B3 blocks regardless. Test: cancel then PASS delivered, merge refused, PR closed |
| Merge preconditions drift after check | `--match-head-commit H` server-side; settle only via reconciler; GitHub refusal beyond clauses raises PROTECTION_UNMET |
| Stale ledger at merge | Clause U3 freshness bound; sync failure yields UNKNOWN, never zero; sync timestamp in the merge decision row. Test: sync error, merge blocked |
| Crash between pr-create settle and impl_pr write | One hub tx; and a builder-shaped PR without its chain never merges (`merge:unbound`). Test: kill between, guardian refuses merge, escalation fires |
| Spec repo goes public mid-flight | Outbox-executor visibility probe refuses the effect: BLOCKED plus `spec:visibility`. Test: visibility flips between enqueue and execute, effect refused |
| Quota exhaustion | Builder-written quota ledger (guardian usage folded from per-repo run rows read-only), guardian priority admission, guardian rate-limit fast-fail. Test: quota-exhausted trial in the latency proof |
| VERDICT_WAIT stalls for days | `verdict:stale` and `guardian:dead` escalations; fail-closed is never fail-quiet |
| Disk full / DB write failure | tx throws, no transition (fail closed), exit, launchd relaunch; notify fail-soft-never-silent |
| Budget or stuck | Wall-clock, turns, `--max-budget-usd` per phase, CLI-enforced so orphans self-bound; TIMEOUT, bounded retries (2), PHASE_FAILED |
| App not installed on target | Precondition probe escalates (`builder:app-install:<repo>` at the moment it blocks); never founder-token fallback |
| Ledger research gate | Empirically-selected protocol (§2.3.8); RESEARCH back-fills the real node either way |

---

## 13. What the guardian keeps doing meanwhile

Nothing in this programme changes guardian behaviour on watched repos. Specifically, throughout the rollout and after it:

- The per-repo guardian daemons keep their tick cadence, keep pinning PR heads, settling checks across ticks, reading reviewers four-state on both endpoints, computing the 7-clause worst-wins verdict, and publishing the neutral shadow check runs exactly as today. The review shadow week and verdict shadow week clocks keep running uninterrupted; `review/shadow.mjs` is untouched by every PR in this plan.
- FIX_CI dispatch (including the shipped `flakeAssessment` behaviour: wholly-flaky escalates with no attempt spent, mixed dispatches with the flaky job named), review-thread work, escalation dedup, and notify behave identically; `nextAction` gains **zero** builder branches; the builder is a sibling decider in a sibling process.
- Guardian per-repo DBs receive no builder writes; the builder reads them read-only over same-host WAL (quota derivation §10, merge-decision replay §9, guardian-liveness probe §8). The merge executor adds one additive table to the per-repo schema, `merge_decision` (§9, §11), written only by the guardian's own merge executor.
- The guardian's hub surface is exactly two narrow touches, both inside the merge executor and both landing dark: read-only `mergeEligible` reads, and the attested_push append for repair pushes on builder PRs, which flows through the guardian's own outbox as a witnessed write. Outside the merge executor the guardian never touches hub.db. In particular, the guardian writes nothing to the quota ledger: its worker-exit accounting stays in its own per-repo DB exactly as today, and the builder derives quota pressure from those rows read-only (§10).
- Shared-code touches, each verified by running the full guardian suite in its PR: the profile `FIELDS` additions (FIELDS lands first in the same PR as any new key, or every daemon start dies), the merge executor (dark until profile authority flips as the final act of rollout; until then a PASS on an `owner` repo logs MERGE exactly as today), the sandbox containment fix (§4, which closes a live guardian hole and lands first), and the guardian dispatch path's rate-limit fast-fail (§10, which shortens an existing failure, never lengthens one).
- The guardian's known serial-dispatch defect (a long FIX_CI blinds verdict publishing for that repo) is deliberately **not** fixed here: out of scope, unchanged, documented in Open Questions. The quota fast-fail narrows its worst case (an hours-long quota-blocked await becomes a seconds-long failed attempt) without touching the loop's structure.
- The `ci.flakePatterns` schema key with zero readers gets its wire-or-remove decision inside this programme's profile work (PR-2), per the tracker's standing note.

---

## 14. Rollout: numbered PR plan with per-PR verification

Each PR lands green before the next; each stays at or under 10 files where possible (the review-rounds cliff applies to reeve too). New ctx keys default off, following the `ctx.reviewIngest !== false` opt-out pattern, so the existing guardian test files stay green untouched. The spec-PR step is **PR-7** in this numbering; its one external precondition (App access to nextly-ops) was completed by the founder and verified on 2026-08-21, so no rollout step waits on anyone.

1. **Sandbox containment fix (guardian-shared, lands first).** Credential-less worker git environment, per-worktree pre-push hook, same-commit assertion at the grant site. Closes the live `git -C` publishing hole for guardian workers today and for every builder worker to come. *Verify:* fixture worker attempts `git -C . push <token-url>` and `git -C . remote set-url`; both fail (no credential, hook refusal); full guardian suite green.
2. **Hub store, DDL, project registry, Rule-15 module, single-instance lock.** hubdb, leases with lifecycle, registry, boot visibility check, outbox-executor visibility probe and reeve-token lint as a module (first callers arrive with PR-7), `reeve build run` flock. Profile FIELDS for `builder.*`, plus the `ci.flakePatterns` wire-or-remove decision. *Verify:* 20-way lease race, one winner; lease released on every terminal transition and BLOCKED, re-granted through the intersection check on resume; territory-less admission refused, `**` blocks all grants; visibility public and UNKNOWN both refuse; second `build run` instance refuses; guardian suite untouched-green.
3. **Merge executor (guardian, dark).** `mergeEligible` reading both stores, builder-PR structural detection with the two clause sets (U1-U4 universal, B1-B6 builder-only), the `merge_decision` table and its write on every evaluation, attested-chain verification, PROTECTION_UNMET path, first caller of outbox `gh.pr.merge` plus `reconcilePrMerge`, behind `authority: propose_and_merge` which no profile yet sets. *Verify:* full clause matrix, each witness falsified individually blocks; UNKNOWN blocks; **the ordinary-PR path**: an ordinary guardian PR with PASS at H merges on the universal clauses alone, and the builder clauses are provably not evaluated for it; empty reviewer roster blocks a builder PR (B5) while leaving ordinary-PR semantics unchanged; task not in VERDICT_WAIT blocks (B3); stale ledger sync blocks (U3); stale or absent ownership_check blocks a ledger-sourced builder PR while a founder-filed one records the clause out-of-scope-by-kind (B6); builder-shaped PR without impl_pr row blocks and escalates `merge:unbound`; guardian repair push (attested) still merges, foreign commit blocks (B1); `--match-head-commit` mismatch fails closed; every evaluation, merge and refusal, writes a merge_decision row and `reeve task why` replays it; dry-run against a real PASS PR; full guardian suite green. The authority flip itself is deferred to PR-10.
4. **Phase engine.** `phases.mjs` pure machine (CLAIMING and both held states included), `phase_run` with durable output paths, the §3.2 CAS shape with terminal-transition voiding, `held_from` recording, `reeve task resume [--redesign]` (§3.4), adopt-or-kill restart, crash-resume, stub phases. *Verify:* full transition-matrix table test including BLOCKED → held_from, BLOCKED → DESIGN (--redesign), and ESCALATED → failed-phase-with-fresh-budget; resume refused on territory conflict and on lost ownership; kill-and-resume idempotence; adopt path and kill path each exercised; CAS lost-race no-op; terminal transition voids pending outbox rows and voided rows stay void through resume.
5. **Intake and the claim protocol.** `reeve task file` (territory required), import with hub-row-first ordering, claim as outbox effect under flock, verify-after-push CAS, LOST with nothing appended, orphan-claim sweep, ownership re-verify with the full-sync list, write-back, dedup. **Ships with the research-gate measurement** (§2.3.8), recording which protocol won as a committed doc plus hub fact. *Verify:* 20-way race through reeve's path, one verified winner; human-wins-after-reeve leaves the human as owner; kill between hub insert and claim settle recovers to exactly one of {owned, LOST}; orphan sweep fires; double-import no-op; territory refusal messages identical for file and import.
6. **SIZING / RESEARCH / DESIGN workers.** Sandbox actions, `reviewArtifact` (sibling function, both dispatch seams assert their gate), `--agents` fan-out plumbing, per-action budget/model/effort knobs, malformed-report drill, resume-through-the-seam with the settings hard-fail. *Verify:* extend `prompt-sandbox-agreement` to builder actions; resumed argv equals original settings payload; artifact-gate refusals; adopted-worker report parsed from file; one real scout task run through to artifacts.
7. **Spec PR and the gate.** The external precondition is already satisfied and verified (App access to nextly-ops, 2026-08-21); `reeve builder doctor` re-confirms it at PR time and the `builder:app-install:<repo>` escalation guards any future configuration. Spec worktree, outbox push/create/comment/review-request through the Rule-15-checked executor, `gate.mjs` with the §7.3 table, the strict-grammar matcher with fixture tests built from the live #1129/#1130 comment corpus, the founder-event classifier including the depth-override branch, the 15-minute server-clock window, the clean-pass notification, `reeve task go --sha`, round-keyed revision pushes, the post-GATE watcher. *Verify:* gate table exhaustively, all six rows crossed with head-moved cases, UNKNOWN never proceeds; founder free-text comment holds the clock; founder depth-override comment during GATE stops the clock and lands the task in DESIGN, never APPROVED; a refusal-shaped "no issues" comment does not match; SHA-binding (approval at rev1 never approves rev3; bare `go` refuses); crash between push settle and transition yields one revision per round; extend `escalation-dedup` with `bt:` grammar, hub-state retirement, and the no-interpolated-key test.
8. **IMPLEMENT and handover.** Per-slice worktrees, spec materialization via `git show` at the approved head with recorded sha256, file-cap and gate-definition-denylist diff gates, neutral `mp/` branches, push/PR-create via App with attested_push and the one-tx impl_pr write, guardian pickup, guardian repair-push attestation, VERDICT_WAIT poller with staleness and guardian-liveness escalations, post-approval depth-override hold, slice loop. *Verify:* territory-violation, over-cap, and harness-touch refusals; stale local design.md differs from approved SHA and the approved bytes win; handoff leaves zero live `bt:` run and a released worktree; kill between pr-create settle and impl_pr write, guardian refuses merge; depth override during IMPLEMENTING yields BLOCKED and `resume --redesign` closes the slice PR; extend `dispatch-e2e` (guardian picks up a builder-opened PR, repairs it, chain stays intact).
9. **Dash, doctor, launchd, concurrency and quota proof.** `reeve dash`, `reeve builder doctor`, `com.revnix.reeve.builder.plist` (node v24 pinned), the quota ledger (builder-written, guardian usage folded from per-repo run rows read-only) and guardian-priority admission, guardian rate-limit fast-fail, two-task parallel run. *Verify:* guardian tick latency measured unchanged while the builder runs, in BOTH trials: loaded-machine and quota-exhausted; the quota ledger demonstrably reflects a guardian FIX_CI run without any guardian hub write; dash renders UNKNOWN as UNKNOWN; doctor probes all green or names the blocker.
10. **Go-live.** Flip profile authority to enable the merge executor; first production task is one XS `task:scout-*`. The gate is armed from day one, so the first spec PR is itself the private-repo Codex measurement: expect the WAIT row first (79% refusal rate), proving never-proceed-on-silence live; the first strict-grammar clean pass then proves the 15-minute path with the founder watching the notification arrive; the first live merge happens on that scout PR with the founder watching. Then pilot 2 or 3 scouts, refine prompts, scale.

---

## 15. Resolved contradictions (which source lost, and why)

1. **Research gate at claim**: judged factual, not stylistic; PR-5 resolves it empirically against a copy of the live ledger; the conforming no-force path is preferred if it does not self-block. The losing posture was picking a side without measuring.
2. **`reviewArtifact` shape**: the optional `gate` parameter lost to the sibling function (all three judges): an optional safety parameter is the exact failure class that bit four times in one day; a separate mandatory function removes the class instead of asserting around it. The same ruling now also governs resume dispatch (§4): the settings parameter hard-fails rather than defaulting.
3. **Merge executor ordering**: "merge lands LAST" lost to "lands early, dark": the riskiest wiring soaks longest under test, while guard-lands-last is honored by deferring the authority flip, the actual widening, to PR-10. Code early, capability last.
4. **`--fast` gate skip**: lost. Pre-authorization at filing binds to no head SHA; no size or flag skips the gate; trivial tasks get short specs, not no specs.
5. **Terminal state for lost claim races**: explicit **LOST** won: quiet, terminal, no alarm, durable, visible in dash. Post-findings refinement: LOST appends nothing to the ledger (§2.3.6).
6. **Per-phase model and effort**: per-action knobs won: sonnet/low for SIZING triage, fable/high for RESEARCH, DESIGN, IMPLEMENT; meaningful cost control at zero safety cost.
7. **Ownership re-check cadence**: every-transition re-verify won; post-findings refinement: the full-sync list covers every externally visible transition, IMPL_PR_OPEN and resume included (§2.4).
8. **Gate timers**: the synthesis's 30-minute founder window and its founder-first table are **superseded by the founder's 2026-08-21 revision** (§7.3): Codex clean is a mandatory serial witness, and the founder window is 15 minutes from the Codex clean-pass timestamp. The WAIT row's re-request and escalate cadence remains profile-tunable (`builder.gate.rerequestMinutes`, `escalateMinutes`, defaults 60 and 120).

---

## 16. Open questions (what the measurements could not settle)

1. **Does Codex review on private repos at all?** Installed with selection=all, but zero reviews exist on any private revnix or nextly-ops PR ever. The first spec PR (PR-10's scout) is the measurement; `reeve builder doctor` reports the current answer. Because Codex clean is now a mandatory serial witness, a Codex-dead spec repo blocks every task at WAIT, founder approval included; that is safe but not live, which is exactly why question 2 exists. Grammar drift on a responding Codex degrades to WAIT too, and doctor surfaces "requests sent, nothing ever matched".
2. **NEW, for the founder: should the emergency Codex waiver exist?** Designed (§7.3) as `reeve task go bt:<id> --sha <prefix> --waive-codex "<reason>"`: founder-only, loud, durably recorded, quoted at the merge boundary, escalated so it is never quiet. It is the only path forward if Codex never responds on nextly-ops. Options: ship it enabled, ship it dark behind a profile flag, or refuse it and accept that a Codex-dead spec repo halts the builder until Codex is fixed. Until ruled, it does not exist.
3. **Does the research-node-first claim protocol self-block?** Resolved empirically in PR-5 (§2.3.8); both protocols are specified.
4. **Ledger claim serialization, long-term.** flock is the honest interim; the ledger's own plan (SQLite WAL store, salvaged spike passing 29/29) is the successor. Who migrates human lanes onto it, and when, is a founder decision outside this programme.
5. **Second-project onboarding.** revnix repos need a fresh App installation (founder action); rext and 21century have no ledger yet, so intake there is founder-filing only. The registry and per-project specRepo fields are ready; nothing else is assumed.
6. **The guardian's serial-dispatch defect** remains: a long FIX_CI blinds verdict publishing for that repo. The builder deliberately does not inherit it, and the quota fast-fail (§10) caps its worst case, but fixing the guardian loop is its own future programme.
7. **IMPLEMENT budgets (60-90 min) are guesses.** Calibrate from the first pilots; the knobs are per-action profile fields, so tuning is config, not code.
8. **Does `gh.review.request` alone trigger Codex on nextly-ops, or is the trigger comment required?** Both are posted (standing rule), so the answer is observable without being load-bearing.

(The synthesis's former question about calibrating a "substantive clean pass" classifier is closed: the founder's revision replaced calibration with the strict grammar measured live on #1129/#1130, armed from day one and failing closed.)

---

## Appendix A. Findings disposition: all 29, where each fix now lives

| # | Finding (short title) | Severity | Where the fix lives |
|---|---|---|---|
| 1 | "Founder silent" undefined; unclassified activity falls through | critical | §7.3 (silence = zero founder events; HOLD row 4 plus `gate:founder-unclassified`); §5 and §7.3 (depth override is a classified founder event: stops the clock, re-enters DESIGN) |
| 2 | Row 3 armed with an uncalibrated clean-pass classifier | critical | §7.3: superseded by the founder's strict-grammar decision (exact template plus reviewed-commit prefix match, fail-closed, armed day one); §16 note |
| 3 | Resume can relaunch a worker without its sandbox | critical | §4 (resume through the dispatch seam; workerArgs hard-fails on null settings); §12 row; PR-6 verification |
| 4 | Nothing consumes founder activity after APPROVED | serious | §7.5 (post-GATE spec-PR watcher, `spec:reopened`); §9 clause B4 |
| 5 | `reeve task go` binds a head the founder never read | serious | §7.4 (`--sha` required, refuse on mismatch, prefix in every notification and spec revision) |
| 6 | Merge-time ledger BLOCKS check has no freshness contract | serious | §9 clause U3 (sync inside mergeEligible, fail to UNKNOWN, timestamp recorded in the merge decision row) |
| 7 | pushed_head_sha custody undefined after guardian pushes | serious | §8 and §9 clause B1 (attested head chain, append-only, both pushers via outbox) |
| 8 | Verification harness inside the worker's writable territory | serious | §8 (gate-definition denylist, `impl:harness-touched`, base-revision gate definitions) |
| 9 | Rule 15 leaks through impl PRs; visibility checked only at boot | serious | §1 (outbox Rule-15 lint, executor-time visibility probe) and §8 (neutral naming) |
| 10 | Absent or empty territory admits a collide-with-everything task | serious | §2.2 and §10 (territory REQUIRED at filing; empty means `**`; NOT NULL in §11) |
| 11 | VERDICT_WAIT can stall silently forever | minor | §8 and §11 (`verdict:stale`, `guardian:dead` escalations) |
| 12 | Guardian repair pushes permanently disqualify builder PRs | critical | §8 and §9 clause B1 (attested chain admits reeve's repairs, blocks foreign commits; FIX_CI-then-PASS-merges test) |
| 13 | Crash between ledger claim push and hub insert orphans the task | critical | §2.3 (hub row first, claim as outbox effect, reconciler, orphan-claim sweep and doctor probe) |
| 14 | Lost-race "release" un-claims the human winner's task | critical | §2.3.6 (append nothing on a lost race; LOST hub-side; conditional retraction only under flock with owner-is-reeve precondition) |
| 15 | Restart with a surviving detached worker: wedge or double-occupancy | critical | §3.3 (durable output files, adopt-or-kill, CLI-enforced worker bounds, single-instance flock in §1) |
| 16 | CANCELLED task's open slice PR still auto-merges on PASS | serious | §9 clause B3 (task liveness) and §3.2.5 (terminal transitions void outbox rows, close the PR) |
| 17 | Territory leases have no lifecycle; founder filings bypass the check | serious | §10 (grant in admission tx for both paths, release on terminal and BLOCKED, re-grant on resume §3.4, expiry, slice-start re-check, `candidate.skipped` event) |
| 18 | Builder workers exhaust the subscription and freeze guardian verdicts | serious | §10 (builder-written quota ledger folding guardian run rows read-only, guardian priority, guardian rate-limit fast-fail) and PR-9's quota-exhausted trial |
| 19 | Rule-15 visibility check is boot-time only | serious | §1 (outbox-executor visibility probe with TTL cache, `spec:visibility`, doctor) |
| 20 | Builder-PR detection undefined; crash can route around the gate | serious | §9 (structural detection, incomplete chain never merges, `merge:unbound`) and §8 (pr-create settle plus impl_pr write in one tx) |
| 21 | Ownership full-sync list omits IMPL_PR_OPEN | minor | §2.4 (full sync before every externally visible transition, IMPL_PR_OPEN and resume named) |
| 22 | REVISING crash-rerun burns the revision cap on re-derived SHAs | minor | §3.2 (round-keyed push idempotency; cap counts distinct findings-rounds) |
| 23 | `git -C` bypasses the push deny while `Bash(git:*)` allows it | critical | §4 (containment by authority: credential-less env, pre-push hook, pushurl; string patterns named honestly as non-enforcement); rollout PR-1 |
| 24 | Merge boundary severed from the authorization evidence in the hub | critical | §9 (single mergeEligible reads both stores; hub reads fail closed; approval SHA replayable in the merge decision row, DDL in §11) |
| 25 | Impl branch name `reeve/...` pushed to the public repo | serious | §8 (neutral `mp/` branches, `merge-policy[bot]` author) and §1 (lint plus doctor assertion) |
| 26 | IMPLEMENT reads a slice plan not bound to the approved head | serious | §8 (materialize spec.md and design.md via `git show` at the approved SHA; sha256 recorded) |
| 27 | Empty reviewer roster makes review PASS vacuous at the merge | serious | §9 clause B5 (empty roster is UNKNOWN for builder PRs; real witness or durable founder authority required) |
| 28 | FIX_CI moves the head but the hub record never updates | minor | §8 (guardian repair pushes append attested_push via outbox; §9 clause B1 compares against the chain, not "whatever we last saw") |
| 29 | Escalation dedup keys leak descriptive detail into the identity | minor | §11 (two-field escalations enforced; no-interpolation test in PR-7) |

Every row above is design text in its named section, not a changelog entry; a fresh reader of any section sees one coherent mechanism.