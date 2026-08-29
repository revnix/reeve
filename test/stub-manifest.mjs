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
              find: "for (const e of manifest)\n  for (const ed of e.edits)\n    if (!contained(ed.file))",
              replace: "for (const e of [])\n  for (const ed of e.edits)\n    if (!contained(ed.file))" }],
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
              find: '              output: dropped ? `${kept.join("\\n")}\\n${body}` : body });',
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
];
