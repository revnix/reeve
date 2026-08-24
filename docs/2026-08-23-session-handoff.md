# Session handoff — 2026-08-23

Supersedes `docs/2026-08-22-session-handoff-2.md` for anything they disagree on.

Everything here is either **measured** (with a date and the file that records it)
or marked **intent**. If a claim has neither, distrust it.

Durable companions: `docs/TRACKER.md` (done / in flight), `docs/HANDOFF.md`
(design reasoning), `docs/2026-08-21-builder-design.md` (the builder spec),
`docs/measured/*` (the facts).

---

## 0. The one-paragraph truth

**reeve is DISARMED, because it could not publish.** `--execute` was removed from
the plist on 23 Aug and the running process verified without it; `worker.isolation`
remains `scratch-home`. It still watches, judges and escalates — it just does not
dispatch, so no attempt is spent at all.

When it is re-armed, eligible will be narrower than red: a missing required check,
an inherited-only failure, one reeve cannot name, one already at cap, and a
demonstrated flake (`daemon.mjs:808-812`) all escalate without dispatching, and
containment and capacity can defer one earlier still.

Three dispatches under this contract produced three correct fixes and published
none of them, **for two different reasons**. Runs 1 and 2 hit `max_turns` and
never reached the publication gate at all. Only run 3 finished, and it could not
publish because **the worker cannot run `git add` or `git commit`** — the sandbox
that landed on 22 August denies Bash writes to `.git`. That part is a regression,
not a worker quirk: reeve published successfully three times on 21 August, before
that sandbox existed. Measured and controlled:
`docs/measured/2026-08-23-three-real-dispatches.md`, Finding 1.

---

## 1. What changed today

| | before | now |
|---|---|---|
| `--execute` | off | armed, then **DISARMED again** the same day once Finding 1 was understood — both verified on the running process, not just the plist |
| `worker.isolation` | unset (dispatch refused) | `scratch-home` |
| `watch` limits | none (defaults: 20min / 40 turns / 5 workers) | **10 min / 20 turns / 1 worker** |
| PR #14 | open | merged (`16769e7`), 10 rounds, 22 findings |
| PRs #1, #2 | open since 20 Aug | **closed** — both superseded/empty |
| dispatch evidence | last measured 21 Aug, pre-sandbox | **3 runs under the new contract, $2.66**, recorded |

