# The claim protocol

**Multiple lanes work this repository at once.** A lane is one session in one worktree. Two
lanes editing the same file, or opening PRs against the same task, is the failure this protocol
exists to prevent — and it is the same failure reeve's own territory leases prevent for builder
tasks, so this protocol is modelled on them deliberately.

**Read this before starting anything. Then read `../MASTER.md` to see what is already held.**

---

## The rules

1. **Claim before starting. Nothing is worked unclaimed.** Not "I'll claim it once I know it's
   feasible" — the exploration is part of the task.
2. **One task at a time per lane.** Finish it, verify it, get it merged, release the claim, then
   claim the next. A lane holding two claims is a lane that will abandon one.
3. **Read the tracker first**, every time, including on resume. Another lane may have claimed
   something since you last looked. Do not touch files another lane's claim names.
4. **Update the tracker after each task, not in a batch.** STATE, PR number, rounds, findings,
   and any decision taken. A batched update is an update that does not happen.
5. **"Done" means merged and verified by content** — never "PR opened", never "PR approved".
   This has already bitten: `docs/TRACKER.md` carries **10 of 20 unchecked boxes sitting on
   merged work**, two of them reading "PR open" for PRs that had merged the day before, because
   the tracker is edited by the PR that builds the work and never again after the merge.
6. **Release a claim you abandon.** A stale claim blocks another lane exactly like a stale
   provider lease blocks a dispatch — a defect this repository fixed in its own code this week.
   Releasing costs one commit. Not releasing costs another lane a day.
7. **A claim is not permission to merge.** Merging needs the founder's explicit **per-PR** grant,
   and grants never carry over.

---

## The mechanism: one file per claim

**One small file per claim, named `<stage>-<task>.md`, under this directory.** Two lanes claiming
different tasks never touch the same file, so **claims never conflict on merge**.

**The stage prefix is load-bearing, not decoration.** Task numbering **restarts at 1 in every
stage** (`../../MASTER-PLAN.md` §B.8), and a released claim is **kept, never deleted** — so a bare
`T1.md` would put S4's claimant on top of S3's historical record, and an S9 reader could not tell
whether a `T1.md` marked HELD belongs to their stage or to one closed a year earlier. Two
independent facts would share one file, which is the thing this design exists to prevent.

```
tasks/reeve-tasks/trackers/claims/
  README.md         this file
  S3-T1.md          claim on S3 task T1
  S3-P2.md          claim on the pre-S3 PR for issue reeve#50
  S4-T1.md          a DIFFERENT task, and a different file, in a later stage
```

**Name the file `<stage>-<task>.md`** — `S3-T1`, `S3-P2`, `S4-T1` — never for the branch and never
for the lane. The stage-and-task pair is what two lanes could collide on, and it is unique across
the roadmap where the task id alone is not.

### The file

Copy this exactly. Every field is required; an absent field is not a default.

```markdown
# Claim: T1 — builder.* FIELDS, and the one reader of the capability switches

stage:      S3
tracker:    ../s3.md
lane:       <session or worktree name, e.g. reeve-wt/c4>
host:       <hostname>
branch:     feat/s3-fields
claimed:    2026-08-27T18:40:00Z
refreshed:  2026-08-27T18:40:00Z
state:      HELD
pr:         —

## Files this claim covers

- `src/profile/schema.mjs`
- `src/build/capabilities.mjs` (new)
- `src/init.mjs`
- `test/profile-validate.test.mjs`
- `test/build-capabilities.test.mjs` (new)

## Notes

<anything another lane needs to know before touching an adjacent file>
```

`state` is one of exactly three words: **HELD · RELEASED · TAKEN OVER.**

### Every state change reaches `main` the same way, or it has not happened

**This is the invariant, and everything below is an instance of it.** Peers discover claims on
`main`. A change that lives on a feature branch is invisible to exactly the audience the protocol
exists to serve, so **a claim file is only ever edited by a PR that contains nothing else, and is
merged before the change counts.**

That covers all five transitions, not just the first:

| transition | when | what a peer sees if it is not published |
|---|---|---|
| **claim** | before any work starts | two lanes both start the same task |
| **heartbeat** | on every push to the feature branch | a live task looks **stale after 24h and is taken over** |
| **release** | when the task merges | a finished task stays **HELD forever**, and the next task never starts |
| **takeover** | when a stale claim is adopted | two lanes both believe they hold it |
| **reclaim** | when abandoned work is picked up | the same |

