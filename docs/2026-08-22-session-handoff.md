# Session handoff — 2026-08-22

Written at the end of a long session so the next one starts with the same facts
rather than re-deriving them. Everything here is either **measured** (with the
date and the file that records it) or marked **intent**. If a claim has neither,
distrust it.

Durable companions, which this does not replace:
`docs/TRACKER.md` (what is done / in flight), `docs/HANDOFF.md` (the system's
design reasoning), `docs/2026-08-21-builder-design.md` (the builder spec),
`docs/measured/*` (the facts).

---

## 0. The one-paragraph truth

reeve watches nextlyhq/nextly and publishes verdicts. It has **never dispatched
a worker** and still cannot: dispatch is refused in code. S1 (the worker
contract) is complete on `main` as PR-1 and PR-2; PR-3 is in flight on a branch
and is what would make dispatch *possible* — not enabled. The founder's
credentials are now unreachable from a worker by construction, which is new
today and is the single biggest change in this session.

---

## 1. Where the code is

| | |
|---|---|
| Repo | `github.com/revnix/reeve` (private), local `~/Work/Products/reeve` |
| `main` | `8f8b41f` — contains PR-1 (`0d31350`) and PR-2 (`1a2fbea`, merged as #4) |
| In flight | branch `feat/s1-standalone-clones`, worktree `~/Work/Products/reeve-wt/s3`, 3 commits: `3e8d6eb`, `066472c`, `e2bb635` |
| Suite | **58 test files**, all green on the branch (`for f in test/*.test.mjs; do node "$f"; done`, node 24) |
| Daemon | launchd `com.revnix.reeve`, running `reeve run nextlyhq/nextly` **observe-only** (no `--execute`), pid 88387 at handoff time |
| Node | 24 required (`node:sqlite`); the shell default here is 22, so always `PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"` |

`npm install` is needed in any fresh worktree: `@anthropic-ai/sandbox-runtime` is
a dev dependency and `test/escape.test.mjs` **fails rather than skips** on macOS
without it, deliberately.

---

## 2. The two programmes

**Programme 1 — the guardian (live, partly armed).** Four capabilities:
watch/judge/escalate is ON; fix-CI (`--execute`) is off; review actions
(`watch.reviewActions`) off; refuse-unsafe-merge (`--enforce` + ruleset) off.

**Programme 2 — the builder (ruled in 2026-08-21, S1 built).** reeve picks a
task, researches, designs, specs, implements, PRs, guards, and merges. The
worker contract (S0/S1) is what both programmes share, and it is what this
session was about.

---

## 3. Founder rulings — settled, do not re-litigate

1. **The gate**: every spec PR needs a Codex clean pass (mandatory serial
   witness), then a **15-minute** founder window; silence = go. Codex
   unavailable → a SHA-bound founder approval alone suffices; founder silence
   never advances without Codex.
2. **Revision cap: 10 rounds** (raised from 5 on 2026-08-22, because reeve #4
   needed 8 and a cap of 5 would have escalated it with two privilege-escalation
   paths still open).
3. **No new macOS user** (2026-08-22, explicit). This killed the
   dedicated-worker-user design and forced the scratch-HOME closure below.
4. **Not cloud-hosted**; must run macOS + Windows + Ubuntu, fail-closed where a
   platform is unmeasured. macOS is the only measured platform today.
5. **reeve merges builder-run PRs** on a PASS verdict; the replacement invariant
   is that reeve merges only what independent witnesses judged, never a worker's
   word.
6. Never mention reeve in CI for nextly (public) or client repos. No Claude
   attribution in commits/PRs. Conventional Commits. No `--no-verify`.
7. CodeRabbit Pro Plus declined — never raise again. Go/Rust/PHP not now.
   SPILL off indefinitely.

---

## 4. Measured facts — do not re-litigate these either

All in `docs/measured/`. The ones that shape the design:

**`2026-08-22-claude-print-mode.md`**
- `sandbox.*` **applies** under `-p`: network, outside writes, `denyRead`
  (including through symlinks) and `Read(...)` denies all hold.
- An **invalid settings file is dropped whole and silently, exit 0** — so a
  supplied path proves nothing and pre-spawn validation is load-bearing.
- `--setting-sources local` loads the checkout's `settings.local.json`; use `""`.
- The sandbox **blocks loopback**, which is why the canary's network control is a
  daemon-local listener.
- **Exact-file** `denyRead` works while a neighbour in the same directory stays
  readable.

**`2026-08-22-scratch-home-closes-the-keychain.md`** (the important one)
- The keychain is reached **through `HOME`**. With a scratch home the search list
  collapses to `/Library/Keychains/System.keychain` and both the GitHub and
  Claude items answer `errSecItemNotFound`.
- The OS sandbox **cannot** deny the keychain: the runtime's Seatbelt profile
  hard-allows `com.apple.securityd.xpc` and `com.apple.SecurityServer`.
- `claude` with a scratch home and no token: `Not logged in`.
  `CLAUDE_CODE_OAUTH_TOKEN` replaces `~/.claude`; proven end to end
  (`is_error:false` while both keychain probes returned not-found).
- A **sandboxed** process cannot read another process's environment (`ps eww`
  returns nothing); an unsandboxed one can. So a token in the daemon's env is out
  of a worker's reach.

