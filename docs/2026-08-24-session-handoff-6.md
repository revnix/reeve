# Session handoff: S2-A built, two PRs open (2026-08-24)

Supersedes `docs/2026-08-23-session-handoff-5.md`, which described three plan PRs and
one follow-up. **Those are all merged.** Read this one. Companion resume prompt:
`2026-08-24-resume-prompt-6.md`.

Everything here is either **measured** (with the command that measured it) or labelled
as intent. Where I got something wrong during the session and corrected it, the
correction is recorded rather than the tidy version — the wrong turns are load-bearing.

---

## 1. Where things stand

| | |
|---|---|
| Repository | `revnix/reeve` (private) |
| `origin/main` | **`bc17a06`** — "Apply the S2 plans' deferred review findings (#17)" |
| Live daemon | **RUNNING** from `~/Work/Products/reeve` against `nextlyhq/nextly`, launchd `KeepAlive`, pid 84409 at handoff (14h31m uptime) |
| My open PR #20 | **S2-A: the hub store.** `feat/s2-hub-store` @ `294cdb8`, 13 commits, base `main`. CLEAN, CI green. **18 threads, 5 UNRESOLVED** |
| My open PR #21 | **CLI flag discipline.** `fix/cli-flag-discipline` @ `3e1e32c`, 1 commit, base **`feat/s2-hub-store`** (stacked on #20). CLEAN, CI green. **5 threads, 5 UNRESOLVED** |
| Not mine | #15 `docs/first-dispatches`, #18 `fix/prompt-grant-agreement`, #19 `fix/reeve-commits` — other sessions. **Do not touch or merge.** |
| Suite | **65 files, 0 failures** on #21's head; `escape.test.mjs` always excluded |

**No merge grant has been given for either PR.** A grant is per-PR and is spent when used.

---

## 2. What was built this session

S2-A — the hub store — implemented end to end from
`docs/superpowers/plans/2026-08-23-s2a-hub-store.md`, all 13 tasks.

| commit | what |
|---|---|
| `ffc3170` | Task 1 — `hubPathFor`, `openHub` + forward-only migration runner, `hubTx` |
| `d5d0e17` | Tasks 2–6 — the 31-table migration 1, `hubEvent`, `migrationPlan` |
| `791dc8a` | Task 7 — `locks.mjs` (singleton/writer/maintenance) + `bin/reeve build` route |
| `adf3f73` | Task 8 — backup discovers the hub, `validateSnapshot`, exclusive publish |
| `093199c` | Task 9 — `replay.mjs`, `restoreHub`, the destructive drill |
| `1ad0c45` | Task 10 — `hubFindings` + **`renderHub` (which did not exist)** |
| `6623f25` | Task 11 — the prose-versus-DDL cross-check, 266 assertions |
| `c518c86` | Task 12 — `ci.flakePatterns` retired |
| `887467e` | Task 13 — migration 1 frozen, tracker, PR opened |
| `c8766b0` | review round 1 — 5 findings |
| `0d99b79` | the outbox lease fence (found by research, not review) |
| `27c1198` | review round 2 — 3 findings |
| `294cdb8` | review round 3 — 5 findings |

**Measured properties:** 32 tables in a live store (31 in `hub.sql` + `schema_version`),
23 indexes, `HUB_TABLES` equals the live table set **in both directions**, migration 1
frozen over **both** halves (the DDL text and the `up()` source), each verified red on
its own stub.

Nothing in S2-A dispatches a worker or touches GitHub. `worker.isolation` is still
`none` and dispatch is still refused in code.

---

## 3. THE OPEN WORK — 10 unresolved findings

These are the immediate task. Thread IDs are what `reply.sh` needs.

### PR #20 (5 unresolved, review at 05:40:43Z on `294cdb8`)

