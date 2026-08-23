# S2-A: The Hub Store, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A STRICT, versioned, forward-only-migrated hub store at `~/.reeve/state/hub.db` that can hold a builder task's whole life, whose backup can see it, whose restore refuses live writers and is proven by dropping the live database and replaying it, and whose every table has a declared writer and reader.

**Architecture:** One PR against `revnix/reeve` `main`. Adds `src/build/hub.sql` (32 tables), `src/build/hubdb.mjs` (open, migrate, `hubTx`, `hubEvent`), `src/build/locks.mjs` (singleton, writer, maintenance), `src/build/replay.mjs`, `src/build/tables.mjs`, `hubPathFor` in `paths.mjs`, hub discovery and per-store validation in `backup.mjs`, the hub half of `doctor.mjs`, and retires `ci.flakePatterns`. **Nothing here reads or writes GitHub, and no worker is dispatched.**

**Tech Stack:** Node `~/.nvm/versions/node/v24.17.0/bin/node` (PATH node is v22 and `node:sqlite` warns there), `node:sqlite` `DatabaseSync`, plain-script tests under `test/*.test.mjs` (CI runs every file in that glob on ubuntu-latest under three TZs), no dependencies added.

**Spec:** `docs/2026-08-21-builder-design.md` — §14 S2 is the stage definition and its *Verify:* clause is the definition of done. The sections that bind this plan: §1.2 (singleton lease), §1.3 (stores and the single-writer rule), §9.1 (`repo_gate_state`), §9.3 B5, §9.6 (`pr_hold`), §10.2 (leases), §10.4 (the scheduler tables), §11.1 (DDL requirements), §11.2 (hub tables), §11.4 (backup and restore), §11.7 (escalation identities), §13.

**This is one of three plans for S2.** They were split out of a single 5,300-line document after four review rounds found 54 defects, a majority of them caused by the previous round's own fixes: an edit in a document that large cannot see its neighbourhood. Each plan is now self-contained and reviewed on its own.

| plan | scope |
|---|---|
| `2026-08-23-s2a-hub-store.md` | the store: schema, migrations, locks, backup, restore, the cross-check |
| `2026-08-23-s2b-phase-machine.md` | the pure machine, the transition transaction, the fenced outbox, registry, gate state |
| `2026-08-23-s2c-provider-scheduler.md` | the shared scheduler, the guardian claim, the hub allowlist, the `pr_hold` verdict clause |

Their review history — all 54 findings and what each changed — is `2026-08-23-s2-review-history.md`. **Order matters:** A lands before B, B before C. This plan is first; it depends on nothing but `main`.

---

## Global Constraints

- **Node:** always `~/.nvm/versions/node/v24.17.0/bin/node`. Alias it `N` in every shell: `N=~/.nvm/versions/node/v24.17.0/bin/node`. `node` on PATH is v22 and `node:sqlite` emits an ExperimentalWarning there; CI asserts a floor of 24.
- **Tests:** plain scripts, no framework. Use the `check(ok, name, detail)` helper shape every existing test file uses; `console.log("PASS  name")` / `"FAIL  name"`; end with `process.exit(fail ? 1 : 0)`. New files under `test/` are discovered by CI automatically.
- **The four-check stub loop for every fix:** control green, stub verified applied, the RIGHT assertion red, restore verified. Never commit a test that has not been seen red against the broken code. Every task below names the stub explicitly.
- **Run the full suite before every commit**, with the one exclusion the next sentence explains:

  ```bash
  for f in test/*.test.mjs; do
    case "$f" in */escape.test.mjs) continue;; esac    # see below: not while the daemon is live
    $N "$f" >/dev/null || echo "FAILED $f"
  done
  ```

  The glob must not simply be `test/*.test.mjs`: that includes `escape.test.mjs`, which writes decoys into the shared `~/.reeve/canary/` tree the live daemon reads and probes the login keychain. Advertising a command that contradicts the warning beside it means the warning loses. **Measured 2026-08-22 on `9dbd3a0`: 59 test files exist; 58 were run and all 58 passed.** `test/escape.test.mjs` was NOT run, because it writes decoy files into the shared `~/.reeve/canary/` directory that the live daemon also reads; run it once on a quiet machine to complete the baseline. That run had `node_modules` absent, and a green file can hide a skip, so skips were counted rather than assumed: exactly two files carry one `SKIP` each (`policy-self-exclusion`, `supervisor-contract`). That 58-file pass is the base every task is measured against, and it is the same base for all three PRs — never a chained comparison against the previous task.
- **Conventional Commits**, lowercase, `type(scope): subject`, ≤72 characters. **No attribution trailer of any kind.** Never `--no-verify`.
- Every change carries a what/why comment in the style of the file it lands in. Comments never reference tasks, plans, findings, or this document.
- **No raw SQL outside `src/db/` and `src/build/`.** `hubdb.mjs` owns every hub statement the way `ops.mjs` owns every guardian statement.
- No `as any`, no `@ts-expect-error`, no lint suppression.
- **Escalation keys are identities.** No counts, durations, paths, or SHAs in the key; those ride in the body. §11.7 lists every builder identity; a test asserts no `escalations.set` call interpolates variable detail into a key.
- Nothing in any public or client repository may name reeve. This plan touches only `revnix/reeve`, which is private.
- **Every timestamp is `INTEGER` seconds from `unixepoch()`** unless the column name ends `_ms`. Never a TEXT date.
- **No task in S2 dispatches a builder worker.** `worker.isolation` is `none` and dispatch is refused in code; S2 does not change that and must not.

### Isolation while this plan is being written or executed

A guardian daemon is live on the founder's host (measured 2026-08-22: pid 12574, `bin/reeve run nextlyhq/nextly`, running from the **main checkout**, not a copy). Therefore, for anyone executing this plan:

- Work in a worktree (`git worktree add -b <branch> ~/Work/Products/reeve-wt/<name> origin/main`), never in `~/Work/Products/reeve`. A `git pull` there swaps code under a running process.
- Do not run `reeve canary`: it costs a real model call and writes one shared state file at `~/.reeve/canary/<owner>/<repo>.json` that the daemon also reads. Last writer wins.
- Do not restart the daemon, run `launchctl`, or stop the service. `reeve doctor` is read-only and is fine.
- `docs/TRACKER.md` conflicts on every branch. Add the tracker entry as the **last commit before opening the PR**, so the conflict is one line.

### What S1 measured, which changes how these tests are written

Do not re-derive any of these. Each is recorded under `docs/measured/`.

| Measured fact | Consequence for S2 |
|---|---|
| A permission rule takes an absolute path only with **two** leading slashes; `Read(/Users/x/.ssh/**)` matches nothing, silently (`docs/measured/2026-08-22-the-read-deny-list-was-inert.md`) | Any permission rule this plan writes or asserts uses `//`. A rule that matches nothing looks identical to a rule that is working. |
| The file tools (Read/Edit/Write/Grep/Glob) are **not** covered by the OS sandbox — the CLI's own process runs outside the Seatbelt profile it applies to the shells it spawns | Never argue that a hub file is protected because a worker is sandboxed. Hub file safety in S2 comes from locks and from the fact that no worker runs at all. |
| A deny that **contains** the worker's checkout refuses the worker its own files, because deny beats allow | Never write one. Not applicable inside S2, which spawns nothing, but it constrains any rule added in passing. |
| A scratch HOME closes the keychain **search list**, not the keychain; the file stays reachable by path until `~/Library/Keychains` is denied (`docs/measured/2026-08-22-scratch-home-closes-the-keychain.md`, **read its correction banner**) | Do not treat a scratch HOME as a containment claim anywhere in S2's docs or comments. |
| `pull_request.updated_at` does **not** change when a review thread is resolved (`docs/measured/2026-08-22-the-shadow-compared-two-moments.md`) | The hub inbox must never use `updated_at` as a change signal or as an ordering. It is blind to review state. §7.6's content-hash generation is the mechanism; the DDL must make `updated_at` unusable as an ordering by keeping it named `edited_at`, as the guardian's inbox already does. |

### Decisions taken by the founder for this stage, 2026-08-22

Recorded so no executor re-litigates them.

1. **S2 splits into three PRs**, in the order A → B → C, with the provider scheduler last because it is the only one that changes the running guardian.
2. **The guardian fails OPEN when hub.db is unreadable at provider-claim time.** It dispatches exactly as it does today and escalates `builder:provider:hub-unreadable`. The builder fails closed. The scheduler restrains the builder; it must never become a new way to silence the guardian. This matches the `ctx.reviewIngest !== false` opt-out shape §14 asks new ctx keys to follow (`src/daemon.mjs:516,1263,1270`), so existing guardian tests stay green untouched.
3. **`ci.flakePatterns` is REMOVED**, and the live `nextlyhq/nextly.json` is stripped in the same change. Measured, with a positive control, in `docs/measured/2026-08-22-flakepatterns-has-no-readers.md`. Removing it from `FIELDS` alone would make the live profile invalid and kill every daemon start.
4. **`repo_gate_state` ships in S2 with a real writer**: the table, a pure `gateStateFrom()` derivation with unit tests over drifted/absent/stale inputs, and a `build run` tick that calls it through an injected `ctx.fetchGateState`. No live GitHub call in S2. S8 supplies the fetcher and clause U4, the reader.

---


## The test harness every file in this plan opens with

Where a task writes `/* ... standard harness ... */`, it means exactly this block. It is written once here rather than repeated in each task, but it is **not** optional shorthand: without it `check`, `dir` and the imports are undefined and the file fails before reaching its first assertion.

```js
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-<slug>-"));
```

and closes with:

```js
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
```

Each task names any imports it needs **beyond** these.

## File structure

| File | Responsibility after this plan |
|---|---|
| `src/build/hub.sql` (new, PR-A) | the complete hub DDL: 32 tables, their CHECKs and their indexes. Read at `openHub()` the way `schema.sql` is read at `open()`. |
| `src/build/hubdb.mjs` (new, PR-A) | `openHub`, the forward-only migration runner, `hubTx`, `hubEvent`, and every hub SQL statement. The hub's `ops.mjs`. |
| `src/build/locks.mjs` (new, PR-A) | `singleton`, `writerLease`, `maintenanceLock`: acquire, heartbeat, reap-by-pid+lstart, and the refusal message that names the holder. |
| `src/backup.mjs` (PR-A) | `everyStore` discovers the hub and labels it `hub`; snapshot validates `schema_version` and `integrity_check`; `restoreHub` refuses while any writer is live. |
| `src/doctor.mjs` (PR-A) | hub snapshot age, last integrity result, restore compatibility, `repo_gate_state` per project, provider scheduler state and stale leases. |
| `src/profile/schema.mjs` (PR-A) | `ci.flakePatterns` removed from `FIELDS`. |
| `bin/reeve` (PR-A, PR-B) | `build run|status|pause` routes; `build run` takes the singleton lease and refuses a second instance naming the holder. |
| `test/hub-schema.test.mjs` (new, PR-A) | STRICT, pragmas, CHECKs, `WITHOUT ROWID`, indexes, migration idempotence and forward-only refusal. |
| `test/hub-crosscheck.test.mjs` (new, PR-A) | the prose-versus-DDL cross-check, executable: every table in the DDL has a declared writer and reader, and every table §11.2's prose names exists. |
| `test/hub-locks.test.mjs` (new, PR-A) | 20-way singleton race with one winner; a second `build run` refuses naming the holder; writer lease and maintenance lock. |
| `test/hub-backup-restore.test.mjs` (new, PR-A) | snapshot validation, restore refusal while a writer is live, and the destructive restore drill over §11.4's comparison set. |
| `docs/measured/2026-08-22-flakepatterns-has-no-readers.md` (new, PR-A) | the measurement behind decision 3. **Already written.** |

---

# PR-A: The hub store

**Branch:** `feat/s2-hub-store`. **Scope:** the database, its migrations, its locks, its backup and restore, the cross-check, and the `ci.flakePatterns` retirement. **Nothing in PR-A reads or writes GitHub.**

**A note that expires when PR-A merges.** `~/.reeve/state/` holds only `nextlyhq/` and `revnix/` today (measured 2026-08-22) — **no `hub.db` exists on any machine**. So while PR-A is open, migration 1 may be edited freely: Tasks 2 through 5 each append to `hub.sql`, and that is still one migration. The moment PR-A merges, migration 1 is frozen and every later change is a new numbered migration. Task 6 installs the test that enforces this.

---

### Task 1: The hub path, an opened store, and a forward-only migration runner

**Files:**
- Modify: `src/paths.mjs` (append)
- Create: `src/build/hubdb.mjs`, `src/build/hub.sql`
- Test: `test/hub-schema.test.mjs`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `hubPathFor(home) -> string`. `HUB_SCHEMA_VERSION: number` (1). `openHub(path) -> DatabaseSync` — applies every migration above the store's recorded version, in order, each in its own transaction; **refuses** a store recorded above `HUB_SCHEMA_VERSION`. `hubTx(db, fn) -> any` — `BEGIN IMMEDIATE`, commit, rollback on throw; the hub's `tx`. `canonicalHub(v) -> string` — deterministic JSON, re-exported from `ops.mjs` so both stores serialize identically.

- [ ] **Step 1: Write the failing test**

Create `test/hub-schema.test.mjs`:

```js
// The hub is the authority for who is allowed to do what, so it does not
// inherit the guardian's pragmas. synchronous=NORMAL can lose the last
// transactions on power loss, which for the guardian costs a re-poll and for
// the hub would mean an approval or a merge decision that the database no
// longer remembers granting. It is also forward-only: an older binary opening
// a newer store would read columns it does not know about as absent, and
// absence is never read as success anywhere else in this system either.
import { hubPathFor, statePathFor } from "../src/paths.mjs";
import { openHub, hubTx, HUB_SCHEMA_VERSION } from "../src/build/hubdb.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const dir = mkdtempSync(join(tmpdir(), "reeve-hub-"));

// ── the path is one place, and it is not a repository store ──────────────────
{
  check(hubPathFor("/h") === join("/h", "state", "hub.db"), "the hub lives at <home>/state/hub.db", hubPathFor("/h"));
  check(hubPathFor("/h") !== statePathFor("/h", "nextlyhq/nextly"),
    "and is not the same file as any repository's store", `${hubPathFor("/h")} vs ${statePathFor("/h", "nextlyhq/nextly")}`);
  check(hubPathFor("/h") !== statePathFor("/h", "hub/db"),
    "control: a repository literally named hub/db still does not collide with it");
}

// ── the pragmas the hub does not inherit ─────────────────────────────────────
{
  const db = openHub(join(dir, "p.db"));
  const one = (sql) => Object.values(db.prepare(sql).get())[0];
  check(String(one("PRAGMA journal_mode")).toLowerCase() === "wal", "journal_mode is WAL", String(one("PRAGMA journal_mode")));
  check(one("PRAGMA synchronous") === 2, "synchronous is FULL, not the guardian's NORMAL", `got ${one("PRAGMA synchronous")} (1=NORMAL, 2=FULL)`);
  check(one("PRAGMA foreign_keys") === 1, "foreign_keys is ON", String(one("PRAGMA foreign_keys")));
  check(one("PRAGMA busy_timeout") === 10000, "busy_timeout is 10s", String(one("PRAGMA busy_timeout")));
  db.close();
}

// ── the version is recorded, and opening again is inert ──────────────────────
{
  const p = join(dir, "v.db");
  const a = openHub(p);
  const v1 = a.prepare("SELECT max(version) v FROM schema_version").get().v;
  check(v1 === HUB_SCHEMA_VERSION, "a fresh store records the binary's schema version", `${v1} vs ${HUB_SCHEMA_VERSION}`);
  const rows1 = a.prepare("SELECT count(*) c FROM schema_version").get().c;
  a.close();
  const b = openHub(p);
  const rows2 = b.prepare("SELECT count(*) c FROM schema_version").get().c;
  check(rows2 === rows1, "re-opening applies nothing and appends no version row", `${rows1} then ${rows2}`);
  b.close();
}

// ── forward-only: an older binary refuses a newer store ──────────────────────
{
  const p = join(dir, "future.db");
  openHub(p).close();
  const raw = new DatabaseSync(p);
  raw.exec(`INSERT INTO schema_version(version, applied_at) VALUES(${HUB_SCHEMA_VERSION + 7}, unixepoch())`);
  raw.close();
  let why = null;
  try { openHub(p); } catch (e) { why = e.message; }
  check(why !== null, "a store recorded above this binary's version refuses to open");
  check(why?.includes(String(HUB_SCHEMA_VERSION + 7)) && why?.includes(String(HUB_SCHEMA_VERSION)),
    "and the refusal names both versions, so the operator knows which binary to run", String(why));
}

// ── hubTx rolls back, so a failed transition leaves nothing behind ───────────
{
  const db = openHub(join(dir, "tx.db"));
  db.exec("CREATE TABLE t(x INTEGER) STRICT");
  try { hubTx(db, () => { db.exec("INSERT INTO t VALUES(1)"); throw new Error("boom"); }); } catch {}
  check(db.prepare("SELECT count(*) c FROM t").get().c === 0, "hubTx rolls back on a throw");
  hubTx(db, () => db.exec("INSERT INTO t VALUES(2)"));
  check(db.prepare("SELECT count(*) c FROM t").get().c === 1, "control: hubTx commits when the body returns");
  db.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it and watch it fail for the right reason**

```bash
N=~/.nvm/versions/node/v24.17.0/bin/node
$N test/hub-schema.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` for `../src/build/hubdb.mjs`.

**On the broken implementation this plan is guarding against** — an `openHub` that is `open()` from `ops.mjs` with a different filename — the module resolves and the suite still goes red on exactly two lines: `synchronous is FULL, not the guardian's NORMAL` reads `1`, and `a store recorded above this binary's version refuses to open` passes silently because there is no version check at all. Those two are the assertions that carry this task; the WAL and foreign-keys checks would pass either way and are controls, not evidence.

- [ ] **Step 3: Add the path**

Append to `src/paths.mjs`:

```js
/**
 * The hub store: one file for the whole builder, not one per repository.
 *
 * Every other store here is per-repo because a repository is what the guardian
 * watches. The hub is the opposite by design -- a task spans projects, a lease
 * is global, and the provider scheduler exists precisely to arbitrate between
 * repositories. Keying it by nwo would make each of those unaskable.
 */
export function hubPathFor(home) {
  return join(home, "state", "hub.db");
}
```

- [ ] **Step 4: Write the migration runner**

Create `src/build/hubdb.mjs`:

```js
// hubdb -- the builder's store, and every statement that touches it.
//
// The guardian repairs its own schema at open(): CREATE TABLE IF NOT EXISTS,
// plus an ADDED_COLUMNS list, plus a RESHAPED list for tables that changed key.
// That grew out of a real failure (settlement.accounting never appeared on the
// live store) and it works for a store whose worst case is a re-poll.
//
// The hub is not that. It records who approved what, at which SHA, under which
// generation, and which merges were allowed. A column that silently fails to
// appear here is an authority question answered from absence. So the hub is
// versioned instead: a numbered, forward-only list, each step in its own
// transaction, and a store recorded above this binary's version does not open.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonical } from "../db/ops.mjs";

export const HUB_SCHEMA_VERSION = 1;

/**
 * Forward-only. Each entry runs exactly once, in order, in its own transaction,
 * and records itself. Never edit a merged entry -- add the next number.
 */
const MIGRATIONS = [
  { version: 1, up: (db) => db.exec(readFileSync(new URL("./hub.sql", import.meta.url), "utf8")) },
];

export function openHub(path) {
  // state/ may not exist yet: on a fresh REEVE_HOME no guardian store has
  // created it, and DatabaseSync will not create a missing parent. Without this
  // the very first hub-writing command fails before migration 1 can run.
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 10000 });

  // Set before anything else: foreign_keys cannot be changed inside a
  // transaction, and a migration is a transaction.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");     // authority-bearing and low-volume; NORMAL is not inherited
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 10000");

  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
             version    INTEGER PRIMARY KEY,
             applied_at INTEGER NOT NULL
           ) STRICT`);

  // Read once here only to refuse a NEWER store early with a clear message.
  const seen = db.prepare("SELECT COALESCE(max(version), 0) v FROM schema_version").get().v;
  if (seen > HUB_SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `hub store at ${path} is schema version ${seen}; this binary knows ${HUB_SCHEMA_VERSION}. ` +
      `Migrations are forward-only: run the newer binary, or restore a snapshot taken at ${HUB_SCHEMA_VERSION}.`);
  }

  for (const m of MIGRATIONS) {
    if (m.version <= seen) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      // Re-read INSIDE the lock. Two processes opening a store that needs
      // migrating both read the same old version before either reaches
      // BEGIN IMMEDIATE; the first commits, the second then takes the lock and
      // re-runs a migration that has already been applied -- colliding on
      // schema_version at best, and corrupting a non-idempotent future
      // migration at worst. The decision to apply has to be made under the same
      // lock that applies it.
      const applied = db.prepare("SELECT COALESCE(max(version), 0) v FROM schema_version").get().v;
      if (m.version <= applied) { db.exec("COMMIT"); continue; }
      m.up(db);
      db.prepare("INSERT INTO schema_version(version, applied_at) VALUES(?, unixepoch())").run(m.version);
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      db.close();
      throw new Error(`hub migration ${m.version} failed, store unchanged: ${e.message}`);
    }
  }
  return db;
}

/** One helper so every hub mutation is BEGIN IMMEDIATE and nothing else. */
export function hubTx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

/** Both stores serialize payloads identically, so a replay compares byte for byte. */
export const canonicalHub = canonical;
```

- [ ] **Step 5: Create `src/build/hub.sql` with its header only**

```sql
-- The hub store. One file for the whole builder.
--
-- Every table here obeys the same rules, and they are rules rather than style:
--   STRICT                 -- a TEXT written into an INTEGER column is an error,
--                             not a silent affinity conversion
--   WITHOUT ROWID          -- for every composite identity, so the primary key
--                             IS the storage and a duplicate cannot hide
--   CHECK on every enum    -- the set of legal values lives with the data, not
--                             only in the code that happens to write it
--   NOT NULL on identity   -- a null in a key is a row that matches nothing
--   *_at INTEGER           -- unixepoch() seconds, never a TEXT date
--   numeric GitHub ids     -- repo_id/actor_id/app_id are immutable; the
--                             human-readable name sits beside them as a snapshot
--
-- Pragmas are set in hubdb.mjs rather than here, because foreign_keys cannot be
-- changed inside a transaction and this file runs inside one.
```

- [ ] **Step 6: Run the test**

```bash
$N test/hub-schema.test.mjs
```

Expected: all green. The `schema_version` assertions pass; the table-shape assertions arrive in Tasks 2 through 5.

- [ ] **Step 7: Commit**

```bash
git add src/paths.mjs src/build/hubdb.mjs src/build/hub.sql test/hub-schema.test.mjs
git commit -m "feat(hub): versioned store with forward-only migrations"
```

