# Session handoff — 2026-08-22, second session of the day

**This supersedes `docs/2026-08-22-session-handoff.md`**, which was written before
PRs #5, #6 and #7. Its keychain section is now WRONG in a way that matters; the
correction is in §4 below. Read this one.

Everything here is either **measured** (with the date and the file that records
it) or marked **intent**. If a claim has neither, distrust it. That rule earned
its place today: I twice acted on a document instead of on a measurement, and
both times the document was stale.

Durable companions: `docs/TRACKER.md` (what is done / in flight),
`docs/HANDOFF.md` (design reasoning), `docs/2026-08-21-builder-design.md` (the
builder spec), `docs/measured/*` (the facts).

---

## 0. The one-paragraph truth

reeve watches `nextlyhq/nextly` and publishes verdicts. It has **never dispatched
a worker** and still will not: `worker.isolation` is `none` in the live profile
and the daemon runs without `--execute`. S1 — the worker contract — is now
COMPLETE on `main` across four merged PRs. Everything that gated the
`--execute` decision is in place and measured. That decision is the founder's,
and it is the next real fork in the road.

---

## 1. Where the code is

| | |
|---|---|
| Repo | `github.com/revnix/reeve` (private), local `~/Work/Products/reeve` |
| `main` | `9bd0c61` — contains PR-1 `0d31350`, PR-2 `1a2fbea`, and #5 `0fdf351`, #6 `9dbd3a0`, #7 `9bd0c61` |
| Suite | **59 test files**, all green on `main` (node 24) |
| Daemon | launchd `com.revnix.reeve`, `reeve run nextlyhq/nextly`, observe-only, restarted on `9bd0c61` |
| Node | 24 is a floor (`node:sqlite`); the shell default here is 22, so always `PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"` |

`npm install` is needed in any fresh worktree: `@anthropic-ai/sandbox-runtime` is
a dev dependency and `test/escape.test.mjs` **fails rather than skips** on macOS
without it, deliberately.

**Worktrees in play:**

| path | branch | owner |
|---|---|---|
| `~/Work/Products/reeve` | `main` | the running daemon — do not `git pull` or switch branches here casually |
| `~/Work/Products/reeve-wt/paths` | `fix/per-commit-paths-and-attr-symlinks` | **the next PR — start here** |
| `~/Work/Products/reeve-wt/s2` | `plan/s2-hub-core` | ANOTHER SESSION. PR #8 is open. Do not touch. |
| `~/Work/Products/reeve-wt/{s3,shadow,gates}` | merged branches | stale, safe to remove |

---

## 2. What shipped today

Four PRs, all merged and verified by CONTENT (squash merges, so SHA ancestry
does not hold — compare trees, not parents).

**#5 — S1 close-out.** Standalone clone per run; a scratch HOME plus an OAuth
token replacing `~/.claude`; the founder's checkout deny-read; `reeve canary`;
dead linked-worktree code removed (`src/worktree.mjs` → `src/gitguard.mjs`).

**#6 — the shadow instrument.** The review shadow's four "divergences" were the
instrument, not the derivation.

**#7 — the publish path.** Eight ways content could reach the remote unread.

Three of the four needed several Codex rounds. **43 genuine findings across the
day**, and the ones that mattered most were not in the code I wrote last — they
were in the instruments that were supposed to be checking it.

---

## 3. Founder rulings — settled, do not re-litigate

1. **The gate**: every spec PR needs a Codex clean pass (mandatory serial
   witness), then a **15-minute** founder window; silence = go. Codex
   unavailable → a SHA-bound founder approval alone suffices; founder silence
   never advances without Codex.
2. **Revision cap: 10 rounds.**
3. **No new macOS user** (explicit). This killed the dedicated-worker-user design.
4. **Not cloud-hosted**; must run macOS + Windows + Ubuntu, fail-closed where a
   platform is unmeasured. macOS is the only measured platform.
5. **reeve merges builder-run PRs** on a PASS verdict; the replacement invariant
   is that reeve merges only what independent witnesses judged, never a worker's word.
6. Never mention reeve in CI for nextly (public) or client repos. No Claude
   attribution in commits/PRs. Conventional Commits. No `--no-verify`.
7. CodeRabbit Pro Plus declined — never raise again. Go/Rust/PHP not now. SPILL off.
8. **Merging is the founder's call, per PR.** A grant is spent when used.

---

## 4. Measured facts — do not re-derive, and note the CORRECTIONS

All in `docs/measured/`. The ones that shape everything:

**A scratch HOME closes the keychain SEARCH LIST, not the keychain.**
`2026-08-22-scratch-home-closes-the-keychain.md` — read its correction banner.
The file does not move, is unlocked `no-timeout`, and the worker runs as the same
OS user, so `security find-internet-password -s github.com <login.keychain-db>`
returned the credential from a scratch home. Closed by denying
`~/Library/Keychains` **by path**, measured with a positive control (44 under the
deny, 0 without). **The earlier handoff says the scratch HOME closed it. That was
wrong.**

