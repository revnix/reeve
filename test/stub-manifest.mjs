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
  "test/cli-flags.test.mjs",
  "test/cli-routing.test.mjs",
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
  "test/state-paths.test.mjs",
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
    name: "pathname-off-a-file-url",
    why: "take `.pathname` off a file URL again, which yields a percent-encoded path that does not exist -- and fails as ENOENT or as a silently skipped existsSync, never as a decode that was missed",
    test: "test/source-is-text.test.mjs",
    expectRed: "no source reads `.pathname`",
    edits: [{ file: "test/deploy.test.mjs",
              find: "const PLIST = fileURLToPath(new URL(\"../deploy/com.revnix.reeve.plist\", import.meta.url));",
              replace: "const PLIST = new URL(\"../deploy/com.revnix.reeve.plist\", import.meta.url).pathname;" }],
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
];
