# Measured: the instrument was in the canary's id and not in its key

Date: 2026-08-23. Found while re-running the canary on merged code and noticing
its id had changed for no reason anyone could name.

## Two ids, and neither did what the comments said

`canaryIdFor` documents why the script belongs in the identity:

> A record made before a probe existed describes a weaker measurement than the
> one being asked for now, and reusing it is how the by-path keychain reach
> stayed unmeasured while a passing record said containment was closed.

It was passed a `script` in exactly one place — `sandboxCanary`, for the id it
RECORDS. The cache key, in `containment.mjs`, was computed without one.

So there were two different values: the recorded id, and the key everything is
actually looked up by.

## Why the key could not have included it

The script embeds the run's tmp and outside directories, its two decoy paths and
the daemon-local listener's URL. `normaliseRules` rebases only the worktree, so
none of the rest normalised out:

```
invocation A id: 8a4915240ea38b27  policy: 064ab8f6ceed591c
invocation B id: 8985d7e07a440cce  policy: 064ab8f6ceed591c

policy hash stable across invocations : true
canary  id   stable across invocations: false
identical inputs reproduce the id     : true
only the listener PORT differs        : id CHANGED
```

The policy half was already stable — `normalisePolicy` fixed exactly this class
once, for quarantine denies rooted at a per-invocation worktree, with the note
that otherwise "the cache could never hit and every wanted task paid another
five-minute model canary". The script reintroduced it.

Which is why the key omitted the script: including it would have made the cache
useless. The two constraints were traded against each other rather than both
being met.

## What that cost

The guarantee the script was put in the id for did not exist. A canary script
strengthened with a new probe went on reusing a pass taken before that probe
existed, because the key never saw the difference.

Its practical reach is narrow — changing the script means changing the code, and
that means restarting the daemon, which empties the in-process cache. What was
not narrow is that the recorded id identified nothing: two runs of one policy and
one instrument produced different values, and `reeve doctor`, `docs/TRACKER.md`
and two handoff documents have all quoted canary ids as though they did.

`dae5b2c1f1f59777` and `7e14000fb54d28f5`, recorded four hours apart and read as
evidence of a change, are very likely the same measurement.

## The fix

`instrumentHash({ hasNet })` hashes `canaryScript`'s own text with every
per-invocation value placeholdered. It is stable, so one value serves as both the
recorded id and the cache key, and both call sites compute it.

`hasNet` is the one input that changes what the script DOES rather than where it
points: with no listener the network positive control is absent, and a pass
measured without it is a weaker measurement. Editing `canaryScript` changes the
hash because the hash is over that function's output.

`sandboxCanary` derives it from `!!netProbe` rather than `!!netProbe.url`, so it
is computable before the script exists — which is what lets the cache key match.
The two can disagree only when a listener was handed over and failed to bind, and
a canary whose network control is missing fails on that alone.

## What the test had to be told

Every existing cache test injected a canary FUNCTION, so the real id producer
never ran and the drift between the two values could not be observed. The new
test drives `measureContainment` with the real `sandboxCanary` behind a stub
runner, so both call sites are exercised.

Stubbing each half back out separately:

| stub | red |
|---|---|
| id hashes the raw per-invocation script | the two "the verdict carries the id" assertions |
| the cache key omits the instrument | "a run WITHOUT the network control does not reuse the pass measured with it" — it comes back `cached: true` |

The second is the original defect, reproduced.

## The persisted record needed the same treatment

Raised by Codex on #14, and it is a consequence of this change rather than a
pre-existing defect: after the upgrade, a canary record can carry the same binary
identity and the same policy hash while its id was produced by the previous,
weaker instrument. The daemon's in-memory cache is emptied by the restart that
loads the new code, but `reeve doctor` reads the PERSISTED record, and
`checkCanary` compared only `binaryId` and `policyHash`.

So the instrument is written into the record and compared there too. A record
whose instrument differs is DEGRADED; a record with no instrument at all cannot
be compared and is UNKNOWN, never OK — the same treatment a record with no
`binaryId` or no `policyHash` already got.

Live immediately after the change, against the record written that morning:

```
UNKNOWN
  R-14  worker sandbox canary
        canary 7e14000fb54d28f5 passed 548 min ago, but the record names no instrument
        so it cannot be checked against the canary script in use now; the daemon re-measures before it dispatches
```

Which is the correct reading: that measurement was taken with a different
instrument, and nothing about it can be matched to the one in use now.

## And the comparison had to be against the right instrument

Raised by Codex in the second round, and it is the sharper half of the previous
section. `checkCanary` defaulted its expectation to `instrumentHash()` — the
NO-network variant, because that is the parameter default.

`measuredContainment` always builds a `netListener`, so every canary it records
carries the network control and persists the hasNet instrument. The two never
match. Every freshly recorded PASS would have been reported as a changed script:
permanently DEGRADED, exit code 3, on a host whose canary had just passed.

`currentInstrument()` is now the one place that says what the daemon would run
today, and doctor defaults to it. If the daemon ever stops guaranteeing a
listener, that is the line which has to change with it.

## Two tests that could not see their own stub

Both found by running the stub loop rather than by reading the tests.

The first wrote its fixture record with `currentInstrument()` and compared it
against doctor's default — which is `currentInstrument()`. Stubbing that function
moved both sides together and the assertion stayed green. It writes
`instrumentHash({ hasNet: true })` explicitly now: the value production
persists, so a default that drifts from it is visible.

The second is the `--all` fix. The fake `run` returned the whole list whether or
not `--all` was in the arguments, so removing the flag from the code changed
nothing the test could observe. The fake models git now — first url without the
flag, all of them with it — and the stub turns two assertions red.

Neither test was wrong about what it asserted. Both were unable to represent the
defect they were written for, which a green run does not distinguish from
covering it.
