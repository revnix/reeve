# The operator surface: researched design for S3-E

**What this is.** Six research angles into CLI and operator-surface design, each then **checked
against reeve's actual source** before anything was kept. 54 recommendations survived that check.

**The check is the point.** A recommendation that reeve already satisfies comes back `ALREADY`
with a `file:line`, so nobody "improves" a deliberate decision. A recommendation whose premise
about reeve turns out to be false comes back `REFUTED` with the measurement that killed it — and
**one of those refutations killed the research's own first proposal**, which is the single most
valuable thing in this document.

| | |
|---|---|
| recommendations | **54** |
| status | ADOPT **41** · ALREADY **7** · REFUTED **6** |
| angles | cli-spec 9 · agent-ops-ux 9 · error-taxonomy 9 · attention 9 · evidence-ux 9 · json-contract 9 |

---

## The finding that matters most: reeve is a Node script, and Node owns the low exit codes

The first exit-code table this research proposed was **wrong in a way that would have caused real
harm**, and the second pass killed it by measuring Node's actual behaviour on this machine.

**Node reserves 1, 3, 4, 5, 6, 7, 9, 10, 12, 13 and 14.** `bin/reeve` is `#!/usr/bin/env node`
with `"type": "module"`. Two of those codes are live in reeve **today**, not theoretically:

| proposed | Node's meaning | what reeve does that emits it | the harm |
|---|---|---|---|
| `7` = `upstream`, **retryable = true** | Internal Exception Handler Run-Time Failure | `src/supervisor.mjs:99` installs `process.on("uncaughtException", e => { reap(); throw e; })` — **a handler that rethrows** | a retry wrapper **loops forever** on a crashing crash-handler |
| `13` = `held` | Unsettled Top-Level Await | `bin/reeve:1573,:1697` use top-level `await run(ctx)` | a **stuck daemon** reports a *territory-claim conflict* — a lie in the exact direction the operator acts on |

**Bash owns 126, 127 and 128+N. And launchd already emits 78 into reeve's own log** —
`deploy/com.revnix.reeve.plist:10` records that a bare `node` "fails with exit 78 EX_CONFIG and
writes NOTHING to the stderr log", which kills the sysexits proposal independently of sysexits'
own maintainer deprecating it.

**The window reeve actually owns is 15-125.** The adopted table uses **20-34**, clear of Node,
of bash, and of sysexits' 64-78.

**This is why research gets checked against the source.** Both collisions are invisible from the
standards documents alone; both were found by running `node` on this machine and by reading
reeve's own supervisor.

---

## What reeve already gets right — do not "improve" these

**already-streams-and-synthetic-unknowns** — ALREADY RIGHT: synthetic findings on the fault path — and the stream-separation claim needs its boundary stated

- Record both so a later author does not simplify them away.

(1) SYNTHETIC FINDING ON THE FAULT PATH — confirmed at five sites, not four: bin/reeve:943-947 (no hub), :963-967 (unopenable hub), :979-983 (forward schema version), :990-994 (half-completed first migration), and :1104-1114 (H-7, unreadable registry). Each builds an ordinary finding object and renders it through the ordinary renderer, so the human and the --json consumer receive the same object graph on the fault path as on the healthy path. H-7's severity is `fail` rather than `warn` deliberately, because with no expected projects every absent-row H-4 is suppressed and this one finding stands in for an unknown number of hidden one

- *Where:* `bin/reeve:943-947, :963-967, :979-983, :990-994, :1104-1114; src/doctor.mjs; template for task list|show|why and dash`

**two-bands-not-one-feed** — Keeping "needs you" and "working" as two bands is right and deliberate — but the proposed three-way `waiting_party` map is wrong on both entries that matter

- KEEP the divergence, and make it survive: one comment in `src/build/dash.mjs` beside `HUMAN_WAITS` naming Jules' merged activity feed and Amp's single bell as the patterns being refused, so an author adding a chronological view has to argue against a named alternative rather than fill a gap.

REFUTE the `waiting_party` map as proposed. It is wrong on both non-obvious entries, measured against the derivations in Task 3:
- It calls `WAITING_FOR_NOTICE` "external". The derivation is `ev.notices.some(n => n.kind === "delivered") && !ev.notices.some(n => n.kind === "founder_ack")` (plan lines 838-840) — a notice was delivered and THE FOUNDER has not acknowledged it. That is waiting on the founder

- *Where:* ``src/status.mjs:182-199` (`needsYou`) and `:213-218` (`render`); `HUMAN_WAITS` in `src/build/dash.mjs` (S3-E Task 9); `WAITING` in `src/build/show.mjs` (Task 3)`

**typed-failures-are-ahead-of-the-field** — The kind + exit-table + retryable design is ahead of what funded teams ship; the correlation handle is worth taking but must not be called `run_ref`

- Change nothing about the kind/exit/retryable design. `EXITS = {ok:0, refused:1, misuse:2, degraded:3}` with no two names sharing a code, `ERROR_KINDS` closed at six and snake_case-asserted, and `fail(kind, message, {exit, retryable})` refusing an undeclared kind (plan lines 3739, 2450-2483) are stronger than the shipped comparator. The field offers no counter-example that argues for softening either.

Two additions, one of them renamed.

(1) One comment beside `PAGES` in `src/build/announce.mjs`: a capability wait is CONFIGURATION, never a failure, and raises no escalation by design — with `droid exec` named as the contrast, so a later author benchmarking reeve does not "fix" a resting task 

- *Where:* `S3-E Tasks 1-2 — `bin/reeve.flags.mjs` (`EXITS`, `ERROR_KINDS`, `fail`); `evidenceFor`/`taskShow` in `src/build/show.mjs`; the `WAITING_FOR_CAPABILITY` derivation`

**verdict-lattice-already** — ALREADY — and it is broader than stated: `worst()`, `faultKind()`, `hubAccess`'s three answers and `retryableFrom` are four existing classifiers the new module must consume, not four it may duplicate

