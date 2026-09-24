---
name: resume-work
description: Resume work on a project whose plan and state live in GitHub (issues, sub-issues, blocked-by links, checkpoint comments, pull requests). Use at the start of a session, after a break, or when asked to resume, continue or pick up where work stopped. It reports what is in review, what is waiting on a person, and the next ready task, then proposes one next action. It also records a checkpoint before you stop.
---

# Resume work

The state lives on GitHub, not in any conversation. Rebuild the picture from
GitHub, then propose the next step.

## 1. Pick the project

Choose the repository in this order:
1. **An argument names it** (`reeve`, `revnix/reeve`, `nextly-control`). Use
   that repository. For a bare name, read the local clone's `origin` remote.
2. **The current directory is a git repository.** Use it.
3. **Otherwise,** ask which project.

## 2. Read the rules

Read `AGENTS.md` (and `CLAUDE.md`) at the repository root, and the newest
decision records (`docs/decisions/` or `knowledge/decisions/`). Where they
differ from this skill, they win.

## 3. Take the snapshot

Don't reconstruct state by reading issues one by one. Run this from this
skill's directory:

```sh
node scripts/snapshot.mjs --repo <owner/name>
```

It changes nothing. It prints:
- the open pull requests, and what each is waiting for;
- the plan's phases;
- the tasks in progress, and their checkpoints;
- the ready tasks (open, unassigned, every blocker closed);
- a suggested next step.

If the repository documents its own tool for readiness and claims, use that
tool instead. For example, nextly-control has `ctl next` and `ctl status`.

## 4. Report, then propose

Keep the report short and in plain language:
- **Needs me:** my pull requests that are drafts, or have unresolved review
  threads, requested changes or failing checks.
- **Needs you:** pull requests waiting for a person to merge them or decide.
- **Next:** the task in progress, or the first ready task, with its latest
  checkpoint.

Propose one next action. Change nothing until the person agrees, unless they
have already said to go ahead.

## 5. While working

- **Choose in this order:**
  1. review findings and failing checks on your own pull requests;
  2. a task already assigned to you, resumed from its checkpoint;
  3. the next ready task.
- **Claim a new task first:** `node scripts/claim.mjs --issue <n>`.
  - It assigns you and posts a claim comment with a random session id.
  - The earliest live claim wins, so two sessions under one account can't
    both take the task. A claim is live while its author is still assigned
    and hasn't released the task since.
  - A session that loses to another account gives up its assignment.
  - It refuses tasks that are closed, blocked or held by someone else.
  - `--release` gives the task back. Running it again finishes a release
    that stopped halfway.
- **Use a git worktree,** never the main checkout.
- **Handle review findings properly:**
  1. Classify each one: blocking, important, suggestion or invalid.
  2. Fix the real ones.
  3. Reply to every finding with evidence.
  4. Resolve the thread.
- **Leave authority with the person.** Never merge, bypass protections or
  change repository settings without the person's decision.
- **No AI attribution** in commits, pull requests, comments or docs.

## 6. Before you stop

Commit and push the branch first. A draft pull request is fine. Then record
where you stopped:

```sh
node scripts/checkpoint.mjs --issue <n> --done "…" --remaining "…" --validation "…" --next "…"
```

It refuses if the branch has uncommitted, unpushed or stashed work, because a
checkpoint that points at one machine's disk can't be resumed anywhere else.
