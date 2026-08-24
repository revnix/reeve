# Session handoff — 2026-08-24

Supersedes `docs/2026-08-23-session-handoff.md`, which stays readable as history.

Everything here is either **measured** (with a date and the file that records it)
or marked **intent**. If a claim has neither, distrust it.

---

## 0. STATE — MEASURE first, then read what only a person can tell you

Thirteen review rounds found a fact corrected in one place and left standing in
another, so this section became the single place to write them down. Then `main`
moved twice in one afternoon while this file said otherwise, which is the lesson
the single-source rule could not teach on its own: **a fact a command can answer
should not be written down at all.** Writing it down does not make it available,
it makes it a second copy that ages, and the copy is the one people read.

So §0 has two halves, and the split is the point.

### 0.1 Facts to MEASURE — never trust a file for these, this one included

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"   # node 24 is a floor
cd ~/Work/Products/reeve && git fetch -q origin

git log --oneline -1 origin/main                     # what `main` is
git log --oneline -1 HEAD                            # what the DAEMON runs; drift is normal
gh pr list --state open --json number,headRefName,author \
   -q '.[] | "#\(.number) \(.author.login) \(.headRefName)"'      # what is open, and whose

# Is reeve ARMED? Read the PROCESS, never the plist: `launchctl kickstart`
# replays launchd's cached copy, so the file and the process can disagree.
ps -o args= -p "$(launchctl print gui/$(id -u)/com.revnix.reeve | awk '/pid = /{print $3}')"

# Has a real dispatch ever happened? The store is PER REPO, and read-only here:
# sqlite3 opens a missing path by CREATING it, so a wrong path answers "zero rows"
# for a database it just made. This exact mistake produced a confident 0 from an
# empty file at ~/.reeve/state.db.
sqlite3 -readonly ~/.reeve/state/nextlyhq/nextly.db \
  'select (select count(*) from run) as runs, (select count(*) from worker_run) as workers'
