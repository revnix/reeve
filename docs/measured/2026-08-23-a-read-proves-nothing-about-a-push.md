# Measured: on a public repository, a read proves nothing about a push

Date: 2026-08-23, against the two repositories reeve is configured for.

#10 fixed reeve's founder-side git so it can reach its own remote again. This is
about the instrument that should have caught the break in the first place, and
about why the obvious instrument would not have.

## The obvious instrument, and where it fails

`ls-remote origin`, run through the real code path:

| repo | visibility | founder-side (after #10) | worker isolation (before #10) |
|---|---|---|---|
| revnix/reeve | private | reached `e41cd287e2` | **refused** — could not read Username |
| nextlyhq/nextly | **public** | reached `f4e27fefe8` | **reached** `f4e27fefe8` |

Row 1 is the break, visible. Row 2 is the same broken configuration reporting
healthy — because a public repository answers `ls-remote` anonymously. And row 2
is the repository reeve actually watches.

So a reachability check would have shown green on nextly for the whole period
during which no publication could have succeeded.

## The instrument that does work

`git credential fill` is what a push does to obtain its credential. It performs
no network write. Asked for `protocol=https, host=github.com` through both
environments:

| checkout | founder-side (after #10) | worker isolation (before #10) |
|---|---|---|
| revnix/reeve | credential supplied | **refused** |
| nextlyhq/nextly | credential supplied | **refused** |

Both rows refuse under the old configuration, public repository included. That is
the half `ls-remote` cannot see.

Nothing reads the credential itself. The check looks for a `password=` line and
returns a boolean; the value is not logged, recorded, or put in any evidence
file. The probe that produced the table above printed only its length.

## What R-16 does

- no checkout in the profile → UNKNOWN, because there is nothing to publish from
- no origin → BROKEN
- origin unreachable → BROKEN, in git's own words, and it says that the reads
  reeve makes through `gh` are unaffected so nothing else reports this
- https, reachable, no credential → BROKEN, and on a repository whose profile
  says `visibility: public` it says the read succeeded anonymously and proves
  nothing about a push
- ssh or a local path → the transport authenticates itself, so the reach above
  already exercised it and no https credential is asked for

Live on 2026-08-23:

```
  R-16  publication reach
        origin https://github.com/nextlyhq/nextly.git
        reachable: main is at 22b39d09d2
        a credential is available for github.com (its value is never read into reeve)
```

## What this does not establish

That a push would SUCCEED. It establishes that the credential a push needs can be
obtained and the remote answers. Authorisation — whether that credential may
write to that repository — is not measured, and cannot be without pushing.

The regression test drives the check through injected seams rather than the
network, including the case a reachability-only check gets wrong. Stubbing the
credential half back out turns three assertions red, one of which is that the
credential was asked for at all.
