# Reviewer comment bodies, captured verbatim

All four fetched 2026-08-22 from `nextlyhq/nextly` **#1137**, issue-comments
endpoint, and written to disk unmodified — not retyped, not summarised.

| file | author | created_at | chars (API `length`) |
|---|---|---|---|
| `codex-errored.txt` | `chatgpt-codex-connector[bot]` | 2026-08-22T16:48:48Z | 600 |
| `codex-clean.txt` | `chatgpt-codex-connector[bot]` | 2026-08-22T16:54:43Z | 581 |
| `coderabbit-limit-reached.txt` | `coderabbitai[bot]` | 2026-08-22T16:35:17Z | 4151 |
| `coderabbit-rate-limited.txt` | `coderabbitai[bot]` | 2026-08-22T16:52:28Z | 393 |

Reproduce:

```
gh api repos/nextlyhq/nextly/issues/1137/comments --paginate \
  --jq '.[] | select(.user.login|test("codex|coderabbit")) | .body'
```

Verbatim matters here more than usual. A retyped version of `codex-errored.txt`
loses that its quotes are **curly** (`“@codex review”`, U+201C/U+201D), and a
summarised `coderabbit-limit-reached.txt` loses its machine markers
(`<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->`),
which is the most stable discriminator either body carries. A fixture that
cannot exhibit the defect proves nothing, and both of those details were lost
in a hand-relayed copy of these same bodies before they were fetched.

**No clean CodeRabbit body is captured here**: CodeRabbit was rate-limited
across #1135, #1136 and #1137, so none exists to capture. The test constructs
those two cases and labels them SYNTHETIC.
