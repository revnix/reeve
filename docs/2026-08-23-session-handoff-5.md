# Session handoff: the S2 programme after the merge (2026-08-23, third handoff)

Supersedes `2026-08-23-session-handoff-4.md`. That document described three
plan PRs in flight; **they are merged.** Read this one. The companion resume
prompt is `docs/2026-08-23-resume-prompt-5.md`.

Everything here is either measured (with the command that measured it) or
labelled as intent.

---

## 1. Where things stand, in one table

| | |
|---|---|
| Repository | `revnix/reeve` (private) |
| `origin/main` | **`2dc6e67`** — "S2-C plan: the provider scheduler (#13)" |
| Live daemon | **RUNNING** from `~/Work/Products/reeve` against `nextlyhq/nextly`, launchd `KeepAlive` |
| S2 plans | **MERGED** — see §2 |
| My open PR | **#17** — the 24 deferred findings, `CLEAN`, CI green, 0 open threads, review pending |
| My open issue | **#16** — the deferred-findings record; #17 closes it |
| Other sessions' PRs | **#15** and **#18** — NOT mine, do not touch (§8) |

The 15-minute watcher cron is **cancelled**. Its targets merged.

---

## 2. The three plan PRs merged

Squash, in order, on 2026-08-23, with the founder's explicit grant and `--admin`:

| PR | merge commit | plan file | lines |
|---|---|---|---|
| **#11** S2-A hub store | `f8cb926` | `docs/superpowers/plans/2026-08-23-s2a-hub-store.md` | 5535 |
| **#12** S2-B phase machine | `4eb2abf` | `…-s2b-phase-machine.md` | 3994 |
| **#13** S2-C provider scheduler | `2dc6e67` | `…-s2c-provider-scheduler.md` | 2724 |

`main` went `16769e7` → `2dc6e67`. **Each merge was verified byte-identical to
the pushed head** — not assumed from the merge succeeding. `src/` and `bin/` are
unchanged across all three: these were documents only, so the running guardian's
code did not move.

Do **not** re-derive the merge from the branch heads. A squash merge never leaves
the branch head as an ancestor of `main`, so `git merge-base --is-ancestor` says
"FAIL" for all three and means nothing. Compare **file content**:

```bash
git show origin/main:docs/superpowers/plans/<f>.md | shasum
git show origin/plan/<branch>:docs/superpowers/plans/<f>.md | shasum
```

---

## 3. PR #17 — the work in flight right now

**Branch `fix/s2-plan-review-findings`, head `90a531c`, in `~/Work/Products/reeve-wt/pa`.**
Two commits, `887fb27` (S2-A) and `90a531c` (S2-B). `CLEAN`, `Test=SUCCESS`,
`CI Gate=SUCCESS`, **zero open threads**, and **no Codex review has arrived yet**
as of 16:37Z. It closes #16.

It applies all 24 findings deferred at the merge — 11 on S2-A, 13 on S2-B, none
on S2-C. Each was verified against the plan text or against `src/` before acting.
The five that would have shipped a real defect:

1. **Every builder escalation key was doubled.** Templates are
   `bt:<id>:infeasible`, a task id is already `bt:1`, so `.replace("<id>", taskId)`
   produced `bt:bt:1:infeasible` — a key the announcer, `task resolve` and §11.7
   all fail to match. The row is written and nobody is told. Fixed by replacing
   the whole `bt:<id>` token.
2. **A restore installed a stranger's `maintenance_lock`.** `restoreHub` cleared
   every process-scoped table *except* that one, on the stated grounds that "this
   restore holds it" — while the acquire above had returned `{ok:false}` against
   the snapshot's own live-looking lock row and the result was ignored. Fixed:
   clear the snapshot's lock first, acquire, **check the result**.
3. **Two daemons snapshotting one store in the same second could delete each
   other's file.** `snapshot()` now writes to a unique temp and renames, and
   returns `mine`; only a snapshot this process wrote may it validate or delete.
4. **A truncated tail restored silently.** Contiguity cannot see a file that
   stops early. `export-events --hub` now ends with a manifest footer, written
   last, so its absence *is* the truncation signal.
5. **A voided finalization effect read as complete**, letting a task commit DONE
   before the ledger write-back was re-enqueued.

