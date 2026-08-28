# Measured — the spill handlers, 2026-08-28

## The constraint rebuild is still free

Re-measured immediately before relying on it, because the earlier reading was
recorded as one that expires:

```
~/.reeve/state/nextlyhq/nextly.db -> 0 row(s)
~/.reeve/state/revnix/reeve.db    -> 0 row(s)
```

Both outboxes empty, so `RESHAPED` rebuilds rather than refuses. The moment a
spill is enqueued this stops being true, and the refusal path is what runs
instead — which is why that path is tested rather than assumed.

## The rebuild proven against a copy of the live store

Not a fresh fixture. A byte copy of the real database, 39,930 events:

```
CHECK now allows gh.issue.create: true
depends_on survived the rebuild:  true
index rebuilt:                    true
history intact:                   39930 events
an issue-create effect enqueues:  true
```

The ordering matters and is easy to get wrong: `reshapeTables` drops, `schema.sql`
recreates with the widened CHECK and the `depends_on` column, then
`addMissingIndexes` puts `outbox_depends` back. A rebuild that ran after the index
step would leave the index missing on exactly the stores it rebuilt.

## A defect found by reading the seam instead of assuming it

`apiAsInstallation` runs `execFileSync("gh", ["api", ...args])`, so the caller
supplies everything AFTER `gh api`. Both new GraphQL calls were written as
`api(["api", "graphql", ...])`, which produces `gh api api graphql`.

It would have failed at run time and in no test that mocks the seam. Found by
reading `src/github/app.mjs` rather than by pattern-matching the neighbouring
handler, which uses REST and therefore looks different. There is now an assertion
on the call's first element, and stubbing the prefix back turns it red.

## A test whose matcher could never fire

The first run of `test/spill-handlers.test.mjs` reported two failures that were
the test's fault, not the code's. `Array.includes` is exact ELEMENT equality, not
a substring search, so a matcher written as `argv.includes("query=query")` never
fired — the recorder fell through to its default answer, and the assertions then
measured the default rather than the case they named.

Same family as the rest: the instrument measured something adjacent to the
property, and the adjacent thing was chosen because it was easier to write.

## The stub sweep

Six defect classes, exit codes read rather than output lines, green control
before, clean restore after.

```
GREEN CONTROL          exit=0
reshape-check          exit=1  RED
reshape-refusal        exit=1  RED
issue-author-check     exit=1  RED
thread-read-first      exit=1  RED
graphql-prefix         exit=1  RED
issue-number-required  exit=1  RED
after-restore          exit=0
```

Run by hand because `scripts/stub-sweep.mjs` has not merged yet. They become
manifest entries as soon as it does.

Suite: 100 files, 5,459 PASS, 0 FAIL.
