# Measured: three ways a changed path never reached the gate

Date: 2026-08-22, against git 2.x on macOS 15.6 and reeve's own `reviewDiff`.

`reviewDiff` decides whether a worker's change may be published. It is given a
list of paths, and every rule it applies — quarantine, self-governing, sensitive,
territory — is a glob match against that list. So the gate is only as good as
the reading that produced the list, and `changedFiles` produced three lists that
were each missing something the push would still carry.

The first of these was Codex's; the other two were found while writing its test.

## 1. The endpoints of a range are not what the range contains

`git diff --name-only <since>..<ref>` names what the DIFF holds. A worker that
edits a path in one commit and restores it in a later one leaves the endpoints
identical, so the path is not named:

```
$ git diff --no-ext-diff --name-only $BASE..HEAD
app.js
```

with `.github/workflows/ci.yml` weakened in the second commit and restored in the
third. `.github/**` is SELF_GOVERNING — the worker is editing what grades it —
and the gate saw nothing. The push carries that commit and its objects either
way; only the reading was blind.

`git log --name-only --pretty=format: -m <since>..<ref>` names the paths of each
commit in the range. `-m` is needed for the merge case: without it a merge commit
contributes nothing at all.

| reading | paths named |
|---|---|
| `diff --name-only $BASE..HEAD` | `app.js` |
| `log --name-only -m $BASE..HEAD` | `app.js`, `.github/workflows/ci.yml` |

## 2. git QUOTES a path with a non-ASCII byte, and the quote breaks every glob

Default output, on a file called `secrets/kéy.txt`:

```
$ git status --porcelain
 M "secrets/k\303\251y.txt"
$ git log --name-only --pretty=format: -1
"secrets/k\303\251y.txt"
```

That string does not match `secrets/**`, because of the leading `"`. Fed to
reeve's own gate with `risk.sensitivePaths: ["secrets/**"]`:

| files given to `reviewDiff` | verdict |
|---|---|
| `"secrets/k\303\251y.txt"` (as git prints it) | **ok: true** |
| `secrets/kéy.txt` (raw) | refused — "sensitive path(s) changed and need a human" |

So a sensitive file published itself by being named in a language with accents.
A newline in a filename quotes the same way and evades identically; setting
`core.quotePath=false` fixes the accent case but *not* the newline one:

```
$ git -c core.quotePath=false status --porcelain
A  "secrets/we\nird.txt"
```

`-z` fixes both — it emits paths verbatim, NUL-terminated — which is why the
reading is NUL-separated rather than quote-configured.

`-z` changes the porcelain shape: a rename is `R  <new>\0<old>\0`, two records,
the second with no status columns. Both paths are kept. The `"old -> new"` parser
this replaces kept only the destination.

## 3. Rename detection is ON by default, and it hides the source

Moving `secrets/key.txt` to `public.txt` in one commit:

| reading | paths named |
|---|---|
| `log --name-only` (default) | `public.txt` |
| `diff --name-only $BASE..HEAD` | `public.txt` |
| `log --name-only --no-renames` | `public.txt`, `secrets/key.txt` |

The commit carries a secret out of the directory that protects it, and the gate
is shown a harmless name. `--no-renames` reports the pair as a delete and an add,
which is the fail-closed reading: more paths judged, never fewer.

## 4. And an UNREADABLE range was reported as an empty one

Added 2026-08-23, from Codex on #10.

The reader returns `null` when git could not be asked. The status read returns
that straight out, and `reviewDiff` has a distinct refusal for it — "could not
read what the worker changed". The commit walk did not: `?? ""` turned an
unreadable range into an empty path list, and the refusal became "the worker
produced an empty diff — nothing was changed".

That reason is not true, and it points whoever reads it at the worker rather
than at the read.

It is reachable two ways. A revision the checkout does not hold:

```
$ git log --name-only 0000000000000000000000000000000000000001..HEAD
fatal: Invalid revision range 0000000000000000000000000000000000000001..HEAD
```

and output past `execFileSync`'s buffer, which defaults to 1 MiB and throws
`ENOBUFS` beyond it:

```
$ node -e '<execFileSync of 1.5 MB, default options>'
THREW code=ENOBUFS
```

A per-commit path walk reaches that sooner than it looks. One commit of 1,600
files under three 240-byte directory components produced **1,177,600 bytes** of
pathnames on its own, in 0.28s of fixture time.

So both halves: the walk reads under the same 64 MiB the secret scanner uses,
and a failed read is returned as `null` rather than as nothing-changed. Stubbing
each back out separately turns exactly one assertion red — the first gives the
"empty diff" reason on an unreadable range, the second refuses a wide change as
unreadable.

## What this does not establish

Nothing here was measured against a live worker; reeve has still never dispatched
one. These are measurements of the reading and of `reviewDiff` in isolation,
which is the layer the holes were in. Each is covered by a test in
`test/dispatch-e2e.test.mjs` that was confirmed to go red with the fix stubbed
back out, with a control beside it showing what the old reading returned.
