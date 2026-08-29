# When a fixture's two outcomes are identical, its pass is not evidence — 2026-08-29

## The shape

**A test asserted the right property over a fixture that could not be shown to
produce the condition, and the runner returned the same verdict either way.** So
the assertion was green whether or not the defect was ever exhibited, and nothing
observable separated the two runs.

This is the seventh instance in the stub-sweep lineage of a test passing for a
reason other than the one it named, and it was found INSIDE the test written to
close the sixth.

## The measurement

The fixture exists to prove that a line forged by interleaving cannot be
classified: stdout writes `FAIL  wrong assertion` unterminated, stderr writes
` the guard holds\n`, and the concatenation reads as one assertion naming the
expected text. Whether that concatenation ever reaches the parent depends on the
two stdout writes arriving as SEPARATE data events.

Measured on darwin 25.6, node v24.17.0, by running the same fixture with and
without the pauses between the writes:

| | data events | forged line reaches the parent | runner verdict | exit | both assertions |
|---|---|---|---|---|---|
| pauses present | 3 | yes | `WRONG_RED` | 1 | pass |
| pauses removed | 2 | **no** | `WRONG_RED` | 1 | **pass** |

Without the pauses the two stdout writes coalesce into one data event before
stderr's arrives. The condition never occurs, and the outcome is byte-identical to
the run where it does.

`spawnSync` cannot show this. It hands back the two streams already separated, so
a probe built on it reports "not forged" however the writes actually landed — the
merge has to be the runner's own: two async data handlers appending to one buffer
in arrival order.

## Why the sweep did not catch it

The sweep proves a test goes RED when the code breaks. It cannot prove the fixture
can produce the condition, because a fixture that never exhibits the defect still
goes red under a stub — for the wrong reason, reporting `CAUGHT` exactly as it
would if everything were sound.

This is the stated boundary of the instrument, and it is where the remaining
instances of the shape have landed: the assertion states the right property; the
tree it runs against cannot produce the condition. Six of the seven were the
FIXTURE, not the assertion.

## The fix

A control spawns the same fixture body through the runner's merge discipline and
fails loudly when the line is not forged. The body is written ONCE and shared, so
the control cannot drift from the fixture it attests to.

Its manifest entry stubs the FIXTURE rather than the runner — the only way to show
that the control can go red. It is the one entry in the manifest that does so, and
the reason is written beside it.

## The rule

**A control must be able to fail, and a fixture whose two outcomes are
indistinguishable is not a fixture.** When a test passes, the question is not
whether the assertion is correct — it usually is — but what would have to be true
for it to fail, and whether the fixture can make that happen.

The companion rule, paid for on the same pull request: when several causes share
one observable outcome, assert the CAUSE and not the outcome. Exit code 2 meant
both "refused for git metadata" and "refused because the tree was dirty", and only
a second assertion on the reason separated them.