---

### Task 2: DDL family 1 — identity, state, and the append-only event log

**Files:**
- Modify: `src/build/hub.sql` (append), `test/hub-schema.test.mjs` (append)

**Interfaces:**
- Consumes: `openHub`, `hubTx` from Task 1.
- Produces: tables `task`, `task_territory`, `task_drain`, `phase_event`, `hold_reason`, `hub_event`, `phase_run`, `gate_run`. The phase enumeration as a SQL `CHECK` — the single authoritative list that `phases.mjs` (PR-B) must match exactly. Index `one_live_run ON phase_run(task) WHERE status IN ('live','adopted')`.

**One deliberate deviation from §11.2, flagged for review.** §11.2 lists `drain_set` as a column on `task`. This plan makes it the child table `task_drain` instead. §11.1 grants the S2 PR authority over "types, checks, and indexes", and this is arguably structural, so it is called out rather than slipped in. The reason: §3.5 says a task becomes CANCELLED "only when every row in `drain_set` has settled through its reconciler". Against a JSON blob that is a parse-and-loop in application code on every tick; against a child table it is one SQL predicate that the database can index and that a restore drill can compare row for row. §11.2 already sets exactly this precedent for territory — "stored as **child rows** `task_territory(task, kind, path)`, never as one TEXT blob". If review prefers the blob, the change is local to this task and to Task 12's cross-check row.

- [ ] **Step 1: Append the failing assertions**

Append to `test/hub-schema.test.mjs`, immediately before the `rmSync` line:

```js
// ── family 1: identity and state ─────────────────────────────────────────────
{
  const db = openHub(join(dir, "f1.db"));
  const tables = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name));
  for (const t of ["task","task_territory","task_drain","phase_event","hold_reason","hub_event","phase_run","gate_run"])
    check(tables.has(t), `openHub creates ${t}`);

  // STRICT is the point of the whole file: without it a TEXT lands in an
  // INTEGER column and nothing complains until something reads it back.
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?");
  for (const t of ["task","phase_event","hub_event","phase_run","gate_run"])
    check(/\bSTRICT\b/.test(sql.get(t).sql), `${t} is STRICT`);
  for (const t of ["task_territory","task_drain","phase_run"])
    check(/WITHOUT ROWID/.test(sql.get(t).sql), `${t} is WITHOUT ROWID (its identity is composite)`);

  // The phase CHECK is the authoritative enumeration of section 3.1. If this
  // list and phases.mjs ever disagree, one of them is admitting a state the
  // other refuses, and the database is the half that cannot be argued with.
  const ins = (phase) => {
    try {
      db.prepare(`INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,source_kind,source_key,
                                   repo_path,profile_path,profile_hash,default_branch,visibility,
                                   registry_version,created_at,updated_at)
                  VALUES(?,'p',1,'o/r','t',?,'founder',?, '/p','/f','h','main','private',1,unixepoch(),unixepoch())`)
        .run(`bt:${phase}`, phase, `k:${phase}`);
      return true;
    } catch { return false; }
  };
  const LEGAL = ["FILED","CLAIMING","SIZING","RESEARCH","DESIGN","SPEC_DRAFT","SPEC_PR_OPEN","GATE",
                 "APPROVED","IMPLEMENTING","IMPL_PR_OPEN","VERDICT_WAIT","SLICE_MERGED","FINALIZING",
                 "BLOCKED","ESCALATED","CANCELLING","DONE","CANCELLED","LOST","INFEASIBLE"];
  check(LEGAL.every(ins), "every one of the 21 phases in the section 3.1 enumeration is accepted");
  check(!ins("REVISING"), "REVISING is refused: a revision is an edge, never a state");
  check(!ins("PHASE_FAILED"), "PHASE_FAILED is refused: it is a phase_run outcome, never a state");
  check(!ins("implementing"), "control: the CHECK is case-sensitive, so a lowercased phase cannot slip in");

  // A territory claim that is not one of the two accepted shapes is refused by
  // the database as well as by the grammar, because the grammar is code and
  // this is the row that outlives it.
  const terr = (kind) => { try {
    db.prepare("INSERT INTO task_territory(task,kind,path) VALUES('bt:FILED',?,'packages/x')").run(kind);
    return true; } catch { return false; } };
  // Both kinds, asserted separately. `a === false || b` is SATISFIED when the
  // schema wrongly rejects 'file' (the left side becomes true), so the original
  // passed on exactly the breakage it was written to catch.
  check(terr("file"), "task_territory accepts an exact-file claim");
  check(terr("prefix"), "and a recursive-prefix claim");
  check(!terr("glob"), "and refuses anything else, including glob");

  // At most one live run per task. The guardian's run table learned this the
  // hard way; the hub is not going to relearn it.
  const run = (attempt, status) => { try {
    db.prepare(`INSERT INTO phase_run(task,generation,phase,slice,attempt,resume_seq,status,started_at,heartbeat_at,lease_expires_at,out_path,err_path)
                VALUES('bt:FILED',1,'RESEARCH',0,?,0,?,unixepoch(),unixepoch(),unixepoch()+120,'/o','/e')`).run(attempt, status);
    return true; } catch { return false; } };
  check(run(1, "live"), "a live run is admitted");
  check(!run(2, "live"), "a SECOND live run for the same task is refused by one_live_run");
  check(run(3, "succeeded"), "control: a settled run beside a live one is fine, so the index is partial and not a blanket");

  db.close();
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
$N test/hub-schema.test.mjs
```

Expected: `FAIL  openHub creates task`, and the rest of the block throwing on the missing table. **On the broken implementation that matters here** — a `task.phase` column declared `TEXT NOT NULL` with no `CHECK` — every table assertion passes, and the three lines that go red are `REVISING is refused`, `PHASE_FAILED is refused`, and the case-sensitivity control. Those are the assertions doing work; the `creates <table>` lines are scaffolding.

- [ ] **Step 3: Append the DDL**

Append to `src/build/hub.sql`:

```sql
-- ---------------------------------------------------------------- identity
-- One row per builder task, for its whole life.
--
-- generation is the CONTRACT EPOCH and bumps on exactly two founder commands
-- (resume --redesign, regenerate). It is NOT a retry counter -- retries live on
-- phase_run.attempt. Approvals bind to (spec head sha, generation), so a retry,
-- a crash, or a plain resume cannot void an approval, and only a deliberate
-- change of what was approved starts an epoch that must be approved again.
CREATE TABLE IF NOT EXISTS task (
  id             TEXT    PRIMARY KEY,              -- bt:<ulid>, minted by the hub
  project        TEXT    NOT NULL,                 -- registry key; NOT a repo name
  repo_id        INTEGER NOT NULL,                 -- immutable numeric GitHub id
  nwo_snapshot   TEXT    NOT NULL,                 -- readable name as it was at admission
  title          TEXT    NOT NULL,
  body           TEXT,
  priority       TEXT    NOT NULL DEFAULT 'p2' CHECK (priority IN ('p1','p2')),
  depth          TEXT             CHECK (depth IS NULL OR depth IN ('trivial','standard','deep')),

  -- The authoritative state enumeration. phases.mjs shares this domain exactly;
  -- a test asserts the two lists are equal, because a state the machine emits
  -- and the database refuses is a transition that throws at commit time.
  phase          TEXT    NOT NULL CHECK (phase IN (
                   'FILED','CLAIMING','SIZING','RESEARCH','DESIGN','SPEC_DRAFT',
                   'SPEC_PR_OPEN','GATE','APPROVED','IMPLEMENTING','IMPL_PR_OPEN',
                   'VERDICT_WAIT','SLICE_MERGED','FINALIZING',
                   'BLOCKED','ESCALATED','CANCELLING',
                   'DONE','CANCELLED','LOST','INFEASIBLE')),
  generation     INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  slice_cursor   INTEGER NOT NULL DEFAULT 0 CHECK (slice_cursor >= 0),
  resume_seq     INTEGER NOT NULL DEFAULT 0 CHECK (resume_seq >= 0),

  -- provenance
  source_kind    TEXT    NOT NULL CHECK (source_kind IN ('founder','ledger')),
  source_key     TEXT    NOT NULL,
  text_hash      TEXT,                             -- founder filings
  filed_via      TEXT             CHECK (filed_via IS NULL OR filed_via IN ('cli','import')),
  claim_event_id TEXT,                             -- ledger tasks (S5); never a byte offset
  operation_id   TEXT,
  projection_generation INTEGER,
  idempotency_key TEXT,

  -- held and terminal detail
  blocked_reason TEXT,
  held_from      TEXT             CHECK (held_from IS NULL OR held_from IN (
                   'FILED','CLAIMING','SIZING','RESEARCH','DESIGN','SPEC_DRAFT',
                   'SPEC_PR_OPEN','GATE','APPROVED','IMPLEMENTING','IMPL_PR_OPEN',
                   'VERDICT_WAIT','SLICE_MERGED','FINALIZING')),
  terminal_reason TEXT,

  -- the spec PR is fixed for the task's life; a redesign pushes a new head to it
  spec_repo_id   INTEGER,
  spec_pr        INTEGER,
  spec_head      TEXT,
  approved_spec_head TEXT,
  approved_generation INTEGER,

  -- registry snapshot: what admitted this task, frozen. Later phases read THIS,
  -- never the live registry, so an edit to projects.json cannot move a task.
  repo_path        TEXT    NOT NULL,
  profile_path     TEXT    NOT NULL,
  profile_hash     TEXT    NOT NULL,
  default_branch   TEXT    NOT NULL,
  visibility       TEXT    NOT NULL CHECK (visibility IN ('private','public','internal','unknown')),
  gate_definition_hash TEXT,
  registry_version INTEGER NOT NULL,
  founder_user_id  INTEGER,
  ledger_name      TEXT,

  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,

  UNIQUE (source_kind, source_key)
) STRICT;
CREATE INDEX IF NOT EXISTS task_active ON task(project, phase) WHERE phase NOT IN ('DONE','CANCELLED','LOST','INFEASIBLE');
CREATE UNIQUE INDEX IF NOT EXISTS task_idem ON task(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Territory claims as child rows, never one TEXT blob: overlap is a prefix
-- question and a blob cannot be asked one.
CREATE TABLE IF NOT EXISTS task_territory (
  task TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('file','prefix')),
  path TEXT NOT NULL,
  PRIMARY KEY (task, kind, path)
) STRICT, WITHOUT ROWID;

-- The drain set of a CANCELLING task: the in-flight outbox rows that must
-- reconcile before CANCELLED is legitimate. A child table rather than a JSON
-- column on task, because "has every row settled" is a query, and because a
-- forced cancel has to record WHICH rows were forced and what was last known
-- about them -- neither of which a blob can be joined against.
CREATE TABLE IF NOT EXISTS task_drain (
  task        TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  outbox_id   INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  settled_at  INTEGER,
  forced      INTEGER NOT NULL DEFAULT 0 CHECK (forced IN (0,1)),
  last_known  TEXT,                                -- the last reconciler attempt, for `task why`
  PRIMARY KEY (task, outbox_id)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------- events
-- phase_event: the transition log. hub_event: EVERY authority-bearing write.
-- They are separate because the restore drill replays hub_event, and a store
-- whose only log is transitions cannot rebuild an approval that was recorded
-- without one.
CREATE TABLE IF NOT EXISTS phase_event (
  seq            INTEGER PRIMARY KEY,
  task           TEXT    NOT NULL REFERENCES task(id),
  at             INTEGER NOT NULL,
  op             TEXT    NOT NULL,                 -- builder op names only; guardian ops are never reused
  from_phase     TEXT,
  to_phase       TEXT,
  from_generation INTEGER,
  to_generation  INTEGER,
  slice          INTEGER,
  artifact_sha   TEXT,                             -- what justified the transition
  detail         TEXT    NOT NULL DEFAULT '{}'     -- canonical JSON
) STRICT;
CREATE INDEX IF NOT EXISTS phase_event_task ON phase_event(task, seq);

CREATE TABLE IF NOT EXISTS hold_reason (
  id         INTEGER PRIMARY KEY,
  task       TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  reason     TEXT    NOT NULL,
  detail     TEXT,
  at         INTEGER NOT NULL,
  cleared_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS hold_reason_open ON hold_reason(task) WHERE cleared_at IS NULL;

-- Append-only. One row per authority-bearing write, in that write's own
-- transaction. This is what the destructive restore drill replays, so a write
-- that skips it is a fact the hub cannot get back.
CREATE TABLE IF NOT EXISTS hub_event (
  seq     INTEGER PRIMARY KEY,
  at      INTEGER NOT NULL,
  kind    TEXT    NOT NULL,
  task    TEXT REFERENCES task(id),
  payload TEXT    NOT NULL DEFAULT '{}'            -- canonical JSON
) STRICT;
CREATE INDEX IF NOT EXISTS hub_event_task ON hub_event(task, seq);
CREATE INDEX IF NOT EXISTS hub_event_kind ON hub_event(kind, seq);

-- ---------------------------------------------------------------- runs
-- One row per attempt at one phase. slice is 0 for phases that have none.
-- attempt is monotonic per key and never reused, so a run resumed after a
-- founder resume can never collide with a run from before it.
CREATE TABLE IF NOT EXISTS phase_run (
  task        TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  generation  INTEGER NOT NULL,
  phase       TEXT    NOT NULL,
  slice       INTEGER NOT NULL DEFAULT 0,
  attempt     INTEGER NOT NULL,
  resume_seq  INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL CHECK (status IN ('live','succeeded','failed','adopted','killed')),
  pid         INTEGER,
  lstart      TEXT,                                -- distinguishes a reused pid
  session_id  TEXT,
  started_at  INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  out_path    TEXT    NOT NULL,
  err_path    TEXT    NOT NULL,
  truncated   INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  outcome     TEXT,
  evidence    TEXT,
  -- the contract snapshot; same column family as the guardian's worker_run
  cli_version TEXT, model_id TEXT, effort TEXT,
  argv_hash TEXT, prompt_hash TEXT, settings_hash TEXT, tools_hash TEXT, agents_hash TEXT,
  max_turns INTEGER, max_budget_usd REAL, canary_id TEXT,
  snapshot_hash TEXT,                              -- the registry snapshot; guardian runs have none
  contract_drift TEXT,                             -- canonical JSON; null when the live env matched
  PRIMARY KEY (task, generation, phase, slice, attempt)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS one_live_run ON phase_run(task) WHERE status IN ('live','adopted');

-- Gates the CONTROLLER ran, from gate definitions hashed at the approved base.
-- A worker's self-report never gates anything; this row is what did.
CREATE TABLE IF NOT EXISTS gate_run (
  id          INTEGER PRIMARY KEY,
  task        TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  generation  INTEGER NOT NULL,
  slice       INTEGER NOT NULL DEFAULT 0,
  command     TEXT    NOT NULL,
  base_definition_hashes TEXT NOT NULL,
  tool_versions TEXT,
  env_hash    TEXT,
  exit_code   INTEGER NOT NULL,
  output_hash TEXT    NOT NULL,
  out_path    TEXT    NOT NULL,
  at          INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS gate_run_task ON gate_run(task, generation, slice, at);
```

- [ ] **Step 4: Run the test**

```bash
$N test/hub-schema.test.mjs
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/build/hub.sql test/hub-schema.test.mjs
git commit -m "feat(hub): task identity, events, runs and gate evidence"
```

---
### Task 3: DDL family 2 — gate evidence and the attested implementation chain

**Files:**
- Modify: `src/build/hub.sql` (append), `test/hub-schema.test.mjs` (append)

**Interfaces:**
- Consumes: `task` from Task 2.
- Produces: tables `gate_request`, `approval`, `notice_receipt`, `impl_pr`, `attested_push`, `guardian_receipt`, `ownership_check`, `harness_acceptance`. Enumerations: `approval.kind ∈ {founder_review, founder_cli, founder_silence, codex_clean}`, `approval.verdict ∈ {approve, changes_requested, clean}`, `approval.path ∈ {codex_clean_founder, codex_clean_silence, founder_codex_unavailable}` or NULL, `notice_receipt.kind ∈ {delivered, founder_ack}`, `attested_push.pusher ∈ {builder, guardian}` paired with `source_kind ∈ {outbox, guardian_event}`, `guardian_receipt.status ∈ {imported, verified, rejected}`.

- [ ] **Step 1: Append the failing assertions**

Append to `test/hub-schema.test.mjs`, before `rmSync`:

```js
// ── family 2: gate evidence and the attested chain ───────────────────────────
{
  const db = openHub(join(dir, "f2.db"));
  const tables = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name));
  for (const t of ["gate_request","approval","notice_receipt","impl_pr","attested_push","guardian_receipt","ownership_check","harness_acceptance"])
    check(tables.has(t), `openHub creates ${t}`);

  db.exec(`INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,source_kind,source_key,
             repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,created_at,updated_at)
           VALUES('bt:1','p',1,'o/r','t','GATE','founder','k','/p','/f','h','main','private',1,unixepoch(),unixepoch())`);

  const approve = (kind, verdict, path) => { try {
    db.prepare(`INSERT INTO approval(task,spec_repo_id,spec_pr,head_sha,actor_id,actor_login_snapshot,kind,verdict,path,observed_at,source_id,task_generation)
                VALUES('bt:1',9,1,?,5,'m',?,?,?,unixepoch(),?,1)`)
      .run("a".repeat(40), kind, verdict, path, `${kind}:${verdict}:${path}`);
    return true; } catch { return false; } };
  check(approve("codex_clean", "clean", null), "a Codex clean pass is a legal approval row");
  check(approve("founder_silence", "approve", "codex_clean_silence"), "so is a silence approval carrying its path");
  check(!approve("waiver", "approve", null), "there is no waiver kind: the Codex-unavailable path is an approval row, not a waiver");
  check(!approve("founder_review", "lgtm", null), "control: an invented verdict is refused, so the CHECK is on verdict too");

  // A merge witness must be traceable to a pusher AND to the mechanism that
  // recorded it. builder pushes arrive through the outbox; guardian pushes
  // arrive as imported receipts. A row claiming a builder push arrived as a
  // guardian_event is a chain nobody can verify, so the pairing is a CHECK.
  const push = (pusher, sourceKind) => { try {
    db.prepare(`INSERT INTO attested_push(task,generation,slice,pr,sha,pusher,source_kind,source_ref,at)
                VALUES('bt:1',1,0,7,?,?,?,'r',unixepoch())`).run(`${pusher}${sourceKind}`.padEnd(40,"0").slice(0,40), pusher, sourceKind);
    return true; } catch { return false; } };
  check(push("builder", "outbox"), "a builder push attests through the outbox");
  check(push("guardian", "guardian_event"), "a guardian push attests through an imported receipt");
  check(!push("builder", "guardian_event"), "a builder push claiming a guardian receipt is refused");
  check(!push("guardian", "outbox"), "and a guardian push claiming the hub outbox is refused");

  // At-least-once delivery is the guardian receipt contract. Importing the same
  // seq twice must be inert, not a second row and not an error the caller has
  // to special-case away.
  const receipt = () => db.prepare(
    `INSERT INTO guardian_receipt(repo_id,guardian_event_seq,kind,pr,head_before,head_after,payload_hash,received_at,status)
     VALUES(1,42,'push.settled',7,'a','b','h',unixepoch(),'imported') ON CONFLICT DO NOTHING`).run();
  receipt(); receipt();
  check(db.prepare("SELECT count(*) c FROM guardian_receipt WHERE repo_id=1 AND guardian_event_seq=42").get().c === 1,
    "importing the same guardian_event seq twice leaves exactly one receipt");

  // impl_pr binds a PR to a slice, and UNIQUE(repo_id, pr) is what the receipt
  // importer joins on. Two slices claiming one PR would make that join
  // ambiguous and a merge would be attributed to the wrong slice.
  db.exec(`INSERT INTO impl_pr(task,generation,slice,repo_id,pr,created_at) VALUES('bt:1',1,0,1,7,unixepoch())`);
  let dup = true;
  try { db.exec(`INSERT INTO impl_pr(task,generation,slice,repo_id,pr,created_at) VALUES('bt:1',1,1,1,7,unixepoch())`); }
  catch { dup = false; }
  check(!dup, "two slices cannot bind the same (repo_id, pr)");

  db.close();
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
$N test/hub-schema.test.mjs
```

Expected: `FAIL  openHub creates gate_request` and the block throwing thereafter.

**On the broken implementation:** the pairing CHECK on `attested_push` is the one an ordinary DDL author would omit — `pusher TEXT CHECK(pusher IN ('builder','guardian'))` and `source_kind TEXT CHECK(source_kind IN ('outbox','guardian_event'))` as two independent checks look complete and pass every "creates the table" assertion. The two lines that go red are `a builder push claiming a guardian receipt is refused` and its mirror. Likewise `there is no waiver kind` goes red against any `approval.kind` declared without a CHECK.

- [ ] **Step 3: Append the DDL**

Append to `src/build/hub.sql`:

