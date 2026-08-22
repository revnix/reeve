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
| `reeve shadow nextlyhq/nextly` | Whether the review data is trustworthy yet |
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
| Read, edit and write files in **its own copy** of the branch, and the run's own temp dir | Write anywhere else — the OS sandbox denies it, not just a rule |
| Run the project's own commands and language runtime (`pnpm test`, `node`, `git`) | Reach the network at all — the OS sandbox denies it (research phases get a named allowlist) |
| `git add`, `git commit` locally | **Push or merge, ever.** reeve publishes, after checking the diff |
| **Read** the workflow that is failing it | **Change** `.github/**` — the files that judge its work |
| Read sensitive code to understand a failure | **Change** sensitive paths (auth, migrations, changesets, release scripts) |
| — | Read quarantined data, or any credential FILE (`~/.ssh`, `~/.config/gh`, `~/.aws`, …) — deny-read at the OS layer |

A FIX_CI worker also runs with a **built environment**, not your shell's: no
`GH_TOKEN`, no ssh agent, no cloud or proxy variables, a git that is told to read
no system config and use no credential helper, and a `gh`/`ssh` that refuse. It
runs inside the **OS sandbox** (Seatbelt on macOS) with no unsandboxed fallback:
the network is denied, writes are confined to its worktree and the run's temp
dir, and every credential file is deny-read. The settings that ask for all this
are **validated before the worker starts**, because a settings file that fails
validation is silently ignored. Its output streams to files under
`~/.reeve/runs/<owner>-<repo>/<pr>/<run>/` so a crashed daemon can still read what
the worker said, and every run records the exact CLI version, model, and settings
it ran under (`worker_run`). If the daemon cannot prove the worker's lease is
still live, the worker is terminated rather than trusted.

**What the sandbox does NOT cover, stated plainly.** The worker still runs as
you, with your real home directory (the `claude` CLI needs it to authenticate).
The OS sandbox denies credential *files*, but it cannot deny the macOS
*keychain* — the runtime's own profile hard-allows the security service — so a
worker that asks `git`'s osxkeychain helper still gets your GitHub token; and a
worker in a linked worktree shares your checkout's git dir, so it can move a
branch or plant a hook. That is measured, not theoretical
(`test/escape.test.mjs` records each as known-open). **So before any worker is
dispatched under `--execute`, reeve MEASURES this host: a sandbox canary must
pass under the running CLI, your login keychain must hold no GitHub credential,
and the profile must declare an isolated worker (`worker.isolation:
dedicated-user`).** The keychain probe is a guard, not a guarantee — another app
can store a token elsewhere in your account — so the only real closure is a
**dedicated worker OS user** with its own empty keychain and its own clone of the
repo. Until that is in place, dispatch is refused and reeve says so once as
`guardian:containment:open`; `reeve doctor` shows R-14 (the canary) and R-15
(the keychain) so you can see why. Capability 2 stays off by code, not by
memory.

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

Escalations go to **two places**, and both must work for reeve to call a send
successful — a phone that did not ring is a failure even when the desk did.

**This Mac: working now.** A native notification appears whenever something needs
you. Nothing to set up.

**Your phone, via ntfy on topic `revnix-reeve`: BLOCKED, and it needs you.**
reeve's pushes succeed — the server accepts every one — but no credential on this
machine can READ that topic. All five tokens on the publishing account are
write-only, the account is role `user` with no read grants, and `/v1/users`
returns 401. Creating a reader needs shell access to the server:

```sh
ntfy user add mobeen                        # prompts for a password
ntfy access mobeen revnix-reeve read-only
```

and, for iOS background delivery, `upstream-base-url: "https://ntfy.sh"` in
server.yml. Then subscribe in the ntfy app to `https://notify.revnix.com`.

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
| `launchctl list` shows `-9` next to reeve | Normal. That is the signature the restart above leaves behind, not a crash. What matters is whether a PID is shown and the log is still moving |
| A verdict looks wrong | `reeve why <pr>` — it prints the clause table and the trail |
| Nothing has happened for a while | `tail ~/.reeve/reeve.log`, and `~/.reeve/reeve.err.log` |
| A worktree went missing | It is under `~/Work/Products/nextly-worktrees/_quarantine`, intact. reeve quarantines rather than deletes whenever a checkout held work it could not account for |

---

## 9. reeve is a GUARDIAN today — and a BUILDER is being designed

TODAY reeve does **not** pick what to build, research it, design it, or write it.
It watches pull requests that already exist. The shape today is: **you (or a
Claude session running Prompt A/B) build the feature and open the PR — then reeve
takes over.** It fixes the CI, works the reviewer findings, and refuses an unsafe
merge.

**Ruled 2026-08-21:** reeve will also become a builder — you file a task (or it
picks one from the ledger), it researches and designs, opens a plain-language
spec PR for your approval (with a 30-minute window and a Codex-reviewed
fallback), implements, and merges when the verdict passes. That programme is in
design; its requirements and state live in `docs/TRACKER.md`, Programme 2.
Nothing in this document's guardian half changes.

## 9b. What reeve is NOT, yet

Being clear about this saves disappointment:

- **It cannot pick your next task.** It watches pull requests. The task graph is
  still the `ledger` in `nextly-ops`.
- **It cannot research a feature or design one.** No competitor analysis, no gap
  finding. That is still you plus a Claude session.
- **It cannot review a PR.** The reviewer agents can, but you run them.
- **It cannot block a merge yet.** The verdict is published in shadow mode —
  visible, not enforcing — until it has run seven days with zero false blocks.
