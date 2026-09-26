// A node:test reporter that prints this repository's own lines: `PASS  name` for
// a test that passed and `FAIL  name` for one whose assertion failed (#224).
//
// The stub sweep reads those lines, and nothing else, to tell a stub caught by
// the check it names from one caught by another, from one caught by none, and
// from a test that died. node:test's own reporters print neither word, so a file
// written with it read as reporting no assertion at all.
//
// - A test inside a describe block or another test is named with the path to it,
//   `group > test`, so the same name in two places reads as two tests.
// - A test with subtests reports only a failure of its own: its subtests'
//   failures are theirs, and a stub that breaks one must not read as caught by
//   the parent. A describe block, a skipped test and a todo test print nothing.
// - A test that throws anything but an assertion error died rather than failed,
//   as a script-style test that throws does. It prints `ERROR  name: message`,
//   which is no assertion line: the sweep then counts one assertion fewer than
//   its control run, and refuses to read the stub as caught. So does a test that
//   timed out or was cancelled.
//
// The path comes from the start events, which node:test sends in order while a
// file's tests run one after another, its default.
//
//   node --test-reporter=./scripts/test-reporter.mjs --test-reporter-destination=stdout test/x.test.mjs
const oneLine = (name) => String(name).replace(/\s+/g, " ").trim();

export default async function* reporter(source) {
  const path = [], hadSubtest = [];
  for await (const { type, data } of source) {
    const n = data?.nesting ?? 0;
    if (type === "test:start") {
      path.length = n; path[n] = oneLine(data.name); hadSubtest[n] = false;
      if (n > 0) hadSubtest[n - 1] = true;
      continue;
    }
    if (type !== "test:pass" && type !== "test:fail") continue;
    if (data.details?.type === "suite" || data.skip !== undefined || data.todo !== undefined) continue;
    const name = [...path.slice(0, n), oneLine(data.name)].join(" > ");
    const error = data.details?.error, cause = error?.cause;
    if (hadSubtest[n] && (type === "test:pass" || error?.failureType === "subtestsFailed")) continue;
    if (type === "test:pass") { yield `PASS  ${name}\n`; continue; }
    yield cause?.code === "ERR_ASSERTION" ? `FAIL  ${name}\n`
      : `ERROR  ${name}: ${String(cause?.message ?? error?.message ?? "no error given").split("\n")[0]}\n`;
  }
}
