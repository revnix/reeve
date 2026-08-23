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