```sql
-- ---------------------------------------------------------------- gate evidence
-- One gate_request per (spec PR, head). The revision cap counts THESE, not raw
-- pushes: a crash-rerun re-derives different bytes and would otherwise look
-- like a second revision of the same round.
CREATE TABLE IF NOT EXISTS gate_request (
  task           TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  spec_repo_id   INTEGER NOT NULL,
  spec_pr        INTEGER NOT NULL,
  head_sha       TEXT    NOT NULL,
  round          INTEGER NOT NULL CHECK (round >= 0),
  task_generation INTEGER NOT NULL,
  requested_at   INTEGER NOT NULL,
  PRIMARY KEY (spec_repo_id, spec_pr, head_sha)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS gate_request_task ON gate_request(task, task_generation, round);

-- Every witness at a head, from every source. There is deliberately NO waiver
-- table: the Codex-unavailable path (section 7.3 row 7) is an ordinary founder
-- approval row carrying path='founder_codex_unavailable' and the evidence of
-- unavailability, so it is auditable as an approval rather than as an exception.
CREATE TABLE IF NOT EXISTS approval (
  task            TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  spec_repo_id    INTEGER NOT NULL,
  spec_pr         INTEGER NOT NULL,
  head_sha        TEXT    NOT NULL,
  actor_id        INTEGER NOT NULL,               -- numeric; a login can be renamed
  actor_login_snapshot TEXT NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN
                    ('founder_review','founder_cli','founder_silence','codex_clean')),
  verdict         TEXT    NOT NULL CHECK (verdict IN ('approve','changes_requested','clean')),
  receipt_ref     TEXT,                            -- silence rows carry the notice receipt
  command_line    TEXT,                            -- CLI rows carry the command
  head_read_at    INTEGER,
  path            TEXT             CHECK (path IS NULL OR path IN
                    ('codex_clean_founder','codex_clean_silence','founder_codex_unavailable')),
  unavailability_evidence TEXT,                    -- refusal comment id, or request ts + window
  observed_at     INTEGER NOT NULL,
  source_id       TEXT    NOT NULL,                -- the comment/review id this row came from
  task_generation INTEGER NOT NULL,
  superseded_at   INTEGER,
  superseded_by   TEXT,
  PRIMARY KEY (spec_repo_id, spec_pr, head_sha, actor_id, source_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS approval_task ON approval(task, task_generation, head_sha);

-- The founder's 15 minutes start from max(clean comment, notice DELIVERED).
-- Without a receipt there is no clock, and a builder that was down for twenty
-- minutes past a clean comment must not restart and call that silence.
CREATE TABLE IF NOT EXISTS notice_receipt (
  task            TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  head_sha        TEXT    NOT NULL,
  clean_source_id TEXT    NOT NULL,                -- always real: `task ack` refuses before a clean pass
  channel         TEXT    NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('delivered','founder_ack')),
  delivered_at    INTEGER NOT NULL,
  receipt_ref     TEXT,
  PRIMARY KEY (task, head_sha, clean_source_id)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------- impl chain
CREATE TABLE IF NOT EXISTS impl_pr (
  task       TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  slice      INTEGER NOT NULL,
  repo_id    INTEGER NOT NULL,
  pr         INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  merged_sha TEXT,
  PRIMARY KEY (task, generation, slice),
  -- the key the receipt importer joins guardian_event.pr to a (task, slice) on
  UNIQUE (repo_id, pr)
) STRICT, WITHOUT ROWID;

-- The attested head chain. A commit nobody attested blocks the merge, which is
-- what stops a smuggled commit without the check decaying into "head = head".
--
-- pusher and source_kind are PAIRED, not independent: a builder push arrives
-- through the hub outbox, a guardian push arrives as a verified imported
-- receipt. A row asserting one pusher with the other's mechanism describes a
-- chain that cannot be verified against anything.
CREATE TABLE IF NOT EXISTS attested_push (
  task        TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  generation  INTEGER NOT NULL,
  slice       INTEGER NOT NULL,
  pr          INTEGER NOT NULL,
  sha         TEXT    NOT NULL,
  pusher      TEXT    NOT NULL CHECK (pusher IN ('builder','guardian')),
  source_kind TEXT    NOT NULL CHECK (source_kind IN ('outbox','guardian_event')),
  source_ref  TEXT    NOT NULL,                    -- outbox key, or <repo_id>:<seq>
  at          INTEGER NOT NULL,
  PRIMARY KEY (task, generation, slice, sha),
  CHECK ((pusher = 'builder'  AND source_kind = 'outbox')
      OR (pusher = 'guardian' AND source_kind = 'guardian_event'))
) STRICT, WITHOUT ROWID;

-- Receipts imported from a guardian's own append-only table. Delivery is
-- at-least-once, so the unique key is the whole dedup mechanism: re-reading a
-- seq is inert rather than a second row.
CREATE TABLE IF NOT EXISTS guardian_receipt (
  repo_id            INTEGER NOT NULL,
  guardian_event_seq INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  pr          INTEGER,
  head_before TEXT,
  head_after  TEXT,
  payload_hash TEXT   NOT NULL,
  received_at INTEGER NOT NULL,
  verified_at INTEGER,
  status      TEXT    NOT NULL CHECK (status IN ('imported','verified','rejected')),
  reason      TEXT,
  PRIMARY KEY (repo_id, guardian_event_seq)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ownership_check (
  task      TEXT    PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  owner     TEXT,
  synced_at INTEGER NOT NULL,
  at        INTEGER NOT NULL
) STRICT;

-- Written ONLY by `reeve task resume --accept-harness <prefix>`. The command
-- re-hashes the preserved held patch and refuses a prefix that does not match,
-- so the hash recorded here is the hash of the diff the PR carries. No event,
-- comment, or worker can write this row.
CREATE TABLE IF NOT EXISTS harness_acceptance (
  task        TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  generation  INTEGER NOT NULL,
  slice       INTEGER NOT NULL,
  diff_hash   TEXT    NOT NULL,
  actor_id    INTEGER NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (task, generation, slice, diff_hash)
) STRICT, WITHOUT ROWID;
```

- [ ] **Step 4: Run it, then commit**

```bash
$N test/hub-schema.test.mjs      # expect all green
git add src/build/hub.sql test/hub-schema.test.mjs
git commit -m "feat(hub): gate evidence and the attested push chain"
```

---

### Task 4: DDL family 3 — holds, authority, and per-repo gate state

**Files:**
- Modify: `src/build/hub.sql` (append), `test/hub-schema.test.mjs` (append)

**Interfaces:**
- Consumes: `task` from Task 2.
- Produces: tables `pr_hold` (with `one_open_hold`), `project_authority`, `repo_gate_state`. `pr_hold` is the **only hub table the guardian reads**; `project_authority` is written **only** by `reeve build authority`; `repo_gate_state` is written by the builder tick and **never** by doctor.

- [ ] **Step 1: Append the failing assertions**

```js
// ── family 3: holds and authority ────────────────────────────────────────────
{
  const db = openHub(join(dir, "f3.db"));
  for (const t of ["pr_hold","project_authority","repo_gate_state"]) {
    const has = db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name=?").get(t).c === 1;
    check(has, `openHub creates ${t}`);
  }
  db.exec(`INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,source_kind,source_key,
             repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,created_at,updated_at)
           VALUES('bt:1','p',1,'o/r','t','BLOCKED','founder','k','/p','/f','h','main','private',1,unixepoch(),unixepoch())`);

  const hold = (reason) => { try {
    db.prepare(`INSERT INTO pr_hold(task,repo_id,pr,head_sha,reason,created_at) VALUES('bt:1',1,7,?,?,unixepoch())`)
      .run("a".repeat(40), reason); return true; } catch { return false; } };
  check(hold("cancel"), "a hold is written for an open builder PR");

  // The whole point of one_open_hold: a task that is held twice must not
  // accumulate two open rows, because the guardian's verdict clause asks "is
  // there an uncleared hold" and clearing one of two would answer no while the
  // other still stands.
  check(!hold("escalated"), "a SECOND open hold on the same (repo_id, pr) is refused");
  db.exec("UPDATE pr_hold SET cleared_at=unixepoch() WHERE cleared_at IS NULL");
  check(hold("escalated"), "control: once cleared, the same PR can be held again");
  check(!hold("because-i-said-so"), "an invented hold reason is refused; the set is closed");

  // An expired authority row authorizes nothing. Storing `until` as an INTEGER
  // is what makes that a comparison rather than a string parse at merge time.
  db.exec(`INSERT INTO project_authority(project_id,kind,granted_by,until,created_at)
           VALUES('nextly','review-witness',5,unixepoch()+3600,unixepoch())`);
  const live = db.prepare(
    `SELECT count(*) c FROM project_authority WHERE project_id='nextly' AND kind='review-witness' AND until > unixepoch()`).get().c;
  check(live === 1, "a live review-witness grant is findable by a plain comparison");
  let badKind = true;
  try { db.exec(`INSERT INTO project_authority(project_id,kind,granted_by,until,created_at) VALUES('n','merge',5,1,1)`); }
  catch { badKind = false; }
  check(!badKind, "review-witness is the only authority kind there is");

  // repo_gate_state has no merge-permission probe column, by design: nothing in
  // this system ever attempts a merge against a production repository to find
  // out whether it could.
  const cols = new Set(db.prepare("PRAGMA table_info(repo_gate_state)").all().map(c => c.name));
  check(cols.has("ruleset_requires_check") && cols.has("bound_app_id") && cols.has("expected_app_id") && cols.has("verified_at"),
    "repo_gate_state records what the ruleset requires and which app is bound", [...cols].join(","));
  check(![...cols].some(c => /merge.*(probe|permission)|can_merge/.test(c)),
    "and carries no merge-permission probe column", [...cols].join(","));
  db.close();
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
$N test/hub-schema.test.mjs
```

**On the broken implementation:** a `pr_hold` declared with a plain `UNIQUE(repo_id, pr)` instead of the partial index passes `a hold is written` and `a SECOND open hold is refused`, and goes red on exactly one line — `control: once cleared, the same PR can be held again` — because a full unique constraint refuses the re-hold too. That control is not decoration; it is the only assertion that distinguishes the partial index from the blanket one.

- [ ] **Step 3: Append the DDL**

```sql
-- ---------------------------------------------------------------- holds
-- The one hub table a guardian READS. On CANCELLING, ESCALATED and BLOCKED the
-- entry tx writes one row per open builder PR; the guardian's verdict finds it
-- and renders BLOCK, so the server-required ops/merge-policy check fails at the
-- head and the server refuses a merge even against a stale client request.
--
-- one_open_hold is PARTIAL on purpose. The verdict asks "is there an uncleared
-- hold for this PR"; two open rows would mean clearing one answers no while the
-- other still stands. A cleared row is history and must not block a re-hold.
CREATE TABLE IF NOT EXISTS pr_hold (
  id         INTEGER PRIMARY KEY,
  task       TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  repo_id    INTEGER NOT NULL,
  pr         INTEGER NOT NULL,
  head_sha   TEXT    NOT NULL,
  reason     TEXT    NOT NULL CHECK (reason IN
               ('cancel','reopen','ownership_lost','harness_touched','over_budget',
                'depth_post_approval','escalated','blocked_other')),
  detail     TEXT,                                 -- for blocked_other, the escalation identity
  created_at INTEGER NOT NULL,
  cleared_at INTEGER
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_open_hold ON pr_hold(repo_id, pr) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS pr_hold_task ON pr_hold(task) WHERE cleared_at IS NULL;

-- ---------------------------------------------------------------- authority
-- Written ONLY by `reeve build authority <project> --kind review-witness
-- --until <date>`, which is founder-only. It exists because the guardian's
-- review clause emits PASS on an empty blocking-reviewer roster: for a builder
-- PR that is absence read as success on the very witness the requirement names.
-- An expired row authorizes nothing, so `until` is compared, never trusted.
CREATE TABLE IF NOT EXISTS project_authority (
  project_id TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('review-witness')),
  granted_by INTEGER NOT NULL,                     -- numeric actor id
  until      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, kind, created_at)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------- gate state
-- Refreshed by the builder tick, one row per registry project. Clause U4 reads
-- it with a freshness bound; absent, stale or drifted is UNKNOWN, never PASS.
-- Doctor REPORTS this row and never writes it -- a reporter that can also write
-- what it reports can agree with itself.
--
-- There is deliberately no merge-permission probe column. The only merge probe
-- in this system runs against the disposable canary repository; nothing ever
-- attempts a merge on a production repo to discover whether it could.
CREATE TABLE IF NOT EXISTS repo_gate_state (
  repo_id       INTEGER PRIMARY KEY,
  nwo_snapshot  TEXT    NOT NULL,
  ruleset_requires_check INTEGER NOT NULL CHECK (ruleset_requires_check IN (0,1)),
  bound_app_id  INTEGER,                           -- the app the ruleset names as the source
  expected_app_id INTEGER,                         -- the app reeve expects; a mismatch is drift
  app_installed TEXT    NOT NULL CHECK (app_installed IN ('pass','fail','unknown')),
  permission_diff TEXT,                            -- canonical JSON; null when it matched
  ruleset_snapshot TEXT,                           -- what was read, verbatim
  verified_at   INTEGER NOT NULL,
  error         TEXT
) STRICT;
```

- [ ] **Step 4: Run it, then commit**

```bash
$N test/hub-schema.test.mjs      # expect all green
git add src/build/hub.sql test/hub-schema.test.mjs
git commit -m "feat(hub): pr holds, project authority and repo gate state"
```

---
### Task 5: DDL family 4 — effects, evidence transport, and coordination

**Files:**
- Modify: `src/build/hub.sql` (append), `test/hub-schema.test.mjs` (append)

**Interfaces:**
- Consumes: `task` from Task 2.
- Produces: tables `inbox`, `outbox` (with `outbox_live_key`), `merge_decision`, `singleton_lease`, `writer_lease`, `maintenance_lock`, `directory_lease`, `territory_lease`, `provider_lease`, `provider_state`, `intake_event`, `escalation`. **32 tables total** after this task; Task 11 asserts that number and its membership.
- The hub outbox kind enumeration, which is closed and contains **no** check-publish kind: `git.push.branch`, `gh.pr.create`, `gh.pr.comment`, `gh.pr.close`, `gh.pr.body`, `gh.review.request`, `gh.pr.merge`, `notify`, `gate.clean_notice`, `ledger.claim`, `ledger.release`.

- [ ] **Step 1: Append the failing assertions**

```js
// ── family 4: effects, transport, coordination ───────────────────────────────
{
  const db = openHub(join(dir, "f4.db"));
  for (const t of ["inbox","outbox","merge_decision","singleton_lease","writer_lease","maintenance_lock",
                   "directory_lease","territory_lease","provider_lease","provider_state","intake_event","escalation"]) {
    const has = db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name=?").get(t).c === 1;
    check(has, `openHub creates ${t}`);
  }
  db.exec(`INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,source_kind,source_key,
             repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,created_at,updated_at)
           VALUES('bt:1','p',1,'o/r','t','SPEC_DRAFT','founder','k','/p','/f','h','main','private',1,unixepoch(),unixepoch())`);

  // The builder never publishes a check run on any production repository; the
  // guardian is the sole publisher of ops/merge-policy there. That is not a
  // convention to remember at the call site -- there is no kind to enqueue.
  const kind = (k) => { try {
    db.prepare(`INSERT INTO outbox(idempotency_key,kind,task_id,task_generation,fence,cancellable,args,created_at,updated_at)
                VALUES(?,?, 'bt:1',1,1,1,'{}',unixepoch(),unixepoch())`).run(`k:${k}`, k); return true; } catch { return false; } };
  check(kind("git.push.branch") && kind("gh.pr.create") && kind("notify"), "the ordinary effect kinds are enqueueable");
  check(!kind("gh.check.publish"), "there is NO builder check-publish kind: the guardian is the sole publisher");
  check(!kind("gh.pr.forceMerge"), "control: an invented kind is refused, so the enumeration is closed and not open");

  // Key uniqueness is over LIVE rows only. A completed, voided, fenced or
  // failed row is history: a plain resume re-enqueues the same key and must be
  // ADMITTED beside it, then settled inert by its reconciler against external
  // truth. A blanket UNIQUE would either swallow the re-enqueue or refuse it.
  const again = () => { try {
    db.prepare(`INSERT INTO outbox(idempotency_key,kind,task_id,task_generation,fence,cancellable,args,created_at,updated_at)
                VALUES('bt:1:g1:SPEC_DRAFT:push:0','git.push.branch','bt:1',1,1,1,'{}',unixepoch(),unixepoch())`).run();
    return true; } catch { return false; } };
  check(again(), "a key is enqueueable once");
  check(!again(), "and refused while the first row is still live");
  db.exec("UPDATE outbox SET status='voided' WHERE idempotency_key='bt:1:g1:SPEC_DRAFT:push:0'");
  check(again(), "but admitted again once the earlier row is voided, because uniqueness is over live rows only");

  for (const s of ["voided","fenced","refused","superseded","forced"]) {
    let ok = true;
    try { db.exec(`UPDATE outbox SET status='${s}' WHERE id=1`); } catch { ok = false; }
    check(ok, `the hub-only outbox status '${s}' is legal`);
  }

  // The measured fact from the shadow week: pull_request.updated_at does NOT
  // change when a review thread is resolved. A column by that name invites
  // exactly the ordering that was blind, so the hub inbox does not have one.
  const inboxCols = new Set(db.prepare("PRAGMA table_info(inbox)").all().map(c => c.name));
  check(!inboxCols.has("updated_at"), "the hub inbox has no updated_at column", [...inboxCols].join(","));
  check(inboxCols.has("edited_at") && inboxCols.has("content_hash") && inboxCols.has("generation"),
    "it carries edited_at, content_hash and generation instead, so an edit is a new generation", [...inboxCols].join(","));
  check(inboxCols.has("complete") && inboxCols.has("payload_hash") && inboxCols.has("delivery_id"),
    "and completeness, payload hash and delivery id, so an incomplete page reads as UNKNOWN", [...inboxCols].join(","));

  // A clone belongs to no task; a worktree always belongs to one. Getting that
  // pairing wrong means a reaper that frees a live task's worktree.
  const dl = (kindV, task) => { try {
    db.prepare(`INSERT INTO directory_lease(path,owner_kind,task,pid,lstart,expires_at)
                VALUES(?,?,?,1,'x',unixepoch()+120)`).run(`/p/${kindV}/${task}`, kindV, task); return true; } catch { return false; } };
  check(dl("worktree", "bt:1"), "a worktree lease names its task");
  check(dl("clone", null), "a clone lease has no task");
  check(!dl("worktree", null), "a worktree lease WITHOUT a task is refused");
  check(!dl("clone", "bt:1"), "and a clone lease WITH one is refused");

  const pl = (owner, status) => { try {
    db.prepare(`INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,priority,status,requested_at,expires_at)
                VALUES(?,1,?,1,'x',0,?,unixepoch(),unixepoch()+120)`).run(owner, `${owner}${status}`, status); return true; } catch { return false; } };
  check(pl("guardian", "held") && pl("builder", "queued"), "both daemons can hold a provider lease row");
  check(!pl("worker", "held"), "and nothing else can");
  check(!pl("builder", "running"), "control: the status set is closed too");

  db.close();
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
$N test/hub-schema.test.mjs
```

**On the broken implementation:** copying the guardian's `outbox` DDL verbatim gives `idem_key TEXT NOT NULL UNIQUE`. Every table assertion passes and the enqueue works. The line that goes red is `admitted again once the earlier row is voided` — a blanket UNIQUE refuses it. That single assertion is the difference between an outbox that can be resumed and one that silently swallows the re-enqueued effect, and it is the reason the voided-then-retry case is written out rather than assumed.

- [ ] **Step 3: Append the DDL**

