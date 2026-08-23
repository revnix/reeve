# What `PRAGMA integrity_check` costs, and why it left the per-tick path

Measured 2026-08-23 on node v24.17.0 (`node:sqlite` `DatabaseSync`), macOS 25.6.

## Why this was measured

A previous round moved validation into `latestSnapshot`, so the read path would
stop handing back a snapshot that fails at restore time. That was right, and it
had a consequence nobody costed: `selfaudit.mjs` calls `latestSnapshot` **once
per discovered store and again for the current repository** (`:48`, `:56`), and
`src/daemon.mjs:1334` runs `selfAudit` on **every guardian tick**. So every
daemon began full-database scans of immutable files every 90 seconds, forever.

## The measurement

A 32-table hub with indexes, at four sizes. Each figure is a mean over 20 runs
(5 for the largest), open-to-close, read-only:

| rows in the largest table | file | `PRAGMA integrity_check` | marker query | ratio |
|---|---|---|---|---|
| 0 | 0.3 MB | 0.32 ms | 0.25 ms | 1× |
| 5,000 | 1.4 MB | 1.27 ms | 0.27 ms | 5× |
| 50,000 | 11.9 MB | 11.75 ms | 0.30 ms | 39× |
| 200,000 | 47.0 MB | 51.85 ms | 0.66 ms | 78× |

`integrity_check` scales with the file — roughly **1.1 ms per megabyte**, because
it reads every page. The marker query is flat: it touches one b-tree root
whatever the database holds.

**On the tick path that is ~155 ms per tick** for two stores at 47 MB, added to a
serial loop, growing with the store and repeated every 90 seconds against files
that cannot have changed since the last check. Snapshots are immutable.

## What changed

`validateSnapshot(path, { expectVersion, kind, deep = false })` now has two
depths, and the callers pick:

- **Cheap (default)** — open read-only, query the store's marker table, read
  `schema_version`, and compare the snapshot's table set against the full
  expected set for that version. Flat cost. This is what `latestSnapshot` uses,
  and it still catches every failure the read path cares about: not a database,
  wrong schema version, missing marker, missing authority-bearing tables.
- **Deep (`deep: true`)** — the above plus `PRAGMA integrity_check`. Used by
  `snapshotAll` on the snapshot it has just written (hourly, and verifying a
  fresh write is the whole point) and by `restoreHub` before it replaces
  anything (once, where a full scan is cheap against what a bad restore costs).

The page-level corruption a deep check catches is not a failure mode the *read*
path can act on differently anyway: `latestSnapshot`'s job is to pick a
candidate, and the restore that follows validates deeply before touching the
live file.

Reproduced by building each fixture with `DatabaseSync`, closing it, then timing
open → `PRAGMA integrity_check` → close against open → `SELECT count(*)` → close.
