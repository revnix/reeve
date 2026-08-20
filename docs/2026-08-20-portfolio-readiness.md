# Can reeve serve the whole portfolio?

**Measured:** 2026-08-20. Every number below came from `gh api`, `reeve init` or the local
checkouts. Where a measurement of mine was wrong, the correction is recorded rather than the
original quietly replaced.

---

## 1. The short answer

reeve's **engine** is portable. Its **preconditions** are not met almost anywhere.

Running reeve's own detector against 13 clones across 6 orgs produced a correct, useful profile
every single time, including on stacks it had never seen. That is the part people usually get
wrong, and it works. What does not work is the environment: of 27 active repos surveyed, **one**
(`nextlyhq/nextly`) can actually be governed end to end today. The blockers are all outside reeve.

---

## 2. Three capabilities, and which exist

The question "can reeve work on these projects" is really three questions.

| Capability | State | Evidence |
|---|---|---|
| **Govern** — watch PRs, read CI, compute a verdict, make GitHub refuse | Built, proven on 1 repo | The daemon has been ticking on nextly since 16:29 UTC; 14 ticks, 4 PRs, verdicts published |
| **Execute** — dispatch a worker that fixes CI or implements a task | Built, proven **once** | `revnix/reeve` PR #1: red CI → root cause → fix → push → green, 185s, $1.51, unattended |
| **Research** — find user problems, competitor gaps, feature ideas, codebase improvements | **Not built** | Deferred to Phase G by ruling. No discovery loop, no competitor analysis, no improvement proposer |

The founder's question emphasises "most of them will need research for new features, codebase
improvements". That third column is the honest gap: **reeve today is a gate and a fixer, not a
proposer.** It can be told what to do and hold the work to a standard. It cannot yet decide what
is worth doing.

---

## 3. Two portfolio-wide blockers

### 3.1 Every one of your orgs is on GitHub's free plan

    revnix                free        rextaihq   free       nextlyhq   free
    21stCenturyEquipment  free        4Rivers…   free       Comfy-Org  enterprise

A free plan exposes branch protection and rulesets on **public** repos only. Every private repo in
the survey returns `403` for branch protection — measured, not assumed, on all 23.

reeve's central invariant is "reeve publishes a verdict, **GitHub** refuses". That inversion is the
whole safety argument: a stale reeve fails to publish and the merge blocks. Without server-side
enforcement the inversion collapses back to "an agent decided not to merge", which is exactly the
property the old nextly-ops merge gate had when it merged 0 of its last 10 PRs.

So outside `nextlyhq/nextly`, reeve can **attest** but never **enforce**. reeve is honest about
this: `init` reports `enforcement: attested` and `doctor` reports R-01 as UNKNOWN rather than OK.

**Only three ways out:** make a repo public, pay for Team on the org that matters, or accept
attestation. This is a founder decision, not an engineering one.

### 3.2 The GitHub App reaches exactly one repo

`Merge Policy` (App ID 4660593) is installed on `nextlyhq/nextly` only. All nine other repos probed
return `no installation … HTTP 404`. Each additional repo needs an explicit install; each
**org** needs an owner to approve it — and on Comfy-Org you hold `write`, not admin, so that is
not yours to grant.

Without the App, reeve cannot create check runs at all (a user token gets 403; App-only endpoint).
It degrades gracefully — the tick still runs, verdicts still compute, escalations still fire, only
the publish step 404s — but "GitHub refuses" becomes "reeve advises".

---

## 4. The blocker nobody would have predicted: there is almost no CI to read

This is the finding that most changes the answer.

Of the repos outside nextly and Comfy-Org that have any workflow at all, I checked what each
workflow actually triggers on:

| Repo | Workflow | Triggers on |
|---|---|---|
| revnix/ficonz-frontend | deploy.yaml | `push: dev` |
| revnix/rext-admin | ci_cd.yaml | `push` |
| revnix/rext-site-v3 | deploy.yaml | `push: main` |
| revnix/21c-v4 | deploy.yaml | `push: main` |
| revnix/tby-dev | deploy.yaml | `push: feat/nextly-integration` |
| revnix/4re-v4 | deploy.yaml | `push: main` |
| revnix/ficonz-generator-v2 | tests.yml | `pull_request: [master, multi-agent]` |
| revnix/4re-marketing-console | — | no workflow files at all |