**A permission rule takes an absolute path only with TWO leading slashes.**
`2026-08-22-the-read-deny-list-was-inert.md`. `Read(/Users/x/.ssh/**)` matches
nothing, silently. The file tools (`Read`/`Edit`/`Write`/`Grep`/`Glob`) are **not
covered by the OS sandbox at all** — the CLI's own process runs outside the
Seatbelt profile it applies to the shells it spawns.

**A deny that CONTAINS the worker's checkout refuses the worker its own files**,
because deny beats allow. Measured against the real CLI. Never write one; the
validator now refuses it.

**`find-*-password` cannot tell DENIAL from ABSENCE** (44 either way).
`security show-keychain-info <keychain>` can: 0 reachable, 161 denied. That is
the deciding probe.

**`pull_request.updated_at` does not change when a review thread is resolved.**
`2026-08-22-the-shadow-compared-two-moments.md`. Measured on merged #4, byte
identical across unresolve and re-resolve. Any polling guard built on it is blind
to review state.

**A worker could read the founder's checkout** where it lives.
`2026-08-22-the-founders-checkout-was-readable.md`. The clone carries only
committed content, which is not the same as out of reach.

**Costs, measured on nextlyhq/nextly (APFS):** `git clone --no-hardlinks` 2.4 s /
251 MB; `cp -Rc node_modules` 15 s / **31 MB real** (1.2 GB apparent).

---

## 5. The live canary is the instrument that earns its cost

`reeve canary [owner/repo]` runs one throwaway worker under the policy the
profile generates, prints what it found, and exits 0 when the credential read is
closed. Nothing is dispatched and nothing is published.

**It has now caught seven defects that ~640 green tests and the real-Seatbelt
escape test could not**, including two regressions from its own session's fixes
within a minute each. The first one ever run FAILED, and every finding was real.

Last run, on `main`'s policy:

```
canary dae5b2c1f1f59777 PASSED — credentialRead: closed
inside=0 tmp=0 outside=1 curl=56 probe=7 decoy=1
kc_github=44 kc_claude=44 kc_helper=1
kc_path_github=44 kc_path_claude=44 kc_path_open=161
filedecoy=1 filecontrol=0 symlink=1
readTool=denied  readInside=allowed  writeTool=denied
```

**Do not recommend arming anything on fixture measurements.** Run the canary.

It is a SHARED resource: one state file (`~/.reeve/canary/<owner>/<repo>.json`,
last writer wins) that the daemon and doctor both read, and it costs a real model
call. Only one session runs it.

---

## 6. Traps that bit me today — read before touching this code

- **An instrument made only of refusals passes when the worker can do nothing.**
  A deny on the checkout's parent refused workers every read of their own files,
  and the canary passed, because every probe it had measured a refusal. It now
  reads its own file and fails if that is denied OR never attempted OR returns no
  content.
- **A fixture that cannot exhibit the defect.** Twice. The symlink case skipped
  the copy entirely because its SOURCE did not exist; the commit-message case
  passed because the check errored on every input. Both were caught by stubbing
  the fix back out, never by reading.
- **A stub that stays green means the test is wrong, not that the fix is safe.**
  Three fixes had NO test until a stub loop showed 0 assertions going red.
- **Absence searches need a positive control.** A pathspec quoting error made a
  sweep report "absent" for everything, including things I had just found.
- **Documents go stale in days.** The nextly roadmap said Live Preview was
  greenfield (built) and the AGENTS.md scaffold was unstarted (built). I acted on
  it before verifying. Verify against `main` first, always.
- **`-c diff.external=` makes git execute the empty string.** Any content diff
  needs `--no-ext-diff`.
- **`capacity()` reads the host load average.** Three dispatch tests inject
  `ctx.capacity`; if a new one flakes, that is why.
- **`dispatch-e2e` makes real `gh` calls per tick** (~600 ms each). It is slow,
  not hung.
- Codex re-reports stale findings across rounds. Verify each against the code.

---

## 7. Remaining work, in order

### THE NEXT PR — three findings Codex left open on #7

They are on `main` now. Branch and worktree are already created:
`fix/per-commit-paths-and-attr-symlinks` at `~/Work/Products/reeve-wt/paths`.

**1. P1 — `src/daemon.mjs:236`, walk the per-commit diffs.**
`changedFiles` compares the range endpoints, so a worker that touches a
sensitive or out-of-territory path in one commit and restores it in a later one
gets past `reviewDiff` while the push still carries the intermediate commit.
`--name-only` shows the names in the DIFF, not the paths touched by each
intervening commit. Walk `${since}..${ref}` per commit.
Thread: `PRRT_kwDOT-hWms6baCND`

