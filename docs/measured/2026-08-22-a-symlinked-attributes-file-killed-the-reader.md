# Measured: a symlinked `.gitattributes` killed the process that read it

Date: 2026-08-22. git 2.50.1 (Apple Git-155), node 24.17.0, macOS 15.6.

`prepareRunCheckout` reads every `.gitattributes` in the tree it just cloned, to
notice filter drivers reeve cannot supply. It read them with `readFileSync`, on
the strength of `git ls-files` having listed them.

That tree is pull-request content, and `.gitattributes` can be committed as a
symlink.

## The commit, and what a clone does with it

```
$ ln -s /dev/zero .gitattributes && git add -A && git commit -m base
$ git ls-files -s
120000 71ef849dd58cf734fe1b47e1a401909fe97f4f2f 0	.gitattributes
100644 587be6b4c3f93f93c489c0111bba5596147a26cb 0	app.js

$ git clone /tmp/gasrc /tmp/gadst && cd /tmp/gadst
$ git ls-files -z -- "*.gitattributes" .gitattributes
.gitattributes
$ ls -l .gitattributes
lrwxr-xr-x  1 mobeen  wheel  9 .gitattributes -> /dev/zero
```

Mode 120000 is recorded, the clone materialises the link, and `ls-files` lists
it — so the reader was handed it as an ordinary path to read.

## What reading it did

```
$ node --max-old-space-size=400 probe.mjs      # readFileSync(".gitattributes", "utf8")
NODE_EXIT=137
```

137 is SIGKILL. `/dev/zero` never reaches EOF, so the synchronous read grows its
buffer until the process is killed. In the daemon that is the guardian dying,
during checkout preparation, driven entirely by pull-request content, before any
worker is launched.

## git's own behaviour, which does not help reeve

git refuses to follow these itself:

```
warning: unable to access '.gitattributes': Too many levels of symbolic links
```

So a tree relying on a symlinked attributes file is not getting those attributes
from git either. The warning is git protecting git; reeve's reader was its own.

## The fix, and what the test proves

`lstat` before reading, refuse anything that is not a regular file, bound the
per-file size (1 MiB) and the total across all of them (4 MiB) — a tree can
commit any number, and the daemon reads them synchronously.

The automated fixture does not point at `/dev/zero`; a test that kills its own
runner is a poor regression test. It points at a file outside the checkout that
DECLARES A FILTER, which makes the refusal itself the evidence:

| reader | refusal |
|---|---|
| guarded | "this tree commits .gitattributes as a symbolic link rather than a file, which reeve will not read" |
| guards stubbed out | "this tree declares checkout filter(s) reeve cannot supply (**absolutely-not-supplied**)" |

The stubbed reader names a filter that exists only in a file outside the
checkout. That is the read through the link, observed.
