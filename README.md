# reeve

An agent-ops control plane. It watches the pull requests an agent fleet opens,
reads CI, root-causes failures, dispatches workers to fix them, decides whether a
PR is genuinely safe to merge, and publishes that decision to GitHub **so that
GitHub does the refusing**.

It serves many projects of different stacks from one engine plus a small
per-project profile.

---

## The one idea

> An agent may reason probabilistically. **Authorization, state transitions,
> evidence binding and merge decisions must be deterministic, durable and
> independently verifiable.**

The CLI is the deterministic half and contains no model call that decides
anything. The prompts are the probabilistic half and cannot merge anything.

Three rules follow, and most of the code exists to hold them:

**UNKNOWN never merges.** Three outcomes — PASS, BLOCK, UNKNOWN — and only one
merges. Absence is never success. "Not checkable" blocks. The gate asserts that a
check run *exists* for the revision it judges, not merely that nothing failed.
Every fail-open defect in the system reeve replaces was an UNKNOWN rendered as a
PASS: an absent gate script read as a pass, a rate-limited reviewer reporting
success, a fork PR with zero checks.

**reeve does not merge.** It computes a verdict, publishes it as a check run bound
to an exact `head_sha`, and GitHub refuses. The actuator runs as a GitHub App
installation, which is not an org admin and therefore *cannot* bypass. This
inverts the failure mode: a stale reeve fails to publish and the merge blocks,
where the old design merged on stale logic.

**A worker is contained by the tool layer, not by its prompt.** Risk paths,
forbidden commands and territory are compiled into a scoped allowlist and a
settings file the CLI enforces. Workers hold no push or merge authority; reeve
publishes after checking what git says changed.

---

## Requirements

- **Node ≥ 24.10.0.** `node:sqlite` still emits an experimental warning on 22.x
  and the state layer is the authority, and `DatabaseSync.setAuthorizer` -- which
  the guardian's restricted hub connection refuses to open without -- arrived in
  24.10.0. `package.json` enforces the same floor. On this machine `node` on
  `PATH` is v22, so use the absolute path:
  `~/.nvm/versions/node/v24.17.0/bin/node`.
- `git` and the `gh` CLI, authenticated.
- `claude` on `PATH` for dispatch (not needed to observe).

## Install

```sh
git clone git@github.com:revnix/reeve.git && cd reeve
alias reeve='~/.nvm/versions/node/v24.17.0/bin/node ~/Work/Products/reeve/bin/reeve'

reeve init                 # detect this repo, and ASK about anything ambiguous
reeve init --set project.kind=product --write
reeve doctor <owner/repo>  # what is actually true right now
```

`init` never guesses where guessing would change what the gate judges. Two
lockfiles, a mixed merge history or two formatters come back as **questions** with
the evidence that made them ambiguous.

## Layout

| | Where | Notes |
|---|---|---|
| **core** | this repository | project-agnostic |
| **profile** | `~/.reeve/profiles/<owner>/<repo>.json` | per project; **never inside a repo** |
| **state** | `~/.reeve/state/<owner>/<repo>.db` | SQLite; keyed by owner *and* repo |
| dashboard | `~/.reeve/dash/<owner>/<repo>.html` | rewritten every tick |
| credentials | `~/.reeve/credentials/` | mode 600 |
| log | `~/.reeve/reeve.log` | |
| **halt** | `~/.reeve/HALT` | create it to stop everything, including workers in flight |

`~/.reeve` is deliberately not a git repository. Profiles and the App private key
therefore cannot be committed into a public or client repo by accident — a
structural guarantee rather than a rule someone has to remember.

## Commands

