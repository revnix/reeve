# Measured: which folders each package manager takes as workspace members

Date: 2026-09-27. Host: WSL2 Ubuntu, Node 24.21.0.

Versions: npm 11.19.0 (@npmcli/map-workspaces 5.0.3), pnpm 12.5.1 and 10.28.1,
yarn 1.22.22, 2.4.3, 3.8.7 and 4.14.1 (through corepack), and bun 1.2.14 and
1.4.2 (through npx).

Each run was a fresh project with a folder per name below, each holding a
`package.json` of its own. The root declared the patterns in `workspaces`, or
in `pnpm-workspace.yaml` for pnpm. Each manager was asked for its members:

| Manager | How |
|---|---|
| npm | `npm pkg get name --workspaces --json` |
| pnpm | `pnpm ls -r --depth -1 --json` |
| yarn 1 | `yarn --silent workspaces info` |
| yarn 2 and later | `yarn workspaces list --json` |
| bun | `bun install --save-text-lockfile`, then the `workspaces` of `bun.lock` |

`npm query .workspace` lists nothing before an install, so it wasn't used.

## Folders foo and bar, and the patterns that exclude with `!`

| Patterns | npm | pnpm 10, 12 | yarn 1 | yarn 2, 3 | yarn 4 | bun 1.2.14 | bun 1.4.2 |
|---|---|---|---|---|---|---|---|
| `["*", "!bar", "bar"]` | bar | no bar | bar | bar | no bar | bar | |
| `["*", "!bar"]` | no bar | no bar | bar | no bar | no bar | bar | no bar |
| `["!bar", "*"]` | no bar | no bar | bar | bar | no bar | bar | |
| `["*", "!./bar"]` | no bar | | bar | | no bar | bar | bar |
| `["*", "!bar/**"]` | no bar | | bar | | no bar | bar | bar |
| `["*", "!**/bar"]` | no bar | | bar | | no bar | bar | no bar |

With baz as well:

| Patterns | npm | yarn 1 | yarn 2, 3 | yarn 4 | bun 1.2.14 | bun 1.4.2 |
|---|---|---|---|---|---|---|
| `["*", "!ba*"]` | foo | all three | | foo | all three | foo |
| `["*", "!bar", "!ba*", "bar"]` | foo | all three | | foo | all three | bar, foo |
| `["*", "!ba*", "bar"]` | all three | all three | bar, foo | foo | all three | bar, foo |
| `["bar", "!b*"]` | none: "No workspaces found" | bar | | none | bar, foo | bar, foo |

A blank cell wasn't run.

## Other patterns, npm 11.19.0

| Patterns | Members |
|---|---|
| `["e2e", "packages/[ab]"]` | e2e, packages/a, packages/b. pnpm, yarn 1 to 4 and bun 1.2.14 list the same. |
| `["e2e", "packages/[ab]", "!e2e"]` | packages/a, packages/b |
| `["packages/**", "!packages/*"]` | none, with packages/a/b the only package |
| `["packages/*/*", "!packages/a"]` | packages/a/b |
| `["bar/**"]` | bar, bar/x |
| `["**", "!bar"]` | bar/x, foo |
| `["bar/"]` | bar |

## A leading slash, an extglob and a backslash

Folders foo and bar. pnpm 10 is 10.28.1, pnpm 12 is 12.5.1, yarn 3 is 3.8.7, yarn 4 is 4.14.1, and bun 1.2 is 1.2.14.

| Patterns | npm | pnpm 10 | pnpm 12 | yarn 1 | yarn 3 | yarn 4 | bun 1.2 | bun 1.4.2 |
|---|---|---|---|---|---|---|---|---|
| `["*", "!/bar"]` | foo | bar, foo | bar, foo | bar, foo | bar, foo | bar, foo | bar, foo | bar, foo |
| `["/bar"]` | bar | none | none | none | none | none | refused | refused |
| `["b?(a)r"]` | bar | bar | refused: `ERR_PNPM_WORKSPACE_INVALID_GLOB` | bar | bar | bar | none | none |
| `["*", "!b?(a)r"]` | foo | foo | refused | bar, foo | foo | foo | bar, foo | bar, foo |
| `["*", "!b\\ar"]` | foo | foo | refused | bar, foo | foo | foo | bar, foo | foo |

