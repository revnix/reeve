/**
 * Defects to reintroduce on purpose, and the assertion that must notice each one.
 *
 * A stub here is a claim: "if someone deletes this line, THIS assertion fails."
 * `node scripts/stub-sweep.mjs` checks every claim. A stub that leaves the suite
 * green means the assertion it names cannot fail for that reason — a test
 * reporting success regardless of the code.
 *
 * ADD ONE WHENEVER YOU ADD A GUARD. That is the whole point: writing the guard and
 * proving the guard is reached become one action instead of two, the second of
 * which is otherwise optional and gets skipped exactly when it matters.
 *
 * `expectRed` is text from the ASSERTION, not a file. A file-level expectation is
 * satisfied by any failure in that file, so a stub that breaks something adjacent
 * would read as success while the property it names stayed unmeasured.
 *
 * The seed set is the sweep that was run by hand over the dependency edge. Three
 * of those hand-run stubs came back green on first writing, and all three were
 * repaired by moving the assertion rather than by changing the code — which is the
 * evidence that this file should exist.
 */
// NOT HERE, deliberately: the byte budget on retained assertion lines.
//
// It prevents an out-of-memory, not a wrong reading. With the budget and without
// it the verdict is identical — the only difference is how much is held, and the
// failure it guards is the process dying, which a test would have to actually
// provoke to observe. A stub of it therefore comes back NOT_CAUGHT, correctly, and
// the honest response is to leave it unmanifested rather than to bend a test until
// it appears covered.
//
// The same reasoning applies to reaping a worker from a normally-exited test; see
// test/stubsweep.test.mjs, where the limit is written down instead of asserted.