**Why a whole PR for a one-line edit.** It is one file that nothing else touches, so it reviews
in under a minute and can never conflict. That cost is the price of the property; a protocol whose
state is only sometimes visible is worse than none, because it is trusted.

**Batching is allowed for heartbeats only.** A heartbeat is the one transition whose staleness is
bounded by the 24-hour rule rather than by correctness, so a lane pushing several times a day may
publish one heartbeat PR per day. **Claim, release, takeover and reclaim are never batched** —
each is a fact another lane acts on immediately.

### The heartbeat, and what makes a claim stale

**Touch `refreshed` every time you push.** That is the heartbeat, and it is the only signal
another lane has that you are still alive.

**A claim whose `refreshed` is more than 24 hours old is STALE.** A stale claim may be taken
over — but **takeover is recorded, never silent**:

1. **Archive the outgoing claim as history**: move the previous holder's block down under a
   `## Taken over <date>` heading, marked `TAKEN OVER`, with a line saying who took it and when.
   **Leave its text unedited.** Do not rewrite history into agreement.
2. **Set the file's top-level header to `HELD` in your own name**, with your lane, host and
   timestamps. The header is authoritative; the blocks below it are history. Leaving the header at
   `TAKEN OVER` publishes **no active holder at all**, and a third lane reading `main` sees the
   task as free or ambiguously owned — which is the duplicate work this protocol exists to stop,
   arriving through the procedure meant to prevent it.
3. Publish it as a claim-only PR, like every other transition.
4. Say so in `../MASTER.md`'s *In flight* table.

Twenty-four hours is a **convention, not a measurement**. It is the number at which a lane that
has genuinely stopped is more likely than a lane that is thinking. If it turns out to be wrong,
change it here and say why — do not work around it silently in one lane.

### Reclaiming work that was released unfinished

Rule 6 permits abandoning a task, and a released claim is kept rather than deleted — so a later
lane finds a file at `RELEASED` and **no documented way in**. Recreating it destroys the history
the protocol keeps deliberately; `TAKEN OVER` does not apply, because that transition is for a
**stale `HELD`** claim whose holder may still be alive.

**Append a new claim block to the same file, under a `## Reclaimed <date>` heading**, and set the
file's top-level `state:` to `HELD` with your own lane, host and timestamps.

**The top-level fields are always authoritative; the blocks below them are history.** A reader
who wants to know who holds this task reads the header and stops. A reader who wants to know how
it got here reads down. Never edit an earlier block to agree with the present.

The same rule settles the ambiguity for takeover, which had the same gap: `state: TAKEN OVER` is
the *outgoing* holder's record, and the incoming lane sets the header to `HELD` in its own name.

### Releasing

Set `state: RELEASED`, add the reason and the date, and **publish it as a claim-only PR like every other transition** — a release that only exists on a merged feature branch leaves the task HELD forever to anyone reading `main`. **Do not delete the file.** The
history of who held what, and why they let it go, is the thing that makes a stale claim
diagnosable next time.

---

## Territory: the files a claim covers

**A claim names its files, and the names are the boundary.** Before touching a file that
another lane's claim lists, say so to that lane first.

Some files belong to the **guardian lane** and are never touched without telling it, claim or
no claim:

```
src/daemon.mjs      src/db/**        src/outbox/**     src/github/**
src/pr.mjs          src/verdict.mjs  src/watcher.mjs   src/review/**
src/prompts.mjs
```

And two changes require telling the peer lane **even when you hold the claim**, because they
change a shape other code is written against rather than a behaviour:

- changing the **SHAPE** of `computeVerdict`'s clause set;
- changing the **ORDER** of `nextAction`'s branches.

Use `ListAgents` to find the peer lane (a session named `nextly-integrations-*`), and tell it
before the edit, not after the push.

---

## Why one file per claim, and not a table

A shared claims table is the obvious design and it is the wrong one here. Two lanes claiming
two different tasks would edit the same table on two branches and conflict on every merge —
and the resolution of a claims conflict is exactly the moment when one lane's claim silently
disappears. One file per claim makes the data structure match the concurrency: **independent
facts live in independent files.**

This is the same reason a stage tracker's close-out line is the **last** commit before the PR:
`docs/TRACKER.md` conflicts on every branch, so the conflict is deliberately reduced to one
line.