1. **`PRRT_kwDOT-hWms6blqEw`** — `src/backup.mjs:1074` **P1** — *Keep the synthetic lock
   held until cleanup completes.* An absent-hub restore that fails after taking its
   synthetic lock releases the lock **before** removing the synthetic database. A
   `build run` waiting in `acquireSingleton` wakes, takes its lease in that file, and
   then has the file unlinked underneath it. This is the **remaining half** of the
   synthetic problem partially fixed in `294cdb8` — that fix covered the two-restore
   loser, this is the failure-path ordering.
2. **`PRRT_kwDOT-hWms6blqEy`** — `src/selfaudit.mjs:209` **P1** — *Report a previously
   created hub that disappears.* The `existsSync(hub)` guard suppresses the only
   hub-integrity finding when `hub.db` is DELETED after init, and `everyStore` enumerates
   only existing files — so the same tick snapshots the repo stores and says nothing about
   the missing authority database. The CLI half was fixed (`backup --hub` now requires a
   hub result); **the daemon/self-audit path was not.**
3. **`PRRT_kwDOT-hWms6blqE1`** — `bin/reeve:569` **P2** — *Handle version-zero hubs in
   builder doctor.* **FOURTH site of one class.** `build run`, `restoreHub` and
   `build status` were each fixed for this; `builder doctor` still accepts version 0 and
   `hubFindings` then queries `repo_gate_state`, producing an uncaught SQLite stack trace
   instead of an H-0 finding.
4. **`PRRT_kwDOT-hWms6blqE3`** — `bin/reeve:303` **P1** — *Publish event exports
   atomically.* `export-events --hub` uses `writeFileSync`, which **truncates the previous
   valid tail** before writing the replacement. A kill or a full disk then leaves a partial
   file with no manifest, having destroyed the last usable tail — and a later restore
   permanently loses every post-snapshot event it protected. Needs write-temp-then-rename,
   the same discipline `snapshot()` already uses.
5. **`PRRT_kwDOT-hWms6blqE7`** — `src/build/replay.mjs:161` **P2** — *Validate keys before
   replaying delete events.* The `h.delete` branch runs **above** the missing-key guard
   added in `093199c`, so a delete with an absent key still produces the opaque bind error
   the guard exists to replace — and a key serialised as `null` matches no row, is counted
   as `applied`, and the release event is appended, leaving the restored projection holding
   a lease its own log says was released.

### PR #21 (5 unresolved, review at 05:55:31Z on `3e1e32c`)

1. **`PRRT_kwDOT-hWms6blzHr`** — `bin/reeve:203` **P1** — *Refuse missing `--home`
   values.* A trailing `--home`, or `--home --json`, gives `opt("home")` an `undefined` or
   a flag string with no validation — so it silently falls back to `$REEVE_HOME`, or uses
   a relative directory called `--json`. **This recreates the exact wrong-home failure #21
   exists to prevent.** Valued flags need their next token checked.
2. **`PRRT_kwDOT-hWms6blzHw`** — `bin/reeve:203` **P1** — *Propagate `--home` into
   containment policy.* `credentialPaths()` (`src/sandbox.mjs:192`) and the canary decoy
   (`src/daemon.mjs:362`) read `process.env.REEVE_HOME` directly, so `--home` changes only
   the local `HOME`. The generated sandbox can omit the custom root, and the canary can
   measure a decoy under `~/.reeve` and report **containment closed**. This one touches
   containment and is the most serious of the five.
3. **`PRRT_kwDOT-hWms6blzHy`** — `bin/reeve:120` **P2** — *Apply `--home` when initializing
   sidecar profiles.* `profilePath()` in `src/init.mjs:26-29` unconditionally selects
   `~/.reeve/profiles`, so `reeve init --home /custom --write` can overwrite the operator's
   real profile while the caller believes it is isolated.
4. **`PRRT_kwDOT-hWms6blzH2`** — `bin/reeve:174` **P2** — *Reject unsupported single-dash
   flags.* The refusal only examines `--` tokens, so `reeve init -w` becomes an unused
   positional and the command proceeds as though the flag were absent — the same silence,
   one syntax over.
