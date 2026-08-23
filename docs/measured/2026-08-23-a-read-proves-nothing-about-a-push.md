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

## Round three: the push-url reachability probe is removed

The probe was mine, not asked for. It generated a finding in each of the two
rounds after it, and the third settles it.

`ls-remote <the literal url>` drops every REMOTE-SCOPED setting. Measured
2026-08-23 against this repository with an unreachable `remote.origin.proxy`:

```
$ git -c remote.origin.proxy=http://127.0.0.1:1 ls-remote origin refs/heads/main
fatal: unable to access 'https://github.com/revnix/reeve.git/': Failed to connect to 127.0.0.1 port 1
$ git -c remote.origin.proxy=http://127.0.0.1:1 ls-remote https://github.com/revnix/reeve.git refs/heads/main
e41cd287e2e592faad884e7b2e236f19760d0a4e	refs/heads/main
```

So the literal probe answers a different question in both directions: it can
report reachable for a remote whose only route is a proxy it ignored, and it
would have reported BROKEN for a checkout that publishes.

Making it faithful means reproducing git's own remote resolution —
`remote.<name>.proxy`, `uploadpack`, `vcs`, and whatever the next version adds.
An attempt to sidestep that with `-c remote.origin.url=<pushUrl> ls-remote
origin` does not work either: measured, the override is ignored, because the key
is multi-valued and git takes the first.

The reading is removed rather than tuned, and what it reached for is stated as
not established. `ls-remote origin` still exercises origin's full configuration,
which is what reeve's own fetch uses, and the credential question needs no
network and no proxy so it is still asked per destination.

## An empty pushurl, where the two gits disagree

```
$ git config remote.origin.pushurl ""
$ git remote get-url --push --all origin
/tmp/r16d/A.git                       # git 2.50.1 DROPS the empty value
$ git push --dry-run origin HEAD:refs/heads/main
Everything up-to-date                 # and the push succeeds
```

A reviewer reports git 2.43 exiting 128 with `fatal: no path specified` instead.
That is not reproducible here, and 2.43 is what Ubuntu LTS ships — a platform
reeve has to run on — so it is taken rather than dismissed.

The resolved list is exactly where the two gits agree, so the check reads the raw
configuration: `git config -z --get-all remote.origin.pushurl`, with `-z` because
`--get-all` alone loses an empty value to the trim. Any empty value is BROKEN,
and the report names both gits so a reader is not misled about which behaviour
their own git has.

## The claim that outlived its probe

Round five, and the third stale claim this branch produced. The non-http branch
said the push transport's authentication had been exercised by the reach above.
That was true while the push destination still had a probe of its own; the round
that removed the probe left the sentence behind.

`ls-remote origin` uses the FETCH url. So an https fetch beside an ssh push url
means the ssh transport was never touched, and an anonymous public fetch plus an
ssh push with no usable key reported healthy.

The claim now depends on where the reach actually went: when the push url IS the
fetch url the reach went through it and the verdict stands; when it differs, the
destination is unverified and the check is DEGRADED with the reason naming which
transport was exercised.

All three of this branch's stale claims have the same shape — a sentence written
when the code did more than it does now. Two were found by a reviewer and one by
re-reading my own diff. What they have in common is that removing a reading is
not finished until every sentence that depended on it is re-read.

## netrc, which is not git configuration at all

Round six. `http.<url>.extraHeader` and `http.<url>.cookieFile` are git config
and resolve through `--get-urlmatch`. `~/.netrc` is neither: git hands libcurl
`CURL_NETRC_OPTIONAL` and curl reads the file itself, so `git credential fill`
never sees it.

Measured 2026-08-23 on git 2.50.1, against a local server issuing a 401 Basic
challenge (a bare repo served dumb-http, with the handler recording what
Authorization header arrived):

| HOME | `ls-remote` | Authorization sent |
|---|---|---|
| no netrc | exit 128 | no |
| a matching netrc | **exit 0** | **yes** |
| `credential fill`, same netrc | exit 128 | returned no password |

So a netrc-backed checkout publishes fine while R-16 called it BROKEN.

**It did NOT reproduce against GitHub over https.** There, git's own credential
lookup fails first and the request is never made, so netrc never gets its turn:

```
$ HOME=<scratch, with a matching netrc> git ls-remote origin refs/heads/main
fatal: could not read Username for 'https://github.com': terminal prompts disabled
```

The exposure is therefore real and narrower than the general claim: it needs a
server that answers with a challenge rather than one git pre-empts. Worth
recording, because the obvious reproduction attempt is the one that fails.

A netrc entry for the host — or a `default` entry, which matches any host — is
treated exactly like the other two: DEGRADED with the mechanism named, never
BROKEN. Only the FILE NAME is reported; the file is a list of passwords.

## A fixture that was green because of this machine

The netrc seam defaults to reading the founder's own `~/.netrc`. There is none
on this host, so every existing R-16 fixture passed without knowing the seam
existed — and would have behaved differently on a machine that has one. Every
fixture now injects its netrc explicitly, including the ones that want none.

That is the same shape as the dispatch fixtures that read the real
`~/.reeve/claude-token`: green here, red on a machine configured differently, for
a reason that is not the code.

## emptyAuth, and a boolean that is not a presence

Round seven, and the third round in a row that added an authentication mechanism
`git credential fill` cannot see. `http.<url>.emptyAuth` tells git to attempt
authentication without seeking a username or password — Kerberos and
GSS-Negotiate — so a push succeeds where the helper returns nothing.

The trap is that it is a BOOLEAN. Measured 2026-08-23:

```
http.emptyAuth  https://enterprise.example/o/r.git -> [true]  exit=0
http.emptyAuth  https://other.example/x.git        -> [false] exit=0
http.emptyAuth  https://nowhere.example/x.git      -> []      exit=1
```

Reading it the way the other keys are read — presence, exit 0 — would take
configuration that says the OPPOSITE as evidence for it, and suppress a refusal
that is real. Boolean keys are asked with `--type=bool` and only `true` counts.

`http.<url>.sslCert` was added at the same time, without a reviewer asking. A
client certificate is an authentication mechanism exactly as a header or a cookie
jar is, and this is the third round of one being found missing.

## The list is incomplete by nature, and that is a decision

git keeps adding ways to authenticate, so an enumeration of them will always be
one behind. What matters is which way its incompleteness errs:

| | consequence |
|---|---|
| a mechanism MISSING from the list | a working checkout is called BROKEN — loud, and a human can dismiss it |
| a mechanism WRONGLY in the list | a broken checkout is called DEGRADED — quiet, and nobody looks |

The first is recoverable and the second is the failure R-16 exists to prevent.
So the list stays explicit rather than widening to "any `http.*` key at all":
`http.postBuffer` says nothing about authentication, and treating it as
authentication would suppress a real refusal — trading the loud error for the
quiet one.

## A mirror remote refuses every push reeve makes

Round eight, and the one finding in this stretch that is not about an
authentication mechanism. `publishRunWork` always names an explicit refspec, and
`remote.<name>.mirror` makes a push behave as `--mirror`, which git will not
combine with one:

```
$ git config remote.origin.mirror true
$ git push origin HEAD:refs/heads/main
fatal: --mirror can't be combined with refspecs
$ git config --unset remote.origin.mirror
$ git push origin HEAD:refs/heads/main      # succeeds
```

Every publication fails, and no credential or reachability probe can see it —
the remote is perfectly reachable and the credential is perfectly obtainable.
BROKEN, with git's own message quoted so the reader is not left to guess.

Read with `--type=bool`, for the reason `emptyAuth` taught: `mirror = false` is
configuration saying the opposite, and presence is not the question.

## Two more shapes the credential question can take

**A helper that answers with a credential rather than a password.** With the
`authtype` capability negotiated, a helper returns `authtype=Bearer` and
`credential=...` and git forms the Authorization header from those — no
`password=` line anywhere. Measured 2026-08-23: git 2.50.1 (Apple Git-155) does
NOT support the capability, so this is forward insurance rather than a
reproduced defect. Unknown input keys are tolerated silently on that build, but
2.43 cannot be tested from here, so a call that FAILS is retried without the
capability line. A git that rejects the key gets the plain question rather than a
wrong BROKEN.

**A quoted netrc machine name.** curl permits a double-quoted field, and
measured against the same 401 Basic server, `machine "127.0.0.1"` authenticates
exactly as the unquoted form does. Comparing raw whitespace tokens missed it.

## And the instrument reaches outside the file that defines it

`measuredContainment` assembles the probe's environment from workerenv.mjs:
`workerEnv`, `writeGitConfig` and `workerHomeFor` choose the HOME, the PATH
shims and the git configuration the canary runs under — which are the very
mechanisms whose isolation it measures. Changing them changes what a pass means,
from outside canary.mjs.

The rot guard reads canary.mjs's imports, so it cannot see a caller's assembly.
**That blind spot is real and is not closed.** Hashing daemon.mjs would
re-measure on every unrelated edit to the daemon; parsing one function's body for
imports is a guard that breaks quietly. The entry is declared by hand, asserted
by name, and the comment says why a reader should check it when
`measuredContainment` grows a dependency.

## A read-only key answers the read and refuses the write

Round nine, and it is the ssh half of a limit already conceded for https.

`ls-remote` speaks to **git-upload-pack**; a push speaks to **git-receive-pack**.
A read-only deploy key answers the first and refuses the second. The ssh branch
said the reach had exercised the push transport's authentication — true of the
transport, false of the authorisation, and the sentence claimed the second.

It now says the reach exercised it **for reading**, and every destination —
https or ssh — carries the same closing statement:

```
-> not established: whether a PUSH to <url> would be accepted — `ls-remote` speaks to
   git-upload-pack and a push to git-receive-pack, so a read-only key or token answers
   the read and refuses the write, and nothing here can tell them apart without pushing
```

The verdict stays OK, for the reason given when the same remedy was proposed for
https credentials: there is no path from these observations to a proven write
that does not push, so DEGRADED would be the permanent state of every remote and
a permanently degraded check is one its reader skips.

## What this does not establish, said in the report rather than only here

That a push would SUCCEED. `git credential fill` obtains the fields from the
helpers; it does not present them to the server, so an expired, revoked,
wrong-account or read-only token answers exactly as a working one does. Neither
acceptance nor authorisation is measured, and neither can be without pushing.

That belongs beside the verdict, not only in a document nobody reads at 3am, so
R-16's own lines say it:

```
  R-16  publication reach
        origin https://github.com/nextlyhq/nextly.git
        reachable: main is at b5c9199141
        a credential is obtained for https://github.com/nextlyhq/nextly.git, though not validated against the server (its value is never read into reeve)
        -> not established: whether that credential is accepted, or authorised to write here — neither can be known without pushing
```

The verdict stays OK rather than becoming DEGRADED, which a reviewer suggested.
DEGRADED would be permanent for every https remote — there is no path from
"obtained" to "validated" that does not push — and a check that is always
degraded is one its reader learns to skip. What it can say precisely is: the
credential path resolves, and here is exactly what that does not prove.

The regression test drives the check through injected seams rather than the
network, including the case a reachability-only check gets wrong. Stubbing the
credential half back out turns three assertions red, one of which is that the
credential was asked for at all.
