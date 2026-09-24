# reeve — agent guide

Reeve is a control plane for AI coding agents. Agents do the work. Reeve decides
whether that work counts, using evidence the agent cannot produce itself. It
publishes PASS, BLOCK or UNKNOWN on the exact commit, and GitHub enforces the
decision. "Reeve" is a working name.

Every harness reads this file: Claude Code through `CLAUDE.md`, and Codex and
others directly.

## Where things are

| What | Where |
|---|---|
| The plan, and all work state | GitHub issues on this repository (details below) |
| Decisions, and the reasons for them | [`docs/decisions/`](docs/decisions/). Start with [`2026-09-24-direction.md`](docs/decisions/2026-09-24-direction.md) |
| Work in flight | open pull requests |
| History only, never current state | `docs/HANDOFF.md`, `docs/TRACKER.md`, the dated `docs/*-session-handoff.md` and `docs/*-resume-prompt.md` files, and `tasks/` |

The plan issues:

| Phase | Issue |
|---|---|
| Phase 0 | #148 |
| Phase 1 | #158 |
| First milestone | #170 |
| Phases 3 and 4 | #181, #182 |

- Each task is a sub-issue of its phase.
- The order between tasks is a "blocked by" link.
- Progress is recorded in checkpoint comments.

## Resuming work

This applies to a new session, a new machine, or coming back after a break.

Use the `resume-work` skill. It is in `.agents/skills/resume-work/`, with a
copy in `.claude/skills/`:
- In Claude Code, type `/resume-work`.
- In Codex, ask it to use the resume-work skill.

The skill does the following, and you can also do it by hand:

1. Read this file and [`docs/decisions/2026-09-24-direction.md`](docs/decisions/2026-09-24-direction.md).
2. Take a snapshot of where things stand:
   `node .agents/skills/resume-work/scripts/snapshot.mjs`. It lists the open
   pull requests and what each is waiting for, the tasks in progress and their
   checkpoints, the ready tasks, and a suggested next step. By hand, use
   `gh pr list -R revnix/reeve --limit 100`; the default of 30 would hide older
   pull requests.
3. Choose the work in this order:
   1. Review findings and failing checks on your own pull requests.
   2. A task assigned to you, resumed from its latest checkpoint.
   3. The next open task that has no open blockers and nobody assigned.
4. Claim a new task before you change anything:
   `node .agents/skills/resume-work/scripts/claim.mjs --issue <n>`.
   - It assigns you and posts a claim comment carrying a random session id.
   - The earliest live claim wins, so two sessions of the same account can't
     both take it. A claim is live while its author is still assigned and
     hasn't released the task since.
   - A session that loses to another account gives up its assignment.
   - Give a task back with `--release`. If a release stops halfway, running
     it again finishes it.
5. Work in a git worktree, never in the main checkout, because another session
   may be using it. Remove the worktree once the pull request is pushed.
6. If you stop partway through a task, commit and push your branch first. A
   draft pull request is fine. Then record where you stopped:
   `node .agents/skills/resume-work/scripts/checkpoint.mjs --issue <n> --done "…" --remaining "…"`.
   It refuses if the branch has uncommitted, unpushed or stashed work, because
   a checkpoint that points at one machine's disk can't be resumed anywhere else.
   Don't write a handoff document.

```
<!-- checkpoint v1 -->
branch:
pr:
done:
remaining:
validation:
blockers:
next:
```

## Rules

- **No AI attribution anywhere.** That covers commits, co-author trailers,
  pull request and issue text, comments and docs.
- **This repository is public.** Never include:
  - client names (the founder's own products, such as Nextly, aren't clients);
  - private plans, or task links from private repositories;
  - secrets.
- **No other public repository names Reeve.** This repository obviously does.
  But no other public repository, client or product, may mention Reeve. In
  those repositories its App is `merge-policy`, and its branches use the prefix
  `mp/`.
- **Plans say what and why; the code shows how.** Write short plans, and only
  for the next slice of work.
- **Put rigor where being wrong is dangerous:** merge authority, credentials,
  containment, evidence and recovery. Everywhere else, ordinary tests are
  enough.
- **Measure against the real CLIs** ([`docs/measured/`](docs/measured/)) rather
  than adding more tests.
- **A fix needs a test that fails on the broken code first.** Never turn an
  absence into a pass.
- **Recovery checks what actually happened before it retries.** Promise safe
  retries and reconciliation, never "exactly once".
- **Stop after two rounds of the same review disagreement** and ask the founder.
- **Everything you allocate ships its teardown in the same change.** That
  includes worktrees, containers and temporary directories.

## Commands

| Task | Command |
|---|---|
| Run the tests, stopping at the first failure (Node 24.10 or later) | `npm test` |
| Run every test file and list all failures (exits non-zero if any fail) | `( fail=0; for f in test/*.test.mjs; do case "$f" in */escape.test.mjs) continue;; esac; node "$f" >/dev/null \|\| { echo "FAILED $f"; fail=1; }; done; exit $fail )` |
| The containment escape probe (run deliberately, on a quiet machine) | `npm run test:escape` |
| Lint | `npm run lint` |
| Check one stub-sweep entry (the full sweep runs nightly in CI) | `STUB_SWEEP_NO_DIFF=1 node scripts/stub-sweep.mjs <entry-name>` |

**Why the escape probe is left out of the routine commands:** it writes decoy
files into the `~/.reeve/canary/` folder that a running daemon reads, and on
macOS it probes the login keychain. CI still runs it, because CI runs on a
clean runner.

CI runs the tests twice: under `TZ=UTC` and under `TZ=Asia/Karachi`.