| `["bar/**"]` | bar | bar | bar | bar | none | none | bar | bar |
| `["*", "!bar/**"]` | foo | foo | foo | bar, foo | foo | foo | bar, foo | bar, foo |
| `["*", "!!bar"]` | bar, foo | bar, foo | bar, foo | bar, foo | foo | none | bar, foo | bar, foo |

So:
- `bar/**` lists bar for npm, pnpm, yarn 1 and bun, and not for yarn 3 or 4.
  `!bar/**` excludes it for npm, pnpm and yarn 3 and 4, and not for bun.
- Repeated bangs are read differently by yarn 3 and by yarn 4.
- Only npm drops a leading slash. The others keep it, and it matches no folder.
- An extglob is read by npm, pnpm 10 and yarn, refused by pnpm 12, and matched by no bun.
- A backslash is an escape to npm, pnpm 10 and yarn 3 and 4, where Node's matcher (`path.matchesGlob`) reads it as a separator.

## A trailing globstar, a leading `!(`, and a negated class

Run later the same day (about 23:45 UTC), after #266's post-ready review, with
the same method and versions, and yarn 2.4.3 as well. Folders foo and bar:

| Patterns | npm | pnpm 10 | pnpm 12 | yarn 1 | yarn 2, 3 | yarn 4 | bun 1.2 | bun 1.4.2 |
|---|---|---|---|---|---|---|---|---|
| `["*/**"]` | bar, foo | bar, foo | bar, foo | bar, foo | none | bar, foo | bar, foo | bar, foo |
| `["b*/**"]` | bar | bar | bar | bar | none | bar | bar | bar |
| `["**"]` | bar, foo | bar, foo | bar, foo | bar, foo, and the root | bar, foo | bar, foo | bar, foo | bar, foo |
| `["!(foo)"]` | none | bar | refused | none | none | bar | bar, foo | bar, foo |
| `["*", "!(foo)"]` | bar, foo | bar, foo | refused | bar, foo | bar | bar, foo | bar, foo | bar, foo |
| `["b[!x]r"]` | bar | none | bar | bar | bar | bar | bar | bar |
| `["b[^x]r"]` | bar | bar | none | bar | bar | bar | bar | bar |
| `["b[ax]r"]` | bar | bar | bar | bar | bar | bar | bar | bar |
| `["*", "!b[!x]r"]` | foo | bar, foo | foo | bar, foo | foo | foo | bar, foo | foo |

Yarn alone, with packages at packages/a, packages/a/b and foo:

| Patterns | yarn 1 | yarn 2, 3 | yarn 4 |
|---|---|---|---|
| `["packages/*/**"]` | packages/a, packages/a/b | packages/a/b | packages/a, packages/a/b |
| `["packages/**"]` | packages/a, packages/a/b | packages/a, packages/a/b | packages/a, packages/a/b |
| `["p*/**"]` | packages/a, packages/a/b | packages/a, packages/a/b | packages/a, packages/a/b |
| `["packages/a/**"]` | packages/a, packages/a/b | packages/a/b | packages/a/b |
| `["*/a/**"]` | packages/a, packages/a/b | packages/a, packages/a/b | packages/a, packages/a/b |

So:
- For yarn 4, a trailing `/**` reaches the folder itself, as Node's matcher
  reads the folder's path with its slash, unless the folder is the pattern's
  literal base: the leading part with no glob in it, which the glob walks from
  and never lists. `bar/**` doesn't list bar, and `*/**` does.
- Yarn 2 and 3 read that form by some other rule: `*/**` lists no top-level
  folder, and `*/a/**` lists packages/a. Six runs don't settle it.
- A leading `!(` is a negated extglob to yarn 4 and pnpm 10, and pnpm 12
  refuses it. Yarn 2 and 3 read it as an exclusion of a group, `(foo)`, which
  Node's matcher reads as literal text. Yarn 1 reads no `!` pattern.
- pnpm 10 doesn't read `[!x]` as a negated class, and pnpm 12 doesn't read
  `[^x]` as one. Every other manager reads both as Node's matcher does.

