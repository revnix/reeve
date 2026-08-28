# Measured — the outbox dependency edge, 2026-08-28

Every claim below was produced by running the command shown, on this machine,
on 2026-08-28. Anything not measured is marked as intent.

## SQLite accepts the column, and the old CHECK still binds

Probed on a scratch database rather than reasoned about, because both answers
decide a design and neither is obvious from the documentation.

```
ALTER TABLE outbox ADD COLUMN depends_on INTEGER REFERENCES outbox(id);   -> rc=0
INSERT INTO outbox(id,kind) VALUES(1,'gh.issue.create');
  -> Error: CHECK constraint failed: kind IN ('a','b') (19)
```

So an additive nullable column carrying a REFERENCES clause migrates cleanly,
and a widened `CHECK` does NOT arrive by the same route. The second failure is
LOUD at insert time rather than silent — but it would fire inside the daemon on
the first spill, not when the migration ran, which is the part that matters.

## Both live stores hold zero outbox rows

```
~/.reeve/state/nextlyhq/nextly.db  -> 0
~/.reeve/state/revnix/reeve.db     -> 0
```

This is what makes the `CHECK` widening free for the NEXT change in this
programme: `RESHAPED` in `src/db/ops.mjs` rebuilds a table only when it is empty
and refuses otherwise, and both stores satisfy that today. The same condition is
what let the `inbox` reshape ship. If a spill is ever enqueued before that change
lands, this measurement expires and the rebuild needs a real migration.

## A defect the whole suite could not see

A full suite of 5,298 assertions passed while `open()` was broken for every
database holding history.

`open()` executes `schema.sql` BEFORE `addMissingColumns`. On an existing table
`CREATE TABLE IF NOT EXISTS` does nothing, so an index in `schema.sql` naming a
not-yet-added column throws:

```
Error: no such column: depends_on
    at open (src/db/ops.mjs:121)
```

It was found by opening a COPY of the live store — 39,133 events — and it was
invisible to the suite because every test database is built fresh from
`schema.sql`, where the column exists before the index. A fixture that cannot
exhibit the defect proves nothing about it.

The index moved to `ADDED_INDEXES`, applied after the columns. After the fix, on
the same copy:

```
depends_on after open(): true
index created: true
edge stored on the populated store: true
second open succeeded: true
```

`test/outbox-dependency-edge.test.mjs` now BUILDS a pre-column outbox by hand and
opens it, with a control asserting the fixture genuinely lacks the column — so
the guard is tested against the tree that should fail it.

## The stub sweep

Seven defect classes stubbed back in one at a time, exit codes read rather than
output lines, with a green control before and a hash-clean restore after.

```
GREEN CONTROL   exit=0
lease-gate      exit=1  RED
cascade         exit=1  RED
missing-throws  exit=1  RED
dangling-edge   exit=1  RED
terminal-settle exit=1  RED
blocked-report  exit=1  RED
index-order     exit=1  RED
after-restore   exit=0
```

Suite after the change: `npm test` exit 0, 97 files, 5,304 PASS, 0 FAIL.