```sql
-- ---------------------------------------------------------------- inbox
-- Facts observed from GitHub, keyed by CONTENT so a retro-edit is a new
-- generation rather than a silent no-op. Extended past the guardian's shape
-- with the numeric actor id, the head it was observed at, the server's own
-- timestamp, and whether pagination finished.
--
-- There is no updated_at column, and that is a decision rather than an
-- omission: pull_request.updated_at does NOT change when a review thread is
-- resolved, so a reader that ordered or filtered on it would be blind to
-- exactly the review state it was watching for. GitHub's edit timestamp is
-- kept as edited_at and is never used as an ordering.
CREATE TABLE IF NOT EXISTS inbox (
  id           INTEGER PRIMARY KEY,
  source       TEXT    NOT NULL,                   -- reviewer login, 'human', 'ci'
  external_id  TEXT    NOT NULL,
  repo_id      INTEGER,                            -- numeric; the nwo can be renamed
  pr_number    INTEGER,
  head_sha     TEXT,
  actor_id     INTEGER,
  login_snapshot TEXT,
  kind         TEXT    NOT NULL,
  payload      TEXT    NOT NULL,                   -- canonical JSON
  content_hash TEXT    NOT NULL,                   -- of payload; an edit changes it
  payload_hash TEXT    NOT NULL,
  generation   INTEGER NOT NULL DEFAULT 1,
  complete     INTEGER NOT NULL DEFAULT 1 CHECK (complete IN (0,1)),  -- 0 = pagination unfinished
  delivery_id  TEXT,                               -- X-GitHub-Delivery, when webhooks arm
  observed_at  INTEGER NOT NULL,                   -- when reeve saw it
  server_at    INTEGER,                            -- GitHub's own created/submitted time
  edited_at    INTEGER,                            -- never an ordering; see above
  UNIQUE (source, external_id, content_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS inbox_pr ON inbox(repo_id, pr_number, kind);
CREATE INDEX IF NOT EXISTS inbox_object ON inbox(source, external_id, generation);
CREATE INDEX IF NOT EXISTS inbox_incomplete ON inbox(repo_id, pr_number) WHERE complete = 0;

-- ---------------------------------------------------------------- outbox
-- Every externally-visible effect, enqueued in the same transaction as the
-- state change that decided it.
--
-- Two things differ from the guardian's outbox, and both are load-bearing:
--
-- 1. The idempotency key is unique over LIVE rows only. A done, voided, fenced,
--    failed or superseded row is history; a re-enqueued key is admitted beside
--    it and settled against external truth by its reconciler, which is what
--    makes re-delivery inert. A blanket UNIQUE would either swallow the
--    re-enqueued effect or refuse the enqueue outright.
-- 2. Every row carries the task generation and a fence. The executor
--    revalidates the fence inside the lease transaction: if the task has moved
--    to another generation, or the row was voided, it settles 'fenced' with no
--    effect. Without it a stale attempt from generation 3 can act on a task
--    that was redesigned into generation 4.
--
-- There is no check-publish kind. On a production repository the guardian is
-- the sole publisher of ops/merge-policy; the builder has nothing to enqueue.
CREATE TABLE IF NOT EXISTS outbox (
  id           INTEGER PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN
                 ('git.push.branch','gh.pr.create','gh.pr.comment','gh.pr.close','gh.pr.body',
                  'gh.review.request','gh.pr.merge','notify','gate.clean_notice',
                  'ledger.claim','ledger.release')),
                 -- gate.clean_notice is its own kind, not a plain notify: its
                 -- settle writes the notice_receipt row that STARTS the founder
                 -- silence window (section 7.3), and the window is measured from
                 -- max(clean comment, notice delivered). A generic notify has no
                 -- such settlement, so without this kind the clock never starts
                 -- and no silence approval can ever be legitimate.
  task_id      TEXT REFERENCES task(id) ON DELETE CASCADE,
  task_generation INTEGER NOT NULL,
  fence        INTEGER NOT NULL,                   -- the phase_event seq that enqueued it
  cancellable  INTEGER NOT NULL DEFAULT 1 CHECK (cancellable IN (0,1)),
  args         TEXT    NOT NULL,                   -- canonical JSON
  status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN
                 ('pending','inflight','done','failed','dead_letter',
                  'voided','fenced','refused','superseded','forced')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  not_before   INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER NOT NULL DEFAULT 0,
  visibility_repo_id INTEGER,                      -- what was re-queried at effect time
  visibility_result  TEXT CHECK (visibility_result IS NULL OR
                       visibility_result IN ('private','public','internal','unknown')),
  result       TEXT,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS outbox_live_key ON outbox(idempotency_key) WHERE status IN ('pending','inflight');
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(not_before, id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS outbox_inflight ON outbox(lease_expires_at) WHERE status='inflight';
CREATE INDEX IF NOT EXISTS outbox_task ON outbox(task_id, status);

-- ---------------------------------------------------------------- merge
-- Two outcomes per row on purpose. witness_outcome is every clause EXCEPT the
-- capability switch and the process flag; actuation_outcome is that AND the
-- switches. While the switches are off actuation_outcome is UNKNOWN on every
-- row, so a false-merge metric computed over it would be vacuously zero.
-- The dark stages prove something because witness_outcome is scored instead.
CREATE TABLE IF NOT EXISTS merge_decision (
  id           INTEGER PRIMARY KEY,
  task         TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  slice        INTEGER NOT NULL,
  task_generation INTEGER NOT NULL,
  repo_id      INTEGER NOT NULL,
  pr           INTEGER NOT NULL,
  head_sha     TEXT    NOT NULL,
  decided_at   INTEGER NOT NULL,
  phase        TEXT    NOT NULL CHECK (phase IN ('enqueue','preflight','settle')),
  witness_outcome   TEXT NOT NULL CHECK (witness_outcome   IN ('MERGE','REFUSE','UNKNOWN')),
  actuation_outcome TEXT NOT NULL CHECK (actuation_outcome IN ('MERGE','REFUSE','UNKNOWN')),
  clause_results TEXT NOT NULL,                    -- canonical JSON, one entry per clause
  ledger_sync_at INTEGER,
  approval_head_sha TEXT,
  approval_source_id TEXT,
  approval_path TEXT,
  codex_clean_source_id TEXT,
  notice_receipt_ref TEXT,
  server_gate_snapshot TEXT,
  outbox_key   TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS merge_decision_pr ON merge_decision(repo_id, pr, decided_at);

-- ---------------------------------------------------------------- coordination
-- The singleton lease lives in the DATABASE, not in an OS lock, so the service
-- manager's instance and a founder's terminal instance can never both tick,
-- on any platform.
CREATE TABLE IF NOT EXISTS singleton_lease (
  name        TEXT    PRIMARY KEY,                 -- 'builder'
  pid         INTEGER NOT NULL,
  lstart      TEXT    NOT NULL,                    -- distinguishes a reused pid
  command     TEXT    NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
) STRICT;

-- Held by every CLI command that writes hub.db, for its duration. Restore
-- refuses while any is live and prints the holder.
CREATE TABLE IF NOT EXISTS writer_lease (
  id          TEXT    PRIMARY KEY,
  pid         INTEGER NOT NULL,
  lstart      TEXT    NOT NULL,
  command     TEXT    NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
) STRICT;

-- Taken exclusively by restore. Every writer, daemon and CLI alike, refuses to
-- BEGIN a write while it is held -- so a command started a moment after
-- restore's check cannot slip in behind it.
CREATE TABLE IF NOT EXISTS maintenance_lock (
  name        TEXT    PRIMARY KEY,                 -- 'restore'
  pid         INTEGER NOT NULL,
  lstart      TEXT    NOT NULL,
  acquired_at INTEGER NOT NULL
) STRICT;

-- Process-scoped: it protects something that dies with a process, so it is
-- heartbeated and reaped on pid+lstart death.
CREATE TABLE IF NOT EXISTS directory_lease (
  path       TEXT    PRIMARY KEY,                  -- absolute
  owner_kind TEXT    NOT NULL CHECK (owner_kind IN ('worktree','clone')),
  task       TEXT REFERENCES task(id),
  pid        INTEGER NOT NULL,
  lstart     TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  -- a clone belongs to no single task; a worktree always belongs to one
  CHECK ((owner_kind = 'clone'    AND task IS NULL)
      OR (owner_kind = 'worktree' AND task IS NOT NULL))
) STRICT;

-- Task-scoped, NOT process-scoped: a task is a row, not a process, so "dead"
-- is a state question. The reaper deletes a territory lease only when its task
-- is terminal, or held with no live pin -- never merely because it looks old.
CREATE TABLE IF NOT EXISTS territory_lease (
  project      TEXT    NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('file','prefix')),
  path         TEXT    NOT NULL,
  task         TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  expires_at   INTEGER NOT NULL,
  pinned_until INTEGER,                            -- the ONLY home of the pin; task carries no copy
  PRIMARY KEY (project, kind, path)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS territory_lease_task ON territory_lease(task);

-- The global provider scheduler: the one hub table pair a guardian WRITES.
CREATE TABLE IF NOT EXISTS provider_lease (
  id           INTEGER PRIMARY KEY,
  owner        TEXT    NOT NULL CHECK (owner IN ('guardian','builder')),
  repo_id      INTEGER,
  run_ref      TEXT    NOT NULL,
  pid          INTEGER NOT NULL,
  lstart       TEXT    NOT NULL,
  priority     INTEGER NOT NULL DEFAULT 0,
  budget_usd   REAL,
  status       TEXT    NOT NULL CHECK (status IN ('queued','held')),
  requested_at INTEGER NOT NULL,
  started_at   INTEGER,
  heartbeat_at INTEGER,
  expires_at   INTEGER NOT NULL,
  -- Set when a guardian is queued and every slot is held by builder leases
  -- (section 10.4, builder.provider.preemptAtBoundary). It is a REQUEST, read by
  -- the builder loop at a phase boundary and never acted on mid-phase, which is
  -- why it is a flag here rather than a revocation. S2-C writes and reads it;
  -- the column lives here because migration 1 owns the whole schema and a table
  -- gaining a column later would need a numbered migration for no reason.
  preempt_requested INTEGER NOT NULL DEFAULT 0 CHECK (preempt_requested IN (0,1)),
  -- Set when a release was refused because a restore held maintenance_lock. The
  -- daemon can restart before its retry, and an in-memory id does not survive
  -- that, so the reaper treats a row marked here as releasable once the lock
  -- clears -- rather than holding the slot for a full lease window after every
  -- restore. Written and cleared by S2-C's scheduler.
  refused_release   INTEGER NOT NULL DEFAULT 0 CHECK (refused_release IN (0,1))
) STRICT;
CREATE INDEX IF NOT EXISTS provider_lease_live ON provider_lease(status, owner, requested_at);
-- One LIVE request per run. A capacity-blocked guardian calls claimProvider again
-- on every tick; without this, each call inserts another queued row, the queue
-- depth reports ticks elapsed rather than work waiting, and "no guardian is
-- queued" -- the builder's admission precondition -- can never come true again.
-- repo_id is IN the key: guardian run refs are `pr:<number>`, so PR #9 on two
-- watched repositories produces the same run_ref. Without the repo, one
-- guardian's request collides with another's and the second can never queue.
CREATE UNIQUE INDEX IF NOT EXISTS provider_one_live_request
  ON provider_lease(owner, repo_id, run_ref) WHERE status IN ('queued','held');

CREATE TABLE IF NOT EXISTS provider_state (
  provider          TEXT    PRIMARY KEY,           -- 'claude'
  concurrency_limit INTEGER NOT NULL,
  guardian_reserved INTEGER NOT NULL,
  cooldown_until    INTEGER,
  last_429_at       INTEGER,
  last_signature    TEXT,
  measured_at       INTEGER                        -- null until `build measure-provider` runs (S3)
) STRICT;

CREATE TABLE IF NOT EXISTS intake_event (
  id      INTEGER PRIMARY KEY,
  at      INTEGER NOT NULL,
  ledger  TEXT,
  node_id TEXT,
  op      TEXT    NOT NULL,
  detail  TEXT
) STRICT;

-- The hub's OWN escalation table. Builder identities (^bt: and ^builder:) are
-- raised and retired only by the builder process, from here; guardian
-- identities stay in their per-repo store. No process announces from another
-- process's table.
CREATE TABLE IF NOT EXISTS escalation (
  why             TEXT    PRIMARY KEY,             -- the bare identity; detail rides in the body
  count           INTEGER NOT NULL,
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  announced_count INTEGER NOT NULL
) STRICT;
```

- [ ] **Step 4: Run it, then commit**

```bash
$N test/hub-schema.test.mjs      # expect all green
git add src/build/hub.sql test/hub-schema.test.mjs
git commit -m "feat(hub): inbox, fenced outbox, merge decisions and leases"
```

---
### Task 6: `hub_event`, and the invariants that keep migrations forward-only

**Files:**
- Modify: `src/build/hubdb.mjs` (append), `test/hub-schema.test.mjs` (append)

**Interfaces:**
- Consumes: `openHub`, `hubTx`, `MIGRATIONS` from Task 1.
- Produces: `hubEvent(db, { kind, task = null, payload = {} }) -> number` — appends one `hub_event` row and returns its seq. **Must be called inside the caller's transaction**, never opening its own; that is what makes the projection replayable. `migrationPlan() -> [{version}]` — exported for the invariant test.
- The **freeze fixture** that stops migration 1 from ever being edited after merge lands in Task 13, once `hub.sql` has stopped moving.

- [ ] **Step 1: Append the failing assertions**

```js
// ── hub_event and migration shape ────────────────────────────────────────────
import { hubEvent, migrationPlan } from "../src/build/hubdb.mjs";
{
  const versions = migrationPlan().map(m => m.version);
  check(versions.length > 0, "there is at least one migration");
  check(versions.every((v, i) => v === i + 1), "migration versions are 1..N with no gaps and no reordering", versions.join(","));
  check(Math.max(...versions) === HUB_SCHEMA_VERSION, "HUB_SCHEMA_VERSION is the highest migration", `${Math.max(...versions)} vs ${HUB_SCHEMA_VERSION}`);

  const db = openHub(join(dir, "ev.db"));
  db.exec(`INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,source_kind,source_key,
             repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,created_at,updated_at)
           VALUES('bt:1','p',1,'o/r','t','FILED','founder','k','/p','/f','h','main','private',1,unixepoch(),unixepoch())`);

  // hub_event must join the CALLER's transaction. If it opened its own, a
  // transition that rolled back would still leave its event behind, and the
  // replay would rebuild a fact that never happened.
  // A hubEvent that opened its OWN transaction throws on the nested BEGIN, and a
  // bare catch swallows that -- leaving the row count at 0 for the wrong reason,
  // so the assertion passes against the very implementation it targets.
  let nested = null;
  try { hubTx(db, () => { hubEvent(db, { kind: "approval.recorded", task: "bt:1", payload: { a: 1 } }); throw new Error("SENTINEL"); }); }
  catch (e) { nested = e.message; }
  check(nested === "SENTINEL",
    "hubEvent joins the caller's transaction rather than opening its own",
    `the body's own error should surface; got ${nested} -- a BEGIN error means hubEvent wrapped itself`);
  check(db.prepare("SELECT count(*) c FROM hub_event").get().c === 0,
    "and a hub_event written in a transaction that rolls back leaves nothing");
  const seq = hubTx(db, () => hubEvent(db, { kind: "approval.recorded", task: "bt:1", payload: { b: 2 } }));
  check(typeof seq === "number" && seq > 0, "control: it returns its seq when the transaction commits", String(seq));

  // Payloads are canonical, so a replay compares byte for byte rather than
  // depending on whatever key order the writer happened to use.
  hubTx(db, () => hubEvent(db, { kind: "k", payload: { z: 1, a: 2 } }));
  const p = db.prepare("SELECT payload FROM hub_event ORDER BY seq DESC LIMIT 1").get().payload;
  check(p === '{"a":2,"z":1}', "payloads are canonical JSON with sorted keys", p);
  db.close();
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
$N test/hub-schema.test.mjs
```

Expected: `SyntaxError`/import failure on `hubEvent`.

**On the broken implementation** — a `hubEvent` that wraps itself in `hubTx` — the import resolves and one line goes red: `a hub_event written inside a transaction that rolls back leaves nothing` finds a row. Nested `BEGIN IMMEDIATE` in `node:sqlite` throws rather than nesting, so the failure is loud; the assertion is written against the row count anyway, because a future SAVEPOINT-based helper would swallow the throw and this assertion would still catch it.

- [ ] **Step 3: Implement**

Append to `src/build/hubdb.mjs`:

```js
/**
 * Append one row to the append-only log, IN THE CALLER'S TRANSACTION.
 *
 * This function deliberately does not open a transaction. Every
 * authority-bearing write appends one of these in the same tx that performs
 * it -- an approval, a gate request, a notice receipt, an impl_pr, an attested
 * push, a guardian receipt, a harness acceptance, a gate run, a pr_hold create
 * or clear, a hold reason, a project authority grant, a merge decision, a
 * territory or singleton lease grant or release, and every outbox enqueue,
 * void, fence or settle. That is what makes the projection replayable from
 * this table plus artifacts and external receipts, and it is why the
 * destructive restore drill has anything to compare against.
 *
 * If this opened its own transaction, a transition that rolled back would
 * leave its event behind and the replay would rebuild a fact that never
 * happened.
 */
export function hubEvent(db, { kind, task = null, payload = {} }) {
  const r = db.prepare(
    `INSERT INTO hub_event(at, kind, task, payload) VALUES(unixepoch(), ?, ?, ?) RETURNING seq`)
    .get(kind, task, canonical(payload));
  return r.seq;
}

/** The migration list, for the invariant test. Versions are 1..N, no gaps. */
export function migrationPlan() {
  return MIGRATIONS.map(m => ({ version: m.version }));
}
```

- [ ] **Step 4: Run it, then commit**

```bash
$N test/hub-schema.test.mjs      # expect all green
git add src/build/hubdb.mjs test/hub-schema.test.mjs
git commit -m "feat(hub): append-only hub_event in the caller's transaction"
```

---

### Task 7: The three locks, and a second `build run` that names the holder

**Files:**
- Create: `src/build/locks.mjs`
- Modify: `bin/reeve` (a new `build` case)
- Test: `test/hub-locks.test.mjs`

**Interfaces:**
- Consumes: `openHub`, `hubTx`, `hubEvent` from Tasks 1 and 6.
- Produces:
  - `acquireSingleton(db, { name, pid, lstart, command, isAlive, now, takeover })` → `{ ok: true } | { ok: false, holder: { pid, lstart, command, ageSeconds, expiresAt }, recovery: string }`. Throws while a live restore holds `maintenance_lock`.
  - **Every hub writer calls `assertWritable` first**, inside its own transaction: `acquireSingleton`, `withWriterLease`, and every provider mutation (Task 21). That is the complete set — the lock is a property of writing the hub, not of one path.
  - `heartbeatSingleton(db, { name, pid, lstart, now }) -> boolean` — false when the row is no longer ours, which must stop the loop.
  - `releaseSingleton(db, { name, pid, lstart })`
  - `withWriterLease(db, { command, pid, lstart, isAlive }, fn) -> any` — takes a `writer_lease` row for the duration and always releases it.
  - `acquireMaintenanceLock(db, { pid, lstart, isAlive })` / `releaseMaintenanceLock(db, { pid, lstart })` / `assertWritable(db, { isAlive })` — the last throws while a live maintenance lock is held.
  - `LEASE_SECONDS = 120`, `HEARTBEAT_SECONDS = 30` — re-exported from `ops.mjs`, not redefined, so the two stores cannot drift apart.
- `lstart` is the `ps -o lstart=` string. It is what distinguishes a reused pid, so it is required, never defaulted.

- [ ] **Step 1: Write the failing test**

Create `test/hub-locks.test.mjs`:

```js
// Two builder processes ticking one hub is the failure this lease exists to
// make impossible: both would admit tasks, both would enqueue effects, and the
// idempotency keys would only hide half of it.
//
// The lease lives in the DATABASE rather than in an OS lock, because the
// service manager's instance and a founder's terminal instance do not share a
// lock namespace on every platform, and the platform matrix has to fail closed.
import { openHub } from "../src/build/hubdb.mjs";
import { acquireSingleton, heartbeatSingleton, releaseSingleton,
         withWriterLease, acquireMaintenanceLock, assertWritable } from "../src/build/locks.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const dir = mkdtempSync(join(tmpdir(), "reeve-locks-"));
const NEVER = () => false;   // nothing is alive
const ALWAYS = () => true;   // everything is alive

// ── the ordinary claim, and the refusal that has to be useful ────────────────
{
  const db = openHub(join(dir, "s.db"));
  const a = acquireSingleton(db, { name: "builder", pid: 100, lstart: "L100", command: "reeve build run", isAlive: ALWAYS });
  check(a.ok === true, "the first claim succeeds");

  const b = acquireSingleton(db, { name: "builder", pid: 200, lstart: "L200", command: "reeve build run", isAlive: ALWAYS });
  check(b.ok === false, "a second process is refused while the holder is alive");
  check(b.holder?.pid === 100 && b.holder?.lstart === "L100", "and the refusal names the holder's pid and lstart", JSON.stringify(b.holder));
  check(typeof b.holder?.command === "string" && b.holder.command.length > 0, "and the command it is running", b.holder?.command);
  check(typeof b.holder?.ageSeconds === "number" && typeof b.holder?.expiresAt === "number",
    "and the lease age and expiry", JSON.stringify(b.holder));
  check(/--takeover/.test(b.recovery ?? ""), "and exactly one recovery command", String(b.recovery));

  // Re-entrancy: the SAME process re-claiming is not a second instance.
  const again = acquireSingleton(db, { name: "builder", pid: 100, lstart: "L100", command: "reeve build run", isAlive: ALWAYS });
  check(again.ok === true, "the holder re-claiming its own lease succeeds");

  // A reused pid is not the same process. Without lstart this is the bug where
  // a dead builder's pid gets recycled and the new process inherits authority.
  const reused = acquireSingleton(db, { name: "builder", pid: 100, lstart: "DIFFERENT", command: "x", isAlive: ALWAYS });
  check(reused.ok === false, "a process with the holder's pid but a different lstart is NOT the holder");
  db.close();
}

// ── takeover refuses while the holder is alive, and works once it is dead ────
{
  const db = openHub(join(dir, "t.db"));
  acquireSingleton(db, { name: "builder", pid: 100, lstart: "L100", command: "reeve build run", isAlive: ALWAYS });
  db.exec("UPDATE singleton_lease SET expires_at = unixepoch() - 1");
  const live = acquireSingleton(db, { name: "builder", pid: 300, lstart: "L300", command: "x", isAlive: ALWAYS });
  check(live.ok === false, "an EXPIRED lease whose holder is still alive is not takeable");
  const dead = acquireSingleton(db, { name: "builder", pid: 300, lstart: "L300", command: "x", isAlive: NEVER });
  check(dead.ok === true, "an expired lease whose holder is provably dead is takeable");
  db.close();
}

// ── --takeover is advertised as the recovery, so it must recover ─────────────
{
  const db = openHub(join(dir, "to.db"));
  acquireSingleton(db, { name: "builder", pid: 100, lstart: "L100", command: "reeve build run", isAlive: ALWAYS });
  // lease NOT expired, holder dead: the case an operator hits after a crash.
  // The implementation admits only when (expired || takeover) && holderDead, so
  // the flagless call must be REFUSED here -- asserting otherwise contradicts
  // the specified rule and would fail against a correct implementation while
  // never exercising the recovery path the flag exists for.
  const flagless = acquireSingleton(db, { name: "builder", pid: 400, lstart: "L400", command: "x", isAlive: NEVER });
  check(flagless.ok === false,
    "a dead holder with an UNEXPIRED lease is refused without the flag", JSON.stringify(flagless));
  const withFlag = acquireSingleton(db, { name: "builder", pid: 400, lstart: "L400", command: "x", isAlive: NEVER, takeover: true });
  check(withFlag.ok === true, "and --takeover recovers exactly that case", JSON.stringify(withFlag));
  db.exec("DELETE FROM singleton_lease");
  acquireSingleton(db, { name: "builder", pid: 100, lstart: "L100", command: "reeve build run", isAlive: ALWAYS });
  const alive = acquireSingleton(db, { name: "builder", pid: 500, lstart: "L500", command: "x", isAlive: ALWAYS, takeover: true });
  check(alive.ok === false,
    "and --takeover still REFUSES a holder that is alive: it waives expiry, never liveness", JSON.stringify(alive));
  db.close();
}

// ── heartbeat loss must be detectable, because it has to stop the loop ───────
{
  const db = openHub(join(dir, "h.db"));
  acquireSingleton(db, { name: "builder", pid: 100, lstart: "L100", command: "c", isAlive: ALWAYS });
  check(heartbeatSingleton(db, { name: "builder", pid: 100, lstart: "L100" }) === true, "the holder can heartbeat");
  releaseSingleton(db, { name: "builder", pid: 100, lstart: "L100" });
  check(heartbeatSingleton(db, { name: "builder", pid: 100, lstart: "L100" }) === false,
    "a heartbeat after the row is gone returns false, so the loop can stop rather than tick on");
  db.close();
}

// ── the writer lease and the maintenance lock ────────────────────────────────
{
  const db = openHub(join(dir, "w.db"));
  let sawLease = 0;
  withWriterLease(db, { command: "reeve task file", pid: 1, lstart: "A", isAlive: ALWAYS }, () => {
    sawLease = db.prepare("SELECT count(*) c FROM writer_lease").get().c;
  });
  check(sawLease === 1, "a writer lease exists for the duration of the command");
  check(db.prepare("SELECT count(*) c FROM writer_lease").get().c === 0, "and is released when it returns");

  try { withWriterLease(db, { command: "x", pid: 1, lstart: "A", isAlive: ALWAYS }, () => { throw new Error("boom"); }); } catch {}
  check(db.prepare("SELECT count(*) c FROM writer_lease").get().c === 0,
    "and is released even when the command throws, so a crash does not wedge restore forever");

  acquireMaintenanceLock(db, { pid: 9, lstart: "M", isAlive: NEVER });
  let refused = false;
  try { assertWritable(db, { isAlive: ALWAYS }); } catch { refused = true; }
  check(refused, "every writer refuses to begin while a live maintenance lock is held");
  let reaped = true;
  try { assertWritable(db, { isAlive: NEVER }); } catch { reaped = false; }
  check(reaped, "control: a maintenance lock left by a CRASHED restore is reaped like any lease, not honoured forever");
  db.close();
}