5. **`PRRT_kwDOT-hWms6blzH8`** — `bin/reeve:152` **P1** — *Handle `--help` before executing
   commands.* I added `help` to the registry and **no route checks it**, so
   `reeve restore --hub --help` selects the newest snapshot and **performs a restore**.
   This is a defect I introduced in `3e1e32c`.

---

## 4. Founder decisions — do not re-litigate

1. **Merge at zero-open, not at a clean pass** (2026-08-23). Decided after ~490 threads
   over 16 rounds on the plan PRs with no clean pass ever arriving.
2. **#20: wait for one more review, then ask for the grant** (2026-08-24). Chosen over
   granting immediately, because round 3 found a defect that would have deleted an
   operator's whole backup set on a typo, and another that destroyed a WAL during
   recovery — both in the half of the PR that was then unreviewed. **That review has now
   arrived (5 findings), so the condition is: work them to zero-open, then ask.**
3. **The CLI flag fix gets its own small PR before S2-B** (2026-08-24) → that is #21.
4. **Treat the CLI as the product.** reeve has no GUI; its interface is the CLI and its
   findings. `builder doctor` / `build status` / refusal wording get real design attention.
5. **Execute S2-A now; research before S2-B and S2-C.** The research pass on lease fencing
   is DONE and produced `0d99b79` (see §6). The remaining research questions are in §8.
6. **The guardian fails OPEN** when the hub is missing, locked or corrupt; the builder
   fails closed. The scheduler restrains the builder and must never become a new way to
   silence the watchman.
7. **S2 ships no worker dispatch.**
8. **`ci.flakePatterns` is REMOVED** — done, in code and in the live profile (§7).
9. **Fold changes into the existing PR.** Do not open new PRs for small changes.
10. **Never merge without an explicit per-PR grant**; a grant is spent when used.

---

## 5. Hard rules

- **Never merge without a grant.** Neither #20 nor #21 has one.
- **Never `--no-verify`.** Conventional Commits, lowercase, `type(scope): subject`, ≤72
  chars. **No Claude attribution anywhere.**
- **Do not** restart the reeve daemon, run `launchctl`, run `reeve canary`, or `git pull`
  in `~/Work/Products/reeve` — a live guardian executes `bin/reeve` from that working tree
  directly, and `reeve canary` costs a real model call and writes a shared state file at
  `~/.reeve/canary/<owner>/<repo>.json` that the daemon reads.
- **Work in the worktrees.** `git fetch` is fine.
- **`test/escape.test.mjs` is excluded** from suite runs — it writes decoys into that same
  shared canary tree.
- **Scope every test and manual run with `REEVE_HOME=<dir>`, never a flag** — see §7.
- **`build run` is a heartbeat loop.** Never run it in the foreground without a timeout,
  and if you background it, kill it **by pid** — `kill %1` does not reach a job started in
  a subshell. I leaked four daemons this way; they ran for 1h45m before I noticed. All
  four were scoped to temp homes, so nothing was damaged, and they were killed at handoff.

---

## 6. The research pass, and what it found

The founder approved a research pass on lease fencing before S2-B/S2-C. It was done and
it changed the schema.

The literature (Kleppmann, *How to do distributed locking*) is that a TTL plus a liveness
check is **not** sufficient: a paused process keeps its pid, so `isAlive` says yes for
exactly the process that must be refused. Correctness needs a monotonic token checked at
the write.

Auditing reeve's own leases against that criterion found **three columns S2-B requires
that migration 1 did not declare**, including the fence itself:

- `outbox.worker TEXT` — the lease owner
- `outbox.lease_token INTEGER NOT NULL DEFAULT 0` — bumped per lease; monotonic per row;
  survives a restart because it lives in the row rather than in a process
- `task_territory.pinned INTEGER NOT NULL DEFAULT 0`

