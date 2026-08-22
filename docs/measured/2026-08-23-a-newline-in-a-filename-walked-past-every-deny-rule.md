# Measured: a newline in a filename walked past every deny rule

Date: 2026-08-23. Node 24.17.0, against reeve's own `reviewDiff`.

Codex raised a display problem on #10: a pathname carrying a newline or a
terminal control sequence reaches the operational log and the phone alert
verbatim, so a pull request can forge a log line. That is real and is fixed.

Writing its test found the larger half. The pathname never reached the log at
all, because **it was never refused**.

## The matcher

```js
const toRe = glob => new RegExp("^" + glob.split("**")
  .map(seg => seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
  .join(".*") + "$");
```

`**` compiles to `.*`. Without the `s` flag, `.` does not match a newline, and
`$` anchors at the end of input — so the pattern cannot span one. `*` compiles to
`[^/]*`, a negated class, which matches a newline fine. Only the `**` forms
leaked, and every deny rule reeve ships is a `**` form.

## What it let through

| files given to `reviewDiff` | `ok` |
|---|---|
| `secrets/x.txt`, `sensitivePaths: ["secrets/**"]` | false — refused |
| `secrets/x⏎FORGED CLEARED: nothing needs you` | **true — publishes** |
| `.github/workflows/ci⏎x.yml` (SELF_GOVERNING, no config needed) | **true — publishes** |

The second row is a secret published. The third is a worker editing the workflow
that grades its own work, with reeve's own gate reporting nothing wrong.

git records such a name without complaint, a clone materialises it, and reeve
reads pathnames verbatim now — so this is the shape that reaches the gate.

## Why it was invisible until this week

Until #10 the reader took git's DEFAULT output, which QUOTES any path holding a
newline: `"secrets/x\nFORGED…"`. The leading quote broke the glob too, so the
path was refused — by accident, and for no stated reason. Making the reading
faithful removed an escaping nobody had designed, and exposed a matcher that had
never been able to handle the character.

Both halves of that were holes. The quoted form failed the SENSITIVE match as
well, which is the other direction and is measured in
`2026-08-22-the-gate-read-the-wrong-paths.md` §2.

## The fix

The `s` flag. Nothing else in the generated pattern contains an unescaped `.`,
so it changes exactly the `**` behaviour.

It cuts both ways deliberately: the deny rules now match a newline path
(fail-closed), and a lane's TERRITORY now matches one too, so a legitimate
`src/a⏎b.ts` inside the territory is allowed rather than refused for a reason
nobody wrote down. Denies are evaluated before territory, so the ordering is
unchanged.

## What the test had to be told

The first version of the regression test asserted only that the path was
refused. It passed with the flag stubbed out — because the fixture's lane has a
territory, and a newline path fails the territory match too. A refusal was
happening; the wrong one.

The assertion now names the RULE: the self-governing path must be refused as
self-governing, the quarantined path as quarantined, and an in-territory path
must be allowed. All three go red with the flag removed.

## The display half, which is also fixed

`printable()` neutralises C0, DEL and C1 at the two places worker-supplied text
faces a human — `log()` and `buildAlert()` — rather than at each call site, so
the next thing that logs a worker-supplied string is covered too. The escaped
form is visible rather than deleted (`\n`, `\x1b`), and the end-to-end test
asserts that every line in the operational log still begins with reeve's own
timestamp.
