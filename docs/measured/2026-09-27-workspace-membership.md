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

## pnpm-workspace.yaml: a flow list with a comment line

| File | pnpm 10.28.1 | pnpm 12.5.1 |
|---|---|---|
| `packages: [` / `# Browser tests` / `  "e2e"` / `]` | e2e | e2e |
| the same with `"e2e"` unindented too | e2e | refused: "invalid indentation" |
| the same with the comment indented | e2e | e2e |

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
- A comment line inside a flow list is skipped, indented or not.
