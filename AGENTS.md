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

1. Read this file and [`docs/decisions/2026-09-24-direction.md`](docs/decisions/2026-09-24-direction.md).
2. Check pull requests in review before starting anything new: `gh pr list -R revnix/reeve`.
3. Open the current phase issue. Take the next open task that has no open
   blockers. Its latest checkpoint comment says where the work stopped.
4. Work in a git worktree, never in the main checkout, because another session
   may be using it. Remove the worktree once the pull request is pushed.
5. If you stop partway through a task, post a checkpoint comment on it. Don't
   write a handoff document.

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
  - client names;
  - private plans, or task links from private repositories;
  - secrets.
- **Nothing public names Reeve.** No public client or product repository may
  mention Reeve. Its App is `merge-policy`, and its branches use the prefix
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
| Run the tests (Node 24.10 or later) | `for f in test/*.test.mjs; do node "$f" \|\| echo "FAILED $f"; done` |
| Lint | `npm run lint` |
| Check one stub-sweep entry (the full sweep runs nightly in CI) | `STUB_SWEEP_NO_DIFF=1 node scripts/stub-sweep.mjs <entry-name>` |

CI runs the tests twice: under `TZ=UTC` and under `TZ=Asia/Karachi`.