./bin/reeve doctor nextlyhq/nextly --as-app           # what is broken today
```

If any of that disagrees with any prose in this repository, the command wins and
the prose is stale. That includes this section.

### 0.2 Facts no command answers — the ones that need a person

These are decisions and intent. A command can tell you `--execute` is absent; only
this can tell you that its absence is deliberate.

| | |
|---|---|
| `--execute` is OFF **on purpose** | it was disarmed on 2026-08-23 after a P0, and re-arming is the founder's call, not a resumed session's |
| the publish fix | **merged** — #19. Repairs are staged and committed by reeve, not by the worker |
| prompt/grant fix | **merged** — #18 |
| the dispatch write-up | **merged** — #15 |
| what a real dispatch has proven | nothing yet under the current contract. If `run` is empty, the publish path is carried by tests alone |
| the tracker | owed for 22–24 Aug; §6 says what belongs in it |
| capability 1 — watch, judge, escalate | the one that is meant to be on |
| capability 2 — repair red CI | built, and gated behind `--execute` above |
| capability 3 — work review threads | half-built; §6 has what it needs and what it is waiting on |
| capability 4 — refuse an unsafe merge | not started; needs a shadow week and the R-01 ruleset flip |
| the builder daemon | not something this programme runs; S2 is a peer's lane, see §7 |

**Change these HERE and nowhere else**; elsewhere, write "see §0". That is
enforced rather than intended: `test/docs-state-is-single-sourced.test.mjs` fails
if a present-tense state claim, or a block naming one of the subjects above,
appears in the resume prompt or in this file outside §0 without deferring to it.

---

## 1. What reeve is, in one paragraph

Two programmes sharing a codebase. **The guardian** watches pull requests, judges
them, escalates, and repairs red CI by dispatching a sandboxed worker. **The
builder** takes a task and builds it across a phase machine. They are separate
daemons with separate stores. Which of them is running is a §0 fact.

---

## 2. The guardian's four capabilities

Whether each of these is on is a §0 fact and is not repeated here. This table
says what each capability IS; §0 says where it stands.

| # | capability | what it does |
|---|---|---|
| 1 | Watch, judge, escalate | reads every open pull request, judges it, and raises what needs a person |
| 2 | Repair red CI | dispatches a sandboxed worker at a red check, gates the diff, and publishes the fix |
| 3 | Work review threads | answers and resolves review findings without a person relaying them |
| 4 | Refuse an unsafe merge | stands between a pull request and `main` as a required check |

---

## 3. The P0 that dominated 22–24 August

**reeve could not publish anything at all.** Its worker's sandbox denied Bash
writes to `.git`, so `git add` and `git commit` failed with `EPERM` on
`.git/index.lock`. Three real dispatches produced three byte-identical CORRECT
fixes and shipped none of them.

Two controls established it was the sandbox: a Bash write elsewhere in the same
worktree succeeded, and an identical copy of the worktree committed fine
unsandboxed. It was a **regression** — reeve published three times on 21 August,
before the OS sandbox landed on 22 August.

Full write-up: `docs/measured/2026-08-23-three-real-dispatches.md`.

**The fix (merged, #19): reeve stages and commits; the worker never touches git's
state.** Three properties worth carrying, because the obvious reading is wrong on
each:

1. **reeve commits BEFORE the gates, not after.** The gates then judge the ref
   that gets pushed, exactly as they judged the worker's own commits, so nothing
   about what may ship changed hands.
2. **reeve stages exactly what the worker declared** in `filesTouched`, via
   `git --literal-pathspecs add --force --pathspec-from-file=- --pathspec-file-nul`.
   Not `git add --all`. See §4 for why. `--literal-pathspecs` is a GLOBAL option and
   must precede the subcommand: after it, git exits with "unknown option" and
   stages nothing. It is there because a filename may begin with `:`, which git
   would otherwise read as pathspec magic rather than as a name.
3. **The worker keeps read-only git** (`status`, `diff`, `log`, `show`) and
   `git clean`. `git clean` is NOT read-only — it deletes untracked files, and
   `-d`/`-x` reach directories and ignored files. It is also not the worker's only
   delete: any script-capable runner can unlink. What bounds the risk is that
   nothing it can reach was ever committed.

---

## 4. The design lesson that cost the most, and is worth the most

**Staging by heuristic produced four defects in four review rounds.** The original
approach was `git add --all` minus the dependency trees preparation had copied in.
Each round found another hole and each fix was another exclusion rule:

- a tree excluded from staging still made the checkout dirty, so the gate quarantined every repair;
- a TRACKED file inside such a tree had its edit silently dropped;
- a NEW file inside one was dropped while the rest published as if complete;
- a declared-but-uncopied path was hidden from staging AND from the dirty check at once.

**Four instances of one shape is a design answer, not four bugs.** Only the worker
knows which of its files were the repair and which were a reproduction script, so
the declaration became the INSTRUCTION rather than a cross-check applied
afterwards. Every exclusion rule disappeared.

The same reasoning then applied one level down, to attribution: excluding copied
trees BY PATH cannot tell reeve's own file from the same file after a worker edits
it — git reports the identical `?? vendor/dep.js` either way. Preparation now
records a **content digest per path** before the worker starts, and the dirty gate
compares content. It is the one fact only reeve knows.

---

## 5. Traps that cost real hours (durable — these do not expire)

- **`launchctl kickstart` restarts from launchd's CACHED plist.** The file can say
  `--execute` while the running process does not have it. Use `bootout` +
  `bootstrap`, and verify with `ps -o args=`, never by reading the file.
- **`loadProfile` runs ONCE at startup.** A profile edit is not in force until the
  daemon restarts.
- **`git diff main..branch` is NOT what a PR proposes.** Compute from
  `git merge-base`.
- **A test that checks a helper works is not a test that it is WIRED IN.** Stub the
  fix back out and confirm the test goes red. This caught false passes repeatedly.
- **A fixture that cannot exhibit the defect passes for the wrong reason.** Three
  times in one day: a whitespace fixture with the space in the middle (trim only
  eats the ends); a declared-but-unchanged fixture using a file that did not exist
  (`git add` rejects that on its own, so the check under test never ran); a peer's
  corrupt-page fixture where the scan answered from an index and never touched the
  damaged page.
- **`git status --porcelain` collapses an entirely untracked directory** to
  `node_modules/` unless you pass `--untracked-files=all`.
- **`-z` output is DATA.** Do not trim it: a leading space can be part of a
  filename. And a rename's source arrives as the NEXT NUL record.
- **A filename may begin with `:`**, which git reads as pathspec magic. Use
  `--literal-pathspecs`.
- **Rename detection reports only the destination.** Use `--no-renames` when you
  need both sides.
- **The commit hook blocks the vendor's name** in commits and PR bodies, including
  factual uses. Rewrite rather than argue.

---

## 6. Unfinished work, and what each piece needs

**Capability 3 — working review threads.** Needs a routing decision; §0 says where
the capability stands and whether the decision has been taken. The guardian's outbox table exists (`src/db/schema.sql:110`)
with `gh.pr.comment` and `gh.thread.resolve` among its kinds, and enqueue / lease /
complete / fail / recover implemented in `src/db/ops.mjs:239-284`. It has **zero
callers and no drainer**. The hub (S2) is building its own, separate outbox for the
BUILDER's effects — genuinely different stores for different daemons, so wiring the
guardian's is not work S4 supersedes.

**A known latent defect to fix when it is wired:** the outbox needs a fencing
token. A paused drainer keeps its pid, so `isAlive` says yes for exactly the
process that must be refused, and a second drainer can deliver the same GitHub
effect twice. `settleOutbox` also updates by `id` with no lease check.

- The repair is `lease_token INTEGER NOT NULL DEFAULT 0`, bumped per lease, matched
  at settle — added through `ADDED_COLUMNS` in `ops.mjs:22`, which handles additive
  columns on populated tables (measured).
- **Do NOT reuse `attempts` for this.** It is the retry BUDGET (`dead = attempts >=
  max_attempts`). A fence must increment on every lease including a no-op one; a
  budget must increment only on a real attempt. A lease is not an attempt, and one
  column cannot be both. reeve's own hub already carries `lease_token` beside
  `attempts` for exactly this reason.
- There is **no deadline** on this. An earlier version of this note claimed one,
  based on reading `RESHAPED`'s refusal (which is for a changed UNIQUE constraint,
  not an added column). That was wrong.

**The tracker entry has been owed since 23 August** — for PR #14, the arming, the
three dispatches, the P0, the disarming and the PRs that fixed it. Whether it has
been written yet is in §0.

**`docs/HANDOFF.md`'s "Proven" list has been dated.** Its "three complete
dispatches … reeve published → green" was true on 21 August and false from 22
August, when the OS sandbox took the publishing half away. The entry now carries
that history, says the capability was rebuilt on reeve's side rather than restored
on the worker's, and points at §0 for whether a real run has since agreed with the
tests.

**Also open:** ntfy read user (needs shell on 95.217.11.127); second project
(`rextaihq/rext-backend`); R-01 the ruleset (admins bypass everything, no required
status check).

---

## 7. The builder programme

Thirteen stages, S0–S12. S0 and S1 are done. **S2 is a peer's lane**, held by a
session that has been renamed at least once — ask over SendMessage rather than
going by the name written here, and see §0 for what of theirs is open. S3 onward
is authorised only after S0–S2 land. Do not take builder work without checking
with them first.

Design: `docs/2026-08-21-builder-design.md`.

---

## 8. Founder decisions — do not re-litigate

1. **Arm with merge authority** (`propose_and_merge` + admin). Taken knowingly;
   R-01 gets fixed "at the end".
2. **Worker limits: 10 min / 20 turns / 1 worker.** Applied.
3. **`maxFixAttemptsPerFinding` stays 1.** Note the "leave it armed" half of this
   decision was SUPERSEDED the same day once the P0 was understood.
4. **Signing: leave it as a doctor check.** reeve commits unsigned; doctor reports
   a signature-requiring ruleset rather than reeve acquiring a key.
5. **PRs #1 and #2 are closed.** Do not reopen.
6. **No `git push --dry-run` probe in doctor.** The one-off was run by hand; both
   repos returned PUSH AUTHORISED.
7. **Merge #15, #18, #19 and handle later feedback in ONE follow-up PR** (#22).

---

## 9. How to work here

- **Ten-round review cap per PR.** At the cap, answer and resolve what is there, do
  NOT request another review, and bring the founder a judgement. #15 hit it at 43
  findings and was merged on it.
- **Comment `@codex review` on every PR and every push.** Reply to AND resolve each
  thread via GraphQL; replying alone does not clear it.
- **Read BOTH verdict endpoints.** Findings arrive as review threads; a clean pass
  arrives as an ISSUE comment with no review object. Reading one answers the wrong
  question. Check the verdict's `commit_id` against the head — a verdict at an
  older head is stale.
- **`reviewThreads(first:N)` truncates silently.** Compare `totalCount` to what you
  fetched. Under-reporting reads as clean.
- **Zero-open is a SNAPSHOT, not a state.** A review requested before a merge can
  land after it. Measured twice in one day by two sessions.
- Conventional Commits, never `--no-verify`, no AI attribution anywhere.
- **Never merge without an explicit grant.** Each one is spent when used.

---

## 10. The rules that generalise past reeve

These came out of 100+ review findings in two days and are the most portable thing
in this document.

- **Never read ABSENCE as success; read a positive signal that the check RAN.** A
  truncated query, a reviewer that never ran, a verdict not yet in, a watcher that
  reports only on change — all fail in the direction that reads as "nothing is
  wrong". Each has a positive signal: a count, a `success` conclusion ever
  existing, a `commit_id`, a heartbeat.
- **The third instance of a shape is evidence about the DESIGN.** Remove the
  fallible read rather than correcting it again.
- **Declaring a class swept is itself an unverified read.** After centralising,
  GREP for the thing, then add the test that fails when a new copy appears. Twice
  the fix contained the defect it was fixing.
- **A mechanism's LIMIT does not travel with its behaviour.** Carrying "this
  refuses on a populated table" across a boundary without checking what enforces it
  there produced a false deadline handed to the founder.
- **Two facts that look alike are not one fact.** A fence and a retry budget both
  count up; merging them is overloading, not deduplication.
- **A noisy gate is also an insensitive one.** A guard that fires on correct text
  gets weakened or ignored.
- **Verify a peer's claim before acting on it, and concede when they are right.**
  Three claims were traded today; checking each against the code changed the answer
  twice.

---

## 11. Verification commands

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"   # node 24 is a floor
cd ~/Work/Products/reeve && git fetch -q origin && git log --oneline -3 origin/main
for f in test/*.test.mjs; do node "$f" >/dev/null || echo "FAILED $f"; done
./bin/reeve doctor nextlyhq/nextly --as-app
ps -o args= -p "$(launchctl print gui/$(id -u)/com.revnix.reeve | awk '/pid = /{print $3}')"
tail -30 ~/.reeve/reeve.log
```