**2. P1 — `src/checkout.mjs:284`, reject symlinked attribute files.**
`declaredFilters` reads every `.gitattributes` with `readFileSync`, following
symlinks. A PR can commit `.gitattributes` as a symlink to `/dev/zero` and the
DAEMON hangs or exhausts memory before the worker is even launched. Codex
verified git retains mode `120000` and that the `ls-files` pathspec selects it.
`lstat` first, refuse anything that is not a regular file, and bound the size.
Thread: `PRRT_kwDOT-hWms6baCNH`

**3. P2 — `src/checkout.mjs:50`, scope the git isolation to worker-controlled
repos.** This one is stronger than it looks and I nearly under-rated it. `gitEnv()`
is applied to EVERY git call in that module, including `fetch`, `ls-remote` and
`push` against the FOUNDER's repo. If that repo's `origin` depends on a global
`url.<base>.insteadOf` rewrite — common with SSH rewrites and corporate proxies —
those calls now fail and **every dispatch and publication breaks**. Codex
reproduced it. The distinction is clean and worth stating in the code: the
isolation exists for git commands run in **worker-controlled** directories; the
founder's own repository is not one. Apply `gitEnv()` to the run checkout, not to
`git -C repoRoot`.
Thread: `PRRT_kwDOT-hWms6baCNK`

### Then, the founder's decision

**Arm `--execute`?** Everything gating it is on `main` and measured. What it
needs: set `worker.isolation: "scratch-home"` in
`~/.reeve/profiles/nextlyhq/nextly.json` and start the daemon with `--execute`.
Run a live canary on the merged code first and hand the founder the result.

### Guardian tail (independent, small)

- **The review shadow week has 0 clean days** and four recorded divergences
  (`#1134`, `#1128`, `#1131`, `#1133`). #6 fixed the instrument, so the clock
  restarts from the next clean day and any divergence that SURVIVES is now real.
- `REQUEST_REVIEW` and `SPILL` prompts tell the worker to use `gh`, but the
  contract shims `gh` and holds no credential. Must go through reeve's outbox
  before `watch.reviewActions` arms.
- `e.threadDetails` is read at both review dispatch sites and written by nothing.
- `ci.flakePatterns` is in the schema with zero readers (its decision belongs to S2).
- Wrong-worker dispatch evidence (a confidently bad fix) still unbuilt.

### Builder S2 — ANOTHER SESSION OWNS THIS

PR #8 (`plan/s2-hub-core`) is open, written by a parallel session. Do not touch
it, its branch, or its worktree. Coordinate via SendMessage if the lanes meet.

---

## 8. What needs the founder

- **The `--execute` decision.** Nothing else gates it.
- **A merge grant for each PR.** The last one is spent.
- **ntfy read user** — all five tokens are write-only; needs shell on the ntfy host.
- **Ruleset flip** for capability 4, after the verdict shadow week.
- **`R-01` is BROKEN and has been all along**: `enforce_admins: false`, the
  ruleset lets `OrganizationAdmin` bypass always, and it carries no required
  status checks. Every gate written against that repo is decorative until the
  actuator loses its bypass. This is a founder action, not a code fix.

---

## 9. How to verify all of this

```bash
cd ~/Work/Products/reeve && npm install          # srt is a dev dep
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
for f in test/*.test.mjs; do node "$f" >/dev/null || echo "FAILED $f"; done
node test/escape.test.mjs        # the real-sandbox measurements, macOS only
./bin/reeve doctor nextlyhq/nextly --as-app
./bin/reeve shadow nextlyhq/nextly
tail -30 ~/.reeve/reeve.log      # a tick every ~90s
```

Expected doctor today: **R-01 BROKEN** (the ruleset, pre-existing, founder
action), **R-03 BROKEN** (merge shape: 4 merge commits in the last 20 while the
gate declares squash), **R-05 DEGRADED** (Codex refused 57% this week),
**R-15 DEGRADED** (`worker.isolation` is `none` — correct, and it says so),
**R-14 OK** (the canary record matches the deployed policy).

---

## 10. Open risks, stated plainly

- **The worker holds a working Claude token in its environment.** It must, to
  run. Bounded by: no network, the diff and every newly reachable object scanned
  for that token before publishing, and no other sandboxed process able to read
  its env. The scan is a LITERAL match — a worker that encodes the value walks
  around it. Not closed; brokered auth is the real answer and is not built.
- **Only macOS is measured.** Windows and Ubuntu workers are refused.
- **`R-01`**: the merge gate is decorative until the admin bypass goes.
- **The token file** `~/.reeve/claude-token` (0600) is a real credential inside
  the deny-read tree. Rotate with `claude setup-token` if it leaks.
- **Ten Claude sessions were alive on this machine today.** Coordinate before
  assuming a lane is free.
