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

/**
 * FROZEN DEBT: test files that predate the rule that every test file carries a stub.
 *
 * NOT AN EXEMPTION LIST, and the difference is enforced. A file here loses its place
 * the moment anyone MODIFIES it: the gate intersects a change with this list and
 * refuses, so the demand to prove a test can fail arrives in front of the person who
 * already has the file open and knows which assertion is load-bearing.
 *
 * That shape was chosen over a deadline and over a plain ratchet for one reason:
 * paying down a list is a separate act of virtue, it competes with real work, and it
 * loses. A calendar picks files at random and picks them when nobody is looking at
 * them; an edit picks exactly the file someone is already holding. A file nobody
 * touches costs nothing, and that is correct rather than a compromise -- an untouched
 * test is not accruing risk. The risk arrives with the edit, and so does the demand.
 *
 * NOTHING MAY BE ADDED HERE. A new test file has no history to be grandfathered by,
 * so it arrives with an entry in STUBS or it does not arrive. Growth is visible in
 * the diff, which is the point: re-grandfathering cannot be done quietly.
 *
 * The list is checked for ROT as well as for growth. A name that has since gained a
 * STUBS entry, or that no longer exists, must be removed -- a list nobody is required
 * to correct becomes a blanket exemption without anyone deciding to grant one.
 *
 * ONE OPERATIONAL NOTE, learned the hard way. This list freezes the tree as it stood
 * when it was written, and CI judges a pull request MERGED INTO the default branch --
 * so any test file that lands on main between generating this and merging it arrives
 * as an orphan and turns the gate red. That is the rule working rather than failing:
 * a file that appeared after the freeze genuinely has no claim to be grandfathered.
 * It does mean a long-lived branch carrying this list must re-check it against main
 * before merging, and the failure names the file, so the cost is one line.
 */
