# Using reeve, from zero

Written for someone who has never used it. No prior context assumed.

---

## 1. The one-sentence version

**reeve is a background watchman for your pull requests.** It is already running.
You do not start it, you do not open it, and you do not clone it.

You keep working exactly as you do today. reeve watches what you open, tells you
what is blocked and why, and — for one specific job — fixes it for you.

---

## 2. Do I need to clone `revnix/reeve` into `nextly-workspace`?

**No.** Nothing to clone, nothing to install, nothing to add to nextly.

reeve lives at `~/Work/Products/reeve` and runs as a macOS background service. It
talks to GitHub over the network. It never needs to be inside the repo it watches.

The only thing you add is a shortcut so you can type `reeve` instead of a long
path. Put this in your `~/.zshrc`, once:

```sh
alias reeve='~/.nvm/versions/node/v24.17.0/bin/node ~/Work/Products/reeve/bin/reeve'
```

That is the entire setup.

---

## 3. The three commands you will actually use

Run these from anywhere — you do not need to be in any particular folder.

| Command | What it tells you |
|---|---|
| `reeve status nextlyhq/nextly` | What is blocked right now, and why |
| `reeve why 1127` | The full decision trail for one pull request |
| `open ~/.reeve/dash/nextlyhq/nextly.html` | The same thing as a web page |

**`reeve status` is the one to learn.** It has three parts:

- **NEEDS YOU** — things that will not move without you. Target state: empty.
- **FLEET** — pull requests reeve is watching and what it is waiting for.
- **HEALTH** — how often merges land with genuinely green evidence.

---

## 4. Two completely different kinds of "agent"

This is the thing most worth getting straight, because the same word means two
different things and they are easy to confuse.

### A. reeve's own workers — automatic, no human involved

The background service dispatches these by itself. You never invoke them.

| Worker | What it does | Status |
|---|---|---|
| **FIX_CI** | A check went red. It root-causes the failure, fixes it in its own isolated copy of the branch, and reeve publishes the fix. | **ON** |
| FIX_FINDINGS | Works unresolved review threads. | **off** |
| REQUEST_REVIEW | Asks the review bots for a round. | **off** |
| SPILL | Moves leftover non-critical findings to a follow-up PR. | **off** |

The last three are **deliberately off**. reeve does not yet ingest review data
properly — it cannot count review rounds correctly and it cannot tell a critical
finding from a minor one. Rather than guess, it escalates to you and says so in
plain words. Turning them on before that data is real would let it move a critical
finding to a follow-up and call it policy.

### B. The `agent-ops` agents — you ask for these, in a Claude session

These are **not** part of reeve. They live in the `agent-ops` plugin and are
available inside a Claude Code session. You (or Claude) invoke them by name.

| Agent | Role | Use it when |
|---|---|---|
| **scout** | Answers exactly one factual question about the repo, read-only, with the command that proved it | "Is X actually wired up?" before you plan anything |
| **researcher** | Prior art — how Payload, Strapi, Directus, Sanity solve the same problem, plus current library docs | Before any behaviour-changing decision |
| **lane-builder** | Implements page-builder work | Building in `packages/builder/**` |
| **lane-schema** | Implements schema, data, API and adapter work | Building in the core |
| **lane-admin** | Implements admin panel and UI-kit work | Building in `packages/admin/**` |
| **reviewer-correctness** | Adversarial correctness review of one PR diff | Reviewing a PR |
| **reviewer-access-data** | Access-control and data-integrity review only | Reviewing a PR |
| **reviewer-evidence** | Do the tests actually prove anything? | Reviewing a PR |
| **docs-audit** | Checks what the docs claim against what the repo does | Docs look stale |

**So: can agents review PRs? Yes** — the three `reviewer-*` ones. But they are run
by a Claude session, not by reeve. reeve's own review half is off.

### How the two fit together

```
YOU open a PR
      ↓
reeve (automatic)         ← watches it, reads CI, publishes a verdict
      ↓
   CI red?  ── yes ──→  FIX_CI worker fixes it, reeve pushes
      ↓ no
   blocked on something else  ──→  NEEDS YOU, and a push to your phone
      ↓
YOU (in a Claude session)  ← run the reviewer agents, work the findings
      ↓
YOU merge
```

reeve never merges. It publishes a verdict and GitHub does the refusing.

---

## 5. What a FIX_CI worker is allowed to do

Worth knowing, because it runs unattended.

| It can | It cannot |
|---|---|
| Read, edit and write files in **its own copy** of the branch | Touch your working directory |
| Run the project's own commands (`pnpm test`, `pnpm lint`) | Run any other shell command |
| `git add`, `git commit` locally | `git push` — **reeve** pushes, after checking the diff |
| — | Merge anything, ever |
| — | Reach the network (`curl`, `wget`, `ssh`) |
| — | Touch `.github/**` — the files that judge its work |
| — | Touch sensitive paths (auth, migrations, changesets, release scripts) |

These are enforced by the tool layer, not by asking the model nicely. That
distinction was measured: told not to write a file but given a plain shell, the
model wrote it with `printf >` on the very next turn.

One thing reeve deliberately does NOT try to do: stop the worker running code. It
cannot — anything that can write a file can write a script and run it. What it
enforces instead is what the worker may *reach* (paths, the network) and what it
may *do to the world* (it holds no push or merge authority at all). A worker's own
account of itself is never trusted; the diff comes from git, and CI re-runs on
whatever reeve publishes.

Before anything is published, reeve checks what **git** says changed — not what
the worker claims — against the lane's territory and the risk rules. A change
outside its territory is refused even if the worker was certain it was right.

---

## 6. Notifications

Escalations go to your phone via **ntfy**, on the topic **`revnix-reeve`**.

**What you need to do:** open the ntfy app, add a subscription to
`https://notify.revnix.com` topic `revnix-reeve`. The publish credential is
already on this machine and a real test push has been sent and accepted.

This is a **new topic**, separate from `revnix-nextly-ops`. Keeping them apart
means you can tell which system is asking for you. The old topic still works and
the old hook still uses it.

Only escalations are pushed, and only when they *arrive* — never repeated every
tick. An over-pushing channel gets muted within days, and a muted channel is worse
than no channel.

---

## 7. Stopping it

```sh
touch ~/.reeve/HALT     # stops everything, including any worker mid-flight
rm ~/.reeve/HALT        # resumes
```

The halt switch fails closed. It is a file, so you can create it over SSH from
your phone.

---

## 8. When something looks wrong

| Symptom | What to do |
|---|---|
| `reeve status` leads with a warning about the daemon | It has stopped ticking. `launchctl kickstart -k gui/$(id -u)/com.revnix.reeve` |
| A verdict looks wrong | `reeve why <pr>` — it prints the clause table and the trail |
| Nothing has happened for a while | `tail ~/.reeve/reeve.log`, and `~/.reeve/reeve.err.log` |
| A worktree went missing | It is under `~/Work/Products/nextly-worktrees/_quarantine`, intact. reeve quarantines rather than deletes whenever a checkout held work it could not account for |

---

## 9. What reeve is NOT, yet

Being clear about this saves disappointment:

- **It cannot pick your next task.** It watches pull requests. The task graph is
  still the `ledger` in `nextly-ops`.
- **It cannot research a feature or design one.** No competitor analysis, no gap
  finding. That is still you plus a Claude session.
- **It cannot review a PR.** The reviewer agents can, but you run them.
- **It cannot block a merge yet.** The verdict is published in shadow mode —
  visible, not enforcing — until it has run seven days with zero false blocks.