- Confirmed at HEAD, every anchor. `src/verdict.mjs:32-36` defines `worst(a,b)` as BLOCK > UNKNOWN > PASS with the comment "UNKNOWN outranks PASS so a clause that could not answer cannot be outvoted", backed by `:13-15`: "Every fail-open defect measured in the previous system was an UNKNOWN silently rendered as PASS: an absent gate script read as a pass, a rate-limited reviewer reporting state=success, a fork PR with zero check runs." `src/build/hubdb.mjs:250-253` defines `faultKind()` → `full` | `operational` | `damage`, each inclusion documented against a measured incident (`:277-284`: SQLITE_FULL classified as damage "sent `build run` and `build status` at `restore --hub --force`, which rep

- *Where:* `src/verdict.mjs:13-15,32-36; src/build/hubdb.mjs:250-285; src/build/hubaccess.mjs:35-45; src/outbox/effects.mjs:168-181 — constrains new src/fail.mjs`

**three-tier-ladder-is-already-right** — reeve independently reinvented the SRE alerting ladder and a two-part anti-desensitisation mechanism — record both as deliberate

- Add each of these as a one-line citation beside the prose that already says it, so the decision is defended rather than rediscovered. No code changes.

(a) THE THREE TIERS ARE THE SRE LADDER. Ewaschuk defines a page as "anything that tries to urgently and actively get the attention of a specific human (e.g. via a pager or cell phone going beep beep beep)" and routes sub-critical items to "bug or ticket-tracking systems" or "a daily (or more frequent) report". reeve's durable row -> dash/digest -> phone IS that ladder, arrived at independently at src/notify.mjs:6-11.

(b) TASK 11's PER-TYPE `next` SATISFIES THE ACTIONABILITY TEST VERBATIM. Ewaschuk: "Simply noting 'this paged again' is not an

- *Where:* `src/notify.mjs:6-11; src/daemon.mjs:3229-3288 (`announceable`); src/status.mjs:182-199; src/build/announce.mjs `PAGES`/`body`/`NEXT` (Tasks 11 and 13)`

**one-format-version-text-unstable** — `why` sharing `show`'s `READ_FORMAT_VERSION` and declaring the human text unstable is already right — make both enforceable rather than conventional

- Keep both decisions and add two standing assertions to the read-model freeze test (Task 6), since neither is currently enforced by anything but habit. (1) Assert that `FORMAT_VERSION` has exactly one definition site: scan `src/build/*.mjs` for `/export const \w*FORMAT_VERSION\b/` and assert the match count is 1, with a counter-control that the same regex finds two in a literal fixture string it has never seen (the extraction-control pattern Task 2 already uses for `fail()` kinds). (2) Assert no `--json` path can emit human text: scan `bin/reeve` for `/JSON\.stringify\(\s*render(Show|List|Why)/` and assert zero matches, with the same style of counter-control. Leave the `THE HUMAN TEXT IS NOT 

- *Where:* ``READ_FORMAT_VERSION` in `src/build/show.mjs`, consumed by `src/build/why.mjs` (S3-E PR-E1 Tasks 3, 4, 6)`

**already-right-with-one-correction** — Four decisions the plan already got right -- with one addition that is measurably wrong and must not be written down

- Record these four in s3.md §4 with their sources attached, so the next author argues against evidence rather than preference:

1. **stdout carries the machine shape, stderr the human one, and stdout is never two documents.** Stated verbatim at plan:484. This is the exact failure npm shipped. Keep it; add the assertion (`stderr` parses as JSON -> red).
2. **The human render is explicitly not a stable interface**, said twice in comments that survive into source (`THE HUMAN TEXT IS NOT A STABLE INTERFACE. Parse --json, never this.`). This is git's porcelain split, and it is what buys the freedom to iterate on the operator's screen at all.
3. **A flag that cannot apply is refused, not ignored**,

- *Where:* `S3-E plan lines 119, 121, 484, 862, 1089, 1157, 1225; `bin/reeve.flags.mjs` (APPLIES); `test/cli-flags.test.mjs``


---

## Refuted, with the measurement that killed each

**exit-numbers-not-ours** — REFUTED: 3–14 are Node's own exit codes and reeve is a node script — and the same fact kills sysexits

- Reject the proposed numbering and write the rejection into src/exit.mjs so it is not re-proposed.

NODE OWNS 1,3,4,5,6,7,9,10,12,13,14 and calls 2 and 8 "Unused". BASH owns 126, 127, 128+N. LAUNCHD emits 78 (EX_CONFIG) into deploy/com.revnix.reeve.plist's StandardErrorPath — the same file reeve writes — and the plist records it at :10: a bare `node` "fails with exit 78 EX_CONFIG and writes NOTHING to the stderr log".

The window reeve actually owns is 15–125, and 20–34 stays clear of sysexits' 64–78 as well.

The two collisions that would have caused real harm:
  7  = Node "Internal Exception Handler Run-Time Failure", proposed as `upstream` with retryable=true → a retry wrapper loops forever on a rethrowing crash handler that reeve actually installs.
  13 = Node "Unsettled Top-Level Await", proposed as `held` → a stuck daemon promise reports a territory-claim conflict, which is a lie in

- *Evidence:* https://raw.githubusercontent.com/nodejs/node/main/doc/api/process.md §"Exit codes" — documents 1,3,4,5,6,7,9,10,12,13,14 and marks 2 "Unused (reserved by Bash for builtin misuse)" and 8 "Unused" · https://www.gnu.org/software/bash/manual/html_node/Exit-Status.html (126 found-but-not-executable, 127 not-found, 128+N fatal signal) · https://man.freebsd.org/cgi/man.cgi?query=sysexits&sektion=3 ("Thi

**transcript-is-the-wrong-artifact** — The obvious import from Jules, Devin and Copilot is the transcript, and its premise does not hold here

- Keep `why` a DECISION trail and never a transcript. The premise behind every transcript feature is that access to the log is the missing thing; in reeve it is not.

What to render instead, concretely:
- each `phase_run` row: `run  <phase> attempt <n>  <status>  out <out_path>`, plus the literal word `TRUNCATED` when `phase_run.truncated = 1` — a truncated log that renders identically to a complete one is absence read as success, and the flag exists at `src/build/hub.sql:191`;
- each `phase_event`: `artifact <sha>  <path from taskPathFor, or "not stored">` — a citation to a sha nobody can open is a citation to nothing;
- NO log bytes in `why`, `renderDash`, or any page body.

The one earned exception is the worker's own `reason` string on a blocked or infeasible report (design §4.1). That is a diagnosis the worker wrote, not a transcript, and it belongs in the escalation body — see the se

- *Evidence:* https://github.com/github/gh-aw/issues/14352 — Copilot shipped the session-log link and then had to file separately for conversation transcripts, because "only GitHub Actions infrastructure logs are available, which lack the actual conversation content": the transcript that exists is the wrong one. https://www.answer.ai/posts/2025-01-08-devin.html — 14 failures, 3 inconclusive, 3 successes in 20 t

**nagios-table-refuted** — REFUTED, upheld — and reeve already has the test that defends the deviation, which is the thing to point a future author at

- Upheld on all three grounds, and the source text checks out exactly. The monitoring-plugins guidelines specify 0 OK / 1 WARNING / 2 CRITICAL / 3 UNKNOWN, and define 3 as covering "Invalid command line arguments were supplied to the plugin or low-level failures internal to the plugin (such as unable to fork, or open a tcp socket) that prevent it from performing the specified operation … The --help or --version output should also result in Unknown state." That is four unrelated conditions on one code — `die()` at the standard level — plus a WARNING tier that presumes a supervising monitoring engine converts the code into a state, which reeve by design does not have (`src/dash.mjs:1-9`: "Regenerated by the daemon each tick, so it is a glance surface rather than a service: nothing to run, nothing to keep alive, nothing to secure. The telemetry stack this sits beside spent weeks serving unaut

- *Evidence:* https://www.monitoring-plugins.org/doc/guidelines.html (Table 2, Plugin Return Codes — quoted verbatim above); reading of /Users/mobeen/Work/Products/reeve-wt/c4/src/dash.mjs:1-9, bin/reeve:442, test/cli-flags.test.mjs:244

**load-aware-escalation-does-not-transfer** — The U-shape transfers; the load-aware policy does not — and the 'cumulative load' argument is not in the paper

- THREE READINGS, and only one survives into the comment.

HOLDS — quote as-is. At capacity C=25 the optimum escalates 64% and lets 42% of dangerous actions through, versus 57% under 100% escalation. Escalating everything is strictly worse than escalating some.

DOES NOT TRANSFER — "make the page list load-aware". The load-aware policy that beat the paranoid one is a THRESHOLD ON A GUARD MODEL'S RISK SCORE: theta=35 giving a 26% escalation rate, versus theta=10 / 88% for paranoid. The 88%-vs-26% attack-success comparison is a fact about two model thresholds. reeve has no risk score and no guard model on this path. Verified: the paper proposes NO batching, NO queue-ordering and NO rate limiting; its future work is fitted fatigue curves, enforced-oversight interception, trajectory-level guarding and a self-improving policy loop. Anyone proposing an adaptive page list is reading a policy into

- *Evidence:* https://arxiv.org/html/2606.08919 (Turan, "Oversight Has a Capacity: Calibrating Agent Guards to a Subjective, Fatiguing Human") — verified: r(l)=max(r_min, 1-slope*max(0,l-C)), slope 0.02, r_min 0.2; Table 2 at C=25: 64% escalation -> 42% danger-through, 100% -> 57%; theta=35 -> 26%, theta=10 -> 88%; attack success ~40% at k=50 filler under paranoid vs ~0% under load-aware, bending to ~10% near k

**no-dag-render-no-signing** — Do not render a DAG and do not sign the lineage — reeve's evidence is a totally ordered chain in a single-operator local store

- Render slices as an indented fan under their parent transition, not as a graph: `#446 dispatch.implement  slice 0` and `#447 … slice 1` as sibling lines with a two-space gutter, ordered by `slice` then `seq`. Reserve `--all` semantics for `--generation all` (prior epochs), never for edges. If a graph is genuinely wanted later, emit it as data — `why --json` already carries `source: {table, key}` per node, which is a complete edge list any external tool can lay out — and keep the terminal renderer a chain. On signing: if cross-machine trust ever arrives (a second operator, a shared hub), the right move is a hash chain over `hub_event.seq` computed with `node:crypto` — still zero dependencies — not an attestation format. Record that as the future shape so the next author does not reach for in-toto or DSSE.

- *Evidence:* https://bazel.build/docs/user-manual (`--explain`/`--verbose_explanations` write a per-step rebuild reason; graph output exists for genuinely many-parented action graphs); https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-why-depends (verified: `--all` shows "all edges in the dependency graph... rather than just a shortest path" — opt-in, because the default question has a single-path answe

**ndjson-refuted-terminator-already** — NDJSON earns nothing on the read routes -- and reeve already invented the terminator record it would need

- Do **not** convert `task show|list|why|dash`, `doctor` or `builder doctor` to NDJSON. Each completes its computation before it prints, is bounded by one operator's task count, and gains nothing from incremental delivery. Batch JSON with the single envelope is correct for all of them.

The apparent argument -- a truncated batch document is unparseable while a truncated NDJSON stream degrades to "the first N records are valid" -- is true and is the wrong fix. The truncation is `process.exit()` abandoning pending stdout writes (see `emit-not-exit`); switching format would hide the bug behind partial output rather than remove it.

Two narrow places NDJSON belongs:
1. **`reeve export-events --hub`** -- ALREADY RIGHT, leave it. `bin/reeve:649` is `rows.map(r => JSON.stringify(r))`, one object per line, written to a FILE (so the truncation bug does not reach it), and `:680` appends a `{_manifes

- *Evidence:* MEASURED at b519803 in this checkout: `bin/reeve:649` `const lines = rows.map(r => JSON.stringify(r));`, `:679-680` writes the `_manifest` line after the body, and the surrounding comment records that an earlier revision "described it here and then wrote only the event lines, so every `restore --hub --tail` was refused for a footer no exporter had ever produced." `src/daemon.mjs:681` is `log(logPa


---

## Adopt


### cli-spec — 7

**exit-codes-two-bands** — Two bands, one frozen module — but the numbers are 20–34, not 1–15

- **Applies to:** `new src/exit.mjs; bin/reeve (48 process.exit sites); src/doctor.mjs:1044; src/init.mjs:10-13,298-326`
- **Recommendation:** One frozen module, one table, and every process.exit() in bin/reeve takes its number from it.

export const EXIT = Object.freeze({
  ok: 0,
  failed: 1,        // FROZEN, back-compat. Node also emits 1 for an uncaught exception and the meanings coincide, so this collision alone is benign. NEW CODE MUST NOT USE IT.
  changed: 2,       // GRANDFATHERED OUTCOME. Already emitted by src/init.mjs:322 and :326 and documented in usage(); src/init.mjs:10-13 records the source explicitly ("Exit codes follow the terraform convention"). DO NOT renumber it to 14.
  // 3 RETIRED, never emitted again. Documented as: "retired — previously meant degraded, stale, or halted at once."
  // 4..14 belong to Node; see finding exit-numbers-not-ours.
  usage: 20,          // unknown flag, missing flag value, inapplicable flag, unknown subcommand, bad positional
  no_credential: 21,  // gh not authenticated, App key unreadable, sandbox denied the read
  absent: 22,         // no repo, no profile, no state db, no hub, no snapshot
  unreadable: 23,     // the store exists but cannot be opened, is corrupt, or is
- **Why here:** MEASURED in bin/reeve: 19 die() call sites plus 18 inline `console.error+process.exit(1)` in one file, so code 1 covers "canary measured an OPEN sandbox" (:932), "doctor found a fail finding" (:1127), "no repo" (:914) and "no profile" (:916) indistinguishably from a typo. Code 3 is emitted at src/doctor.mjs:1044 (degraded), bin/reeve:849 (shadow streak short) and bin/reeve:1696 (tick halted) — no wrapper can tell those three apart.
- **Source:** https://clispec.dev/ (v0.3 candidate, Aug 2026, Ruben Jongejan, CC BY 4.0 — one-author draft, weigh accordingly) · measured `gh help exit-codes` on gh 2.96.0: 0 success / 1 error / 2 cancelled / 4 authentication required · https://developer.hashicorp.com/terraform/cli/commands/plan (-detailed-exitco

**json-envelope-v1** — One versioned envelope for every --json route; field names taken from the spec it cites

- **Applies to:** `bin/reeve:548 (doctor), :894 (status), :946/:965/:981/:992/:1115 (builder doctor); S3 routes task list|show|why, dash, builder doctor, canary`
- **Recommendation:** Exactly one JSON object on stdout, always this shape:

{"reeve":"1.0","command":"builder doctor","at":"2026-08-28T09:14:02.117Z","home":"/Users/mobeen/.reeve","exit":30,"kind":"degraded","band":"outcome","complete":true,"data":{"findings":[]}}

On a failure path the same envelope carries `error` in place of `data`, using the CLI Spec's OWN field names rather than the ones the recommendation invented: `kind` (required), `message` (required), `hint` (the remediation — the draft called it `action`), `details` (structured context — the draft called it `detail`). `retryable` is an additional key, permitted by the spec but not defined by it; derive it from RETRYABLE in src/exit.mjs so the flag and the table cannot disagree.

Versioning is Terraform's, verbatim: minor bump for additive/backward-compatible changes, consumers ignore unrecognised property names; major bump for anything not backward-compatible, consumers reject an unsupported major. Adding a finding field never bumps the major.

`band` is derivable from `exit` but is present because code 2 (changed) sits outside the outcome blo
- **Why here:** MEASURED: the three routes that honour --json emit three unrelated top-level shapes — doctor emits {home, ...result} (:548), status emits {state, health} (:894), builder doctor emits a BARE ARRAY of findings (:1115). None carries a version. A consumer must already know which command it ran before it can parse the first byte, and a later author adding a field to the findings array has no way to signal it.
- **Source:** https://developer.hashicorp.com/terraform/internals/machine-readable-ui ("We will increment the minor version … for backward-compatible changes or additions"; "Ignore any object properties with unrecognized names"; "Reject any input which reports an unsupported major version") · https://clispec.dev/

**die-must-speak-json** — die() must emit the envelope on stderr under --json — and two exits fire before flag() and HOME exist

- **Applies to:** `bin/reeve:60 (die), :224-229 (node version floor), :422-427 (parser errors), and all 37 failure exits`
- **Recommendation:** Give die() the exit table and the flag, but read the flag from argv rather than from the parse. THE CONSTRAINT THE DRAFT MISSED, measured: two failure exits fire before `flag` and `HOME` exist. bin/reeve:224-229 is the Node >=24.10 floor, which runs before `const argv` is even declared at :232; bin/reeve:422-427 is the parser's own error path, and `flag` is defined at :429, `HOME` at :437. A `fail()` that closes over flag("json") or HOME cannot serve either — and those two are the paths a wrapper is most likely to hit first.

const wantsJson = process.argv.includes("--json");   // argv, not the parse: this must work before the parse
const fail = (kind, message, { details = null, hint = null } = {}) => {
  const exit = EXIT[kind];                            // throws on an unknown kind, so a typo can never become exit 0
  if (wantsJson) console.error(JSON.stringify({
    reeve: "1.0", command: cmdPath(), at: new Date().toISOString(), home: resolveHome(),
    exit, kind, band: BAND[exit], complete: false,
    error: { kind, message, details, hint, retryable: RETRYABLE.has(exit) },
  })
- **Why here:** MEASURED: die() is `const die = (msg) => { console.error(msg); process.exit(1); }` at bin/reeve:60, with no reference to flag("json"). So `reeve doctor --json` on the no-repo path (bin/reeve:526) writes prose to stderr, NOTHING to stdout, and exits 1. `reeve doctor --json | jq '.checks'` gets a jq parse error instead of a diagnosis; a caller that swallows stderr sees an empty stdout — this system's dominant defect class (absence read as success) reproduced at the CLI boundary.
- **Source:** https://clispec.dev/ ("writes the structured error envelope as the last line of stderr whenever the selected output format is structured") · https://clig.dev/ ("Send messaging to stderr. Log messages, errors, and so on should all be sent to stderr.") · measured in-repo at bin/reeve:60, :228, :426, :

**flag-applicability-split** — Per-command flag table: ADOPT the mechanism, REFUTE its worked example — --json on dash is settled

- **Applies to:** `bin/reeve:263 (FLAGS), :345-412 (the walk), :424 (the accepts line), :429 (flag()), and the six read routes that accept --json and ignore it`
- **Recommendation:** ADOPT the mechanism. Arity stays global (the single walk needs it to know whether --home eats the next token); applicability becomes a post-walk check keyed on the resolved command:

const COMMANDS = {
  doctor:     { flags:["db","plugin-cache","plugin-repo","as-app","json","home","help"], exits:[0,EXIT.no,EXIT.degraded,EXIT.absent,EXIT.unreadable] },
  canary:     { flags:["db","log","json","home","help"],                                 exits:[0,EXIT.no,EXIT.absent] },
  dash:       { flags:["health","out","open","last","json","home","help"],               exits:[0,EXIT.absent] },
  "task why": { flags:["json","home","last","help"],                                     exits:[0,EXIT.absent] },
  ...
};

Refusal message, in gh's measured shape:
  reeve: --health does not apply to `reeve builder doctor`
  -> reeve builder doctor accepts: --home --json
  -> reeve help exit-codes
exit EXIT.usage (20).

REFUTE the worked example. `reeve: --json does not apply to \`reeve dash\`` contradicts s3.md §4 decision 7, which is settled and not to be reopened: "Every read surface is compute -> dat
- **Why here:** MEASURED: FLAGS at bin/reeve:263 is a single GLOBAL table, so every flag parses on every command by construction — and bin/reeve:424 makes the CLI say so out loud, printing `-> reeve <cmd> accepts: <every key in FLAGS>` on any usage error. flag("json") is read at exactly three routes (:548, :894, :946/:965/:981/:992/:1115). The other six read commands — why (:883-886), statusline (:872), dash (:874-880), shadow (:849), build status, canary (:912-932) — accept --json and change nothing. That is n
- **Source:** measured on this machine, gh 2.96.0: `gh browse --json` → exit 1 "unknown flag: --json"; `gh pr list --json` → exit 1, refuses and PRINTS THE LEGAL FIELDS rather than defaulting · https://clispec.dev/ (per-command declared surface) · https://clig.dev/ · CONTRADICTED SOURCE: tasks/reeve-tasks/tracker

**derive-help-from-the-tables** — Generate usage() from FLAGS/COMMANDS/EXIT and add `reeve help exit-codes` — the pattern already exists on one axis

- **Applies to:** `bin/reeve:1720-1766 (usage), test/cli-flags.test.mjs:291-295, new `reeve help exit-codes` route`
- **Recommendation:** ALREADY, and it is the precedent to extend rather than a new idea: test/cli-flags.test.mjs:291-295 already asserts that the help names every command IN BOTH DIRECTIONS, and its comment states the rule — "Derived from the switch rather than a list, because a second list is what drifts." The pattern is proven on the command axis. Extend it to two more:

(1) Per-command flag lines rendered from COMMANDS[cmd].flags joined against FLAGS[n].what, which already exists and is already written. Delete the hand-copied strings in usage().
(2) Per-command exit lines rendered from COMMANDS[cmd].exits joined against EXIT, in gh's measured style. `reeve canary --help` ends with:
      Additional exit codes:
        31: the sandbox credential read is open
   and every route's footer carries gh's own cross-reference line: "Learn about exit codes using `reeve help exit-codes`".
(3) A `reeve help exit-codes` route printing the whole table, including the retired line: "3  retired — previously meant degraded, stale, or halted at once. Never emitted."

The test that makes it stick: for every command, asser
- **Why here:** MEASURED drift, present now, in three forms. usage() documents doctor as "(0 ok · 1 broken · 3 degraded)", init --write as "(exit 0 no-op · 2 changed · 1 needs an answer)" and canary as "(0 closed · 1 open)" — three hand-written prose statements — while shadow's exit 3 (:849), tick's exit 3 (:1696) and builder doctor's 0/1/3 (:1127) are documented NOWHERE. usage()'s --home line is a byte-for-byte hand copy of FLAGS.home.what (bin/reeve:264). And the comment at bin/reeve:1116 cites "the CLI's exi
- **Source:** measured on gh 2.96.0: `gh pr checks --help` ends with "Additional exit codes:\n\t8: Checks pending" and the footer "Learn about exit codes using `gh help exit-codes`"; `gh help exit-codes` prints a small documented global table · https://cli.github.com/manual/gh_help_exit-codes · https://clispec.de

**stability-section** — Name the four promised surfaces, disclaim human text in the same paragraph, and pin both with a golden file

- **Applies to:** `README.md (new ## Stability section), test/ (new golden-file test), bin/reeve`
- **Recommendation:** Add to README.md, verbatim:

## Stability

PROMISED. Breaking any of these bumps the major.
1. Exit codes. The table `reeve help exit-codes` prints. A code's meaning never
   changes, and a retired code is never reused.
2. The `--json` envelope at `reeve: "1.x"`. Fields are added, never removed and
   never retyped, within a major. Consumers ignore properties they do not
   recognise, and reject a major they do not support.
3. The set of flags each command accepts, and each flag's arity.
4. `export-events --hub` JSONL: one complete JSON value per line, UTF-8, no BOM.

NOT PROMISED. Every byte of human-readable output: column order, wording,
ordering within a band, the sparkline, the dash HTML. Parse `--json` or an exit
code; do not parse the text.

Why the second list exists rather than promising everything: "Changing output for
humans is usually OK. The only way to make an interface easy to use is to iterate
on it, and if the output is considered an interface, then you can't iterate on
it." -- clig.dev

Enforcement, with no dependencies: one golden-file test holding JSON.stringify(E
- **Why here:** MEASURED: README.md has nine ## headings — The one idea, Requirements, Install, Layout, Commands, Running it unattended, Runbook, Two switches both off, Working on reeve — and there is no statement anywhere in the repository about which output is a contract. Meanwhile src/status.mjs exports `spark` and src/dash.mjs:12 imports it to render a sparkline from a 0..1 series, and dash.mjs writes an HTML page; both are surfaces meant to be iterated. builder doctor --json (bin/reeve:1115) emits a bare u
- **Source:** https://clig.dev/ (the human-output quotation) · https://kubernetes.io/docs/reference/kubectl/conventions/ ("For a stable output in a script: Request one of the machine-oriented output forms") · https://clispec.dev/ ("field removal is a breaking change") · https://developer.hashicorp.com/terraform/i

**waiting-is-not-a-failure** — An exit code describes the command's answer, not the system's mood — and the plist trap is one edit away

- **Applies to:** `src/exit.mjs (the rule, stated beside the table); bin/reeve:1696 (tick); S3 routes task list|show|dash; deploy/com.revnix.reeve.plist`
- **Recommendation:** State this rule in src/exit.mjs, beside the table: a read command exits non-zero for a BAND reason (degraded / no / waiting / held), never because the system it read about is unhappy.

  reeve task list      -> 0 if it could read. Tasks in WAITING_CODEX/_NOTICE/_FOUNDER/_GUARDIAN/_QUOTA/_CAPABILITY are DATA, not the command's verdict.
  reeve dash           -> 0 if it could render. Never encodes fleet health in the exit code.
  reeve task show <id> -> 32 (waiting) is legitimate: the operator asked about ONE task and the answer is "not yet".
  reeve run --tick     -> 32 (waiting) when halted. Not 3, and not a failure code.
  reeve builder doctor -> 30 / 31, renumbered from 3 / 1.

And in the envelope, a waiting task always carries its substate and its evidence, derived at read time and never stored, which is already the design:
  "waiting": { "substate": "WAITING_CODEX", "since": "2026-08-28T07:02:11Z", "because": { "table": "phase_event", "rowid": 4417 } }

This is the exit-code expression of the escalation research and is why it is a stated rule rather than a matter of taste: the me
- **Why here:** MEASURED: `reeve run --tick` exits 3 when halted (bin/reeve:1696) — a DELIBERATE operator action rendered as the same number as a degraded doctor (src/doctor.mjs:1044) and a short shadow streak (bin/reeve:849). deploy/com.revnix.reeve.plist:41 sets KeepAlive to bare <true/> with ThrottleInterval 10 (:46), so nothing restarts on the code today — but the plist's own comments show the supervisor layer already reads exit codes (it records launchd's 78 at :10), and the standard tick-job pattern is Ke
- **Source:** https://docs.github.com/en/code-security/reference/code-scanning/codeql/codeql-cli/exit-codes ("The command successfully determined that the answer to your question is 'no'") · measured on gh 2.96.0: `gh pr checks --help` reserves 8 for "Checks pending" as a documented per-command code rather than f


### agent-ops-ux — 6

**headline-oldest-wait** — The digest needs one headline number, and it must be a rendered duration, not raw seconds

- **Applies to:** `S3-E Task 9 — `src/build/dash.mjs` (`dashModel`, `renderDash`); plan lines 1884 (SUPPORTING) and 2060-2125 (the model and renderer)`
- **Recommendation:** Two edits to Task 9, both inside `src/build/dash.mjs`.

(1) Add ONE key, `headline`, and add the literal string `"headline"` to the `SUPPORTING` array at plan line 1884 — currently `["format_version","generated_at","projects","switches","tasks","since"]`. Without that edit the assertion `and nothing else, so the digest cannot grow a sixth question quietly` goes red, which is the correct behaviour and the reason to make the addition deliberate. Task 10's freeze needs no change: it filters `Object.keys(m)` against `QUESTIONS`, so `headline` is invisible to it. Shape, derived from `waiting_on_you` which already exists, so it adds no query:

```js
headline: (() => {
  const w = m_waiting_on_you;                       // the array built two lines above
  if (!w.length) return { oldest_wait_seconds: null, task: null, waiting: null, count: 0 };
  const o = w.reduce((a, b) => (b.for_seconds > a.for_seconds ? b : a));
  return { oldest_wait_seconds: o.for_seconds, task: o.id, waiting: o.waiting, count: w.length };
})(),
```

`renderDash` prints it as the FIRST line, above `alive`:

```
oldest
- **Why here:** MEASURED: `src/dash.mjs:8-10` states reeve's own rule — "a dashboard with six equal numbers has no headline. Clean-merge rate is that number: it read 0% on the system this replaces while every vanity metric looked healthy." The builder digest as planned returns five equal keys with no number above them, and reproduces the failure one directory over. `waiting_on_you` is already ordered first, so the ordering half is done; what is missing is the magnitude. And with one operator who is the bottlene
- **Source:** https://linearb.io/resources/software-engineering-benchmarks-report — 2026 Software Engineering Benchmarks, 8.1M+ PRs / 4,800 teams / 163,820 contributors: agentic-AI PRs sit idle 5.3x longer before reviewer pickup at p75 (1,055 vs 201 minutes). VERIFIED. The finding's "32.7% vs 84.4% accepted" and 

**body-next-is-not-wired-into-announce** — The page body is the bare escalation key: `body().next` exists, is tested, and reaches nothing

- **Applies to:** `S3-E Task 13 — `announce()` in `src/build/announce.mjs` (plan lines 2938-2955); `body()` at plan line 2526; `redact`/`printable` in `src/notify.mjs:55,60``
- **Recommendation:** REFUTE the proposed 9-entry `RESOLUTIONS` table and build nothing new. A per-failure-type `next` ALREADY exists: `body({type, reason, ...}) -> {type, reason, next, ...}` (plan line 3739), with Task 11 asserting `${t} carries a distinct next action` and `the four next actions are four, not one repeated` (plan lines 2418-2420). A second, identity-keyed map would be a second answer to one question, and would also cross founder decision 9, which settles that the type is the axis.

The gap is that it is not mounted. MEASURED at plan line 2945, inside `announce()`: `message: `${f.why}${f.count > 1 ? ` (x${f.count})` : ""}``. `body` is never called on the page path. The founder's phone receives `bt:7:phase:blocked:RESEARCH` and nothing else.

The fix is one call and one seam test.

```js
// announce(), replacing the message literal:
const b = body({ type: f.type ?? "BLOCKED", reason: f.reason ?? null, task: f.task ?? null });
const r = send({
  title: `reeve builder · ${f.why}`,
  message: redact(printable(
    `${f.why}${f.count > 1 ? ` (x${f.count})` : ""}\n` +
    (b.reason ? `${b.reason
- **Why here:** MEASURED: `src/build/hub.sql:712-718` — the escalation table is `(why, count, first_seen_at, last_seen_at, announced_count)` and carries no resolution. The design promises the missing half at §11.7 and the plan builds it as `body().next`, tested four ways — and then `announce()` at plan line 2945 builds its message from `f.why` alone. This is the repository's own "shipped is not mounted" class: the tests prove `body()` works, not that it is wired, and the one surface a paged founder reads at 3am
- **Source:** https://docs.langchain.com/oss/python/langchain/human-in-the-loop — VERIFIED, and the finding's field names are stale: the current shape is `InterruptOnConfig` with `allowed_decisions: list[string]` drawn from `approve | edit | reject | respond`, and responses are typed decision objects with `type` 

**lineage-is-addressable** — `why --at <seq>` is sound only over the append-only tables; `escalation` and `provider_lease` cannot be addressed at a moment and must say so

- **Applies to:** `S3-E Task 4 — `src/build/why.mjs` (`whyModel`, `renderWhy`); `FLAGS` at `bin/reeve:263`; the freeze fixture in Task 6`
- **Recommendation:** Adopt `reeve task why <id> --at <seq>`, with the scope corrected and the proposed byte-identity test replaced, because as written it fails.

ADDRESSABLE, because the rows are append-only and carry their own moments:
- `phase_event` — `WHERE seq <= :at` (`seq` is `INTEGER PRIMARY KEY`, `src/build/hub.sql:134`)
- `hold_reason` — open at T is `at <= :t AND (cleared_at IS NULL OR cleared_at > :t)` (`hub.sql:148-155`)
- `task_drain` — `recorded_at <= :t`, settled iff `settled_at IS NOT NULL AND settled_at <= :t` (`hub.sql:113-127`)

NOT ADDRESSABLE, and this is the part the finding missed:
- `escalation` has NO history. `count` and `announced_count` are updated in place (plan lines 2732, 2738: `UPDATE escalation SET count=?, last_seen_at=?`), so the count as of seq 412 is unrecoverable.
- `provider_lease.status` mutates in place (`queued` → `held`), so the lease's state at seq 412 is unrecoverable.
- `phase_run` is HALF addressable: `started_at <= :t` selects the right ROWS, but `status`, `outcome` and `evidence` are settled in place, so a run that was `live` at seq 412 renders `succeeded
- **Why here:** MEASURED: `src/status.mjs:276-282` — the guardian's `why(db, id, {limit = 12})` is `ORDER BY seq DESC LIMIT 12` and takes no moment; the S3-E `whyModel` selects `seq` (plan line 1046) and exposes no way to pin one. `phase_event.seq` is already an `INTEGER PRIMARY KEY` (`hub.sql:134`), so the stable address exists and nothing surfaces it. A page fires when a task blocks and the founder opens it hours later to a render of NOW — a different justification than the one that paged them. That is the sa
- **Source:** https://github.blog/changelog/2026-03-20-trace-any-copilot-coding-agent-commit-to-its-session-logs/ — VERIFIED verbatim: commits carry an `Agent-Logs-Url` trailer giving "a permanent link from agent-authored commits back to the full session logs, so you can understand why Copilot made a change durin

**statusline-blind-to-hub** — statusline reads only the guardian store, and its no-state early exit means the builder segment must be computed before it

- **Applies to:** ``bin/reeve:855-872` (the shared status/statusline/dash/why case) and `src/status.mjs:258-273` (`statusline`)`
- **Recommendation:** Append one segment to `statusline`, with three corrections to the proposed wiring.

(1) WIRING. MEASURED at `bin/reeve:865-869`: when the guardian's per-repo db is absent, the shared `status/statusline/dash/why` case prints `reeve: no state` and `process.exit(0)` BEFORE `statusline(db, {nwo})` is ever called. A builder segment added inside `src/status.mjs:statusline` is therefore invisible on exactly the machine most likely to have a hub and no guardian state. Compute the hub segment in `bin/reeve` ABOVE that early exit and print it in both branches.

(2) SCOPE — do NOT filter by repo. `statusline` is per-`nwo`; the hub is machine-global by design (`src/paths.mjs:60-67`: "a task spans projects, a lease is global"). Filtering the count to the current repo hides a waiting task whenever the operator's terminal is cd'd elsewhere, which is absence read as success on the one line that is always on screen. Count globally and label it `builder`, not `nextly builder`.

(3) THREE RENDERINGS, and the third is the point:
```
nextly · 2 runs · ⚠ 1 NEEDS YOU (builder 1)     hub read, one waiting o
- **Why here:** MEASURED: `bin/reeve:864` resolves `dbPath` from `stateFor(nwo)` for all four commands, and `git grep -n hubPathFor -- bin/reeve` returns lines 83, 124, 597, 639-643, 749-757, 941, 1170-1256, 1304-1458, 1492 — the backup, restore, export-events, builder and build routes only. Of the nine builder escalation identities, the three on the closed page list reach a phone and the other six reach `reeve task dash` and nothing else — a command the operator must remember to run. `src/status.mjs:270-271` a
- **Source:** Comparables all ship an ambient or push signal rather than a pull-only command: Cursor DMs completion into Slack (https://cursor.com/docs/integrations/slack), Amp rings the terminal bell on finish or block (https://ampcode.com/manual), Copilot keeps a persistent agents page (https://docs.github.com/

**question-four-has-no-watermark** — Question four requires a unix timestamp nobody has, so `since_you_looked` structurally never renders

- **Applies to:** `S3-E Task 9 — `dashModel`/`renderDash` in `src/build/dash.mjs` (plan lines 2073-2078, 2117-2121) and the `task dash` route (plan lines 2131-2141); `src/paths.mjs``
- **Recommendation:** A watermark FILE, not a hub row, so PR-E1/PR-E2's hub-write invariants are untouched.

Put the path in `src/paths.mjs` beside `hubPathFor`, not inline in `dash.mjs` — paths.mjs is the single answer to "where does X live", and a path computed in a renderer is a second answer:

```js
/** The dash watermark: what the operator has already seen. Not a store. */
export function dashSeenPathFor(home) {
  return join(home, "state", "builder-dash-seen.json");
}
```

Content: `{ "format_version": 1, "seen_at": <unix>, "seen_seq": <max phase_event.seq at the time> }`.

Behaviour:
(a) `task dash` with no `--since` defaults `since` to `seen_at` from the file;
(b) the default read NEVER writes — only `task dash --seen` advances the watermark, so a glance you did not finish does not silently consume the window (GitHub's explicit mark-as-read, not Slack's auto-advance, is the right default for one operator who is interrupted);
(c) with no file, the section renders `since you looked  UNKNOWN — no watermark; run \`reeve task dash --seen\` to start the window` and NOT nothing, which is the UNKNOWN rule
- **Why here:** MEASURED in the plan itself: `dashModel(db, { ..., since = null })`; `since_you_looked: since == null ? [] : db.prepare(...)`; `renderDash` emits that section only under `if (m.since != null)`; and the CLI reads it from `--since <unix>`. Nobody knows the unix timestamp of their last glance, so `--since` is never passed and one of the five questions never renders at all. That is the same shape as `src/status.mjs:171-174`, where a `status='pending'` query could only ever return nothing: "a band th
- **Source:** none — this is reasoning from the plan's own code. The shipped pattern it generalises is a durable read boundary the system owns rather than a window the user types: Amp resumes threads server-side (https://ampcode.com/manual), Copilot's agents page persists sessions across visits (https://docs.gith

**page-rate-cannot-be-measured** — Nothing records when a page went out, so decision 6's review point arrives with no data — and the instrument needs a three-valued disposition and a NON_REPLAYED_KINDS entry

- **Applies to:** `S3-E Task 13 — `announce()` in `src/build/announce.mjs`; `NON_REPLAYED_KINDS` in `src/build/replay.mjs:46`; `hubFindings` in `src/doctor.mjs` (Task 16)`
- **Recommendation:** No column, no migration — `hub_event(seq, at, kind, task, payload)` already exists (`src/build/hub.sql:161-169`) with a `hub_event_kind` index. Four corrections to the proposal, three of them load-bearing.

(1) THE DISPOSITION IS THREE-VALUED, NOT A BOOLEAN. `announce()` already returns `{ paged, digested, declined, cleared }` (plan line 3739) — and `declined` is a page that WAS attempted and failed to deliver. A `paged: true|false` boolean cannot represent it, so a dead ntfy channel would be recorded as "digested", i.e. as a deliberate policy choice. Record:

```js
hubEvent(db, { kind: "escalation.announced", task: f.task ?? null,
  payload: { why: f.why, disposition: "paged" | "digested" | "declined",
             channels: ["ntfy", "desktop"], ref: "<delivery ref>" | null,
             declined_why: "<reason>" | null } });
```

(2) THE CHANNEL IS `ntfy` AND `desktop`, NOT `pushover`. `src/notify.mjs:132,152` implements exactly two channels, and `notify()` returns `channels: [{name, ok, why}]`; Task 14 adds `ref`. Take the names from `r.channels`, never hardcode one.

(3) `escalati
- **Why here:** Founder decision 6 is right — "limits are measured before they are chosen" — and it names a review point: revisit after S3's first week with the measured rate in hand. But `src/build/hub.sql:712-718` stores only `announced_count` and `last_seen_at` on the escalation row, which says an identity was announced four times and never WHEN. The rate the founder committed to reviewing cannot be reconstructed from what the hub stores, so week one arrives with a decision to make and only memory to make it
- **Source:** https://sre.google/sre-book/monitoring-distributed-systems/ — "Every page should be actionable"; "Every page response should require intelligence. If a page merely merits a robotic response, it shouldn't be a page"; "I can only react with a sense of urgency a few times a day before I become fatigued


### error-taxonomy — 7

**kinds-table** — Keep the kinds table, but scope it: it is R8's missing table, not a new idea — and it must CONSUME reeve's existing `retryable`, not declare a second one

- **Applies to:** `new `src/fail.mjs`; `bin/reeve` `die()` at :60 and 28 `process.exit(1)` sites; consumers `src/outbox/effects.mjs:171`, `src/build/hubdb.mjs:250``
- **Recommendation:** Adopt the table as written, with four corrections that came out of the source.

(1) FRAME IT AS R8, NOT AS NEW. `MASTER-PLAN.md:4594` (row R8) already says "Errors get a stable snake_case `kind`, an exit code, and a `retryable` bit", assigned to T3/T13/T15, and `S3-AUDIT-REPORTS.md` §A2 already specifies `die({kind, exit, retryable, what, observed, help, docs})` with example kinds (`no_state_db`, `no_profile`, `unknown_flag`, `lease_held`, `credential_denied`). The contribution here is the CLOSED TABLE those two lack. Land it as the table for A2/R8 so the plan does not carry two competing shapes; A2's field names (`what`/`observed`/`help`) and this finding's (`observed`/`recover`/`details`) must be reconciled to one set before T3.

(2) DO NOT DECLARE A SECOND `retryable`. reeve already has one, as a first-class field of the outbox effect protocol: `src/outbox/effects.mjs:9` ("Every handler takes `(args, deps)` and returns `{ok, result?, error?, retryable?}`"), classified by `retryableFrom(err)` at `effects.mjs:171` and consumed at `src/db/ops.mjs:560` (`const dead = !retryable || ...
- **Why here:** MEASURED at HEAD: `bin/reeve` has 19 `die()` calls and 28 bare `process.exit(1)` sites — 47 conditions on one code with no identity. But the finding's stated evidence for this is FALSE: it claims "the only integer literals passed to `process.exit` anywhere in `bin/reeve` or `src/daemon.mjs` are 0 and 1", and `bin/reeve:849`, `:1127` and `:1696` all pass 3 (its own sibling finding #9 says so). The real, checkable evidence is the 47 exit-1 conditions and the two opposite `retryable` defaults, not 
- **Source:** https://google.aip.dev/193 (ErrorInfo `reason` — "must use the same (reason, domain) pair for the same error, and must not use the same (reason, domain) pair for logically different errors"); https://smithy.io/2.0/spec/behavior-traits.html (`@retryable`); plus reading of /Users/mobeen/Work/Products/

**exit-code-classes** — Eight codes, but NOT these eight — `2` is already claimed by an outcome (`init` returns 2 for "changed"), and re-pointing 3 breaks five test assertions, not one

- **Applies to:** `src/doctor.mjs:1044; bin/reeve:849, :1127, :1696, :1703, :426; src/init.mjs:322,326; src/supervisor.mjs:97`
- **Recommendation:** Adopt the split (errors vs outcomes, disjoint code sets, UNKNOWN gets its own code) and REJECT the specific assignment. Two measurements move it.

REFUTED — `2` is not free. `src/init.mjs:322` returns `{code: 2, ..."-> reeve init --write to apply"}` and `:326` returns `{code: 2, ..."wrote <path>"}`; `bin/reeve:801` exits with it; `usage()` at `bin/reeve:1729` documents `init --write` as `(exit 0 no-op · 2 changed · 1 needs an answer)` and `README.md:89` documents the doctor band. `2` is therefore ALREADY an outcome code with the `diff` meaning, and assigning it to usage errors violates this finding's own disjointness rule. Do not move `init` to satisfy an unfrozen third-party draft — generalise it instead: `2` means CHANGED (a difference exists or was written), which `task file --dry-run` (`MASTER-PLAN.md:188`: "prints … the conflicts it would hit … and writes nothing") will reuse immediately.

THE TABLE THAT SURVIVES:

  OUTCOMES — the command worked; the answer is not "yes". No error envelope.
    2  changed    a difference exists or was written        (init today)
    3  degraded 
- **Why here:** MEASURED: `src/doctor.mjs:1044` reads `checks.filter(c => c.level === DEGRADED || c.level === UNKNOWN)` and returns 3 for both — reeve's dominant defect class encoded in its own exit code. And `render()` at `doctor.mjs:1049-1051` ALREADY iterates `[BROKEN, DEGRADED, UNKNOWN, OK]` as four separate bands, so the human output already distinguishes them and only the machine-readable answer collapses them. The fix is one line.
- **Source:** https://clispec.dev/ (v0.3 candidate — outcomes, disjointness); https://www.gnu.org/software/bash/manual/html_node/Exit-Status.html (126/127, 128+N reserved); reading of /Users/mobeen/Work/Products/reeve-wt/c4/src/init.mjs:322,326, bin/reeve:1729, README.md:89, src/supervisor.mjs:97, test/cli-routin

**determination-triple** — Adopt the triple, but do NOT ban absence — `verdict.mjs:245` uses absence for a fourth meaning ("this question was never asked") and the comment above it says why

- **Applies to:** `src/verdict.mjs:163, :182, :201, :221, :245-248; src/build/hubaccess.mjs:83-210; src/doctor.mjs checks; `reeve task why``
- **Recommendation:** Adopt `{status: "yes"|"no"|"unknown", reason, message, at, from}` with the two enforcement rules — and replace the "reeve should never emit the absence" rule, which contradicts working code.

REFUTED, with the code that refutes it: `src/verdict.mjs:245` guards the whole hold clause with `if (i.hold) { … }`, and `:241-244` states why: "Omitted entirely when the caller passes nothing, rather than defaulting to UNKNOWN: a guardian built before the hub existed has no opinion about holds, and an UNKNOWN clause would drag every verdict it renders to UNKNOWN for a question it was never asked." Absence there means NOT-APPLICABLE, a fourth value, and mandating a triple everywhere would make every pre-hub guardian's verdict UNKNOWN and stop every merge.

THE RULE THAT SURVIVES, and it still deletes the whole defect class: **a determination is either completely absent — the question was not asked, and the clause is not emitted — or a complete triple. Never a partial one.** No field is ever omitted from a triple that exists; `unknown` is a value, not a missing key; serialisers must not drop it. 
- **Why here:** MEASURED: `src/build/hubaccess.mjs` ALREADY returns a three-valued determination and its header at `:35-40` says so in capitals — "THREE ANSWERS, NOT TWO, and the earlier version had two" — `{hub, why: null}` = yes, `{hub: null, why: null}` = absent-and-ordinary, `{hub: null, why: "…"}` = unreadable. It encodes the third value POSITIONALLY, as two nulls versus one. So this recommendation is naming a model reeve already reasoned its way to and paid for, not introducing one; that is the argument t
- **Source:** https://raw.githubusercontent.com/kubernetes/community/master/contributors/devel/sig-architecture/api-conventions.md — "Condition `status` values may be `True`, `False`, or `Unknown`"; `reason` "contains a programmatic identifier … This field may not be empty"; "The absence of a condition should be 

**message-shape** — Adopt the four-part shape — and settle which of reeve's TWO live recover-line conventions wins, because `->` currently carries both rustc's `help` and its `note`

- **Applies to:** `bin/reeve all failure paths; src/build/hubdb.mjs:391-416 (exemplar); src/backup.mjs:1078,1121,1294; src/doctor.mjs:314,358,878,912; src/init.mjs:322; bin/reeve:424-425,551`
- **Recommendation:** Adopt the shape and the rustc rules verbatim — they are confirmed at source: "The text should be matter of fact and avoid capitalization and periods, unless multiple sentences are needed"; "When code or an identifier must appear in a message or label, it should be surrounded with backticks"; "The word 'illegal' is illegal. Prefer 'invalid'"; "The error or warning portion should not suggest how to fix the problem, only the 'help' sub-diagnostic should"; "general and able to stand on its own, so that it can make sense even in isolation". The last one is load-bearing here for a reason rustc does not have: `src/notify.mjs:71` sends escalation text to a phone with no surrounding terminal, capped at 700 chars and redacted.

THE CONCRETE DECISION THE FINDING MISSES. reeve has two live recover-line prefixes and they are not interchangeable:
  `  recover  <command>` — 7 message sites: `src/build/hubdb.mjs:394,398,411,415`, `src/backup.mjs:1078,1121,1294`
  `-> <command or sentence>` — 16 sites: `src/doctor.mjs:314,358,878,912`, `src/init.mjs:322`, `bin/reeve:424,425,551`
And `->` is OVERLOADE
- **Why here:** MEASURED contrast inside one binary: `hubdb.mjs:391-416` spends 25 lines separating two causes of SQLITE_FULL, names the wrong fix, and tells the operator not to take it — while `bin/reeve:868` says `reeve <cmd>: no state database at <path>` and stops, with no kind, no recover line, and no statement of whether that is even a problem. Both are failure text in the same CLI, and only one is usable at 2am. The two-prefix split is what stops the good half being rewritten into the bad half by a later 
- **Source:** https://raw.githubusercontent.com/rust-lang/rustc-dev-guide/master/src/diagnostics.md (all five rules quoted above verified verbatim); https://www.anthropic.com/engineering/writing-tools-for-agents; reading of /Users/mobeen/Work/Products/reeve-wt/c4/src/build/hubdb.mjs:391-416, src/backup.mjs:1078,1

**refusal-rationale** — ADOPT, narrowed to the one wire that is actually missing: refusals are ALREADY durable in `phase_event` — nothing reads them back into the worker's next turn

- **Applies to:** `src/build/phases.mjs:81, :107-133, :637-654; src/build/transition.mjs:668, :756-768; src/prompts.mjs (redispatch); `reeve task why``
- **Recommendation:** Adopt code 6 = refused with a mandatory rationale, and the four visibly-different shapes (FAILED 1 / UNCERTAIN 4 / REFUSED 6 / BLOCKED 5, never collapsed to "something went wrong"). Narrow the build to what is missing, because most of it exists.

ALREADY BUILT: `src/build/phases.mjs:81` — `refuse(refusal, extra) => ({ok:false, refusal, ...extra})`, with the comment that a refusal may still carry state the caller must persist. `src/build/transition.mjs:756-765` — `refuseDurably(refusal)` writes `{from: expectedPhase, evidence: evidence?.kind ?? null, refusal}` into a durable event and returns `{applied:false, reason:"refused", refusal}`, with the comment at `:760`: "a refusal with no record is indistinguishable from a report that was never made". `transition.mjs:668` does the same for a thrown refusal. `phases.mjs:107-111` (`holdReasonFor`) THROWS on an unknown hold reason and `:131-133` (`holdReasonRefusal`) refuses `blocked_other` with an empty escalation identity, reasoned as "a hold with no identity reaches no founder" — and specifically "NONEMPTY, not merely non-null … A null che
- **Why here:** MEASURED: reeve already refuses a mis-attributed report, a SIZING report with no depth, an unknown hold reason and an empty `blocked_other` escalation — with a written reason each time, already persisted durably by `refuseDurably`. The rationale is on disk. The founder is the bottleneck by the brief's own framing, and every one of those written reasons that reaches the worker's next turn instead of the operator is an interruption removed for the cost of one SELECT. The source's own claim is that
- **Source:** https://alignment.openai.com/auto-review/ — verified verbatim: "A rejection does not merely say no. It gives Codex a rationale and enough signal to continue safely without asking the user for approval or guidance. In our internal deployment, Codex continues after a denial and successfully finds an a

**escalation-identity** — ADOPT the `(kind, subject)` decomposition — but as ADDED COLUMNS plus a unique index. Changing the PRIMARY KEY throws at `open()` on the founder's live guardian

- **Applies to:** `src/db/schema.sql:460 (guardian) and src/build/hub.sql:712 (hub); src/daemon.mjs 47 `raise()` sites and `announceable` at :3235-3290; src/db/ops.mjs:14-51 (`ADDED_COLUMNS`), :66-102 (`RESHAPED`)`
- **Recommendation:** The diagnosis is confirmed and the remedy is not implementable as written.

CONFIRMED: 47 `raise()` sites in `src/daemon.mjs`. Only five identities are stable (`guardian:hub:unreadable` at :1328/:1371/:1404, `guardian:containment:open` :2202, `guardian:containment:changed` :2643, `guardian:checkout:config-tampered` :2853, `guardian:worker:credential-in-diff` :2993 — the finding missed the fifth). `:1223` interpolates `${err.message}` into the primary key, `:1177` interpolates `${auth.why}`, `:2932` interpolates `${landed.why}`, and eighteen sites interpolate `#${pr}`. Both tables are `why TEXT PRIMARY KEY` STRICT.

REFUTED — the PK change. SQLite cannot alter a primary key; the table must be rebuilt. The guardian's per-repo store has exactly one rebuild mechanism, `RESHAPED` at `src/db/ops.mjs:66-102`, and it **throws at `open()` when the table has rows** — "Refusing to rebuild it at open(): export them, drop the table, and reopen. Silently copying between shapes loses whatever the new key was added to distinguish." The escalation table holds the STANDING set and is durable precisely
- **Why here:** MEASURED: the primary key of the escalation table is a free-text string into which `daemon.mjs:1223` interpolates `${err.message}`. One cause with two error strings is two standing rows, `announced_count` never converges, and the identity space is unbounded rather than the 23 the design counts — which is precisely why `src/notify.mjs` has to `redact()` and cap the identity at 700 chars before it reaches a phone. The U-shaped escalation result cannot be acted on at all until a cause can be named;
- **Source:** https://www.rfc-editor.org/rfc/rfc9457.html ("Consumers MUST use the 'type' URI … as the problem type's primary identifier"; `title` "SHOULD NOT change from occurrence to occurrence"; "Consumers SHOULD NOT parse the 'detail' member"); https://google.aip.dev/193; reading of /Users/mobeen/Work/Product

**json-envelope** — ADOPT the truncation fix outright — but `builder doctor` ALREADY honours `--json` on four failure paths, deliberately, and the stderr-envelope rule would regress it

- **Applies to:** `bin/reeve:548, :894, :946, :965, :981, :992, :1115 (exit-after-write); the accept-and-ignore routes `why` :884, `dash` :873, `statusline` :871, `shadow` :849, `canary` :932, `build status``
- **Recommendation:** Two halves, and only one of them is as filed.

(b) DO NOT TRUNCATE — ADOPT UNCHANGED, HIGHEST VALUE. Confirmed against the Node docs verbatim: "Calling `process.exit()` will force the process to exit as quickly as possible even if there are still asynchronous operations pending that have not yet completed fully, including I/O operations to `process.stdout` and `process.stderr`", with an explicit worked example labelled "an example of what *not* to do" and the recommendation to set `process.exitCode` instead. reeve does the anti-pattern at `bin/reeve:548, :894, :946, :965, :981, :992, :1115` — every one of them `console.log(JSON.stringify(...))` immediately followed by `process.exit(n)`. Replace with `process.exitCode = n; return;` throughout, and extend it to the non-JSON exits in the same switch (`:553, :603, :617, :621, :780, :801, :849, :932, :1127, :1696, :1703`) so the idiom is uniform rather than split by output mode.

(a) THE ENVELOPE — REFUTED AS FILED. "Zero honour it on the failure path" is false: `bin/reeve:946, :965, :981, :992` all emit `flag("json") ? JSON.stringify(fin
- **Why here:** MEASURED: `--json` is a GLOBAL flag (`bin/reeve:284`, not `:226` as R7's now-stale anchor says) accepted by every command and honoured by three. Truncated JSON is the worst failure this system can produce, because a valid prefix parses and a consumer reads a short answer as a complete one — absence read as success, in the one place the founder decision (tracker §4 decision 7) exists to prevent it. That half costs seven line edits and needs no design at all.
- **Source:** https://nodejs.org/api/process.html#processexitcode (quoted verbatim above); https://clispec.dev/ (envelope as last line of stderr; "An outcome exit writes no error envelope; stdout carries the result"; "Data goes to stdout. Messages, progress indicators, and diagnostics go to stderr"); reading of /


### attention — 7

**clear-never-reaches-the-phone** — Resolution is announced on the same channel as the problem, or silence means both "fixed" and "reeve died"

- **Applies to:** `src/daemon.mjs:1264-1292 (code, today); src/build/announce.mjs Task 13 Step 3 (PLAN edit — the file does not exist yet)`
- **Recommendation:** TWO HALVES, DIFFERENT KINDS OF CHANGE.

GUARDIAN (code, today). After the existing push block at src/daemon.mjs:1275-1288:
```js
// Resolution goes out on the SAME channel as the problem. An operator told only
// about problems reads silence as either "resolved" or "reeve died".
if (cleared.length) {
  const done = { title: `reeve · ${nwo} · cleared`,
                 message: cleared.map(w => redact(printable(w))).join("\n"),
                 priority: "low", tags: "white_check_mark" };
  const r = (ctx.notify ?? notify)({ profile, alert: done });
  log(logPath, r.ok ? `pushed ${cleared.length} clearance(s)` : `did NOT push clearances: ${r.why}`);
}
```
`redact` and `printable` are already exported from notify.mjs and MUST be applied — `buildAlert` does it, and a second sender that skips it is a redaction bypass on the one path where output crosses the machine boundary.

BUILDER (edit Task 13 Step 3 before it is written). After the paging loop, filtered through the SAME `pages` predicate, not a new list:
```js
const resolved = cleared.filter(pages);
if (resolved.length) {
  const r 
- **Why here:** `announceable`'s own docstring at src/daemon.mjs:3230 states the requirement verbatim — "Clearing is announced too: an operator who is only ever told about problems cannot distinguish 'resolved' from 'reeve stopped looking'" — and the code 1,960 lines above it sends only `fresh`. MEASURED: `buildAlert` has exactly one call site, src/daemon.mjs:1275, taking `fresh`; `cleared` reaches only `log(logPath, "CLEARED: …")` at :1274 and the return value at :1286. All three paged identities STOP WORK, so
- **Source:** https://prometheus.io/docs/alerting/latest/configuration/ (send_resolved defaults, verified: pagerduty/pushover/webhook/opsgenie/victorops = true; email/slack/wechat = false); https://docs.ntfy.sh/publish/ (priority 2 = "No vibration or sound. Notification will not visibly show up until notification

**ntfy-dead-mans-switch** — The dead man's switch exists on the channel reeve already uses — but it is a new task, and postViaCurl cannot express it

- **Applies to:** `A NEW plan/task (not an S3-E edit): src/notify.mjs (a `heartbeat` export beside `notify`); src/daemon.mjs:3222 beside `noteTick`; bin/reeve:1554 inside buildTick's try; deploy/com.revnix.reeve.plist`
- **Recommendation:** ADOPT the mechanism; six corrections, each measured.

(a) SCOPE. Do NOT edit S3-E. Its spec-coverage line (plans/2026-08-27-s3e-operator-surface.md:3735) files R20 out of that plan explicitly and with reasons. S3-DESIGN-BRIEF.md:768 files R20 as "S3 or S4", so this is a new task in its own plan — not a reopening.

(b) `postViaCurl` CANNOT express it. MEASURED at src/notify.mjs:108-118: it always POSTs `${cfg.url}/${cfg.topic}` with `-d body` and no method flag. The switch needs a path SUFFIX and a DELETE. Add a sibling export, never a parameter on `notify`:
`export function heartbeat({ profile, id, delay = "15m", title, message, cancel = false, exec = execFileSync, readCredential = null })` building `${url}/${topic}/${id}`, header `In: ${delay}`, and `-X DELETE` when `cancel`.

(c) RE-ARM PLACEMENT, measured. Guardian: beside `noteTick(db)` at src/daemon.mjs:3222 — the complete path only; the two degraded exits return at :1592 and :1621, ABOVE it. Builder: INSIDE the `try`, after `const tick = await buildTick(...)` at bin/reeve:1554, never after the `catch` at :1568 — that catch's ow
- **Why here:** deploy/com.revnix.reeve.plist sets `KeepAlive true`, which restarts a process that EXITS; launchd has no WatchdogSec, so a wedged daemon is never restarted and never reported. Every liveness surface reeve has is self-reported from inside the store the daemon writes: `daemonLiveness` reads MAX(at) FROM event WHERE op='daemon.tick', Task 9's `alive` reads a `singleton_lease` row, and src/dash.mjs is regenerated each tick so a stale file is silent — all three read BY an operator who is already look
- **Source:** https://docs.ntfy.sh/publish/#scheduled-delivery — verified: ships a dead man's switch example, `curl -H "In: 5m" -d "…" ntfy.sh/mytopic/heartbeat-check` re-published each 60s; "publishing a new message with the same sequence ID … the original scheduled message is deleted from the server and replace

**the-23-minute-figure-is-hollow** — The statistic defending the page list is an interview remark hyperlinked to a paper that reports the opposite

- **Applies to:** `tasks/reeve-tasks/S3-DESIGN-BRIEF.md:991; S3-AUDIT-REPORTS.md:2581, :2706, :4834; and the Task 13 commit body when it is written`
- **Recommendation:** MEASURED, complete enumeration: `grep -rn "23-minute\|23 minute\|23 min" tasks/ docs/ src/` returns FOUR lines, all under tasks/ — S3-DESIGN-BRIEF.md:991, S3-AUDIT-REPORTS.md:2581, :2706, :4834. Line :2581 is the worst instance: it attributes "23 minutes 15 seconds" to Mark, Gudith & Klocke CHI 2008 with a direct link to the PDF. The paper does not contain the number and reports interrupted tasks completing FASTER (20.31 / 20.60 min vs 22.77 min uninterrupted) at higher stress, frustration, time pressure and effort. The figure traces to a 2006 interview, not a publication.

EXACT EDITS:
- :991 and :4834 — replace "a measured 23-minute recovery cost per interruption" with "an operator for whom only 10% of interrupted programming sessions resume work within one minute (Parnin & Rugaber 2011, 10,000 recorded sessions, 86 programmers)".
- :2581 — delete the "23 minutes 15 seconds" sentence. KEEP the following clause, which is correctly attributed and says the useful thing: interrupted work completes ~7% faster at measurably higher workload, stress and frustration.
- :2706 — replace "23 m
- **Why here:** reeve's standing rule is that inherited notes carry no evidence and repetition is not corroboration. The page-list decision is CORRECT and worth defending, and it is currently defended by the single most-debunked productivity statistic in circulation, marked "measured" and — at S3-AUDIT-REPORTS.md:2581 — hyperlinked directly to a paper that says something else. A later author who checks the one load-bearing citation finds it hollow and concludes the whole list was arbitrary.
- **Source:** https://blog.oberien.de/2023/11/05/23-minutes-15-seconds.html (provenance trace); https://ics.uci.edu/~gmark/chi08-mark.pdf (Mark, Gudith & Klocke CHI 2008 — reports 20.31 and 20.60 min interrupted vs 22.77 min uninterrupted, and never states 23:15); https://link.springer.com/article/10.1007/s11219-

**page-inhibition-rules** — Two of three paged identities mean nothing can dispatch, so the third pages N times for a consequence already on the phone

- **Applies to:** `src/build/announce.mjs `announce` (S3-E Task 13 Step 3, PLAN edit)`
- **Recommendation:** Add to src/build/announce.mjs:
```js
// A consequence of a cause already paged is not a second interruption. It keeps
// its durable row and reaches the digest; it does not reach a phone. Neither
// source can ever match the target regex, so nothing here inhibits itself.
const BLOCKED = /^bt:[A-Za-z0-9]+:phase:blocked:[A-Z][A-Z_]*$/;
const INHIBITS = Object.freeze([
  Object.freeze({ source: "builder:sandbox:canary-failed", target: k => BLOCKED.test(k) }),
  Object.freeze({ source: "builder:backup:failed",        target: k => BLOCKED.test(k) }),
]);
export const inhibited = (key, standing) =>
  INHIBITS.some(r => r.target(key) && standing.has(r.source));
```
In `announce`, read `standing` AFTER `builderAnnounceable` has run, and from the WHOLE escalation table — not from `fresh`:
```js
const standing = new Set(db.prepare("SELECT why FROM escalation").all().map(r => r.why));
…
if (!pages(f.why) || inhibited(f.why, standing)) { digested.push(f); continue; }
```
Reading the whole table is what makes a cause raised in the SAME tick inhibit its consequences from tick one. Reading `fresh` 
- **Why here:** The guardian half of this codebase ALREADY performs this reduction and says why: `needsYou` at src/status.mjs:182-199, comment at :185 — "A shared cause is one row, not N. Four PRs on a red base is one problem." Task 13's `announce` has no equivalent, and the builder is the half that will run many tasks. This is the codebase disagreeing with itself across two processes. `bt:<id>:phase:blocked:<phase>` is per task AND per phase by design, so one canary failure becomes one page per blocked task, e
- **Source:** https://prometheus.io/docs/alerting/latest/configuration/ — inhibit_rules; verified: "an alert that matches both the target and source side of a rule cannot be inhibited by alerts for which the same is true (including itself)". https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/ — T

**waiting-on-you-ordering** — An ordering the plan claims in prose and never writes — and the weight it would use is in the wrong database

- **Applies to:** `src/build/dash.mjs `dashModel.waiting_on_you` (S3-E Task 9 Step 3, PLAN edit); `reeve task dash --json``
- **Recommendation:** MEASURED, both halves.

DEFECT 1 — the ordering is claimed and absent. plans/2026-08-27-s3e-operator-surface.md:3735 states "'the single next action' is carried … as `waiting_on_you`'s ordering by `for_seconds` (Task 9)". Task 9's `dashModel` (plan :2050-2060) is `tasks.filter(…).map(…)` with NO `.sort()` at all; it inherits `taskList`'s order.

DEFECT 2 / REFUTED — the proposed weight is not derivable. Deriving `w_j` from `edge` (BLOCKS/DEPENDS_ON) and the `v_blocked` view does not work: MEASURED, both live in src/db/schema.sql (`edge` at :43, `v_blocked` at :471) — the GUARDIAN's store. src/build/hub.sql has no dependency graph and no `edge` table, and Task 12 makes the separation structural (its measurement records the guest handle throwing on the cross-store read). `dashModel` opens the hub. Blast radius is not available here.

USE THE WEIGHT THAT ALREADY EXISTS. `task.priority`, src/build/hub.sql:33 — `TEXT NOT NULL DEFAULT 'p2' CHECK (priority IN ('p1','p2'))` — founder-declared at filing, wired by S3-B's `--priority`, and adding NO column, so tracker decision 9 holds and reeve
- **Why here:** `waiting_on_you` is the plan's own stated most-valuable line, and Task 9's "On the broken implementation" note already names the failure mode: an operator who scans a list twice and finds nothing of theirs stops scanning it. An unordered list of pending decisions has exactly that property past about five rows — the operator must read all of it to find the one that matters, every time.
- **Source:** https://statmath.wu.ac.at/~boehm/book/chapter2.pdf (Smith's rule: non-increasing w/p is optimal for 1||Sum w_j C_j, by adjacent pairwise interchange); the cmu rule for weighted holding cost. Measured: plan :3735 vs plan :2050-2060; src/build/hub.sql:33; src/db/schema.sql:43 and :471.

**digest-must-be-pushed** — A digest that must be pulled is a dashboard with a different name — and the frequency is a measured point

- **Applies to:** `a new `reeve digest --send`; src/build/dash.mjs `renderDash` section order (S3-E Task 9); deploy/ (a schedule binding per platform)`
- **Recommendation:** BUILD `reeve digest --send` as a plain command, NOT a hook in the tick. Two reasons: a wedged daemon must not be able to silently stop the digest (the dead man's switch is what reports that), and reeve must run macOS, Windows and Ubuntu — so the deliverable is a command any scheduler calls, with launchd `StartCalendarInterval` as one binding, systemd timers and Task Scheduler as the others. deploy/ today holds exactly one plist and zero timers.

FREQUENCY: three times a day, on the founder's clock. Fitz et al. found the three-times-daily batch reported feeling more attentive, more productive, in better mood and more in control of their phones than as-usual delivery, and that switching notifications OFF produced MORE anxiety and FoMO than either. Zero is worse than some. This is a measured point, not a free parameter. (I could not verify the "hourly is indistinguishable from control" sub-claim; do not write it down.)

WATERMARK: `since_you_looked` needs a stored "last digest at" and none exists — `--since` is a caller-supplied number. Persist it as a `hub_event` row, `kind='digest.sen
- **Why here:** `reeve task dash [--json] [--since]` is a PULL surface: the founder must remember to run it. Six of the nine S3 identities route to dash-and-digest, including every `phase:failed`, `infeasible`, `depth:post-approval`, `lease:conflict`, `lease:starved` and `cancel:draining`. If the digest is never delivered, that routing is indistinguishable from dropping them — which converts the page-list decision from "split escalation from notification" into "stop telling the operator about six of nine things
- **Source:** https://www.sciencedirect.com/science/article/abs/pii/S0747563219302596 (Fitz, Kushlev, Jagannathan, Lewis, Paliwal & Ariely, Computers in Human Behavior 2019; n=237 randomised field experiment); https://docs.ntfy.sh/publish/ (priority semantics); src/dash.mjs header for the ordering rule

**page-budget-as-a-doctor-check** — The refusal to set a budget is right; the gap is that nothing records a page happened at all

- **Applies to:** `src/build/announce.mjs `announce` (one INSERT, Task 13 Step 3); src/doctor.mjs `hubFindings` + the bin/reeve `builder` route (Task 16)`
- **Recommendation:** KEEP the refusal to set a budget: a budget that DROPS pages is fail-quiet, which reeve forbids. The SRE ceiling of 2 incidents per 12-hour shift is for a full-time SRE on a rotation; reeve's operator is one founder with no rotation, so 4 pages/day is an UPPER BOUND never to approach, not a target.

BLOCKER — the recommendation as posed cannot be implemented. It proposes `SELECT SUM(json_extract(payload,'$.count')) FROM event WHERE op='notify.sent'`. MEASURED: `event` exists ONLY in src/db/schema.sql:12 — the GUARDIAN's store. src/build/hub.sql has `hub_event` and `escalation` but no `event`; `builder doctor` reads the hub; Task 12's measurement records the two stores as structurally unreadable to each other ("guardian store has escalation: true | phase_run: false | hub_event: false"). Worse: Task 13's `announce` records no send ANYWHERE — it returns `{paged, digested, declined}` and `escalation` (hub.sql:712) has no `paged_at`. The check would read the wrong store and report zero.

PRECONDITION — one INSERT in Task 13 Step 3, per outcome:
```js
db.prepare("INSERT INTO hub_event(at,ki
- **Why here:** The whole page-list decision is explicitly conditional — "Revisit after S3's first week with the measured rate in hand" — and nothing in the plan computes that rate or even records that a page happened. The revisit will be a memory exercise, which is the shape reeve's own ledger calls "make the rule a step".
- **Source:** https://sre.google/sre-book/being-on-call/ — verified verbatim: "the maximum number of incidents per day is 2 per 12-hour on-call shift"; "dealing with the tasks involved in an on-call incident … takes 6 hours"; "at least 50% of SRE time into engineering: of the remainder, no more than 25% can be sp


### evidence-ux — 7

**floors-can-never-render** — `why`'s floors section reads an op that no source file writes, a table that never receives it, and a payload with no `floors` key

- **Applies to:** ``reeve task why` — `src/build/why.mjs` (S3-E PR-E1 Task 4); `persistDepth` at `src/build/transition.mjs:693-697`; `applyFloors` (S3-D PR-D1 Task 2, not yet built); `TABLE_OWNERS.hub_event` at `src/build/tables.mjs:24``
- **Recommendation:** Four changes, and the first lands in S3-D, not S3-E. (1) In `src/build/transition.mjs`, widen `persistDepth(db, taskId, depth, kind)` to `persistDepth(db, taskId, depth, kind, extra = {})` and build the payload as `{...row, ...extra}` where `row` is the existing `SELECT id, depth, generation, updated_at FROM task WHERE id = ?`. S3-D Task 3's two call sites (`transition.mjs:832, 842, 1044`) pass `{proposed, floors}` from `applyFloors`'s return `{depth, est_slices, floors, proposed}`. (2) In `whyModel`, read the RIGHT table with the RIGHT names: `SELECT seq, at, kind, payload FROM hub_event WHERE task=? AND kind IN ('sizing.recorded','sizing.overridden') ORDER BY seq DESC LIMIT 1`, then keep it only if `JSON.parse(payload).generation === task.generation`. There is no op `sizing.decided`. (3) Render three answers: `floors:["risk-territory","package-span"]` → `standard  floored from trivial by: risk-territory, package-span  (hub_event #2201)`; `floors:[]` with `proposed` present → `trivial   no floor fired — the classifier's own choice, hub_event #2201`; row absent / payload unparseable 
- **Why here:** MEASURED: `git grep -n "sizing.decided"` returns hits in exactly one file, `tasks/reeve-tasks/plans/2026-08-27-s3e-operator-surface.md` (lines 1063, 1791, 1802, 2270), and in zero source files. Positive control: `git grep -n "sizing.recorded"` finds `src/build/transition.mjs:699`, `src/build/replay.mjs:92,96`, `test/hub-transition.test.mjs:1155`. Second fault: `transition.mjs:693-697` writes via `hubEvent(...)` into `hub_event`; the planned `whyModel` searches `phase_event`. Third fault: the pay
- **Source:** none (measured in this repo at HEAD `b519803`, with a positive control)

**escalation-band-split-and-the-halt-marker** — Six of the twenty-six escalation identities carry no task id, so `why` prints `none standing` while the halt marker has the whole builder stopped

- **Applies to:** ``whyModel`/`renderWhy` escalation section; `evidenceFor` at S3-E Task 3 Step 3; `halted()` at `src/supervisor.mjs:500``
- **Recommendation:** Split into two bands, both ALWAYS rendered. `escalations (this task)` keeps `evidenceFor`'s existing `WHERE why LIKE ?` with `${taskId}:%`. `escalations (system)` is a NEW read, not filtered by task: `SELECT why,count,first_seen_at,last_seen_at,announced_count FROM escalation WHERE why LIKE 'builder:%' OR why LIKE 'bt:unknown:%' ORDER BY first_seen_at`. Render the system band ABOVE the task band. Resolve the halt state separately and never by `halted()`: `halted()` is `Boolean(markerPath) && existsSync(markerPath)` (`src/supervisor.mjs:500`), and `existsSync` returns `false` on EACCES/ELOOP as well as on a missing file — absence and unreadable collapsed in one boolean. Use `statSync(haltMarker, {throwIfNoEntry:false})` inside try/catch and render three states: `halt marker  PRESENT since <stamp> — no dispatch or effect will run for ANY task` / `halt marker  absent` / `halt marker  ⚠ UNREADABLE — <errno>`. Test: insert `builder:probe:merged`, assert it appears in `whyModel(db,'bt:x').escalations_system` while `escalations_task` stays empty, with the control that `bt:x:phase:failed:SIZ
- **Why here:** MEASURED: the `escalation` table is `(why PRIMARY KEY, count, first_seen_at, last_seen_at, announced_count)` — there is no `task` column, so a per-task read must prefix-match. Extracting every identity from design line 747 gives exactly 26, and exactly 6 cannot match `bt:<id>:%`: `bt:unknown:intake:orphan-claim`, `bt:unknown:merge:unbound:<repo_id>:<pr>`, `builder:app-install:<repo>`, `builder:backup:failed`, `builder:probe:merged`, `builder:sandbox:canary-failed`. `builder:probe:merged` is the 
- **Source:** none (measured against `docs/2026-08-21-builder-design.md:747` and `src/build/hub.sql:712-718`)

**four-section-states-exit-3-not-4** — A lineage section has four states — and the missing sections are the five tables `tables.mjs` already names `why` as the reader of

- **Applies to:** ``whyModel`/`renderWhy` in `src/build/why.mjs`; the `absent` array (S3-E PR-E1 Task 4); `EXITS` in `bin/reeve.flags.mjs` (S3-E Task 2)`
- **Recommendation:** Replace `absent: string[]` with `sections: { [name]: { state, rows, reason, error } }`, `state ∈ {RECORDED, NOT_RECORDED, NOT_APPLICABLE, UNREADABLE}`, produced through one wrapper that cannot throw:

```js
const SECTION = { RECORDED:"RECORDED", NOT_RECORDED:"NOT_RECORDED",
                  NOT_APPLICABLE:"NOT_APPLICABLE", UNREADABLE:"UNREADABLE" };
// `na` is a REASON or null, never a boolean: "cannot apply" that cannot say why
// is the same non-answer as an empty array.
function readSection(name, { na = null }, fn) {
  if (na) return { name, state: SECTION.NOT_APPLICABLE, rows: [], reason: na, error: null };
  try {
    const rows = fn();
    return rows.length
      ? { name, state: SECTION.RECORDED, rows, reason: null, error: null }
      : { name, state: SECTION.NOT_RECORDED, rows: [], reason: null, error: null };
  } catch (e) {
    return { name, state: SECTION.UNREADABLE, rows: [], reason: null, error: String(e.message) };
  }
}
```

The section list is not invention — take it from `src/build/tables.mjs`, which already declares `task why` as the reader of `gate_run`, `gate_
- **Why here:** The four states survive; the fifth exit code does not. MEASURED: S3-E Task 2 Step 3 declares `3  DEGRADED: the command ran, the answer is partial or the system is unwell` — an UNREADABLE section IS a partial answer, so exit 3 is exactly the case Task 2 gives `3` its single meaning for, and adding `4: evidence_incomplete` re-creates the overloading Task 2 exists to end, in reverse. The bisect citation's own premise does not transfer: git's docs say 125 was chosen "as the highest sensible value...
- **Source:** https://opentelemetry.io/docs/specs/otel/trace/api/ (verified: Unset is "The default status", Ok and Error are separate values, "Ok > Error > Unset"); https://prometheus.io/docs/prometheus/latest/querying/basics/ (staleness markers: no value returned rather than the last value carried forward); http

**verdict-header-with-availability-checked-counterfactual** — Lead with verdict, decisive row, contrastive foil and counterfactual — and the counterfactual must not print a command S3 does not ship

- **Applies to:** ``renderWhy` header block in `src/build/why.mjs`; a new `TASK_SUBCOMMANDS` export in `src/build/show.mjs` consumed by `bin/reeve`'s `case "task"``
- **Recommendation:** Four lines before any section. **VERDICT** — `task.phase`, `waitingFor().first`, and `stamp()` of entry into that phase. **BECAUSE** — the decisive row, derived: `SELECT * FROM phase_event WHERE task=? AND to_generation=? AND to_phase=? ORDER BY seq DESC LIMIT 1`; print seq, op, `artifact_sha`, and mark that same row in the chain below with `← the decisive row`. When it returns nothing, print `UNKNOWN — no phase_event at generation N puts this task in <phase>` and push `decisive_event` onto `unknown`: that means a phase column was written without a transition, a hub integrity fault `why` is uniquely placed to catch. **NOT** — a frozen foil map naming the row that would have to exist: `FOIL = { ESCALATED: ["BLOCKED", "no hold_reason row: a retry cap is not a founder hold"], BLOCKED: ["ESCALATED", "no escalation standing; a founder hold, not a fault"], VERDICT_WAIT: ["SLICE_MERGED", "no guardian verdict at this head"], CANCELLING: ["CANCELLED", "N drain rows unsettled"] }`; a phase absent from the map prints `NOT  UNKNOWN — no foil declared for <phase>`, never a silent blank. **MOVES I
- **Why here:** The correction is the load-bearing part. MEASURED: `s3.md` §1's sixteen tasks contain `reeve task file` (T3) and `list|show|why` (T13) and NO `resume`, `regenerate`, `infeasible`, `cancel` or `depth` route; S3-B's route is literally `if (sub !== "file") { console.error("reeve task: the only subcommand is `file`") }`. A `MOVES IT` line printing `reeve task resume` at 2am hands the one operator a command that exits 1 — the counterfactual becomes a dead end, which is worse than no counterfactual. D
- **Source:** https://arxiv.org/abs/1706.07269 (Miller, *Explanation in AI*, AIJ 267:1-38 — explanations are contrastive: "people do not ask why event P happened, but rather why event P happened instead of some event Q", and selected: "people rarely expect an explanation that consists of an actual and complete ca

**generation-scoped-chain** — `events.find()` returns generation 1's row while `task.depth` is generation N's, and no section is cut at the epoch boundary

- **Applies to:** `every query in `whyModel`, `src/build/why.mjs``
- **Recommendation:** Scope every section to `task.generation` by default and say so on the section header. Events: `WHERE task=? AND to_generation=?`; runs: `WHERE task=? AND generation=?`; approvals and gate_requests: `WHERE task_generation=?`; merge_decision: `WHERE task_generation=?`. Ban `Array.prototype.find` over a mixed-generation list anywhere in the module — every "the latest X" becomes an explicit `ORDER BY seq DESC LIMIT 1`. Render the seam as a header suffix: `transitions                    generation 3 only  (--generation all: 27 more)`. Under `--generation all`, print each epoch under its own rule naming the bumping event:

```
  ══ generation 2 → 3  #401  task.regenerate  2026-08-27 06:03:11Z
     registry_version 14 → 15, profile_hash 8ac1… → 3f70…
     everything above this line authorizes nothing at generation 3
```

The last sentence is the load-bearing one. Test: insert two `sizing.recorded` hub_events at generations 1 and 2, assert the model reports generation 2's floors, with the control that `--generation all` returns both.
- **Why here:** `hub.sql:19-25` states it in the schema: generation "is the CONTRACT EPOCH and bumps on exactly two founder commands (resume --redesign, regenerate)... Approvals bind to (spec head sha, generation), so a retry, a crash, or a plain resume cannot void an approval." Design:223 says the same in prose. MEASURED in the planned `whyModel`: `phase_event` is selected `WHERE task = ? ORDER BY seq` with no generation predicate, `phase_run` `WHERE task = ? ORDER BY started_at, attempt` likewise, and the dep
- **Source:** none (measured against `src/build/hub.sql:19-25` and `docs/2026-08-21-builder-design.md:223`)

**fmt-module-glyph-table-and-absolute-stamps** — Extract `src/build/fmt.mjs`: one `ago()`, a `stamp()` that is not raw unix seconds, and a glyph table with an ASCII fallback that does not exist anywhere in reeve today

- **Applies to:** ``renderWhy`; new `src/build/fmt.mjs`; `src/dash.mjs:18`; `src/status.mjs:29``
- **Recommendation:** Create `src/build/fmt.mjs` exporting `ago(sec)` (delete both copies), `stamp(sec, now)` → `"2026-08-27 06:11:04Z (26h ago)"`, and `GLYPH`. Timestamps are UTC-absolute plus relative, because the operator's local calendar is PKT (+5) and elapsed time here is only meaningful against the hub's clock. Glyphs are a table selected once at render time: UTF-8 `● ◌ ○ ▲ ⚠` with gutter `│ ═ └`; ASCII `* . - ! ?` with `| = \`` chosen when `!process.stdout.isTTY || /^(C|POSIX)$/.test(process.env.LC_ALL||process.env.LANG||"") || !/UTF-?8/i.test(process.env.LC_ALL||process.env.LC_CTYPE||process.env.LANG||"")`, forced by `--ascii`, and honour `NO_COLOR` in the same table. Section state maps to glyph one-to-one: RECORDED `●`, NOT_RECORDED `◌`, NOT_APPLICABLE `○`, needs-you `▲`, UNREADABLE `⚠`. `@` is elapsed since the current generation's first event; `+` is a run's own duration. A section with nothing to say costs exactly one line — `gate runs   ◌ NOT RECORDED — expected at GATE; no gate_run row exists` — but it must still cost one; deleting it is how absence becomes invisible. Close with the legend,
- **Why here:** MEASURED: `git grep -c isTTY -- src bin` and `git grep -c NO_COLOR -- src bin` both return NOTHING (exit 1, no files), against the positive control `git grep -c console -- bin/reeve` = 109. Yet `src/status.mjs` emits `┌ ├ └ ─ │ ● ◐ ○ ⚠` at lines 204-250 and a `spark()` bar at :24-27, so reeve already garbles on a non-UTF-8 terminal and has no fallback path to add one to. ONE CORRECTION to the original finding: `bin/reeve` does NOT emit `⚠` — its twelve non-ASCII lines are em-dashes, `§`, comment
- **Source:** https://man7.org/linux/man-pages/man1/systemd-analyze.1.html (verified: "The time after the unit is active or started is printed after the \"@\" character. The time the unit takes to start is printed after the \"+\" character", example `└─pmie.service @35.968s +548ms`); https://nix.dev/manual/nix/2.

**json-node-envelope-drop-absent** — Every `--json` section carries its own `state` and the `{table, key}` that produced it — and `absent` is DELETED rather than carried beside `sections`

- **Applies to:** ``whyModel` output shape; the `--json` contract for `reeve task why`; the freeze fixture `test/fixtures/read-model-v1.json` (S3-E Task 6)`
- **Recommendation:** Shape every section as a node, never a bare array:

```json
{ "format_version": 1, "kind": "task.why", "data": {
  "task": "bt:01HQZ…", "phase": "ESCALATED", "generation": 3, "generations_total": 3,
  "verdict": { "waiting": "WAITING_FOR_FOUNDER", "since": 1787551864 },
  "decisive": { "state": "RECORDED", "source": {"table":"phase_event","key":{"seq":418}},
                "at": 1787551864, "op": "phase.escalated",
                "from_phase":"GATE", "to_phase":"ESCALATED", "artifact_sha": null },
  "foil": { "phase": "BLOCKED", "absent_row": "hold_reason" },
  "moves_it": [ { "command": "reeve task resume bt:01HQZ… --redesign",
                  "available": false, "effect": { "generation": 4 } } ],
  "sections": {
    "runs": { "state": "RECORDED", "reason": null, "error": null, "rows": [
      { "source": {"table":"phase_run",
                   "key":{"task":"bt:01HQZ…","generation":3,"phase":"SIZING","slice":0,"attempt":3}},
        "at": 1787551262, "status": "failed", "snapshot_hash": "4c1f8ab2",
        "contract_drift": { "cli_version": { "snapshot": "2.1.4", "live": "2.2.
- **Why here:** Keeping `absent` beside `sections` is the exact shape reeve already banned in its own source: `src/build/tables.mjs:10-12` — "PROSE_TABLES is transcribed BY HAND... deliberately not derived from TABLE_OWNERS: two lists built from one source agree with each other and prove nothing." Two derivations of one fact is how they drift. MEASURED on the `--json` premise: `bin/reeve:880-885`'s `why` route is `console.log(why(db, target)); process.exit(0)` with no `flag("json")` branch at all — one of the s
- **Source:** https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md ("Subject artifacts are matched purely by digest, regardless of content type" — evidence bound to an immutable identity, not a rendered label); https://slsa.dev/spec/v1.0/provenance ("Unset, null, and empty field values MUST be in


### json-contract — 7

**emit-not-exit** — Route every --json write through one emitter that sets process.exitCode; never process.exit() after a document

- **Applies to:** `bin/reeve:548 (doctor --json), :894 (status/statusline/dash/why shared block), :946/:965/:981/:992/:1115 (builder doctor --json); S3-E plan Task 2 fail() (plan:487), Task 3/5 task show|list|why, Task 7 task dash (plan:2131), Task 14 notify --test (plan:3142)`
- **Recommendation:** Add one writer in bin/reeve and route every machine-shape write through it:

```js
// process.exit() abandons pending stdout writes. On a PIPE -- the only place
// the contract is ever read -- that truncates the document at the first buffer
// and still exits 0.
const emit = (doc) => { process.stdout.write(JSON.stringify(doc, null, 2) + "\n"); process.exitCode = doc.exit; };
```

Then: (a) replace the seven `console.log(JSON.stringify(...)) ... process.exit(N)` pairs at the lines above with `emit(...)`; (b) every route below the emitter must `return` out of the switch, not `exit` -- bin/reeve:855-858 is one fall-through block shared by `status`, `statusline`, `dash` and `why`, so a single `process.exit(0)` at :895 is the exit for four routes and one edit fixes all four; (c) the human path keeps `process.exitCode` too, so a mixed route has one exit mechanism.

Per tracker s3.md §4 decision 14, the plan carries the PROPERTY, not the test code. State it as: *"a `--json` document larger than one pipe buffer arrives whole, and the fixture that produces it is itself asserted to exceed 6553
- **Why here:** MEASURED in this checkout at b519803: `grep -c 'process\.exit' bin/reeve` -> 48, and `grep -n 'process\.exitCode' bin/reeve src/*.mjs` -> ZERO matches. Every route that honours `--json` today uses the failing pattern, and so does every route S3-E adds. Reachability is arithmetic, not theory: I built a realistic `taskShow` row from the plan's own model (id, project, nwo, title, phase, generation, depth, waiting{first,all,since,capability}, age{seconds,from}, two territory claims, draining, prs, e
- **Source:** MEASURED by me on this machine, Node v24.17.0 (reeve's engine floor), 2026-08-28: a 1,278,999-byte pretty-printed document written with `console.log(...); process.exit(0)` and piped -> 65536 bytes, `JSON.parse` throws `Unterminated string in JSON at position 65536`, shell exit status 0. Same content

**one-envelope-seven-keys** — One envelope on every route, success and failure alike -- but `ok` means "a document was produced", not "healthy"

- **Applies to:** `S3-E Task 3 (`src/build/show.mjs`: `envelope`, plan:717), Task 2 (`fail()`, plan:487), Task 7 (`envelope("task.dash", ...)`, plan:2131), Task 14 (plan:3142); and bin/reeve:548, :894, :946-1115`
- **Recommendation:** Seven keys, identical on every route and on both paths:

```json
{ "format_version": "1.0", "kind": "task.show", "ok": true, "exit": 0,
  "data": { "...": "payload" }, "error": null,
  "meta": { "generated_at": "2026-08-28T09:12:04Z", "reeve_version": "0.1.0" } }
```

Failure keeps all seven keys and the ROUTE's kind, not the error's:

```json
{ "format_version": "1.0", "kind": "task.show", "ok": false, "exit": 1, "data": null,
  "error": { "kind": "task_not_found", "message": "no task bt:nope in the hub at ~/.reeve/hub.db", "retryable": false },
  "meta": { "...": "..." } }
```

Invariants, each an assertion:
1. All seven keys on every document. Never a bare object, never a bare array.
2. `ok === (error === null)`, and exactly one of `data`/`error` is non-null. **`ok` states that the route produced its answer; it does not state health.**
3. `exit ∈ Object.values(EXITS)` **and equals the process's actual exit status.** Health lives here. A degraded answer is `ok:true, exit:3, data:{...}, error:null`, and *what* is degraded is named inside `data.unknown` / `data.absent` -- never by a 
- **Why here:** MEASURED at b519803: the three routes that honour `--json` today emit three unrelated shapes -- `{home, verdict, checks, exitCode}` (bin/reeve:548 spreading src/doctor.mjs:1044), `{state, health}` (:894), and a **bare JSON array** of findings (:946, :965, :981, :992, :1115). None carries `format_version`, `kind`, or `ok`. The plan then specifies a FOURTH shape without `ok` (plan:717), so success is signalled by the absence of `ok:false` in a system whose stated dominant defect class is absence r
- **Source:** MEASURED by me, npm 11.7.0, 2026-08-28: `npm ls --json` on a package.json with a missing dependency emits ONE parseable document on stdout carrying both the result and an `error` key, human `npm error ...` prose on stderr (219 bytes), exit 1. The bug it replaced is npm/cli#2150, "[BUG] --json output

**format-version-string** — `format_version` is the string "MAJOR.MINOR", declared once -- as an integer it cannot say "additive", which is why the plan contradicts itself

- **Applies to:** `S3-E Task 3 `READ_FORMAT_VERSION` (plan:717), Task 6 `test/fixtures/read-model-v1.json` (plan:1403-1408), Task 2 `fail()` (plan:487), Task 13 (plan:1834), Task 14 (plan:3142)`
- **Recommendation:** `format_version` is a **string** `"MAJOR.MINOR"` starting at `"1.0"`, exported once from `bin/reeve.flags.mjs` and imported everywhere. Delete the two hardcoded `format_version: 1` literals (plan:487, plan:3142) -- three declarations for one fact is the second-inventory shape.

The rule, published in `reeve --help` and in the contract dump:

| change | version move |
|---|---|
| add a key, at any depth | MINOR (1.0 -> 1.1) |
| widen a closed value domain | MINOR, only if the unknown-member rule is published |
| remove or rename a key; change a value's JSON type; change a key's meaning | MAJOR |
| narrow a closed value domain | MAJOR |
| change an exit code's meaning | MAJOR |
| change the human render | **no move** -- the human text is not in the contract |

Consumer rule, verbatim in the help text: *"Reject a `format_version` whose MAJOR you do not recognise. Ignore keys you do not recognise. Treat an unrecognised `kind`, `error.kind`, `phase`, `severity`, `classification` or waiting substate as UNKNOWN and act on nothing."*

A key is never removed inside a MAJOR; it keeps being emi
- **Why here:** MEASURED in the plan file at b519803: it states the rule twice and the two statements are opposites. plan:1408, the fixture's own `note`, says "additive fields need a new format_version"; plan:1358 says "New fields are additive and go in a version bump"; and plan:1834 instructs the author to "say in the commit body that `format_version` stays `1` because the change is purely additive." Task 13 adds exactly such a field (`age`) and so hits the contradiction on its first use. Both readings are def
- **Source:** Terraform, the one shipping tool with this exact field and a written rule, verified verbatim 2026-08-28 at https://developer.hashicorp.com/terraform/internals/json-format : "We will increment the minor version, e.g. \"1.1\", for backward-compatible changes or additions. Ignore any object properties 

**closed-domains-and-contract-route** — Key sets are additive-safe; closed VALUE domains are not -- and reeve has seven of them, not six

- **Applies to:** `S3-E Task 1 (`bin/reeve.flags.mjs`: APPLIES, EXITS, ERROR_KINDS), Task 3 (WAITING, NEEDS_SWITCH), Task 6 (the freeze fixture), `src/build/phases.mjs:42`, `src/doctor.mjs``
- **Recommendation:** Declare every closed domain once, freeze it, and publish it. **Seven**, not six -- the finding as handed to me missed `severity`, which `builder doctor --json` already emits today:

| domain | where it lives now | measured members |
|---|---|---|
| `kind` (route kinds) | does not exist yet | new |
| `error.kind` | ERROR_KINDS, plan:466 | 6 |
| `exit` | EXITS, plan:450 | 4 |
| `phase` | `src/build/phases.mjs:42` (ACTIVE+HELD+DRAINING+TERMINAL) | frozen already |
| waiting substate | WAITING, plan:721 | 6 |
| `classification` | `src/doctor.mjs`, emitted at bin/reeve:946/1115 | configuration, dependency-outage, stale-evidence, unsafe-authority |
| `severity` | `src/doctor.mjs`, emitted at bin/reeve:946/1115 | pass, warn, fail |

Add one route, `reeve contract [--json]`, generated from those same frozen constants so it cannot drift, reading no database:

```json
{ "format_version": "1.0", "kind": "contract", "ok": true, "exit": 0,
  "data": { "kinds": [...], "error_kinds": [...], "exits": {"ok":0,"refused":1,"misuse":2,"degraded":3},
    "phases": [...], "waiting": [...], "severities": [
- **Why here:** Adding a seventh waiting substate is additive to the schema -- the array's type is unchanged, so every key-set freeze stays green -- and breaking to the consumer, who has six branches and no seventh. The plan already senses this: it freezes WAITING as six strings (plan:1381), which means it already treats enum widening as a contract event without saying which version move that is. The two domains the finding missed are the two already on the wire: `builder doctor --json` at bin/reeve:946 and :11
- **Source:** gh 2.96.0, MEASURED by me on this machine 2026-08-28: `gh pr list --json` with no value prints its full field list and exits 0 -- the tool enumerates its own contract rather than making the caller guess. Kubernetes deprecation policy: "Constant/enumerated values must function in any API version wher

**skeleton-freeze-corrected** — Freeze a recursive path+type image, not a top-level key list -- but the walker as handed to me is wrong twice and must not be shipped as written

- **Applies to:** `S3-E Task 6 (`test/fixtures/read-model-v1.json`, `test/task-show.test.mjs`, plan:1360-1410)`
- **Recommendation:** Replace `Object.keys(model).sort()` with a full skeleton image. **The version I was handed has two defects I measured; use this one instead.**

Defect 1: its counter-control asserts `image({a:{b:[1]}}).join(",") === "$.a.b[]:number,$.a.b:array,$.a:object,$:object"`. MEASURED: a correct walker returns `$.a.b:array,$.a.b[]:number,$.a:object,$:object` -- `:` is 0x3A and `[` is 0x5B, so `.sort()` puts the array before its element. Shipped as written, the counter-control goes red against a CORRECT implementation.

Defect 2: recording `null` as a type makes the image unstable. A path frozen as `$.x:null` from a fixture where `draining`/`pinned_until` happened to be null is reported as a REMOVAL -- a false MAJOR -- the first time the field carries a value.

Corrected walker (MEASURED stable across both cases, ~20 lines, plain Node):

```js
function image(doc) {
  const types = new Map(), nullable = new Set();
  (function walk(v, p) {
    if (v === null) { nullable.add(p); if (!types.has(p)) types.set(p, new Set()); return; }
    const t = Array.isArray(v) ? "array" : typeof v;
    if (!type
- **Why here:** The plan's freeze at plan:1367-1375 is `Object.keys(taskShow(...)).sort()` and `Object.keys(whyModel(...)).sort()` -- **top level only**. Renaming `waiting.first` to `waiting.now`, changing `age.seconds` from number to string, or flipping `draining` from `null` to `{}` all pass that freeze untouched, and all three break a consumer. The plan states the right principle one line above it -- "a freeze verified only against the half it already covered proves nothing about the half that was added" -- 
- **Source:** MEASURED by me on Node v24.17.0, 2026-08-28, both defects reproduced and the correction verified: the original walker on `{a:{b:[1]}}` returns `$.a.b:array,$.a.b[]:number,$.a:object,$:object`, not the string the finding asserts; and on `{x:[1,"s",null]}` it emits three separate `$.x[]` type paths. T

**test-helper-keeps-streams-apart** — The contract test cannot be written with the existing helper, and four plan assertions would go red against a correct implementation

- **Applies to:** ``test/cli-flags.test.mjs:33-36`, `:58-61`, `:446-449`; S3-E Task 1 Step 1 and Task 2 Step 1, whose new assertions read `.stdout` (plan:263-264, :412-413, :422)`
- **Recommendation:** Change all three helpers in `test/cli-flags.test.mjs` to keep the streams apart while preserving `out`, so the ~40 existing assertions that read it are untouched:

```js
const run = (...args) => {
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), ...args],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, REEVE_HOME: join(dir, "envhome") } });
  const stdout = r.stdout ?? "", stderr = r.stderr ?? "";
  // `out` stays, for assertions that only care that a string was said. stdout
  // and stderr stay APART, because "stdout is exactly one JSON document and
  // stderr is not a second one" is the property, and a concatenation cannot
  // see it.
  return { status: r.status, out: stdout + stderr, stdout, stderr };
};
```

Same for `runIn` (:58) and `runH` (:446). Then the two purity assertions become expressible: `JSON.parse(r.stdout)` succeeds, and `JSON.parse(r.stderr)` throws. The `maxBuffer` raise is not cosmetic -- the 1MiB default silently truncates and sets `r.error`, which would make the >64KiB control from `emit-not-exit` unreada
- **Why here:** Four of the plan's own new assertions -- including `a refusal under --json is itself JSON on stdout` (plan:412-413) and `a refusal without --json writes nothing to stdout` (plan:422), the two that carry the whole stdout/stderr contract -- would go red against a CORRECT implementation, because `run()` never sets `.stdout`. `p.stdout.trim()` on `undefined` throws a TypeError, and in a plain-script test that aborts the file before the remaining assertions run. That is worse than a missing test: it 
- **Source:** MEASURED at b519803 by reading the file: `test/cli-flags.test.mjs:36`, `:61` and `:449` each end `return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };`. `grep -n stdout test/cli-flags.test.mjs` returns exactly four hits -- those three returns plus one unrelated local `spawnSync` at

**next-action-typed** — Keep `next_action`, change its type: a closed `kind`, an argv array, and prose explicitly outside the contract

- **Applies to:** ``docs/2026-08-21-builder-design.md:130` and `:735` (§11.6's mutating shape); S3-B plan:739-740 (the assertion) and :871 (the shipped value); every mutating `task` subcommand and S3-E's `resume`/`cancel`/`infeasible``
- **Recommendation:** Not a string, not a shell command:

```json
"next_action": {
  "kind": "await_founder_approval",
  "actor": "founder",
  "command": ["reeve", "task", "go", "bt:41"],
  "human": "approve the spec on PR #118, or reeve task infeasible bt:41 --reason ...",
  "derived_at": "2026-08-28T09:12:04Z"
}
```

Four rules, each an assertion:
1. `next_action.kind` is a member of a closed domain (see `closed-domains-and-contract-route`) and is the only part a script may branch on.
2. `command` is an **argv array**, never a string -- a string invites `eval`, and a task title is operator-supplied text that reaches this record.
3. `human` is prose and is explicitly not contractual, per RFC 9457's rule for `detail`. Say so in the contract dump.
4. `derived_at` is present so a consumer can see the value is a snapshot. `next_action` is `null` when the next move is nobody's -- never a made-up placeholder -- and the closed domain must contain an explicit `no_action` member so "absent" and "nothing to do" stay distinguishable.

One boundary: this must NOT become the operator's queue. `reeve task dash` is whe
- **Why here:** reeve's own stated rule, at plan:706-710, is that the waiting substates are "DERIVED on every read and stored nowhere", with the failure spelled out: "a task filed while `observe` was on would keep reading 'a worker is coming' after the switch went off." `next_action` is that same derivation, computed at the instant of a write and handed to a consumer whose whole purpose is to keep it; the daemon ticks between the write and the read. And MEASURED in the plan family: S3-B asserts `typeof r.next_a
- **Source:** git separates the two surfaces completely: `git status`'s human output suggests next commands, while `git status --porcelain`, the machine contract, is "guaranteed not to change in a backwards-incompatible way" and carries no advice at all, https://git-scm.com/docs/git-status . clig.dev places "Sugg


---

## The synthesis

# reeve S3-E: the operator surface

Written against measurements in `/Users/mobeen/Work/Products/reeve-wt/c4` at HEAD. Every `file:line` below was re-read, not inherited.

---

## 1. The three decisions that matter most

### D1. `--json` stops being a flag and becomes a read model, an envelope, and one emitter that is not `process.exit()`

**This changes the most: nine existing routes, five new ones, and every route S3 has not written yet.**

Measured now: `grep -c 'process\.exit' bin/reeve` → **48**. `grep -rn 'process\.exitCode' bin/ src/` → **zero matches**. `flag("json")` is read at exactly three routes (`bin/reeve:548`, `:894`, `:946`/`:965`/`:981`/`:992`/`:1115`), and they emit three unrelated top-level shapes: `{home, verdict, checks, exitCode}`, `{state, health}`, and a **bare array**. Six read routes accept `--json` and change nothing.

And the pattern all three use is the one Node's own docs mark as an anti-pattern:

> "Calling `process.exit()` will force the process to exit as quickly as possible even if there are still asynchronous operations pending that have not yet completed fully, including I/O operations to `process.stdout` and `process.stderr`" — https://nodejs.org/api/process.html#processexitcode

Measured on Node v24.17.0 (reeve's engine floor): a 1,278,999-byte pretty-printed document written with `console.log(...); process.exit(0)` and **piped** arrives as **65,536 bytes**, `JSON.parse` throws `Unterminated string in JSON at position 65536`, and the **shell exit status is 0**. The same content to a file or a TTY arrives whole. `spawnSync` with `encoding:"utf8"` reproduces it exactly.

A realistic `taskShow` row built from the plan's own model measures **841 bytes** pretty-printed. `task list --json` crosses 65,536 bytes at **60 tasks**. `task why --json` on one long-lived task crosses on its own.

So: the contract written to prevent absence-being-read-as-success produces exactly that, on a pipe, which is the only place the contract is ever read.

**Shape to implement.** One writer in `bin/reeve`, and every machine-shape write goes through it:

```js
// process.exit() abandons pending stdout writes. On a PIPE -- the only place
// the contract is ever read -- that truncates the document at the first buffer
// and still exits 0.
const emit = (doc) => {
  process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
  process.exitCode = doc.exit;
};
```

Three consequences, all mechanical:

1. Replace the seven `console.log(JSON.stringify(...)); process.exit(N)` pairs with `emit(...)`, and convert the human paths in the same switch to `process.exitCode = n; return;`. `bin/reeve:855-858` is one fall-through block shared by `status`, `statusline`, `dash` and `why`, so a single edit at `:895` fixes four routes.
2. Every read route computes a model, wraps it in the envelope (§2.3), and emits. No route prints.
3. `--json` is declared per command in one `APPLIES` table, and **declaring it is what makes it parse**. `FLAGS` at `bin/reeve:263` is global today, which is why `bin/reeve:424` prints `-> reeve <cmd> accepts: <every key in FLAGS>` on any usage error. Once applicability is per-command, a route cannot gain `--json` in the help without gaining it in the parser: the six-route gap becomes unrepresentable rather than merely fixed.

**Do not use the "refuse it where it is not implemented" escape** that `MASTER-PLAN.md:4593` (R7) offers. Tracker `s3.md` §4 decision 7 is settled: every read surface is compute → data → render. Refusal is reserved for flags that genuinely cannot apply (`--health` on `builder doctor`, `--tail` on `doctor`, `--set` on `status`).

**The test, and its controls.** Per `s3.md` §4 decision 14, state the property, not the code:

> A `--json` document larger than one pipe buffer arrives whole, **and the fixture that produces it is itself asserted to exceed 65,536 bytes**, and the document's `exit` equals the observed process exit status.

The size assertion is mandatory. Without it, a fixture that shrinks below 64 KiB turns the check green while guarding nothing. Use `spawnSync(..., {encoding:"utf8", maxBuffer: 64*1024*1024})`: `spawnSync` uses a pipe and reproduces the failure, and the default 1 MiB `maxBuffer` would truncate for the opposite reason.

**Blocker to schedule.** `test/cli-flags.test.mjs:33-36`, `:58-61` and `:449` all return `{status, out: (r.stdout ?? "") + (r.stderr ?? "")}`. No helper in the file exposes `.stdout`. Four of the plan's own new assertions read `p.stdout.trim()`, including the two that carry the whole stdout/stderr contract (plan:412-413, plan:422). Against a *correct* implementation they throw `TypeError` on `undefined` and abort the file. Fix the three helpers first, keeping `out` so the ~40 existing assertions are untouched.

---

### D2. Four section states, and `why` currently cannot tell the truth in three places

The system's dominant defect class is absence read as unreadable, or absence read as success. The plan's answer is an `absent: string[]`. That is one bit where four values are needed, and three measured faults show why.

**Fault 1: the floors section can never render.** Measured, with a positive control:

- `git grep -n "sizing.decided"` → hits in **one file only**, `tasks/reeve-tasks/plans/2026-08-27-s3e-operator-surface.md` (1063, 1791, 1802, 2270). **Zero source files.**
- Control: `git grep -n "sizing.recorded"` → `src/build/transition.mjs:699`, `src/build/replay.mjs:92,96`, `test/hub-transition.test.mjs:1155`.

The planned `whyModel` searches `phase_event` for op `sizing.decided`. `transition.mjs:693-697` writes `sizing.recorded`/`sizing.overridden` into **`hub_event`**, and the payload is literally `SELECT id, depth, generation, updated_at FROM task WHERE id = ?` — **there is no `floors` key to find**. Three independent faults, so `renderWhy` prints `floors fired: none recorded` for every task that will ever exist, and `--json` reports `floors: []`.

`docs/2026-08-21-builder-design.md:339` makes `why` the only surface where the founder can audit whether the model or the code chose the depth. As planned it always says neither did.

Fix: widen `persistDepth(db, taskId, depth, kind, extra = {})` in S3-D and build the payload as `{...row, ...extra}`; read `hub_event WHERE kind IN ('sizing.recorded','sizing.overridden')` and keep the row only if `payload.generation === task.generation`.

**Fault 2: `why` is blind to the halt.** The `escalation` table is confirmed as `(why PRIMARY KEY, count, first_seen_at, last_seen_at, announced_count)` (`src/build/hub.sql:712-718`). No `task` column, so a per-task read must prefix-match `bt:<id>:%`. Extracting every identity from `docs/2026-08-21-builder-design.md:747` gives **26**, and **six cannot match**: `bt:unknown:intake:orphan-claim`, `bt:unknown:merge:unbound:<repo_id>:<pr>`, `builder:app-install:<repo>`, `builder:backup:failed`, `builder:probe:merged`, `builder:sandbox:canary-failed`.

`builder:probe:merged` writes the HALT marker that "every dispatch and effect checks, failing closed" (design:487). **The one condition under which no task can move is the one condition `reeve task why <any task>` is structurally incapable of showing.** The operator reads `none standing` and concludes the task is merely slow.

Fix: two bands, both always rendered, system band first. And resolve the halt state separately, never via `halted()`: `src/supervisor.mjs:500` is `Boolean(markerPath) && existsSync(markerPath)`, and `existsSync` returns `false` on EACCES and ELOOP as well as on a missing file. Absence and unreadable, collapsed into one boolean, inside the guard for the whole system. Use `statSync(p, {throwIfNoEntry:false})` in try/catch and render three states.

**Fault 3: the chain mixes contract epochs.** `src/build/hub.sql:19-25` states it in the schema, verbatim: generation "is the CONTRACT EPOCH and bumps on exactly two founder commands (resume --redesign, regenerate) ... Approvals bind to (spec head sha, generation), so a retry, a crash, or a plain resume cannot void an approval." The planned `whyModel` selects `phase_event WHERE task = ? ORDER BY seq` with no generation predicate, and finds depth with `events.find(...)`, which returns the **first** match. After one `regenerate` it returns generation 1's row while `task.depth` is always current. The render pairs a current depth with a superseded epoch's evidence and shows no seam. The code already enforces the binding; only the render does not.

Fix: scope every query to `task.generation` by default, ban `Array.prototype.find` over a mixed-generation list in the module, print the scope on the section header, and under `--generation all` rule each epoch with the sentence *"everything above this line authorizes nothing at generation N."*

**The shape.** Replace `absent: string[]` with one wrapper that cannot throw:

```js
const SECTION = { RECORDED:"RECORDED", NOT_RECORDED:"NOT_RECORDED",
                  NOT_APPLICABLE:"NOT_APPLICABLE", UNREADABLE:"UNREADABLE" };
// `na` is a REASON or null, never a boolean: "cannot apply" that cannot say why
// is the same non-answer as an empty array.
function readSection(name, { na = null }, fn) {
  if (na) return { name, state: SECTION.NOT_APPLICABLE, rows: [], reason: na, error: null };
  try {
    const rows = fn();
    return rows.length
      ? { name, state: SECTION.RECORDED,     rows, reason: null, error: null }
      : { name, state: SECTION.NOT_RECORDED, rows: [], reason: null, error: null };
  } catch (e) {
    return { name, state: SECTION.UNREADABLE, rows: [], reason: null, error: String(e.message) };
  }
}
```

The wrapper is not optional: `whyModel` runs six unguarded `db.prepare(...).all()` calls, and `bin/reeve:955-960` already carries the comment for `builder doctor` that throwing "produces no finding and no JSON at all, so the one command an operator runs to find out what is wrong answers with a stack trace." Same shape, second instance.

**The section list is not invention.** `src/build/tables.mjs` already declares `task why` as the reader of `gate_run`, `gate_request`, `approval`, `merge_decision` and `intake_event`. The planned `whyModel` reads **none of the five**. Add them as sections with derivable `NOT_APPLICABLE` reasons.

**One rule that ties it to the exit code:** `complete === false` ⟺ at least one section is `UNREADABLE` ⟺ exit 30 (`unknown`). Nothing else sets it. `NOT_RECORDED` is a determined answer and does not.

**Do not adopt** the OTel/SLSA-shaped rule that "unset, null and empty are equivalent" (https://slsa.dev/spec/v1.0/provenance). That rule is right for a consumer validating a signed document from a build platform it does not control. Adopting it inside `why` destroys the exact distinction `why` exists to draw.

**Do not** carry `absent` beside `sections`. `src/build/tables.mjs:10-12` already bans that shape in this repo: "PROSE_TABLES is transcribed BY HAND ... deliberately not derived from TABLE_OWNERS: two lists built from one source agree with each other and prove nothing."

---

### D3. Exit codes: two bands, and `ok` **is** the band

The plan's `EXITS = { ok: 0, refused: 1, misuse: 2, degraded: 3 }` (plan:450) collides with shipped, documented reeve behaviour. Measured:

- `src/init.mjs:322` returns `{code: 2, ... "-> reeve init --write to apply"}` and `:326` returns `{code: 2, ... "wrote <path>"}`. `bin/reeve:1731` documents it as `(exit 0 no-op · 2 changed · 1 needs an answer)`. **2 already means CHANGED**, sourced from Terraform's `-detailed-exitcode` (https://developer.hashicorp.com/terraform/cli/commands/plan). `misuse: 2` is a straight contradiction inside reeve.
- Code **3** is emitted from three unrelated routes: `src/doctor.mjs:1044` (`broken ? 1 : degraded ? 3 : 0`, where `degraded` is `DEGRADED || UNKNOWN`), `bin/reeve:849` (`sk.days >= need ? 0 : 3`, shadow streak), `bin/reeve:1696` (`r.halted ? 3 : 0`, tick halted). No wrapper can tell those apart.
- `die()` at `bin/reeve:60` is `console.error(msg); process.exit(1)`, used for 19 conditions, plus 28 more bare `process.exit(1)` sites in the same file. 47 conditions on one integer.

**The refutation that constrains the numbering.** `bin/reeve:1` is `#!/usr/bin/env node`. Node owns 1, 3, 4, 5, 6, 7, 9, 10, 12, 13, 14 and marks 2 and 8 "Unused" (https://raw.githubusercontent.com/nodejs/node/main/doc/api/process.md). Two of those are live in reeve **today**, not theoretically:

- `src/supervisor.mjs:99` is `process.on("uncaughtException", e => { reap(); throw e; })`. A handler that throws. Node exits **7** (measured).
- `bin/reeve` uses top-level await at `:1573` and `:1697`. An unsettled top-level await exits **13** (measured).

So any table assigning 7 to a retryable kind hands a retry wrapper an infinite loop on a rethrowing crash handler reeve actually installs, and any table assigning 13 to "held" reports a territory conflict when a daemon promise wedged. **The window reeve owns is 15–125.** Bash owns 126, 127 and 128+N (https://www.gnu.org/software/bash/manual/html_node/Exit-Status.html); `src/supervisor.mjs:97` already exits 130/143 on SIGINT/SIGTERM, which is that convention, is correct, and must be exempted by name from any "stay inside the window" rule rather than "fixed."

sysexits is also out: FreeBSD deprecates it in its own man page ("This interface has been deprecated and is retained only for compatibility"), launchd already emits 78 into the file reeve writes (`deploy/com.revnix.reeve.plist:10`), and it has no code for "the command ran and the answer is no", which is the distinction reeve most needs.

**The synthesis, cheaper than either option in the research.** Keep 0, 1, 2 and 3 with exactly the meanings they carry today. Un-poison 3 by moving the *other* two meanings off it rather than burning the number. Add everything new at 30+ and 20+.

The full table is §2.1. The one-line rule to write into `src/exit.mjs`:

> An exit code describes the command's answer, not the system's mood. `ok` is the band: an outcome means reeve answered, and the answer is data; a failure means reeve did not do the job.

This is the exit-code expression of the escalation research, and it is why it is a stated rule rather than taste. The measured optimum was a 64% escalation rate at 42% danger-through against **57% under full escalation** (Turan, https://arxiv.org/html/2606.08919, Table 2 at C=25). Medicine agrees from the other side: acceptance falls ~30% per additional repeat reminder (Ancker et al. 2017, https://bmcmedinformdecismak.biomedcentral.com/articles/10.1186/s12911-017-0430-8). A nonzero exit is this CLI's alarm. Spending it on "a task is waiting, as designed" is how one operator learns to ignore nonzero exits from reeve.

Concretely:
- `reeve task list` → 0 if it could read. Waiting tasks are **data**, not the command's verdict.
- `reeve dash` → 0 if it could render. Never encodes fleet health in the exit code.
- `reeve task show <id>` → 32 `waiting` is legitimate: one task was asked about, and the answer is "not yet".
- `reeve run --tick` halted → 32, not 3. Watch `deploy/com.revnix.reeve.plist:41`: `KeepAlive` is bare `<true/>` with `ThrottleInterval 10`, so nothing restarts on the code today, but the standard tick-job pattern is `KeepAlive: {SuccessfulExit: false}`, under which a deliberate halt becomes a restart every ten seconds.

---

### Decided now, built after S3-E: the phone

Not in S3-E's diff (`plans/2026-08-27-s3e-operator-surface.md:3735` files R20 out of it explicitly; `S3-DESIGN-BRIEF.md:768` files it as "S3 or S4"). Decide it now because S3-E's `announce()` is written against it.

Four measured gaps, in cost order:

1. **Resolution never reaches the phone.** `announceable`'s own docstring at `src/daemon.mjs:3230` states the requirement verbatim: "an operator who is only ever told about problems cannot distinguish 'resolved' from 'reeve stopped looking'." `buildAlert` has exactly one call site, `src/daemon.mjs:1275`, taking `fresh`. `cleared` reaches only `log()` at `:1274`. All three paged identities STOP WORK, so "am I still needed" is the only question a page raises. Alertmanager's defaults split the same way reeve's design does: paging receivers default `send_resolved: true`, email and Slack default false (https://prometheus.io/docs/alerting/latest/configuration/). Announce clearance on paging identities only, at ntfy `priority: low`, through `redact(printable(...))` (`src/notify.mjs:55,60`) because a second sender that skips redaction is a redaction bypass on the one path that crosses the machine boundary.
2. **One cause pages N times.** `bt:<id>:phase:blocked:<phase>` is per task and per phase by design, so one `builder:sandbox:canary-failed` becomes one page per blocked task, each individually correct. The guardian half already performs this reduction and says why: `src/status.mjs:185`, "A shared cause is one row, not N. Four PRs on a red base is one problem." Add Prometheus-style inhibition (§2.6), reading `standing` from the **whole** escalation table after `builderAnnounceable` has run, not from `fresh`, so a cause raised in the same tick inhibits its consequences from tick one.
3. **The digest is never delivered.** Measured: `grep -n -e digest -e heartbeat bin/reeve` returns 17 hits, every one either `createHash(...).digest` or the internal `singleton_lease` heartbeat. Six of the nine S3 identities route to dash-and-digest. If the digest is only ever pulled, that routing is indistinguishable from dropping them. Build `reeve digest --send` as a plain command any scheduler calls (launchd `StartCalendarInterval`, systemd timer, Task Scheduler), **not** a hook in the tick, so a wedged daemon cannot silently stop it. Three times a day: Fitz et al. (n=237 randomised field experiment, https://www.sciencedirect.com/science/article/abs/pii/S0747563219302596) found three-times-daily batching produced more attentiveness, better mood and more control than as-usual delivery, and that switching notifications **off** produced more anxiety and FoMO than either. Zero is worse than some.
4. **Nothing reports that reeve stopped.** `KeepAlive true` restarts a process that *exits*; launchd has no `WatchdogSec`, so a wedged daemon is never restarted and never reported. Every liveness surface reeve has is self-reported from inside the store the daemon writes, read by an operator who is already looking. ntfy ships a dead man's switch on the channel reeve already uses (https://docs.ntfy.sh/publish/#scheduled-delivery): publish with `In: 15m` to `<topic>/<id>`, re-publish each tick to replace it, `DELETE /<topic>/<id>` on SIGTERM. Re-arm **inside** the tick's `try` (guardian: beside `noteTick(db)` at `src/daemon.mjs:3222`, which the two degraded exits at `:1592` and `:1621` return above; builder: after `await buildTick(...)` at `bin/reeve:1554`, never after the `catch` at `:1568`, whose own comment records this exact failure mode). A `setInterval` re-arm proves the event loop turns, not that a tick completed. Probe support **behaviourally**, never by version: publish `In: 10s`, immediately DELETE, assert 2xx.

---

## 2. The exact contracts

### 2.1 Exit codes

One frozen module, `src/exit.mjs`. Every `process.exit`/`process.exitCode` in `bin/reeve` takes its number from it.

**Outcome band — reeve answered. The answer is data. `ok: true`. No error envelope.**

| code | name | meaning | notes |
|---|---|---|---|
| 0 | `ok` | the answer is yes | |
| 2 | `changed` | a difference exists or was written | GRANDFATHERED. `src/init.mjs:322,326`; documented at `bin/reeve:1731`; sourced from Terraform. Do not renumber. `task file --dry-run` reuses it. |
| 3 | `degraded` | measured, working, below par | GRANDFATHERED. `src/doctor.mjs:1044`; published at `README.md:89`. Keeps its published meaning; the other two uses of 3 move away. |
| 30 | `unknown` | reeve could not determine. **Never "no".** | New. Outranks `degraded`, mirrors `worst()` at `src/verdict.mjs:32-36`. |
| 31 | `no` | the measured answer is negative | |
| 32 | `waiting` | the answer is "not yet" | |
| 33 | `held` | a lease or territory claim is held by someone else | |
| 34 | `needs_input` | only the operator can settle this | |

**Failure band — reeve did not do the job. `ok: false`. Error envelope required.**

| code | name | notes |
|---|---|---|
| 1 | `failed` | FROZEN, back-compat. Node also emits 1 for an uncaught exception and the meanings coincide, so the collision is benign. **NEW CODE MUST NOT USE IT.** |
| 20 | `usage` | the invocation was wrong |
| 21 | `no_credential` | a credential is missing or the read was denied |
| 22 | `absent` | a thing reeve needed does not exist |
| 23 | `unreadable` | it exists and cannot be understood |
| 24 | `upstream` | GitHub, network, quota |
| 25 | `internal` | a caught exception reeve could not classify. Always a reeve bug. |
| 26 | `damaged` | durable state is untrustworthy. **Do not retry; recover.** |
| 27 | `environment` | the machine prevents the operation (disk full, read-only fs, OS-level lock) |

**Reserved and never emitted by reeve:** 4–14 (Node's), 15–19 and 28–29 and 35+ (gaps, deliberate: adding a failure kind must never renumber an outcome), 126/127/255, 128+N. **Exempted by name:** `src/supervisor.mjs:97` exits 130/143 on signals. That is the 128+N convention, it is correct, and no "stay inside the window" rule may touch it.

**Four rules stated beside the table:**

1. No code is claimed by both a band, and no two outcomes share one. The CLI Spec explicitly permits two error kinds to share a code (https://clispec.dev/); reeve declines that latitude for *outcomes* because the operator's wrapper is a shell script and a distinct integer is the cheapest discriminator. Error **kinds** are finer than error **codes**; several kinds map to one code (§2.2).
2. Band is DECLARED, never inferred from the number: 2 and 3 break contiguity permanently. In the envelope, `ok` is the band.
3. `fail()` throws if handed an outcome code. `emit()` throws if handed a failure code with `error: null`.
4. `3` is un-poisoned by removing its other two uses, not by burning the number. `README.md:89` and `bin/reeve:1723` publish it; `src/init.mjs:10-13` records the same reasoning for 2.

**Call-site migration.**

| site | today | becomes |
|---|---|---|
| `src/doctor.mjs:1044` | `broken?1:degraded||unknown?3:0` | `broken?31 : unknown?30 : degraded?3 : 0` — split UNKNOWN out; `render()` at `:1049-1051` already shows it as its own band |
| `bin/reeve:1127-1128` | `fail?1:warn?3:0` | same split, once `unknown` joins the severity set |
| `bin/reeve:849` | 3 (shadow streak short) | `31` no |
| `bin/reeve:1696` | 3 (tick halted) | `32` waiting |
| `bin/reeve:607,609,774,776,810,812,868,914,916,1581,1583,1591` | 1 | `22` absent |
| `bin/reeve:426`, `:625`, `:629`, `:938`, `:1149`, `:1703` | 1 | `20` usage |
| `bin/reeve:507`, `:946`, `:965` | 1 | `23` unreadable |
| `bin/reeve:981` (schema ahead), `:992` (half migration) | 1 | `23` unreadable — but they are **outcomes**: keep the findings payload on stdout, `ok: true`, and use the outcome band. See the note below. |
| `bin/reeve:932` (canary open) | 1 | `31` no |
| `src/init.mjs:315` | 1 | `34` needs_input |
| `src/init.mjs:307` | 1 | `23` unreadable |
| `src/init.mjs:322,326` | 2 | **unchanged** |

**Note on `bin/reeve:946/965/981/992`.** These already honour `--json` on the fault path, deliberately: the comment at `:955-960` says throwing instead "produces no finding and no JSON at all, so the one command an operator runs to find out what is wrong answers with a stack trace." Under the band split those four are **outcomes** — the report was produced — so they keep the normal payload on stdout with `ok: true`, and only their *code* changes (`22` no hub, `30` unreadable-hub, `31`/`30` for schema-ahead and half-migrated as the finding's severity decides). Do not move them to the error envelope.

**Cost, measured.** Five test assertions pin a code this moves: `test/cli-routing.test.mjs:57` (shadow 3→31), `test/cli-routing.test.mjs:69` (canary/no-profile 1→22), `test/hub-doctor.test.mjs:778` (`build status` on an unreadable hub 1→30), `test/hub-doctor.test.mjs:111` (`builder doctor` tolerates only 0|1), `test/hub-locks.test.mjs:232` (`build run` lease held 1→33 — and that assertion's own name says "exits non-zero" while the check says `=== 1`, so it is stricter than its stated property and should be relaxed regardless). Plus one line each in `README.md:89` and `bin/reeve:1723`.

**Write the Nagios refutation into the table's header, not into a plan document.** The monitoring-plugins guidelines (https://www.monitoring-plugins.org/doc/guidelines.html, Table 2) specify 0/1/2/3 = OK/WARNING/CRITICAL/UNKNOWN and define 3 as covering "Invalid command line arguments ... or low-level failures internal to the plugin ... The --help or --version output should also result in Unknown state." That is four unrelated conditions on one code plus a `--help` rule reeve has already actively defended: `bin/reeve:442` is `if (flag("help")) { usage(); process.exit(0); }` with a comment recording that `reeve restore --hub --help` once performed the restore, and `test/cli-flags.test.mjs:244` asserts it. Cite that test:line in the header. A later author reaching for the plugin guidelines will change the code before reading the comment; they will not get it past the suite. reeve's `3` also *looks* Nagios-shaped, which is why the refutation has to live where the codes live.

### 2.2 Error kinds

Closed, frozen, snake_case. `kind` is finer than `code`: several kinds map to one code, as `reason` is finer than `code` in AIP-193 (https://google.aip.dev/193, "must not use the same (reason, domain) pair for logically different errors"). `retryable` is per **kind**, not per code.

| kind | exit | retryable | fires when |
|---|---|---|---|
| `unknown_flag` | 20 | no | a flag not in `FLAGS` |
| `flag_not_applicable` | 20 | no | a declared flag not in `APPLIES[cmd]` |
| `flag_missing_value` | 20 | no | a `value: true` flag at end of argv |
| `unknown_subcommand` | 20 | no | e.g. `reeve task frobnicate` |
| `bad_argument` | 20 | no | a positional that will not parse |
| `no_credential` | 21 | no | gh not authenticated, App key unreadable |
| `sandbox_denied` | 21 | no | the sandbox refused the read |
| `no_repo` | 22 | no | cwd is not a repo / nwo does not resolve |
| `no_profile` | 22 | no | no sidecar profile for this nwo |
| `no_state_db` | 22 | no | guardian per-repo store absent |
| `no_hub` | 22 | no | hub absent |
| `no_snapshot` | 22 | no | restore found nothing |
| `no_task` | 22 | no | `task show|why` on an id the hub does not hold |
| `store_unreadable` | 23 | no | opens, cannot be understood |
| `schema_ahead` | 23 | no | a schema version this binary does not know |
| `migration_incomplete` | 23 | no | a half-completed first migration |
| `hub_damaged` | 26 | no | `faultKind() === "damage"` (`src/build/hubdb.mjs:250-285`) |
| `disk_full` | 27 | no | SQLITE_FULL. **Recover line must say: do not restore. There is nothing wrong with the file; a restore needs more room rather than less** (`src/build/hubdb.mjs:409-410`) |
| `db_locked` | 27 | **yes** | `faultKind() === "operational"` |
| `read_only_fs` | 27 | no | |
| `upstream_unavailable` | 24 | **yes** | GitHub or network |
| `quota_exhausted` | 24 | **yes** | |
| `internal` | 25 | no | a caught exception reeve could not classify |

**There is no `unknown` kind.** An error kind always names *what* could not be determined. Write that sentence into the module header.

**Consume reeve's four existing classifiers; build none.**

- `faultKind()` — `src/build/hubdb.mjs:250-285`, → `full` | `operational` | `damage`, each inclusion documented against a measured incident. Its `:277-284` records that misclassifying SQLITE_FULL "sent `build run` and `build status` at `restore --hub --force`, which replaces an intact hub and does not free a single byte." The cost of a second classifier has already been paid once in this repo.
- `worst()` — `src/verdict.mjs:32-36`, BLOCK > UNKNOWN > PASS, for any aggregation (doctor's verdict, a task's state, the dash headline).
- `hubAccess` — `src/build/hubaccess.mjs:35-45`, three answers encoded positionally.
- `retryableFrom()` — `src/outbox/effects.mjs:171`, the GitHub-specific classifier, consumed at `src/db/ops.mjs:560`.

**Fix the default divergence this exposes.** `src/db/ops.mjs:499` declares `settleOutbox(db, {..., retryable = true})`; `src/build/outbox.mjs:451` declares `settleEffect(db, {..., retryable = false})`. Same field, same protocol, opposite default. A caller that omits it gets a retry in the guardian store and a dead letter in the hub store. Latent today (`settleEffect` has no production caller outside `test/`), which is the cheapest moment to remove it. Make both required.

**`fail()` must work before the parser exists.** Two failure exits fire before `flag` and `HOME` are declared: `bin/reeve:224-229` (the Node ≥24.10 floor, above `const argv` at `:232`) and `bin/reeve:422-427` (the parser's own error path; `flag` is defined at `:429`, `HOME` at `:437`). Those are the paths a wrapper hits first.

```js
const wantsJson = process.argv.includes("--json");   // argv, not the parse
const fail = (kind, message, { details = null, hint = null } = {}) => {
  const exit = EXIT_FOR[kind];               // throws on an unknown kind: a typo can never become exit 0
  if (wantsJson) console.error(JSON.stringify(envelope({ kind: cmdPath(), exit, error: {
    kind, message, hint, details, retryable: RETRYABLE.has(kind) } })));
  else { console.error(`reeve ${cmdPath()}: ${message}`); if (hint) console.error(`  recover  ${hint}`); }
  process.exitCode = exit;
};
```

`resolveHome()` is called lazily per `src/home.mjs`'s rule; `cmdPath()` returns `""` before the parse.

**Message shape**, from rustc's diagnostics guide (https://raw.githubusercontent.com/rust-lang/rustc-dev-guide/master/src/diagnostics.md, all verified verbatim): "matter of fact and avoid capitalization and periods"; identifiers "surrounded with backticks"; "The word 'illegal' is illegal. Prefer 'invalid'"; "The error or warning portion should not suggest how to fix the problem, only the 'help' sub-diagnostic should"; and "general and able to stand on its own, so that it can make sense even in isolation." The last is load-bearing here for a reason rustc does not have: `src/notify.mjs:71` sends this text to a phone with no surrounding terminal, capped at 700 chars and redacted.

**Settle the two live recover-line prefixes.** reeve has both, and `->` currently carries rustc's *help* and *note* roles indiscriminately:

- `  recover  <command>` — 7 sites: `src/build/hubdb.mjs:394,398,411,415`, `src/backup.mjs:1078,1121,1294`
- `-> <anything>` — 16 sites, of which `src/doctor.mjs:314` is `-> reeve lane reap --dry-run` (a *help*) and `src/doctor.mjs:358` is `-> reeve is meant to be unable to change the rules that judge it; narrow these` (a *note*)

Assign: **`  recover  ` is the help and carries a literal, copy-pasteable command. An un-prefixed indented second clause is the note and carries what it means. Retire `->` from failure text.** `src/doctor.mjs:878` and `:912` are notes wearing a help's prefix today. Make `src/build/hubdb.mjs:391-416` the reference implementation named in `src/fail.mjs`'s header. Add `reeve explain <kind>` as one static map, which is what buys the freedom to keep the first line to one clause.

**Refusals: adopt code 31, and build only the missing wire.** Most of this exists. `src/build/phases.mjs:81` is `refuse(refusal, extra)`; `src/build/transition.mjs:756-765` is `refuseDurably()`, whose comment at `:760` says "a refusal with no record is indistinguishable from a report that was never made"; `phases.mjs:107-133` throws on an unknown hold reason and refuses `blocked_other` with an empty escalation identity, reasoned as "NONEMPTY, not merely non-null ... A null check alone was one shape short of its own stated purpose." The rationale is already on disk. **What is missing: nothing feeds it back.** Build exactly one thing — the redispatch path in `src/prompts.mjs` reads the most recent `phase_event` refusal for this task and phase and puts it verbatim into the next turn's prompt, with the `kind` and, where `phases.mjs` names one, the alternative that would be accepted. One SELECT, no schema change. OpenAI's measured result for the same wire: "Codex continues after a denial and successfully finds an acceptable solution in more than half of cases" (https://alignment.openai.com/auto-review/).

### 2.3 The `--json` envelope

Exactly one JSON object on stdout, on every route, success and failure alike.

```json
{
  "format_version": "1.0",
  "kind": "task.why",
  "ok": true,
  "exit": 0,
  "complete": true,
  "data": { "...": "payload" },
  "error": null,
  "meta": { "at": "2026-08-28T09:14:02.117Z", "home": "/Users/mobeen/.reeve", "reeve_version": "0.1.0" }
}
```

Failure keeps all eight keys and the **route's** kind, not the error's:

```json
{
  "format_version": "1.0",
  "kind": "task.show",
  "ok": false,
  "exit": 22,
  "complete": false,
  "data": null,
  "error": { "kind": "no_task", "message": "no task `bt:nope` in the hub at ~/.reeve/hub.db",
             "hint": "reeve task list", "details": { "hub": "/Users/mobeen/.reeve/hub.db" },
             "retryable": false },
  "meta": { "...": "..." }
}
```

| key | type | invariant |
|---|---|---|
| `format_version` | string `"MAJOR.MINOR"` | one definition site in the whole repo, asserted (§2.4) |
| `kind` | `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$` | the resolved route path with `.` for spaces: `task.why`, `builder.doctor`, `doctor`. Same on both paths. |
| `ok` | boolean | `ok === (error === null)` **and** `ok === (exit is in the outcome band)`. **`ok` is the band.** |
| `exit` | integer | a member of `EXIT`, and **equal to the process's actual exit status** |
| `complete` | boolean | `false` ⟺ some section is `UNREADABLE`. Never omitted, never inferred. |
| `data` | object or null | non-null iff `ok`. Lists are `{items: [...], count: N}`, never a bare array. |
| `error` | object or null | non-null iff `!ok`. Required `kind` and `message`; `hint`, `details`, `retryable` always present, possibly null. |
| `meta` | object | `{at, home, reeve_version}` |

Field names for `error` are the CLI Spec's own (`kind`, `message`, `hint`, `details` — https://clispec.dev/), not invented ones; `retryable` is an additional key the spec permits, derived from the kind table so the flag and the table cannot disagree.

**`ok` states that the route produced its answer; it does not state health.** A degraded answer is `ok: true, exit: 3, data: {...}, error: null`, and *what* is degraded is named inside `data.sections`. There is no null-error `ok: false`.

**Why `ok` and not a separate `band`.** They are the same fact. `band` would be a second inventory of `exit`, which `src/build/tables.mjs:10-12` already bans in this repo.

**Why there is no `meta.command`.** It is `kind`. Same rule.

**Per-section node shape** (`data.sections.<name>`):

```json
{ "state": "RECORDED", "reason": null, "error": null,
  "rows": [ { "source": { "table": "phase_run",
                          "key": { "task":"bt:01JKQ8","generation":3,"phase":"GATE","slice":0,"attempt":3 } },
              "at": 1787551262, "status": "failed", "truncated": true,
              "session_id": "018f2c…",
              "contract_drift": { "cli_version": { "snapshot": "2.1.4", "live": "2.2.0" } } } ] }
```

Three rules: `state` is always present and always one of the four strings, so a consumer that reads `rows.length === 0` and stops is visibly reading the smaller question; `source` is `{table, key}` with **every** primary-key column, so a `WITHOUT ROWID` composite row is citable and re-fetchable; `contract_drift` is parsed to `{field: {snapshot, live}}`, and if it will not parse the row's section becomes `UNREADABLE` with the parse error in `error`.

**Failure envelope goes to stderr as the last line; stdout stays byte-empty.** Outcomes keep the payload on stdout and emit no error envelope. Human diagnostic prose on stderr is still permitted alongside a `--json` failure — measured, npm 11.7.0: `npm ls --json` with a missing dependency writes one parseable 503-byte document to stdout **and** 219 bytes of `npm error ...` prose to stderr, exit 1. Do not write "stderr stays empty"; write "**a consumer reads stdout only**."

**Per-route test, run twice (with and without `--json`), four checks:**

(a) stdout is byte-empty on the failure path; (b) stderr's last line `JSON.parse`s; (c) the parsed `exit` equals the observed process exit status; (d) **CONTROL**: the same route in a home where the precondition *is* met exits 0 and writes its envelope to **stdout**.

(d) is not optional. An assertion over an empty stdout passes just as well when the route never ran at all, which is `s3.md` §5's dominant defect class reproduced inside the test that exists to close it.

**One object, never a stream.** JSONL stays reserved for `export-events --hub`, which already emits it (`bin/reeve:649`) with a `_manifest` terminator line (`:679-680`) that its own comment calls "the whole truncation detector". `task why --json` returns its lineage as ordered arrays inside the single envelope.

**Blocking detail `--json` on canary hides:** `reeve canary` writes nine `console.log` lines to stdout at `bin/reeve:919-931`, three of them (`:919-921`) pure progress narration emitted before any measurement exists. Under `--json` every one must move to stderr or the envelope is unparseable. State the stream rule as what was actually measured: *"no module reachable from a `--json` route writes to stdout."* `grep -rl console.log src/` returns exactly two files (`src/daemon.mjs`, `src/db/migrate.mjs`), neither reachable from a `--json` route — but the six routes about to gain `--json` all live in `bin/reeve`, which that grep never looked at.

### 2.4 Versioning

`format_version` is a **string** `"MAJOR.MINOR"`, starting `"1.0"`, exported once from `bin/reeve.flags.mjs`. Delete the two hardcoded `format_version: 1` literals at plan:487 and plan:3142.

| change | version move |
|---|---|
| add a key, at any depth | MINOR (1.0 → 1.1) |
| widen a closed value domain | MINOR, only if the unknown-member rule is published |
| remove or rename a key | MAJOR |
| change a value's JSON type | MAJOR |
| change a key's meaning | MAJOR |
| narrow a closed value domain | MAJOR |
| change an exit code's meaning | MAJOR |
| change the human render | **no move** — the human text is not in the contract |

Consumer rule, published verbatim in `reeve --help` and in `reeve contract`:

> Reject a `format_version` whose MAJOR you do not recognise. Ignore keys you do not recognise. Treat an unrecognised `kind`, `error.kind`, `phase`, `severity`, `classification`, section `state` or waiting substate as UNKNOWN and act on nothing.

Terraform is the one shipping tool with this exact field and a written rule, and its wording is the source (https://developer.hashicorp.com/terraform/internals/json-format): "We will increment the minor version ... for backward-compatible changes or additions. Ignore any object properties with unrecognized names" / "Reject any input which reports an unsupported major version." A key is never removed inside a MAJOR; it keeps being emitted and is listed in `reeve contract` as `{path, since, replaced_by}`.

**One reeve-specific caveat:** protobuf tolerates a rename because the field *number* is the identity. In JSON the *name* is the wire format (which is why buf's `WIRE_JSON` category protects `FIELD_SAME_NAME` and `FIELD_SAME_JSON_NAME`, https://buf.build/docs/breaking/rules/). Rename is always MAJOR here.

**Resolve the plan's self-contradiction.** plan:1408 says "additive fields need a new format_version"; plan:1358 says "New fields are additive and go in a version bump"; plan:1834 instructs the author to say "`format_version` stays `1` because the change is purely additive." All three are defensible because an *integer* version has no notation for "something was added and nothing broke." `"1.0" → "1.1"` makes them simultaneously true and removes the choice.

**Freeze a recursive path+type image, not a top-level key list.** The plan's freeze (plan:1367-1375) is `Object.keys(taskShow(...)).sort()` — top level only. Renaming `waiting.first` to `waiting.now`, changing `age.seconds` from number to string, or flipping `draining` from `null` to `{}` all pass that freeze untouched and all break a consumer.

```js
function image(doc) {
  const types = new Map(), nullable = new Set();
  (function walk(v, p) {
    if (v === null) { nullable.add(p); if (!types.has(p)) types.set(p, new Set()); return; }
    const t = Array.isArray(v) ? "array" : typeof v;
    if (!types.has(p)) types.set(p, new Set());
    types.get(p).add(t);
    if (t === "object") for (const k of Object.keys(v).sort()) walk(v[k], `${p}.${k}`);
    if (t === "array")  for (const e of v) walk(e, `${p}[]`);   // EVERY element, not the first
  })(doc, "$");
  return { paths: [...types.keys()].sort(),
           types: Object.fromEntries([...types].map(([k, s]) => [k, [...s].sort()])),
           nullable: [...nullable].sort() };
}
```

Recording `null` as a *type* makes the image unstable: a path frozen as `$.x:null` from a fixture where `draining` happened to be null reports as a removal, a false MAJOR, the first time the field carries a value. Hence the separate `nullable` set.

**Three controls, or the check reports success while guarding nothing:** a COUNT (`frozen.paths.length >= 40`, not a subset check); no frozen array is empty in the fixture (an empty array contributes no `[]` paths, so everything under it is unfrozen and renameable — `whyModel` returns eight collections and the plan's fixture at plan:1390 inserts a single task in FILED with no events, so as written *every path inside all eight is unfrozen*); and `doc.exit === r.status`. Assert the counter-control by **property** ("the walker finds `$.a.b` as array and `$.a.b[]` as number in a literal it has never seen"), never against a hand-typed joined string: a sorted image puts `$.a.b:array` before `$.a.b[]:number` because `:` is 0x3A and `[` is 0x5B, and a hand-typed expectation with them the other way round goes red against a correct implementation.

### 2.5 Closed value domains

Seven, not six. Declare each once, freeze it, and publish it from `reeve contract [--json]`, generated from the same frozen constants so it cannot drift and reading no database.

| domain | lives in | members |
|---|---|---|
| route `kind` | `APPLIES` / the switch | `doctor`, `builder.doctor`, `status`, `statusline`, `dash`, `shadow`, `canary`, `contract`, `task.file`, `task.list`, `task.show`, `task.why`, `task.dash`, `notify.test` |
| `error.kind` | `ERROR_KINDS` | the 23 in §2.2 |
| `exit` | `EXIT` | the 18 in §2.1 |
| `phase` | `src/build/phases.mjs:42` | **already frozen**, composed from four sub-lists. The contract route reads it; it does not restate it. |
| waiting substate | `WAITING` | `WAITING_FOR_CODEX`, `_NOTICE`, `_FOUNDER`, `_GUARDIAN`, `_QUOTA`, `_CAPABILITY` |
| `severity` | `src/doctor.mjs` | `pass`, `warn`, `fail` — **plus `unknown`**, which `doctor.mjs:1044` needs to stop collapsing UNKNOWN into DEGRADED |
| `classification` | `src/doctor.mjs` | `configuration`, `dependency-outage`, `stale-evidence`, `unsafe-authority` |
| section `state` | `src/build/why.mjs` | `RECORDED`, `NOT_RECORDED`, `NOT_APPLICABLE`, `UNREADABLE` |

`severity` and `classification` are the only closed domains reeve ships on the wire **today** (`builder doctor --json` at `bin/reeve:946` and `:1115` emits a bare array whose every element carries both) and the only two with no freeze at all.

Adding a seventh waiting substate is additive to the schema and **breaking to the consumer**, who has six branches and no seventh. Widening a domain is MINOR only because the unknown-member rule is published. Narrowing is MAJOR.

`reeve contract` also gives the contract test its enumeration for free, closing the class rather than the instance. **Cost to be honest about:** `test/cli-routing.test.mjs`'s opening comment records that `shadow` once landed between three case labels and their shared body and "for a full day the three founder-facing commands all printed the shadow report." The new route needs its own line in that file.

**Derive help from the tables.** The pattern is already proven on one axis: `test/cli-flags.test.mjs:291-295` asserts the help names every command in both directions, with the comment "Derived from the switch rather than a list, because a second list is what drifts." Extend it to flags and exits. Measured drift, present now, in three forms: `usage()` documents doctor, `init --write` and `canary` as three hand-written prose exit statements while shadow's 3, tick's 3 and `builder doctor`'s 0/1/3 are documented nowhere; `usage()`'s `--home` line is a byte-for-byte hand copy of `FLAGS.home.what`; and the comment at `bin/reeve:1116` cites "the CLI's existing doctor convention, documented at bin/reeve:364", where line 364 now sits inside the flag parser's unknown-flag branch.

Add `reeve help exit-codes` in gh's shape: per-route `Additional exit codes:` footers plus "Learn about exit codes using `reeve help exit-codes`" (https://cli.github.com/manual/gh_help_exit-codes). The test: for every command, assert the set of `EXIT.*` constants reachable in that route's source equals `APPLIES[cmd].exits`. Note the direction — derive the expectation from the **table** and check it against the **source**, not the reverse; `s3.md` §5 records a verification shaped to the known-bad string that reported a whole plan family clean while a second spelling of the same defect sat in it.

### 2.6 The closed page list against the digest

Three tiers. reeve arrived at the SRE ladder independently at `src/notify.mjs:6-11`: durable row → dash/digest → phone. Ewaschuk defines a page as "anything that tries to urgently and actively get the attention of a specific human" and routes everything sub-critical to ticket systems or "a daily (or more frequent) report" (https://docs.google.com/document/d/199PqyG3UsyXlwieHaqbGiWVa8eMWi8zzAn0YfcApr8Q/mobilebasic).

**Tier 3 — the phone. Closed at three, and closing it is the decision.**

| identity | why it pages |
|---|---|
| `builder:sandbox:canary-failed` | the sandbox credential read is open; nothing may dispatch |
| `builder:backup:failed` | durable state is not being protected |
| `bt:<id>:phase:blocked:<phase>` | only the founder can unblock, and the cost is context rebuild |

**`builder:probe:merged` is not on this list and writes the HALT marker** that every dispatch and effect checks, failing closed (design:487). That is a founder ruling, not an omission to fix silently. See §5.

**Tier 2 — the pushed digest.** Everything else: the remaining 23 of the 26 identities at design:747, including every `phase:failed`, `infeasible`, `depth:post-approval`, `lease:conflict`, `lease:starved` and `cancel:draining`. ntfy `priority: low` (2). Never `min` (1), which does not visibly appear until the drawer is pulled down (https://docs.ntfy.sh/publish/).

**Tier 1 — the durable row.** All 26, always, regardless of tier. Retirement is never inferred from a tick's silence: `src/daemon.mjs:3260-3288` already refuses to, and carries its measured incident (nextly #834 retired and re-announced twice, four and twenty-five minutes apart, identical text). Alertmanager's `group_interval` (default 5m) exists for the same reason.

**Inhibition** (https://prometheus.io/docs/alerting/latest/configuration/ — verified: "an alert that matches both the target and source side of a rule cannot be inhibited by alerts for which the same is true (including itself)"):

```js
// A consequence of a cause already paged is not a second interruption. It keeps
// its durable row and reaches the digest; it does not reach a phone. Neither
// source can ever match the target regex, so nothing here inhibits itself.
const BLOCKED = /^bt:[A-Za-z0-9]+:phase:blocked:[A-Z][A-Z_]*$/;
const INHIBITS = Object.freeze([
  Object.freeze({ source: "builder:sandbox:canary-failed", target: k => BLOCKED.test(k) }),
  Object.freeze({ source: "builder:backup:failed",        target: k => BLOCKED.test(k) }),
]);
export const inhibited = (key, standing) =>
  INHIBITS.some(r => r.target(key) && standing.has(r.source));
```

Read `standing` from `SELECT why FROM escalation` **after** `builderAnnounceable` has run. Reading `fresh` would page every blocked task on the tick the canary failed and inhibit only afterwards, which is the tick that matters.

Second, independent argument for inhibition: OWASP classifies **Overwhelming Human-in-the-Loop as T10** (https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/), and the builder is dispatched against pull requests outsiders can open. An attacker who can raise `bt:*:phase:blocked:*` at will is inside that threat model.

**Page bodies must carry the `next`.** `body({type, reason, ...}) → {type, reason, next, ...}` already exists and is tested four ways (plan:2418-2420 asserts "the four next actions are four, not one repeated"), and `announce()` at plan:2945 builds its message from `f.why` alone. The founder's phone receives `bt:7:phase:blocked:RESEARCH` and nothing else. One call and one **seam** test: assert the string handed to the injected `send` contains `b.next` for each of the three paging identities, with a control that a digested identity calls `send` zero times. On the current implementation every `body()` unit assertion stays green and the seam assertion goes red alone. Route `b.reason` through `redact(printable(...))` (`src/notify.mjs:55,60`; `LIMIT` is 700 at `:36`): it is the worker's own string and it crosses the machine boundary.

Do **not** test that `next` names a real command. `reeve task resume` is the natural `next` for a blocked task and `case "task":` ships with `file` as its only subcommand (plan:900). A route-level check would pass on a command that does not exist. Until `resume` lands, the honest `next` is a named absence.

**Instrumentation, so the review point has data.** Founder decision 6 is right that limits are measured before they are chosen, and it names a review point after S3's first week. But `escalation` stores only `announced_count` and `last_seen_at`: it records that an identity was announced four times and never **when**. Nothing computes the rate the decision commits to reviewing.

`hub_event(seq, at, kind, task, payload)` already exists with a `hub_event_kind` index. **No column, no migration:**

```js
hubEvent(db, { kind: "escalation.announced", task: f.task ?? null,
  payload: { why: f.why, disposition: "paged" | "digested" | "declined",
             channels: r.channels.map(c => c.name), ref: r.ref ?? null,
             declined_why: r.why ?? null } });
```

Three corrections that are load-bearing: the disposition is **three-valued**, because `announce()` already returns `{paged, digested, declined, cleared}` and `declined` is a page that was attempted and failed to deliver — a boolean would record a dead ntfy channel as a deliberate policy choice. The channels are **`ntfy` and `desktop`** (`src/notify.mjs:132,152`), taken from `r.channels`, never hardcoded. And `escalation.announced` **must** be added to `NON_REPLAYED_KINDS` in `src/build/replay.mjs:46`, or `test/hub-crosscheck.test.mjs:137-141` fails: it scans every `src/build/*.mjs` for `hubEvent(<db>, { kind: "..."` and asserts every kind found is in `HANDLERS` or in `NON_REPLAYED_KINDS`. The declaration writes itself: a delivery is a record that something left the machine; there is no projection row to restore, and replaying it would claim a second delivery that never happened.

Then five doctor rows in `hubFindings`'s existing vocabulary (`{id, severity, classification, title, detail, action}`), numbered from **H-14** because H-1…H-13 are claimed:

| id | reads | verdict |
|---|---|---|
| H-14 `pages.rate` | `hub_event kind='notify.sent'`, last 14d, summed `count` | pass <1/day · warn 1–4/day · fail >4/day |
| H-15 `pages.repeats` | keys paged ≥3 times in 30d | warn, naming each key |
| H-16 `pages.declined` | `kind='notify.declined'` in 24h | fail, `dependency-outage` |
| H-17 `pages.accuracy` | per key: paged, then cleared with no operator action recorded | warn over 50%; note Ewaschuk's 10% threshold |
| H-18 `heartbeat.armed` | the ntfy DELETE probe result, **passed in** | fail when unsupported or unreachable; **`null` renders warn/`stale-evidence` saying nobody looked, never pass** |

Two of Task 16's rules bind and change the shape: H-18's probe is **network**, so `hubFindings` must take probed facts as inputs and the probe runs at the `bin/reeve` route; and the file must still write nothing, so the `hub_event` write belongs to `announce`, in the tick.

**H-14 must carry its window start.** `pages: 4 in the last 7d, 11 digested, 1 declined (measured since 2026-09-02; SRE guidance: a few per day)`. Without that clause, `0 pages in the last 7d` on a hub whose instrument was installed yesterday reads as a healthy rate, which is the absence-as-success the instrument exists to close. With no `escalation.announced` row ever, severity is `warn` and the text is `pages: UNKNOWN — no announcement has ever been recorded`.

**Do not set a budget.** A budget that *drops* pages is fail-quiet, which reeve forbids. The SRE ceiling of 2 incidents per 12-hour shift (https://sre.google/sre-book/being-on-call/) is for a full-time SRE on a rotation; reeve's operator is one founder with no rotation, so 4/day is an upper bound never to approach, not a target.

**Do not make the page list load-aware.** The load-aware policy that beat the paranoid one in Turan's paper is a **threshold on a guard model's risk score** (θ=35 → 26% escalation vs θ=10 → 88%). reeve has no risk score and no guard model on this path. The paper proposes no batching, no queue-ordering and no rate limiting; its future work is fitted fatigue curves and a self-improving policy loop. The defensible sentence for the `PAGES` comment, and it is enough:

> Escalating everything is measurably worse than escalating some (64% escalation → 42% danger-through, versus 57% under full escalation, at reviewer capacity 25). There is no ground truth about what is risky — three reviewer personas agree only moderately, Fleiss κ = 0.52. So a hand-written closed list of the founder's declared preferences is the right instrument, and the revisit reads H-14's measured rate and decides whether the **list** should change, not whether a budget should be added.

Do **not** write "the lever is the total number of pages ever sent." The paper never states `l`'s reset semantics, and `C` is a swept parameter with no stated unit of time. That would be an inherited hypothesis marked as a measured fact.

---

## 3. `reeve task why`, rendered

```
$ reeve task why bt:01JKQ8

  reeve task why   bt:01JKQ8   "webhook retry backoff"   nextlyhq/nextly
  generation 3 of 3 · read 2026-08-28 09:14:02Z · hub ~/.reeve/hub.db

  VERDICT   ESCALATED · WAITING_FOR_FOUNDER · 4h12m
  BECAUSE   #418  phase.escalated  GATE -> ESCALATED  2026-08-28 05:02:11Z (4h12m ago)
            artifact 7c1f8ab2 · attempt 3 of 3 exhausted at GATE
  NOT       BLOCKED. That would need a hold_reason row at generation 3, and none exists.
            A retry cap is not a founder hold.
  MOVES IT  reeve task resume bt:01JKQ8 --redesign        NOT BUILT YET (S3 ships file|list|show|why)
            reeve task infeasible bt:01JKQ8 --reason ...  NOT BUILT YET
            until those land the honest next step is the GATE run log, printed below.

  == system =====================================================================
  ● escalations (system)                    2 standing, not scoped to this task
      builder:sandbox:canary-failed   since 2026-08-28 04:58:03Z (4h16m)   x3, announced 1
      builder:probe:merged            since 2026-08-27 22:11:40Z (11h03m)  x1, announced 1
  ⚠ halt marker                             PRESENT since 2026-08-27 22:11:41Z
      no dispatch and no effect will run for ANY task while this file exists.

  == lineage · generation 3 only ================  (--generation all: 27 more rows)
  ● transitions                             6 rows
      #401  @0s       task.regenerate     generation 2 -> 3   registry_version 14 -> 15
      #404  @0m14s    phase.entered       SIZING              artifact -
      #409  @6m02s    sizing.recorded     standard            artifact 3f70e1
      #412  @6m03s    phase.entered       SPEC                artifact -
      #417  @3h58m    phase.entered       GATE                artifact 7c1f8ab2
      #418  @4h12m    phase.escalated     GATE -> ESCALATED   artifact 7c1f8ab2   <- decisive

  ● sizing floors                           hub_event #409 · sizing.recorded
      standard, floored up from trivial by: risk-territory, package-span

  ● runs                                    3 rows
      SIZING  slice 0  attempt 1  succeeded  +42s     out ~/.reeve/tasks/bt:01JKQ8/sizing.1.out
      SPEC    slice 0  attempt 1  succeeded  +3h51m   out ~/.reeve/tasks/bt:01JKQ8/spec.1.out
      GATE    slice 0  attempt 3  failed     +6m11s   out ~/.reeve/tasks/bt:01JKQ8/gate.3.out
              TRUNCATED · session 018f2c8e · drift: cli_version 2.1.4 -> 2.2.0

  ◌ gate runs                               NOT RECORDED
      the producing step RAN: see runs, GATE attempt 3, failed at 2026-08-28 05:02:11Z.
      it wrote no gate_run row. that is a fault, not a quiet pass.

  ◌ notices                                 NOT RECORDED
      the producing step HAS NOT RUN at generation 3. no notice has been delivered.

  ◌ holds                                   NOT RECORDED
      no hold_reason row was ever written for this task at generation 3.

  ○ approvals                               NOT APPLICABLE
      the task has never reached SPEC_PR_OPEN at generation 3, so no approval can exist.

  ○ pull requests                           NOT APPLICABLE
      builder.capabilities.publishPr is off.

  ○ drain                                   NOT APPLICABLE
      phase is ESCALATED, not CANCELLING.

  ⚠ merge decisions                         UNREADABLE
      SQLITE_CORRUPT: database disk image is malformed
      this section could not be read. the answer above is PARTIAL.

  ● escalations (this task)                 1 standing
      bt:01JKQ8:phase:blocked:GATE   since 2026-08-28 05:02:11Z (4h12m)  x1, announced 1

  == legend =====================================================================
  ●  RECORDED         rows exist and are shown
  ◌  NOT RECORDED     reeve looked and found no row. the line says whether the
                      producing step RAN and wrote nothing, or HAS NOT RUN.
  ○  NOT APPLICABLE   no row can exist here. the precondition is printed.
  ⚠  UNREADABLE       the read failed. this answer is incomplete.
  @  elapsed since generation 3 began       +  the run's own duration

  incomplete: 1 of 10 sections unreadable (merge_decisions).
  exit 30 (unknown)
  this text is not a stable interface. parse `reeve task why bt:01JKQ8 --json`.
```

**The distinction the brief asks for, made three ways at once.** The glyph separates "no row" (`◌`) from "no row is possible" (`○`) from "the read failed" (`⚠`). Inside `◌`, the second line carries one of exactly two clauses, and it is the whole point:

- **ran, produced nothing** — `gate runs`: the producing step RAN, cross-referenced to the `runs` section by phase and attempt, and the render says out loud that this is a fault. An operator reading `none` would have concluded the gate passed quietly.
- **never ran** — `notices`: the producing step HAS NOT RUN at this generation. Nothing is wrong.

Both are derivable, not narrated: reeve knows from `phase_run` whether the phase executed at this generation. A section that cannot determine which flavour it is prints `the producing step's run state is UNKNOWN` and pushes itself to `⚠`.

**A section with nothing to say still costs exactly one line.** Deleting it is how absence becomes invisible.

**`--json`, the same three sections:**

```json
"sections": {
  "gate_runs":       { "state": "NOT_RECORDED",   "reason": null,
                       "producing_step": { "ran": true,  "run": { "phase": "GATE", "attempt": 3, "status": "failed" } },
                       "error": null, "rows": [] },
  "notices":         { "state": "NOT_RECORDED",   "reason": null,
                       "producing_step": { "ran": false, "run": null },
                       "error": null, "rows": [] },
  "merge_decisions": { "state": "UNREADABLE",     "reason": null, "producing_step": null,
                       "error": "SQLITE_CORRUPT: database disk image is malformed", "rows": [] }
}
```

`complete: false`, `exit: 30`, `ok: true`. The command answered; part of the answer is that it could not determine one section.

**Formatting mechanics.** Extract `src/build/fmt.mjs` with one `ago()`, one `stamp()`, and the glyph table. Measured: `git grep -c isTTY -- src bin` and `git grep -c NO_COLOR -- src bin` both return **nothing** (positive control: `git grep -c console -- bin/reeve` = 109), yet `src/status.mjs:204-250` already emits `┌ ├ └ ─ │ ● ◐ ○ ⚠`. reeve already garbles on a non-UTF-8 terminal and has no fallback path to add one to. ASCII set `* . - ! ?` with `| = \``, selected once at render time from `!process.stdout.isTTY`, `LC_ALL`/`LC_CTYPE`/`LANG`, or `--ascii`, honouring `NO_COLOR` in the same table (https://clig.dev/). Timestamps are UTC-absolute **plus** relative: the operator's local calendar is PKT (+5) and elapsed time here is only meaningful against the hub's clock. `ago()` is currently duplicated verbatim at `src/dash.mjs:18` and `src/status.mjs:29`, and the two disagree on the null case (`""` vs `"?"`); `why` would be the third copy and the second disagreement.

**No transcript, ever.** `src/build/hub.sql:189-191` already stores `out_path`, `err_path` and `truncated`. The log is on disk and addressable, so "give the operator the log" is solved and a transcript would be a second, more expensive answer. There is also a hard boundary: `src/notify.mjs:22-34` says escalation text "can carry a slice of a CI log, and a CI log can carry a token that was echoed by a failing command." Guard it as a **provenance** test, not a length test:

```js
const srcs = ["why.mjs", "dash.mjs", "announce.mjs"].map(f =>
  readFileSync(new URL(`../src/build/${f}`, import.meta.url), "utf8"));
for (const s of srcs)
  check(!/readFileSync|createReadStream|openSync/.test(s),
    "no read-model renderer opens a file", s.match(/readFileSync.*/)?.[0] ?? "");
// CONTROL: the pattern can still match a read it has never been shown.
check(/readFileSync/.test('const b = readFileSync(out_path);'),
  "counter-control: the negative pattern is still live");
```

The counter-control is mandatory. A negative regex that stops matching after a rename prints PASS while guarding nothing, and this repo already has two such assertions in production (plan:2320-2322).

**No DAG, no signing.** The premise does not survive the schema. `phase_event.seq` is `INTEGER PRIMARY KEY` with `phase_event_task(task, seq)` — a total order per task. `outbox.fence` is a single-parent FK whose own comment at `hub.sql:481` says "`fence` is a FOREIGN KEY, not just an integer that happens to hold a seq." The only fan-out is `slice`, bounded by `est_slices`. Render slices as an indented fan under their parent transition. `nix why-depends`, the closest-named prior art, prints one shortest path by construction and puts every edge behind `--all` (https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-why-depends). Signing fails on a separate premise: in-toto and SLSA exist to convince a **second party** about a build they did not run. reeve has one operator, one machine, one local SQLite file that operator owns. The threat model is "I forgot what happened", not "someone forged the hub." If cross-machine trust ever arrives, the move is a hash chain over `hub_event.seq` with `node:crypto`, still zero dependencies. Record that so the next author does not reach for DSSE.

---

## 4. What reeve already gets right

Do not "improve" these. Each is a decision with a measured incident behind it.

**The UNKNOWN model, four times over**
- `src/verdict.mjs:32-36` — `worst()` is BLOCK > UNKNOWN > PASS, "so a clause that could not answer cannot be outvoted", backed by `:13-15`: "Every fail-open defect measured in the previous system was an UNKNOWN silently rendered as PASS: an absent gate script read as a pass, a rate-limited reviewer reporting state=success, a fork PR with zero check runs."
- `src/verdict.mjs:241-248` — the hold clause is **omitted entirely** when the caller passes nothing, not defaulted to UNKNOWN, because "a guardian built before the hub existed has no opinion about holds, and an UNKNOWN clause would drag every verdict it renders to UNKNOWN for a question it was never asked." Absence there is a fourth value, NOT-APPLICABLE. Any "mandate the triple everywhere" rule must exempt it or every pre-hub guardian's verdict becomes UNKNOWN and every merge stops.
- `src/build/hubaccess.mjs:35-45` — "THREE ANSWERS, NOT TWO, and the earlier version had two", encoded positionally as two nulls versus one.
- `src/doctor.mjs:1049-1051` — `render()` already iterates `[BROKEN, DEGRADED, UNKNOWN, OK]` as four bands. Only the machine-readable answer collapses them (`:1044`), which is a one-line fix.

**Synthetic findings on the fault path** — `bin/reeve:943-947`, `:963-967`, `:979-983`, `:990-994`, and `:1104-1114` (five sites, not four). Each builds an ordinary finding and renders it through the ordinary renderer, so the human and the `--json` consumer receive the same object graph on the fault path as on the healthy path. H-7's severity is `fail` rather than `warn` **deliberately**: with no expected projects every absent-row H-4 is suppressed, so this one finding stands in for an unknown number of hidden ones. This reads as collapsible boilerplate. It is the template every S3 read route copies.

**One classifier per question** — `faultKind()` at `src/build/hubdb.mjs:250-285`, whose `:277-284` records that one wrong classification "sent `build run` and `build status` at `restore --hub --force`, which replaces an intact hub and does not free a single byte." `retryableFrom()` at `src/outbox/effects.mjs:168-181`, with its stated default: "Retrying is the default, because an unrecognised error is more often transient than terminal."

**The best error message in the codebase** — `src/build/hubdb.mjs:391-416` spends 25 lines separating two causes of SQLITE_FULL and then names the wrong fix and tells the operator not to take it: "Do NOT restore over it in either case: there is nothing wrong with the file, and a restore needs more room rather than less." That is the reference implementation.

**Attention discipline, arrived at independently**
- `src/notify.mjs:6-11` — the three tiers, which are Ewaschuk's ladder.
- `src/daemon.mjs:3229-3288` — `announceable` is **two** anti-desensitisation mechanisms, not one: `announced_count` change-detection kills desensitisation from repeated exposure; the closed `PAGES` list kills cognitive load from distinguishing informative alerts. Ancker et al. 2017 separated exactly these (~30% acceptance drop per additional repeat; ~10% per five-point rise in the proportion of repeats). **Write down that neither substitutes for the other**, because they look like one mechanism and that is how one gets deleted.
- `src/daemon.mjs:3260-3288` — refusing to retire on a tick's silence, with its incident already recorded.
- `src/status.mjs:182-199` and `:213` — `NEEDS YOU` leads and carries "target state: EMPTY"; `needsYou()` at `:185` collapses a shared cause into one row: "Four PRs on a red base is one problem." Jules interleaves progress, errors and requests for input into one activity feed (https://jules.google/docs/code/); Amp plays the same sound for "task complete" and "blocked on you" (https://ampcode.com/manual). reeve's split is a deliberate divergence from what every comparable ships, and it is the kind of decision a later author "fixes" into a timeline because timelines look richer.
- `src/dash.mjs:1-9` — the no-server rationale, and "a dashboard with six equal numbers has no headline. Clean-merge rate is that number: it read 0% on the system this replaces while every vanity metric looked healthy."

**CLI behaviour already defended by a test** — `bin/reeve:442` prints help to stdout and exits 0, with a comment recording that `reeve restore --hub --help` once performed the restore, and `test/cli-flags.test.mjs:244` asserts it. `bin/reeve:867` — `statusline` degrades to one quiet word and exits 0. `bin/reeve:426` prints the flag error plus recover lines. `test/cli-flags.test.mjs:291-295` derives the help-completeness assertion from the switch, "because a second list is what drifts."

**No second inventory** — `src/build/tables.mjs:10-12`: "PROSE_TABLES is transcribed BY HAND ... deliberately not derived from TABLE_OWNERS: two lists built from one source agree with each other and prove nothing." `src/build/phases.mjs:42` composes `PHASES` from four frozen sub-lists; the contract route reads it rather than restating it.

**Refusing to migrate silently** — `src/db/ops.mjs:66-102`: `RESHAPED` throws at `open()` rather than rebuilding a non-empty table, "Silently copying between shapes loses whatever the new key was added to distinguish." `src/build/outbox.mjs:81-102` does the same.

**NDJSON where it belongs, with a terminator** — `bin/reeve:649` emits one object per line to a **file**, and `:679-680` appends a `{_manifest:{count,first,last,...}}` line whose comment calls it "the whole truncation detector" and records that an earlier revision described it and never wrote it, so every `restore --hub --tail` was refused for a footer no exporter had ever produced. That is cargo's `build-finished` and Terraform's `version`-first convention, arrived at independently and already paid for once.

**The read model's own conventions** — `READ_FORMAT_VERSION` declared once in `src/build/show.mjs` and imported by `why.mjs` and `dash.mjs`; the `THE HUMAN TEXT IS NOT A STABLE INTERFACE. Parse --json, never this.` comment at the top of every renderer. Both look like things to tidy. A `WHY_FORMAT_VERSION` looks like better encapsulation and is the change that lets `list`, `show` and `why` drift into three contracts for one operator with one parser.

**Signals** — `src/supervisor.mjs:97` exits 130 on SIGINT and 143 on SIGTERM. That is 128+N and it is correct.

**`WAITING_FOR_CAPABILITY` is better than fail-fast.** `droid exec` "exits `0` on success and non-zero on failure (permission violation, tool error, unmet objective)" — three unrelated kinds behind one code, with `is_error` a bare boolean (https://docs.factory.ai/droid-exec/overview). A switch the founder set is **configuration**, so the task rests in phase with a derived substate and no escalation. Anyone benchmarking reeve against that tool will read reeve's resting task as a missing error. Put one comment beside `PAGES` naming the contrast so it does not get "fixed" into a `phase.failed`.

---

## 5. What this research does not settle

### Needs a measurement, not a citation

1. **The page rate.** Nothing records that a page happened. H-14 is the instrument; the decision that reads it does not exist yet and cannot until at least one week of `escalation.announced` rows exists. Do not choose a budget before then, and do not treat "0 pages last week" as healthy until H-14 prints its window start.
2. **`DECIDE_SECONDS`** in any `waiting_on_you` ranking is a **declared proxy**, not a measurement. There is no acknowledged-at timestamp to difference against. Label it as a proxy in the code and replace it the first time one exists. Smith's rule (non-increasing w/p is optimal for 1‖Σw_jC_j) gives the right *shape*; the numbers in it are guesses.
3. **Page accuracy** (H-17). Ewaschuk's "alerts less than 50% accurate are broken; even those false 10% of the time merit more consideration" needs reeve's own numerator and denominator, and "cleared with no operator action recorded" is a proxy for "was a false alarm" that has not been validated.
4. **Whether `task list --json` actually reaches 60 tasks.** The 64 KiB threshold is arithmetic from a measured 841-byte row. The truncation bug is real regardless; the *urgency* depends on task volume nobody has measured.
5. **ntfy dead-man's-switch support** must be probed behaviourally on the operator's actual server, not inferred from a version string. Below v2.16.0 the switch silently does not exist.

### What n = 1 cannot tell us

- **The alarm-fatigue numbers do not transfer cleanly.** The 72–99% false-alarm figures and the 18.8% acknowledgement rate come from clinical units with shift handoffs; the 2-incidents-per-12-hour ceiling is for an SRE on a rotation. reeve's operator has no rotation, no handoff, and no second reader. The *direction* transfers; the thresholds do not.
- **The U-shape's parameters are unbound.** Turan's `C` is swept at 10/25/50 with no stated time unit, and `l`'s reset semantics (per episode, per session, per day) are unspecified. "Capacity 25" cannot be mapped onto one founder's day without inventing the mapping.
- **There is no ground truth about what is risky.** Fleiss κ = 0.52 across three reviewer personas in that same paper. The closed page list is therefore a founder's declared *preference*, which is the only defensible thing to page on when no truth exists to be right about. It cannot be validated, only revised.
- **One operator means no A/B.** The three-times-daily digest cadence comes from an n=237 randomised field experiment on phone notifications. It is the best available evidence and it is about a different population and a different device. Treat it as a starting point to revise, not a finding about reeve.

### Conflicts that need a founder ruling

1. **Exit numbering.** Three tables were proposed: 20–34 with 3 retired; 1–8 with `4 unknown / 5 blocked / 6 refused / 7 damaged`; and the plan's `{ok:0, refused:1, misuse:2, degraded:3}`. §2.1 recommends a fourth (keep 0/1/2/3, add 20+/30+), because it is the only one that keeps both grandfathered numbers and stays out of Node's 4–14. **Ruling needed, and it decides the README line.** The specific sub-question: is `misuse: 2` (plan:450) dropped, or is `init`'s `2 = changed` (`src/init.mjs:322,326`, `bin/reeve:1731`) renumbered? They cannot both stand.
2. **Retire 3, or keep it as `degraded`?** §2.1 keeps it. The counter-argument is that a number that meant three things is poisoned and burning it is cheaper than trusting every future author to read the comment. Keeping it saves one README edit and one `usage()` edit and preserves a published contract; retiring it costs those and removes the risk permanently.
3. **The escalation `(kind, subject)` decomposition is gated.** The diagnosis is confirmed: 47 `raise()` sites in `src/daemon.mjs`, only five stable identities, `:1223` interpolates `${err.message}` into a `TEXT PRIMARY KEY`, and `announceable` at `~:3277` already regex-extracts a subject back out of that key. But changing the primary key requires a table rebuild, and the guardian's only rebuild mechanism (`src/db/ops.mjs:66-102`) **throws at `open()` when the table has rows** — which it has by construction, since the table holds the standing set. The additive shape (two nullable columns plus a unique index, `why` stays the primary key) avoids that, but adding columns triggers tracker §4 decision 9: "If any S3 task finds it needs a column, #43 lands first." **Ruling: does the decomposition wait for #43, or does S3-E ship without it?**
4. **`builder:probe:merged` halts everything and does not page.** It writes the HALT marker every dispatch and effect checks, failing closed. It is not on the Q8 page list of three, and until the system-escalation band lands it is invisible in `why` too. **Ruling: does it page, or is the halt marker's own visibility in `why` and `dash` sufficient?**
5. **`--at <seq>` is only partly sound.** `phase_event`, `hold_reason` and `task_drain` are append-only and addressable. `escalation.count` and `provider_lease.status` are updated in place, and `phase_run.status`/`outcome`/`evidence` settle in place, so those three sections can only ever render AS OF NOW. The honest version ships `--at` with an `as_of_now: ["escalations","lease","runs.status"]` array and a printed disclaimer. **Ruling: ship it with the caveat, or defer `--at` until those tables carry history?**
6. **Ordering against the Task 6 fixture.** Several additive fields (`session_id`, `at_seq`, `as_of_now`, `headline`, `sections` replacing `absent`) are free if they land **before** Task 6 Step 1 generates `test/fixtures/read-model-v1.json`, and cost a `format_version` MAJOR plus a regenerated fixture if they land after. **This is a scheduling ruling with a real price tag, and it expires when Task 6 runs.**
7. **The identity count disagrees with itself.** The brief says 23. Extracting from `docs/2026-08-21-builder-design.md:747` gives 26. S3 names 9. These are three different populations (all-time, design-listed, S3-reachable) and nothing states which is which. Reconcile before any comment cites a number.
8. **`next_action` is a string today.** S3-B asserts `typeof r.next_action === "string" && r.next_action.length > 0` (plan:739-740) and ships `"none: the builder tick takes FILED to SIZING with no further condition"` (plan:871). Its entire information content is English prose, so a script must regex it or ignore it, across six waiting substates and 26 identities. Changing it to `{kind, actor, command: [argv], human, derived_at}` is free before T3 ships and a break afterwards. **Ruling now, because T3 is unbuilt (`s3.md` §1: STATE `—`).**
9. **`reeve digest --send` scope.** A new plan, or squeezed into S3-E? It needs a per-platform schedule binding (launchd, systemd timer, Task Scheduler), and `deploy/` today holds one plist and zero timers. Related: R20's dead man's switch is filed out of S3-E at plan:3735 and filed as "S3 or S4" at `S3-DESIGN-BRIEF.md:768`. Both are decided above and neither is scheduled.
10. **Two research recommendations conflict on `--json` coverage.** `s3.md` §4 decision 7 says implement it on every read surface; `MASTER-PLAN.md:4593` (R7) offers "or refused where it is not." §2.1/D1 follows decision 7. If the founder wants the cheaper path, R7's wording is still in the plan and would need to win explicitly rather than by being the older text.

### One correction to make regardless

`grep -rn "23-minute\|23 minute\|23 min" tasks/ docs/ src/` returns **four** lines, all under `tasks/`: `S3-DESIGN-BRIEF.md:991`, `S3-AUDIT-REPORTS.md:2581`, `:2706`, `:4834`. Line `:2581` attributes "23 minutes 15 seconds" to Mark, Gudith & Klocke CHI 2008 **with a direct link to the PDF**. The paper does not contain the number and reports interrupted tasks completing *faster* (20.31 / 20.60 min vs 22.77 min uninterrupted) at higher stress and frustration (https://ics.uci.edu/~gmark/chi08-mark.pdf; provenance trace at https://blog.oberien.de/2023/11/05/23-minutes-15-seconds.html). The figure traces to a 2006 interview.

Replace with Parnin & Rugaber 2011 (10,000 recorded sessions, 86 programmers, https://link.springer.com/article/10.1007/s11219-010-9104-9): "only 10% of the sessions have programming activity resume in less than 1 min after an interruption." It is a better fit anyway, because it is about programmers, and it does not weaken the conclusion: the cost is context rebuild, not wall clock, which is exactly what a `bt:<id>:phase:blocked:<phase>` page costs a founder mid-task.

The page-list decision is correct and worth defending. It is currently defended by the single most-debunked productivity statistic in circulation, marked "measured", hyperlinked to a paper that says something else. A later author who checks the one load-bearing citation finds it hollow and concludes the whole list was arbitrary.