**Not one of them gates a pull request into its own default branch.** The only `pull_request`
trigger in the set fires on `master`/`multi-agent`, while that repo's default branch is
`feat/ficonz-selfhost-pipeline` — so it never runs on the PRs that matter either.

These are deploy pipelines, not CI. reeve's verdict engine reads check runs bound to a head SHA.
Where nothing runs on a PR, every PR is `UNKNOWN`, and **UNKNOWN never merges** — so reeve would
correctly block every pull request in these repos, forever, and be useless rather than wrong.

**Writing PR-gating CI is therefore a prerequisite for reeve in almost every repo**, and it is
worth doing on its own merits regardless of reeve.

### A correction to my own measurement

My first sweep reported "1 workflow" for `4re-marketing-console`. That was a `.gitkeep` file being
counted as a workflow. reeve's detector had said `ci: none`, and reeve was right. The lesson is the
one already in the ledger: an existence check that does not look at what it found reports presence
where there is none.

---

## 5. The good news: your delivery topology already suits reeve

Client work is not done in the client's repo. Measured across three client families:

| Family | Development repo | Delivery repo |
|---|---|---|
| 21st Century | `revnix/21c-v4` — 15 PRs, all merged via PR | `21stCenturyEquipment/21century-web-v4` — **0 PRs ever**, direct push |
| The Backyard | `revnix/tby-dev` — 94 PRs | `21stCenturyEquipment/the-backyard-v3` — 0 PRs ever |
| 4 Rivers | `revnix/4re-v4` — 12 PRs | `4RiversEquipment/4rivers-v4` — 0 PRs, HEAD message is literally "Deployment" |
| Marketing console | `revnix/4re-marketing-console` — 100 PRs, 100 merged in 90d | `4RiversEquipment/4re-marketing-console` — 0 PRs |

The paired repos carry **identical commit messages with different SHAs** — re-committed mirrors,
not shared history.

Two consequences, both favourable:

1. **reeve governs `revnix/*` only.** The client-org repos are publication targets and need no gate.
2. **The anonymity rule is satisfied structurally**, not by vigilance. reeve never touches a
   client-owned repo, so it can never leak a name into one. That was the constraint most likely to
   be violated by accident, and the topology removes it.

---

## 6. Repo by repo

Verdict key — **READY**: reeve adds value today. **NEEDS CI**: engine fits, nothing to read.
**ADVISORY**: reeve can watch and fix but never enforce. **BLOCKED**: a precondition is not yours.
**DORMANT**: no commits in 90 days.

### ficonz

| Repo | Stack (detected) | PR flow (90d) | CI | Verdict |
|---|---|---|---|---|
| `revnix/ficonz-generator-v2` | typescript/npm · lint build | 0 merged, 1 open, 22 ever | `tests.yml` on the wrong branches | **NEEDS CI** — fix the trigger and it becomes advisory-ready |
| `revnix/ficonz-frontend` | typescript/pnpm · lint build | 20 merged, 98 ever | deploy-only | **NEEDS CI** — the healthiest PR flow in ficonz, so the highest payoff |
| `revnix/ficonz` | typescript | none | none | **DORMANT** |
| `mobeenabdullah/ficonz-portal` | typescript | none, 45 ever | none | **DORMANT** — also on a personal account, not an org |

Detector notes: `ficonz-frontend` has mixed history (7 of 30 commits two-parent), so `merge.method`
must be answered, not guessed.

### rext ai — the strongest candidate after nextly

| Repo | Stack (detected) | PR flow (90d) | CI | Verdict |
|---|---|---|---|---|
| `rextaihq/rext-backend` | **python/uv** root + typescript/npm `rext` | **85 merged**, 4 open | 4 workflows | **ADVISORY, ready now** |
| `revnix/rext-admin` | typescript | **76 merged** | `ci_cd.yaml` on push only | **NEEDS CI** |
| `revnix/rext-site-v2` | typescript | 27 merged | deploy-only | **NEEDS CI** |
| `revnix/rext-site-v3` | typescript | 6 merged | deploy-only | **NEEDS CI** |