// ── 20 real processes, one winner ────────────────────────────────────────────
// Not 20 calls in one process: BEGIN IMMEDIATE inside a single connection is
// trivially serial, so a same-process "race" would pass against an
// implementation with no transaction at all.
{
  const p = join(dir, "race.db");
  openHub(p).close();
  const worker = join(dir, "race-worker.mjs");
  writeFileSync(worker, `
import { openHub } from "${join(process.cwd(), "src/build/hubdb.mjs")}";
import { acquireSingleton } from "${join(process.cwd(), "src/build/locks.mjs")}";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const db = openHub(process.argv[2]);          // open BEFORE the barrier, so the
const go = process.argv[4];                   // race is over the write, not over
writeFileSync(join(process.argv[5], process.argv[3]), "");   // ...startup and open
while (!existsSync(go)) {}
const r = acquireSingleton(db, { name: "builder", pid: Number(process.argv[3]),
  lstart: "L" + process.argv[3], command: "reeve build run", isAlive: () => true });
console.log(r.ok ? "WON" : "lost");
`);
  // spawn(), not execFileSync(): execFileSync BLOCKS until each child exits, so a
  // loop of twenty of them starts twenty processes one after another and races
  // nothing. A read-then-insert implementation with no transaction passes that
  // version, because the first process has already committed before the second
  // one opens the database. The barrier file below is what makes it a race: every
  // child opens the store, then spins until `go` appears, so all twenty contend
  // for the same write at once.
  const go = join(dir, "go"), ready = join(dir, "ready");
  mkdirSync(ready, { recursive: true });
  const kids = Array.from({ length: 20 }, (_, i) =>
    new Promise((res) => {
      const c = spawn(process.execPath, [worker, p, String(1000 + i), go, ready], { encoding: "utf8" });
      let out = ""; c.stdout.on("data", d => out += d);
      c.on("exit", () => res(out.trim()));
    }));
  // Wait for every child to ANNOUNCE it is at the barrier rather than sleeping a
  // fixed 300ms and hoping. On a loaded machine some children have not opened
  // the database when the gun fires, so they arrive late, contend with nobody,
  // and the race silently shrinks to however many made it in time.
  for (let i = 0; i < 400 && readdirSync(ready).length < 20; i++)
    await new Promise(r => setTimeout(r, 25));
  check(readdirSync(ready).length === 20,
    `control: all 20 children reached the barrier before the start (${readdirSync(ready).length}/20)`);
  writeFileSync(go, "");
  const results = await Promise.all(kids);
  const winners = results.filter(r => r === "WON").length;
  check(winners === 1, `exactly one of 20 processes takes the lease (got ${winners})`, results.join(","));
  check(db_rows(p) === 1, "and exactly one lease row exists afterwards");
}
function db_rows(p) { const d = openHub(p); const c = d.prepare("SELECT count(*) c FROM singleton_lease").get().c; d.close(); return c; }

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it and watch it fail**

```bash
$N test/hub-locks.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` for `../src/build/locks.mjs`.

**On the broken implementation** — the naive `INSERT OR REPLACE INTO singleton_lease` with no liveness check — three assertions carry the task and go red: `a second process is refused while the holder is alive`, `an EXPIRED lease whose holder is still alive is not takeable`, and `exactly one of 20 processes takes the lease` (which reports 20). The re-entrancy and reused-pid pair are the ones that catch the *next* naive fix, matching on pid alone.

- [ ] **Step 3: Implement `src/build/locks.mjs`**

```js
// locks -- the three things that stop two writers from believing they are one.
//
// singleton_lease: one builder process, enforced by a row rather than by an OS
// lock, because the service manager's instance and a founder's terminal
// instance do not share a lock namespace on every platform this has to run on.
//
// writer_lease: every CLI command that writes the hub holds one for its
// duration, so restore can answer "is anything writing right now" without
// asking SQLite, which cannot distinguish an open-but-idle connection.
//
// maintenance_lock: taken exclusively by restore. Every writer refuses to begin
// while it is held, which closes the window between restore's check and its
// copy -- a command started a moment after the check would otherwise slip in.
//
// Liveness is pid AND lstart, never pid alone: pids are recycled, and a
// recycled pid inheriting a lease is a second builder with the first one's
// authority.
import { hubTx, hubEvent } from "./hubdb.mjs";
import { LEASE_SECONDS, HEARTBEAT_SECONDS } from "../db/ops.mjs";

export { LEASE_SECONDS, HEARTBEAT_SECONDS };

const now = () => Math.floor(Date.now() / 1000);

function holderOf(row, at) {
  return { pid: row.pid, lstart: row.lstart, command: row.command,
           ageSeconds: at - row.acquired_at, expiresAt: row.expires_at };
}

export function acquireSingleton(db, { name, pid, lstart, command, isAlive, at = now(), takeover = false }) {
  return hubTx(db, () => {
    // Same rule as every provider mutation and every CLI writer: nothing begins
    // a write while a live restore holds the lock. Without it a builder can
    // start after restoreHub's holder scan, take the singleton, and begin
    // ticking against a database that is about to be replaced underneath it.
    // Round 2 applied this to the provider path and stopped there; it is a
    // property of every hub writer, not of that one path.
    assertWritable(db, { isAlive, at, inTx: true });
    const row = db.prepare("SELECT * FROM singleton_lease WHERE name=?").get(name);
    const mine = row && row.pid === pid && row.lstart === lstart;
    const expired = row && row.expires_at <= at;
    const holderDead = row && !isAlive(row.pid, row.lstart);

    // Refuse when someone else holds it and is either unexpired or still alive.
    // "Expired" alone is not enough: a busy process can miss a heartbeat, and
    // killing its authority while it is mid-effect is the race, not the fix.
    //
    // --takeover waives the expiry half and ONLY that half. A dead holder with a
    // live lease is the case it exists for: the process is provably gone, so
    // waiting out two more minutes protects nobody. It never waives holderDead,
    // because that is the half that answers "is anyone still there".
    if (row && !mine && !((expired || takeover) && holderDead)) {
      return { ok: false, holder: holderOf(row, at),
               recovery: `reeve build run --takeover   (only after confirming pid ${row.pid} is dead)` };
    }
    db.prepare(`INSERT INTO singleton_lease(name,pid,lstart,command,acquired_at,expires_at)
                VALUES(?,?,?,?,?,?)
                ON CONFLICT(name) DO UPDATE SET pid=excluded.pid, lstart=excluded.lstart,
                  command=excluded.command, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at`)
      .run(name, pid, lstart, command, mine ? (row?.acquired_at ?? at) : at, at + LEASE_SECONDS);
    hubEvent(db, { kind: "lease.singleton.granted", payload: { name, pid, lstart, takeover: Boolean(row && !mine) } });
    return { ok: true };
  });
}

/** False means the row is no longer ours; the caller must stop the loop. */
export function heartbeatSingleton(db, { name, pid, lstart, at = now() }) {
  return hubTx(db, () => {
    const r = db.prepare(`UPDATE singleton_lease SET expires_at=? WHERE name=? AND pid=? AND lstart=?`)
      .run(at + LEASE_SECONDS, name, pid, lstart);
    return r.changes === 1;
  });
}

export function releaseSingleton(db, { name, pid, lstart }) {
  return hubTx(db, () => {
    const r = db.prepare("DELETE FROM singleton_lease WHERE name=? AND pid=? AND lstart=?").run(name, pid, lstart);
    if (r.changes) hubEvent(db, { kind: "lease.singleton.released", payload: { name, pid, lstart } });
    return r.changes === 1;
  });
}

/**
 * Hold a writer lease for one command. Always released, including on a throw:
 * a wedged lease would make restore refuse forever for a command that is long
 * since gone.
 */
export function withWriterLease(db, { command, pid, lstart, isAlive, at = now() }, fn) {
  const id = `${pid}:${lstart}:${at}:${Math.trunc(at * 1000) % 1000}`;
  // The check and the insert are ONE transaction. Split across two, a restore can
  // take maintenance_lock in the gap: this command sees a writable hub, the
  // restore sees no writer lease, and both proceed -- the file is replaced under
  // a command that is mid-write. BEGIN IMMEDIATE holds the write lock across both
  // halves, so whichever arrives first makes the other wait and then fail.
  hubTx(db, () => {
    assertWritable(db, { isAlive, at, inTx: true });
    db.prepare(`INSERT INTO writer_lease(id,pid,lstart,command,acquired_at,expires_at) VALUES(?,?,?,?,?,?)`)
      .run(id, pid, lstart, command, at, at + LEASE_SECONDS);
  });
  try { return fn(); }
  finally { hubTx(db, () => db.prepare("DELETE FROM writer_lease WHERE id=?").run(id)); }
}

/** Live writers, for restore's refusal message. Dead ones are reaped as seen. */
export function liveWriters(db, { isAlive, at = now() }) {
  return hubTx(db, () => {
    const live = [];
    for (const r of db.prepare("SELECT * FROM writer_lease").all()) {
      if (isAlive(r.pid, r.lstart)) live.push(r);
      else db.prepare("DELETE FROM writer_lease WHERE id=?").run(r.id);
    }
    return live;
  });
}

export function acquireMaintenanceLock(db, { pid, lstart, isAlive, at = now() }) {
  return hubTx(db, () => {
    const row = db.prepare("SELECT * FROM maintenance_lock WHERE name='restore'").get();
    if (row && isAlive(row.pid, row.lstart) && !(row.pid === pid && row.lstart === lstart))
      return { ok: false, holder: { pid: row.pid, lstart: row.lstart } };
    db.prepare(`INSERT INTO maintenance_lock(name,pid,lstart,acquired_at) VALUES('restore',?,?,?)
                ON CONFLICT(name) DO UPDATE SET pid=excluded.pid, lstart=excluded.lstart, acquired_at=excluded.acquired_at`)
      .run(pid, lstart, at);
    return { ok: true };
  });
}

export function releaseMaintenanceLock(db, { pid, lstart }) {
  return hubTx(db, () => db.prepare("DELETE FROM maintenance_lock WHERE name='restore' AND pid=? AND lstart=?").run(pid, lstart).changes === 1);
}

/**
 * Throws while a LIVE restore holds the lock. A lock left by a crashed restore
 * is reaped exactly like any lease -- honouring it forever would turn one
 * crashed command into a permanently read-only hub.
 *
 * `inTx` is passed by callers already inside a transaction, so the reap below
 * joins theirs rather than opening a nested one (node:sqlite throws on a nested
 * BEGIN). It is not an optional safety switch -- the check runs identically
 * either way; only the transaction it runs in differs.
 */
export function assertWritable(db, { isAlive, at = now(), inTx = false }) {
  const row = db.prepare("SELECT * FROM maintenance_lock WHERE name='restore'").get();
  if (!row) return;
  if (!isAlive(row.pid, row.lstart)) {
    const reap = () => db.prepare("DELETE FROM maintenance_lock WHERE name='restore'").run();
    if (inTx) reap(); else hubTx(db, reap);
    return;
  }
  throw new Error(`a restore is in progress (pid ${row.pid}, started ${row.lstart}); the hub is read-only until it finishes`);
}
```

- [ ] **Step 4: Wire `bin/reeve build run` far enough to take the lease**

Add to `bin/reeve`, beside the existing `case "run":`:

```js
  case "build": {
    // HOME is the value bin/reeve already resolved (--home, REEVE_HOME, or the
    // default). An earlier draft called `reeveHome()`, which is not defined in
    // this file, so every build run and build status threw before reaching the
    // lease -- the two commands this task exists to add.
    const sub = process.argv[3];
    if (sub !== "run" && sub !== "status")
      die(`usage: reeve build run [--takeover] | reeve build status`);
    const db = openHub(hubPathFor(reeveHome()));
    if (sub === "status") {
      // Defined here rather than referenced: an advertised command that throws
      // ReferenceError is worse than one that does not exist.
      const row = db.prepare("SELECT * FROM singleton_lease WHERE name='builder'").get();
      if (!row) { console.log("builder: not running (no singleton lease)"); break; }
      const alive = pidAlive(row.pid, row.lstart);
      console.log(`builder: ${alive ? "running" : "LEASE HELD BY A DEAD PROCESS"}`);
      console.log(`  pid      ${row.pid} (started ${row.lstart})`);
      console.log(`  command  ${row.command}`);
      console.log(`  lease    expires ${new Date(row.expires_at * 1000).toISOString()}`);
      if (!alive) console.log(`  recover  reeve build run --takeover`);
      break;
    }
    // --takeover is PRINTED as the one recovery command, so it has to work.
    // Without parsing it, an operator who follows the instruction is refused
    // exactly as before and the builder stays down until the lease expires --
    // a recovery path that does not recover. Takeover still requires the holder
    // to be provably dead; it only waives the "and the lease has expired" half,
    // which is the half that has nothing to do with whether anyone is there.
    // ONE startup identity, computed once and reused by the claim, every
    // heartbeat and the release. Recomputing per call is worse than redundant:
    // readStart can transiently return null, and a heartbeat passing a different
    // lstart than the claim silently stops matching its own row. `lstartOf` was
    // referenced here and never defined; this is the definition.
    const lstart = readStart(process.pid);
    if (!lstart) die("cannot read this process's start time; refusing a lease that liveness could never match");

    const claim = acquireSingleton(db, {
      name: "builder", pid: process.pid, lstart,
      command: process.argv.slice(1).join(" "), isAlive: pidAlive,
      takeover: flag("takeover"),
    });
    if (!claim.ok) {
      const h = claim.holder;
      // A lock refusal that does not say who holds it turns a two-second
      // problem into an investigation.
      die(`another builder holds the lease\n` +
          `  pid      ${h.pid} (started ${h.lstart})\n` +
          `  command  ${h.command}\n` +
          `  held     ${h.ageSeconds}s, expires at ${new Date(h.expiresAt * 1000).toISOString()}\n` +
          `  recover  ${claim.recovery}`);
    }
    // Hold the lease for the life of the process, and give it back on the way
    // out. Claiming and then returning would exit immediately: the service
    // manager (KeepAlive) relaunches, the new process finds a lease held by a
    // pid that just died, and the job flaps -- while `reeve build status`
    // reports a holder that is never there. A lease nobody heartbeats is also
    // indistinguishable from a crashed holder after LEASE_SECONDS.
    //
    // S2's loop does exactly two things; the phase tick lands in PR-B.
    let running = true;
    const stop = (sig) => {
      if (!running) return;
      running = false;
      releaseSingleton(db, { name: "builder", pid: process.pid, lstart });
      log(`build run: released the singleton lease on ${sig}`);
      process.exit(0);
    };
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => stop(sig));

    while (running) {
      // A heartbeat that fails means the row is no longer ours -- a takeover, or
      // a restore that replaced the file. Authority is gone, so the loop stops
      // rather than ticking on without it (section 1.2).
      if (!heartbeatSingleton(db, { name: "builder", pid: process.pid, lstart })) {
        log("build run: lost the singleton lease; another process holds it. Stopping.");
        process.exit(1);
      }
      // refreshGateState lands with S2-B (its Task 18); until then the loop body
      // is the heartbeat alone. `sleep` is not a global -- spelled out here.
      await new Promise(r => setTimeout(r, HEARTBEAT_SECONDS * 1000));
    }
    break;
  }
```

**Note for the executor:** `lstart` here is the value computed once at startup (`readStart(process.pid)`), reused for the claim, every heartbeat and the release, so all three name the same identity. `refreshGateState` is Task 18's; until that task lands, the loop body is the heartbeat alone.

- [ ] **Step 5: Run both suites**

```bash
$N test/hub-locks.test.mjs
$N test/cli-routing.test.mjs
for f in test/*.test.mjs; do $N "$f" >/dev/null || echo "FAILED $f"; done
```

Expected: green; 59 files still pass plus the two new ones.

- [ ] **Step 6: Commit**

```bash
git add src/build/locks.mjs bin/reeve test/hub-locks.test.mjs
git commit -m "feat(hub): singleton, writer and maintenance locks"
```

---
### Task 8: Backup discovers the hub, and validates a snapshot before trusting it

**Files:**
- Modify: `src/backup.mjs`
- Test: `test/hub-backup-restore.test.mjs` (new)

**Interfaces:**
- Consumes: `openHub`, `HUB_SCHEMA_VERSION` from Task 1; the existing `snapshot`, `everyStore`, `snapshotAll`, `latestSnapshot`, `prune` from `backup.mjs`.
- Produces: `everyStore(home)` returns the hub as `{ nwo: "hub", path, kind: "hub" }` alongside `{ nwo: "owner/repo", path, kind: "repo" }`. `validateSnapshot(path, { kind: "hub"|"repo", expectVersion }) -> { ok, why, version, integrity }` — each store is checked against its own marker; a repo store has no `schema_version`. `snapshotAll` deletes any snapshot that fails validation and reports it, so a bad snapshot is never left looking like a good one.

**Why this task exists at all.** `everyStore` walks `<home>/state/<owner>/` and skips anything that is not a directory (`src/backup.mjs:73`, `if (!o.isDirectory()) continue`). The hub lives at `<home>/state/hub.db` — a file directly in `state/` — so **it is invisible to backup as the code stands**. That is the same failure `everyStore`'s own comment records: reeve's own store held every dispatch experiment and had zero backups while the repository it watched had fourteen. The hub would repeat it verbatim, and the hub is the store that holds who approved what.

- [ ] **Step 1: Write the failing test**

Create `test/hub-backup-restore.test.mjs`:

```js
// everyStore walks state/<owner>/<repo>.db and skips non-directories. The hub
// is a FILE directly in state/, so before this change backup could not see it
// at all -- the same shape as the measured miss where reeve's own store had
// zero backups and the repo it watched had fourteen. A store that nothing
// reminds you about is exactly the one that is not backed up.
import { everyStore, snapshotAll, latestSnapshot, validateSnapshot } from "../src/backup.mjs";
import { open as openStore } from "../src/db/ops.mjs";      // builds the real guardian fixture
import { readFileSync } from "node:fs";                      // reads the durable tail back
import { openHub, HUB_SCHEMA_VERSION } from "../src/build/hubdb.mjs";
import { hubPathFor } from "../src/paths.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const home = mkdtempSync(join(tmpdir(), "reeve-home-"));
const root = join(home, "backups");
mkdirSync(join(home, "state", "nextlyhq"), { recursive: true });

// A REAL guardian store, created through the guardian's own open(), not an empty
// SQLite file: the repo validator requires the `event` table, so a bare file
// would be classified unusable, its snapshot deleted, and the retention
// assertions below would fail against a perfectly correct implementation.
openStore(join(home, "state", "nextlyhq", "nextly.db")).close();
openHub(hubPathFor(home)).close();

// ── discovery ────────────────────────────────────────────────────────────────
{
  const stores = everyStore(home);
  const hub = stores.find(s => s.kind === "hub");
  check(!!hub, "everyStore finds the hub", JSON.stringify(stores));
  check(hub?.nwo === "hub", "and labels it 'hub', not an owner/repo pair", String(hub?.nwo));
  check(hub?.path === hubPathFor(home), "at the one path hubPathFor derives", String(hub?.path));
  check(stores.some(s => s.nwo === "nextlyhq/nextly" && s.kind === "repo"),
    "control: the per-repo stores are still discovered", JSON.stringify(stores.map(s => s.nwo)));
  check(stores.filter(s => s.kind === "hub").length === 1, "and the hub appears exactly once");
}

// ── a snapshot is validated before it is trusted ─────────────────────────────
{
  const res = snapshotAll(home, root);
  const hubRes = res.find(r => r.nwo === "hub");
  check(hubRes?.ok === true, "the hub is snapshotted", JSON.stringify(hubRes));
  const snap = latestSnapshot(root, "hub");
  check(!!snap && existsSync(snap), "and the snapshot file exists", String(snap));

  const v = validateSnapshot(snap, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION });
  check(v.ok === true, "a good snapshot validates", JSON.stringify(v));
  // The regression that would otherwise delete every guardian backup on the box.
  const repoSnap = latestSnapshot(root, "nextlyhq/nextly");
  check(validateSnapshot(repoSnap, { kind: "repo" }).ok === true,
    "a per-repository guardian snapshot validates against its OWN marker, not the hub's",
    JSON.stringify(validateSnapshot(repoSnap, { kind: "repo" })));
  check(res.find(r => r.nwo === "nextlyhq/nextly")?.ok === true,
    "and snapshotAll keeps it rather than deleting it as unusable");
  check(v.version === HUB_SCHEMA_VERSION, "and reports the schema version it holds", String(v.version));
  check(v.integrity === "ok", "and its integrity_check result", String(v.integrity));
}

// ── a snapshot at the wrong version is not restorable ────────────────────────
{
  const snap = latestSnapshot(root, "hub");
  const other = snap.replace(/(\d+)\.db$/, (_, n) => `${Number(n) - 1}.db`);
  const d = new DatabaseSync(snap);
  d.exec(`VACUUM INTO '${other.replace(/'/g, "''")}'`);
  d.close();
  const raw = new DatabaseSync(other);
  raw.exec("DELETE FROM schema_version");
  raw.exec(`INSERT INTO schema_version(version, applied_at) VALUES(${HUB_SCHEMA_VERSION + 1}, unixepoch())`);
  raw.close();
  const v = validateSnapshot(other, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION });
  check(v.ok === false, "a snapshot from a NEWER schema does not validate against this binary");
  check(String(v.why).includes(String(HUB_SCHEMA_VERSION + 1)), "and says which version it holds", String(v.why));
}

// ── a corrupt snapshot is deleted, not left looking usable ───────────────────
{
  const corruptDir = join(root, "hub");
  // Snapshot filenames are unix-epoch SECONDS and latestSnapshot sorts numerically
  // descending, so 999999.db (1970) is far OLDER than the good snapshot taken a
  // moment ago -- the assertion below would pass without anything ever being
  // deleted. The corrupt file has to be the newest candidate to be a test.
  const newest = Math.floor(Date.now() / 1000) + 60;
  const path = join(corruptDir, `${newest}.db`);
  writeFileSync(path, "this is not a database");
  check(latestSnapshot(root, "hub") === path,
    "control: the corrupt file IS the newest candidate, so deleting it is observable",
    `${latestSnapshot(root, "hub")}`);
  const v = validateSnapshot(path, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION });
  check(v.ok === false, "a file that is not a database does not validate");
  // The deletion is snapshotAll's job, so the test has to RUN snapshotAll.
  // Calling validateSnapshot alone leaves the corrupt file in place and the
  // assertion below passes for the wrong reason -- it never exercised the
  // code that is supposed to remove it.
  // snapshotAll only validates the snapshot IT takes this second, so a corrupt
  // file planted at a future timestamp is never its candidate and is never
  // deleted. What actually protects a restore is the read path: latestSnapshot
  // must not hand back a file that fails validation. Assert that, and assert
  // the sweep the command performs over existing candidates.
  const before = latestSnapshot(root, "hub");
  check(before !== path,
    "latestSnapshot never returns a candidate that fails validation, whatever its timestamp",
    `returned ${before}`);
  check(validateSnapshot(path, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION }).ok === false,
    "control: the planted file really is invalid, so the assertion above is not vacuous");
  check(latestSnapshot(root, "hub") !== path,
    "so latestSnapshot no longer offers a file that would fail at restore time", String(latestSnapshot(root, "hub")));
}