**Costs, measured on nextlyhq/nextly (APFS):**
- `git clone --no-hardlinks`: **2.4 s, 251 MB** (own `.git`, committed content only)
- `cp -Rc node_modules`: **15 s, 31 MB real** (1.2 GB apparent — copy-on-write)

---

## 5. What this session did, and why

### PR-1 close-out (already on main)
Deployed, daemon restarted, R-13 baseline matched, worktree/branch cleaned.

### PR-2 — the OS sandbox and a measured verdict (#4, merged `1a2fbea`)
Shipped: the `sandbox.*` block in every worker's settings; `validateSettings`
before spawn; the **sandbox canary** (a throwaway worker per CLI build + policy
whose *files the daemon reads*); measured containment; doctor R-14/R-15; the
escape test rewritten to measure every shape twice (environment-only and under
the real Seatbelt sandbox).

**It took 8 Codex rounds and 43 genuine findings.** Rounds 1–6 found new areas
(quarantine unenforced at the OS layer, git's XDG credential store,
`core.fsmonitor` as daemon-user RCE); rounds 7–8 were entirely follow-ups on its
own fixes. **That shift in character, not the count, was the convergence signal**
— it is the rule to reuse.

### PR-3 — in flight (the branch)
1. **`3e8d6eb` standalone clone per run.** A linked worktree shares the clone's
   ref store and config; a standalone clone shares neither, so the shared-ref and
   shared-config holes close by construction. The clone carries only committed
   content, so the founder's uncommitted work and ignored files (a `.env` among
   them) never reach a worker. Dependencies come copy-on-write, because the
   network is denied and **there was no dependency-install step anywhere in the
   dispatch path** — a fixer could never run the project's tests to check its own
   fix. Work leaves by fetch into reeve's own repo, so the worker still never
   publishes.
2. **`066472c` the scratch-HOME closure.** `workerEnv` now REFUSES the founder's
   home and REFUSES a missing token. `CONTAINMENT.credentialRead` is
   `"closed-by-home"`. The canary gained three keychain probes.
