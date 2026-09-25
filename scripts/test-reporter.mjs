// A node:test reporter that prints this repository's own lines: `PASS  name` for
// a test that passed and `FAIL  name` for one whose assertion failed (#224).
//
// The stub sweep reads those lines, and nothing else, to tell a stub caught by
// the check it names from one caught by another, from one caught by none, and
// from a test that died. node:test's own reporters print neither word, so a file
// written with it read as reporting no assertion at all.
//
// A test that throws anything but an assertion error died rather than failed,
// as a script-style test that throws does. It prints `ERROR  name`, which is no
// assertion line: the sweep then counts one assertion fewer than its control
// run, and refuses to read the stub as caught. So does a test that timed out or
// was cancelled. A describe block is a group, not an assertion, and a skipped or
// todo test ran nothing; neither prints.
//
//   node --test-reporter=./scripts/test-reporter.mjs --test-reporter-destination=stdout test/x.test.mjs
export default async function* reporter(source) {
  for await (const { type, data } of source) {
    if (type !== "test:pass" && type !== "test:fail") continue;
    if (data.details?.type === "suite" || data.skip !== undefined || data.todo !== undefined) continue;
    const name = String(data.name).replace(/\s+/g, " ").trim();
    if (type === "test:pass") { yield `PASS  ${name}\n`; continue; }
    const error = data.details?.error;
    const cause = error?.cause;
    const failed = error?.failureType === "subtestsFailed" || cause?.code === "ERR_ASSERTION";
    yield failed ? `FAIL  ${name}\n` : `ERROR  ${name}: ${String(cause?.message ?? error?.message ?? "no error given").split("\n")[0]}\n`;
  }
}