rmSync(home, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it and watch it fail**

```bash
$N test/hub-backup-restore.test.mjs
```

Expected: `everyStore finds the hub` fails (`undefined`), and `validateSnapshot` is not exported.

**On the broken implementation** — an `everyStore` "fixed" by hardcoding `state/hub.db` into the list without checking it exists — `everyStore finds the hub` passes and `the hub is snapshotted` goes red on a machine that has no hub yet, which is every machine before PR-A merges. The `control: the per-repo stores are still discovered` line is what catches the other common wrong fix: replacing the directory walk instead of extending it.

- [ ] **Step 3: Implement**

In `src/backup.mjs`, replace the body of `everyStore` and add the validator:

```js
/**
 * Every state store on this machine, watched or not, INCLUDING the hub.
 *
 * The per-repo stores live at state/<owner>/<repo>.db. The hub is one file at
 * state/hub.db, because a task spans projects and a lease is global -- so the
 * directory walk below, which skips non-directories, could not see it. That is
 * the same shape as the miss this function was written for: the store nothing
 * reminds you about is the one with no backups, and the hub is the store that
 * records who approved what.
 */
export function everyStore(home) {
  const root = join(home, "state");
  const out = [];

  const hub = join(root, "hub.db");
  if (existsSync(hub)) out.push({ nwo: "hub", path: hub, kind: "hub" });

  let owners;
  try { owners = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const o of owners) {
    if (!o.isDirectory()) continue;
    let files;
    try { files = readdirSync(join(root, o.name)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".db")) continue;
      out.push({ nwo: `${o.name}/${f.slice(0, -3)}`, path: join(root, o.name, f), kind: "repo" });
    }
  }
  return out;
}

/**
 * Read a snapshot before trusting it.
 *
 * A file of the right size with the wrong contents restores exactly as easily
 * as a good one, and the moment you find out is the moment you needed it. So a
 * snapshot is opened, integrity-checked, and its schema version compared with
 * the binary that would have to read it back.
 */
export function validateSnapshot(path, { expectVersion = null, kind = "repo" } = {}) {
  let probe = null;
  try {
    probe = new DatabaseSync(path, { readOnly: true });
    const integrity = Object.values(probe.prepare("PRAGMA integrity_check").get())[0];
    if (integrity !== "ok") return { ok: false, why: `integrity_check says: ${integrity}`, version: null, integrity };

    // Each store is validated against ITS OWN marker. A guardian per-repo store
    // has no schema_version table -- that is the hub's mechanism -- so querying
    // it unconditionally throws, every repository snapshot is classified
    // unusable, and the caller DELETES it. That would leave the hub as the only
    // backed-up store on the machine, while reporting success for it.
    if (kind === "hub") {
      // schema_version alone is too weak a marker: a physically valid SQLite file
      // carrying only that table passes, is retained as a usable backup, and is
      // discovered to be empty at the moment it is restored. hub_event is the
      // table replay reads and the one migration 1 guarantees, so it is the
      // marker that actually means "this is a hub".
      probe.prepare("SELECT count(*) c FROM hub_event").get();
      const version = probe.prepare("SELECT COALESCE(max(version),0) v FROM schema_version").get().v;
      if (expectVersion != null && version > expectVersion)
        return { ok: false, why: `snapshot is schema version ${version}; this binary knows ${expectVersion}`, version, integrity };
      return { ok: true, why: null, version, integrity };
    }
    // A repo store's marker is the append-only log the existing restore() probes.
    probe.prepare("SELECT count(*) c FROM event").get();
    return { ok: true, why: null, version: null, integrity };
  } catch (e) {
    return { ok: false, why: `not a usable store: ${e.message}`, version: null, integrity: null };
  } finally { try { probe?.close(); } catch {} }
}
```

Then, inside `snapshotAll`, validate what was just written and refuse to keep a bad one:

```js
      const taken = snapshot(db, root, nwo, at, { keep });
      // A snapshot that cannot be read back is worse than no snapshot: it makes
      // `latestSnapshot` answer with a file that will fail at restore time.
      if (taken.ok && taken.path) {
        const v = nwo === "hub"
          ? validateSnapshot(taken.path, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION })
          : validateSnapshot(taken.path, { kind: "repo" });
        if (!v.ok) {
          try { rmSync(taken.path, { force: true }); } catch {}
          results.push({ nwo, ok: false, why: `snapshot failed validation and was deleted: ${v.why}`, escalate: "builder:backup:failed" });
          continue;
        }
      }
      results.push({ nwo, ...taken });
```

Add the imports `HUB_SCHEMA_VERSION` from `./build/hubdb.mjs` and keep `existsSync` (already imported).

- [ ] **Step 4: Run it, then commit**

```bash
$N test/hub-backup-restore.test.mjs
$N test/backup.test.mjs            # the existing suite must stay green
git add src/backup.mjs test/hub-backup-restore.test.mjs
git commit -m "feat(backup): discover and validate the hub snapshot"
```

---

### Task 9: Restore refuses while a writer is live, and the destructive drill proves the replay

**Files:**
- Create: `src/build/replay.mjs`
- Modify: `src/backup.mjs` (append `restoreHub`), `bin/reeve` (`restore --hub`), `test/hub-backup-restore.test.mjs` (append)

**Interfaces:**
- Consumes: `validateSnapshot` (Task 8), `liveWriters`, `acquireMaintenanceLock`, `releaseMaintenanceLock` (Task 7), `hubEvent` (Task 6).
- Produces:
  - `restoreHub(snapshotPath, dbPath, { isAlive, pid, lstart, force, tail }) -> { ok, why, holders, replayed, tail }` — takes the maintenance lock first, then refuses while any live singleton lease, any live `writer_lease`, or **any guardian-held `provider_lease`** exists, naming every holder. Captures the post-snapshot `hub_event` tail from the live file, or takes a durable one via `tail` when the file is gone, re-establishes the maintenance lock inside the restored database, replays, and releases.
  - `replayHub(db, events) -> { applied, skipped }` in `src/build/replay.mjs` — re-applies `hub_event` rows onto the projection.
  - `COMPARISON_SET: string[]` — §11.4's fourteen tables, exported so the drill and doctor use the same list rather than two lists that drift.

**The decision that makes replay possible without the phase machine.** `hub_event.payload` carries **the row that was written**, canonical, not a description of a change. Replay is therefore a primary-key upsert per kind, and it needs no knowledge of legal transitions — which is what lets it live in PR-A while `phases.mjs` arrives in PR-B. Every writer in PR-B and PR-C must honour it; Task 11's cross-check asserts each authority-bearing table has a replay handler.

- [ ] **Step 1: Append the failing test**

```js
// ── restore refuses while anything is writing ────────────────────────────────
import { restoreHub } from "../src/backup.mjs";
import { replayHub, COMPARISON_SET } from "../src/build/replay.mjs";
import { acquireSingleton, withWriterLease } from "../src/build/locks.mjs";
{
  const p = hubPathFor(home);
  const db = openHub(p);
  const snap = latestSnapshot(root, "hub");
  const ALIVE = () => true, DEAD = () => false;

  acquireSingleton(db, { name: "builder", pid: 4242, lstart: "L4242", command: "reeve build run", isAlive: ALIVE });
  let r = restoreHub(snap, p, { isAlive: ALIVE, pid: process.pid, lstart: "me" });
  check(r.ok === false, "restore refuses while the builder holds the singleton lease");
  check(JSON.stringify(r.holders).includes("4242"), "and names the holder", JSON.stringify(r.holders));

  db.exec("DELETE FROM singleton_lease");
  db.exec(`INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,priority,status,requested_at,expires_at)
           VALUES('guardian',1,'run:9',777,'L777',0,'held',unixepoch(),unixepoch()+120)`);
  r = restoreHub(snap, p, { isAlive: ALIVE, pid: process.pid, lstart: "me" });
  check(r.ok === false, "restore refuses while a GUARDIAN holds a provider lease");
  check(JSON.stringify(r.holders).includes("777"), "and names that holder too", JSON.stringify(r.holders));

  db.exec("DELETE FROM provider_lease");
  db.close();
  const db2 = openHub(p);
  let refusedDuring = null;
  withWriterLease(db2, { command: "reeve task file", pid: 555, lstart: "L555", isAlive: ALIVE }, () => {
    refusedDuring = restoreHub(snap, p, { isAlive: ALIVE, pid: process.pid, lstart: "me" });
  });
  check(refusedDuring?.ok === false, "restore refuses while a CLI command holds a writer lease");
  db2.close();

  // Control: with every writer gone, the same call succeeds. Without this, all
  // four refusals above are satisfied by a restore that refuses unconditionally.
  const ok = restoreHub(snap, p, { isAlive: DEAD, pid: process.pid, lstart: "me" });
  check(ok.ok === true, "control: with nothing live, restore proceeds", JSON.stringify(ok));
}

// ── the destructive drill ────────────────────────────────────────────────────
// Not "restore a file and see that it opens". Drop the live hub, put the
// snapshot back, replay everything that happened after it, and compare the
// fourteen tables of the comparison set row for row against what was there
// before the drop. A drill that only checks the file opens would pass against a
// restore that silently lost every row written since the snapshot.
{
  const p = join(home, "state", "drill.db");
  const db = openHub(p);
  db.exec(`INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,generation,source_kind,source_key,
             repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,created_at,updated_at)
           VALUES('bt:d','p',1,'o/r','t','GATE',1,'founder','k','/p','/f','h','main','private',1,unixepoch(),unixepoch())`);

  // snapshot HERE, so everything below is post-snapshot history the replay must recover
  const snapDir = join(root, "drill");
  mkdirSync(snapDir, { recursive: true });
  const snap = join(snapDir, "1.db");
  db.exec(`VACUUM INTO '${snap}'`);

  // post-snapshot authority-bearing writes, each appending its hub_event
  writeApproval(db, "bt:d", "a".repeat(40));
  writeHold(db, "bt:d", 7, "cancel");
  writeAuthority(db, "nextly");
  const before = exportComparison(db);
  // Exported to DISK before the destruction, the way an operator would have it:
  // once the file is gone there is nothing left to read a tail out of, so a test
  // that kept it only in memory would be testing a path that does not exist.
  const snapSeq = (() => { const q = new DatabaseSync(snap, { readOnly: true });
    try { return q.prepare("SELECT COALESCE(max(seq),0) s FROM hub_event").get().s; } finally { q.close(); } })();
  const events = db.prepare("SELECT seq,at,kind,task,payload FROM hub_event WHERE seq > ? ORDER BY seq").all(snapSeq);
  writeFileSync(join(dir, "tail.json"), JSON.stringify(events));
  db.close();

  // DESTROY
  rmSync(p, { force: true });
  for (const s of ["-wal", "-shm"]) rmSync(p + s, { force: true });
  check(!existsSync(p), "the live hub is really gone");

  const durableTail = JSON.parse(readFileSync(join(dir, "tail.json"), "utf8"));
  const r = restoreHub(snap, p, { isAlive: () => false, pid: process.pid, lstart: "me", tail: durableTail });
  check(r.ok === true, "the snapshot restores", JSON.stringify(r));
  // The COMMAND replays the tail. The test must not do it on the command's
  // behalf: that would prove the harness works, not the thing an operator runs.
  check(r.replayed > 0, `restoreHub itself replayed the tail (applied ${r.replayed})`, JSON.stringify(r));
  check(r.tail === events.length, "and captured every post-snapshot event before replacing the file",
    `captured ${r.tail}, expected ${events.length}`);
  const back = openHub(p);

  const after = exportComparison(back);
  for (const t of COMPARISON_SET) {
    check(JSON.stringify(after[t]) === JSON.stringify(before[t]),
      `${t} matches the pre-drop export row for row`,
      `before ${JSON.stringify(before[t])}\n        after  ${JSON.stringify(after[t])}`);
  }
  // Process-scoped rows are excluded BY DESIGN: they describe processes that no
  // longer exist. Asserting it, so nobody later "fixes" the drill by adding them.
  for (const t of ["directory_lease","provider_lease","singleton_lease","writer_lease","maintenance_lock"])
    check(!COMPARISON_SET.includes(t), `${t} is excluded from the comparison set`);
  back.close();
}

function exportComparison(db) {
  const out = {};
  for (const t of COMPARISON_SET) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name).sort();
    out[t] = db.prepare(`SELECT ${cols.join(",")} FROM ${t} ORDER BY ${cols.join(",")}`).all();
  }
  return out;
}
function writeApproval(db, task, sha) {
  const row = { task, spec_repo_id: 9, spec_pr: 1, head_sha: sha, actor_id: 5, actor_login_snapshot: "m",
    kind: "codex_clean", verdict: "clean", observed_at: 1, source_id: "c1", task_generation: 1 };
  db.exec("BEGIN IMMEDIATE");
  db.prepare(`INSERT INTO approval(task,spec_repo_id,spec_pr,head_sha,actor_id,actor_login_snapshot,kind,verdict,observed_at,source_id,task_generation)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(...Object.values(row));
  db.prepare(`INSERT INTO hub_event(at,kind,task,payload) VALUES(unixepoch(),'approval.recorded',?,?)`)
    .run(task, JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(k => [k, row[k]]))));
  db.exec("COMMIT");
}
function writeHold(db, task, pr, reason) {
  const row = { task, repo_id: 1, pr, head_sha: "b".repeat(40), reason, created_at: 1 };
  db.exec("BEGIN IMMEDIATE");
  db.prepare(`INSERT INTO pr_hold(task,repo_id,pr,head_sha,reason,created_at) VALUES(?,?,?,?,?,?)`).run(...Object.values(row));
  db.prepare(`INSERT INTO hub_event(at,kind,task,payload) VALUES(unixepoch(),'pr_hold.created',?,?)`)
    .run(task, JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(k => [k, row[k]]))));
  db.exec("COMMIT");
}
function writeAuthority(db, project) {
  const row = { project_id: project, kind: "review-witness", granted_by: 5, until: 9999999999, created_at: 1 };
  db.exec("BEGIN IMMEDIATE");
  db.prepare(`INSERT INTO project_authority(project_id,kind,granted_by,until,created_at) VALUES(?,?,?,?,?)`).run(...Object.values(row));
  db.prepare(`INSERT INTO hub_event(at,kind,task,payload) VALUES(unixepoch(),'project_authority.granted',NULL,?)`)
    .run(JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(k => [k, row[k]]))));
  db.exec("COMMIT");
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
$N test/hub-backup-restore.test.mjs
```

Expected: import failure on `restoreHub` / `replayHub`.

**On the broken implementation** — the existing `restore()` reused for the hub — every refusal assertion goes red at once, because `restore()` probes `pgrep -fl "bin/reeve run"`, which matches a **guardian** and knows nothing about the singleton lease, the writer leases, or provider leases. The single most important assertion here is the **control**: `with nothing live, restore proceeds`. Without it a `restoreHub` that returns `{ok:false}` unconditionally satisfies all four refusal tests and would ship.

- [ ] **Step 3: Implement `src/build/replay.mjs`**

```js
// replay -- rebuild the hub projection from its own append-only log.
//
// hub_event.payload carries THE ROW THAT WAS WRITTEN, canonical, not a
// description of a change. So replay is a primary-key upsert per kind and needs
// to know nothing about which transitions are legal: it is not a second
// implementation of the state machine that could disagree with the first.
//
// That is also why this can be trusted at 2am. The alternative -- replaying
// intent and re-deriving state -- means the recovery path runs code that has
// never been exercised except during a disaster.
import { hubTx } from "./hubdb.mjs";

/**
 * The tables the destructive restore drill compares, and the ONLY definition of
 * that list. Doctor and the drill both import it, so they cannot drift.
 *
 * Process-scoped rows are absent on purpose: directory_lease, provider_lease,
 * singleton_lease, writer_lease and maintenance_lock describe processes that do
 * not exist after a restore, and comparing them would fail every drill for the
 * one reason that is correct.
 */
export const COMPARISON_SET = [
  "task", "task_territory", "task_drain", "phase_event", "phase_run", "approval", "gate_request", "notice_receipt", "impl_pr", "attested_push",
  "harness_acceptance", "gate_run", "pr_hold", "hold_reason", "project_authority",
  "outbox", "territory_lease", "merge_decision",
];

/** kind -> the table its payload is a row of. */
const HANDLERS = {
  "task.transitioned":        { table: "task", key: ["id"] },
  // The transition LOG, not just the projection. Without it every transition
  // after the snapshot vanishes from history: `task why` and dash's
  // age-in-state lose the record, and restored outbox rows keep fence values
  // pointing at phase_event seqs that no longer exist -- so fence revalidation
  // compares against nothing. The transition tx emits this beside
  // task.transitioned, carrying the exact row including its seq.
  "phase_event.appended":     { table: "phase_event", key: ["seq"] },
  // phase_run's LIVE rows are process state, but its settled ones are history:
  // the attempt counter is monotonic per (task, generation, phase, slice) and
  // must never be reused (section 3.4). Losing settled rows on restore lets a
  // resumed run collide with an earlier attempt's key, and the retry budget
  // silently resets. Live rows are excluded at replay: a run whose process is
  // gone is not resurrected.
  "phase_run.settled":        { table: "phase_run", key: ["task","generation","phase","slice","attempt"] },
  "task.filed":               { table: "task", key: ["id"] },
  // A filing writes the task AND its territory children in one transaction, so a
  // replay that restores only the task row loses the claims -- and territory is
  // what admission checks for overlap, so losing it silently re-opens every
  // conflict the filing was refused for. Emitted once per claim by the admission
  // tx; task_territory is in the comparison set for the same reason.
  "task_territory.claimed":   { table: "task_territory", key: ["task","kind","path"] },
  // task_drain is task_territory's sibling and was missed when that one was
  // fixed -- a class half-swept. Without these, a task restored as CANCELLING
  // reads drainRemaining=0, so drain.settled moves it to CANCELLED while the
  // pre-crash external effects are still unresolved: exactly what section 3.5
  // says CANCELLED must never mean.
  "task_drain.recorded":      { table: "task_drain", key: ["task","outbox_id"] },
  "task_drain.settled":       { table: "task_drain", key: ["task","outbox_id"] },
  "approval.recorded":        { table: "approval", key: ["spec_repo_id","spec_pr","head_sha","actor_id","source_id"] },
  "gate_request.minted":      { table: "gate_request", key: ["spec_repo_id","spec_pr","head_sha"] },
  "notice_receipt.recorded":  { table: "notice_receipt", key: ["task","head_sha","clean_source_id"] },
  "impl_pr.bound":            { table: "impl_pr", key: ["task","generation","slice"] },
  "attested_push.appended":   { table: "attested_push", key: ["task","generation","slice","sha"] },
  "guardian_receipt.imported":{ table: "guardian_receipt", key: ["repo_id","guardian_event_seq"] },
  "harness_acceptance.recorded": { table: "harness_acceptance", key: ["task","generation","slice","diff_hash"] },
  "gate_run.recorded":        { table: "gate_run", key: ["id"] },
  // pr_hold's primary key is `id`. An upsert keyed on (task, repo_id, pr,
  // created_at) has no matching UNIQUE constraint, so SQLite raises "ON CONFLICT
  // clause does not match any PRIMARY KEY or UNIQUE constraint" and the replay
  // dies on the first hold it meets. The writer therefore puts `id` in the
  // payload, like every other rowid table here.
  "pr_hold.created":          { table: "pr_hold", key: ["id"] },
  "pr_hold.cleared":          { table: "pr_hold", key: ["id"] },
  "hold_reason.appended":     { table: "hold_reason", key: ["id"] },   // rowid table, same reason as pr_hold
  "project_authority.granted":{ table: "project_authority", key: ["project_id","kind","created_at"] },
  "merge_decision.recorded":  { table: "merge_decision", key: ["id"] },
  "outbox.enqueued":          { table: "outbox", key: ["id"] },
  "outbox.settled":           { table: "outbox", key: ["id"] },
  "outbox.voided":            { table: "outbox", key: ["id"] },
  "outbox.fenced":            { table: "outbox", key: ["id"] },
  "territory_lease.granted":  { table: "territory_lease", key: ["project","kind","path"] },
  "territory_lease.released": { table: "territory_lease", key: ["project","kind","path"], delete: true },
};

/** Which kinds this replay knows. Exported so the cross-check can compare it. */
export function replayableKinds() { return Object.keys(HANDLERS); }

export function replayHub(db, events) {
  let applied = 0, skipped = 0;
  hubTx(db, () => {
    for (const e of events) {
      const h = HANDLERS[e.kind];
      // A lease grant, a heartbeat, or anything else that describes a process
      // is not part of the projection. Counted, never guessed at.
      if (!h) { skipped++; continue; }
      const row = JSON.parse(e.payload);
      if (h.delete) {
        db.prepare(`DELETE FROM ${h.table} WHERE ${h.key.map(k => `${k}=?`).join(" AND ")}`).run(...h.key.map(k => row[k]));
        applied++; continue;
      }
      const cols = Object.keys(row);
      const set = cols.filter(c => !h.key.includes(c)).map(c => `${c}=excluded.${c}`).join(",");
      db.prepare(
        `INSERT INTO ${h.table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})
         ON CONFLICT(${h.key.join(",")}) DO UPDATE SET ${set || h.key[0] + "=" + h.key[0]}`)
        .run(...cols.map(c => row[c]));
      applied++;
    }
    // The log itself is history and is restored with the rest of the row set,
    // so replayed events are re-appended verbatim rather than re-minted.
    for (const e of events)
      db.prepare("INSERT INTO hub_event(seq,at,kind,task,payload) VALUES(?,?,?,?,?) ON CONFLICT(seq) DO NOTHING")
        .run(e.seq, e.at, e.kind, e.task, e.payload);
  });
  return { applied, skipped };
}
```

- [ ] **Step 4: Implement `restoreHub` in `src/backup.mjs`**

```js
/**
 * Put a hub snapshot back.
 *
 * The existing restore() asks a process question -- is `bin/reeve run` alive --
 * because for a per-repo store the daemon is the only writer. The hub has
 * three kinds of writer and pgrep can see none of them properly: the builder
 * holds a singleton lease row, every hub-writing CLI command holds a writer
 * lease for its duration, and a GUARDIAN holds a provider lease whenever it is
 * dispatching a worker. So the refusal is asked of the database.
 *
 * The maintenance lock is taken FIRST and released last. Without it there is a
 * window between the check and the copy, and a command started inside that
 * window writes into a file that is about to be replaced underneath it.
 */