**If #17 has picked up review findings by the time you read this**, work them the
same way as the plan PRs (§6) and push to the same branch. Do not open a second
PR.

---

## 4. Founder decisions — do not re-litigate

1. **Merge at zero-open, not at a clean pass.** Decided 2026-08-23 after ~490
   threads over 16 rounds with no clean pass ever arriving on any PR. Recorded in
   memory as `project_s2_stop_rule`.
2. **S2 splits into three PRs**, A → B → C. Scheduler last, because it is the
   only one that changes the running guardian.
3. **The guardian fails OPEN** when `hub.db` is missing, locked or corrupt: it
   dispatches exactly as today and escalates. The builder fails closed. *The
   scheduler restrains the builder; it must never become a new way to silence the
   watchman.* A `ctx` with no `hub` key at all still dispatches — asserted
   directly, which is what keeps all 59 pre-existing guardian tests green.
4. **`ci.flakePatterns` is REMOVED**, live profile stripped in the same change.
   **Not yet shipped** — still at `src/profile/schema.mjs:183` on main; S2-A's
   Task 12 is the work.
5. **`repo_gate_state` ships with a real writer.** No live GitHub call in S2.
6. **Fewer PRs.** Fold changes into the existing one.
7. **Deferred findings go in ONE follow-up PR** — that is #17.
8. **Never merge without an explicit per-PR grant**, and a grant is spent when
   used. The three plan merges spent theirs. **#17 has no grant yet.**

---

## 5. What S2 is, and what execution means

reeve is an agent-ops control plane. Today it is a **guardian**: per-repo daemons
that watch PRs, publish an `ops/merge-policy` check, and dispatch CI-fixing
workers. The **builder programme** makes reeve also run a task end to end.