S2-B documents `settleEffect` as fenced on the **active lease** rather than the row id,
with the exact failure spelled out: *worker A stalls past expiry, `recoverEffects` returns
the row to pending, B leases it, and A settles B's live delivery.* The CAS was
unimplementable. Fixed in `0d99b79`, done **while migration 1 was still editable** — after
#20 merges these become migration 2 and every existing store needs upgrading for something
that was free.

**Two corrections to my own work here, recorded because the wrong turns matter:** I first
reported *five* missing columns — two of those existed and my candidate list had them
paired with the wrong tables. And my first audit instrument produced ~130 candidates that
were mostly JS identifiers; the shipped one scans only INSERT column lists, where a name
is a column or nothing.

The durable output is the instrument, in `test/hub-crosscheck.test.mjs`: it scans every
INSERT column list in S2-B and S2-C and asserts each column exists in migration 1, with a
control that the scan read something. Verified red by removing `task_territory.pinned`.

**Other lease tables need no token** and that is deliberate: SQLite's own write lock under
`BEGIN IMMEDIATE` serialises them. The outbox is the one whose holder acts **outside** the
transaction, against GitHub.

---

## 7. Measured facts. Do not re-derive.

| Fact | Consequence |
|---|---|
| **`bin/reeve` has no `--home` flag and IGNORES unknown flags** (fixed in #21, but see §3) | `--home /tmp/x` operated on the real `~/.reeve`. It created `state/hub.db` there during this session; backed up and removed. **Scope with `REEVE_HOME`.** |
| **Six valued flags were missing from `VALUED`** — `to, from, backups, keep, days, tail` | `reeve backup --to some/place` answered `no state at <home>/state/some/place.db`: it read the flag's VALUE as the repository. `--tail` takes a path, so this hit the one command run after losing a hub. Fixed in #21. |
| **Closing a handle whose open FAILED makes SQLite delete `-wal` and `-shm`** | Measured: `after open: true true` → `after close: false false`. So `rawOpen`'s cleanup destroyed the WAL before `restoreHub` knew the hub was unreadable. Sidecars are now preserved **before any open attempt**. |
| **`Number("aa")` is `NaN` and `slice(NaN)` is `slice(0)`** | `--keep aa` deleted **every** snapshot while printing success. All of `0`, `-1`, `aa`, `2.5` reported success before the fix. |
| **`opt()` returns `null`, not `undefined`, for an absent flag** | A `=== undefined` check rejected the default path and broke every plain `backup --hub`. |
| **`openHub` commits `schema_version` as plain DDL BEFORE migration 1's transaction** | An interrupted first run leaves a store where the version query succeeds and returns 0 while no other table exists. **Existence is not readiness, and neither is openability.** Four sites: `build run`, `restoreHub`, `build status` (fixed) and `builder doctor` (§3). |
| **`ci.flakePatterns`: profile as-is is INVALID under new code and valid under running code; with the key removed, valid under both** | So the profile had to be stripped first. Done: `~/.reeve/profiles/nextlyhq/nextly.json`, backup at `nextly.json.bak-flakepatterns-1787492030`, only that key differs, daemon not restarted and verified still ticking. |
| **`HUB_TABLES` == the live table set, both directions, 32 == 32** | Task 11's central assertion holds; `HUB_TABLES` is derived from `hub.sql` at module load, not retyped. |
| Suite baseline | **65 files, 0 failures** on #21's head. `dispatch-e2e.test.mjs` alone takes ~126s, so budget **>2 min** and run it in the background. |
| `ops/merge-policy` on `nextlyhq/nextly` is **neutral across 24 runs on 3 PRs** | Informational, non-gating. Reported by a peer session. |
| Four Claude sessions push to `nextlyhq/nextly` concurrently | The guardian's PR churn is four lanes, not one. |

Earlier measured facts from handoff-5 still stand: `integrity_check` costs ~1.1 ms/MB and
does **not** report foreign-key violations; an open SQLite handle never notices an atomic
rename over its path; `PRAGMA table_info.pk` is a 1-based position, not a boolean; own
properties shadow a prototype method rather than removing it.

---

## 8. What remains, in order

1. **Work the 10 findings in §3.** #21's are smaller and its P1s are more dangerous
   (`--help` performs a restore; `--home` can make the canary report containment closed).
   Consider doing #21 first for that reason.
2. **Ask for the merge grant on #20** once it is at zero-open with CI green. The founder's
   condition (§4.2) is satisfied by working the round that has now arrived.
3. **#21 merges after #20** — it is stacked, and GitHub retargets it to `main` automatically
   when #20 merges.
4. **The remaining research questions**, before S2-B and S2-C:
   - what SQLite operators actually do about torn snapshots and WAL sidecars (partly
     answered by the close-deletes-sidecars finding in §7)
   - the DX of the `builder doctor` / `build status` surface — exit codes, machine-readable
     output beside human output, and the wording of every refusal
5. **S2-B execution** — `phases.mjs`, `transition.mjs`, `outbox.mjs`, `registry.mjs`,
   `gatestate.mjs`, `loop.mjs`, drills. Plan:
   `docs/superpowers/plans/2026-08-23-s2b-phase-machine.md`, 7 tasks.
6. **S2-C execution** — `providerdb.mjs`, `provider.mjs`, `hubguest.mjs`, `holds.mjs`, the
   daemon claim, the `pr_hold` verdict clause and its `watcher.mjs` wiring. **This one
   changes the running guardian**; its effect begins at the daemon's next restart, which is
   a founder-timed act. Plan: `…-s2c-provider-scheduler.md`, 5 tasks.
7. **Standing, lower priority:** the off-device backup destination is undecided and doctor
   reports it missing; `greptile-apps` still has no `clean` pattern.

---

## 9. Strategy that worked, and should continue

**Execute the plan rather than review it further.** The three S2 plans absorbed ~490
review findings over 16 rounds. Executing S2-A found **15 more defects** that review never
saw, including a test that could not fail, a `renderHub` that was called four times and
never defined, and an operator message that said "never backed up" when every backup was
corrupt. The durable finding: **a plan can survive sixteen adversarial review rounds and
still contain a test that cannot fail.**

**The four-check stub loop is not optional.** Control green → stub applied **and verified
to parse** → the RIGHT assertion red → restore verified byte-identical. A stub that does
not parse proves nothing: my first attempt at one left a dangling `return` and produced
zero failures, which reads exactly like "the test cannot detect it".

**After a fix, ask what it made newly reachable.** Roughly half of each late round's
findings were defects in the previous round's repairs. Two shapes dominate:
- a repair that spans several sites and lands at only some (version-0: four sites; the
  `snapshotAll` contract: CLI updated, daemon not)
- a repair that silently trades away an unnamed property (temp+rename bought atomicity by
  selling the exclusivity `VACUUM INTO` already had)

**Prefer changing the field to teaching the caller.** `deferred` was `ok: false` and two
independent callers read it as a failure. Two callers making the same mistake is not two
bugs; it is a field whose meaning does not match its use.

**Suppression requires positive knowledge.** `projects: []` means both "lists nothing" and
"could not be read". Filtering on it would have hidden every unsafe-authority finding when
`projects.json` broke. `projectsKnown` defaults to **false**.

**Say what is not tested.** The synthetic-loser race has no deterministic seam; I said so
on the thread rather than add an assertion that passes for a different reason and reads
like coverage.

---

## 10. The scripts that die with this session — rebuild them FIRST

`reviewThreads(first:100)` silently truncates and PRs here go past 100 threads. Always
read `totalCount` and compare it to what you fetched.

```bash
#!/bin/bash
# threads.sh <pr> — unresolved review threads, PAGINATED, with a truncation control.
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
# reply.sh <threadId> <bodyFile> — reply, then resolve. Replying alone does NOT clear it.
set -e
TID="$1"; BODY="$(cat "$2")"
gh api graphql -f query='mutation($t:ID!,$b:String!){ addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t, body:$b}){ comment{ id } } }' -F t="$TID" -F b="$BODY" --jq '.data.addPullRequestReviewThreadReply.comment.id' >/dev/null
gh api graphql -f query='mutation($t:ID!){ resolveReviewThread(input:{threadId:$t}){ thread{ isResolved } } }' -F t="$TID" --jq '.data.resolveReviewThread.thread.isResolved'
```

**Do not loop over thread IDs in zsh.** I misrouted every reply twice this way: zsh arrays
are 1-indexed, and unquoted `$VAR` is not word-split. Write the calls out explicitly, one
per line, and then **verify the routing** by fetching each thread's first and last comment
and checking the reply cites the finding.

**A `| head` or `| tail` on a findings listing hides findings.** I truncated my own output
three times this session and twice concluded the wrong thing from it.

**Codex has four verdict shapes:** findings → a review object with inline comments; a
**clean pass** → an ISSUE comment on `issues/<n>/comments` containing `Didn't find any
major issues` + `Reviewed commit: <sha>`, with **no review object at all**; a refusal →
an issue comment saying `Something went wrong` / `You have reached your Codex usage
limits`, which is **not** a pass; and "no suggestions" → a review object with zero inline
comments plus a 👍 on the `@codex review` comment. **👀 means in flight.** Read both
endpoints. A clean pass DID arrive on #17 at `13eff6dc` — handoff-5's claim that none ever
had is out of date.

The cross-document invariant script from handoff-5 §7 still applies and still passes; it
lives in a scratchpad and dies with the session. Rebuild it from that document if a plan
document is edited again. It is not needed for pure code work.

---

## 11. Environment

```
Node        ~/.nvm/versions/node/v24.17.0/bin/node   (PATH node is v22; node:sqlite warns there)
Repo        ~/Work/Products/reeve                    LIVE daemon — read-only for us
Worktrees   ~/Work/Products/reeve-wt/hub             feat/s2-hub-store  (PR #20)
            ~/Work/Products/reeve-wt/cli             fix/cli-flag-discipline (PR #21)
            ~/Work/Products/reeve-wt/pa              fix/s2-plan-review-findings (merged, #17)
            ~/Work/Products/reeve-wt/pb , pc         merged plan branches
            ~/Work/Products/reeve-wt/paths           docs/first-dispatches — NOT MINE (#15)
Profiles    ~/.reeve/profiles/<owner>/<repo>.json
Hub         ~/.reeve/state/hub.db                    ABSENT, and should stay absent
Suite       for f in test/*.test.mjs; do case "$f" in */escape.test.mjs) continue;; esac
            $N "$f" >/dev/null || echo "FAILED $f"; done
            (>2 min; run in the background)
```

---

## 12. Mistakes worth carrying forward

1. **A rule stated in prose is not a rule.** `renderHub` was called four times, named in an
   import, described as "hubFindings' human renderer" — and defined nowhere. I did the same
   thing myself: I wrote the plan instruction saying `basename` MUST be added to
   `bin/reeve`'s import, then did not add it.
2. **My instrument could not represent the failure, four times.** Checking
   `Object.entries(row)` cannot see a MISSING key. A `/repo/i` regex on stderr depended on
   the working directory. A 130-candidate column audit was noise. A grep for `\blog\b`
   matched `console.log`.
3. **A stub that does not parse proves nothing**, and a green suite after a stub is not
   evidence until you have checked the stub was valid.
4. **My own assertions were weak twice.** One passed vacuously when the finding was absent
   (`String(undefined)` matches nothing). One asserted the escalations map while the defect
   was in the log.
5. **Sweeping by memory instead of by invariant.** Version-0 has four sites; I fixed three
   in three separate commits, each time believing I had swept the class.
6. **A leaked daemon is silent.** Four `build run` processes survived `kill %1` because the
   job was in a subshell, and ran for 1h45m.
7. **Check whose claim it is before correcting it.** The `DatabaseSync` import I blamed on
   the plan was instructed in the plan's own comment; the omission was mine.