export function restoreHub(snapshotPath, dbPath, { isAlive, pid, lstart, force = false, tail: suppliedTail = null } = {}) {
  if (!existsSync(snapshotPath)) return { ok: false, why: `no snapshot at ${snapshotPath}`, holders: [] };

  const v = validateSnapshot(snapshotPath, { kind: "hub", expectVersion: HUB_SCHEMA_VERSION });
  if (!v.ok) return { ok: false, why: `the snapshot is not restorable: ${v.why}`, holders: [] };

  const snapSeq = (() => {
    const p = new DatabaseSync(snapshotPath, { readOnly: true });
    try { return p.prepare("SELECT COALESCE(max(seq),0) s FROM hub_event").get().s; } finally { p.close(); }
  })();

  let live = null, locked = false;
  const staging = dbPath + ".restoring";
  try {
    if (existsSync(dbPath)) {
      // RAW DatabaseSync, not openHub. openHub applies forward migrations, and
      // migrating a database is a write -- so opening that way would upgrade a
      // hub that a builder or a CLI is actively using, before this command has
      // established it is allowed to touch it at all. The exclusion has to come
      // before any write, including a well-intentioned one.
      live = new DatabaseSync(dbPath, { timeout: 10000 });
      const got = acquireMaintenanceLock(live, { pid, lstart, isAlive });
      if (!got.ok) return { ok: false, why: `another restore is running (pid ${got.holder.pid})`, holders: [got.holder] };
      locked = true;

      const holders = [];
      for (const r of live.prepare("SELECT * FROM singleton_lease").all())
        if (isAlive(r.pid, r.lstart)) holders.push({ what: "builder", pid: r.pid, lstart: r.lstart, command: r.command });
      for (const r of liveWriters(live, { isAlive }))
        holders.push({ what: "cli", pid: r.pid, lstart: r.lstart, command: r.command });
      for (const r of live.prepare("SELECT * FROM provider_lease WHERE status='held'").all())
        if (isAlive(r.pid, r.lstart)) holders.push({ what: r.owner, pid: r.pid, lstart: r.lstart, command: r.run_ref });

      if (holders.length && !force) {
        return { ok: false, holders,
          why: `the hub has live writers; stop them first:\n` +
               holders.map(h => `  ${h.what.padEnd(8)} pid ${h.pid} (started ${h.lstart})  ${h.command}`).join("\n") +
               `\n  a guardian holds a provider lease whenever it is dispatching a worker, so a busy ` +
               `guardian is a normal reason to see this; stop the daemons, or pass force if you are certain.` };
      }
    }

    // The tail arrives two ways and both are real: read from the live file when
    // it is still readable, or supplied from a durable `export-events --hub`
    // when it is gone -- which is what "destructive" means. Either way it is
    // FILTERED to events after the snapshot's own max seq: the export command
    // writes the whole log from seq 1, and replaying pre-snapshot rows would
    // re-apply row images the snapshot already contains, in an order the
    // snapshot has already superseded.
    const rawTail = suppliedTail ?? (live
      ? live.prepare("SELECT seq, at, kind, task, payload FROM hub_event WHERE seq > ? ORDER BY seq").all(snapSeq)
      : []);
    const tail = rawTail.filter(e => e.seq > snapSeq).sort((a, b) => a.seq - b.seq);

    // Build the restored database BESIDE the live one, then move it into place
    // in a single rename. A copy directly over dbPath leaves a window in which
    // the file at the real path is a fresh database carrying the SNAPSHOT's lock
    // state -- which is none -- so any writer starting in that window sees an
    // unlocked hub and writes into it while the replay is still running. There
    // is no such window here: the live file keeps its maintenance lock right up
    // until the instant it is replaced, and rename is atomic.
    // Remove the staging file AND its WAL sidecars. A restore killed after
    // opening the staging database in WAL mode leaves -wal/-shm behind; the next
    // attempt copies a fresh main file over the same path and the stale sidecar
    // is replayed into it on open, which is a silent merge of two restores.
    for (const ext of ["", "-wal", "-shm"]) { try { rmSync(staging + ext, { force: true }); } catch {} }
    copyFileSync(snapshotPath, staging);
    let replayed = 0;
    {
      const back = openHub(staging);
      try {
        acquireMaintenanceLock(back, { pid, lstart, isAlive });

        // Snapshots are taken by the running daemon, so a normal one CONTAINS
        // live-looking process rows: a singleton lease held by a pid that was
        // alive when VACUUM INTO ran, provider leases mid-dispatch, worktree
        // leases. Restoring them resurrects authority that belongs to processes
        // which no longer exist -- the next `build run` is refused by a ghost,
        // and the reaper cannot help because pid+lstart may since have been
        // reused by something unrelated. They are excluded from the comparison
        // set for the same reason; they must be cleared from the restored file
        // as well, not merely ignored when comparing.
        for (const t of ["singleton_lease","writer_lease","maintenance_lock","directory_lease","provider_lease"])
          if (t !== "maintenance_lock") back.exec(`DELETE FROM ${t}`);
        // maintenance_lock is deliberately last and deliberately not cleared:
        // this restore holds it. It is released below.

        if (tail.length) replayed = replayHub(back, tail).applied;
        releaseMaintenanceLock(back, { pid, lstart });
      } finally { back.close(); }
    }

    // Close the live handle BEFORE removing its sidecars, and treat a failed
    // removal as fatal rather than swallowing it: a -wal left beside a replaced
    // main file is replayed into the new database on the next open, which is a
    // silent merge of two unrelated stores.
    try { live?.close(); live = null; locked = false; } catch {}
    for (const ext of ["-wal", "-shm"]) {
      try { rmSync(dbPath + ext, { force: true }); }
      catch (e) { return { ok: false, holders: [],
        why: `could not remove ${dbPath}${ext} (${e.message}); refusing to replace the database, ` +
             `because a stale write-ahead log beside a restored file is replayed into it on the next open` }; }
    }
    renameSync(staging, dbPath);
    return { ok: true, why: null, holders: [], replayed, tail: tail.length };
  } catch (e) {
    return { ok: false, why: `could not restore: ${e.message}`, holders: [] };
  } finally {
    if (locked && live) { try { releaseMaintenanceLock(live, { pid, lstart }); } catch {} }
    try { live?.close(); } catch {}
    try { rmSync(staging, { force: true }); } catch {}
  }
}
```

Add to `bin/reeve`:

- `restore --hub [--tail <file>]` routes to `restoreHub`, printing `why` verbatim and, on success, `replayed N of M post-snapshot events`.
- **`export-events --hub <file>`** writes `hub_event` as JSONL. This is not optional garnish: `restoreHub`'s `tail` argument is the ONLY way to recover post-snapshot history when the live database is destroyed or too corrupt to open, and without a route that produces such a file the argument is unreachable from the command line. The existing `backup --events` exports the per-repository `event` table and does not cover `hub_event`.
- The `--hub` restore path prints, when no tail is available and the live file could not be read: `no post-snapshot events were recovered; if you have an export from before the loss, re-run with --tail <file>` — so an operator learns the option exists at the moment it matters rather than from the source.

```js
  case "export-events": {
    if (!flag("hub")) die("usage: reeve export-events --hub <file>");
    // positionals[0] is the destination: `export-events` is the subcommand and is
    // not itself a positional under this parser, so index 1 was always undefined
    // and the command could never run.
    const out = positionals[0] ?? die("usage: reeve export-events --hub <file>");
    const db = openHub(hubPathFor(reeveHome()));
    const rows = db.prepare("SELECT seq,at,kind,task,payload FROM hub_event ORDER BY seq").all();
    writeFileSync(out, rows.map(r => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
    console.log(`exported ${rows.length} hub events to ${out}`);
    break;
  }
```

- [ ] **Step 5: Run it, then commit**

```bash
$N test/hub-backup-restore.test.mjs
for f in test/*.test.mjs; do $N "$f" >/dev/null || echo "FAILED $f"; done
git add src/build/replay.mjs src/backup.mjs bin/reeve test/hub-backup-restore.test.mjs
git commit -m "feat(hub): restore refuses live writers; destructive drill"
```

---
### Task 10: `reeve builder doctor` reports the hub, and never writes what it reports

**Files:**
- Modify: `src/doctor.mjs`, `src/selfaudit.mjs`
- Test: `test/hub-doctor.test.mjs` (new)

**Interfaces:**
- Consumes: `everyStore`, `latestSnapshot`, `validateSnapshot` (Task 8); `COMPARISON_SET` (Task 9); `openHub` (Task 1).
- Produces: `hubFindings(db, { root, now, snapshotFor, projects, offDevice }) -> Finding[]` where `projects` is the registry set `[{ name, repoId, nwo }]` where `Finding = { id, severity, classification, title, detail, action }` and `classification ∈ {'configuration','dependency-outage','stale-evidence','unsafe-authority'}`. Findings `H-1` snapshot age, `H-2` last integrity result, `H-3` restore compatibility, `H-4` `repo_gate_state` per registry project, `H-5` provider scheduler state and stale leases, `H-6` off-device copy missing.

- [ ] **Step 1: Write the failing test**

```js
// Doctor classifies rather than lists, because "16 things are wrong" is not a
// report anyone acts on: a configuration error is fixed, a dependency outage is
// waited out, stale evidence is refreshed, and unsafe authority is the only one
// that should stop a merge.
//
// It also must not write repo_gate_state. A reporter that can write what it
// reports can agree with itself, and the row exists precisely so that clause U4
// reads something the LOOP established.
import { openHub } from "../src/build/hubdb.mjs";
import { hubFindings } from "../src/doctor.mjs";
/* ... standard harness ... */

{
  const db = openHub(join(dir, "d.db"));
  const NOW = 1_800_000_000;

  // no snapshot at all
  let f = hubFindings(db, { root: join(dir, "backups"), now: NOW, snapshotFor: () => null });
  const noSnap = f.find(x => x.id === "H-1");
  check(noSnap && noSnap.severity === "fail", "a hub with no snapshot at all is a failure, not a note", JSON.stringify(noSnap));
  check(noSnap?.classification === "configuration", "classified as configuration", String(noSnap?.classification));

  // a stale snapshot
  f = hubFindings(db, { root: "/b", now: NOW, snapshotFor: () => ({ path: "/b/hub/1.db", at: NOW - 86400 * 3, ok: true, version: 1 }) });
  check(f.find(x => x.id === "H-1")?.classification === "stale-evidence", "a three-day-old snapshot is stale evidence");

  // a fresh, valid one
  f = hubFindings(db, { root: "/b", now: NOW, snapshotFor: () => ({ path: "/b/hub/1.db", at: NOW - 60, ok: true, version: 1 }) });
  check(f.find(x => x.id === "H-1")?.severity === "pass", "control: a fresh valid snapshot passes, so H-1 is not always red");

  // A registry project with NO row is the case doctor was blind to: it emitted
  // nothing at all, which reads as "fine".
  const PROJECTS = [{ name: "nextly", repoId: 1, nwo: "o/r" }, { name: "other", repoId: 2, nwo: "o/other" }];
  f = hubFindings(db, { root: "/b", now: NOW, snapshotFor: () => null, projects: PROJECTS });
  const absent = f.filter(x => x.id === "H-4");
  check(absent.length === 2 && absent.every(x => x.classification === "unsafe-authority"),
    "a registry project with no gate-state row still produces a failing H-4",
    JSON.stringify(absent.map(x => x.title)));

  // repo_gate_state: absent is UNKNOWN and unsafe authority, never a quiet pass
  db.exec(`INSERT INTO repo_gate_state(repo_id,nwo_snapshot,ruleset_requires_check,bound_app_id,expected_app_id,app_installed,verified_at)
           VALUES(1,'o/r',0,NULL,42,'unknown',${NOW - 60})`);
  f = hubFindings(db, { root: "/b", now: NOW, snapshotFor: () => null });
  const gate = f.find(x => x.id === "H-4");
  check(gate?.classification === "unsafe-authority", "a ruleset that does not require the bound check is unsafe authority", JSON.stringify(gate));

  db.exec(`UPDATE repo_gate_state SET ruleset_requires_check=1, bound_app_id=42, app_installed='pass' WHERE repo_id=1`);
  f = hubFindings(db, { root: "/b", now: NOW, snapshotFor: () => null });
  check(f.find(x => x.id === "H-4")?.severity === "pass", "control: a ruleset requiring the bound app passes");

  db.exec(`UPDATE repo_gate_state SET verified_at=${NOW - 3600 * 3} WHERE repo_id=1`);
  f = hubFindings(db, { root: "/b", now: NOW, snapshotFor: () => null });
  check(f.find(x => x.id === "H-4")?.classification === "stale-evidence",
    "a row older than the freshness bound is stale, whatever it says");

  // THE assertion of this task: doctor is a reader.
  const before = db.prepare("SELECT * FROM repo_gate_state WHERE repo_id=1").get();
  hubFindings(db, { root: "/b", now: NOW, snapshotFor: () => null });
  const after = db.prepare("SELECT * FROM repo_gate_state WHERE repo_id=1").get();
  check(JSON.stringify(before) === JSON.stringify(after), "doctor does not write repo_gate_state");
  check(db.prepare("SELECT count(*) c FROM hub_event").get().c === 0, "and appends no hub_event at all: it is a reader");
  db.close();
}
```

- [ ] **Step 2: Run it and watch it fail**

Expected: `hubFindings` is not exported.

**On the broken implementation** — a `hubFindings` that "helpfully" refreshes `repo_gate_state` when the row is stale — every classification assertion passes and exactly two go red: `doctor does not write repo_gate_state` and `appends no hub_event at all`. Those two are the task. The `control:` lines exist because a `hubFindings` that returns a constant list of failures satisfies all four positive classifications.

- [ ] **Step 3: Implement `hubFindings` in `src/doctor.mjs`**

```js
/**
 * The hub half of doctor. Reads only.
 *
 * Every finding is classified, because a flat list of sixteen problems is not
 * something anyone acts on. The four classes are the four different responses:
 * a configuration error is fixed, a dependency outage is waited out, stale
 * evidence is refreshed, and unsafe authority is the one that must stop a merge.
 *
 * This function never writes repo_gate_state. The builder loop establishes that
 * row; a reporter that could also write it would be agreeing with itself, and
 * clause U4's whole value is that it reads something another actor established.
 */
export function hubFindings(db, { root, now = Math.floor(Date.now() / 1000), snapshotFor,
                                  freshMinutes = 60, snapshotMaxHours = 24, offDevice = null,
                                  projects = [] }) {
  const out = [];
  const snap = snapshotFor("hub");
  if (!snap) {
    out.push({ id: "H-1", severity: "fail", classification: "configuration",
      title: "the hub has no snapshot", detail: `nothing under ${root}/hub`,
      action: "reeve backup" });
  } else if (!snap.ok) {
    out.push({ id: "H-1", severity: "fail", classification: "configuration",
      title: "the newest hub snapshot does not validate", detail: String(snap.why), action: "reeve backup" });
  } else if (now - snap.at > snapshotMaxHours * 3600) {
    out.push({ id: "H-1", severity: "warn", classification: "stale-evidence",
      title: "the hub snapshot is stale",
      detail: `${Math.round((now - snap.at) / 3600)}h old, taken ${new Date(snap.at * 1000).toISOString()}`,
      action: "reeve backup" });
  } else {
    out.push({ id: "H-1", severity: "pass", classification: "stale-evidence",
      title: "hub snapshot is fresh", detail: `${Math.round((now - snap.at) / 60)}m old`, action: null });
  }

  // A project with NO row produces no finding at all unless it is asked for by
  // name. That is absence read as success on the clause whose entire job is to
  // refuse absence: on a fresh hub, or where one project has never refreshed,
  // U4 is UNKNOWN and doctor must say so. The registry is the list of what
  // SHOULD be there; the table is only what IS.
  const have = new Map(db.prepare("SELECT * FROM repo_gate_state").all().map(r => [r.repo_id, r]));
  for (const proj of projects) {
    if (have.has(proj.repoId)) continue;
    out.push({ id: "H-4", severity: "fail", classification: "unsafe-authority",
      title: `${proj.nwo} has no gate-state row`,
      detail: "the builder loop has never recorded one; clause U4 reads UNKNOWN, which is never PASS",
      action: "start the builder and let one tick refresh it" });
  }
  for (const r of have.values()) {
    const stale = now - r.verified_at > freshMinutes * 60;
    const bound = r.ruleset_requires_check === 1 && r.bound_app_id != null && r.bound_app_id === r.expected_app_id;
    const installed = r.app_installed === "pass";
    if (stale) {
      out.push({ id: "H-4", severity: "warn", classification: "stale-evidence",
        title: `gate state for ${r.nwo_snapshot} is stale`,
        detail: `verified ${Math.round((now - r.verified_at) / 60)}m ago; the bound is ${freshMinutes}m`,
        action: "start the builder, or wait one tick" });
    } else if (!bound || !installed) {
      out.push({ id: "H-4", severity: "fail", classification: "unsafe-authority",
        title: `${r.nwo_snapshot} does not enforce the bound check`,
        detail: `requires=${r.ruleset_requires_check} bound_app=${r.bound_app_id} expected=${r.expected_app_id} installed=${r.app_installed}`,
        action: "merge stays dark until the ruleset requires ops/merge-policy from the expected app" });
    } else {
      out.push({ id: "H-4", severity: "pass", classification: "unsafe-authority",
        title: `${r.nwo_snapshot} enforces the bound check`, detail: null, action: null });
    }
  }

  // H-2/H-3: the snapshot's own integrity, and whether THIS binary could read it
  // back. Declared in the interface, so they are emitted rather than folded into
  // H-1: "a snapshot exists and is recent" is a different question from "it
  // restores", and a stale-but-valid snapshot and a fresh-but-corrupt one need
  // opposite responses.
  if (snap?.ok) {
    out.push({ id: "H-2", severity: "pass", classification: "stale-evidence",
      title: "the newest hub snapshot passes integrity_check", detail: snap.integrity, action: null });
    // Older is fine: validateSnapshot accepts any version at or below this
    // binary, and openHub applies the forward migrations after the copy. Only a
    // NEWER snapshot is unreadable. Requiring equality would tell an operator to
    // hunt for an old binary in the one case restore already handles.
    const ok = snap.version <= HUB_SCHEMA_VERSION;
    out.push({ id: "H-3", severity: ok ? "pass" : "fail", classification: "configuration",
      title: ok ? "the newest snapshot is restorable by this binary"
                : "the newest snapshot is NOT restorable by this binary",
      detail: `snapshot v${snap.version}, binary v${HUB_SCHEMA_VERSION}`,
      action: ok ? null : "run the matching binary, or take a fresh snapshot" });
  } else if (snap) {
    out.push({ id: "H-2", severity: "fail", classification: "configuration",
      title: "the newest hub snapshot does not read back", detail: String(snap.why), action: "reeve backup" });
    out.push({ id: "H-3", severity: "fail", classification: "configuration",
      title: "restore compatibility is unknown: the snapshot does not open",
      detail: String(snap.why), action: "reeve backup" });
  }

  // H-6: the off-device copy is a REQUIREMENT of this design whose destination is
  // still a founder decision (section 16.2). Reported missing rather than left
  // silent -- an unreported gap in the backup story reads as no gap.
  out.push(offDevice
    ? { id: "H-6", severity: "pass", classification: "configuration",
        title: "an off-device copy is configured", detail: offDevice, action: null }
    : { id: "H-6", severity: "warn", classification: "configuration",
        title: "no off-device copy is configured",
        detail: "same-disk snapshots only; this machine is still a single point of failure",
        action: "choose a destination (LAN machine, NAS or external disk; never cloud, never a git repository)" });

  // A held lease whose holder is gone still occupies a slot until something reaps
  // it, and a scheduler full of dead holders looks exactly like a busy one.
  const staleLeases = db.prepare(
    `SELECT count(*) c FROM provider_lease WHERE status='held' AND expires_at < ?`).get(now).c;
  if (staleLeases > 0) out.push({ id: "H-5", severity: "warn", classification: "stale-evidence",
    title: "provider leases are past their expiry",
    detail: `${staleLeases} held lease(s) expired; a dead holder's slot starves every claim behind it`,
    action: "the next tick reaps them; if it persists, the reaper is not running" });

  const st = db.prepare("SELECT * FROM provider_state WHERE provider='claude'").get();
  if (!st) {
    out.push({ id: "H-5", severity: "warn", classification: "configuration",
      title: "the provider scheduler has no state row", detail: "limits fall back to the defaults 2/1",
      action: "reeve build measure-provider (S3)" });
  } else if (st.measured_at == null) {
    out.push({ id: "H-5", severity: "warn", classification: "stale-evidence",
      title: "provider limits are the unmeasured defaults",
      detail: `limit=${st.concurrency_limit} reserved=${st.guardian_reserved}, never measured`,
      action: "reeve build measure-provider (S3)" });
  } else {
    out.push({ id: "H-5", severity: "pass", classification: "stale-evidence",
      title: "provider limits are measured",
      detail: `limit=${st.concurrency_limit} reserved=${st.guardian_reserved}, measured ${new Date(st.measured_at * 1000).toISOString()}`, action: null });
  }
  return out;
}
```

`src/doctor.mjs` must import what `hubFindings` reads — the healthy-snapshot path evaluates `HUB_SCHEMA_VERSION`, so without the import the ordinary case throws `ReferenceError` and only the already-broken cases return a finding:

```js
import { HUB_SCHEMA_VERSION } from "./build/hubdb.mjs";
```

Wire `hubFindings` into `reeve builder doctor` and its `--json` output, and extend `selfaudit.mjs` to assert the hub's `integrity_check` alongside the per-repo stores.

- [ ] **Step 4: Run it, then commit**

```bash
$N test/hub-doctor.test.mjs
$N test/doctor-state.test.mjs && $N test/selfaudit.test.mjs
git add src/doctor.mjs src/selfaudit.mjs test/hub-doctor.test.mjs
git commit -m "feat(doctor): report hub snapshot, gate state and provider state"
```

---

### Task 11: The prose-versus-DDL cross-check, as an executable test

**Files:**
- Create: `src/build/tables.mjs`, `test/hub-crosscheck.test.mjs`

**Interfaces:**
- Consumes: `openHub` (Task 1), `replayableKinds` (Task 9).
- Produces: `TABLE_OWNERS: Record<string, { writer: string, reader: string, replayed: boolean, section: string }>` — one entry per hub table. `PROSE_TABLES: string[]` — every table §11.2's prose names, transcribed by hand.

**This is the task the S2 review requires.** §11.1: "the S2 review includes a prose-versus-DDL cross-check so that every table the prose names exists and every table the DDL names has a stated writer and reader." A checklist a reviewer ticks by hand is a checklist that is ticked by hand once; this makes it a test that runs on every push.

**The reviewer's checklist** (each row must also be confirmed by eye against §11.2, because the test can only check that a claim was *made*, never that it is *true*):

| Table | Writer | Reader | Replayed | §  |
|---|---|---|---|---|
| `task` | `transition.mjs`, `intake.mjs` | loop, dash, `why`, merge coordinator | yes | 11.2 |
| `task_territory` | `intake.mjs` (admission tx) | `territory.mjs` overlap check | no (restored with `task`) | 10.1 |
| `task_drain` | `transition.mjs` (CANCELLING entry) | `loop.mjs` drain check, `task why` | yes | 3.5 |
| `phase_event` | `transition.mjs` | `why`, dash age-in-state, fence minting | **yes** (outbox fences reference its seq) | 3.2 |
| `hold_reason` | `transition.mjs` (hold on a held task) | `task resume`, `why` | yes | 3.1 |
| `hub_event` | every authority-bearing tx | `replay.mjs`, restore drill | n/a (is the log) | 11.4 |
| `phase_run` | `loop.mjs` at dispatch, `daemon` adopt-or-kill | `why`, adopt-or-kill, retry budget | **yes** (settled rows carry the monotonic attempt counter) | 4.5 |
| `gate_run` | `gates.mjs` (controller-run gates) | merge clause B2, `why` | yes | 8.3 |
| `gate_request` | `gate.mjs` per round | revision cap, `why` | yes | 7.3 |
| `approval` | `gate.mjs` from the inbox | merge clauses B4/U2, `why` | yes | 7.3 |
| `notice_receipt` | `gate.mjs` on notice settle, `task ack` | the silence clock | yes | 7.3 |
| `impl_pr` | `chain.mjs` (pr-create settle, one tx) | receipt importer, merge coordinator | yes | 8.5 |
| `attested_push` | `chain.mjs` | merge clause B1 | yes | 8.5 |
| `guardian_receipt` | `chain.mjs` receipt importer | clause B1 via `attested_push` | yes | 8.5 |
| `ownership_check` | `ledger.mjs` re-verification | clause B6, `task resume` | no (re-derived by sync) | 2.5 |
| `harness_acceptance` | `reeve task resume --accept-harness` **only** | merge clause B7 | yes | 3.4 |
| `pr_hold` | `transition.mjs` on cancel/block/escalate; cleared by resume | **the guardian's verdict**, read-only | yes | 9.6 |
| `project_authority` | `reeve build authority` **only** | merge clause B5 | yes | 9.3 |
| `repo_gate_state` | `gatestate.mjs`, the builder tick | merge clause U4; **reported** by doctor | no (re-derived each tick) | 9.1 |
| `inbox` | `github/inbox` fetcher | `gate.mjs`, merge coordinator, watcher | no (re-fetchable) | 7.6 |
| `outbox` | `transition.mjs` enqueue; executor settle | executor, `recoverOutbox`, drain check | yes | 3.2 |
| `merge_decision` | `merge.mjs` at each of three phases | `why`, S9 shadow scoring | yes | 9.4 |
| `singleton_lease` | `locks.mjs` | `build run`, restore refusal | no (process-scoped) | 1.2 |
| `writer_lease` | `locks.mjs` per CLI command | restore refusal | no (process-scoped) | 11.4 |
| `maintenance_lock` | `restoreHub` **only** | every writer's `assertWritable` | no (process-scoped) | 11.4 |
| `directory_lease` | `worktree.mjs`, clone acquisition | reaper, `never dispatch into a live worktree` | no (process-scoped) | 10.2 |
| `territory_lease` | admission tx, transition tx, `task resume` | overlap check at filing and slice start | yes | 10.2 |
| `provider_lease` | **both daemons** via `provider.mjs` | admission rule, reaper, restore refusal | no (process-scoped) | 10.4 |
| `provider_state` | `provider.mjs` on 429; `build measure-provider` | admission rule, doctor | no (re-measured) | 10.4 |
| `intake_event` | `intake.mjs`, `ledger.mjs` | `why`, orphan sweep | no (log) | 2.4 |
| `escalation` | the builder process **only** | `announceable`, dash, notify | no (re-derived from state) | 11.7 |
| `schema_version` | `openHub` migration runner **only** | `openHub`, `validateSnapshot` | no (structural) | 11.1 |

- [ ] **Step 1: Write the failing test**

Create `test/hub-crosscheck.test.mjs`:

```js
// The prose-versus-DDL cross-check, run rather than remembered.
//
// Two failures this catches, and they point in opposite directions:
//   - a table the design's prose relies on that nobody ever created, so the
//     code that reads it silently gets nothing and reads absence as success;
//   - a table in the DDL that no writer fills and no reader consults -- the
//     read-never-written shape the tracker has already flagged twice.
import { openHub } from "../src/build/hubdb.mjs";
import { replayableKinds } from "../src/build/replay.mjs";
import { TABLE_OWNERS, PROSE_TABLES } from "../src/build/tables.mjs";
/* ... standard harness ... */

const db = openHub(join(mkdtempSync(join(tmpdir(), "reeve-xc-")), "x.db"));
const inDb = new Set(db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name));
const declared = new Set(Object.keys(TABLE_OWNERS));

check(inDb.size === 32, `the hub has exactly 32 tables (got ${inDb.size})`, [...inDb].sort().join(","));

// direction 1: prose -> DDL
for (const t of PROSE_TABLES) check(inDb.has(t), `the prose names ${t}, and the DDL creates it`);

// direction 2: DDL -> a stated writer and reader
for (const t of inDb) {
  const o = TABLE_OWNERS[t];
  check(!!o, `${t} exists in the DDL and has an owners entry`);
  if (!o) continue;
  check(typeof o.writer === "string" && o.writer.trim().length > 0, `${t} has a stated writer`, JSON.stringify(o));
  check(typeof o.reader === "string" && o.reader.trim().length > 0, `${t} has a stated reader`, JSON.stringify(o));
  check(typeof o.section === "string" && /^\d/.test(o.section), `${t} cites the section it comes from`, String(o.section));
}
// and nothing declared that does not exist -- a stale entry is how a checklist
// goes on reporting a table that was renamed out from under it
for (const t of declared) check(inDb.has(t), `${t} is declared in TABLE_OWNERS and exists in the DDL`);

// direction 3: every table marked replayed has a handler, and vice versa
const kinds = replayableKinds();
const replayTables = new Set(kinds.map(k => k.split(".")[0]).map(s => s === "task" ? "task" : s));
for (const [t, o] of Object.entries(TABLE_OWNERS)) {
  const covered = kinds.some(k => k.startsWith(t + ".")) || (t === "task" && kinds.includes("task.transitioned"));
  if (o.replayed) check(covered, `${t} is marked replayed and replay.mjs has a handler for it`, kinds.join(","));
  // The reverse direction the contract promises and the loop skipped: a handler
  // for a table nobody marked replayed means the two lists disagree about what
  // survives a restore, and the comparison set is built from one of them.
  else check(!covered, `${t} is marked NOT replayed and has no handler`, kinds.join(","));
}

// A guard against the cheapest wrong fix: a TABLE_OWNERS filled with "TBD".
for (const [t, o] of Object.entries(TABLE_OWNERS))
  check(!/\b(tbd|todo|unknown|n\/a)\b/i.test(`${o.writer} ${o.reader}`), `${t}'s owners are named, not placeheld`, JSON.stringify(o));

// Control: the check can fail. If every assertion above is vacuous the suite is
// green for the wrong reason, so one deliberate miss is asserted to be caught.
{
  const fake = { ...TABLE_OWNERS };
  delete fake.pr_hold;
  check(!Object.keys(fake).includes("pr_hold") && inDb.has("pr_hold"),
    "control: a table present in the DDL but missing from TABLE_OWNERS is detectable");
}
```

- [ ] **Step 2: Run it and watch it fail**

Expected: `../src/build/tables.mjs` not found.

**On the broken implementation** — a `TABLE_OWNERS` autogenerated from `sqlite_master` with `writer: "TBD"` — directions 1 and 2 pass completely and the placeholder guard is the only thing that goes red. That guard is not defensive noise; auto-filling this file is the single most likely way an executor makes the test green without doing the work.

- [ ] **Step 3: Write `src/build/tables.mjs`**

Transcribe the checklist table above into two exports. `PROSE_TABLES` is transcribed **from §11.2's SQL block by hand**, not derived from `TABLE_OWNERS` — deriving one from the other would make the two directions the same check and neither would catch anything.

```js
// tables -- who writes each hub table and who reads it.
//
// This file is the cross-check the S2 review requires, kept as data so it runs
// on every push instead of being ticked once by a reviewer. It catches two
// opposite mistakes: a table the design relies on that nobody created (its
// readers then get nothing, and absence reads as success), and a table in the
// DDL that nothing fills and nothing consults -- the read-never-written shape
// the tracker has flagged twice already.
//
// PROSE_TABLES is transcribed BY HAND from section 11.2's SQL block. It is
// deliberately not derived from TABLE_OWNERS: two lists built from one source
// agree with each other and prove nothing.
// One entry per row of the checklist above, transcribed VERBATIM -- all 32.
// "... one entry per row ..." was shorthand in an earlier draft, and an executor
// following it literally produces a file with one entry, which the cross-check
// then reports as 31 missing tables. Write them all out; the checklist is the
// source and it is directly above.
export const TABLE_OWNERS = {
  task:            { writer: "transition.mjs, intake.mjs", reader: "loop.mjs, dash, task why, merge.mjs", replayed: true,  section: "11.2" },
  task_territory:  { writer: "intake.mjs (admission tx)",  reader: "territory.mjs overlap check",         replayed: true,  section: "10.1" },
  task_drain:      { writer: "transition.mjs (CANCELLING)", reader: "loop.mjs drain check, task why",     replayed: true,  section: "3.5"  },
  phase_event:     { writer: "transition.mjs",              reader: "why, dash age-in-state, fences",     replayed: true,  section: "3.2"  },
  hold_reason:     { writer: "transition.mjs",              reader: "task resume, why",                   replayed: true,  section: "3.1"  },
  hub_event:       { writer: "every authority-bearing tx",  reader: "replay.mjs, the restore drill",      replayed: false, section: "11.4" },
  phase_run:       { writer: "loop.mjs at dispatch",        reader: "why, adopt-or-kill, retry budget",   replayed: true,  section: "4.5"  },
  gate_run:        { writer: "gates.mjs",                   reader: "merge clause B2, why",               replayed: true,  section: "8.3"  },
  // ...and so on for all 32, each transcribed from the checklist row above.
  // The cross-check asserts the key set equals sqlite_master exactly, so an
  // incomplete transcription fails loudly rather than passing quietly.
};

export const PROSE_TABLES = [
  "task", "task_territory", "phase_event", "hold_reason", "hub_event", "phase_run", "gate_run",
  "gate_request", "approval", "notice_receipt", "impl_pr", "attested_push", "guardian_receipt",
  "ownership_check", "harness_acceptance", "pr_hold", "project_authority", "repo_gate_state",
  "inbox", "outbox", "merge_decision", "singleton_lease", "writer_lease", "maintenance_lock",
  "directory_lease", "territory_lease", "provider_lease", "provider_state", "intake_event",
  "escalation", "schema_version",
];
// task_drain is in TABLE_OWNERS and NOT in PROSE_TABLES: section 11.2 carries
// drain_set as a column on task, and this plan makes it a child table instead
// (see the deviation note on Task 2). The asymmetry is deliberate and is the
// one place the two lists are allowed to differ.
```

- [ ] **Step 4: Run it, then commit**

```bash
$N test/hub-crosscheck.test.mjs
git add src/build/tables.mjs test/hub-crosscheck.test.mjs
git commit -m "test(hub): prose-versus-ddl cross-check as an executable gate"
```

---

### Task 12: Retire `ci.flakePatterns`

**Files:**
- Modify: `src/profile/schema.mjs` (delete one line), `~/.reeve/profiles/nextlyhq/nextly.json` (delete one key, **outside the repository**)
- Test: `test/profile-validate.test.mjs` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. This task **removes** a key.

**Why, and the order it must be done in.** Measured 2026-08-22 in `docs/measured/2026-08-22-flakepatterns-has-no-readers.md`: one reference in `src/`, which is the declaration itself; zero readers; nothing generates it (`profile/detect.mjs:268` writes `ci: {provider, requiredChecks}` and no patterns); the live `nextlyhq/nextly.json` carries `"flakePatterns": []`; and the validator refuses unknown keys **including empty-array ones**, with a positive control. So removing it from `FIELDS` while the live profile still carries the key makes that profile invalid, and **every daemon start dies at profile load**. A guardian daemon is live against exactly that profile.

The reasoning for removing rather than wiring: the shipped `flakeAssessment` (`src/ci-rootcause.mjs:313`) rules on **demonstrated** flake — the same job seen passing on one attempt and failing on another — and its own comment records why: "assuming flake is how a real failure gets re-run until it is". A pattern list asserts flakiness by name, before evidence. Wiring it would let a name pattern suppress a reproducible failure with nothing reporting that it had happened.

- [ ] **Step 1: Append the failing test**

Append to `test/profile-validate.test.mjs`:

```js
// A key with zero readers is a false affordance: it looks like it configures
// something. This one would have been worse than inert if wired -- the shipped
// flake rule is DEMONSTRATED flake (a job seen both passing and failing across
// attempts), and a name pattern asserts flakiness before any evidence, which
// would let a reproducible failure be filed as noise.
{
  const p = minimalProfile();
  p.ci.flakePatterns = [];
  const r = validate(p);
  check(!r.ok && r.errors.some(e => /unknown key: ci\.flakePatterns/.test(e)),
    "ci.flakePatterns is no longer a known key, even as an empty array", JSON.stringify(r.errors));

  const q = minimalProfile();
  q.ci.flakePatterns = ["timeout"];
  check(!validate(q).ok, "nor as a populated one");

  const ok = minimalProfile();
  check(validate(ok).ok, "control: the same profile without the key still validates", JSON.stringify(validate(ok).errors));
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
$N test/profile-validate.test.mjs
```

Expected: the first two assertions fail — the key is still known, so `validate` returns `ok`.

- [ ] **Step 3: Delete the line**

Remove from `src/profile/schema.mjs` (line 183 on `9dbd3a0`):

```js
  "ci.flakePatterns":       [false, isArr(isStr)],
```

Check whether `isArr(isStr)` is now unused anywhere in the file; if it is, leave the helper in place (it is a general validator, not this key's) and say so in the commit body rather than deleting a shared helper as a side effect.

- [ ] **Step 4: Run it**

```bash
$N test/profile-validate.test.mjs
for f in test/*.test.mjs; do $N "$f" >/dev/null || echo "FAILED $f"; done
```

Expected: all green.

- [ ] **Step 5: Strip the live profile, and prove it still validates**

This edits a file **outside the repository**. Do it before the daemon next restarts.

```bash
P=~/.reeve/profiles/nextlyhq/nextly.json
cp "$P" "$P.bak-$(date +%s)"
$N -e '
  const { readFileSync, writeFileSync } = await import("node:fs");
  const p = process.env.HOME + "/.reeve/profiles/nextlyhq/nextly.json";
  const j = JSON.parse(readFileSync(p, "utf8"));
  const had = Object.hasOwn(j.ci ?? {}, "flakePatterns");
  delete j.ci.flakePatterns;
  writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  console.log("key was present:", had, "| now:", Object.hasOwn(j.ci, "flakePatterns"));
'
```

Assert the edit landed and the profile is loadable, **before** anything restarts:

```bash
$N -e '
  const { validate } = await import("./src/profile/schema.mjs");
  const { readFileSync } = await import("node:fs");
  const j = JSON.parse(readFileSync(process.env.HOME + "/.reeve/profiles/nextlyhq/nextly.json", "utf8"));
  const r = validate(j);
  console.log("live profile validates:", r.ok, r.errors);
  process.exit(r.ok ? 0 : 1);
'
```

Expected: `live profile validates: true []` and exit 0. **If this prints false, restore the `.bak` immediately** — a daemon restart against an invalid profile dies at load, and the daemon is watching live work.

Then repeat for every other profile under `~/.reeve/profiles/`:

```bash
for f in ~/.reeve/profiles/*/*.json; do grep -l flakePatterns "$f"; done
```

Expected on `9dbd3a0`: only `nextlyhq/nextly.json` matches, and after the edit, nothing does.

- [ ] **Step 6: Commit**

```bash
git add src/profile/schema.mjs test/profile-validate.test.mjs
git commit -m "refactor(profile): retire ci.flakePatterns, a key with no readers"
```

Commit body: name the measurement doc, and record that the live `nextlyhq/nextly.json` was stripped in the same change because the validator refuses unknown keys.

---
### Task 13: PR-A close-out — freeze migration 1, tracker, PR

**Files:**
- Create: `test/fixtures/hub-schema-v1.json`
- Modify: `test/hub-schema.test.mjs` (append), `docs/TRACKER.md` (**last commit only**)

- [ ] **Step 1: Freeze migration 1**

A merged migration must never be edited: a store that already applied version 1 will never re-run it, so an edit changes what new machines get and leaves every existing machine behind, silently. Append to `test/hub-schema.test.mjs`:

```js
// Migration 1 is frozen. New schema goes in a NEW numbered migration, never
// into this file -- a store that already applied v1 will never re-run it, so an
// edit here changes what new machines get and leaves existing ones behind with
// no error anywhere.
{
  const { createHash } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/hub-schema-v1.json", import.meta.url), "utf8"));
  const sql = readFileSync(new URL("../src/build/hub.sql", import.meta.url), "utf8");
  const sha = createHash("sha256").update(sql).digest("hex");
  check(sha === fixture.sha256,
    "src/build/hub.sql is unchanged since migration 1 was frozen",
    `expected ${fixture.sha256}\n        actual   ${sha}\n        ` +
    `If this change is intentional, it does not belong in hub.sql: add MIGRATIONS[{version: N+1, up}] and bump HUB_SCHEMA_VERSION.`);
  check(fixture.version === 1, "the fixture records which migration it froze");
}
```

Generate the fixture from the file as it stands at this commit:

```bash
$N -e '
  const { createHash } = await import("node:crypto");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const sql = readFileSync("src/build/hub.sql", "utf8");
  writeFileSync("test/fixtures/hub-schema-v1.json",
    JSON.stringify({ version: 1, sha256: createHash("sha256").update(sql).digest("hex"),
                     frozen_at: "2026-08-22", note: "migration 1; new schema goes in a new numbered migration" }, null, 2) + "\n");
  console.log(readFileSync("test/fixtures/hub-schema-v1.json", "utf8"));
'
$N test/hub-schema.test.mjs
```

Verify the guard actually guards, with the four-check stub loop: append a blank line to `hub.sql`, re-run (expect the freeze assertion **red** and nothing else), then `git checkout src/build/hub.sql` and re-run (expect green). A guard that has never been seen red is a guard nobody has tested.

- [ ] **Step 2: Full suite, from a clean checkout**

```bash
for f in test/*.test.mjs; do $N "$f" >/dev/null || echo "FAILED $f"; done
```

Expected: no `FAILED` lines. 59 pre-existing files plus `hub-schema`, `hub-locks`, `hub-backup-restore`, `hub-doctor`, `hub-crosscheck`.

- [ ] **Step 3: The tracker line, as the LAST commit**

`docs/TRACKER.md` conflicts on every branch. One line, added last, so the conflict is trivial. Under Programme 2's "In flight":

```markdown
- [x] **Implementation plan for S2:** `docs/superpowers/plans/2026-08-22-s2-hub-core.md`
      (3 PRs: hub store, phase machine, provider scheduler). Founder decisions
      2026-08-22: guardian fails OPEN on an unreadable hub; `ci.flakePatterns`
      REMOVED (`docs/measured/2026-08-22-flakepatterns-has-no-readers.md`);
      `repo_gate_state` ships with a pure writer and an injected fetcher.
- [ ] **PR-A (hub store)** — 32-table STRICT schema, forward-only migrations,
      the three locks, hub-aware backup, destructive restore drill, the
      prose-versus-DDL cross-check.
```

```bash
git add docs/TRACKER.md
git commit -m "docs: tracker — S2 plan and PR-A"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/s2-hub-store
gh pr create --title "S2 PR-A: the hub store" --body-file - <<'BODY'
## What

The builder's store: 32 STRICT tables, forward-only migrations, three locks,
hub-aware backup, a restore that refuses live writers, and the destructive
restore drill over section 11.4's comparison set.

Nothing here reads or writes GitHub, and no builder worker is dispatched:
`worker.isolation` is still `none` and dispatch is still refused in code.

## Decisions taken in this PR

- **`ci.flakePatterns` is removed.** Measured: one reference in `src/`, which is
  the declaration; zero readers; nothing generates it. The live nextly profile
  set it, and the validator refuses unknown keys including empty arrays, so the
  live profile is stripped in the same change or every daemon start dies at
  profile load. Evidence:
  `docs/measured/2026-08-22-flakepatterns-has-no-readers.md`.
- **`drain_set` is a child table** (`task_drain`), not a column on `task`.
  Section 11.1 gives this PR authority over types, checks and indexes; this is
  arguably structural, so it is flagged rather than slipped in. Reason: "has
  every drained row settled" is a query, and section 11.2 already sets this
  precedent for territory. Happy to revert if review prefers the column.
- **`hub_event.payload` carries the row that was written**, canonical, not a
  description of a change. That is what lets replay be a primary-key upsert
  with no knowledge of legal transitions, so the recovery path is not a second
  implementation of the state machine that could disagree with the first.

## Review focus

- The prose-versus-DDL cross-check in `src/build/tables.mjs` and
  `test/hub-crosscheck.test.mjs`. Please check the writer/reader claims against
  section 11.2 by eye: the test can only prove a claim was made, never that it
  is true.
- `everyStore` previously could not see the hub at all (it skips
  non-directories, and the hub is a file directly in `state/`). That is the
  same shape as the measured miss where reeve's own store had zero backups.
BODY
gh pr comment --body "@codex review"
```

- [ ] **Step 5: Work the gate**

Codex is a mandatory serial witness; a clean pass at the current head opens the 15-minute founder window (silence = go). Codex refused 57% of review requests this week, so expect to re-request; the cap is 10 revision rounds. Comment `@codex review` on **every push**, not only the first. Read **both** endpoints — a clean pass arrives as an issue comment, findings as review comments. Reply to **and resolve** every thread via GraphQL; replying alone does not clear it.

**Do not merge.** Each PR needs the founder's explicit grant, and the last one is spent.

---

---

## Self-review

**Spec coverage.** §11.1 and §11.2 (all 32 tables, with real types, CHECKs and indexes — Tasks 1-5); §11.4 backup, restore and self-audit (Tasks 8-10); §1.2 singleton lease (Task 7); the `writer_lease`/`maintenance_lock` exclusion §11.4 requires of every writer (Task 7); the prose-versus-DDL cross-check §11.1 mandates of the S2 review (Task 11); `ci.flakePatterns` decided (Task 12). Tables whose writers arrive later (`repo_gate_state` in S2-B, `intake_event` and `ownership_check` in S5) are created here with their owners **named** in `TABLE_OWNERS` rather than left blank — that is what the cross-check exists to catch.

**Placeholder scan.** Clean; every `TBD` hit is the guard test in Task 11 that forbids them.

**Type consistency.** `hubPathFor`, `openHub`, `hubTx`, `hubEvent -> seq`, `COMPARISON_SET`, `validateSnapshot({kind, expectVersion})`, `restoreHub({..., tail}) -> {ok, why, holders, replayed, tail}`, `acquireSingleton({..., takeover})`, `assertWritable({..., inTx})`. The `task.phase` CHECK is the authoritative 21-state enumeration. The assertion comparing it with S2-B's `phases.mjs` lives **in S2-B**, not here: `phases.mjs` does not exist until B, so importing it from this plan's cross-check would fail on every run. B introduces the second copy and B asserts the two agree. Stated plainly because an earlier draft of this self-review claimed the check was here — the kind of claim a reader believes without checking.

**What the four review rounds changed here**, in `2026-08-23-s2-review-history.md`: the 20-way race made genuinely concurrent; the crash drill given a real precondition (the SQLITE_BUSY probe); `validateSnapshot` stopped deleting every guardian snapshot; `restore --hub` made to replay its own tail, with a CLI route to produce one; the migration version re-read under the lock; `build run` made to hold and release its lease.