## pnpm-workspace.yaml: a flow list with a comment line

| File | pnpm 10.28.1 | pnpm 12.5.1 |
|---|---|---|
| `packages: [` / `# Browser tests` / `  "e2e"` / `]` | e2e | e2e |
| the same with `"e2e"` unindented too | e2e | refused: "invalid indentation" |
| the same with the comment indented | e2e | e2e |

## bun's lockfile

With a workspace member to record, `bun install` wrote:

| bun | Lockfile |
|---|---|
| 1.1.45 | `bun.lockb` |
| 1.2.14 | `bun.lock` |
| 1.4.2 | `bun.lock` |

With no dependency and no member, none of them wrote a lockfile.

## What each manager does

- **npm 11.19.0** reads the patterns as `@npmcli/map-workspaces` does in its
  source:
  - An exclusion stands wherever it is, unless a later pattern's own text
    matches it, which lifts it. Of two exclusions in a row that one pattern
    lifts, it lifts only the first: its loop skips the exclusion that moves
    into the lifted one's place.
  - A pattern whose own text a standing exclusion matches is dropped.
  - A folder is listed when a pattern left matches it, as `<pattern>/`, and no
    exclusion does, as glob's `ignore` reads one. That takes the folder's path
    with its slash too, so `!bar/**` excludes bar.
- **pnpm 10 and 12, and yarn 4:** an exclusion wins, wherever it stands.
  Yarn 4 reads a leading `!(` as a pattern, not an exclusion.
- **yarn 2 and 3:** the last pattern that matches decides.
- **yarn 1** reads no exclusion: a `!` pattern lists nothing and excludes
  nothing.
- **bun** reads exclusions differently from one version to the next:
  - 1.2.14 excluded nothing in any run.
  - 1.4.2 excluded `!bar` and `!**/bar`, but not `!./bar` or `!bar/**`.
  - Both listed foo for `["bar", "!b*"]`, though no pattern includes it.

## What followed

- `listed` in `src/profile/shellscript.mjs` follows npm's rule above. It reads
  globs with Node's own matcher, the minimatch npm uses, so a character class
  is read rather than left unknown. It answers null only for a pattern that
  matcher can't read.
- Workspace detection in `src/profile/detect.mjs` reads each manager's rule:
  - For yarn, the version comes from `packageManager`, from `.yarnrc.yml`'s
    `yarnPath`, or from the lockfile's format. When nothing names the version,
    it answers only where the versions it could be agree.
  - For bun, it answers only where no exclusion could matter.
  - A folder it can't answer for takes no package manager, and a note says so.
- A comment line inside a flow list is skipped, indented or not. An item with
  no indent, which pnpm 10 reads and pnpm 12 refuses, leaves pnpm's answer
  unknown.
- A backslash leaves every manager's answer unknown. An extglob leaves pnpm's
  unknown, and a folder that only an extglob lists is unknown for bun. A
  leading slash stays literal except for npm, and bun refuses a list with one.
- A yarnPath and a packageManager that name different yarns leave both
  readings open. Only the `yarnPath:` setting counts, not a yarn file named
  in a comment, and a yarnPath whose version can't be read is some yarn from 2
  up.
- A pattern reaches a folder through its path with its slash too, where the
  manager's measured reading does: `bar/**` for pnpm, yarn 1 and bun, and
  `!bar/**` for pnpm and yarn 3 and 4. Repeated bangs leave yarn's answer
  unknown.
- `bun.lock` names bun, as `bun.lockb` does, and the two together are one
  package manager, not a question.
- From the later runs:
  - For yarn 4, a trailing `/**` reaches the folder unless it's the pattern's
    literal base, and a leading `!(` is a pattern. Where either could decide,
    yarn 2 and 3 leave the answer unknown.
  - A negated character class leaves pnpm's answer unknown, as does a leading
    `!(`, which is an extglob to pnpm.
  - A `.yarnrc.yml` says yarn 2 or later only by a setting, so one of only
    comments says nothing. One with a setting, beside yarn 1's lockfile,
    leaves yarn 1 to 4 open.