```
reeve doctor [owner/repo]   what is true now      0 ok · 1 broken · 3 degraded
      --as-app                also prove the GitHub App can act here
reeve init                  detect → preview → merge → prove
      --set k=v --write       0 no-op · 2 changed · 1 needs an answer
reeve status [owner/repo]   what is happening     --health, --json
reeve why <pr>              the decision trail, newest first, with the clauses
reeve dash                  write the one-page view
reeve run [owner/repo]      the daemon
      --tick                  one pass and exit
      --execute               dispatch workers        (default: report only)
      --enforce               publish real conclusions (default: shadow/neutral)
```

## Running it unattended

```sh
cp deploy/com.revnix.reeve.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.revnix.reeve.plist
launchctl print gui/$(id -u)/com.revnix.reeve | grep -E 'state|last exit'
```

`launchctl print` is the only place a startup failure is visible: launchd never
sources a shell profile, so a bare `node` fails **exit 78 with an empty stderr
log**. The plist names an absolute interpreter and an explicit repository for
exactly that reason — passing no repository made it detect one from its working
directory and spend every tick watching the wrong project.

## Runbook

**Is it alive?** `reeve status` leads with a warning when the daemon has stopped
ticking. Freshness is measured against the clock, not against the newest stored
row, because comparing rows to each other made a dead daemon look permanently
current.

**Stop everything:** `touch ~/.reeve/HALT`. The halt switch fails closed and
terminates workers in flight.

**Why did it decide that?** `reeve why <pr>` prints the trail newest-first with the
clause table.

**Something looks wrong in the log.** Read `~/.reeve/reeve.err.log` too. A tick
that cannot reach GitHub logs the failure and continues; it does not conclude
anything from not being able to ask.

**A worktree was quarantined.** It is under `<worktreeRoot>/_quarantine`, intact.
That happens when a checkout held uncommitted changes, unpushed commits, or a
non-empty stash stack — the stash stack is shared across every worktree of a
clone, so it may hold work left in a different one entirely.

## Two switches, both off

`--execute` dispatches workers. `--enforce` publishes real conclusions instead of
neutral ones. Both are opt-in, and the sequence is deliberate: observe, then fix
under supervision, then enforce. The shadow period exits on **seven days of data
with zero false blocks**, not on a date.

## Working on reeve

```sh
for f in test/*.test.mjs; do ~/.nvm/versions/node/v24.17.0/bin/node "$f" || echo "FAILED $f"; done
```

### What is true right now

```sh
node scripts/state.mjs            # main, this checkout, the daemon, open work
node scripts/state.mjs --sweep    # the above, plus a full stub sweep of the default branch
```

**Start here when you pick the work up again.** It measures rather than
remembers: the default branch and how far this checkout is from it, whether the
daemon is actually running and which commit that process loaded, the hub schema
version, open pull requests, and branches carrying commits that no pull request
claims.

Every reading is a measurement or a refusal, and there is no third thing. A read
that fails says so and sets a non-zero exit; it never reaches you as an empty
answer, because empty reads as good news -- no unopened branches, no open work,
nothing to do. `--sweep` stops you on an incomplete verification as well as on a
finding, since an entry that could not run produced no evidence either way.

It replaced a shell block that lived in a handoff document, where nothing tested
it and the stub sweep could not see it. That block shipped two guards that
alarmed on success and would have halted a resumed session on a healthy
repository. Keep this here, where it is covered.

Conventions the tests hold, each of which exists because breaking it cost
something real:

- **A fix needs a test that fails on the broken code first.** A test you did not
  watch fail proves nothing.
- **Every absence search needs a positive control.** A search that reports zero for
  everything is broken, not conclusive.
- **Never turn an absence into a pass.** Not in a verdict, not in a metric, not in
  a status screen.
- **Don't invent a tuned constant.** Prefer a contract. Where a number is
  unavoidable, derive it from another one rather than picking a second.
- Timezone: the suite runs twice in CI, once under `TZ=Asia/Karachi`, because a
  test comparing against a naive local parse passes here and fails on a UTC runner.

Longer context, every founder ruling and the full list of what remains:
[`docs/HANDOFF.md`](docs/HANDOFF.md).
