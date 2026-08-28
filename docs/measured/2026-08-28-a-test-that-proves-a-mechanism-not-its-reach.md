# A shape, measured three times in one pull request — 2026-08-28

## The shape

**A test proves a mechanism exists without proving it is reached.** The assertion
is green, plausible, and worthless.

Three instances in reeve #61, all found by stubbing the fix back out and reading
the EXIT CODE, none found by writing the test or by reading it back.

| # | the assertion | why it could not fail |
|---|---|---|
| 1 | the retirement count is 0 | asserted in a case where both the right and the wrong reading are 0, so nothing distinguished them |
| 2 | the cascade stops at the pass deadline | correct inside the cascade, while the drainer called it WITHOUT passing a deadline; every test of the mechanism passed with the wiring gone |
| 3 | one status transition emits one event | the fixture marked the row terminal, so the selection filtered it out and the guarded line never executed |

Each was fixed by moving the assertion, not by changing the code. In two of the
three the code was already right.

## Why it is one shape and not three accidents

The instrument that caught all three is a stub sweep, and the sweep exists only as
a habit. Nothing in the repository requires it, the stubs are written ad hoc in a
scratch directory, and its own preconditions are unguarded: on one run
`git checkout -- src/` restored to the last COMMIT and silently destroyed the
uncommitted fixes it was about to measure, so the next reading measured the
absence of the fix rather than the fix.

A verification step that depends on remembering is the fallible read. This
repository's own rule is that the third instance of a shape is evidence about the
DESIGN rather than about the instance.

## The decision

Founder, 2026-08-28: finish the pull request on the current discipline, then land
a separate change that makes the sweep a repository artefact rather than a habit —
a manifest of `(file, anchor, replacement, the test that must go red)` beside the
tests, and a runner that FAILS when a stub leaves the suite green.

The point is not automation for its own sake. It is that "I added a guard" and "I
proved the guard is reached" become one action instead of two, the second of which
is currently optional.

## A note on redundant defences

Not every guard can be reached by a test, and pretending otherwise is how instance
3 happened. Where two defences are redundant BY DESIGN, removing either alone
correctly changes nothing — so the honest demonstration is a COMPOUND stub that
removes both and shows the property break. That was done here, and the block says
in as many words which property it asserts and which it does not.