export const STUBS = [
  {
    name: "lease-gate",
    why: "let a dependent effect be leased before the one it waits for has delivered",
    test: "test/outbox-dependency-edge.test.mjs",
    expectRed: "the child is NOT leased while its parent is inflight",
    edits: [{
      file: "src/db/ops.mjs",
      find: `                  AND (o.depends_on IS NULL
                       OR EXISTS (SELECT 1 FROM outbox p
                                  WHERE p.id = o.depends_on AND p.status='done'))
`,
      replace: "",
    }],
  },
  {
    name: "missing-value-throws",
    why: "substitute a missing value silently instead of refusing, so a body reading \"see #\" ships",
    test: "test/outbox-dependency-edge.test.mjs",
    expectRed: "and the error NAMES the path that was missing",
    edits: [{
      file: "src/outbox/depends.mjs",
      find: "    if (v === undefined || v === null) { missing.add(path); return whole; }",
      replace: '    if (v === undefined || v === null) { return ""; }',
    }],
  },
  {
    name: "scalar-guard",
    why: "let an object stringify to [object Object] and be delivered as a comment",
    test: "test/outbox-dependency-edge.test.mjs",
    expectRed: "an object is refused, not stringified",
    edits: [{
      file: "src/outbox/depends.mjs",
      find: '    if (typeof v === "object") { nonScalar.add(path); return whole; }\n',
      replace: "",
    }],
  },
  {
    name: "inert-gate",
    why: "resolve every row rather than only those with an edge, dead-lettering ordinary comments that quote the token syntax",
    test: "test/outbox-dependency-edge.test.mjs",
    expectRed: "and its literal token text reaches the handler untouched",
    edits: [{
      file: "src/outbox/drain.mjs",
      find: "        if (job.depends_on != null) {",
      replace: "        if (true) {",
    }],
  },
  {
    name: "attempt-refund",
    why: "charge a delivery attempt for a handler that was never invoked",
    test: "test/outbox-dependency-edge.test.mjs",
    expectRed: "and no delivery attempt is charged",
    edits: [{
      file: "src/outbox/drain.mjs",
      find: "                             retryable: false, unattempted: true, error: err.message });",
      replace: "                             retryable: false, error: err.message });",
    }],
  },
  {
    name: "index-before-column",
    why: "create an added column's index before the column exists, which throws at open() on every store holding history",
    test: "test/outbox-dependency-edge.test.mjs",
    expectRed: "opening a store whose outbox predates the column does not throw",
    edits: [{
      file: "src/db/ops.mjs",
      find: "  addMissingColumns(db);\n  // AFTER the columns, never before. See ADDED_INDEXES.\n  addMissingIndexes(db);",
      replace: "  addMissingIndexes(db);\n  addMissingColumns(db);",
    }],
  },
  {
    name: "supersede-dependents",
    why: "retire a parent without its dependents, so the foreign key throws and rolls back every reconciliation",
    test: "test/outbox-dependency-edge.test.mjs",
    expectRed: "and the dependent is retired with it",
    edits: [{
      file: "src/db/ops.mjs",
      find: "    deletable.push(...kin.reverse(), r);",
      replace: "    deletable.push(r);",
    }],
  },
  {
    name: "cascade-budget",
    why: "let the cascade run past the pass budget, delaying evaluation, heartbeats and alerts",
    test: "test/outbox-dependency-edge.test.mjs",
    expectRed: "a spent budget cascades nothing",
    edits: [{
      file: "src/db/ops.mjs",
      find: "    if (now() >= deadlineAt) break;",
      replace: "",
    }],
  },
  {
    name: "cascade-deadline-wiring",
    why: "stop the drainer handing its deadline down, so the bound is correct and nothing is plugged into it",
    test: "test/outbox-dependency-edge.test.mjs",
    expectRed: "the drainer's own deadline reaches the cascade",
    edits: [{
      file: "src/outbox/drain.mjs",
      find: "cascadeDeadLetter(db, { deadlineAt: passDeadlineAt, now })",
      replace: "cascadeDeadLetter(db)",
    }],
  },
  {
    name: "sweep-restores-on-signal",
    why: "stop the sweep restoring the tree when it is killed, leaving a deliberately broken file behind",
    test: "test/stubsweep.test.mjs",
    expectRed: "a sweep killed mid-stub restores the source before exiting",
    edits: [{
      file: "scripts/stub-sweep.mjs",
      find: `for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {`,
      replace: "for (const sig of []) {",
    }],
  },
  {
    name: "overlap-count",
    why: "skip overlapping occurrences, so a repeated anchor reads as unique and is applied to the first",
    test: "test/stubsweep.test.mjs",
    expectRed: "an anchor occurring at overlapping offsets is refused",
    edits: [{ file: "src/stubsweep.mjs", find: "    i = at + 1;", replace: "    i = at + needle.length;" }],
  },
  {
    name: "trailing-terminator",
    why: "count the empty segment after a trailing newline as another anchor line",
    test: "test/stubsweep.test.mjs",
    expectRed: "reports two lines, not three",
    edits: [{ file: "src/stubsweep.mjs",
              find: `  const anchorLines = find.replace(/\\n$/, "").split("\\n").length;`,
              replace: `  const anchorLines = find.split("\\n").length;` }],
  },
  {
    name: "move-hint-exact",
    why: "call a divergence INSIDE the first line a probable move, collapsing the two cases the hint separates",
    test: "test/stubsweep.test.mjs",
    expectRed: "is not called a move",
    edits: [{ file: "src/stubsweep.mjs",
              find: "  const shape = anchorLines > 2 && completeLinesMatched === 1",
              replace: "  const shape = anchorLines > 2 && completeLinesMatched <= 1" }],
  },
  {
    name: "timeout-is-not-red",
    why: "read a killed run as a failing assertion when its partial output happens to match",
    test: "test/stubsweep.test.mjs",
    expectRed: "is UNRUNNABLE even when the output matches",
    edits: [{ file: "src/stubsweep.mjs",
              find: `  if (stubExit === TIMED_OUT_EXIT)\n    return { verdict: UNRUNNABLE,\n             why: "the test was killed for exceeding its time limit, so the run never completed — " +\n                  "whatever it printed first is not a verdict" };\n`,
              replace: "" }],
  },
  {
    name: "assertion-delimiter",
    why: "treat any line starting with FAIL as an assertion, so a crash printing FAILURE: <text> reads as CAUGHT",
    test: "test/stubsweep.test.mjs",
    expectRed: "lines beginning with FAIL but lacking the two-space delimiter are not assertions",
    edits: [{ file: "src/stubsweep.mjs",
              find: "const ASSERTION = /^(PASS|FAIL) {2}(.+)$/;",
              replace: "const ASSERTION = /^(PASS|FAIL)\\s*(.*)$/;" }],
  },
  {
    name: "expectred-type",
    why: "accept a truthy non-string expectRed, so `[]` coerces to \"\" and matches every failing assertion",
    test: "test/stubsweep.test.mjs",
    expectRed: "expectRed as an array is refused",
    edits: [{ file: "src/stubsweep.mjs",
              find: `    if (typeof e.expectRed !== "string" || !e.expectRed.trim())`,
              replace: "    if (!e.expectRed)" }],
  },
  {
    name: "path-containment",
    why: "let a manifest edit resolve outside the repository, where the cleanliness guard cannot see it",
    test: "test/stubsweep.test.mjs",
    expectRed: "resolving outside the repository is refused outright",
    edits: [{ file: "scripts/stub-sweep.mjs",
              find: "for (const e of manifest)\n  for (const ed of e.edits) {\n    const real = contained(ed.file);",
              replace: "for (const e of [])\n  for (const ed of e.edits) {\n    const real = contained(ed.file);" }],
  },
  {
    name: "side-effect-check",
    why: "stop rechecking the tree, so a stubbed test's litter passes unnoticed and later entries run against it",
    test: "test/stubsweep.test.mjs",
    expectRed: "a stub whose test litters the repository does not pass the sweep",
    // Reports a CLEAN reading in the shape the code now expects, rather than a
    // bare string. A stub whose replacement no longer type-checks against the
    // surrounding code breaks a different assertion and reads as WRONG_RED — which
    // is the sweep telling you the manifest has rotted, not that the guard failed.
    edits: [{ file: "scripts/stub-sweep.mjs",
              find: "  const after = treeState();",
              replace: "  const after = { tracked: \"\", ignored: beforeStub.ignored };" }],
  },
  {
    name: "keep-verdict-lines",
    why: "discard assertion lines with the output tail, so a noisy failure reads as CRASHED",
    test: "test/stubsweep.test.mjs",
    expectRed: "a named assertion still counts when the failure buries it",
    edits: [{ file: "scripts/stub-sweep.mjs",
              find: '              output: kept.length ? `${kept.join("\\n")}\\n${body}` : body });',
              replace: "              output: body });" }],
  },
  {
    // BOTH defences at once, and deliberately so.
    //
    // The process group and the descendant sweep are redundant BY DESIGN: either
    // alone kills a helper the test spawned. Removing one therefore changes
    // nothing observable, and an entry stubbing only `detached` came back
    // NOT_CAUGHT — correctly, because the property still held.
    //
    // The honest stub for a redundant pair is a compound one. Removing both must
    // break it, or neither is load-bearing and the entry proves nothing about
    // either.
    name: "process-tree-kill",
    why: "remove BOTH the process group and the descendant sweep, so a helper the test spawned outlives it and acts on a restored tree",
    test: "test/stubsweep.test.mjs",
    expectRed: "the helper the STUBBED test spawned was killed with it",
    edits: [
      { file: "scripts/stub-sweep.mjs",
        find: "  const child = spawn(process.execPath, [join(ROOT, file)], { cwd: ROOT, detached: true });",
        replace: "  const child = spawn(process.execPath, [join(ROOT, file)], { cwd: ROOT });" },
      { file: "scripts/stub-sweep.mjs",
        find: "  for (const pid of stragglers) {\n    try { process.kill(pid, \"SIGKILL\"); } catch { /* already gone, or not ours */ }\n  }",
        replace: "" },
    ],
  },
  {
    name: "manifest-url-safe",
    why: "import the manifest by raw path, which breaks on a win32 drive letter and on any path holding a URL fragment character",
    test: "test/stubsweep.test.mjs",
    expectRed: "still loads and runs",
    edits: [{ file: "scripts/stub-sweep.mjs",
              find: "(await import(pathToFileURL(manifestPath).href))",
              replace: "(await import(manifestPath))" }],
  },
  {
    name: "git-dir-excluded",
    why: "allow an edit inside .git, where a failed restore is invisible to the cleanliness guard",
    test: "test/stubsweep.test.mjs",
    expectRed: "inside the git directory is refused outright",
    // BOTH halves. The resolved directory and the literal `.git` pointer are
    // redundant for an ordinary repository — either alone refuses `.git/config` —
    // so removing one changes nothing observable and the entry reads NOT_CAUGHT
    // correctly. The honest stub removes the whole condition.
    edits: [{ file: "scripts/stub-sweep.mjs",
              find: "    if (real === GIT_DIR || real.startsWith(GIT_DIR + sep) ||\n        real === GIT_POINTER || real.startsWith(GIT_POINTER + sep))",
              replace: "    if (false)" }],
  },
  {
    name: "ignored-artifacts",
    why: "compare only tracked files, so an ignored cache the control run creates is invisible",
    test: "test/stubsweep.test.mjs",
    expectRed: "an ignored artifact left by the control run voids the reading",
    edits: [{ file: "scripts/stub-sweep.mjs",
              find: "  if (beforeStub === null || beforeStub.tracked !== \"\" || beforeStub.ignored !== atEntry.ignored) {",
              replace: "  if (beforeStub === null || beforeStub.tracked !== \"\") {" }],
  },
  {
    name: "real-git-dir",
    why: "assume `<root>/.git` is the metadata directory, which is only a pointer file in a worktree or separate-git-dir repository",
    test: "test/stubsweep.test.mjs",
    expectRed: "an edit inside a SEPARATE git directory is refused",
    edits: [{ file: "scripts/stub-sweep.mjs",
              find: '  GIT_DIR = realpathSync(\n    execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: ROOT, encoding: "utf8" }).trim());',
              replace: '  GIT_DIR = join(REAL_ROOT, ".git");' }],
  },
  {
    name: "inert-raw-body",
    why: "classify the raw interleaved capture, where a line neither stream emitted can name the expected assertion",
    test: "test/stubsweep.test.mjs",
    expectRed: "an assertion forged by interleaving does not pass the sweep",
    edits: [{ file: "scripts/stub-sweep.mjs",
              find: '    const raw = (dropped ? `[${dropped} earlier byte(s) dropped]\\n${out}` : out)\n      .split("\\n").map(l => `  ${l}`).join("\\n");\n    const body = raw;',
              replace: '    const body = dropped ? `[${dropped} earlier byte(s) dropped]\\n${out}` : out;' }],
  },
  {
    name: "ignored-fingerprint",
    why: "compare ignored artifacts by PATH only, so a control run overwriting one in place is invisible",
    test: "test/stubsweep.test.mjs",
    expectRed: "an ignored artifact the control OVERWROTE voids the reading",
    edits: [{ file: "scripts/stub-sweep.mjs",
              find: '  return h.digest("hex").slice(0, 16);',
              replace: '  return "same";' }],
  },
  {
    name: "named-line-reserved",
    why: "let unrelated failures fill the retention budget so the named assertion is crowded out and the entry reads WRONG_RED",
    test: "test/stubsweep.test.mjs",
    expectRed: "the named assertion is counted even when 21,000 other failures fill the budget",
    edits: [{ file: "scripts/stub-sweep.mjs",
              find: "    if (isNamed) observed.namedFailSeen = true;",
              replace: "    if (false) observed.namedFailSeen = true;" }],
  },
  {
    // The only entry here that stubs a FIXTURE rather than the runner, and it is
    // the entry this whole sweep exists for. MEASURED: with the pauses removed the
    // two stdout writes coalesce into one data event, the forged line never reaches
    // the parent, and the runner returns the SAME WRONG_RED and the SAME exit 1 it
    // returns when the forging does happen. Both of the forged-line assertions
    // therefore stay green over a tree that cannot exhibit the defect. Only the
    // control separates them, so the control has to be shown to fail.
    name: "forging-control",
    why: "remove the pauses, so the fixture stops forging the line and its assertions pass for a second reason",
    test: "test/stubsweep.test.mjs",
    expectRed: "control: the fixture really does forge a line neither stream emitted",
    edits: [{ file: "test/stubsweep.test.mjs",
              find: "    `  const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);\\n` +",
              replace: "    `  const pause = () => {};\\n` +" }],
  },
  {
    // BOTH halves, because they are one mechanism: asking git for `-z` and reading
    // NUL-separated fields. Reverting only the flag leaves the parser splitting a
    // newline-delimited blob on NUL and reading one enormous field, which fails for
    // a reason that has nothing to do with quoting.
    name: "porcelain-z",
    why: "read the human-readable porcelain form, where a path holding a space is C-QUOTED and the quoted string is not the path",
    test: "test/stubsweep.test.mjs",
    expectRed: "an ignored artifact with a QUOTED name still voids the reading",
    edits: [{ file: "scripts/stub-sweep.mjs",
              find: '["status", "--porcelain", "-z", "--ignored"]',
              replace: '["status", "--porcelain", "--ignored"]' },
            { file: "scripts/stub-sweep.mjs",
              find: 'const fields = String(raw).split("\\0");',
              replace: 'const fields = String(raw).split("\\n");' }],
  },
  {
    name: "symlink-by-target-text",
    why: "stop hashing an ignored symlink's target text, so every symlink fingerprints as one constant and retargeting it is invisible",
    test: "test/stubsweep.test.mjs",
    expectRed: "an ignored symlink RETARGETED by the control run voids the reading",
    edits: [{ file: "scripts/stub-sweep.mjs",
              find: "  if (st.isSymbolicLink()) {",
              replace: "  if (false) {" }],
  },
  {
    name: "verdict-from-observed",
    why: "derive the verdict by re-reading the retained buffer, so what a run REPORTED and what SURVIVED retention become the same question",
    test: "test/stubsweep.test.mjs",
    expectRed: "a stubbed run reporting only PASSes is WRONG_RED rather than CRASHED",
    edits: [{ file: "src/stubsweep.mjs",
              find: "  const anyAssertion = observed ? observed.anyAssertionSeen : reportedAnyAssertion(stubOutput);",
              replace: "  const anyAssertion = reportedAnyAssertion(stubOutput);" }],
  },
  {
    // COMPOUND, and it has to be. Two independent defences stop a PASS from
    // crowding out the named FAIL: ingestion keys the reservation on FAIL, and the
    // verdict does not read the retention buffer at all. Removing either alone
    // changes nothing observable, and the entry would read NOT_CAUGHT correctly.
    name: "pass-cannot-spend-the-reservation",
    why: "let a PASS naming the expected text spend the reserved slot, AND let the verdict be read back out of the buffer that then evicts the real failure",
    test: "test/stubsweep.test.mjs",
    expectRed: "a PASS naming the expected text does not crowd out the named FAIL",
    edits: [{ file: "scripts/stub-sweep.mjs",
              find: '    if (m[1] !== "FAIL") return;',
              replace: '    if (m[1] !== "FAIL") { if (expectRed && m[2].trim().includes(expectRed)) namedKept = true; return; }' },
            { file: "src/stubsweep.mjs",
              find: "  const failures = observed ? observed.failures : failedAssertions(stubOutput);",
              replace: "  const failures = failedAssertions(stubOutput);" },
            { file: "src/stubsweep.mjs",
              find: "  const namedFailed = observed\n    ? observed.namedFailSeen\n    : failures.some(f => f.includes(expectRed));",
              replace: "  const namedFailed = failures.some(f => f.includes(expectRed));" }],
  },
  {
    // COMPOUND for the same reason: the tails going through the one ingestion site,
    // and the verdict not being read back out of the buffer, are both sufficient.
    name: "tails-go-through-ingest",
    why: "give the close-time tails their own copy of the rules again — the budget without the named reservation — AND read the verdict back out of the buffer",
    test: "test/stubsweep.test.mjs",
    expectRed: "an unterminated named FAIL after the budget fills is still counted",
    edits: [{ file: "scripts/stub-sweep.mjs",
              find: "    for (const tail of [partial.out, partial.err]) if (tail) ingest(tail);",
              replace: "    for (const tail of [partial.out, partial.err]) {\n" +
                       "      const m = tail && ASSERTION_LINE.exec(tail);\n" +
                       "      if (m && m[1] === \"FAIL\" && kept.length < MAX_ASSERTION_LINES && keptBytes < MAX_ASSERTION_BYTES) {\n" +
                       "        kept.push(tail); keptBytes += tail.length;\n" +
                       "      }\n" +
                       "    }" },
            { file: "src/stubsweep.mjs",
              find: "  const failures = observed ? observed.failures : failedAssertions(stubOutput);",
              replace: "  const failures = failedAssertions(stubOutput);" },
            { file: "src/stubsweep.mjs",
              find: "  const namedFailed = observed\n    ? observed.namedFailSeen\n    : failures.some(f => f.includes(expectRed));",
              replace: "  const namedFailed = failures.some(f => f.includes(expectRed));" }],
  },
];
