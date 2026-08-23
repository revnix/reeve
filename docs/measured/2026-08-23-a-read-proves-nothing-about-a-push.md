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

## Four more ways it asked the wrong question

From Codex on #14, all four reproduced before being taken.

**The fetch url is not the push url.** `git push origin` uses
`remote.origin.pushurl` when it is set, so https-fetch plus ssh-push — and the
reverse — are both ordinary:

```
$ git remote get-url origin        -> https://github.com/o/fetchside.git
$ git remote get-url --push origin -> https://github.com/o/PUSHSIDE.git
```

The check probed the fetch url, which is the wrong transport AND the wrong
credential. It now reads both, asks the credential about the push url, and gives
a separate push url its own `ls-remote` — `ls-remote origin` reads through the
fetch url and says nothing about the other one.

**`git remote get-url` EXPANDS `insteadOf`.** A rewrite pointing at a
credential-bearing URL hands the credential straight back:

```
$ cat ~/.gitconfig
[url "https://user:s3cr3t-token@example.com/"]
	insteadOf = short:
$ git remote get-url origin
https://user:s3cr3t-token@example.com/o/r.git
```

That string was being printed in the report and in `--json`. Userinfo is removed
before any url is reported, and the removal is visible (`[redacted]@host`) rather
than silent. An scp-style `git@host:path` has no authority and is untouched.

**`credential.useHttpPath` makes protocol-and-host the wrong question.** Measured
against a helper that records what git asked it:

| fill form | what git asked | result |
|---|---|---|
| `protocol=https, host=example.com` | protocol, host | a **host-wide** credential answers |
| `url=https://example.com/two.git` | protocol, host, **path=two.git** | nothing answers |

So the host-only form reports a credential is available while the real
path-qualified push has none. `url=` is what is asked now, and it carries the
port and any username as well.

**`http://` was grouped with ssh and local.** A public http repository answers an
anonymous read exactly as https does, so that branch reproduced the very false
green the https branch exists to prevent. Git's credential subsystem covers both
schemes; both take the credential path.

## Two more, from the second round

**A remote can have several push urls, and git pushes to all of them.**
`get-url --push` returns only the first:

```
$ git config --add remote.origin.pushurl https://github.com/o/one.git
$ git config --add remote.origin.pushurl https://github.com/o/two.git
$ git remote get-url --push origin        -> https://github.com/o/one.git
$ git remote get-url --push --all origin  -> https://github.com/o/one.git
                                             https://github.com/o/two.git
```

Every one is reached and credential-checked now. `--push --all` returns the
fetch url when no pushurl is set, so the ordinary single-remote case is
unchanged.

**A credential helper is not the only way http authenticates.**
`http.<url>.extraHeader` carrying an Authorization header, and
`http.<url>.cookieFile`, are used by `ls-remote` and by the real push while
`git credential fill` knows nothing about them — so a silent helper is not proof
that publication is broken. Resolved with git's own per-url matching:

```
$ git config --get-urlmatch http.extraHeader https://github.com/o/one.git
Authorization: Bearer [value hidden]        # exit 0
$ git config --get-urlmatch http.extraHeader https://elsewhere.example/x
                                            # exit 1
```

When one of those is configured the verdict is DEGRADED with the mechanism
named — not BROKEN, which would call a working checkout broken, and not OK,
which would claim a verification that did not happen. Only the KEY is reported;
the value is an Authorization header, and it gets the same treatment as the
credential.

## What this does not establish

That a push would SUCCEED. It establishes that the credential a push needs can be
obtained and the remote answers. Authorisation — whether that credential may
write to that repository — is not measured, and cannot be without pushing.

The regression test drives the check through injected seams rather than the
network, including the case a reachability-only check gets wrong. Stubbing the
credential half back out turns three assertions red, one of which is that the
credential was asked for at all.