3. **`e2bb635` dispatch wiring.** Dispatch prepares a standalone checkout keyed
   by run id (so the policy is built *after* it, against it); publishing goes
   through `publishRunWork` (fetch into reeve's repo, push from there);
   containment's gate moved from a **proxy** (the host keychain looking empty —
   a probe of two known item shapes) to a **measurement** (the canary's probes).
   `worker.isolation` gained `scratch-home`; `dedicated-user` is unbuilt and
   refused with that reason rather than silently downgraded.

---

## 6. Traps that bit me this session — read before touching this code

- **`~/...` in a deny rule expands against the PROCESS's home.** Giving workers a
  scratch home therefore silently disabled the *entire* file deny list. Caught by
  `test/escape.test.mjs`. Credential paths are absolute now, resolved against the
  daemon's home. **Never write a tilde into a policy path.**
- **The canary results parser matched `[a-z]+`**, dropping `kc_github`, which read
  as "the probes did not run" and would have failed every real canary. Underscore
  now included.
- **`capacity()` reads the host's load average**, so any test asserting dispatch
  fails on a busy machine. Three tests inject `ctx.capacity`. If a new dispatch
  test flakes, that is why.
- **`dispatch-e2e` makes real `gh` calls per tick** (~600 ms each), so it is slow,
  not hung. Do not "fix" it by adding timeouts.
- **A fixture can hide the bug it tests.** My first double-refund test seeded an
  attempt that hit `maxFixAttemptsPerFinding: 1`, so the tick escalated before
  ever reaching the spawn and the assertion passed either way. **Always stub the
  fix back out and confirm the test goes red.**
- **Assert on every text patch.** I twice reported an edit as applied when the
  anchor had not matched.
- Codex re-reports stale findings across rounds. Verify against the code before
  working one; several rounds were 50–100 % stale.

---

## 7. Remaining work

### PR-3 tail (do this first)
1. **Dead code**: `worktree.mjs`'s `acquireWorktree` / `releaseWorktree` /
   `pushWorktree` are no longer used by dispatch, but tests still cover them —
   false confidence. Remove them, or re-point the escape test's environment-only
   section at the run checkout. `resolveWorktree` in `daemon.mjs` is also now
   unused except by `test/worktree-root.test.mjs`.
2. **Doctor wording** for the new arrangement (R-15 currently talks about the
   keychain gating dispatch; it no longer does).
3. **Open the PR**, request Codex, work rounds (cap 10), reply and resolve every
   thread via GraphQL, merge only with CI green and zero open threads **and the
   founder's explicit grant** — the last self-merge grant is spent.
4. **A live canary run** on the real profile as evidence before recommending the
   flag. Do not recommend arming on fixture measurements.

### Then, to actually dispatch (needs the founder)
Set `worker.isolation: "scratch-home"` in the live profile and start the daemon
with `--execute`. Nothing else gates it once the canary passes.

### Guardian tail (independent of the builder)
- **Shadow week reset today.** `#1134` diverged: `resolved differs: live 13,
  derived 18` (55 comparisons, 52 agreements; every other PR 161/161). The 5-day
  clean run for PR-5 restarts from the next clean day. **Investigate that
  divergence** — it is a real disagreement between reeve's derived review state
  and GitHub's live one.
- PR-6 precondition: `REQUEST_REVIEW` and `SPILL` prompts tell the worker to use
  `gh`, but the contract shims `gh` and holds no credential. Those effects must
  go through reeve's outbox before `watch.reviewActions` arms.
- `e.threadDetails` is read at both review dispatch sites and written by nothing.
- Wrong-worker dispatch evidence (a confidently bad fix) still unbuilt.
- `ci.flakePatterns` is declared in the schema with zero readers.

### Builder, after S1
S2 onwards per `docs/2026-08-21-builder-design.md` §14. The first live task
exercises the Codex-silent branch of the gate.

---

## 8. What needs the founder

- **Nothing to unblock PR-3.** Everything above is mine to build.
- **The `--execute` decision**, once PR-3 lands and a live canary passes.
- **ntfy read user** — all five tokens are write-only; needs shell on the ntfy
  host. Desktop notifications work meanwhile.
- **Ruleset flip** for capability 4, after the verdict shadow week.
- A merge grant for PR-3 (each PR needs its own; the last one was spent).

---

## 9. How to verify the whole thing still works

```bash
cd ~/Work/Products/reeve && npm install                     # srt is a dev dep
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"   # 24 is a floor
for f in test/*.test.mjs; do node "$f" >/dev/null || echo "FAILED $f"; done
node test/escape.test.mjs        # the real-sandbox measurements, macOS only
./bin/reeve doctor nextlyhq/nextly --as-app
tail -30 ~/.reeve/reeve.log      # a tick every ~90s, backups, shadow line
```

Expected doctor today: R-01 BROKEN (pre-existing, the ruleset item), R-05
DEGRADED (reviewer refusal rates), R-13 OK, R-14 UNKNOWN (no canary has ever
run), R-15 DEGRADED (the keychain holds a GitHub credential — which no longer
gates dispatch, so this wording is on the fix list).

---

## 10. Open risks, stated plainly

- **The worker holds a working Claude token in its environment.** It must, to
  run. Bounded by: no network, reeve reviews every diff, and no other sandboxed
  process can read its env. Not closed.
- **Only macOS is measured.** Windows and Ubuntu workers are refused.
- **The canary has never run for real.** Every containment property is proven by
  fixtures plus the runtime-level escape test; the end-to-end proof under the
  real CLI is the live canary run listed above.
- **The token file** `~/.reeve/claude-token` (0600) is a real credential inside
  the deny-read tree. If it leaks, rotate with `claude setup-token`.
- A token pasted into a chat transcript earlier in this session was **revoked by
  the founder**; the one in use is a later one and was verified working after the
  revoke.
