# `PRAGMA integrity_check` does not see foreign-key violations

**Measured 2026-08-23.** Node `v24.17.0`, `node:sqlite`, SQLite **3.53.0**.

## The question

`validateSnapshot(..., { deep: true })` gated a snapshot's usability on
`PRAGMA integrity_check` alone. Does that reading cover the declared foreign
keys the hub schema relies on, or only physical page structure?

## The measurement

A two-table database with a declared foreign key, given one orphaned child row
by inserting it with `PRAGMA foreign_keys = OFF` — which is how a snapshot of a
store whose writer had them off, or a hand-edited file, would come to hold one:

```js
db.exec(`CREATE TABLE parent(id INTEGER PRIMARY KEY) STRICT;
         CREATE TABLE child(id INTEGER PRIMARY KEY, p INTEGER NOT NULL REFERENCES parent(id)) STRICT;`);
db.exec("PRAGMA foreign_keys = OFF");
db.exec("INSERT INTO parent(id) VALUES(1); INSERT INTO child(id,p) VALUES(1,999);");
```

Read back on a fresh read-only handle:

```
sqlite_version      : 3.53.0
integrity_check     : "ok"
foreign_key_check   : [{"table":"child","rowid":1,"parent":"parent","fkid":0}]
```

**Positive control** — the same `integrity_check`, on the same file, after
4096 bytes of `0x41` were written over page 2:

```
control (corrupted) : "*** in database main ***\nTree 2 page 2: btreeInitPage() returns error code 11"
```

So the `"ok"` above is a real answer from a working instrument, not a check that
only knows one word.

## Consequence

A snapshot holding an orphaned authority row — an `outbox` row whose
`phase_event` is gone, a `task_territory` whose `task` is gone — passed deep
validation, was retained as the newest usable recovery point, and would have
been restored over a live hub. Every such row is one the schema's declared
foreign keys exist to make impossible, and `restoreHub` opens the result with
`PRAGMA foreign_keys = ON`, so the inconsistency surfaces later as a write
failure in an unrelated transaction rather than at the restore.

`validateSnapshot`'s deep path therefore runs **both**: `integrity_check` for
physical structure, then `foreign_key_check`, rejecting any returned row and
naming the first few. The cheap path runs neither — it is on the per-tick
`latestSnapshot` route, and `2026-08-23-integrity-check-cost.md` measures why
nothing full-scan belongs there.

Found by review on PR #11 (thread `bfQj-`), and confirmed here rather than
accepted: the previous SQLite claim from the same reviewer was refuted by
measurement, so neither direction is taken on faith.
