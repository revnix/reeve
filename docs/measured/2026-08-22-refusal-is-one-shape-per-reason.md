# A reviewer's refusal is one shape per reason, not one per reviewer

**Measured 2026-08-22** against `nextlyhq/nextly` #1137 and the live profile
`~/.reeve/profiles/nextlyhq/nextly.json`, on `9bd0c61`.

## What was wrong

`src/review/derive.mjs` classifies an issue comment by testing the profile's
`refusal` regex first, then `clean`. Anything matching neither returns `null`,
which the function's own comment calls "a trigger command, a human comment,
chatter".

Each reviewer carried **one** `refusal` string. Each bot has **several**
refusals, one per reason, worded differently. So every refusal except the one
that happened to be on screen when the pattern was written fell through to
`null` — and a bot that crashed became indistinguishable from a bot that had
not spoken. Those want opposite responses: re-request one, keep waiting on the
other.

## The four bodies

Fetched verbatim from the issue-comments endpoint and committed under
`test/fixtures/reviewer-bodies-2026-08-22/`; see its `PROVENANCE.md`.

```
gh api repos/nextlyhq/nextly/issues/1137/comments --paginate \
  --jq '.[] | select(.user.login|test("codex|coderabbit")) | .body'
```

| at (UTC) | author | shape |
|---|---|---|
| 16:35:17 | `coderabbitai[bot]` | rate limit, worded **"Review limit reached"** |
| 16:48:48 | `chatgpt-codex-connector[bot]` | **"Something went wrong" / "Unknown error"** |
| 16:52:28 | `coderabbitai[bot]` | rate limit, worded **"Review rate limited"** |
| 16:54:43 | `chatgpt-codex-connector[bot]` | clean, naming `00f2867b31` |

Classified with the **live** patterns, the clean body serving as the control
that distinguishes one uncovered shape from a broken matcher:

```
codex   16:48:48  errored        refusal=False clean=False -> null   <-- CHATTER
codex   16:54:43  clean          refusal=False clean=True  -> clean       (control)
crab    16:35:17  limit reached  refusal=False clean=False -> null   <-- CHATTER
crab    16:52:28  rate limited   refusal=True  clean=False -> refusal     (control)
```

Two of four real bodies read as chatter. On the PR that produced them,
CodeRabbit never reviewed at any head and Codex crashed once before passing —
and reeve could not tell either from silence.

## A third defect, found by a control rather than looked for

The assertion "a real Codex clean pass is still clean" existed only to catch a
widened `refusal` swallowing a pass, since `refusal` is tested first. It failed
for an unrelated reason: `commitPattern` appears **zero** times in
`src/init.mjs`. The seed never sets one, so a freshly initialised profile gives
Codex no way to bind a clean pass to a revision, and every clean degrades to
`unbound_clean` — recorded, never coverage. The live nextly profile has the
pattern because it was added by hand; a new project would not get it.

That is the discriminator the design leans on hardest — a refusal never names a
reviewed commit — absent from the only place that ships it.

## The fix

Widened alternations in `KNOWN_REFUSALS`, plus the missing `commitPattern`.
`refusal` and `clean` are already compiled with `new RegExp(pattern, "i")`
(`src/review/derive.mjs:84-90`), so alternation needed no code change.

CodeRabbit's second alternative matches its **machine marker**
(`rate limited by coderabbit.ai`) rather than its visible wording, because the
two rate-limit bodies word themselves differently and only the marker is stable
across both.

## What is not fixed, and why not

`greptile-apps` in the live profile has **no `clean` pattern at all**, so a
greptile pass cannot classify as anything. It is not fixed here: greptile posts
nothing on #1135, #1136 or #1137, so **no real body exists to write a pattern
against**, and inventing a regex for a body nobody has seen is the mistake this
document is about. It needs one observed greptile pass first.

Likewise no real CodeRabbit *clean* or *findings* body exists to capture —
CodeRabbit was rate-limited across all three PRs — so those two test cases are
constructed and labelled `SYNTHETIC` in the test rather than presented as
measurements.

## Scope note

All three reviewers on nextly are `kind: advisory`, and both
`src/review/derive.mjs:308` and `src/verdict.mjs:81` filter on
`kind === "blocking"`. The blocking-reviewer roster is therefore **empty**, and
none of this gates a merge today. It changes what reeve *reports*, not what it
*decides* — but the builder design's clause B5 exists precisely because an
empty roster makes the review clause emit PASS on absence, so the reporting is
the part that has to be right before that clause matters.
