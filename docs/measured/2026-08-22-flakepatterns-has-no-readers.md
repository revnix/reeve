# `ci.flakePatterns` has no readers, and removing it kills the daemon

**Measured 2026-08-22** on `plan/s2-hub-core` at `9dbd3a0`, node v24.17.0.

## The question

`docs/TRACKER.md` carries a standing note from the flake-detection work
(`39a5ce9`): `ci.flakePatterns` is declared in the profile schema with zero
readers, "wire or remove when the builder design lands". §13 of the builder
design assigns that decision to S2. This is the measurement it rests on.

## What was run

```
$ git grep -n "flakePatterns" -- src/
src/profile/schema.mjs:183:  "ci.flakePatterns":       [false, isArr(isStr)],

$ git grep -c "flakePatterns" -- src/ | wc -l
1
```

One reference in `src/`, and it is the declaration itself. **Zero readers.**

`git grep` is used rather than `grep`: `grep` on this host is shadowed by
`ugrep`, which skips files it classifies as data. A count is reported rather
than a listing, and the listing above is complete rather than `head`-ed, so
the absence is a count and not a first-page impression.

## The live profile sets it

```
$ grep -rn "flakePatterns" ~/.reeve/profiles/
/Users/mobeen/.reeve/profiles/nextlyhq/nextly.json:120:    "flakePatterns": [],
```

The value is the empty array.

## Removing it from FIELDS invalidates that profile

`validate()` in `src/profile/schema.mjs` refuses unknown keys
(`errors.push("unknown key: " + p)`) and validation is fail-closed. The open
question was whether an **empty array** even reaches the unknown-key check, or
whether `flatten()` skips it — an empty array is a plausible thing for a
flattener to drop, and if it were dropped, removal would be free.

It is not dropped. Run against the live profile, with a positive control:

```
live nextly ci.flakePatterns = []
live profile validates TODAY: true
empty-array unknown key REFUSED: true
   errors: [ 'unknown key: ci.bogusPatternsXYZ' ]
control non-empty unknown key REFUSED: true
```

The control is there because a `true` from the empty-array case alone cannot
distinguish "the check fires on empty arrays" from "the check fires on
everything and I have learned nothing specific". Both shapes are refused, so
the empty array genuinely reaches the check.

**Therefore:** deleting `"ci.flakePatterns"` from `FIELDS` while
`~/.reeve/profiles/nextlyhq/nextly.json` still carries the key makes that
profile invalid, and every daemon start dies at profile load. The removal and
the profile edit are one change, not two.

At the time of measurement a guardian daemon was live against that exact
profile — pid 12574, started Sat Aug 22 21:01:06 2026,
`bin/reeve run nextlyhq/nextly` — so the blast radius is not hypothetical.

## The decision this supports

**Remove.** Founder ruling 2026-08-22.

The shipped flake behaviour (`flakeAssessment`, `src/ci-rootcause.mjs:313`)
rules on **demonstrated** flake: the same job observed passing on one attempt
and failing on another. Its own comment states the rule and the reason —
"assuming flake is how a real failure gets re-run until it is". A pattern list
is the inverse: it asserts a job is flaky by name, before any evidence exists.
Wiring it would let a name pattern suppress a reproducible failure, and nothing
in the system would report that it had happened.

A key with zero readers is also a false affordance on the configuration
surface: it looks like it does something. The tracker already flags two others
of the same shape (`e.threadDetails`, `decision.lane`); this one is retired
rather than joined.