The `ps` line is the only way to know whether reeve is actually armed.

To verify a squash merge landed, ask whether YOUR PATCH is present rather than
comparing trees:

```bash
BASE=$(git merge-base origin/main <your-pushed-head>)
git diff $BASE <your-pushed-head> | git apply --reverse --check -
# run from a clean checkout of origin/main; exit 0 == every hunk is there
```

Read a FAILURE carefully: exact hunks stop reverse-applying once a LATER commit
touches the same lines, which is not the same as work being lost. Measured on
24 Aug — #18 merged fine, #19 then edited the same functions, and #18's patch
stopped reverse-applying while every line was present.

---

## 12a. Why the resume prompt is shaped the way it is

Design rationale, kept here because this is where rationale belongs and because a
prompt with prose around it grows facts in that prose. The prompt file is now the
fenced block and nothing else, and a test enforces that.

- **It states no current facts, and says so.** Ten review rounds found the same
  drift, twice inside the fix for it. §0 exists so there is exactly one place to
  correct.
- **It leads with verification**, and makes the `ps` check non-optional: a
  plist/process divergence is invisible to anyone reading files, and it already
  cost a false "done" once.
- **It carries the traps rather than the conclusions.** Conclusions are in this
  document. The traps are what cost hours, and they are what a fresh session
  cannot re-derive.
