# Measured — merge authority (R-01), 2026-08-28

## Before

`revnix/reeve` itself: no rulesets (`[]`), no branch protection (HTTP 404
"Branch not protected"). Nothing to enforce and nothing to read.

`nextlyhq/nextly`, ruleset `protect-main` (id 16172495):

```
rules: deletion, non_fast_forward, pull_request
bypass: OrganizationAdmin mode=always
```

No `required_status_checks` rule at all, and the one account most likely to land
changes bypassing unconditionally. Branch protection separately reported
`enforce_admins: false`, `strict: false`, required context
`Decide what this commit can affect`.

## The constraint that decided which check to require

The substantive jobs are PATH-CONDITIONAL. Sampled across six open pull requests:

| pull request | checks reported |
|---|---|
| #1320, #1316, #1286 | 13-14 including Integration and gitleaks |
| #1291, #1011 | 22-25 including Scaffold and CLI guards |
| #925 | **5**, none of them Integration, gitleaks, or `Decide what this commit can affect` |

So requiring `Lint / Typecheck / Test / Build` or any `Integration (*)` would
block a pull request that legitimately never runs it. `Decide what this commit
can affect` was chosen because branch protection ALREADY required it, which makes
it proven workable rather than merely plausible.

## After

Applied 2026-08-28 with the founder's approval, and verified by READING THE
RULESET BACK rather than by trusting the write:

```
rules: deletion, non_fast_forward, pull_request, required_status_checks
bypass: OrganizationAdmin mode=pull_request
required: Decide what this commit can affect
```

The original ruleset JSON was captured first, so the change restores verbatim.

Both ruleset complaints disappeared from doctor's R-01. It still reports the gate
as decorative, and that is correct: `enforce_admins: false` lives in BRANCH
PROTECTION, which is a different mechanism from the ruleset. Two overlapping
systems govern this branch, and changing one says nothing about the other.

## Why the last switch was left alone

`nextlyhq/nextly` main is red: **10 of the last 10 completed ci.yml runs concluded
failure**, oldest sampled 00:51Z, newest 02:45Z.

Verified as a real failure rather than a base that never ran, which a conclusion
alone cannot distinguish:

```
run 33136871697: Lint / Typecheck / Test / Build failure steps=27
run 33136809907: Lint / Typecheck / Test / Build failure steps=27
```

27 steps executed is a positive signal that the job ran and failed. A runner that
never started reports failure with zero steps.

Turning on `enforce_admins` against that base would make the required check fail
for the founder too, with the bypass now narrowed — locking them out of the very
work that turns main green. Deferred deliberately, not forgotten.

## A detector note worth keeping

Ninety minutes earlier, R-04 reported `main: 0 of the last 0 ci.yml runs failed`
for the same repository. Nothing about nextly changed in between. The daemon's
checkout had been fast-forwarded, so the second reading came from the R-04 fix
that distinguishes a failing base from one that never ran. The old detector could
not see ten consecutive failures on the founder's main product repository.
