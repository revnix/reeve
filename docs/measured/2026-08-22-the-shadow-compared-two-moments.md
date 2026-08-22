# Measured: the shadow week's divergences were the instrument, not the derivation

Date: 2026-08-22. Against the live `nextlyhq/nextly` daemon state.

## What the shadow said

The review shadow week reset on 2026-08-22 with four recorded divergences:

| day | PR | agreed | reported |
|---|---|---|---|
| 08-22 | #1134 | 99/102 | `resolved differs: live 13, derived 18` |
| 08-21 | #1128 | 50/51 | `thread count differs: live 55, derived 50` |
| 08-21 | #1131 | 35/36 | `resolved differs: live 4, derived 5` |
| 08-21 | #1133 | 121/122 | `thread count differs: live 15, derived 14` |

Each one is a claim that reeve's derived review state disagrees with GitHub's.
That claim gates PR-5, where the verdict stops reading GitHub on every tick and
starts consuming projections.

## What the pair actually says

Taken **back to back** — a live read, an ingest, then the projection — all four
agree exactly:

| PR | live (total/resolved) | derived (total/resolved) | verdict |
|---|---|---|---|
| #1134 | 31 / 26 | 31 / 26 | AGREE |
| #1128 | 55 / 7 | 55 / 7 | AGREE |
| #1131 | 8 / 8 | 8 / 8 | AGREE |
| #1133 | 20 / 19 | 20 / 19 | AGREE |

The derivation is sound. What differed was **when each side was read**.

## The mechanism

In one tick, in this order:

1. `evaluate()` reads GitHub live. That reading is `e.threads`.
2. `observe()` + `ingest()` read GitHub **again**, and write what they find.
3. `derivePr()` + `reviewState()` build the projection from what step 2 wrote.
4. `compare(e.threads, projection)` — **step 1's reading against step 3's**.

So any pull request that moved between steps 1 and 2 was recorded as the
derivation disagreeing. The probe above is not indirect evidence of this: the
ingest it ran was still inserting **five threads** on #1128, which is exactly
that PR's reported gap of five.

An instrument that reports a divergence for a PR that simply moved cannot be
used to decide whether the derivation is trustworthy, which is the only question
it exists to answer. Its own header warns about the other half of this:

> an instrument that cries wolf on correct behaviour teaches its reader to
> ignore it, and then it is not an instrument.

## The fix

The live side of the comparison is **the observation that fed the projection**,
not a second read taken after it.

The first attempt at this retook the live read after the ingest. Codex pointed
out that this only narrows the window rather than closing it: a thread that
changes between `observe()` returning and the retake completing produces exactly
the same false divergence. That is right, and the better answer costs less —
`observe()` already paginates the whole thread set, so the counts come from a
read reeve was making anyway, and there is no second moment to disagree with.

A tick that did not observe has no snapshot. Comparing the older projection
against anything would be comparing two moments again, so such a tick is
INCOMPARABLE: neither agreement nor disagreement, which the shadow already
handles as "a tick where nothing was learned". It costs volume on quiet pull
requests and buys an instrument whose every remaining comparison is sound.

## What this does NOT establish

Whether the ingest is also **missing** threads for a reason of its own. Five
threads on #1128 had never been ingested, and the `moved` guard skips the ingest
entirely when a PR's `updatedAt` has not changed. That is a separate question,
and it is now answerable: with the instrument comparing one moment against
itself, a divergence that survives is a real one.

Nothing here affects live judgement. The verdict reads GitHub directly; the
projection is shadow-only until PR-5.
