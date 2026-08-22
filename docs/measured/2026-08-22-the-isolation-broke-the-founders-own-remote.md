# Measured: the worker isolation broke reeve's access to its own remote

Date: 2026-08-22, against `revnix/reeve` on this machine. git 2.50.1.

Every git command in `src/checkout.mjs` ran under the worker isolation: the
`NEUTRALISE` flags, plus `GIT_CONFIG_GLOBAL=/dev/null` and
`GIT_CONFIG_SYSTEM=/dev/null`. That isolation exists because a worker's checkout
holds pull-request content, so its configuration is hostile input.

Seven of those commands do not run in a worker's checkout. They run in the
FOUNDER's, and four of them talk to the remote: the fetch that opens a
preparation, the `ls-remote` that takes the lease, and both pushes.

## The measurement

```
$ git ls-remote origin refs/heads/main
aad542c683e2fd6a74fd9315e483f254784d292a	refs/heads/main

$ GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 \
  git --no-replace-objects -c core.fsmonitor= -c core.hooksPath=/dev/null \
      -c core.pager=cat -c core.editor=true -c sequence.editor=true \
      -c core.sshCommand= -c core.askPass= -c diff.external= \
      -c uploadpack.packObjectsHook= -c credential.helper= \
      -c protocol.ext.allow=never \
      ls-remote origin refs/heads/main
fatal: could not read Username for 'https://github.com': terminal prompts disabled
```

reeve's origin is `https://github.com/revnix/reeve.git`, and the credential for
it comes from the founder's **global** configuration:

```
$ git config --global --get-regexp '^credential\.'
credential.https://github.com.helper  !/opt/homebrew/bin/gh auth git-credential
```

`credential.helper=` in the flags and `GIT_CONFIG_GLOBAL=/dev/null` in the
environment each remove it on their own.

So every publication reeve would have attempted, on its own repository and on
`nextlyhq/nextly`, would have failed to authenticate. Without
`GIT_TERMINAL_PROMPT=0` it would have blocked on a prompt instead.

Codex raised this as a `url.<base>.insteadOf` rewrite breaking — SSH rewrites,
corporate proxies. That is the same hole from the other side, and it is the one
the regression test uses, because a credential cannot go in a fixture:

```
[url "/tmp/rw/origin.git"]
	insteadOf = reeve-fixture://origin
```

| reading | result |
|---|---|
| founder's config visible | `ls-remote` succeeds |
| `GIT_CONFIG_GLOBAL=/dev/null` | `fatal: remote helper 'reeve-fixture' aborted session` |

## Why it had never been noticed

reeve has never dispatched a worker, so `publishRunWork` has never run against a
real remote. Every test fixture uses a local path as its origin, which needs no
credential and no rewrite — the one shape of remote that cannot exhibit this.

`reeve doctor` runs no git at all, so it could not have caught it either. A
doctor probe that the founder-side git can actually reach origin is the missing
instrument, and is not in this change.

## The split

- What stops git RUNNING a program stays everywhere: `--no-replace-objects`,
  `core.fsmonitor`, `core.hooksPath`, the pagers and editors, `diff.external`,
  `uploadpack.packObjectsHook`.
- What decides how git REACHES A REMOTE is worker-only: `core.sshCommand`,
  `core.askPass`, `credential.helper`, `protocol.ext.allow`, and the two
  config-file variables.
- Founder-side calls also delete any inherited `GIT_CONFIG_GLOBAL` /
  `GIT_CONFIG_SYSTEM`, so a daemon launched with them already at /dev/null
  cannot reproduce this silently, and set `GIT_TERMINAL_PROMPT=0` so a missing
  credential fails rather than waits.

`git init -- <path>` keeps the worker isolation even though its working
directory is the founder's checkout: the repository it creates is the worker's,
and the founder's `init.templateDir` would otherwise install hooks into it.

None of the founder-side commands checks out a working tree, so no filter or
smudge driver from the founder's configuration can run on pull-request content
through them.