export const GRANDFATHERED = [
  "test/backup.test.mjs",
  "test/base-health-steps.test.mjs",
  "test/baseline.test.mjs",
  "test/build-capabilities.test.mjs",
  "test/canary.test.mjs",
  "test/cause-identity.test.mjs",
  "test/characterise-tick.test.mjs",
  "test/check-accounting.test.mjs",
  "test/checkout-root.test.mjs",
  "test/checkout.test.mjs",
  "test/checkpoint-lease.test.mjs",
  "test/ci-rootcause.test.mjs",
  "test/clean-merge.test.mjs",
  "test/containment.test.mjs",
  "test/denial-policy.test.mjs",
  "test/deploy.test.mjs",
  "test/dispatch-e2e.test.mjs",
  "test/docs-state-is-single-sourced.test.mjs",
  "test/doctor-body-detector.test.mjs",
  "test/doctor-containment.test.mjs",
  "test/doctor-signatures.test.mjs",
  "test/doctor-state.test.mjs",
  "test/durable-run.test.mjs",
  "test/effects-capability.test.mjs",
  "test/escalation-dedup.test.mjs",
  "test/escape.test.mjs",
  "test/flake-dispatch.test.mjs",
  "test/fold-before-evaluate.test.mjs",
  "test/freshness.test.mjs",
  "test/gitguard.test.mjs",
  "test/guardian-hub-access.test.mjs",
  "test/guardian-hub-allowlist.test.mjs",
  "test/guardian-provider-lease.test.mjs",
  "test/hub-backup-restore.test.mjs",
  "test/hub-crosscheck.test.mjs",
  "test/hub-derived-schema.test.mjs",
  "test/hub-doctor.test.mjs",
  "test/hub-drills.test.mjs",
  "test/hub-gatestate.test.mjs",
  "test/hub-locks.test.mjs",
  "test/hub-outbox.test.mjs",
  "test/hub-phases.test.mjs",
  "test/hub-registry.test.mjs",
  "test/hub-schema.test.mjs",
  "test/hub-transition.test.mjs",
  "test/hubsession-acceptance.test.mjs",
  "test/hubsession.test.mjs",
  "test/inherited.test.mjs",
  "test/init.test.mjs",
  "test/lease-expiry.test.mjs",
  "test/lifecycle.test.mjs",
  "test/log-dedup.test.mjs",
  "test/mergecheck.test.mjs",
  "test/missing-required.test.mjs",
  "test/node-floor-is-one-fact.test.mjs",
  "test/notify.test.mjs",
  "test/offline-tests.test.mjs",
  "test/outbox-drain.test.mjs",
  "test/outbox-fencing.test.mjs",
  "test/policy-self-exclusion.test.mjs",
  "test/profile-detect.test.mjs",
  "test/profile-validate.test.mjs",
  "test/prompt-sandbox-agreement.test.mjs",
  "test/prompt-study.test.mjs",
  "test/provider-queue-order.test.mjs",
  "test/provider-scheduler.test.mjs",
  "test/reconciler.test.mjs",
  "test/repair-message.test.mjs",
  "test/repo-id-lookup.test.mjs",
  "test/required-evidence.test.mjs",
  "test/retry-brake.test.mjs",
  "test/review-body-findings.test.mjs",
  "test/review-derive.test.mjs",
  "test/review-facts-wire.test.mjs",
  "test/review-gate.test.mjs",
  "test/review-ingest.test.mjs",
  "test/review-request-effect.test.mjs",
  "test/review-shadow.test.mjs",
  "test/reviewer-refusal-shapes.test.mjs",
  "test/reviewer-status.test.mjs",
  "test/sandbox.test.mjs",
  "test/schema-is-one-file.test.mjs",
  "test/schema-migration.test.mjs",
  "test/selfaudit.test.mjs",
  "test/settlement-persistence.test.mjs",
  "test/shadow-same-moment.test.mjs",
  "test/spill-handlers.test.mjs",
  "test/status-vocabulary.test.mjs",
  "test/status.test.mjs",
  "test/supervisor-contract.test.mjs",
  "test/supervisor.test.mjs",
  "test/uncommitted-baseline.test.mjs",
  "test/verdict.test.mjs",
  "test/watcher.test.mjs",
  "test/worker-args.test.mjs",
  "test/worker-contract.test.mjs",
  "test/worker-report.test.mjs",
  "test/worker-tool-boundary.test.mjs",
  "test/workerenv.test.mjs",
  "test/zero-agrees-with-the-code.test.mjs",
];

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
    // COMPOUND, and it BECAME compound, like `inert-raw-body`. Prepending the kept
    // assertions used to be the only thing keeping a buried failure reachable; the
    // verdict now comes from counters that never consult the tail, so prepending is
    // the HUMAN's evidence rather than the verdict's and removing it alone correctly
    // changes nothing. Both halves, or the entry reports NOT_CAUGHT honestly.
    name: "keep-verdict-lines",
    why: "discard assertion lines with the output tail AND read the verdict back out of that tail, so a noisy failure reads as CRASHED",
    test: "test/stubsweep.test.mjs",
    expectRed: "a named assertion still counts when the failure buries it",
    edits: [{ file: "scripts/stub-sweep.mjs",
              find: '              output: kept.length ? `${kept.join("\\n")}\\n${body}` : body });',
              replace: "              output: body });" },
            { file: "scripts/stub-sweep.mjs",
              find: "              observed,\n",
              replace: "" }],
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
              find: "await import(pathToFileURL(manifestPath).href)",
              replace: "await import(manifestPath)" }],
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
    // COMPOUND, and it BECAME compound. Making the raw body inert used to be the
    // only thing stopping a forged line from being classified; the verdict now
    // comes from counters taken per stream, which a forged line never enters, so
    // the two defences are redundant and removing either alone correctly changes
    // nothing. The entry read NOT_CAUGHT honestly until it removed both.
    name: "inert-raw-body",
    why: "classify the raw interleaved capture AND read the verdict back out of it, where a line neither stream emitted can name the expected assertion",
    test: "test/stubsweep.test.mjs",
    expectRed: "an assertion forged by interleaving does not pass the sweep",
    edits: [{ file: "scripts/stub-sweep.mjs",
              find: '    const raw = (dropped ? `[${dropped} earlier byte(s) dropped]\\n${out}` : out)\n      .split("\\n").map(l => `  ${l}`).join("\\n");\n    const body = raw;',
              replace: '    const body = dropped ? `[${dropped} earlier byte(s) dropped]\\n${out}` : out;' },
            { file: "scripts/stub-sweep.mjs",
              find: "              observed,\n",
              replace: "" }],
  },
  {
    name: "ignored-fingerprint",
    why: "compare ignored artifacts by PATH only, so a control run overwriting one in place is invisible",
    test: "test/stubsweep.test.mjs",
    expectRed: "an ignored artifact the control OVERWROTE voids the reading",
    edits: [{ file: "src/stubsweep.mjs",
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
            { file: "src/stubsweep.mjs",
              find: "    if (i === buf.length || buf[i] === 0) { if (i > start) fields.push(buf.subarray(start, i)); start = i + 1; }",
              replace: "    if (i === buf.length || buf[i] === 0x0a) { if (i > start) fields.push(buf.subarray(start, i)); start = i + 1; }" }],
  },
  {
    name: "porcelain-bytes",
    why: "decode the porcelain output as UTF-8, which replaces every undecodable byte and hands the filesystem a path that does not exist",
    test: "test/stubsweep.test.mjs",
    expectRed: "an undecodable ignored path reaches the filesystem call as its original bytes",
    edits: [{ file: "src/stubsweep.mjs",
              find: '  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "binary");',
              replace: '  const buf = Buffer.from(String(raw), "utf8");' }],
  },
  {
    name: "symlink-by-target-text",
    why: "stop hashing an ignored symlink's target text, so every symlink fingerprints as one constant and retargeting it is invisible",
    test: "test/stubsweep.test.mjs",
    expectRed: "an ignored symlink RETARGETED by the control run voids the reading",
    edits: [{ file: "src/stubsweep.mjs",
              find: "  if (st.isSymbolicLink()) {",
              replace: "  if (false) {" }],
  },
  {
    // SINGLE-PURPOSE, and that is the whole point of it. This exact regression
    // shipped: `observed` was computed correctly and never put on the resolved run,
    // so `classify` took its documented fallback and the counting path was inert.
    // The suite stayed green -- both paths return the same verdict when the new one
    // is unused -- and two COMPOUND entries reported CAUGHT for the other half of
    // their stub, which is what hid it. A compound stub cannot say which defence
    // carried the entry, so a seam whose wiring is unproven needs one of these.
    name: "observed-reaches-the-verdict",
    why: "compute the counters and never hand them to the classifier, which is the inert-seam regression this file already shipped once",
    test: "test/stubsweep.test.mjs",
    expectRed: "the runner's own counters reach the verdict: only-passes is WRONG_RED, not CRASHED",
    edits: [{ file: "scripts/stub-sweep.mjs",
              find: "              observed,\n",
              replace: "" }],
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
  {
    name: "premerge-unfinished-check-is-unknown",
    why: "treat a check that has not finished as though it had passed, which is the window a merge lands in",
    test: "test/premerge.test.mjs",
    expectRed: "an unfinished check is UNKNOWN, not clear",
    edits: [{ file: "src/premerge.mjs",
              find: "  if (unfinished.length)",
              replace: "  if (false)" }],
  },
  {
    name: "premerge-no-checks-is-not-a-pass",
    why: "read no checks at all as nothing-failed, so a repository with no CI reads as passing",
    test: "test/premerge.test.mjs",
    expectRed: "no checks at all is UNKNOWN, not clear",
    edits: [{ file: "src/premerge.mjs",
              find: "  if (runs.length === 0)",
              replace: "  if (false)" }],
  },
  {
    name: "premerge-truncated-listing-is-unknown",
    why: "drop the completeness check, so a page cap makes a partial read look settled",
    test: "test/premerge.test.mjs",
    expectRed: "a truncated listing is UNKNOWN, because 'none unresolved' would be about a page",
    edits: [{ file: "src/premerge.mjs",
              find: "  if (nodes.length !== totalCount)",
              replace: "  if (false)" }],
  },
  {
    name: "premerge-verdict-never-rounds-up",
    why: "invert the ranking so the best news wins and a summary line reads as a pass while carrying a refusal",
    test: "test/premerge.test.mjs",
    expectRed: "a pull request nobody reviewed is not clear even with everything else green",
    edits: [{ file: "src/premerge.mjs",
              find: "  const rank = { [REFUSE]: 3, [UNKNOWN]: 2, [UNREVIEWED]: 1, [CLEAR]: 0 };",
              replace: "  const rank = { [REFUSE]: 0, [UNKNOWN]: 0, [UNREVIEWED]: 0, [CLEAR]: 1 };" }],
  },
  {
    name: "premerge-unreadable-refs-are-unknown",
    why: "treat refs that could not be read as though the branch matched, which is absence read as agreement",
    test: "test/premerge.test.mjs",
    expectRed: "refs that could not be read are UNKNOWN, not clear",
    edits: [{ file: "src/premerge.mjs",
              find: "  if (branchRead !== \"read\")",
              replace: "  if (false)" }],
  },
  {
    name: "premerge-pending-status-is-not-clear",
    why: "read a legacy status context's PENDING state as finished, which is how a pending pull request reported CLEAR",
    test: "test/premerge.test.mjs",
    expectRed: "a legacy status in PENDING is UNKNOWN, not clear",
    edits: [{ file: "src/premerge.mjs",
              find: "  const unfinished = runs.filter(r => !FAILED.has(norm(r)) && !PASSED.has(norm(r)));",
              replace: "  const unfinished = runs.filter(r => !norm(r));" }],
  },
  {
    name: "premerge-rollup-completeness",
    why: "drop the completeness check on the check rollup, so a first page of passes reads as all of them",
    test: "test/premerge.test.mjs",
    expectRed: "a truncated check rollup is UNKNOWN, not clear",
    edits: [{ file: "src/premerge.mjs",
              find: "  if (totalCount !== null && nodes.length !== totalCount)",
              replace: "  if (false)" }],
  },
  {
    name: "premerge-stale-is-terminal",
    why: "put STALE back among the unfinished, so a run that will never complete reads as one still running and a caller retries for ever",
    test: "test/premerge.test.mjs",
    expectRed: "a STALE check run is refused, not reported as unfinished",
    edits: [{ file: "src/premerge.mjs",
              find: "                          \"ERROR\", \"STARTUP_FAILURE\", \"STALE\"]);",
              replace: "                          \"ERROR\", \"STARTUP_FAILURE\"]);" }],
  },
  {
    name: "premerge-binds-the-verified-head",
    why: "drop the verified head, so a caller cannot bind the merge to the commit the gate actually checked",
    test: "test/premerge.test.mjs",
    expectRed: "a clear verdict names the FULL head it verified",
    edits: [{ file: "src/premerge.mjs",
              find: "           verifiedHead: head?.prHead ?? null,",
              replace: "           verifiedHead: null," }],
  },
  {
    name: "premerge-tip-difference-does-not-overclaim",
    why: "restore the claim that a tip difference loses commits, which is false when a branch was force-reset backward to an ancestor",
    test: "test/premerge.test.mjs",
    expectRed: "the tip difference does not claim anything is lost",
    edits: [{ file: "src/premerge.mjs",
              find: "                \"whether that difference loses anything is NOT established here \u2014 \" +",
              replace: "                \"commits on the branch would not be carried \u2014 \" +" }],
  },
  {
    name: "premerge-delegates-mergeability",
    why: "widen the permitted merge states so BLOCKED and DIRTY read as clear, which is the gate printing a merge command GitHub would refuse",
    test: "test/premerge.test.mjs",
    expectRed: "a merge state of BLOCKED is refused rather than reported clear",
    edits: [{ file: "src/premerge.mjs",
              find: "  const ok = new Set([\"CLEAN\", \"HAS_HOOKS\"]);",
              replace: "  const ok = new Set([\"CLEAN\", \"HAS_HOOKS\", \"BLOCKED\", \"DIRTY\", \"DRAFT\", \"BEHIND\", \"UNSTABLE\"]);" }],
  },
  {
    name: "premerge-transient-merge-state",
    why: "let an unresolved merge state fall through to REFUSE, reporting an asynchronous transient as an actionable blocker",
    test: "test/premerge.test.mjs",
    expectRed: "a resolved mergeable with an unresolved merge state is a transient, not a refusal",
    edits: [{ file: "src/premerge.mjs",
              find: "  if (status === \"UNKNOWN\")",
              replace: "  if (false)" }],
  },
  {
    name: "premerge-null-review-is-not-approval",
    why: "let a null review decision fall through to clear, so 'no review is required' reads as 'somebody reviewed'",
    test: "test/premerge.test.mjs",
    expectRed: "no review decision is UNREVIEWED, not clear",
    edits: [{ file: "src/premerge.mjs",
              find: "  return { state: UNREVIEWED,\n           why: \"GitHub reports no review decision, which means none is REQUIRED rather than that one was given\" };",
              replace: "  return { state: CLEAR,\n           why: \"GitHub reports no review decision\" };" }],
  },
  {
    name: "outbox-edge-survives-a-rerun",
    why: "write the dependants with no dependency at all, which is the orphan: they drain at once and their token has no parent to read",
    test: "test/outbox-edge-rerun.test.mjs",
    expectRed: "a child is written with the parent's id, not with no dependency at all",
    edits: [{ file: "src/db/ops.mjs",
              find: "  for (const child of dependants) ids.push(enqueue(db, { ...child, dependsOn: parentId }));",
              replace: "  for (const child of dependants) ids.push(enqueue(db, { ...child, dependsOn: null }));" }],
  },
  {
    name: "migration-counter-absence",
    why: "key the legacy counters by a plain object, so a `__proto__` kind or status hits the inherited setter and its count vanishes from the report entirely",
    test: "test/migration-counters.test.mjs",
    expectRed: "an unknown kind named '__proto__' is PRESENT in unknownKind",
    edits: [{ file: "src/db/migrate.mjs",
              find: "                 statusChanges:0, coercedStatus:counters(), unknownKind:counters(),",
              replace: "                 statusChanges:0, coercedStatus:{}, unknownKind:{}," }],
  },
  {
    name: "migration-counter-garbage",
    why: "the same defect's OTHER half, which the presence assertion cannot see: `constructor` DOES become an own property, so only its VALUE reveals that the count is a stringified inherited function",
    test: "test/migration-counters.test.mjs",
    expectRed: "'constructor' counts to the NUMBER 1 in unknownKind, not a stringified inherited function",
    edits: [{ file: "src/db/migrate.mjs",
              find: "                 statusChanges:0, coercedStatus:counters(), unknownKind:counters(),",
              replace: "                 statusChanges:0, coercedStatus:{}, unknownKind:{}," }],
  },
  {
    name: "premerge-approval-bound-to-head",
    why: "stop filtering the approvals by commit, so an approval given on an EARLIER commit reads as an approval of the head being merged -- the original defect, an APPROVED aggregate mapping straight to CLEAR",
    test: "test/premerge.test.mjs",
    expectRed: "an approval on an EARLIER commit does not clear the head being merged",
    edits: [{ file: "src/premerge.mjs",
              find: "    const atHead = approvals.filter(a => a.commit.oid === head);",
              replace: "    const atHead = approvals;" }],
  },
  {
    name: "premerge-unreadable-approval-is-not-clear",
    why: "treat an approving review whose commit did not resolve as an approval on some earlier commit, so an incomplete READ is reported as a finding and automation asks for another review instead of saying the read failed",
    test: "test/premerge.test.mjs",
    expectRed: "an approval whose commit is null is UNKNOWN, not an approval on an earlier commit",
    edits: [{ file: "src/premerge.mjs",
              find: "      return { state: UNKNOWN,\n               why: `GitHub reports APPROVED, but ${unreadable.length} of ${approvals.length} approving review(s) carry no resolvable commit",
              replace: "      return { state: UNREVIEWED,\n               why: `GitHub reports APPROVED, but ${unreadable.length} of ${approvals.length} approving review(s) carry no resolvable commit" }],
  },
  {
    name: "premerge-truncated-reviews-are-not-a-verdict",
    why: "read a truncated page of opinionated reviews as the whole set, so an approval of this head sitting on a later page is reported as `every approval is on an earlier commit` -- a page presented as a finding",
    test: "test/premerge.test.mjs",
    expectRed: "a TRUNCATED approvals listing is UNKNOWN, not a verdict about the page that was read",
    edits: [{ file: "src/premerge.mjs",
              find: "  if (nodes.length !== totalCount)\n    return { ok: false, state: UNKNOWN,",
              replace: "  if (false)\n    return { ok: false, state: UNKNOWN," }],
  },
  {
    name: "premerge-completeness-precedes-the-filter",
    why: "check completeness AFTER narrowing to approvals, so totalCount (which counts every opinionated review) can never match and any pull request carrying a change-request is refused as truncated -- the completeness rule producing a false refusal of its own making",
    test: "test/premerge.test.mjs",
    expectRed: "a CHANGES_REQUESTED review sitting in the listing is not truncation",
    edits: [{ file: "src/premerge.mjs",
              find: "    const complete = completeness({ nodes: reviews, totalCount: reviewsTotal,",
              replace: "    const complete = completeness({ nodes: reviews.filter(r => String(r?.state).toUpperCase() === \"APPROVED\"), totalCount: reviewsTotal," }],
  },
  {
    name: "sweep-covers-every-test-file",
    why: "let a test file be neither named by an entry nor listed as frozen debt, which is how 103 of 106 files came to have no stub while the required job claimed the tests could fail. NAMED AGAINST THE SYNTHETIC ASSERTION, not the repository-wide one: that one asserts the current tree has zero orphans, and a value already at zero cannot be moved by breaking the detector, so a stub of it comes back NOT_CAUGHT however true the assertion is",
    test: "test/stubsweep.test.mjs",
    expectRed: "coverage() NAMES a test file that has neither an entry nor a place on the list",
    edits: [{ file: "src/stubsweep.mjs",
              find: "  const orphans = files.filter(f => !named.has(f) && !spared.has(f));",
              replace: "  const orphans = [];" }],
  },
  {
    name: "sweep-grandfather-list-cannot-rot",
    why: "stop noticing that a grandfathered file has gained an entry or stopped existing, so the list quietly becomes a blanket exemption nobody granted",
    test: "test/stubsweep.test.mjs",
    expectRed: "coverage() reports a grandfathered file that has SINCE gained an entry",
    edits: [{ file: "src/stubsweep.mjs",
              find: "  const stale = [...spared].filter(f => named.has(f) || !files.includes(f)).sort();",
              replace: "  const stale = [];" }],
  },
  {
    name: "sweep-unresolvable-base-is-not-an-empty-diff",
    why: "return an empty file list when the base cannot be resolved instead of refusing, which is how a depth-1 checkout makes the gate pass while measuring nothing",
    test: "test/stubsweep.test.mjs",
    expectRed: "an unresolvable base REFUSES rather than reporting an empty diff, which would pass",
    edits: [{ file: "src/stubsweep.mjs",
              find: "  if (!base) return { ok: false, files: [], why:",
              replace: "  if (!base) return { ok: true, files: [], why:" }],
  },
  {
    name: "sweep-grandfathering-ends-at-the-first-edit",
    why: "let a grandfathered file be edited without demanding a stub, which removes the only mechanism that ever pays the debt down",
    test: "test/stubsweep.test.mjs",
    expectRed: "editing a grandfathered test file REFUSES, and names the file",
    edits: [{ file: "src/stubsweep.mjs",
              find: "  const touched = (changed ?? []).filter(f => spared.has(f));",
              replace: "  const touched = [];" }],
  },
  {
    name: "sweep-frozen-list-may-only-shrink",
    why: "accept additions to GRANDFATHERED, so a change can drop a test's entry and add the test to the list instead -- the file is never edited, the edit rule sees only the manifest in the diff, and coverage falls while the gate reports success",
    test: "test/stubsweep.test.mjs",
    expectRed: "a name ADDED to the frozen list is refused, and named",
    edits: [{ file: "src/stubsweep.mjs",
              find: "  const added = (after ?? []).filter(f => !was.has(f));",
              replace: "  const added = [];" }],
  },
  {
    name: "registryio-nonzero-git-exit-is-not-no-entry",
    why: "accept a nonzero git exit as an answer, so a checkout git refuses to read -- dubious ownership, a corrupt or locked index, exit 128 -- comes back as empty stdout, parses to `null`, and the caller admits the claim without ever establishing whether the index records a symlink or a submodule. `ls-files` exits 0 when nothing matches, so a nonzero status never means \"no entry\"; it always means the question could not be asked, and answering it as absence is fail-OPEN on the one probe that guards the admission path",
    test: "test/registry-io.test.mjs",
    expectRed: "git failing with exit 128 refuses, rather than reading as \"nothing is tracked\"",
    edits: [{ file: "src/build/registryio.mjs",
              find: "      if (res.status !== 0 || res.signal)",
              replace: "      if (false)" }],
  },
  {
    name: "sweep-ratio-counts-proven-not-present",
    why: "report every manifest entry as coverage regardless of whether it could run, so an entry whose anchor a refactor moved keeps counting as a guard while guarding nothing -- the ratio overstating by exactly the thing the sweep exists to prevent",
    test: "test/stubsweep.test.mjs",
    expectRed: "the ratio says how many entries were PROVEN when that is fewer than exist",
    edits: [{ file: "src/stubsweep.mjs",
              find: "  const head = proven === null || proven === c.entries",
              replace: "  const head = true" }],
  },
  {
    name: "sweep-file-count-follows-proven-too",
    why: "count a test file as covered when its only entry could not run, so the FILE-level number keeps overstating after the entry-level number was fixed -- half a repair reading as a whole one",
    test: "test/stubsweep.test.mjs",
    expectRed: "a file whose only entry could not run is NAMED but not PROVEN",
    edits: [{ file: "src/stubsweep.mjs",
              find: "           provenCovered: provenNamed === null ? null : files.filter(f => provenNamed.has(f)) };",
              replace: "           provenCovered: provenNamed === null ? null : files.filter(f => named.has(f)) };" }],
  },
  {
    name: "source-is-text-nul-scan",
    why: "stop finding the NUL byte, so a file git treats as BINARY passes the scan -- a file whose diff every reviewer sees as empty, which is how a NUL delimiter written as a literal byte survived in the module that decides whether a check run counts",
    test: "test/source-is-text.test.mjs",
    expectRed: "the NUL detector finds the byte in a buffer that contains one",
    edits: [{ file: "test/source-is-text.test.mjs",
              find: "const nulAt = buf => buf.indexOf(0);",
              replace: "const nulAt = () => -1;" }],
  },
  {
    name: "lint-rule-reports-a-pathname-read",
    why: "stop matching the property name, so the rule reports nothing and every invalid case in its tests passes vacuously -- a lint rule that fires on nothing is the same shape as a test that cannot fail",
    test: "test/lint-no-url-pathname.test.mjs",
    expectRed: "a direct read is reported",
    edits: [{ file: "tools/eslint-rules/no-url-pathname.js",
              find: 'if (node.computed || node.property?.name !== "pathname") return;',
              replace: 'if (node.computed || node.property?.name !== "never-matches") return;' }],
  },
  {
    name: "lint-config-reaches-the-extensionless-cli",
    why: "narrow the lint config's file patterns so the extensionless CLI matches none of them, which makes eslint SKIP it while `eslint .` prints nothing -- a skipped file and a clean file are the same output, and that is how widening a glob removed all coverage of the production entry point while every command still reported success",
    test: "test/lint-config-covers-bin.test.mjs",
    expectRed: "resolves a config that enables the rule",
    edits: [{ file: "eslint.config.js",
              find: '"bin/!(*.*)", "bin/*.mjs"',
              replace: '"bin/*"' }],
  },
  {
    name: "taskfile-empty-claim-is-the-root",
    why: "filter blank claims out of the territory list before counting it -- the shape an author reaches for first -- so a whitespace-only --territory reads as \"no territory declared\" and is refused by the grammar. The refusal looks correct, and the grammar assertions stay green, but the claim that conflicts with EVERYTHING in its project has quietly become a filing that conflicts with nothing. `normalizeClaim` returns the repository root for a blank claim deliberately; the absence of a territory claim must never read as the absence of conflict",
    test: "test/task-file.test.mjs",
    expectRed: "an empty claim is admitted as a claim, not dropped",
    edits: [{ file: "src/build/taskfile.mjs",
              find: "  if (!Array.isArray(territory) || territory.length === 0)",
              replace: "  if (!Array.isArray(territory) || territory.filter(t => String(t).trim()).length === 0)" }],
  },
  {
    name: "taskfile-refusal-leaves-nothing",
    why: "catch admitTask's refusal OUTSIDE its transaction and re-insert a bare task row so the operator \"has something to look at\" -- the shape an author reaches for when a refusal loses the title the founder typed. The refusal is still returned and still names the blocking task, so every message assertion stays green, while the hub gains a task holding no territory, blocking nothing, and reading as FILED in every later view. A refusal that is RETURNED and a refusal that CHANGED NOTHING are two different facts",
    test: "test/task-file.test.mjs",
    expectRed: "and the task-row COUNT is unchanged",
    edits: [{ file: "src/build/taskfile.mjs",
              find: "  if (!r.ok) return { ok: false, refusal: r.refusal };",
              replace: "  if (!r.ok) { db.prepare(\"INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,generation,source_kind,source_key,repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,created_at,updated_at) VALUES(?,?,?,?,?,'FILED',1,'founder',?,?,?,?,?,?,?,unixepoch(),unixepoch())\").run(id, project, snapshot.repoId, snapshot.nwo, title, id, snapshot.repoPath, snapshot.profilePath, snapshot.profileHash, snapshot.defaultBranch, snapshot.visibility, snapshot.registryVersion); return { ok: false, refusal: r.refusal }; }" }],
  },
  {
    name: "taskfile-liveness-is-never-defaulted",
    why: "give the liveness predicate a default instead of refusing without one. assertWritable throws exactly when the predicate says the restore's holder is ALIVE, so `() => true` never reaps a lock whose holder is long dead and wedges the hub read-only for good, while `() => false` reaps a live restore and admits a filing into a file being replaced underneath it. One costs availability and the other costs the write; a default picks one silently on behalf of the only caller that could tell them apart",
    test: "test/task-file.test.mjs",
    expectRed: "fileTask throws rather than defaulting isAlive",
    edits: [{ file: "src/build/taskfile.mjs",
              find: "  if (typeof isAlive !== \"function\")",
              replace: "  if (false)" }],
  },
  {
    name: "taskfile-honours-the-predicate-it-is-given",
    why: "accept the caller's liveness predicate and then not use it, passing `() => true` to the writer lease instead -- which reads EVERY recorded restore holder as alive, including one whose process died mid-restore. The filing is then refused with a correct-looking `a restore is in progress` message naming a pid that no longer exists, and it is refused for ever: nothing else reaps that row, so one crashed restore makes the hub permanently unwritable while every message about it reads as normal operation",
    test: "test/task-file.test.mjs",
    expectRed: "a filing proceeds once the dead holder's lock is reaped",
    edits: [{ file: "src/build/taskfile.mjs",
              find: "    { command: \"reeve task file\", pid, lstart, isAlive },",
              replace: "    { command: \"reeve task file\", pid, lstart, isAlive: () => true }," }],
  },
  {
    name: "taskfile-dry-run-writes-nothing",
    why: "let --dry-run fall through into the real admission, so the command that exists to answer \"what would happen\" performs it instead. The founder's habit of checking before committing becomes the thing that files the task, and on free territory it succeeds -- so the operator sees a plan-shaped failure and a real task row. Both counters are asserted, and on DISJOINT territory: a dry run whose claims are already held would be refused by the conflict and write nothing either way, which makes the counter agree with a correct implementation and a broken one alike",
    test: "test/task-file.test.mjs",
    expectRed: "and it still inserts no task row",
    edits: [{ file: "src/build/taskfile.mjs",
              find: "  if (dryRun) return { ok: true, dryRun: true,",
              replace: "  if (false) return { ok: true, dryRun: true," }],
  },
  {
    name: "taskfile-next-sub-shape-is-frozen",
    why: "collapse `next` from {phase, generation} to a bare phase string. Every mutating command in this system returns the same envelope and the commands written against it do not exist yet, so this is the change that breaks every future reader while breaking no current test: the KEY SET is untouched, so a freeze that checks only the envelope's keys stays green, and only an assertion over next's OWN keys can see it. The half a freeze already covers is not the half that needs the freeze",
    test: "test/task-file.test.mjs",
    expectRed: "and so is next's, which is the half a consumer reads a phase out of",
    edits: [{ file: "src/build/taskfile.mjs",
              find: "             next: { phase: \"FILED\", generation: 1 }, evidence_id: ev,",
              replace: "             next: \"FILED\", evidence_id: ev," }],
  },
  {
    name: "cli-valued-flag-given-no-value-is-refused",
    why: "accept a valued flag that was given no value, so `--title` with nothing after it becomes the empty string instead of a refusal. Every route then reads `opt(\"title\")` as \"\" and proceeds: a task is filed with no title, which is what names it in every later view, and the operator sees a success. The parser is the only place that can tell an omitted value from an intended empty one, because by the time a route reads it the two are the same string",
    test: "test/cli-flags.test.mjs",
    expectRed: "an empty valued flag is refused",
    edits: [{ file: "bin/reeve",
              find: "    if (v === undefined || (v === \"\" && !EMPTY_IS_A_VALUE.has(name))) {",
              replace: "    if (false) {" }],
  },
  {
    name: "cli-task-reaches-its-own-body",
    why: "stop the `task` label from matching, so the command falls past its own body. This CLI's case labels share fall-through blocks and `task` sits directly above `build` -- the position that captured status, statusline and dash for a full day when `shadow` landed there. A route that does not reach its body does not error in an obvious way; it runs the NEXT command's body against the operator's arguments, which is how a read command became a write one",
    test: "test/cli-routing.test.mjs",
    expectRed: "task reaches its own body",
    edits: [{ file: "bin/reeve",
              find: "  case \"task\": {",
              replace: "  case \"task-disabled\": {" }],
  },
  {
    name: "artifact-write-is-atomic-against-a-crash",
    why: "write the artifact straight to its final path, because the rename looks like an optimisation. A process killed mid-write then leaves a SHORT research.md rather than nothing -- present, correctly named, and incomplete -- and the next reader finds an artifact where there should be none. The drill kills a real child between the write and the rename, so the assertion is about what survives a crash rather than about what the function returns",
    test: "test/artifact.test.mjs",
    expectRed: "no artifact exists after a write interrupted before its rename",
    edits: [{ file: "src/build/artifact.mjs",
              find: "  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString(\"hex\")}`;",
              replace: "  const tmp = path;" }],
  },
  {
    name: "artifact-read-back-checks-the-bytes",
    why: "return the file's contents without comparing its hash to the one recorded, so a read certifies that something is there rather than that it is the thing the transition was justified by. An artifact edited after its write then reads back clean, and the sha in phase_event describes bytes nobody has since seen",
    test: "test/artifact.test.mjs",
    expectRed: "and a file mutated after the write is refused on read-back",
    edits: [{ file: "src/build/artifact.mjs",
              find: "  if (got !== expectSha)",
              replace: "  if (false)" }],
  },
  {
    name: "path-ids-cannot-escape-their-directory",
    why: "stop sanitising the identifier used as a directory name. Task ids and repository names arrive from a command line, and a separator that survives turns join(home, \"tasks\", id) into a path that leaves the home entirely -- so a filing can read or write anywhere the process can. The assertion resolves the path and requires containment rather than searching for two dots, because `../../etc` sanitises to `--..-etc`, which still contains them and still cannot traverse: a segment is not a path",
    test: "test/state-paths.test.mjs",
    expectRed: "a task id cannot escape the tasks directory",
    edits: [{ file: "src/paths.mjs",
              find: "const safe = s => String(s).replace(/[^A-Za-z0-9._-]/g, \"-\").replace(/^\\.+/, \"-\");",
              replace: "const safe = s => String(s);" }],
  },
  {
    name: "artifact-citation-is-checked-per-claim",
    why: "check the artifact for a citation anywhere in the FILE rather than on each claim. Nine cited claims and one bare assertion then read as clean -- and the bare one is the claim that needed checking. The whole-file form passes as soon as any line carries a citation, so it grows weaker the longer the artifact gets, which is the opposite of what a gate should do",
    test: "test/artifact.test.mjs",
    expectRed: "and exactly the one uncited claim is named, not the whole file",
    edits: [{ file: "src/build/artifact.mjs",
              find: "      if (!CLAIM.test(line)) continue;",
              replace: "      if (!CLAIM.test(line)) continue;\n      if (CITATION.test(withoutUrls(text))) { claims++; continue; }" }],
  },
  {
    name: "reviewdiff-refuses-an-artifact-phase",
    why: "let a report phase fall through into the diff gate, on the argument that nothing calls reviewDiff with a phase name. It then arrives with an empty file list and is refused as \"the worker produced an empty diff\" -- a refusal that reads as the worker's fault and is the gate's, so an operator debugs a worker that did exactly what it was asked. The guard is derived from the artifact-phase map rather than listing the three names, so a fourth report phase is covered without anyone remembering",
    test: "test/artifact.test.mjs",
    expectRed: "reviewDiff refuses the dispatch name BUILD_RESEARCH",
    edits: [{ file: "src/sandbox.mjs",
              find: "  if (action !== null && (BUILD_ACTIONS.includes(action) || Object.hasOwn(ARTIFACT_FILE, action)))",
              replace: "  if (false)" }],
  },
  {
    name: "run-paths-do-not-collide-across-attempts",
    why: "drop the attempt from a run's filename, so a retry writes over the transcript of the attempt it is retrying. Nothing errors: the file is present, correctly named, and describes the wrong run -- and the crash-recovery path that finds a surviving worker by this name then finds the wrong one. This is the shape that made two of three runs vanish from a measured comparison and forced a published figure to be withdrawn. The assertion compares two attempts TO EACH OTHER rather than to a frozen string, because against a frozen name that carries an attempt, a path that has lost its attempt still differs -- and the check passes under the exact defect it is named for",
    test: "test/state-paths.test.mjs",
    expectRed: "and a different attempt is a different file, so one attempt cannot overwrite another",
    edits: [{ file: "src/paths.mjs",
              find: "`g${generation}-${phase}-s${slice}-a${attempt}.${stream}`",
              replace: "`g${generation}-${phase}-s${slice}.${stream}`" }],
  },
  {
    name: "reviewdiff-guard-matches-the-dispatch-vocabulary",
    why: "key the guard on PHASE names only, which is the form that shipped and could never fire: reviewDiff receives `decision.action`, and a report phase is dispatched under a BUILD_ name. The guard then looks correct, is covered by a green test that passes it phase names, and is unreachable from every real caller -- a fixture written to match the implementation rather than production. Both vocabularies are refused now, and phases.mjs records why neither can be derived from the other: SIZING dispatches as BUILD_SIZE, not BUILD_SIZING",
    test: "test/artifact.test.mjs",
    expectRed: "reviewDiff refuses the dispatch name BUILD_SIZE",
    edits: [{ file: "src/sandbox.mjs",
              find: "  if (action !== null && (BUILD_ACTIONS.includes(action) || Object.hasOwn(ARTIFACT_FILE, action)))",
              replace: "  if (action !== null && Object.hasOwn(ARTIFACT_FILE, action))" }],
  },
  {
    name: "artifact-absence-does-not-satisfy-the-citation-rule",
    why: "let an artifact with no claims pass. The per-claim loop runs zero times, every claim is trivially cited, and an artifact that is all headings and prose satisfies a gate whose entire subject is the claims it does not contain. RESEARCH then advances having produced nothing, and the phase that consumes its findings finds none -- with no refusal anywhere, because nothing was checked and nothing was wrong",
    test: "test/artifact.test.mjs",
    expectRed: "a research artifact with NO claims is refused",
    edits: [{ file: "src/build/artifact.mjs",
              find: "    if (claims < minClaims)",
              replace: "    if (false)" }],
  },
  {
    name: "artifact-url-port-is-not-a-citation",
    why: "count a URL's port as a file:line citation. `[\\w./-]+:\\d+` matches localhost:3000 exactly as it matches src/x.mjs:170, and research is full of links -- so a claim supported by nothing but a URL reads as sourced, and the gate accepts precisely the unsupported claims it exists to reject. The controls matter as much: a claim carrying BOTH a link and a real citation must still pass, or the fix has become a ban on URLs",
    test: "test/artifact.test.mjs",
    expectRed: "a claim supported only by http://localhost:3000 is refused",
    edits: [{ file: "src/build/artifact.mjs",
              find: "      if (!CITATION.test(withoutUrls(line))) findings.push(`no file:line citation: ${line.trim()}`);",
              replace: "      if (!CITATION.test(line)) findings.push(`no file:line citation: ${line.trim()}`);" }],
  },
  {
    name: "artifact-design-minima-are-per-slice",
    why: "check the design's required lines across the whole DOCUMENT instead of within each slice. It then passes as soon as one slice carries each label, so a complete first slice makes an empty second slice invisible and the phase advances with a slice naming no files, no tests and no done condition. This is the same per-unit distinction the citation check makes, and it was missing here in the same file -- one site fixed, its sibling left",
    test: "test/artifact.test.mjs",
    expectRed: "a second slice missing everything is refused",
    edits: [{ file: "src/build/artifact.mjs",
              find: "        const rows = body.split(\"\\n\");",
              replace: "        const rows = text.split(\"\\n\");" }],
  },
  {
    name: "artifact-sizing-must-be-a-sizing",
    why: "accept any syntactically valid JSON as a sizing. `null`, `[]`, `7` and `{}` all parse, and none carries a decision -- so the task advances out of SIZING with nothing to size by, and the depth the phase machine reads is simply absent. Parsing proves the bytes are JSON, which is not the property the gate is for",
    test: "test/artifact.test.mjs",
    expectRed: "sizing.json that is null is refused",
    edits: [{ file: "src/build/artifact.mjs",
              find: "      if (!isSizingObject)",
              replace: "      if (false)" }],
  },
  {
    name: "artifact-failed-rename-takes-its-temporary",
    why: "leave the rename outside the cleanup, so a rename that fails after the bytes were safely written leaves a COMPLETE temporary and every retry leaves another. Worse than the partial-write leak it sits three lines below, because each orphan is full size -- and it is that leak's sibling in the same function, which is how it survived the commit that fixed the first one",
    test: "test/artifact.test.mjs",
    expectRed: "a failed rename leaves no temporary behind",
    edits: [{ file: "src/build/artifact.mjs",
              find: "    try { rmSync(tmp, { force: true }); } catch { /* the rename failure is the real one */ }",
              replace: "    /* leak it */" }],
  },
  {
    name: "artifact-stale-temporaries-are-reaped-by-age",
    why: "reap every temporary rather than only those older than the threshold, which deletes a CONCURRENT writer's file out from under it mid-write -- a corruption far worse than the leak the reaper exists to fix. Age is the discriminator precisely because pid is not: pids are reused, so a live writer's temporary can carry a pid this process believes is dead",
    test: "test/artifact.test.mjs",
    expectRed: "and a RECENT one is left alone, because it may be a live writer's",
    edits: [{ file: "src/build/artifact.mjs",
              find: "        if (now - statSync(full).mtimeMs > STALE_TMP_MS) rmSync(full, { force: true });",
              replace: "        rmSync(full, { force: true });" }],
  },
  {
    name: "artifact-slice-ends-at-the-next-section",
    why: "bound the last slice at end-of-file instead of at the next section, so a trailing section's labels are read as the slice's own. An empty final slice followed by a Notes block carrying the four labels then passes -- and the labels it was credited with belong to prose nobody will implement. This is the per-slice fix's own blind spot: bounding slices by the next SLICE leaves the last one unbounded",
    test: "test/artifact.test.mjs",
    expectRed: "an empty final slice does not inherit a trailing section's labels",
    edits: [{ file: "src/build/artifact.mjs",
              find: "      const next = sections.find(i => i > starts[k]) ?? lines.length;",
              replace: "      const next = starts[k + 1] ?? lines.length;" }],
  },
  {
    name: "artifact-citation-must-look-like-a-path",
    why: "accept any token of the form word:number as a file citation. A claim mentioning a time (12:30), a ticket (issue:42) or a pull request then reads as sourced, and research prose is full of all three -- so the gate passes precisely the unsupported claims it exists to catch. Removing URLs closed one leak in that pattern and left the rest, which is the same shape one round later",
    test: "test/artifact.test.mjs",
    expectRed: "12:30 is not a file citation",
    edits: [{ file: "src/build/artifact.mjs",
              find: "const CITATION = /(?:[\\w.-]*\\/[\\w./-]*|[\\w-]+\\.[A-Za-z][\\w]{0,5}):\\d+/;",
              replace: "const CITATION = /[\\w./-]+:\\d+/;" }],
  },
  {
    name: "artifact-design-labels-need-values",
    why: "check that a slice CONTAINS each label rather than that each label has something after it. The bare scaffold -- Files:, Packages:, Tests:, Done when: and nothing else -- then advances as though the slice named its files, its tests and its done condition. The label is the question and the gate was reading it as the answer",
    test: "test/artifact.test.mjs",
    expectRed: "a slice carrying the bare scaffold is refused",
    edits: [{ file: "src/build/artifact.mjs",
              find: "        if (!has) { findings.push(`${heading} has a ${label} line with nothing after it`); continue; }",
              replace: "        if (false) { findings.push(`${heading} has a ${label} line with nothing after it`); continue; }" }],
  },
  {
    name: "artifact-sizing-carries-its-whole-contract",
    why: "require only a depth of the sizing artifact. The design states the shape it emits -- depth, est_files, est_weighted_files, est_packages, est_slices, risk_paths_touched, rationale -- and a sizing carrying only a depth advances the task with no estimate, no slice count, no risk paths and no reasoning, which is every input the floors and the spec section read. I declined this once on the argument that requiring fields would be guessing at an unwritten task; the shape is written down, so it was not a guess to enforce",
    test: "test/artifact.test.mjs",
    expectRed: "a sizing carrying only a depth is refused",
    edits: [{ file: "src/build/artifact.mjs",
              find: "          if (!(field in parsed)) findings.push(`sizing.json omits ${field}`);",
              replace: "          if (field !== \"depth\" && false) findings.push(`sizing.json omits ${field}`);" }],
  },
  {
    name: "run-path-components-are-single-segments",
    why: "sanitise only the task id and check the other components for presence alone. A phase or stream carrying a separator then escapes the task tree entirely -- `phase: \"x/../../../../escape\"` resolves to a file directly under the reeve home, outside any task. It is the defect `safe` exists to prevent, in the same function, on the arguments beside the one that was protected. These throw rather than being sanitised: a task id is typed by a person, but a phase and a stream are chosen by this codebase, so a separator in one is a wiring error and rewriting it quietly would hide the bug and produce a file nobody can find by name",
    test: "test/state-paths.test.mjs",
    expectRed: "a run path refuses {\"phase\":\"x/../../../../escape\"}",
    edits: [{ file: "src/paths.mjs",
              find: "    if (String(value) !== safe(value))",
              replace: "    if (false)" }],
  },
  {
    name: "artifact-claim-sees-every-list-marker",
    why: "recognise only some of Markdown's list markers, so a claim written with + or 1) is not a claim at all and the citation rule never sees it. The artifact then passes with an uncited claim in it, and the gate reports success on precisely the input it skipped -- a check that narrows its own input answers a smaller question than the one it was asked",
    test: "test/artifact.test.mjs",
    expectRed: "an uncited claim written with \"+\" is seen and refused",
    edits: [{ file: "src/build/artifact.mjs",
              find: "const CLAIM = /^\\s*(?:[-*+]|\\d+[.)])\\s+\\S/;",
              replace: "const CLAIM = /^\\s*(?:[-*]|\\d+\\.)\\s+\\S/;" }],
  },
  {
    name: "artifact-accepts-the-producers-slice-headings",
    why: "match only this plan's level-two `## Slice` heading. The phase plan that will actually emit design.md writes `## Slices` holding level-three `### Slice 1: ...`, so the gate finds ZERO slices in the artifact its producer is specified to write and refuses it with \"carries no ordered slice list\" -- correct work rejected, and every hand-written fixture in the suite passing because they were all written to match the checker rather than the producer",
    test: "test/artifact.test.mjs",
    expectRed: "and accepts the documented design artifact with a depth-carrying expect",
    edits: [{ file: "src/build/artifact.mjs",
              find: "    const SLICE = /^#{2,3}\\s+Slice\\b/;",
              replace: "    const SLICE = /^##\\s+Slice\\b/;" }],
  },
  {
    name: "artifact-expect-needs-no-depth",
    why: "demand a depth inside the expect object. The phase helpers that call this return the requirement set -- minCitationsPerClaim and minClaims -- and carry no depth, because the depth is an INPUT to them and not an output. Demanding one throws before the artifact is read, so the gate refuses its own documented callers while every test that hand-built an expect object passes",
    test: "test/artifact.test.mjs",
    expectRed: "reviewArtifact does not throw on the helper's requirement set",
    edits: [{ file: "src/build/artifact.mjs",
              find: "  if (!expect || typeof expect !== \"object\")",
              replace: "  if (!expect || typeof expect.depth !== \"string\")" }],
  },
  {
    name: "artifact-claims-are-scoped-to-findings",
    why: "treat every bullet in the document as a claim rather than only those under the Findings heading the contract names. A valid research report is then REFUSED for a Limitations note saying the network was unavailable -- the gate rejecting exactly the honest disclosure research is supposed to carry, and refusing correct work rather than admitting wrong work, which is the failure direction nobody looks for",
    test: "test/artifact.test.mjs",
    expectRed: "a bullet outside Findings is not a claim and does not need a citation",
    edits: [{ file: "src/build/artifact.mjs",
              find: "      if (at === -1) return rows;",
              replace: "      return rows;" }],
  },
  {
    name: "artifact-honours-the-requirements-it-is-given",
    why: "ignore the requirement flags the caller passes and key the measured-context check on depth alone. The phase helper returns {requireSliceList, requireDoneCondition, requireMeasuredContext, minSlices} and carries NO depth, so every one of those checks silently does not run -- a quieter failure than refusing, because the gate reports ok and the minima it was asked to apply were never applied",
    test: "test/artifact.test.mjs",
    expectRed: "requireMeasuredContext true is honoured, with no depth in sight",
    edits: [{ file: "src/build/artifact.mjs",
              find: "    const wantsMeasured = \"requireMeasuredContext\" in expect",
              replace: "    const wantsMeasured = false && \"requireMeasuredContext\" in expect" }],
  },
];
