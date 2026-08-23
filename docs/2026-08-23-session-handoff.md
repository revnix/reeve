# Session handoff — 2026-08-23

Supersedes `docs/2026-08-22-session-handoff-2.md` for anything they disagree on.
That one described a reeve that had never dispatched a worker. **That stopped
being true today.**

Everything here is either **measured** (with a date and the file that records it)
or marked **intent**. If a claim has neither, distrust it.

Durable companions: `docs/TRACKER.md` (done / in flight), `docs/HANDOFF.md`
(design reasoning), `docs/2026-08-21-builder-design.md` (the builder spec),
`docs/measured/*` (the facts).

---

## 0. The one-paragraph truth

**reeve is armed.** `--execute` is live on the running daemon, `worker.isolation`
is `scratch-home`, and it will dispatch a real worker at the next red CI on
`nextlyhq/nextly`. It has now run **three real workers** (in a sandboxed
experiment, not on nextly) and they produced three correct fixes and published
**none** of them, because the work was never committed. The founder has seen that
and chosen to leave the settings as they are: the proper turn-on waits until the
BUILDER programme is done, and today's arming is an evidence-gathering run.

---

## 1. What changed today

| | before | now |
|---|---|---|
| `--execute` | off | **ON** — verified on the running process, not just the plist |
| `worker.isolation` | unset (dispatch refused) | `scratch-home` |
| `watch` limits | none (defaults: 20min / 40 turns / 5 workers) | **10 min / 20 turns / 1 worker** |
| PR #14 | open | merged (`16769e7`), 10 rounds, 22 findings |
| PRs #1, #2 | open since 20 Aug | **closed** — both superseded/empty |
| dispatch evidence | never run | **3 real runs, $2.66**, recorded |

`main` is `16769e7`. The daemon runs from `~/Work/Products/reeve` and was
restarted onto it.

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

## 3. What the three real dispatches measured

