# Measured: `--setting-sources` under print mode (CLI 2.1.237)

Date: 2026-08-22. Host: macOS, CLI 2.1.237. Two one-turn calls, each with
`--safe-mode --strict-mcp-config --no-chrome --settings ./gen.json
--allowedTools 'Bash(echo:*)' --max-turns 3`, where `gen.json` allows
`Bash(echo:*)` and the checkout carries `.claude/settings.local.json` that
DENIES `Bash(echo:*)`.

| Call | `--setting-sources` | Outcome |
|---|---|---|
| A | `""` (empty) | accepted; `echo PROBE-A` ran; the generated settings applied; zero denials |
| B | `local` | the checkout's `settings.local.json` deny was loaded: `Bash` denied, the worker reported "permission was denied" |

Conclusions, now encoded in `workerArgs`:

- The empty value is valid and means "no ambient sources": only the explicit
  `--settings` file shapes the worker. It is the default.
- `local` is NOT "only the generated file": it loads the checkout's own
  `.claude/settings.local.json`, which a pull request can carry. A worker must
  never load it. (`project` and `user` load more still.)
