# Issue #50 — the session that owns the guardian's hub rules

**Produced 2026-08-28** by a measure → research → design pass: three agents enumerating the real
call sites, the tests that pin behaviour and the provider contracts (36 measured
facts), two researching the pattern and the safe-refactor discipline (24 items), and
one designing against both — instructed to re-verify anything decision-critical itself rather
than inherit it.

**It corrected the brief it was given, twice, and both corrections matter:**

1. **The base was stale.** The brief said `main` = `97838d9`; it is `a529096`. Re-measured:
   `src/daemon.mjs` is **3,433 lines** and `tick()` spans **`:1022-3303` = 2,282 lines**.

2. **The escalation key in the brief does not exist.** It said the guardian escalates
   `builder:provider:hub-unreadable` on an unreadable hub. That string has **zero hits** across
   `src/`, `bin/` and `test/`; the shipped key is **`guardian:hub:unreadable`** (5 files).
   `test/guardian-provider-lease.test.mjs` asserts it with an **exact-match `includes()`**, so
   adopting the brief's wording would have kept **3 of 4 assertions green while silencing the
   audible half of the founder's fail-open ruling** — a guardian that fails open and no longer
   says so. The stale form came from `trackers/s2.md`, which has since been corrected; the
   correction had *already* been made in the S2-C plan and recorded at
   `S3-AUDIT-REPORTS.md:710` as never back-patched.

**Environment note that would waste an afternoon:** the `node` on `PATH` is **v22.18.0** and
`package.json` requires `>=24.10.0`. Four suites crash before asserting. Use
`~/.nvm/versions/node/v24.17.0/bin/node`. Baseline measured in a real git checkout: **94 of 95
green**, the one red being `test/escape.test.mjs` for a missing optional dependency. Note also
that characterisation must run in a **git worktree, not a `git archive` export** — two further
suites shell out to `git -C` and go red in an export for reasons that have nothing to do with the
change under test.

---

Verified everything decision-critical myself. Handing back the design.

---

# Design for issue #50 — a session that owns the guardian's hub rules

## 0. Base correction, before anything else

**Branch from `origin/main` = `a529096`, not `97838d9`.** The brief's ref is two commits stale and the worktree at `/Users/mobeen/Work/Products/reeve-wt/c4` (`docs/s3-foundation`, `f82e16f`) has `src/` and `test/` byte-identical to **`main` = `36b4107`**, three commits behind `origin/main`. Measured on `a529096`: `src/daemon.mjs` = **3,433 lines**, `tick()` = **:1022–3302 = 2,281 lines**, three exits at **1639 / 1668 / 3302**. All line numbers below are `a529096`.

Two facts in the brief are wrong and would poison the work if inherited:

- **`builder:provider:hub-unreadable` exists nowhere in `src/`, `bin/`, `test/`** — 0 hits, positive control `guardian:hub:unreadable` → 9 hits across 5 files. The shipped keys are `guardian:hub:unreadable` (daemon.mjs:1375, :1418, :1451) and the free-text `"the provider scheduler is unreadable; dispatching unscheduled"`. `test/guardian-provider-lease.test.mjs:1299` uses `esc.includes("guardian:hub:unreadable")` — an exact match. **Renaming it to the brief's string keeps 3 of 4 assertions green and silences the founder's audible half.** Do not adopt the brief's wording.
- Node on PATH is **v22.18.0**; `package.json` requires `>=24.10.0`. Four suites crash before asserting. Use `~/.nvm/versions/node/v24.17.0/bin/node`.

**Baseline green-set, measured in a real git checkout:** 94 of 95 green. Only `test/escape.test.mjs` is red, and only because `@anthropic-ai/sandbox-runtime` is not installed. (In a `git archive` scratch tree `review-request-effect` and `source-is-text` also go red — they shell out to `git -C`. Characterisation must run in a git worktree, not an export.) Lease suite runtime: **25 s**.

### The measurement that actually decides the API

`claimHub()` is a **two-way collapse of a three-way answer.** `hubOr(onFault)` returns `a.why ? onFault(why) : a.hub`, so `claimHub() === null` means *absent* **and** *unreadable*, indistinguishably. Every site that needs the three-way answer must therefore bypass `claimHub` and call `hubNow()` — and then **re-implement the fault-report latch by hand**. Exactly one site does today:

```
daemon.mjs:1370-1376   hubOr:            if (a.why && !hubFaultSaid) { hubFaultSaid = true; log(...); raise("guardian:hub:unreadable"); }
daemon.mjs:1438,1451   releaseWithRetry: const a = hubNow(); ... if (!hubFaultSaid) { hubFaultSaid = true; log(...); raise("guardian:hub:unreadable"); }
```

One rule, two spellings, because the primitive throws away the information one caller needs. That is the #50 shape at the level of the *primitive*, not the call site — and it is why the session's single private primitive must be the three-way answer and nothing else.

Consequence already visible: the cooldown ladder (`hubOr` at 1524) **cannot** distinguish absent from unreadable, so it defers in both; the release ladder (`hubNow` at 1438) drops on absent and defers on unreadable. Two ladders, four lines apart, with divergent semantics. **Preserve that divergence exactly** — it is defensible in both directions and constraint 2 forbids folding it in silently.

---

## 1. THE API

### It is an object with a lifecycle, constructed once per tick. Not callback-scoped, not `Disposable`.

**Why not `withProviderSession(fn)`:** a bracket promises paired release on every exit path. reeve's release has three outcomes and two of them are *"not released, retry next tick"* — `hub unreadable` → defer, `throw` → defer, `{ok:false, reason:"maintenance"}` → defer, with the identity carried in `ctx.providerRetry` **into the next tick**. The worker lease is claimed at 2397, bound at 2773 inside `onSpawn`, released at 2820 inside a `finally`, and may then outlive the tick. Nothing can contain that. The canary *is* bracketable (claim 2210 → bind 2241 → release 2273); offering both forms would be two shapes for one rule, which is the disease.

**Why not `using` / `Symbol.dispose`** (it does work — Node 24 parses `using` unflagged and `DatabaseSync` implements `Symbol.dispose`): a dispose has no return value and no vocabulary for *"legitimately not released, keep the identity"*; a throwing dispose becomes a `SuppressedError`, and the worker release runs at the top of a `finally` whose own comment says *"Cleanup must not be able to destroy the outcome it exists to record."* Separately, `using` anywhere in `bin/reeve`'s import graph converts its friendly Node floor (`bin/reeve:223`) into a raw `SyntaxError`, because ESM parses the whole graph before the entry's first statement runs.

