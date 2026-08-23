# Where a scribble has to land to corrupt a SQLite database

Measured 2026-08-23 on node v24.17.0 (`node:sqlite` `DatabaseSync`), macOS 25.6.

## The question

Two review findings (revnix/reeve #11 thread `beLMG`, #12 thread `bePXe`)
asserted that the corruption drills' technique —

```js
const fd = openSync(p, "r+"); writeSync(fd, Buffer.alloc(4096, 0x41), 0, 4096, 8192); closeSync(fd);
```

— "merely appends unused pages beyond the database's declared page count", so
`PRAGMA integrity_check` keeps returning `ok` and the drill proves nothing. One
finding stated this had been reproduced locally.

## The measurement

Default `page_size` is 4096, so offset 8192 is **page 3**. Whether the write
corrupts anything is therefore decided by one number: `PRAGMA page_count`.

| fixture | page_count | file | `integrity_check` after the write |
|---|---|---|---|
| empty database, no tables | 1 | 4096 B | `ok` — the claim holds here |
| 1 table, no index | 2 | 8192 B | `ok` — the claim holds here |
| 1 table + 1 index | **3** | 12288 B | `*** in database main *** Tree 3 page 3: btreeInitPage() returns error code 11` |
| 32 tables + 32 indexes | 67 | 274432 B | same malformed-page error |
| 32 tables + 32 indexes + 60 rows | 67 | 274432 B | same malformed-page error |

In every corrupt case a subsequent `SELECT` also throws
`database disk image is malformed`, so the drill's `openHub` assertion is
reached the way it intends.

**The threshold is `page_count >= 3`.** Both drills build their fixture with
`openHub(p)` — 32 tables plus their indexes, **67 pages**. The finding is
correct as a general statement about tiny databases and false about the
databases these two tests actually construct.

## What was changed anyway

The technique is right and the *constant* is fragile: 8192 is only a live page
because the fixture happens to be large, and nothing in either test says so. If
a later revision trimmed the fixture below three pages, the write would land
past the end and the assertion under it would pass while proving nothing —
which is the failure mode both drills exist to rule out.

So both drills now derive the offset from the file itself,

```js
const { page_size, page_count } = /* PRAGMA page_size, PRAGMA page_count */;
const off = (page_count - 1) * page_size;      // the last live page, whatever the fixture's size
```

and each asserts, as a **control**, that `integrity_check` no longer returns
`ok` before asserting that the code under test reports the corruption. The
control is the durable half: it fails loudly if the technique ever stops
working, instead of letting the assertion beneath it pass vacuously.

Reproduction script: the table above was produced by building each fixture with
`DatabaseSync`, closing it, reading `PRAGMA page_size` / `page_count`, writing
the 4096-byte scribble, and re-opening read-only to run `integrity_check`.

Related: `docs/measured/2026-08-22-refusal-is-one-shape-per-reason.md` (same
discipline — check the claim against the real artefact before acting on it).