- **It names the peers**, because cross-session work has found real defects here
  rather than merely avoided collisions.
- **It puts the experiment second, not first.** Which experiment is worth a dollar
  is the founder's call, not a resumed session's, and the prompt's job is to hand
  over the choice rather than to pre-empt it. What the recommendation rests on is
  a comparison between two things that can each move: what the tests say, and what
  a real dispatch has shown. §0 holds both.
- **The epilogue that used to live in the prompt file is this section.** It was the
  tenth place a state claim appeared outside §0, and it appeared there because
  commentary about a document is exactly where facts about the document collect.
  Removing the prose removed the surface.

---

## 12. Open risks

- **The publish fix may still be unproven in the field.** The test suite carries
  it; §0 says whether a real dispatch ever has. The defect it fixes was found by a
  dispatch that roughly 640 green tests never saw, so those two readings are not
  interchangeable and the gap between them is the risk. Re-arming should be treated
  as an experiment with a result to read.
- **The daemon's checkout can drift behind `main`**, which puts the running process
  on older code than anything the tests exercise. §0 says where it stands. Read it
  from the process with `ps`, never from the plist, and never from this line.
- **`maxTurns: 20` is probably too tight.** A correct fix ran out of turns twice —
  but 13 of one run's 36 tool calls went on an impossible instruction, so re-measure
  after the fix rather than raising it blind.
- **`@nextly-bot` appears never to have delivered a review**, across ~3,000 sampled
  runs over 8 days (measured by session `nextly-workspace-d5`). That is a nextly
  repo-config problem, not reeve's, but it is the same absence-reads-as-success
  shape and the founder should rotate the secret.