### `src/build/hubsession.mjs`

```js
/**
 * Every hub touch the guardian's tick makes, behind one door.
 *
 * THE SESSION HOLDS THE GETTER AND NEVER A HANDLE. No method returns one, no
 * field stores one, and `daemon.mjs` has none in scope. "A fresh hub handle at
 * every mutation" -- applied at 2 of 4 sites in PR #44 -- is not enforced here,
 * it is UNWRITABLE: there is no handle to reuse.
 */
export function hubSession({
  hub,                 // REQUIRED. The GETTER: () => ({ hub, why }). Never a handle.
  owner = "guardian",
  repoId,              // number | null
  pid,                 // process.pid
  lstart,              // string | null
  isAlive,             // (pid, lstart) => boolean
  nwo,                 // for the log lines that already name it
  carried,             // { releases: Map, cooldowns: Map } -- SUPPLIED, never allocated here
  log,                 // (line) => void
  raise,               // (cause, n = 1) => void
  ops,                 // the eight provider seams, resolved by the caller
  now = () => Math.floor(Date.now() / 1000),
}) -> Session   // Object.freeze'd
```

Three constructor rules that are load-bearing:

- **`hub` is the getter.** If `typeof hub !== "function"` the constructor throws. Today `hubNow` at :1354 silently accepts a bare handle (`ctx.hub ?? null`); that tolerance is what lets a captured handle in. No fixture uses the non-function form (all 37 `tick(` sites pass `hub: () => (...)` or `hub: null` — and `hub: null` must keep working, so: `null`/`undefined` normalise to `() => ({hub:null, why:null})`, anything else non-function throws).
- **`carried` is supplied, never allocated.** `ctx.providerRetry` and `ctx.cooldownRetry` are cross-tick state (daemon.mjs:1434, :1484). A session that allocates its own Maps drops every deferred release and cooldown **and nothing fails**: the tick returns, the escalation still raises, the lease is simply never given back. The constructor throws if `carried.releases` / `carried.cooldowns` are not Maps.
- **`ops` collapses the eight `ctx.*` seams into one bag**, but `daemon.mjs` keeps building it as `{ claim: ctx.providerClaim ?? claimProvider, ... }`. **Do not collapse the `ctx` surface in the move PR.** All 37 `await tick(` fixtures and the whole characterisation harness depend on those seam names. Collapsing them is a follow-on.

### The private primitive — the only thing that touches the getter

```js
// #ask() -> { hub, why }, exactly as the getter answered.
//
// NOT wrapped in try/catch: `hubNow` at daemon.mjs:1354 is not either, and a
// getter that throws must go on aborting the tick as it does today.
//
// The fault is reported ONCE PER SESSION. Today this latch is written twice --
// inside `hubOr` and again inline in `releaseWithRetry` -- because `claimHub()`
// collapses the three-way answer and the release path needs it. There is one
// primitive here and it is three-way, so there is one latch.
#ask() {
  const a = this.#hub();
  if (a.why && !this.#faultSaid) {
    this.#faultSaid = true;
    this.#log(`hub: ${a.why}`);
    this.#raise("guardian:hub:unreadable");
  }
  return a;
}
```

`#ask` is `#private`. It is never exported, never returned, and no public method returns `a.hub`.

### The frozen public surface — twelve verbs

```js
claim({ runRef, priority = 0, budgetUsd = null })   -> Verdict
serveQueueHead({ intended })                        -> { served: string | null }
release(lease)                                      -> void
bind(lease, { pid, lstart })                        -> void      // THROWS on failure
heartbeat(lease)                                    -> { lost: boolean }
noteCooldown(key, { signature, cooldownSeconds })   -> void
reap()                                              -> void
queued()                                            -> { rows, readable }
withdrawAll()                                       -> void
sweepQueued({ rows, keep })                         -> void
drainDeferred()                                     -> void
holdFor({ pr })                                     -> { readable, why, ...hold }
```

Two return types carry the whole design.

**`Verdict` — three states, and `state` is a string so `if (v.ok)` cannot be written:**

```js
{ state: "scheduled",   lease: Lease | null }            // proceed, holding a lease (or none: got.id was null)
{ state: "unscheduled", why: string | null }             // FAIL OPEN -- dispatch anyway. `why` is null when the hub is merely ABSENT.
{ state: "refused",     reason: string, until?: number } // FAIL CLOSED -- do not dispatch. reason ∈ the provider's alphabet
                                                         //   { queued, cooldown, at-limit, held-elsewhere, no-identity, maintenance }
                                                         //   plus the session's own "unscopeable" (repoId == null)
```

**`Lease` — minted by the session, validated on hand-back:**

```js
// A frozen { owner, repoId, runRef, id, token } the caller cannot construct.
// `release`, `bind` and `heartbeat` check membership in a private WeakSet and
// throw on anything else. "The identity, never the id" stops being a rule:
// there is no id-shaped argument to pass.
```

### Method contracts, exactly

