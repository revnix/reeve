# Session handoff: the S2 plan programme (2026-08-23, second handoff)

Supersedes `2026-08-23-session-handoff-3.md`, which is now wrong in several
places — read this one. The companion resume prompt is
`docs/2026-08-23-resume-prompt-4.md`.

Everything here is either measured (with the command that measured it) or
labelled as intent.

---

## 1. State, and how to read it correctly

| | |
|---|---|
| Repository | `revnix/reeve` (private) |
| `origin/main` | `16769e7` — "Two instruments that could not have caught what they exist for (#14)" |
| Live daemon | **RUNNING** from `~/Work/Products/reeve` against `nextlyhq/nextly`, launchd `KeepAlive` |
| Work in flight | three **plan** PRs — documents only, no `src/` changes |
| Merged this programme | **#9** (reviewer refusal patterns). **#14** was another session's. |
| Closed | **#8** (the combined S2 plan, superseded by the three-way split) |

| PR | Branch | Worktree | Plan | Lines |
|---|---|---|---|---|
| **#11** S2-A hub store | `plan/s2a-hub-store` | `~/Work/Products/reeve-wt/pa` | `2026-08-23-s2a-hub-store.md` | 4503 |
| **#12** S2-B phase machine | `plan/s2b-phase-machine` | `~/Work/Products/reeve-wt/pb` | `2026-08-23-s2b-phase-machine.md` | 2951 |
| **#13** S2-C provider scheduler | `plan/s2c-provider-scheduler` | `~/Work/Products/reeve-wt/pc` | `2026-08-23-s2c-provider-scheduler.md` | 2034 |

**Head SHAs and open counts are deliberately not written here.** They change
every twenty minutes. Read them live — but read them with the *paginated* query
below, not the obvious one.

### THE INSTRUMENT TRAP — read this before believing any thread count

`reviewThreads(first:100)` **silently truncates**. Once a PR passes 100 threads
the first page is the OLDEST threads, all resolved, and the new round is on
page 2. On 2026-08-23 this made me report "all three PRs at zero open" to the
founder while **44 findings** sat unread. `#11` had 69 threads then, fit in one
page, and was genuinely zero — so the instrument agreed with reality on one PR
and lied about two, which is what made it believable.

Thread totals as of this handoff: **#11 = 97, #12 = 147, #13 = 138.** Two of the
three are already past 100 and the third will be within a round or two.

The tell that caught it: the Codex review objects at both current heads carried
25 and 8 **inline comments**. A review with comments and a thread query returning
zero cannot both be true.

**Recreate this script first thing — it lives in a session scratchpad and dies
with the session:**

```bash
#!/bin/bash
# threads.sh <pr>  — unresolved review threads, PAGINATED.
set -e
N=$1; CURSOR=null
while :; do
  RES=$(gh api graphql -f query='
  query($n:Int!,$c:String){ repository(owner:"revnix", name:"reeve"){ pullRequest(number:$n){
    reviewThreads(first:100, after:$c){
      totalCount pageInfo{ hasNextPage endCursor }
      nodes{ id isResolved isOutdated path line comments(first:1){nodes{author{login} body createdAt}} } } } } }' \
    -F n=$N -F c="$CURSOR")
  echo "$RES" | jq -c '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) | {id, path, line, author: .comments.nodes[0].author.login, created: .comments.nodes[0].createdAt, body: .comments.nodes[0].body}'
  HAS=$(echo "$RES" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')
  [ "$HAS" = "true" ] || break
  CURSOR=$(echo "$RES" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor')
done
```

```bash
#!/bin/bash
# reply.sh <threadId> <bodyFile>  — reply, then resolve. Replying alone does NOT clear it.
set -e
TID="$1"; BODY="$(cat "$2")"
gh api graphql -f query='mutation($t:ID!,$b:String!){ addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t, body:$b}){ comment{ id } } }' -F t="$TID" -F b="$BODY" --jq '.data.addPullRequestReviewThreadReply.comment.id' >/dev/null
gh api graphql -f query='mutation($t:ID!){ resolveReviewThread(input:{threadId:$t}){ thread{ isResolved } } }' -F t="$TID" --jq '.data.resolveReviewThread.thread.isResolved'
```

