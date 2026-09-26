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
where the old design merged on stale logic. A PASS it has already published
stays on its commit, so reeve withdraws it whenever it stops checking: on HALT,
on a stop, for a pull request it couldn't re-check, and after a crash through
`reeve withdraw`. A machine that is asleep or off can withdraw nothing.

**A worker is contained by the tool layer, not by its prompt.** Risk paths,
forbidden commands and territory are compiled into a scoped allowlist and a
settings file the CLI enforces. Workers hold no push or merge authority; reeve
publishes after checking what git says changed.

---

## Requirements

- **Node ≥ 24.10.0.** `node:sqlite` still emits an experimental warning on 22.x
  and the state layer is the authority, and `DatabaseSync.setAuthorizer` -- which
  the guardian's restricted hub connection refuses to open without -- arrived in
  24.10.0. `package.json` enforces the same floor. If `node` on `PATH` is
  older, call a 24.x node by its absolute path, as the service files in
  `deploy/` do.
- `git` and the `gh` CLI, authenticated.
- `claude` on `PATH` for dispatch (not needed to observe).

## Install

```sh
git clone git@github.com:revnix/reeve.git
alias reeve="node $PWD/reeve/bin/reeve"

cd <a checkout of the repository reeve will watch>
reeve init                 # detect it, and ASK about anything ambiguous
reeve init --set project.kind=product --write
reeve doctor <owner/repo>  # what is actually true right now
```

`init --write` writes the profile and creates the state database (see Layout).
Run it first on a new machine: `reeve run` refuses to start without that
database rather than create an empty one itself, because a fresh empty store in
place of the real one is how history stops being read without anything failing.
`init` never touches a database that exists, and moves one from the old path
into place.

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

On Linux and WSL2 it runs as a systemd user service, `deploy/reeve.service`,
which follows the same rules: an absolute interpreter and an explicit repository.

Edit the file first. `run nextlyhq/nextly` names the repository the daemon
watches, so change it to yours, and `withdraw nextlyhq/nextly` in
`ExecStopPost` to the same one. Change the node and checkout paths if they live
elsewhere. `ExecStopPost` runs after the daemon stops, however it stopped, and
withdraws any PASS it left standing. Then:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/reeve.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now reeve
sudo loginctl enable-linger "$USER"   # keep it running after you log out
systemctl --user status reeve
```

Without lingering, systemd stops the service when your last session ends. On
WSL2, systemd must be enabled (`[boot] systemd=true` in `/etc/wsl.conf`), and
keeping the daemon awake holds only the Linux side: Windows decides when the
host sleeps.

To stop it and remove it:

```sh
systemctl --user disable --now reeve
rm ~/.config/systemd/user/reeve.service
systemctl --user daemon-reload
sudo loginctl disable-linger "$USER"  # only if reeve alone needed it
```

On macOS:

```sh
launchctl bootout gui/$(id -u)/com.revnix.reeve
rm ~/Library/LaunchAgents/com.revnix.reeve.plist
```

Either way, `~/.reeve`, the state and the logs, stays in place. Delete it only
when you're done with reeve on this machine.

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
# stop at the first failing file
npm test
# run every file, list each failure, and exit non-zero if any failed
( fail=0; for f in test/*.test.mjs; do case "$f" in */escape.test.mjs) continue;; esac; node "$f" >/dev/null || { echo "FAILED $f"; fail=1; }; done; exit $fail )
# the containment escape probe writes into ~/.reeve/canary and probes the macOS
# keychain, so run it deliberately, on a quiet machine
npm run test:escape
```

The stub sweep checks that the tests can fail. It reintroduces each defect in
`test/stub-manifest.mjs` and requires the assertion that entry names to go red.
It takes about 35 minutes, so CI runs it nightly and on demand
(`.github/workflows/stub-sweep.yml`), not on every pull request. To check one
entry locally:

```sh
STUB_SWEEP_NO_DIFF=1 node scripts/stub-sweep.mjs <entry-name>
```

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

How to work on reeve, where the plan and current state live, and how to resume
work: [`AGENTS.md`](AGENTS.md). Decisions and the reasons for them are in
[`docs/decisions/`](docs/decisions/). `docs/HANDOFF.md` and the dated handoff
files are history, up to 2026-09-02.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