Full write-up: `docs/measured/2026-08-23-three-real-dispatches.md` (PR #15).

The experiment was built to find a **confidently bad fix**. It did not find one.

| run | turns | outcome | cost |
|---|---|---|---|
| 1 | 20 | `failed (max_turns)` | $0.758 |
| 2 | 40 | `failed (max_turns)` | $0.994 |
| 3 | 40 | `ok (completed)` | $0.910 |

Three byte-identical **correct** fixes. No test weakened, no territory left. And
**nothing published, 3/3**, because the work was never committed.

The safety machinery was right 3/3: uncommitted → refused → preserved →
escalation naming the files.

**Findings:**

1. **The worker leaves litter it cannot delete, and the litter blocks the push.**
   It creates a scratch file probing whether it can write; `rm` is not granted;
   that file counts as an uncommitted change and blocks publication on its own.
2. **Refusals are opaque, so it retries instead of adapting.** 28 of 40 turns in
   runs 1–2 went on retrying refused commands. This is why 20 and then 40 both
   ran out — **a larger budget buys more retries of the same refusals.**
3. **An unrecognised `units[].language` silently grants no runtime.** `UNIT`
   validates only that it is a string; `sandbox.mjs` does `RUNTIMES[lang] ?? []`.
   Nothing live is affected (detection only emits `typescript`).

**What it does NOT establish:** that any of this reproduces on nextly. The
fixture had no lockfile and no `node_modules`, which is what sent the worker
guessing. Only a real dispatch settles it.

**The standing cost:** `maxFixAttemptsPerFinding` is **1**, and the attempt is
spent when the RUN succeeds (`daemon.mjs:857`), not when publication does —
verified as one unrefunded `fix_attempt` row. So each red PR gets one shot, and
on this evidence it is spent producing a fix that does not ship.

---

## 4. Founder decisions made today — do not re-litigate

1. **Arm it fully, with merge authority intact.** The concern about
   `propose_and_merge` + admin + a bypassable ruleset was raised and the founder
   reaffirmed. GitHub rules get fixed "at the end".
2. **Worker limits: 10 min / 20 turns / 1 worker.** Applied.
3. **Leave the attempt cap at 1** and leave reeve armed, after seeing that each
   red PR spends its only attempt on a fix that will not publish. Reason given:
   *"we can turn on it properly once reeve's builder part is done."*
4. **Close PRs #1 and #2.** Done, with the reasoning recorded on each.
5. **One parallel session on the `threadDetails` wiring.** Prompt was written and
   handed over.
6. **`git push --dry-run` in doctor: declined.** The one-off check was run by
   hand instead — both repos returned PUSH AUTHORISED.

---

## 5. Who owns what right now

| lane | owner | branch / worktree |
|---|---|---|
| S2-A/B/C plans (#11/#12/#13) | peer session | `reeve-wt/pa`, `pb`, `pc` |
| `threadDetails` wiring | a session the founder started | `feat/thread-details` (to be created) |
| docs PR #15 | this session | `docs/first-dispatches` @ `reeve-wt/paths` |

**A freeze is in force and was promised to the threadDetails session:**
`src/daemon.mjs` and `docs/TRACKER.md` are not to be edited until their PR lands.
A tracker entry is **owed** for: PR #14, the arming, the limits, and the three
dispatches. Fold it in when the freeze lifts.

---

## 6. Traps that cost real time today

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
- **The commit hook blocks the word "Claude" in PR bodies**, including factual
  uses. Rewrite rather than argue.
- **Stale claims outlive the code they described.** PR #14 produced three
  comments that described behaviour removed in a later round of the same PR.
  Removing a reading is not finished until every sentence that depended on it has
  been re-read.

---

## 7. What is left, by programme

### Programme 1 — the GUARDIAN (~75–80% done)

| # | capability | state |
|---|---|---|
| 1 | Watch, judge, escalate | **ON** |
| 2 | Fix red CI | **ON as of today** (but see §3 — it publishes nothing yet) |
| 3 | Work review threads | off — half claimed (threadDetails), half blocked |
| 4 | Refuse an unsafe merge | off — needs shadow week + the ruleset flip |

Capability 3's other half is blocked on a **design question the founder has not
settled**: the tracker says REQUEST_REVIEW/SPILL effects "must be performed by
reeve through the outbox", but **there is no outbox** — it arrives with the
builder at S2/S4. Meanwhile reeve already makes 7 direct `gh` calls in
`src/github/`. Either wait, or do it directly and migrate later.

Also open: ntfy read user (needs shell on 95.217.11.127), second project
(`rextaihq/rext-backend`), PR-open size warning (optional).

### Programme 2 — the BUILDER (~15%, 2 of 13 stages)

S0 and S1 are done. S2 is in planning as three chained PRs (#11 → #12 → #13,
each explicitly based on the previous one's merge commit). S3–S12 not started.

**S2 cannot be parallelised** — the plans say so themselves, with a reason: the
tests open a hub, and rebasing across a changed `hub.sql` silently changes what
they test.

Estimated **40–65 PRs remaining**, putting the whole build at roughly **12–16%**.
That estimate extrapolates from one data point (S1 = 8 PRs) and should be treated
as a rough order of magnitude. The real cost driver is review rounds, not code:
PR #14 took 10 rounds and 22 findings.

---

## 8. What needs the founder

- **R-01, the ruleset.** Admins bypass every rule and no CI check is required.
  Agreed to fix "at the end", but reeve now has `propose_and_merge` + admin, so
  nothing outside reeve stops a bad publish from merging.
- **The outbox question** (blocks half of capability 3).
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

- **reeve is armed and, on today's evidence, cannot publish.** Each red nextly PR
  will spend its one attempt producing an unpublished fix, for ~$1. Accepted by
  the founder; revisit if the first real dispatch confirms it.
- **The first real dispatch has not happened.** Everything in §3 is from a
  synthetic fixture whose bareness may have caused the flailing. A watcher is
  running to capture the real one in full.
- **`maxTurns: 20` is probably too tight** even for good work — measured, a
  correct fix ran out of turns twice. Raising it alone will not help (finding 2).
- **The guardian's dispatch is effectively parked** until the builder lands, by
  the founder's own framing. That is weeks to months.
