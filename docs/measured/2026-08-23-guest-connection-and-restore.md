# What `node:sqlite` actually does at the guest-connection boundary

Measured 2026-08-23 on node v24.17.0 (`DatabaseSync`), macOS 25.6, against four
claims raised in review on revnix/reeve #13.

## 1. An open handle does NOT notice an atomic rename over its path

The daemon's health probe assumed that after `restoreHub` stages a file and
renames it over `~/.reeve/state/hub.db`, a query on the already-open handle would
throw and the catch would re-open. It does not throw at all:

```
before rename:            [{"owner":"old","n":1}]
inode changed:            true
OLD handle after rename:  OK {"c":1}
OLD handle sees rows:     [{"owner":"old","n":1}]     <- the REPLACED inode
FRESH handle sees rows:   [{"owner":"new","n":2}]     <- the restored file
```

POSIX `rename(2)` unlinks the directory entry, not the inode, and SQLite holds
the file descriptor. So the guardian keeps reading the pre-restore database
indefinitely, silently, with no error to catch — scheduler leases and `pr_hold`
rows that no longer exist anywhere else. **A try/catch probe cannot detect this.**
Identity has to be compared (`stat().ino` of the path against the handle's), or
the handle closed as part of restore.

## 2. `serialize()` is covered by the authorizer

Claimed: `serialize()` "returns the entire database image without issuing an
authorizer-checked SQL statement", so a guest could read `task` and `approval`
while every statement test passes.

Measured: with `setAuthorizer(() => SQLITE_DENY)`,

```
a DENIED statement says:  "not authorized"
serialize() THREW:        "not authorized"
```

The claim does not hold on this build. `serialize` is still added to the shadow
list, for a reason the finding did not give: whether SQLite routes `serialize`
through the authorizer is SQLite's choice, not reeve's, and a boundary should
not depend on an implementation detail of the thing it is guarding. The
assertion records what was measured, so a future build that changes this is
caught rather than assumed.

## 3. A denied statement's wording is SQLite's, not reeve's

The refusal suite asserted the error text matched `/allowlist|not permitted/`.
Neither string ever appears:

| denied action | message |
|---|---|
| `SQLITE_READ` | `access to provider_state.owner is prohibited` |
| `SQLITE_SELECT` | `not authorized` |
| `SQLITE_INSERT` | `not authorized` |

So the assertion as written **fails against a correct implementation** — the
worst kind of wrong test, because the natural response to it is to weaken the
authorizer until the text changes. The suite now matches the native wording and
carries a positive control that a permitted statement still succeeds.

## 4. The authorizer cannot tell one `BEGIN` from another

`SQLITE_TRANSACTION` (action **22**) reports only the keyword:

```
BEGIN IMMEDIATE   events=["22/BEGIN/-"]  OK
BEGIN EXCLUSIVE   events=["22/BEGIN/-"]  OK
BEGIN DEFERRED    events=["22/BEGIN/-"]  OK
BEGIN             events=["22/BEGIN/-"]  OK
COMMIT            events=["22/COMMIT/-"]
ROLLBACK          events=["22/ROLLBACK/-"]
SAVEPOINT sp      events=["32/BEGIN/sp"]   (SQLITE_SAVEPOINT = 32)
```

`arg1` is `BEGIN` for every flavour, so `case SQLITE_TRANSACTION: return OK`
admits `BEGIN EXCLUSIVE` — a guest taking an exclusive lock blocks the builder
and every restore. **The authorizer is the wrong layer for this**: the allowed
transaction *shapes* have to be gated in the facade, on the SQL string, before it
reaches SQLite. `SAVEPOINT` arrives as its own action, so a `default: DENY`
refuses it without extra work.

Reproduced by: opening a `DatabaseSync`, installing an authorizer that records
`(action, arg1, arg2)` and permits only actions 22 and 32, then `exec`-ing each
form.
