# 2026-09-24 — Direction for Reeve

The founder decided this on 2026-09-24, after a review of the code, the earlier
strategy, and the market. The plan that carries it out is in these issues:

| Phase | Issue |
|---|---|
| Phase 0 | #148 |
| Phase 1 | #158 |
| First milestone | #170 |
| Later phases | #181, #182 |

## What Reeve is

Reeve is the referee for AI-written code. Agents do the work: Claude Code,
Codex, or any other. Reeve then:
- decides whether the work counts, using evidence the agent cannot produce
  itself;
- publishes PASS, BLOCK or UNKNOWN on the exact commit;
- explains why.

GitHub enforces the decision.

Reeve has one core and two surfaces:
- **the Gate** judges any pull request;
- **the Runner** runs agents and feeds their pull requests to the Gate.

The Gate's reliability comes first. A builder must not run unattended until
the thing that judges it can be trusted.

## Decisions

| Topic | Decision |
|---|---|
| Work state | GitHub issues own goals, tasks, claims and progress. Reeve keeps only execution state (leases, runs) and evidence locally. Nothing needed to resume work may live only on one machine. |
| First customer | Nextly, a real product with a team. First a shadow gate on its pull requests, meaning verdicts are published but block nothing. Then small Routine tasks. Reeve's own repository runs alongside. |
| First milestone | One complete workflow (below), run through both harnesses. It must recover from an interruption, and nobody may have to relay CI errors or review comments by hand. |
| Worker login | The person's own, unmodified CLI login, or an API key. Reeve never reads or stores login tokens. Unattended Codex runs on public repositories use an API key. |
| Authority | Four separate authorities (below). A worker's own report is never independent verification. An agent saying "approved" is never an approval. |
| Recovery | Safe retries and reconciliation, not "exactly once". Before repeating an external effect, check what actually happened. For example, adopt a pull request that GitHub already created. |
| Auditing the Gate | Shadow periods count false passes as well as false blocks, using an audited sample plus a set of known-bad cases. |
| Stack | Node 24, SQLite and a hand-written core. TypeScript arrives gradually, alongside useful changes. No agent framework goes in the core. |
| Platforms | Linux and WSL2 first; keep macOS; native Windows later, behind a platform adapter. |
| License and visibility | Apache-2.0. The repository is public but not promoted until an MVP works. "Reeve" is a working name. |
| Process | Issues and checkpoint comments hold state; there are no handoff documents. The stub sweep runs nightly. Rigor concentrates on authority, credentials, containment, evidence and recovery. |

The first milestone's workflow:

```
approved task → claim → implement → pull request → CI and review feedback
  → repair → merge-ready → a person merges → verified completion
```

The four authorities:

| Authority | Held by |
|---|---|
| Model login | the worker |
| GitHub writes | Reeve's App, which has no bypass |
| Evidence signing | Reeve, never the worker |
| Merge | a person, and the ruleset |

## What this replaces

- **The earlier builder plan is now history.** That means the 21-state builder
  plan and the 12-stage sequence in `tasks/reeve-tasks/` and
  `docs/2026-08-21-builder-design.md`. Parts of it are reused, but the order of
  work is the one in the issues.
- **The handoff and resume documents in `docs/` are history** too.

## Considered and rejected

- **A core that owns missions and tasks in its own database.** It would create
  a second source of truth next to the issues.
- **LangGraph, or another agent framework, in the core.** These are built for
  agents that run inside the program. None of Reeve's own steps call a model.
- **Discovery, product and go-to-market workflows, a hosted version, a desktop
  app, or reinforcement learning, now.** These come later, and only once the
  first milestone's metrics hold.