Design: `docs/2026-08-21-builder-design.md` (997 lines, founder-approved).
§14 defines stages S0–S10. **S1 is complete** (PRs #3–#6). The three merged plans
are S2: hub core. **S2 ships no worker dispatch** — `worker.isolation` is `none`
and dispatch is refused in code. S2 does not change that.

**Execution, in order** (§13 of handoff-4, now on main):

1. **S2-A** → `src/build/hub.sql`, `hubdb.mjs`, `locks.mjs`, `replay.mjs`,
   `tables.mjs`, backup/restore, doctor, the CLI routes, tests. Retires
   `ci.flakePatterns`.
2. **S2-B** → `phases.mjs`, `transition.mjs`, `outbox.mjs`, `registry.mjs`,
   `gatestate.mjs`, `loop.mjs`, drills.
3. **S2-C** → `providerdb.mjs`, `provider.mjs`, `hubguest.mjs`, `holds.mjs`, the
   daemon claim, the `pr_hold` verdict clause and its `watcher.mjs` wiring.
   **This one changes the running guardian**; its effect begins at the daemon's
   next restart, which is a founder-timed act.

Each plan carries its own tasks, interfaces, test code and self-review. They are
written for an engineer with no context — follow them task by task.

---

## 6. How to work a review finding

This method was arrived at over 16 rounds and is the reason the plans are what
they are.

1. **Verify the claim against the actual text or source first.** Roughly one in
   ten needs reframing rather than applying. Two this programme were factually
   wrong and were refuted with a measurement. **Once, I began writing a reply
   telling Codex it was wrong, then read the code and found I had missed an
   `if (t !== "maintenance_lock")` guard — it was right and I was not.**
2. **Fix it properly**, with a comment saying what and why, in the style of the
   surrounding text.
3. **Assert every anchor matched exactly once, and verify in the same run as the
   write.** A script that aborts before its write saves nothing; one that writes
   file A then fails on file B leaves A written.
4. **Sweep the class, not the instance.** When a finding names one site, grep for
   the rest — and match the SHAPE, not a spelling. The suite-loop sweep took
   three passes because the first two matched the trailing comment wording.
5. **Reply AND resolve.** Replying alone does not clear the thread.
6. **Re-run the invariants** (§7), commit, push, comment `@codex review`.

---

## 7. The invariant script — rebuild it first

**It lives in a session scratchpad and dies with the session.** It has caught
defects in eight separate rounds. Run it from a checkout that holds all three
plans — since the merge, that is any checkout of `main`.

> The version in handoff-4 read **one plan per worktree**, which silently
> compared a new file against two stale ones the moment the worktrees diverged.
> This version reads all three from one tree. That was a real instrument defect,
> fixed in #17.

```python
#!/usr/bin/env python3
"""Cross-document invariants for the reeve S2 plans.

Run from a checkout that holds ALL THREE plans. Each direction was added because
something slipped past the previous set; each carries a positive control,
because a check that cannot fail is not a check.
"""
import io, re, sys
pa = io.open("docs/superpowers/plans/2026-08-23-s2a-hub-store.md", encoding="utf-8").read()
pb = io.open("docs/superpowers/plans/2026-08-23-s2b-phase-machine.md", encoding="utf-8").read()
pc = io.open("docs/superpowers/plans/2026-08-23-s2c-provider-scheduler.md", encoding="utf-8").read()
bad = []
def eq(n, a, b, brief=False):
    ok = a == b
    print(("  OK  " if ok else " FAIL ") + f"{n}: {(len(a) if brief and ok else a)}" + ("" if ok else f"  vs  {b}"))
    if not ok: bad.append(n)

t  = sorted(set(re.findall(r"CREATE TABLE IF NOT EXISTS ([a-z_]+) *\(", pa)))
ow = sorted(re.findall(r"^\s{2}([a-z_]+):\s*\{", re.search(r"export const TABLE_OWNERS = \{(.*?)\n\};", pa, re.S).group(1), re.M))
pt = sorted(set(re.findall(r'"([a-z_]+)"', re.search(r"export const PROSE_TABLES = \[(.*?)\];", pa, re.S).group(1))))
eq("1a tables == 32", len(t), 32); eq("1b TABLE_OWNERS", ow, t, True); eq("1c PROSE_TABLES", pt, t, True)

cs = re.findall(r'"([a-z_]+)"', re.search(r"export const COMPARISON_SET = \[(.*?)\];", pa, re.S).group(1))
H  = re.search(r"const HANDLERS = \{(.*?)\n\};", pa, re.S).group(1)
h  = sorted(set(re.findall(r'table:\s*"([a-z_]+)"', H)))
eq("2a COMPARISON_SET == 20", len(cs), 20)
eq("2b handlers subset", [x for x in h if x not in cs], [])
eq("2c comparison handled", [x for x in cs if x not in h], [])

kinds  = set(re.findall(r'"([a-z_.]+)":\s*\{\s*table', H))
owners = dict(re.findall(r"^\s{2}([a-z_]+):\s*\{([^}]*)\}", re.search(r"export const TABLE_OWNERS = \{(.*?)\n\};", pa, re.S).group(1), re.M))
eq("3 replayed == handlers", sorted(k for k,v in owners.items() if "replayed: true" in v), sorted(set(h)), True)

nr = set(re.findall(r'"([a-z_.]+)"', re.search(r"NON_REPLAYED_KINDS = Object\.freeze\(\[(.*?)\]\);", pa, re.S).group(1)))
RX = r'hubEvent\(\s*\w+\s*,\s*\{\s*kind:\s*"([a-z_.]+)"'
em_all = set(re.findall(RX, pa)) | set(re.findall(RX, pb)) | set(re.findall(RX, pc))
em = {k for k in em_all if "." in k}          # undotted ones are test fixtures
eq("4 every emitted kind declared", sorted(em - kinds - nr), [])

aph = sorted(set(re.findall(r"'([A-Z_]+)'", re.search(r"CHECK\s*\(\s*phase IN \((.*?)\)\s*\)", pa, re.S).group(1))))
bph = []
for g in ("ACTIVE","HELD","DRAINING","TERMINAL"):
    bph += re.findall(r'"([A-Z_]+)"', re.search(r"export const %s\s*= Object\.freeze\(\[(.*?)\]\);" % g, pb, re.S).group(1))
eq("5a phases == 21", len(aph), 21); eq("5b A CHECK == B PHASES", aph, sorted(set(bph)), True)

comp = re.findall(r"'([a-z-]+)'", re.search(r"closed set `\[(.*?)\]`", pb, re.S).group(1))
rows = re.findall(r"^\| `([a-z-]+)` \| ", pb, re.M)
eq("6a compensations == 14", len(comp), 14)
eq("6b each has a row", sorted(c for c in comp if c not in rows), [])

he = re.findall(r"^\s{2}([a-z_]+):\s", re.search(r"HOLD_ESCALATION = Object\.freeze\(\{(.*?)\n\}\);", pb, re.S).group(1), re.M)
prh = re.search(r"CREATE TABLE IF NOT EXISTS pr_hold(.*?)\n\) STRICT;", pa, re.S).group(1)
prset = set(re.findall(r"'([a-z_]+)'", re.search(r"reason\s+TEXT\s+NOT NULL CHECK \(reason IN\s*\n?\s*\((.*?)\)\),", prh, re.S).group(1)))
eq("7 HOLD_ESCALATION subset", sorted(set(he) - prset), [])

enums = dict(re.findall(r'"([a-z_]+\.[a-z_]+)":\s*"([^"]*)"', re.search(r"const ENUMS = \{(.*?)\n\};", pa, re.S).group(1)))
wrong, scanned = [], 0
for tb in cs:
    m = re.search(r"CREATE TABLE IF NOT EXISTS %s \((.*?)\n\) (STRICT|WITHOUT)" % tb, pa, re.S)
    if not m: continue
    body = m.group(1)
    for line in body.split("\n"):
        cm = re.match(r"\s*([a-z_]+)\s+TEXT\s+NOT NULL(?!.*DEFAULT).*CHECK\s*\(", line)
        if not cm: continue
        im = re.search(r"IN\s*\((.*?)\)", body[body.index(line):body.index(line)+400], re.S)
        if not im: continue
        scanned += 1
        legal, key = set(re.findall(r"'([^']+)'", im.group(1))), f"{tb}.{cm.group(1)}"
        if enums.get(key) not in legal: wrong.append(f"{key}={enums.get(key)!r} legal={sorted(legal)}")
eq("8 ENUMS legal", wrong, [])

for n, ok in [("tables", len(t)>0), ("handlers", len(kinds)>0), ("kinds", len(em)>0),
              ("phases", len(aph)>0), ("pr_hold CHECK", len(prset)>0), ("enum columns", scanned>0)]:
    print(("  OK  " if ok else " FAIL ") + f"control: {n} found")
    if not ok: bad.append("control " + n)
print("\n" + ("ALL INVARIANTS GREEN" if not bad else "FAILED: " + ", ".join(bad)))
sys.exit(1 if bad else 0)
```

**Current values, all green:** 32 tables, owners and prose complete, **20**-table
comparison set clean both ways, **21≡21** phases, **14** compensations with 14
rows, ENUMS legal for 18 enumerated columns, zero undeclared event kinds.

---

## 8. Other sessions — coordinate before touching `src/`

**21 peer sessions were listed.** Two open PRs in reeve are **not mine**:

| PR | branch | files | state |
|---|---|---|---|
| **#15** "Three dispatches under the new worker contract, and the P0 they exposed" | `docs/first-dispatches` | `docs/2026-08-23-resume-prompt.md`, `docs/2026-08-23-session-handoff.md`, `docs/measured/2026-08-23-three-real-dispatches.md` | CLEAN, CI green, updated 16:35Z |
| **#18** "Name only the commands the grant carries" | `fix/prompt-grant-agreement` | **`src/prompts.mjs`, `src/sandbox.mjs`**, `test/prompt-sandbox-agreement.test.mjs` | CLEAN, CI green, created 16:34Z |

**#18 touches `src/`.** Another session is actively writing reeve source. My S2
execution will touch `src/build/*`, `src/backup.mjs`, `src/doctor.mjs`,
`src/profile/schema.mjs` and `bin/reeve` — no overlap with prompts/sandbox
today, but **check before you start**.

I sent coordination messages to `Check PR feedbacks [3328f9]` and
`nextly-integrations-76 [3a1674]` stating what I own and warning about the live
daemon. **No replies had arrived by 16:37Z.** Use `ListAgents` + `SendMessage`;
tell peers what you are taking.

Also present: `~/Work/Products/reeve-wt/s2` on `plan/s2-hub-core` with **2
unpushed commits** — the original three-way split from 10:15Z, before all 16
review rounds. Every file is smaller than main's. Dead history from closed PR #8.
Nothing to preserve.

---

## 9. Measured facts. Do not re-derive.

Under `docs/measured/` on main (17 files).

| Fact | Consequence |
|---|---|
| `PRAGMA integrity_check` costs **~1.1 ms/MB** (52 ms on 47 MB); a marker query is flat at ~0.3 ms | Deep validation belongs on `snapshotAll`, `restoreHub`, `builder doctor` — **never** per tick. `openHub` uses `quick_check(1)` |
| **`integrity_check` does NOT report foreign-key violations** — an orphaned row reads `ok`; `foreign_key_check` catches it (SQLite 3.53.0, with a positive control) | Deep validation runs both. `2026-08-23-integrity-check-misses-foreign-keys.md` |
| Writing 4096 bytes at offset 8192 corrupts SQLite iff `page_count >= 3` | Derive the offset from `PRAGMA page_count` and control on `integrity_check` |
| An open SQLite handle **never notices** an atomic rename over its path | Compare `stat().ino` before AND after the open |
| The authorizer sees `arg1: "BEGIN"` for BEGIN/DEFERRED/IMMEDIATE/EXCLUSIVE alike | Transaction shape needs a facade scanner |
| **Own properties SHADOW a prototype method, they do not remove it** — `Object.getPrototypeOf(g).setAuthorizer.call(g, null)` reaches the original | The guest hub connection is a frozen **null-prototype facade**, not a branded handle with properties written over it |
| `node:sqlite` exports no top-level `SQLITE_*` | They are under `constants` |
| `PRAGMA table_info.pk` is the **1-based position**, not a boolean | A rowid alias is: exactly one pk column, declared type exactly `INTEGER` |
| No numeric repo id exists anywhere in the guardian schema or profiles (re-measured on `16769e7`: 0 files under `src/`, positive control 26 for `nwo`, 0 of 3 live profiles) | Resolve once at startup via the App client, retry with backoff |
| `pull_request.updated_at` does not change on thread resolution | Any polling guard built on it is blind |
| `ci.flakePatterns` has zero readers; the validator refuses unknown keys **including empty arrays** | Removing it from `FIELDS` alone kills every daemon start |
| `src/supervisor.mjs:444-445` gives `lateWhy` precedence over `classifyResult` | Setting `revoked` makes the exit `LEASE_LOST` and the 429 branch at `:220` unreachable — the daemon must normalise from its own recorded fact |
| The OPS HEALTH "ledger render failed" banner is a false alarm | cwd-dependence plus a discarded diagnostic |

---

## 10. Line-number citations

The plans cite `src/daemon.mjs:NNN` etc. **All are measured against `16769e7`**,
which is still `main`'s parent — `src/` has not changed since. Each is paired
with a searchable string. When `main` moves, re-derive:

```bash
git show origin/main:src/daemon.mjs | grep -n "<the searchable string>"
```

Known true values on `16769e7`: `escalations` Map **551**, `ctx.openPrs ?? openPrs`
**558**, halted return **554**, unreadable return **562**, halted mid-tick **578**,
`if (!e.ok) … continue` **579**, `evaluatePr` call **581**, `nextAction` recompute
**716**, `decisions.push` **732**, `wanted` **762**, `measuredContainment` call
**764**, `containment.credentialRead !==` **765**, `=== "closed"` **770**,
`HALTED before dispatch` **793**, `cannot dispatch FIX_CI` **801**,
`identity.worktreeRoot` refusal **841**, `const run = startRun(db,` **853**,
`recordFixAttempt` **857**, `ctx.heartbeat ?? heartbeat` **873**, `isRevoked`
**1029**, rate-limit branch **1272**, final return **1397**; `supervisor.mjs`
rate_limit event **386-387**, `classifyResult` 429 branch **220**, `lateWhy`
precedence **444-445**; `ci-rootcause.mjs` id filter **259**;
`profile/schema.mjs` unknown-key push **352**, container list **338**;
`bin/reeve` backup import **10**, node:path import **18**.

---

## 11. Hard rules

- **Never merge without an explicit per-PR grant**; a grant is spent when used.
  **#17 has no grant.**
- **Never `--no-verify`.** Conventional Commits, lowercase, `type(scope): subject`,
  ≤72 chars. **No Claude attribution anywhere.**
- **Do not** restart the reeve daemon, run `launchctl`, run `reeve canary`, or
  `git pull` in `~/Work/Products/reeve` — a live guardian runs from that
  checkout, executing `bin/reeve` from that working tree directly, and
  `reeve canary` costs a real model call and writes a shared state file at
  `~/.reeve/canary/<owner>/<repo>.json` that the daemon reads.
- **Work in the worktrees** (`~/Work/Products/reeve-wt/{pa,pb,pc,s2}`).
  `git fetch` is fine.
- **`test/escape.test.mjs` is excluded** from routine suite runs — it writes
  decoys into that same shared canary tree. Baseline: 59 test files, 58 run,
  58 pass (measured on `9dbd3a0`); two carry one `SKIP`.
- **Fold changes into the existing PR.** Do not open new ones for small changes.
- **`docs/TRACKER.md` conflicts on every branch.** One line, last commit before
  opening a PR.

---

## 12. Mistakes worth carrying forward

Each was caught by review or by a control, not by intuition. The last four are
the ones that recurred most and cost the most.

1. **A truncated query reported absence and I believed it** — and reported it to
   the founder. `reviewThreads(first:100)` silently truncates past 100 threads.
   Always read `totalCount` and compare it to what you fetched.
2. **A safety argument that was backwards.** I claimed the SQL comment stripper's
   mistakes "can only be refusals, never admissions". Measured: `SELECT '--';
   BEGIN EXCLUSIVE` passes and runs.
3. **Moving a cost instead of removing it.** Measured `integrity_check` off
   `latestSnapshot` and put it into `selfAudit` in the same round.
4. **Writing against a schema I had not re-read.** `ended_at` does not exist on
   `phase_run`; `lost`/`settled` are not legal statuses.
5. **A rule stated in prose is not a rule.** Eight findings in one round were
   "the plan describes an assertion instead of containing one" — the same defect
   the plans keep flagging in implementations, committed by the document that
   states it. **If you find yourself writing "asserted by X" or "covered by Y",
   write X and Y instead.**
6. **Moving a declaration without checking what closes over it.** I hoisted
   `abandonClaim` twice and both times left a shadowing `const repoId` in the
   block, so the hoist moved a temporal-dead-zone throw rather than fixing it.
7. **A fix that destroys the reason it was fixing for.** Setting `revoked` to
   fast-fail a rate-limited worker made the supervisor classify the exit
   `LEASE_LOST`, so the `RATE_LIMITED` branch never ran and the attempt was spent
   recording a lost lease.
8. **My own repairs became the majority of later findings.** In the last six
   rounds, roughly half of each round's findings were defects in the previous
   round's fixes. Three fixes were broken in the same commit that introduced
   them (an invented `HANDLERS_TABLE`, a note pushed above its own array, an
   unimported `basename`) and only caught because I checked my own edits before
   committing. **Check your own edits before committing.**

---

## 13. What remains

**Immediately:**

1. **PR #17** — watch for the Codex review that had not arrived by 16:37Z. Work
   whatever comes back on the same branch. When it reaches zero-open with CI
   green, **ask the founder for a grant** — the stop rule is not itself a grant.

**Then, the open question the founder asked and I have not answered:**

2. The founder asked for work that is "researched based, future proof and
   scaleable, follows industry best standards and coding best practices" and
   "best UI/UX and best DX". I told them honestly that #17 applied *established*
   patterns where they fit (atomic write-then-rename, a manifest footer for
   truncation detection, an owner-fenced CAS, injected clocks for determinism)
   but was **not** the deep comparative research they asked for. **I asked
   whether to do a research pass before writing S2-A's code, or go straight to
   execution. That question is unanswered.** Ask it again.

   If the answer is research: the questions worth answering are how other
   schedulers fence leases across restarts, what SQLite operators actually do
   about torn snapshots and WAL sidecars, and what the DX of a `builder doctor`
   /`build status` surface should be (this is where the UI/UX/DX ask actually
   lands — reeve has no GUI; its interface is a CLI and its findings).

3. **S2 execution**, A → B → C, per §5.

**Standing, lower priority:**

4. **PR #15 and #18 are other sessions' work** — do not merge without asking.
5. `greptile-apps` still has no `clean` pattern and cannot classify a pass.
   Deliberately unfixed: no observed greptile body exists to write one against.
6. The off-device backup destination (§16.2) is undecided; doctor reports it
   missing.

---

## 14. Environment

```
Node        ~/.nvm/versions/node/v24.17.0/bin/node   (PATH node is v22; node:sqlite warns there)
Repo        ~/Work/Products/reeve                     LIVE daemon — read-only for us
Worktrees   ~/Work/Products/reeve-wt/pa               ON fix/s2-plan-review-findings (PR #17)
            ~/Work/Products/reeve-wt/pb               plan/s2b-phase-machine (merged)
            ~/Work/Products/reeve-wt/pc               plan/s2c-provider-scheduler (merged)
            ~/Work/Products/reeve-wt/s2               closed #8 branch, dead history
Profiles    ~/.reeve/profiles/<owner>/<repo>.json
Registry    ~/.reeve/projects.json                    top-level {name: {...}}, NOT {projects: {...}}
Hub         ~/.reeve/state/hub.db                     does NOT exist yet; S2 creates it
Suite       fail=0; for f in test/*.test.mjs; do case "$f" in */escape.test.mjs) continue;; esac
            $N "$f" >/dev/null || { echo "FAILED $f"; fail=1; }; done
            [ "$fail" -eq 0 ] || { echo "the suite is RED"; exit 1; }
```

---

## 15. The GitHub scripts — rebuild them first

These live in a session scratchpad and die with the session.
**`reviewThreads(first:100)` silently truncates**; every PR here is past 100.

```bash
#!/bin/bash
# threads.sh <pr>  — unresolved review threads, PAGINATED, with a truncation control.
set -e
N=$1; CURSOR=null; SEEN=0; TOTAL=0
while :; do
  RES=$(gh api graphql -f query='
  query($n:Int!,$c:String){ repository(owner:"revnix", name:"reeve"){ pullRequest(number:$n){
    reviewThreads(first:100, after:$c){
      totalCount pageInfo{ hasNextPage endCursor }
      nodes{ id isResolved isOutdated path line comments(first:1){nodes{author{login} body createdAt}} } } } } }' \
    -F n=$N -F c="$CURSOR")
  TOTAL=$(echo "$RES" | jq -r '.data.repository.pullRequest.reviewThreads.totalCount')
  SEEN=$(( SEEN + $(echo "$RES" | jq -r '.data.repository.pullRequest.reviewThreads.nodes|length') ))
  echo "$RES" | jq -c '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) | {id, path, line, author: .comments.nodes[0].author.login, created: .comments.nodes[0].createdAt, body: .comments.nodes[0].body}'
  [ "$(echo "$RES"|jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')" = true ] || break
  CURSOR=$(echo "$RES"|jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor')
done
echo "### PR#$N fetched=$SEEN totalCount=$TOTAL" >&2
[ "$SEEN" = "$TOTAL" ] || { echo "### TRUNCATION" >&2; exit 3; }
```

```bash
#!/bin/bash
# reply.sh <threadId> <bodyFile>  — reply, then resolve. Replying alone does NOT clear it.
set -e
TID="$1"; BODY="$(cat "$2")"
gh api graphql -f query='mutation($t:ID!,$b:String!){ addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t, body:$b}){ comment{ id } } }' -F t="$TID" -F b="$BODY" --jq '.data.addPullRequestReviewThreadReply.comment.id' >/dev/null
gh api graphql -f query='mutation($t:ID!){ resolveReviewThread(input:{threadId:$t}){ thread{ isResolved } } }' -F t="$TID" --jq '.data.resolveReviewThread.thread.isResolved'
```

**Codex has FOUR verdict shapes:**

1. **Findings** → a review object on `pulls/<n>/reviews` with inline comments.
2. **Clean pass** → an **issue** comment on `issues/<n>/comments` containing
   `Didn't find any major issues` + `Reviewed commit: <sha>`. **No review object
   is filed at all.**
3. **Refusal** → an issue comment: `Something went wrong` / `You have reached
   your Codex usage limits`. Not a pass; re-request.
4. **No suggestions** → a review object with zero inline comments **plus a 👍
   reaction** on the `@codex review` comment. A **👀** reaction means *in
   flight*, not finished.

**Zero bot issue comments were ever posted on #11, #12 or #13** — verified with a
positive control. No clean pass has ever arrived on anything in this programme.

`commit_id` on a Codex review is the branch head it reviewed and is often one
commit behind. Check ancestry, not equality.