`main` was `16769e7` at the time of writing and is now `bc17a06` (#17). The
daemon runs from `~/Work/Products/reeve`.

---

## 2. The live configuration, exactly

```
worker    : {"isolation":"scratch-home"}
watch     : {"workerBudgetMinutes":10,"maxTurns":20,"maxWorkers":1}
rounds    : {"softCap":5,"hardCap":10,"maxFixAttemptsPerFinding":1}
authority : propose_and_merge / admin
```

Backups exist for every change: `~/.reeve/profiles/nextlyhq/nextly.json.bak-arm-*`
and `.bak-limits-*`, and `~/Library/LaunchAgents/com.revnix.reeve.plist.bak-arm-*`.
Reverting the arming is: remove `--execute` from the plist, `launchctl bootout`
then `bootstrap` (see the trap in §6 — `kickstart` is not enough).

**`doctor` reads `broken`, on R-01 and R-03 only.** Both are the founder's:
R-01 is the ruleset (admins bypass everything, no required status checks), R-03
is merge shape. Everything else is OK or DEGRADED-by-design.

---

## 3. What the three dispatches measured

Full write-up: `docs/measured/2026-08-23-three-real-dispatches.md` (PR #15).

**These were not reeve's first dispatches.** reeve dispatched real workers on
20–21 August (`f60fbbb`, `866b9ba`) and `docs/HANDOFF.md:442` records three that
published, CI-verified. These three are the first under the contract that landed
on 22 August: the OS sandbox (`1a2fbea`) plus scratch-HOME standalone checkouts
(`0fdf351`). That distinction is the whole story.

The experiment was built to find a **confidently bad fix**. It did not find one.

| run | turn limit | outcome | cost |
|---|---|---|---|
| 1 | 20 | `failed (max_turns)` | $0.758 |
| 2 | 40 | `failed (max_turns)` | $0.994 |
| 3 | 40 | `ok (completed)` | $0.910 |

Three byte-identical **correct** fixes. No test weakened, no territory left. And
**nothing published, 3/3**.

The dirty-checkout gate fired **once**, on run 3. Runs 1 and 2 were unfinished
runs, routed at `daemon.mjs:1161` (`outcome !== OK`) before the gate at
`daemon.mjs:1187` (`outcome === OK`) could see them.

**Findings:**

1. **(P0) The worker cannot commit.** `git add`/`git commit` fail with
   `EPERM` on `.git/index.lock` — six times in run 3, across seven attempts, and
   the worker spent 13 of its 36 turns diagnosing it. Two controls: a Bash write
   elsewhere in the same worktree **succeeded**, and an identical copy of the
   worktree commits fine **unsandboxed**. reeve's own settings do not cause it
   (`denyWrite: []`; `.git/**` denied only for `Edit`/`Write`/`NotebookEdit`) —
   the agent CLI's sandbox layer imposes it. **Publication is structurally
   impossible under this contract, for every repository.**
2. **The prompt promises commands the grant does not include.**
   `src/prompts.mjs:31` says "`pnpm test` is permitted"; this fixture granted
   `pnpm` by neither route — no `packageManager` and no declared command whose
   runner was `pnpm` — and run 3's grant had `npm`.
   `prompts.mjs:33-34` also tells the worker never to use an absolute path,
   while `sandboxFor` grants `Bash(${process.execPath}:*)` unconditionally.
3. **An unrecognised `units[].language` grants no runtime BY LANGUAGE.** `UNIT`
   validates only that it is a string; `sandbox.mjs` does `RUNTIMES[lang] ?? []`,
   and there is no `javascript` key. Three other routes survive: a declared
   `packageManager` (`sandbox.mjs:361`), a declared command as
   `Bash(<runner> <first arg>:*)` (`:348-355`), and the absolute `execPath`. Only
   a unit with none of the three is left with the interpreter alone — which
   finding 2's instruction then forbids using. Nothing live is affected
   (detection only emits `typescript`).
4. **The worker leaves litter, and does not reach for the tool that removes it.**
   A Bash-redirect scratch file; `rm` is not granted, and three attempts at it
   were refused. But `git clean -f --` was available the whole time (`Bash(git:*)`
   is granted and `git clean` writes nothing under `.git`), so this is a gap in
   what the worker was told, not a boundary. It would block a push on its own —
   but it is not why nothing published, because nothing was committable anyway.

**Withdrawn:** an earlier draft claimed the worker burned "28 of 40 turns"
retrying refusals across runs 1–2. The fixture reuses one path, so run 3
overwrote those transcripts and the state DB. It cannot be re-verified. Run 3,
which survives: 36 tool calls, 18 errors, 8 "requires approval".

**What it does NOT establish:** that findings 2–4 reproduce on nextly — the
fixture had no lockfile and no `node_modules`. **Finding 1 does** apply
everywhere; it is in the contract, not the fixture.

**The standing cost:** `maxFixAttemptsPerFinding` is **1**. The attempt is
recorded when the run starts (`daemon.mjs:857`) and refunded if preparation or a
pre-bind cancellation fails (`:1043`, `:1066`), so it is spent once worker
execution begins — never conditional on publication. Verified as one unrefunded
`fix_attempt` row after a refused publication. Not every red PR spends it —
`watcher.mjs:120-136` escalates a missing required check, an inherited-only
failure, one already at cap, or one it cannot name without dispatching at all,
and `daemon.mjs:808-812` then declines a caused, named failure whose checks are
ALL demonstrated flakes before `startRun`. A caused, named, not-wholly-flaky
failure past the containment and capacity gates gets one shot, and on this
evidence it is spent producing a fix that cannot ship.

---

## 4. Founder decisions made today — do not re-litigate

1. **Arm it fully, with merge authority intact.** The concern about
   `propose_and_merge` + admin + a bypassable ruleset was raised and the founder
   reaffirmed. GitHub rules get fixed "at the end".
2. **Worker limits: 10 min / 20 turns / 1 worker.** Applied.
3. **Leave the attempt cap at 1.** Still current. The other half of this
   decision — leave reeve ARMED — was SUPERSEDED the same day: it was taken on the
   belief that publication merely *had not* worked, and once Finding 1 showed it
   *cannot*, reeve was disarmed. Do not restore the armed half from this list; it
   is recorded here only so the reversal is legible.
4. **Close PRs #1 and #2.** Done, with the reasoning recorded on each.
5. **One parallel session on the `threadDetails` wiring.** A prompt was written
   and handed over, and that session never pushed a branch. The work is still
   open and nobody holds it.
6. **`git push --dry-run` in doctor: declined.** The one-off check was run by
   hand instead — both repos returned PUSH AUTHORISED.

---

## 5. Who owns what right now

| lane | owner | branch / worktree |
|---|---|---|
| S2-A/B/C plans (#11/#12/#13, #17) | **merged** | — |
| `threadDetails` wiring | never started; no branch was ever pushed | — |
| docs PR #15 | this session | `docs/first-dispatches` @ `reeve-wt/paths` |
| prompt/grant PR #18 | this session | `fix/prompt-grant-agreement` @ `reeve-wt/prompt-grant` |
| the P0 fix PR #19 | this session | `fix/reeve-commits` @ `reeve-wt/commits` |

**The daemon freeze was lifted on 23 Aug.** It was promised to a `threadDetails`
session that never pushed a branch, and PR #19 needed `src/daemon.mjs` to fix the
P0. `docs/TRACKER.md` is still untouched, and an entry is **owed** for: PR #14,
the arming, the limits, the three dispatches, Finding 1 and its fix. Fold it in
once those PRs land.

---

## 6. Traps that cost real time today

- **Do not inherit a factual claim from a handoff.** This session was told
  "reeve has never dispatched a worker", repeated it in three documents and a PR
  body, and it was false — reeve had dispatched at least eleven times and
  published three. Re-verifying it is what uncovered the P0. A resume prompt is
  a starting point, not evidence.
- **`launchctl kickstart` restarts from launchd's CACHED plist.** The file said
  `--execute`; the running process did not have it. Use `bootout` +
  `bootstrap`, and verify with `ps -o args=`, never by reading the file.
- **`loadProfile` runs ONCE at startup**, before the tick loop. A profile edit is
  not in force until the daemon restarts.
- **`git diff main..branch` is not what a PR proposes.** It shows tree
  difference. I nearly reported PRs #1/#2 as destructive on that basis; the diff
  from their MERGE BASE showed 21 lines and zero. Always compute from
  `git merge-base`.
- **A test that checks a helper works is not a test that it is wired in.** In
  PR #14, three assertions all passed with the code they tested deleted. Only the
  stub loop caught it. This happened twice in one PR.
- **A fixture that reuses one path destroys its own evidence.** Runs 1 and 2 are
  unrecoverable because run 3 overwrote the transcript directory and the state
  DB. Give each run its own root.
- **The commit hook blocks the vendor's name in commits and PR bodies**,
  including factual uses. Rewrite rather than argue.
- **Stale claims outlive the code they described.** PR #14 produced three
  comments that described behaviour removed in a later round of the same PR.
  Removing a reading is not finished until every sentence that depended on it has
  been re-read.

---

## 7. What is left, by programme

### Programme 1 — the GUARDIAN (~75–80% built, but capability 2 is down)

| # | capability | state |
|---|---|---|
| 1 | Watch, judge, escalate | **ON** |
| 2 | Fix red CI | **off** — disarmed on 23 Aug because it could not publish; PR #19 is the fix (§3 Finding 1) |
| 3 | Work review threads | off — the `threadDetails` half was never started, so all of it is open |
| 4 | Refuse an unsafe merge | off — needs shadow week + the ruleset flip |

Capability 3's other half needs a routing decision. The tracker says
REQUEST_REVIEW/SPILL effects "must be performed by reeve through the outbox".
**The outbox exists** — `src/db/schema.sql:110-130` defines the table with
`gh.pr.comment` and `gh.thread.resolve` among its kinds, and `src/db/ops.mjs:239-284`
implements enqueue / lease / complete / fail / recover. It has **zero callers
outside `src/db/`**, and no drainer.

The choice is WHEN, not whether. `docs/TRACKER.md:39-43` records the precondition
in terms that do not leave a third option: before `watch.reviewActions` arms,
those GitHub effects "must be performed by reeve through the outbox (the design's
rule), never by a worker." So it is either wire and drain the existing skeleton
now, or wait to reuse the builder's drainer at S2/S4. reeve calling `gh` directly
from 16 other places does not relax a durability requirement written for these
two actions — an earlier draft of this document listed it as a third route, and
taking it would break the recorded rollout invariant rather than complete
capability 3.

Also open: ntfy read user (needs shell on 95.217.11.127), second project
(`rextaihq/rext-backend`), PR-open size warning (optional).

### Programme 2 — the BUILDER (~15%, 2 of 13 stages)

S0 and S1 are done. **The three S2 plan PRs have merged** — #11 (`f8cb926`),
#12 (`4eb2abf`), #13 (`2dc6e67`) and their follow-up #17 (`bc17a06`) — so S2 is
planned but not built. S3–S12 not started.

**S2 cannot be parallelised** — the plans say so themselves, with a reason: the
tests open a hub, and rebasing across a changed `hub.sql` silently changes what
they test.

Estimated **40–65 PRs remaining**, putting the whole build at roughly **12–16%**.
That estimate extrapolates from one data point (S1 = 8 PRs) and should be treated
as a rough order of magnitude. The real cost driver is review rounds, not code:
PR #14 took 10 rounds and 22 findings.

---

## 8. What needs the founder

- **Finding 1: decided and in flight.** The founder chose reeve-side staging and
  committing, and disarmed reeve meanwhile — `--execute` is off, verified on the
  running process. PR #19 implements it. Until that lands, reeve watches, judges
  and escalates but does not dispatch, so no attempt is spent at all.

  Two details of the implementation are worth carrying, because the obvious
  reading of the decision is wrong on both. reeve commits BEFORE the gates, not
  after: the gates then judge the ref that gets pushed, exactly as they judged the
  worker's own commits, so nothing about what may ship changed hands. And reeve
  stages exactly the paths the worker declared in `filesTouched` rather than
  everything it left — staging by heuristic and excluding the dependency trees
  preparation had copied in produced four defects in four review rounds, each fix
  another exclusion rule, which is the shape that says the design is wrong rather
  than the instances.
  **Findings 1 and 2 are the fifth and sixth instance of the same shape** — the
  prompt claiming a capability the grant does not carry; `docs/HANDOFF.md`
  tabulated four more on 21 August, including this exact one a step later in the
  sequence ("the prompt instructed a push the sandbox denies"). Patching `.git`
  alone leaves the mechanism intact — but generating the prompt from the DECLARED
  grant does not reach it either: reeve's own policy grants `Bash(git:*)`, carries
  no add/commit deny and emits `denyWrite: []`, so a generator reading it would
  still have advertised `git commit`. Five of the six are drift between two things
  reeve writes; the sixth comes from beneath them. The decision worth making is
  whether reeve represents or PROBES the EFFECTIVE restrictions.
- **R-01, the ruleset.** Admins bypass every rule and no CI check is required.
  Agreed to fix "at the end", but reeve now has `propose_and_merge` + admin, so
  nothing outside reeve stops a bad publish from merging.
- **The capability-3 routing**: wire and drain the outbox now, or wait for the
  builder's at S2/S4. Direct `gh` is not on the table — see §7.
- **ntfy read user** — all 5 tokens are write-only.
- **Whether to raise `maxFixAttemptsPerFinding`** from 1, given §3.

---

## 9. Verification commands

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"   # node 24 is a floor
cd ~/Work/Products/reeve && git fetch -q origin && git log --oneline -3 origin/main
for f in test/*.test.mjs; do node "$f" >/dev/null || echo "FAILED $f"; done
./bin/reeve doctor nextlyhq/nextly --as-app
ps -o args= -p "$(launchctl print gui/$(id -u)/com.revnix.reeve | awk '/pid = /{print $3}')"
tail -30 ~/.reeve/reeve.log
```

The `ps` line matters: it is the only way to know whether reeve is actually
armed.

---

## 10. Open risks

- **reeve cannot publish, which is why it is disarmed.** Not "has not yet" —
  cannot, by the contract, in any repository. That risk is currently held closed
  by the disarm rather than by a fix; PR #19 is the fix. If anyone re-arms before
  it lands, each ELIGIBLE red nextly PR — caused, named, not already at cap, not
  a demonstrated flake, past the containment and capacity gates — spends its one
  attempt for ~$1 and escalates.
- **`docs/HANDOFF.md:442` overstates the current state.** Its "Proven — three
  complete dispatches … reeve published → green" was true on 21 August and is
  not true now. Fix it when PR #19 lands.
- **The first real dispatch on nextly under this contract has not happened.**
  Everything in §3 is from a synthetic fixture. Finding 1 will reproduce there;
  findings 2–4 may not.
- **`maxTurns: 20` is probably too tight** even for good work — measured, a
  correct fix ran out of turns twice. Fixing Finding 1 should be measured first:
  13 of run 3's 36 turns went on an impossible instruction.
- **The guardian's dispatch is effectively parked** until the builder lands, by
  the founder's own framing. That is weeks to months.