```js
claim({ runRef, priority, budgetUsd })
  1. const a = #ask()                                  // fault reported once per session
  2. if (!a.hub) return { state: "unscheduled", why: a.why }        // FAIL OPEN, and FIRST
  3. if (repoId == null) { raise("the repository numeric id is unknown; provider leases cannot be scoped");
                           return { state: "refused", reason: "unscopeable" } }   // FAIL CLOSED, and SECOND
  4. #asked.add(runRef)                                 // BEFORE the call, inside the try, as today (daemon:2396)
     try { got = ops.claim(a.hub, { owner, repoId, runRef, pid, lstart, priority, budgetUsd, isAlive }) }
     catch (err) { raise("the provider scheduler is unreadable; dispatching unscheduled");
                   return { state: "unscheduled", why: err.message } }            // FAIL OPEN
  5. if (!got.ok) { if (got.reason === "no-identity")
                      raise("the guardian cannot read its own process identity; no work can be scheduled");
                    return { state: "refused", reason: got.reason, until: got.until } }
  6. return { state: "scheduled", lease: got.id != null ? #mint({owner, repoId, runRef, id: got.id, token: got.token ?? null}) : null }

serveQueueHead({ intended })
  // The queue-head preflight (daemon:2148). DOES NOT mark `askedFor`, deliberately --
  // see daemon:2130-2147. Claims the oldest intended non-canary row and releases it
  // immediately. One #ask() for the read AND the claim AND the release.
  // Returns { served: runRef|null }. A refusal is silent, as today.

release(lease)
  // The full ladder, once. Absent -> return (no defer). Unreadable -> carried.releases.set + log.
  // Throw -> carried.releases.set + log + raise. reason==="maintenance" -> defer. Else -> delete.
  // Key is `lease.runRef`, matching today's callers. Message text preserved verbatim.

bind(lease, { pid, lstart })
  // BOUND OR IT DOES NOT RUN. There is no non-throwing variant, because both call
  // sites want the throw and a second variant is a second chance to get it wrong.
  //   b.ok === false      -> throw new Error(`${what} could not be rebound: ${b.reason}`)
  //   b.bound !== 1       -> throw new Error(`${what} rebind matched ${b?.bound ?? "no"} row(s); ...`)
  // A null hub also THROWS here -- this is the ONE classified fail-closed method,
  // and it is named as such in the acceptance table.

heartbeat(lease)
  // The two-stage predicate written once: { lost: r?.ok === true && r.beat === 0 }.
  // A REFUSAL is not loss. Absent/unreadable hub -> { lost: false }. A throw is
  // caught and logged exactly as today (daemon:2569), never fatal.

noteCooldown(key, { signature, cooldownSeconds })
  // Stamps observedAt AND expiresAt once, at observation; the retry asks for what
  // REMAINS; left <= 0 deletes. Defers on !hub (BOTH absent and unreadable -- today's
  // behaviour via hubOr, preserved), on throw, and on maintenance.

reap() / queued() / withdrawAll() / sweepQueued({rows, keep}) / drainDeferred() / holdFor({pr})
  // Each takes exactly ONE #ask() and uses that one handle for its whole unit of
  // work -- withdrawAll's read plus every cancel in its loop, sweepQueued's whole
  // loop -- which is precisely what the code does today (daemon:1626, :3118).
  // holdFor returns the getter's three-way answer verbatim; the caller's fail-CLOSED
  // reading stays visible in daemon.mjs.
```

### Why this makes "a new call site cannot skip a rule" structurally true — and where it is only *tested*