`rext-backend` is the one repo besides nextly with real PR volume *and* real workflows. reeve's
detector handled the polyglot correctly and flagged two genuine hazards unprompted:

- `ci-quality.yaml` contains `continue-on-error`, so a failing step still reports success
- `dev.yaml` fires `pull_request: closed` — it runs *after* the merge and cannot gate it

Both are exactly the "green that means nothing" class reeve exists to refuse. **This is where I
would prove the second project.**

### Comfy (client, Comfy-Org)

| Repo | Stack (detected) | PR flow (90d) | CI | Verdict |
|---|---|---|---|---|
| `Comfy-Org/ComfyUI_frontend` | typescript/pnpm · lint typecheck test build | 79 merged, **100 open** | **67 workflows**, 5 rulesets | **BLOCKED** — no App, `write` only |
| `Comfy-Org/cloud` | **go** · *(no commands)* | 78 merged, 100 open | **100 workflows** | **BLOCKED** + stack gap |
| `Comfy-Org/workflow_templates` | python + typescript | 90 merged, 31 open | 35 workflows | **BLOCKED** — dual lockfile in `site` |
| `Comfy-Org/ComfyUI_frontend-private` | typescript/pnpm | — | yes | **BLOCKED** |
| `revnix/comfy-workflows` | typescript | 0 PRs, direct push | none | **NEEDS CI** |

Comfy is the only place where reeve reports `enforcement: enforced` — enterprise plan, real
rulesets. It is also the only place where you cannot install the App, hold `write` rather than
admin, and would be governing someone else's repo. **reeve's realistic role here is local advisory
only**: root-cause a red check, prepare a fix, never publish a verdict.

It is also where the detector found the most CI hazards without being asked — 18 in
`ComfyUI_frontend` alone (`continue-on-error` in 11 workflows, `pull_request: closed` in 5).

### Client sites — 21c / tby / mc / 4re

| Family | Dev repo | PRs (90d) | CI | Verdict |
|---|---|---|---|---|
| mc | `revnix/4re-marketing-console` | **100 merged** | **none at all** | **NEEDS CI** — busiest client repo, zero gating |
| tby | `revnix/tby-dev` | 7 merged, 94 ever | deploy-only | **NEEDS CI** |
| 21c | `revnix/21c-v4` | 15 merged | deploy-only | **NEEDS CI** |
| 4re | `revnix/4re-v4` | 8 merged | deploy-only | **NEEDS CI** |
| — | `4RiversEquipment/riverside-hydraulics` | 0 | none | **DORMANT** |
| — | all four client-org mirrors | 0 PRs ever | none | **not reeve's business** — delivery targets |

`21century-web-v4` carries the dual-lockfile hazard the handoff already recorded, and reeve's
detector caught it unprompted: `pnpm-lock.yaml` and `package-lock.json` both tracked, so
`units[].packageManager` is a question rather than a default.

Client mode also lowers the ceiling by design: `softCap 3 / hardCap 5`, high-risk work always human.

### ranknaut

`revnix/ranknaut` — python/uv `backend` + typescript/npm `frontend`, **no CI**, 4 PRs merged in
90d, mixed history.

The interesting finding is a contradiction with your own strategy. `REBUILD-STRATEGY.md` (v3,
today) rules **TypeScript, not Python**: *"two languages for a solo founder whose agents write the
code … is exactly the drift that killed ranknaut_old"*, with Python permitted only as an isolated
queue-backed service. The repo as it stands is python + typescript. **Either the rebuild has not
started, or it has already drifted from the decision on day one.** reeve's detector surfaced this
by reporting two units where the strategy allows one.

On the 55 GTM tasks: the strategy explicitly plans to run the build "under nextly-ops governance —
a `ranknaut.jsonl` ledger, lanes by territory (connectors / engine / portal), review fleet on every
PR". reeve supersedes nextly-ops, so **reeve is the intended host for that task graph**. Its store
already models exactly what those tasks need — `node`, `edge`, `DEPENDS_ON`, `run`, leases,
checkpoints — and it already replays a real 1,022-event ledger. What is missing is a way to
**import** a task corpus, and recurring cadences (weekly / biweekly-capped / quarterly), which no
part of reeve models today. That is new work, not a port.