**Always read `totalCount` and compare it to what you fetched.** A query that
cannot represent the answer looks exactly like an answer.

---

## 2. Codex's verdict shapes — there are FOUR, not three

1. **Findings** → a review object on `pulls/<n>/reviews` with inline comments.
2. **Clean pass** → an **issue** comment on `issues/<n>/comments`, body containing
   `Didn't find any major issues` plus `Reviewed commit: <sha>`. **No review
   object is filed at all.**
3. **Refusal** → an issue comment: `Something went wrong` / `You have reached
   your Codex usage limits`. Not a pass; re-request.
4. **No suggestions** → a review object with the `### 💡 Codex Review` header and
   **zero inline comments**, plus a **👍 reaction** on the `@codex review`
   comment. Its own body documents this: *"If Codex has suggestions, it will
   comment; otherwise it will react with 👍."*

**Zero bot issue comments have ever been posted on #11, #12 or #13**, and no
`@codex review` comment has a 👍. So no clean pass has ever arrived. Verified
with a positive control (the endpoint returns comments — all of them the
founder's `@codex review` requests).

`commit_id` on a Codex review is the branch head it reviewed, and is often one
commit behind the current head because a push lands during the review. Check
ancestry, not equality.

---

## 3. What this programme is

reeve is an agent-ops control plane. Today it is a **guardian**: per-repo daemons
that watch PRs, publish an `ops/merge-policy` check, and dispatch CI-fixing
workers. The **builder programme** makes reeve also run a task end to end.

Design: `docs/2026-08-21-builder-design.md` (997 lines, founder-approved). §14
defines stages S0–S10. **S1 is complete** (PRs #3–#6). These three PRs are the
plan for **S2: hub core**.

S2's authority is §14's S2 paragraph; its *Verify:* clause is the definition of
done. **S2 ships no worker dispatch** — `worker.isolation` is `none` and dispatch
is refused in code. S2 does not change that.

---

## 4. Founder decisions — do not re-litigate

1. **S2 splits into three PRs**, A → B → C. Scheduler last, because it is the
   only one that changes the running guardian.
2. **The guardian fails OPEN** when `hub.db` is missing, locked or corrupt: it
   dispatches exactly as today and escalates. The builder fails closed. *The
   scheduler restrains the builder; it must never become a new way to silence
   the watchman.* A `ctx` with no `hub` key at all still dispatches — asserted
   directly, which is what keeps all 59 pre-existing guardian tests green.
3. **`ci.flakePatterns` is REMOVED**, live profile stripped in the same change.
   Evidence: `docs/measured/2026-08-22-flakepatterns-has-no-readers.md`.
   **It is NOT yet shipped** — it is still declared at `src/profile/schema.mjs:183`
   on main, and S2-A's Task 12 is the work. `docs/TRACKER.md` used to claim it
   shipped in #9; that was corrected.
4. **`repo_gate_state` ships with a real writer** — the table, a pure
   `gateStateFrom()`, and a tick calling it through an injected fetcher. No live
   GitHub call in S2.
5. **Fewer PRs.** Fold changes into the existing three. Do not open new ones.
6. **Never merge without an explicit per-PR grant**, and a grant is spent when
   used.

---

## 5. The three plans, and their cross-document invariants

Each plan is self-contained: header, global constraints, the S1 measured facts,
founder decisions, a test-harness block, a file-structure table, its tasks, and
its own self-review. B and C open with a **consumed-interfaces table**.

**Run this after ANY edit.** It has caught defects in six separate rounds, and
each direction was added because something slipped past the previous set. It
runs from `~/Work/Products/reeve-wt` and needs all three worktrees present.

The version that shipped in the previous handoff had **four wrong regexes** and
died on `PHASES` (which is composed from `ACTIVE`/`HELD`/`DRAINING`/`TERMINAL`,
not a literal array), on `pr_hold`'s two-line CHECK, and on `NON_REPLAYED_KINDS`.
Direction 4 also scanned only plan B for emissions, which is how
`lease.singleton.granted`/`.released` — emitted by **A's own `locks.mjs`** — went
undeclared for nine rounds until review caught them. This version is the one that
actually runs:

```python
#!/usr/bin/env python3
"""Cross-document invariants for the reeve S2 plans. Run from ~/Work/Products/reeve-wt.

Every direction was added because something slipped past the previous set.
Each one carries a positive control: a check that cannot fail is not a check.
"""
import io, re, sys
pa = io.open("pa/docs/superpowers/plans/2026-08-23-s2a-hub-store.md", encoding="utf-8").read()
pb = io.open("pb/docs/superpowers/plans/2026-08-23-s2b-phase-machine.md", encoding="utf-8").read()
pc = io.open("pc/docs/superpowers/plans/2026-08-23-s2c-provider-scheduler.md", encoding="utf-8").read()
bad = []
def eq(n, a, b, brief=False):
    ok = a == b
    shown = (f"{len(a)} items" if brief and ok else a)
    print(("  OK  " if ok else " FAIL ") + f"{n}: {shown}" + ("" if ok else f"  vs  {b}"))
    if not ok: bad.append(n)

# 1. 32 tables; TABLE_OWNERS and PROSE_TABLES complete
t  = sorted(set(re.findall(r"CREATE TABLE IF NOT EXISTS ([a-z_]+) *\(", pa)))
ow = sorted(re.findall(r"^\s{2}([a-z_]+):\s*\{", re.search(r"export const TABLE_OWNERS = \{(.*?)\n\};", pa, re.S).group(1), re.M))
pt = sorted(set(re.findall(r'"([a-z_]+)"', re.search(r"export const PROSE_TABLES = \[(.*?)\];", pa, re.S).group(1))))
eq("1a tables == 32", len(t), 32)
eq("1b TABLE_OWNERS complete", ow, t, brief=True)
eq("1c PROSE_TABLES complete", pt, t, brief=True)

# 2. COMPARISON_SET <-> HANDLERS, both directions
cs = re.findall(r'"([a-z_]+)"', re.search(r"export const COMPARISON_SET = \[(.*?)\];", pa, re.S).group(1))
H  = re.search(r"const HANDLERS = \{(.*?)\n\};", pa, re.S).group(1)
h  = sorted(set(re.findall(r'table:\s*"([a-z_]+)"', H)))
eq("2a COMPARISON_SET == 19", len(cs), 19)
eq("2b handlers subset of comparison", [x for x in h if x not in cs], [])
eq("2c comparison all handled", [x for x in cs if x not in h], [])

# 3. TABLE_OWNERS.replayed agrees with HANDLERS
kinds  = set(re.findall(r'"([a-z_.]+)":\s*\{\s*table', H))
owners = dict(re.findall(r"^\s{2}([a-z_]+):\s*\{([^}]*)\}",
              re.search(r"export const TABLE_OWNERS = \{(.*?)\n\};", pa, re.S).group(1), re.M))
eq("3 replayed == handler tables", sorted(k for k,v in owners.items() if "replayed: true" in v), sorted(set(h)), brief=True)

# 4. every kind ANY plan emits is handled or declared unreplayed.
#    Scans A and C too -- locks.mjs lives in A, and an A-only scan of B was the
#    gap that let lease.singleton.granted/released go undeclared for nine rounds.
#    Undotted kinds are test fixtures (e.g. `kind: "k"` proving canonical JSON);
#    the plan's own scanner reads src/build/*.mjs and never sees them.
nr = set(re.findall(r'"([a-z_.]+)"', re.search(r"NON_REPLAYED_KINDS = Object\.freeze\(\[(.*?)\]\);", pa, re.S).group(1)))
RX = r'hubEvent\(\s*\w+\s*,\s*\{\s*kind:\s*"([a-z_.]+)"'
em_all = set(re.findall(RX, pa)) | set(re.findall(RX, pb)) | set(re.findall(RX, pc))
em = {k for k in em_all if "." in k}
eq("4 every emitted kind declared", sorted(em - kinds - nr), [])
print(f"        scanned {len(em)} dotted kinds; ignored fixtures {sorted(em_all - em) or 'none'}")

# 5. task.phase CHECK in A == the phase sets composed in B, 21 states
aph = sorted(set(re.findall(r"'([A-Z_]+)'", re.search(r"CHECK\s*\(\s*phase IN \((.*?)\)\s*\)", pa, re.S).group(1))))
bph = []
for g in ("ACTIVE","HELD","DRAINING","TERMINAL"):
    bph += re.findall(r'"([A-Z_]+)"', re.search(r"export const %s\s*= Object\.freeze\(\[(.*?)\]\);" % g, pb, re.S).group(1))
eq("5a phases == 21", len(aph), 21)
eq("5b A CHECK == B PHASES", aph, sorted(set(bph)), brief=True)

# 6. the compensation set is closed at 14 and every name has a table row
comp = re.findall(r"'([a-z-]+)'", re.search(r"closed set `\[(.*?)\]`", pb, re.S).group(1))
rows = re.findall(r"^\| `([a-z-]+)` \| ", pb, re.M)
eq("6a compensations == 14", len(comp), 14)
eq("6b each has a table row", sorted(c for c in comp if c not in rows), [])

# 7. HOLD_ESCALATION keys are a subset of pr_hold's CHECK set
he = re.findall(r"^\s{2}([a-z_]+):\s", re.search(r"const HOLD_ESCALATION = Object\.freeze\(\{(.*?)\n\}\);", pb, re.S).group(1), re.M)
prh = re.search(r"CREATE TABLE IF NOT EXISTS pr_hold(.*?)\n\) STRICT;", pa, re.S).group(1)
prset = set(re.findall(r"'([a-z_]+)'", re.search(r"reason\s+TEXT\s+NOT NULL CHECK \(reason IN\s*\n?\s*\((.*?)\)\),", prh, re.S).group(1)))
eq("7 HOLD_ESCALATION subset of pr_hold", sorted(set(he) - prset), [])

# 8. ENUMS holds a LEGAL value for every enumerated NOT NULL column in the set
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
        if enums.get(key) not in legal:
            wrong.append(f"{key}={enums.get(key)!r} legal={sorted(legal)}")
eq("8 ENUMS legal for every enumerated column", wrong, [])
print(f"        scanned {scanned} enumerated NOT NULL columns")

# CONTROLS -- each instrument must be able to report something.
ctl = [("tables found", len(t) > 0), ("handlers found", len(kinds) > 0),
       ("kinds found", len(em) > 0), ("phases found", len(aph) > 0),
       ("pr_hold CHECK read", len(prset) > 0), ("enum columns read", scanned > 0)]
for n, ok in ctl:
    print(("  OK  " if ok else " FAIL ") + f"control: {n}")
    if not ok: bad.append("control " + n)

print("\n" + ("ALL INVARIANTS GREEN" if not bad else "FAILED: " + ", ".join(bad)))
sys.exit(1 if bad else 0)
```

Current values, all green: **32** tables, owners and prose complete,
**19**-table comparison set with membership clean both ways, **21≡21** phases,
**14** compensations with 14 rows, **zero** undeclared event kinds.

### Content, one line each

- **S2-A (#11)** — 13 tasks. 32 STRICT tables; forward-only migrations under the
  lock with a **forward-version recheck inside it**; the three locks; hub-aware
  backup with cheap/deep validation; `restoreHub` (refuse live writers, stage +
  atomic rename, clear process-scoped rows, settle live `phase_run` rows
  `killed`, replay the tail); the destructive drill over all 19 compared tables;
  the prose-versus-DDL cross-check with **four** directions; `NON_REPLAYED_KINDS`;
  `backup --hub`, `restore --hub`, `builder doctor` and `build status` CLI
  routes; retires `ci.flakePatterns`.
- **S2-B (#12)** — 7 tasks. `phases.mjs` pure and total over 21 states; the one
  generation-fenced transition transaction with **14** compensations; the fenced
  outbox (live-rows-only key uniqueness, `KEY_KINDS` supersede, fence
  revalidation inside the lease tx); the registry snapshot with the full §1.5
  admission snapshot including `founderUserId`; filing idempotency;
  `repo_gate_state`'s pure derivation; crash, corruption and duplicate-delivery
  drills.
- **S2-C (#13)** — 5 tasks. `providerdb.mjs` (SQL) + `provider.mjs` (policy);
  transactional admission, guardian reservation, cooldown, reaping, preemption;
  the guardian-side claim failing **open**; `openHubAsGuest` on SQLite's
  `setAuthorizer` plus a **facade SQL scanner**; Task 23b's `pr_hold` verdict
  clause with its `nextAction` wiring.
- `2026-08-23-s2-review-history.md` — #8's self-review and four revision rounds.

---

## 6. Measured facts. Do not re-derive.

Under `docs/measured/`, all on `pa` unless noted.

| Fact | Consequence |
|---|---|
| `PRAGMA integrity_check` costs **~1.1 ms/MB** (52 ms on 47 MB); a marker query is flat at ~0.3 ms | Deep validation belongs on `snapshotAll`, `restoreHub` and `builder doctor` — **never** on a per-tick path. `2026-08-23-integrity-check-cost.md` |
| Writing 4096 bytes at offset 8192 corrupts SQLite iff `page_count >= 3` | The drills' fixtures are 67 pages, so it works — but derive the offset from `PRAGMA page_count` and control on `integrity_check`. `2026-08-23-sqlite-page-corruption.md` |
| An open SQLite handle **never notices** an atomic rename over its path | It keeps serving the replaced inode with no error. Compare `stat().ino`, before AND after the open. `2026-08-23-guest-connection-and-restore.md` (on `pc`) |
| The authorizer sees `arg1: "BEGIN"` for BEGIN/DEFERRED/IMMEDIATE/EXCLUSIVE alike | Transaction shape cannot be gated there; it needs a facade scanner |
| A denied statement says `not authorized` or `access to X is prohibited` | Never `allowlist`/`not permitted`. Match all three shapes |
| `serialize()` IS covered by the authorizer (throws `not authorized`) | Shadowed anyway — the boundary must not rest on SQLite's internal choice |
| `node:sqlite` exports no top-level `SQLITE_*` | They are under `constants` |
| `PRAGMA table_info.pk` is the **1-based position**, not a boolean | A rowid alias is: exactly one pk column, declared type exactly `INTEGER` |
| No numeric repo id exists anywhere in the guardian schema or profiles | Resolve once at startup via the App client, retry on later ticks with backoff |
| `pull_request.updated_at` does not change on thread resolution | Any polling guard built on it is blind |
| `ci.flakePatterns` has zero readers; the validator refuses unknown keys **including empty arrays** | Removing it from `FIELDS` alone kills every daemon start |
| The OPS HEALTH "ledger render failed" banner is a false alarm | cwd-dependence plus a discarded diagnostic |

---

## 7. Line-number citations — re-derive them when main moves

The plans cite `src/daemon.mjs:NNN` and similar. **PR #14 shifted nine of them by
one line**, and one (`ctx.reviewIngest`, cited as `daemon.mjs:516`) had been wrong
by **eighty lines** since before this programme started, unnoticed by nine
rounds.

All citations now name the commit (`on 16769e7`) and are paired with a searchable
string. Each plan's Global Constraints carries:

> **Line numbers are measured against `16769e7`** … If a number does not match,
> the file moved under it — search the string; the reasoning around it is not
> thereby stale.

**When `origin/main` moves, re-derive every citation** (instruction 8 of the
watcher prompt). The command:

```bash
git show origin/main:src/daemon.mjs | grep -n "<the searchable string>"
```

Current true values on `16769e7`: `escalations` Map **551**, `evaluatePr` call
**581**, `decisions.push` **732**, `wanted` **762**, `measuredContainment` call
**764**, `HALTED before dispatch` **793**, `startRun` **853**,
`recordFixAttempt` **857**, `ctx.reviewIngest` **597/1361/1368**,
`ctx.openPrs ?? openPrs` **557**, `nextAction` recompute **716**, selfAudit loop
**1335**, final return **1397**, `doctor.mjs` authenticate `.catch` **267**,
`backup.mjs` prune-inside-snapshot **45**.

---

## 8. What remains

**Read it live** with the paginated script. As of this handoff: **#11 = 0,
#12 = 21, #13 = 11.** Both open sets are fresh rounds landed within the last
twenty minutes and have not been read.

Rounds worked so far, per plan (each number is one Codex round):

| | r1 | r2 | r3 | r4 | r5 | r6 | r7 | r8 | r9 | r10 | r11 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **A** (#11) | 16 | 13 | 4 | 6 | 7 | 8 | 5 | 10 | 9 | 13 | 19 |
| **B** (#12) | 21 | 14 | 18 | 7 | 12 | 13 | 26 | — | — | — | — |
| **C** (#13) | 17 | 9 | 22 | 14 | 13 | 16 | 18 | 9 | — | — | — |

**Roughly 380 threads cumulatively. No clean pass on any PR.**

---

## 9. The pattern, honestly stated

Early rounds found defects in the original plans. **Recent rounds mostly find
defects in the previous round's fixes.** In the last four rounds, between a third
and a half of each round's findings were caused by my own prior repairs — a
`seed` helper that broke an absence assertion, a `latestSnapshot` fix that put a
full page scan on the tick path, a `phase_run` cleanup written against a schema I
had not re-read, a comment stripper whose safety argument was backwards.

That is a loop with no natural exit: every repair is new surface. The findings
are still real and still getting narrower, but "wait for zero" and "wait for a
clean pass" are different stopping rules and only the first is reachable.

**This is the open question the founder owes an answer on** (see §12).

---

## 10. Working method that has been effective

- **Verify every bot claim against the actual text or source before acting.**
  Roughly one in ten needs reframing rather than applying. Two this programme
  were **factually wrong** and were refuted with a measurement (the SQLite page
  corruption, and `serialize()` bypassing the authorizer).
- **Patch with asserted anchors, verify in the same run as the write.** Every
  text edit asserts its anchor matched exactly once. A script that aborts before
  its `open(P,"w")` saves nothing — and one that writes file A then fails on file
  B leaves A written, which has happened.
- **Sweep the class, not the instance.** When a finding names one site, grep for
  the rest. Four separate findings this programme were "you fixed one and not its
  siblings".
- **Never `head` an absence search**, and always pair it with a count and a
  positive control.
- **Reply AND resolve** every thread. Replying alone does not clear it.
- **Re-run the §5 invariants** after each batch, then commit, push, and comment
  `@codex review` — on **every** push.
- **Prefer a control that would fail on the over-fix.** Most of the durable value
  in these plans is in the `control:` assertions, not the primary ones.

---

## 11. Hard rules

- **Never merge.** Every PR needs Mobeen's explicit, per-PR grant; a grant is
  spent when used.
- **Never `--no-verify`.** Conventional Commits, lowercase, `type(scope): subject`,
  ≤72 chars. **No Claude attribution anywhere.**
- **Do not** restart the reeve daemon, run `launchctl`, run `reeve canary`, or
  `git pull` in `~/Work/Products/reeve` — a live guardian runs from that
  checkout, and `reeve canary` costs a real model call and writes a shared state
  file the daemon reads.
- **Work in the worktrees only** (`~/Work/Products/reeve-wt/{pa,pb,pc}`).
  `git fetch` is fine; it does not touch the daemon's working tree.
- **`test/escape.test.mjs` is excluded** from routine suite runs — it writes
  decoys into the shared `~/.reeve/canary/` tree the live daemon reads. Baseline:
  59 test files, 58 run, 58 pass (measured on `9dbd3a0`); two carry one `SKIP`.
- **Fold changes into the existing PRs.** Do not open new ones.
- **`docs/TRACKER.md` conflicts on every branch.** Only `pa` touches it; B and C
  deliberately do not.

---

## 12. Open questions for the founder

1. **What does "good enough to merge" look like for a plan?** ~380 threads, no
   clean pass, and the population of findings has shifted from "defects in the
   plan" to "defects in the last round's repairs". A cap — *merge at zero-open,
   accepting that another round would find more* — would end it. Waiting for a
   clean pass may not, since none has ever arrived on any of the three.
2. **Merge order and grants.** Intended A → B → C. Each needs its own grant.
3. **Does `greptile-apps` need a `clean` pattern?** It cannot classify a pass
   today. Deliberately unfixed: no observed greptile body exists to write one
   against, and inventing a regex for an unseen body is the mistake PR #9 was
   about.
4. **The off-device backup destination** (§16.2) is still undecided; doctor
   reports it missing.

---

## 13. After the plans

These three PRs are **plans**, not code. Once each is approved and merged:

1. Execute S2-A → `src/build/hub.sql`, `hubdb.mjs`, `locks.mjs`, `replay.mjs`,
   `tables.mjs`, backup/restore, doctor, the CLI routes, tests.
2. Execute S2-B → `phases.mjs`, `transition.mjs`, `outbox.mjs`, `registry.mjs`,
   `gatestate.mjs`, `loop.mjs`, drills.
3. Execute S2-C → `providerdb.mjs`, `provider.mjs`, `hubguest.mjs`,
   `holds.mjs`, the daemon claim, the `pr_hold` verdict clause and its
   `watcher.mjs` wiring. **This one changes the running guardian**; its effect
   begins at the daemon's next restart, which is a founder-timed act.

Then S3 onward per §14. Also standing: PR-3 (S1 close-out,
`feat/s1-standalone-clones`) is another session's and still in flight.

---

## 14. Environment

```
Node        ~/.nvm/versions/node/v24.17.0/bin/node   (PATH node is v22; node:sqlite warns there)
Repo        ~/Work/Products/reeve                     LIVE daemon — read-only for us
Worktrees   ~/Work/Products/reeve-wt/{pa,pb,pc}       #11, #12, #13
            ~/Work/Products/reeve-wt/s2               the closed #8 branch, recoverable history
Profiles    ~/.reeve/profiles/<owner>/<repo>.json
Hub         ~/.reeve/state/hub.db                     does NOT exist yet; S2 creates it
Suite       for f in test/*.test.mjs; do case "$f" in */escape.test.mjs) continue;; esac; $N "$f"; done
```

**Peer sessions** run concurrently on this machine, mostly in
`~/Work/Products/nextly-workspace/nextly`. PR #14 was one of them, in reeve.
Coordinate via `ListAgents` + `SendMessage` before claiming territory.

---

## 15. Mistakes worth carrying forward

Each was caught by review or by a control, not by intuition.

1. **A truncated query reported absence and I believed it** — and reported it to
   the founder. §1. The instrument agreed with reality on one of three PRs, which
   is what made it credible.
2. **A safety argument that was backwards.** I claimed the SQL comment stripper's
   mistakes "can only be refusals, never admissions". Measured: `SELECT '--';
   BEGIN EXCLUSIVE` passes and runs, because a `--` inside a literal eats the
   semicolon. Less text visible, not more.
3. **Moving a cost instead of removing it.** Measured `integrity_check` off
   `latestSnapshot` and put it into `selfAudit` in the same round — off one
   per-tick caller and onto a busier one.
4. **Writing against a schema I had not re-read**, twice in one round:
   `ended_at` does not exist on `phase_run`, and `lost`/`settled` are not legal
   statuses. Both would have broken every restore.
5. **Deriving from an API without checking its semantics.** `PRAGMA
   table_info.pk` is a position, not a boolean; treating it as one dropped four
   NOT NULL columns.
6. **Guards nothing wired.** `sourceKind` added and never passed; the CLAIMING
   witness demanded and never written; `pr_hold` given a permitted reader and no
   reader; `cancelQueued` advertised as called on every refusal path with exactly
   one caller.
7. **A rule stated once and contradicted four times.** The `escape.test.mjs`
   exclusion was in Global Constraints and absent from four of five suite loops.
8. **Placeholders.** `TABLE_OWNERS` shipped with 8 of 32 entries behind a
   `// ...and so on`, and I reintroduced the same pattern in `DEFAULT_ROW`
   minutes after fixing it.
9. **A test that passes either way**, repeatedly: a `Set` the test owned doing
   the deduplication; a broad `catch` counting a `ReferenceError` as a lock
   refusal; a fixture seeded for the wrong PR so the sweep cleared it first.