**Structurally true**, by lexical scope (Miller's object-capability: authority travels only by reference):

After PR-4, `src/daemon.mjs` contains no `hubNow`, no `hubOr`, no `claimHub`, no `const hub`, no `openHold` import, and no hub-typed value at all. A new call site **cannot** capture a stale handle, cannot restate the busy timeout, cannot pass an id instead of an identity, cannot ask about `repoId` before asking whether a scheduler exists, and cannot spell the two-stage `ok && count === 0` predicate wrongly — because none of those primitives is in scope. The rule stops being enforced by review and starts being enforced by the resolver.

**Only tested, or not enforced at all — named in §2's caller column.** The session cannot make a caller put `reap()` above the halt exit, cannot make the daemon call `cooldown` before `release`, and cannot stop a new site choosing `claim` where `serveQueueHead` was meant. Those are ordering and placement, and §7 says what they would cost to close.

---

## 2. THE RULE-BY-SITE MATRIX, AFTER

`◆` = holds **by construction** (unwritable wrongly). `T` = holds, enforced by the PR-5 derived test only. `C` = **still the caller's**. `–` = n/a.

| # | line | site today | new call | R1 fresh handle | R2 refusal retried | R3 busy timeout | R4 identity not id | R5 open-before-closed | R6 housekeeping placement | R7 one fault report | R8 `ok && n===0` | R9 absolute expiry | R10 `askedFor` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 | 1464 | `releaseProvider` | `session.release(lease)` | ◆ | ◆ | ◆ | ◆ | ◆ | – | ◆ | – | – | – |
| S2 | 1514 | `noteRateLimit` | `session.noteCooldown(k,n)` | ◆ | ◆ | ◆ | – | ◆ | – | ◆ | – | ◆ | – |
| — | 1528/1532 | the two drains | `session.drainDeferred()` | ◆ | ◆ | ◆ | ◆ | ◆ | **C** | ◆ | – | ◆ | – |
| S3 | 1574 | `reapProviderLeases` | `session.reap()` | ◆ | – | ◆ | – | ◆ | **C** | ◆ | – | – | – |
| S4 | 1593 | `queuedGuardianRequests` | `session.queued()` | ◆ | – | ◆ | – | ◆ | – | ◆ | – | – | – |
| S5 | 1630 | `cancelQueued` (halt) | `session.withdrawAll()` | ◆ | **C** | ◆ | ◆ | ◆ | **C** | ◆ | – | – | – |
| S6 | 1893 | `openHold` | `session.holdFor({pr})` | ◆ | – | ◆ | – | **C** | – | ◆ | – | – | – |
| S7 | 2148 | `claimProvider` (preflight) | `session.serveQueueHead(…)` | ◆ | – | ◆ | ◆ | ◆ | **C** | ◆ | – | – | ◆ |
| S8 | 2210 | `claimProvider` (canary) | `session.claim({runRef})` | ◆ | – | ◆ | ◆ | ◆ | – | ◆ | – | – | ◆ |
| S9 | 2241 | `bindProviderLease` (canary) | `session.bind(lease,…)` | ◆ | – | ◆ | ◆ | ◆ | – | ◆ | ◆ | – | – |
| S10 | 2397 | `claimProvider` (worker) | `session.claim({runRef})` | ◆ | – | ◆ | ◆ | ◆ | – | ◆ | – | – | ◆ |
| S11 | 2551 | `heartbeatProvider` | `session.heartbeat(lease)` | ◆ | – | ◆ | ◆ | ◆ | – | ◆ | ◆ | – | – |
| S12 | 2773 | `bindProviderLease` (worker) | `session.bind(lease,…)` | ◆ | – | ◆ | ◆ | ◆ | – | ◆ | ◆ | – | – |
| S13 | 3147 | `cancelQueued` (sweep) | `session.sweepQueued(…)` | ◆ | **C** | ◆ | ◆ | ◆ | **C** | ◆ | – | – | ◆ |

**Before → after on the four rows that were live at N−1:**

| rule | before (measured on `a529096`) | after |
|---|---|---|
| R1 fresh handle, never captured | 10 of 13 (S7 reuses `h` from 67 lines earlier; S13 reuses one across the loop; S10 takes *two* separate `claimHub()` calls at :2380 and :2397) | 13 of 13, by construction |
| R2 refusal retried, not dropped | 2 of 4 (release ✓, cooldown ✓, halt-cancel ✗, sweep-cancel ✗) | **2 of 4 still — deliberately.** See below. |
| R5 hub before repoId | 3 of 5 (S7@2080 and S13@3117 put `repoId != null` ahead of the hub read) | 5 of 5, inside `claim()` / inside each method's `#ask()` |
| R7 one fault report | 2 spellings (`hubOr` + inline in `releaseWithRetry`) | 1, inside `#ask()` |

### The cells still depending on the caller — this is where the next #44 happens

**C1 — `R2` at the two cancel verbs (S5 `withdrawAll`, S13 `sweepQueued`).** Today both only log a refusal. A dropped cancel leaves a queued guardian row, and `claimProvider` refuses **every builder admission** while one exists (`provider.mjs:201`) — the same harm #50 records for the release. Retrying them is the right change and it is a **behaviour change**, so it is not in this programme. What the session buys is that the policy now has *one home per verb* instead of being restated per site: changing `withdrawAll` to defer is a five-line change reviewed once, and a fourteenth call site cannot pick a different policy. Honest statement: **the rule is owned, not applied.**

**C2 — `R6`, housekeeping placement relative to the three exits (1639 halt, 1668 GitHub-unreadable, 3302 normal).** Nothing in a session can force a caller to call `reap()` before it returns. PR-5's derived test asserts, over a full tick, that `reap` precedes the first `claim` in the session's op ledger — but that is a **test**, not a structure. And the tempting structural fix — reaping lazily on first `claim()` — must be **rejected**: it re-creates "housekeeping gated on local demand", which is the exact finding round 10 fought (`daemon.mjs:1556-1568`, three gates found in front of the reaper in three consecutive rounds).

**C3 — what to do with `unscheduled` vs `refused`.** The session returns a verdict; dispatching or not is tick policy and must stay visible. A new site that treats `unscheduled` as `refused` silences the guardian; a site that treats `refused` as `unscheduled` dispatches unmetered. Mitigated only by the three-state string (no `if (v.ok)` shortcut) and by PR-5's table.

**C4 — choosing `claim` (marks `askedFor`) vs `serveQueueHead` (does not).** This is a rule that is correctly applied at **2 of 3**, and a test asserting "all claim sites mark" would enforce the bug. The two verbs have different names and different return types, which is the strongest available answer; the choice is still the caller's.

**C5 — the `keep` exemptions passed to `sweepQueued`** (`unreadable` PRs, and `intendedNow` when `skipDispatch`). Underivable inside the session; it needs the PR listing and the canary outcome.

**C6 — `holdFor`'s fail-**closed** reading.** The scheduler fails open on an absent hub; the builder-PR hold read fails **closed** to UNKNOWN (`daemon.mjs:1874-1893`). Two contradictory policies over one accessor. The session returns the three-way answer verbatim and the daemon writes the fail-closed clause, so the contradiction stays in the open. **This is the scope question the founder must settle before PR-4** — see §7.

**C7 — passing `carried` from `ctx`.** A future refactor that hands the session fresh Maps loses every deferred release silently. Mitigated by a constructor throw, which is a runtime check, not a structure.

---

## 3. THE FAIL-OPEN GUARANTEE

The founder's ruling is implemented in **`claim()` steps 2, 3 and 4, in that order**, and nowhere else. It is also, structurally, why `claim()` cannot be reordered by a caller: the caller has no hub with which to ask the questions itself.

```
step 2   !a.hub                      -> { state: "unscheduled", why }     DISPATCH ANYWAY
step 3   repoId == null              -> { state: "refused", "unscopeable" } DO NOT DISPATCH
step 4   ops.claim(...) THREW        -> { state: "unscheduled", why }     DISPATCH ANYWAY
```

Three properties that must hold and are easy to break:

1. **Step 2 is before step 3.** The canary comment at `daemon.mjs:2186-2195` records what happens when it is not: *"Asking for the repository id before asking whether a scheduler exists turned the documented fail-open case into a total outage."* The obvious session implementation ("refuse if I cannot scope the lease") hoists step 3, and `test/guardian-provider-lease.test.mjs:1097-1099` is the assertion that catches it.
2. **`bind()` is the one classified exception and it fails CLOSED.** `provider.mjs` guards no `db` argument — all eight exports throw `TypeError` on `null`. A session that uniformly converts throws to `{state:"unscheduled"}` would make S9/S12 fail open, and an unbound lease sits on the guardian's always-alive pid where the liveness-aware reaper preserves it for ever. `bind()` must have **no** null-hub fail-open branch, and the acceptance table must name it as the exception rather than exempting it silently.
3. **The escalation strings are load-bearing and must not be reworded.** `raise("guardian:hub:unreadable")` from `#ask`'s latch, and `raise("the provider scheduler is unreadable; dispatching unscheduled")` from step 4 and from the reap/queued/sweep catches. The per-site *log* lines differ (canary: `execute: provider unreadable, running the containment canary unscheduled: …`; worker: `  #42: provider unreadable, dispatching unscheduled: …`) — so **the session raises, the caller logs**, using `verdict.why`. General rule: the session logs what is already one message across sites (the hub fault line, the deferral lines, the reap line, the cancel lines); the caller logs what differs per site. This keeps §5's artifacts byte-identical.

### The tests that assert it

Existing, all in `test/guardian-provider-lease.test.mjs` — every one must stay green unchanged:

| line | asserts |
|---|---|
| 152–153 | a claim that **throws** still dispatches (`spawned === 1`) and `esc` matches `/unreadable/` |
| 142–146 | a **refused** claim leaves `r.halted !== true` and releases nothing never held |
| 190–199 | a tick over the **real guest** reports no `hub:unreadable` and still dispatches |
| **1097–1099** | **hub null + repoId null → canary `{ok:true}`, `spawned === 1`** ← pins step 2 before step 3 |
| 159–163 | mirror: repoId null with a **readable** hub → `spawned === 0`, `claims === 0`, esc names the id, plus a `repoId: 7` control |
| 1299–1305 | a `resolveRepoId` that throws raises exactly `guardian:hub:unreadable`, `halted !== true` |
| 1819–1823 | hub unreadable at the **first read only** → the worker still gets a lease |
| 1829–1833 | hub unreadable at **every** read → dispatches anyway, no worker claim |

Added in PR-5, and this is the one #50 asks for: for **every** method the table classifies `fail-open`, drive it against a getter answering `{hub:null, why:"…"}` and assert (a) nothing threw, (b) the documented return shape, (c) **exactly one** `guardian:hub:unreadable` for the whole session however many methods ran, (d) any obligation-bearing method left its identity in `carried`. `bind` is classified `fail-closed` and the loop asserts it **does** throw. An unclassified method name **fails the run**, so a fourteenth verb must be classified rather than silently exempted.

---

## 4. THE PR SEQUENCE

Sizes are grounded: the ten regions a session absorbs measure **697 lines, 289 non-comment, 59% comment** on `a529096`. The comments carry the findings history from 66 review rounds and **must travel with the code** — a move-only change is therefore ~700 out and ~700 in before a line of new test. Big-bang is out on arithmetic. The pattern is **Branch by Abstraction**, not Strangler Fig: there is no boundary to route at, only one in-process function.

### PR-0 — convert the two source-text guards. Tests + one dead line. ~200 changed. **Lands first, because everything after it moves code past them.**

I proved both guards with the four-check stub loop, in an isolated copy of `a529096` on node v24.17.0:

| stub | result |
|---|---|
| control, unmodified | `all green` |
| **A.** add `src/build/schedsession.mjs` = `import { openHub } from "./hubdb.mjs"; export const privilegedHandle = p => openHub(p);`, import it into daemon.mjs and reference it | **`PASS  and the guardian's own module cannot reach the privileged opener at all` / `all green`.** `grep -c openHub src/daemon.mjs` = 0. The daemon reaches the privileged opener transitively; the guard says nothing. |
| **B1.** inject `resolveRepoId(h, ctx.project)` — the daemon's own handle idiom, `const h =` appears at 1463/1524/1579/2005/2473 | **`PASS  the daemon never hands its hub connection to the repository-id resolver` / `all green`.** Not caught. |
| **B2.** positive control, `resolveRepoId(hub, …)` | `FAIL … / failed=1` — the guard does bite, on exactly one spelling |
| **C.** a *comment* containing the word `openHub` | `FAIL … / failed=1` — the guard forbids documenting in daemon.mjs why the opener is not used there |
| restore | byte-identical to `a529096` |

So both guards are **defeated by exactly the move #50 requires**, and they will go on reporting success while the property they name is removed. Converting them **after** the move means the conversion PR has nothing to demonstrate.

**I also tested and am rejecting the module-graph fitness function.** I built the loader-derived graph with `module.registerHooks` on v24.17.0 (62 edges, 35 files, positive control `src/provider.mjs` reachable) and measured: **`src/build/hubdb.mjs` is *already* transitively reachable from `src/daemon.mjs` today**, via `build/locks.mjs`, `build/repoid.mjs`, `src/backup.mjs`, `build/replay.mjs`. A "no edge to the privileged opener" assertion is red at baseline, and an allowlist to make it green is itself a rule at N sites. (A hand-written text walker is worse: mine silently missed 5 of 62 edges because daemon.mjs's `provider.mjs` import spans two lines — the exact vacuity being replaced.)

**What replaces them — behavioural, rename-proof, boundary-proof:**

*Replacing `!/\bopenHub\b/` (lease:1932).* Assert the capability of the connection the guardian actually gets. Measured against a real migrated hub through the production accessor `hubAccess(path)`:

```js
const a = hubAccess(hubPath)();
check(JSON.stringify(Object.keys(a.hub)) === '["prepare","exec","close"]',
  "the guardian's hub handle is the guest facade and has no other method", …);
for (const m of ["createSession","deserialize","applyChangeset","loadExtension","serialize","setAuthorizer"])
  check(a.hub[m] === undefined, `and it cannot ${m}`, …);
// CONTROL, so the assertion is not passing over an empty object:
let why = null; try { a.hub.prepare("SELECT repo_id FROM task LIMIT 1"); } catch (e) { why = e.message; }
check(/prohibited|not authorized/i.test(why ?? ""), "control: it REFUSES the builder's work table", String(why));
// and: a session built over THIS getter still claims, releases and reaps.
```

Measured today: keys are exactly `["prepare","exec","close"]`; all six privileged methods `undefined`; `task` → `access to task.repo_id is prohibited`; `BEGIN DEFERRED` → refused. **No rename and no relocation can satisfy this while the property is broken**, because it asserts over the object, not over any file's bytes. Stub A passes the old guard and fails this one.

*Replacing `!/resolveRepoId\s*\(\s*(ctx\.)?hub/` (lease:190).* First, **delete the dead import** — `src/daemon.mjs:32` imports `resolveRepoId` and `grep -cE '(^|[^.[:alnum:]_])resolveRepoId' src/daemon.mjs` = **1**, the import line itself. The guard currently protects a call that does not exist. Then assert behaviourally: inject `ctx.resolveRepoId` as a recorder and check it was **invoked with zero arguments**, alongside the existing `task`-refusal control at lease:170-179. That is about the call, not the spelling, and it survives the resolver moving anywhere.

PR-0 proves itself by re-running stubs A, B1 and C against the **new** assertions and showing each goes red.

### PR-1 — the characterisation harness. Tests only. ~300 changed. Nothing in `src/` moves.

Ten approved scenarios, artifacts committed. Full detail in §5. Proves: the current tick has a recorded, reproducible signature.

### PR-2 — the one deliberate behaviour change. ~30 changed in `src/`, plus one artifact diff.

Delete the stale-snapshot gate and the snapshot it exists for:

```
daemon.mjs:1382   const hub = hubOr(() => null);          <- DELETE. Its ONLY consumer is line 1532.
daemon.mjs:1532   if (hub && pendingReleases.size) {      -> if (pendingReleases.size) {
```

**I reproduced the defect myself** against the real `tick()`, with a getter that faults on the tick's *first* read only:

```
CONTROL: {"releasedWith":["r1","o/r#42:FIX_CI"],"notedWith":["claude"],"hubReads":8,
          "stillPendingReleases":[],"stillPendingCooldowns":[]}
PROBE:   {"releasedWith":["o/r#42:FIX_CI"],"notedWith":["claude"],"hubReads":7,
          "stillPendingReleases":["r1"],"stillPendingCooldowns":[]}
```

The carried release `r1` is stranded for the whole tick while the cooldown `c1` is recorded against the **same** hub and the dispatch-path release succeeds — so the hub was demonstrably usable for releases throughout. `releaseWithRetry` re-asks with `hubNow()` at :1438 and its own comment says *"FRESH, not the tick's opening snapshot"*; the gate four lines from its sibling consults the snapshot. There is an `await ctx.resolveRepoId()` at :1415 between the snapshot and the gate, so the window is real, not theoretical. A pre-bind lease sits on the guardian's always-alive pid, so the liveness-aware reaper preserves it and the slot is held against the global limit for the full tick.

Land it **before** the move so PR-3 and PR-4 can claim byte-identical artifacts. Proves: exactly one artifact field changes, in exactly the way the PR says.

### PR-3 — combine in place. ~600 changed. No line leaves `daemon.mjs`.

`hubNow`, `hubOr`, `claimHub`, `hubFaultSaid`, `releaseWithRetry`, `noteCooldownWithRetry`, `readQueuedNow`, `haltStop`'s cancel loop, the reaper block and the sweep are already a class that has not been written down — they close over the identical set (`ctx`, `logPath`, `raise`, `repoId`, `isSameProcess`, `nwo`). Turn them into `const session = hubSession({...})` **still inside `daemon.mjs`**, and rewrite the 13 sites. Same closures, same captures, zero relocation.

**Two behaviour changes are inseparable from the structure and must be declared here, not folded in:**

- The worker path's **two** `claimHub()` calls (guard at :2380, operation at :2397) collapse to **one**. The site's own comment demands it: *"the guard and the operation must ask the same question at the same moment."* The tick's total getter reads therefore drop by one per dispatched worker. `lease:1819` asserts only `reads > 1` and stays green. Keep `hubReads` as its **own artifact field** so this shows as a one-field diff.
- In the rare race where another process replaced the hub between those two reads, today's outcome is `raise("the provider scheduler is unreadable; dispatching unscheduled")` + dispatch; after, it is `raise("guardian:hub:unreadable")` + dispatch. Both fail open. State it.

Everything else: artifacts byte-identical. That is the review.

### PR-4 — move to `src/build/hubsession.mjs`. ~750 changed, almost all moved text.

The reviewer verifies with `diff` of the moved block. `ctx` surface unchanged, all 37 fixtures unchanged, artifacts byte-identical (including `hubReads`).

Constraint 4 is satisfied: the session holds **no SQL** — it calls `provider.mjs`, which holds none either (`test/provider-scheduler.test.mjs:860-874` asserts zero SQL keywords in `provider.mjs` **with a positive control** that the same scan finds SQL in `providerdb.mjs`; that guard is the best-built one in the repo and is the model PR-0 copies). Living under `src/build/` also keeps the door open if the session ever needs SQL.

### PR-5 — the acceptance test, `Object.freeze`, and the wrong-control session. ~350, tests only.

Detail in §3 and below. Proves: the enumeration is derived and cannot report itself complete.

### Not in this programme, and why

- **A `mintToken` injection seam** (suggested elsewhere as a prerequisite for a DB golden master). Rejected: §5 redacts `token`, `id` and the time columns instead, which is cheaper and avoids a production change made for test convenience.
- **Collapsing the 13 scheduler `ctx.*` keys to `ctx.session`.** Rejected inside the move: it rewrites every fixture in the same PR that moves the code, destroying the byte-identical proof. Follow-on.
- **`using` / `Symbol.dispose` anywhere in `bin/reeve`'s graph.** See §1. The one place RAII genuinely fits is `probeRead` in `hubaccess.mjs` (`let q = null` … `finally { try { q?.close(); } catch {} }`, and `DatabaseSync[Symbol.dispose]` is a documented no-op on an already-closed handle where `close()` throws) — unrelated to #50, and it drags `using` into the graph. Leave it.

---

## 5. THE CHARACTERISATION STRATEGY

**Do not build a new vehicle.** `test/guardian-provider-lease.test.mjs:62-108` already constructs a 40-key `ctx` and returns `{ r, claims, releases, spawned, ctx, esc, log }` — a recorded call log at the seam, the escalation set and the full log file. That is the approval artifact minus serialisation. Its default hub is a **real guest connection over a real hub file**, because the first version passed a `{}` marker and *"a fixture that cannot exhibit the defect reports the code healthy."* Every new scenario inherits that default.

### The technique, concretely

`test/characterise-tick.test.mjs` + `test/fixtures/tick-approved/<scenario>.txt`. For each scenario: build the ctx, run `tick`, serialise, compare to the approved file byte-for-byte; `REEVE_APPROVE=1 node test/characterise-tick.test.mjs` rewrites them.

**Serialised artifact, in this order:**

```
1. SEAM LOG   every ctx.* scheduler seam call, in order, as `op\targs-json`, with
              pid, lstart, token, id and every *_at field replaced by <redacted>.
              Recorded by wrapping the seams in the fixture, not in src/.
2. ESCALATIONS  [...r.escalations.keys()].sort().join("\n")   -- keys only, not counts
3. LOG FILE   the tick's log, with ISO timestamps -> <ts>, tmpdir paths -> <tmp>,
              pid -> <pid>. Line ORDER is the signal.
4. RESULT     JSON.stringify({ halted, unreadable, decisions: decisions.map(d => d.action) })
5. CARRIED    [...ctx.providerRetry.keys()].sort(), [...ctx.cooldownRetry.keys()].sort()
6. HUBREADS   the getter call count -- ITS OWN FIELD, because PR-3 changes it by design
```

Fields 1–5 must be byte-identical across PR-3 and PR-4. Field 6 is allowed to change once, in PR-3, by exactly one per dispatched worker.

**Ten scenarios**, each already reachable through the existing fixture seams:

| # | scenario | how driven |
|---|---|---|
| 1 | happy path | `run()` defaults |
| 2 | `at-limit` refusal | `claim: () => ({ok:false, reason:"at-limit"})` |
| 3 | claim **throws** — the fail-open path | `claim: () => { throw … }` |
| 4 | hub unreadable at **every** read | `hubGetter: () => ({hub:null, why:"…"})` |
| 5 | hub unreadable at the **first** read only | `hubGetter` with a counter — the PR-2 witness |
| 6 | hub genuinely **absent** | `hub: null` |
| 7 | **halted** — exit 1639 | `haltMarker` present, with queued rows |
| 8 | **GitHub unreadable** — exit 1668 | `openPrs: () => null`, with queued rows |
| 9 | `repoId: null` — fail closed | `run({repoId:null})` |
| 10 | `maintenance` refusals on release **and** cooldown, with `providerRetry`/`cooldownRetry` **pre-seeded**, so the carried-obligation path is characterised at all | seams return `{ok:false, reason:"maintenance"}` |

Scenario 5 is the one PR-2 changes and 10 is the one it changes *within*. Scenarios 7 and 8 are the two early exits — they must be present or the move can silently reorder housekeeping past an exit and every artifact stays green.

**Two real-provider scenarios** (1 and 2) additionally dump the database: `SELECT * FROM provider_lease` and `provider_state` ordered by `(owner, repo_id, run_ref)`, with `id`, `token`, `pid`, `lstart`, `requested_at`, `started_at`, `heartbeat_at`, `expires_at`, `last_429_at`, `cooldown_until` redacted. Redaction is required because `newToken()` at `providerdb.mjs:101` is `Date.now().toString(36) + Math.random()…` with no injection point — and redaction is strictly cheaper than adding one. (A SQLite *changeset* golden master is not an option and I checked why: `createSession` is absent from the guest facade, and sessions record only their own connection's writes; and a changeset is a **net** diff, so a claim followed by its release nets to zero bytes — blind to exactly the orderings that matter.)

**Base green-set, per step.** Before the first commit, record the 95 test files and their pass/fail into a file and diff against it per step, in a **git worktree**. At ~25 s for the lease suite and ~5.5 min for the full serial loop, a full differential run per *step* is affordable — six steps is 33 minutes of machine time against nine review rounds. `for f in test/*.test.mjs` is serial; `xargs -P` over the same loop is a two-word change and no new dependency.

**One trap that will read as success.** The lease suite has **127 `check()` sites, 137 assertions (five blocks loop over tables), 36 top-level blocks and zero `try` around them**. A `TypeError` from a session that touches the handle dies at the first of the 14 fixtures passing a marker `hub: () => ({ hub: {}, why: null })`, kills the remaining ~88 checks and prints **zero `FAIL` lines** — `grep -c '^FAIL'` returns 0 on a crashed run. **Judge every run on exit code and on the `all green` tail, never on a FAIL count.** The design constraint that follows: **the session must never introspect the handle** — no `typeof h.prepare`, no version check, no statement preparation. It receives `a.hub` and passes it through.

---

## 6. WHAT TO DO ABOUT THE NEGATIVE SOURCE REGEXES

I enumerated every source-text guard over `src/daemon.mjs` or `bin/reeve`: 16 `readFileSync` sites across 14 test files. Nine are negative assertions. Verdict for each:

| # | guard | verdict |
|---|---|---|
| 1 | `lease:190` `!/resolveRepoId\s*\(\s*(ctx\.)?hub/` | **REPLACE.** Proven vacuous two ways: the import at daemon.mjs:32 is dead (1 occurrence, the import line), so there is nothing to catch; and `resolveRepoId(h, …)` — the daemon's own idiom — walks straight through it (stub B1, `all green`). Replace with: `ctx.resolveRepoId` recorded and asserted **invoked with zero arguments**, plus the existing `task`-refusal control at lease:170-179. Delete the dead import in the same PR. |
| 2 | `lease:1932` `!/\bopenHub\b/` | **REPLACE.** Proven defeated by one indirection module (stub A, `all green`), and it also fails on a *comment* (stub C), so it forbids documenting the rule where it applies. Replace with the capability assertion of §4: `Object.keys(hub)` is exactly `["prepare","exec","close"]`, the six privileged methods are `undefined`, and the control that the connection refuses `task`. `\bopenHub\b` correctly does **not** match `openHubAsGuest` — that half of the guard was right and the behavioural version preserves it by construction. |
| 3 | `fold-before-evaluate:115` `!/foldPrecedesEvaluation:\s*false/` | **KEEP.** Properly anchored: `:113` positively requires `foldPrecedesEvaluation: true` in the same file, so the negative cannot be vacuous while the anchor is absent. Constraint on the refactor: that literal keyword-value must stay in `daemon.mjs` and not migrate into a session/options object. Out of the session's blast radius. |
| 4 | `review-shadow:173` `!/lastIngestIncomplete/` | **KEEP, add a counter-control.** A dead-name check with no positive anchor: it will pass silently if the whole area ever leaves `daemon.mjs`. One line fixes it — assert the replacement name **is** present. Out of scope for #50; file it. |
| 5 | `worker-report:124` `!/recordFixAttempt\([\s\S]{0,140}?statedBlocker/` | **KEEP, flagged.** A 140-char proximity regex. Any reformat that separates the two identifiers satisfies it without preserving *"never read the worker's report at dispatch"*. Not touched by this refactor; note it in the PR so nobody reformats that region while moving neighbours. |
| 6 | `review-request-effect:406-413` zero `escalations.set(` except `const raise =` | **KEEP as is.** Correctly anchored (`:412` positively requires `const raise = (cause, n = 1) =>` in `daemon.mjs`). **The session must satisfy it by construction**: it takes `raise` as an injected callback and never contains the string `escalations.set(`. Verified compatible. |
| 7 | `lease:1868-1871` zero `new DatabaseSync(… timeout: <digits>)` in `bin/reeve` | **KEEP.** `HUB_BUSY_TIMEOUT_MS` is the one #50 rule already structural — `grep -c HUB_BUSY_TIMEOUT_MS src/daemon.mjs` = 0 with 17 hits in `src/build/` and `test/`. The session opens no connections, so this stays true trivially and correctly. |
| 8 | `repo-id-lookup:125` slice-bounded scan of `bin/reeve` | **KEEP, flagged.** Its anchors are slice boundaries (`const repoIdOnce` … `const registryProjects`); `indexOf` returns −1 on a rename and `slice(-1)` still yields a string, so the test greens on a garbage slice. Add a `check(a >= 0 && b > a)` control. One line, out of #50's scope, file it. |
| 9 | `hub-backup-restore:2931-2934` no "keep N prunes" prescription | **KEEP.** Carries a positive control at `:2928` (every file must match `/free space/i`). Outside the blast radius. |

Plus one non-negative constraint the move must respect: **`selfaudit.test.mjs:289-312`** pins order by **raw byte offset** — `indexOf("if (ctx.backupRoot !== false) {")` **<** `indexOf("if (ctx.selfAudit !== false) {")` **<** `indexOf("const { fresh, cleared } = announce({ covered:")`, resolving today to **3187 < 3248 < 3285**. All three sit *after* the post-loop sweep at 3095-3157, so the move does not reorder them; but it pins **layout**, so extracting the backup/audit/announce tail into helpers would break it even with the runtime order unchanged. It has a `Number.isFinite` control, so a rename fails loudly. And **`worker-contract:82`** requires `bindRun(db` within 200 chars of `onSpawn: ({ pid, lstart }) => {`; measured gap today is **54 chars**, and the session's `bind()` sits *below* `bindRun`. Headroom is fine — do not insert a comment block there.

---

## 7. WHAT THIS DESIGN DOES NOT SOLVE

**1. Ordering between verbs is still tick policy, and always will be.** Seven orderings are real and every one was learned by a review round: no nesting (`providerTx` is not re-entrant — a nested claim throws `cannot start a transaction within a transaction`); reap before claim, ungated; claim before any durable side effect (`startRun` spends a fixer's attempt); bind before the child runs; cooldown before release; serve the queue head before asking for anything new; cancel from what was asked, after the loop. The session makes **no nesting, bind-is-a-gate and cooldown-before-release** structural. The other four are placement in `tick`, and a session cannot own them without owning `tick`. *Cost to close:* an ordering assertion over the session's op ledger in PR-5 gets you a **test**, ~60 lines. Making it structural would require the session to drive the tick, which is a different and much larger issue.

**2. `tick()` is still ~1,600 lines after the move.** 697 lines leave; 2,281 − 697 ≈ 1,584 remain, and the shape is 13% larger than when #50 was filed. #50 closes the *hub/scheduler* class. The verdict, evaluation, worker-preparation and backup/audit/announce regions are untouched and carry their own N-site rules. *Cost:* separate lanes, same method.

**3. The dropped-cancel rule (`R2` at S5 and S13) is owned but not applied.** Preserving today's log-only behaviour is deliberate under constraint 2. A dropped cancel leaves a queued guardian row and `queuedGuardianCount > 0` blocks **every** builder admission. *Cost to fix:* ~20 lines plus two artifact diffs, once the harness exists — a good first PR *after* PR-4, precisely because the harness makes it provable.

**4. A live, un-halted guardian in a prolonged GitHub outage holds its queued rows indefinitely.** `tick` returns at 1668 every pass; `reapProviderLeases` removes rows only when expiry **and** non-liveness both hold and this guardian's pid is alive; `haltStop` clears them only on a halt; `sweepQueued` only on a successful listing. One process blocking another with no participant able to break it — the harm the round-10 comment described, reached by a different mechanism. The design *enables* the fix (`withdrawAll()` works from identity alone and needs no PR listing, so the 1668 path can call it) but does not apply it, because doing so is a behaviour change. *Cost:* ~10 lines plus scenario 8's artifact diff. **I would not fold this into any PR above** — it deserves its own founder ruling, exactly as the round-10 comment asked, on whether a guardian that cannot list PRs should withdraw its queue positions.

**5. `holdFor`'s scope is a founder decision, and it must be made before PR-4.** A scheduler-only session leaves `hubNow` alive in `tick` for the builder-PR hold at :1874-1893, which means a handle stays in scope and a future site can still capture one — the class is narrowed, not closed, and "narrowed" is what produced the N−1 pattern. Three options: (a) session owns the hold read too — closes the class, weakens the name; (b) a second hold-only accessor — cheapest, most likely to reproduce the shape; (c) name the module the guardian's **hub session**, owning every hub touch, with scheduling as one responsibility. **I recommend (c)**, because only it lets §4's capability assertion be stated in its strongest form with no exception list — and an exception list is a rule at N sites. The counter-argument is real and should be heard: the scheduler fails open and the hold fails closed, and putting two contradictory policies behind one accessor is "two facts that look alike are not one fact." My answer is that the *accessor* is genuinely one thing and the *policies* are two separately named methods with `holdFor` returning the three-way answer verbatim, so the contradiction stays visible in `daemon.mjs`. That is colocation, not collapse. **It is a naming-and-scope question, and #50's own record shows what happens when one is settled mid-round.**

**6. `releaseProvider`'s documented escape hatch throws for exactly the caller it was written for.** `releaseProvider(db, {owner, repoId, runRef, force: true})` with `id == null` falls through both `no-identity` guards (`provider.mjs:249-254`), fails `(force && id != null)` at :255, and reaches `deleteLease` with `token: null`, where `identityWhere` throws *"a fenced provider mutation requires the claim's token; refusing the weaker predicate"* (`providerdb.mjs:243-248`). `guarded` does not catch it, and `releaseWithRetry` retries a throw for ever with a `raise()` every tick. The daemon never passes `force` today; **S3 builder dispatch is the second caller and is exactly who would.** The session's minted-`Lease` design means the guardian can never lose the identity, so it never needs `force` — but that is avoidance, not a fix. *Cost:* a 3-line guard in `releaseProvider` plus a test, in the provider lane, not this one.

**7. `heartbeatProvider` fires `isAlive` once per expired lease inside `BEGIN IMMEDIATE`, and `isSameProcess → readStart` is `execFileSync("ps", …)`.** Twenty expired rows is real exclusive write-lock time against a shared 10-second `HUB_BUSY_TIMEOUT_MS`. Unchanged by this design and worth knowing before the builder becomes a second reaper.

**Not a problem, contrary to the inherited note:** re-asking the getter per operation is cheap in absolute terms. I measured `hubAccess(path)()` at **0.395 ms/call** against `statSync` at **0.0014 ms** — a 280× *ratio*, but 0.4 ms × ~16 sites is ~6 ms per tick against a 90-second interval. The getter also returns the **same handle object** while the file identity is unchanged (verified: `getter().hub === getter().hub` is `true`), so there is no reconnect cost either. Do not split `hubAccess`'s identity check from its schema probe as an optimisation; it would trade a measured non-problem for a new seam.