### upkit

| Repo | Stack | Activity (90d) | Verdict |
|---|---|---|---|
| `revnix/upkit-backend` | **python/uv** · lint typecheck test | 0 commits | **DORMANT** |
| `revnix/upkit-extension` | typescript/npm · typecheck build | 0 commits | **DORMANT** |
| `revnix/upkit-frontend` | typescript | 0 commits | **DORMANT** |
| `revnix/upkit-site` | typescript | 1 commit | **DORMANT** |

Nothing to govern until upkit restarts. The detector still did useful work: `upkit-backend`
configures **both black and ruff-format**, which disagree on output, so it asks rather than picking
— exactly the kind of silent reformat-war a naive tool would start. The handoff's separate warning
stands: `upkit-extension` can publish an unrecallable browser-store version, so it is
permanently high-risk-human.

---

## 7. Stack coverage gaps

`detectCommands` handles **typescript** and **python** only.

| Language | Detected? | Commands? | Where it bites |
|---|---|---|---|
| TypeScript | yes | yes | — |
| Python | yes | yes | — |
| **Go** | yes | **no** | `Comfy-Org/cloud` profiles as `go/?  (no commands)` — reeve cannot run or verify anything |
| **Rust** | yes | **no** | none active today |
| **PHP** | **no** | no | 8 PHP repos in `revnix` (`wpaegis`, `rext-wp-plugin`, `21c-user-products-api`, …). `composer.json` is not in `detectLanguage`, so these produce no unit at all |

Go and PHP are each roughly a day: a manifest check plus an intent table (`go test ./...`,
`go vet`, `go build ./...`; `composer test`, `phpstan`, `phpcs`). The architecture is right —
intents, not command names — so this is filling a table, not a redesign.

---

## 8. What reeve cannot do at all yet

1. **Research and propose.** No competitor analysis, no gap-finding, no "this codebase would be
   better if". The founder named this as a requirement for most of these projects and it is the
   largest missing piece.
2. **Recurring cadences.** ranknaut's corpus is built on weekly / biweekly-capped / quarterly
   rhythms. reeve models one-shot tasks with dependency edges, not schedules.
3. **Task import.** No way to ingest a corpus of 55 prose task files into the graph.
4. **Non-GitHub CI.** `ci.provider` accepts `github-actions` or `none`. Nothing here needs
   otherwise today.
5. **Worktree lifecycle**, still served by the old plugin.

---

## 9. What I would do, in order

1. **Write PR-gating CI for the four repos with real PR volume** — `revnix/4re-marketing-console`
   (100 merges in 90 days and *no workflow file at all*), `revnix/rext-admin` (76),
   `revnix/ficonz-frontend` (20), `revnix/tby-dev`. This is the precondition for everything else
   and is worth doing even if reeve were abandoned. One reusable workflow, parameterised per
   detected unit — reeve's own detector already knows each repo's lint/typecheck/test/build.
2. **Prove the second project on `rextaihq/rext-backend`.** It is the only non-nextly repo with
   both PR volume and workflows, it is a genuinely different stack (python/uv + typescript), and
   reeve already found two real defects in its CI. Anything that must be changed in reeve's core to
   make it work was misfiled — that is the test.
3. **Decide the enforcement question.** Free plan means attestation everywhere except nextly. Team
   on `revnix` alone would convert roughly a dozen repos from advisory to enforceable. This is
   yours to decide; I would not spend engineering effort routing around it.
4. **Fill the Go and PHP tables** before Comfy or WordPress work needs them.
5. **Then** build the research half. It is the biggest gap, but it is worth the least until the
   repos it would propose changes to have a gate that can hold those changes to a standard.

## 10. Bottom line

The engine generalises — 13 clones, 6 stacks, zero detector failures, and it found real defects in
repos it had never seen. What does not generalise is the environment: no PR-gating CI, no
server-side enforcement on a free plan, and an App installed on one repo.

None of that is a reason to change reeve's design. All of it is a reason to be honest that
**reeve is ready for one repo today, two after a week's work, and roughly a dozen after CI exists
and the plan question is settled.**
