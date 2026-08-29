// A recorded, reproducible signature for the guardian's tick.
//
// WHY THIS EXISTS. Issue #50 moves the provider and hub mechanics out of a
// 2,282-line `tick()` into a session that owns the rules. The move is worth
// doing because the findings it is meant to prevent are all one shape -- a rule
// that must hold at N call sites, applied at N-1 -- but a move of that size is
// exactly where behaviour changes by accident and nobody notices, because the
// suite asserts PROPERTIES and a reordering can preserve every property while
// changing what the tick actually did.
//
// So the tick's observable behaviour is recorded here, byte-for-byte, BEFORE
// anything moves. The artifacts are the review: a step that changes one is
// either wrong or is declaring a deliberate change.
//
// WHAT IS RECORDED, and the order is deliberate:
//
//   1 SEAM LOG    every scheduler seam call, in order, with its arguments.
//                 The ORDER is the signal -- a reordering that preserves every
//                 property still shows here.
//   2 ESCALATIONS the keys, sorted. Keys not counts: a count changes when a
//                 loop runs twice, which is noise, and the KEY is the contract.
//   3 LOG FILE    the tick's own log, normalised. Line order is the signal.
//   4 RESULT      halted / unreadable / the decision actions.
//   5 CARRIED     the retry obligations left in ctx for the NEXT tick. A move
//                 that drops one is invisible in every other field.
//
// REDACTION IS REQUIRED, AND IT IS ALSO THE MOST DANGEROUS PART OF THIS FILE.
// Every value it normalises is a value the signature can no longer see, so a
// pattern that is wider than its reason blinds the comparison to real
// behaviour. Each one is therefore justified by a measurement, and the controls
// below re-run that measurement on every suite run.
//
// TO APPROVE A CHANGE:  REEVE_APPROVE=1 node test/characterise-tick.test.mjs
// Approving is a deliberate act and the diff is the thing a reviewer reads.

import { run, CLAIM_TOKEN, SCHEDULER_SEAMS, SCHEDULER_FALLBACKS } from "./fixtures/tick-harness.mjs";
// DERIVED, not restated. A scenario that hard-coded "rate_limited" would keep
// naming an outcome the supervisor had since renamed, and the branch it is meant
// to reach would simply stop being taken.
import { OUTCOMES } from "../src/supervisor.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const APPROVED = join(HERE, "fixtures", "tick-approved");
const APPROVE = process.env.REEVE_APPROVE === "1";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// HOST PATHS, DERIVED FROM THE RUNNING PROCESS rather than described.
//
// Both of these were once written as shapes -- `/tmp` or `/var` for the
// temporary root, "ends in /bin/node" for the interpreter -- and a shape is a
// description of THIS machine. `TMPDIR` moves one anywhere; Windows gives the
// other a form like `C:\Program Files\nodejs\node.exe`, which has a space in
// it, no `/bin/`, and separators that are doubled when it lands inside a JSON
// string. Neither shape matches there, so the artifacts mismatch and the
// controls that police the redaction fail with them.
//
// Two forms each, because these paths appear both bare (in the log's prose) and
// inside JSON strings (in seam arguments), and the two differ wherever a
// separator needs escaping. Longest first, or a shorter form wins as a prefix
// of a longer one.
const reEscape = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pathForms = (p) => [...new Set([p, JSON.stringify(p).slice(1, -1)])]
  .sort((a, b) => b.length - a.length).map(reEscape).join("|");

// The realpath of the temporary root gains a `/private` prefix on macOS that the
// environment variable does not carry, and the fixture's directories sit under
// it, so the trailing run of path characters is part of the match.
const TMP_RE = new RegExp(`(?:/private)?(?:${pathForms(tmpdir())})[^\\s"'),\\]]*`, "g");

// MEASURED against every scenario: the only interpreter path any artifact
// contains IS `process.execPath`, so matching it exactly loses nothing and
// removes the guesswork about what a node binary's path looks like.
const NODE_PATH_RE = new RegExp(pathForms(process.execPath), "g");

/**
 * Redaction, by MEASURED provenance rather than by name.
 *
 * Each pattern declares WHY it exists, and there are exactly two admissible
 * reasons:
 *
 *   "varies"      the value differs between two runs of one scenario in this
 *                 process. Proved by the control below: remove the pattern and
 *                 the two runs must stop matching.
 *   "provenance"  a same-process pair CANNOT show it varying -- the process id
 *                 is fixed for the life of the process, the interpreter path for
 *                 the life of the machine, and a whole-second clock reading for
 *                 the whole second, so two runs a few hundred milliseconds apart
 *                 record the same one. Differencing them is a control that
 *                 passes or fails on timing, which is no control at all. Each of
 *                 these instead asserts where the removed value CAME FROM, which
 *                 is the actual reason for removing it, and that claim is
 *                 deterministic.
 *
 * WHAT THIS REPLACED, AND WHY IT MATTERS. The previous list redacted by NAME:
 * every `"id"`, every `"token"`, `runRef`, `lstart`, every `*_at`, every 40-hex
 * string. Measured against this fixture, not one of them varies -- the harness
 * builds a fresh database per run and the claim answers deterministically -- so
 * every one of them was BEHAVIOUR being blanked, and four of them never matched
 * anything at all. Under that redactor a refactor that released lease 2 instead
 * of the claimed lease 1, or released under a different run reference, or sent
 * the worker at a different head, produced a byte-identical artifact.
 *
 * A pattern is only ever as narrow as its reason. `"id"` is not a reason;
 * "this value came from the clock" is.
 */
const EPOCH_RE = /"(observedAt|expiresAt)"\s*:\s*(\d+)/g;

/** A stamp's distance from the artifact's origin. Signed, so a stamp BEFORE the
 *  origin is visible rather than silently clamped. */
const offsetOf = (v, t0) => (v === t0 ? "" : `${v < t0 ? "-" : "+"}${Math.abs(v - t0)}`);

/** The earliest stamp anywhere in the artifact, or null if it carries none. */
const originOf = (parts) => {
  const eps = parts.flatMap((p) => [...String(p).matchAll(EPOCH_RE)].map((m) => Number(m[2])));
  return eps.length ? Math.min(...eps) : null;
};

const REDACTIONS = [
  { name: "iso timestamp", kind: "varies",
    apply: (s) => s.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<ts>") },
  // DERIVED FROM `os.tmpdir()`, not from the two Unix roots it usually sits
  // under. `TMPDIR` moves it anywhere, and Windows puts it somewhere else again:
  // REPRODUCED with `TMPDIR=$HOME/.reeve-tmp-probe`, every scenario mismatched
  // its approved signature and BOTH determinism controls failed, with no change
  // to the tick. A pattern naming `/var` and `/tmp` was describing this machine.
  //
  // Two forms, because artifacts embed these paths inside JSON strings and a
  // Windows separator is doubled there. On macOS the realpath gains a `/private`
  // prefix the environment variable does not carry.
  { name: "temp directory", kind: "varies", apply: (s) => s.replace(TMP_RE, "<tmp>") },
  // Generated per dispatch as a base36 clock reading joined to a random suffix.
  { name: "run id", kind: "varies",
    apply: (s) => s.replace(/"runId"\s*:\s*"[^"]*"/g, '"runId":"<runId>"') },
  // The same value again, in the log's prose, where it carries no key.
  { name: "run reference in prose", kind: "varies",
    apply: (s) => s.replace(/\brun [0-9a-z]+-[0-9a-z]+/g, "run <ref>") },

  // A cooldown is stamped with the wall clock at observation. The WINDOW is
  // behaviour and stays visible as `cooldownSeconds`; the absolute epochs are
  // the clock and nothing else. Whole seconds, so two runs in one second record
  // the same number -- which is why this is proved by where the value came from
  // rather than by differencing.
  // RE-ORIGINED, NOT ERASED. Replacing both stamps with one token hides the
  // RELATIONSHIP between them, which is the behaviour: a note re-derived from
  // the retry time rather than the observation looks newer than a rate limit
  // seen after it, and then overwrites it. Only the origin is the clock; the
  // offsets from it are the contract, so they stay on the page.
  // ONE ORIGIN FOR THE WHOLE ARTIFACT, passed in. Computed per section, each
  // section chose its own minimum -- so moving BOTH deferred stamps forward
  // together left their offsets from each other unchanged, the artifact
  // identical and the suite green, while the next tick would extend the cooldown
  // from an observation that has not happened yet and overwrite genuinely newer
  // metadata. A shared origin is what makes the attempted stamps and the
  // deferred ones comparable, which is the whole reason for keeping them.
  { name: "cooldown wall clock", kind: "provenance",
    apply: (s, origin) => {
      const eps = [...s.matchAll(EPOCH_RE)].map((m) => Number(m[2]));
      if (!eps.length) return s;
      const t0 = origin ?? Math.min(...eps);
      return s.replace(EPOCH_RE, (_, k, v) => `"${k}":<t0${offsetOf(Number(v), t0)}>`);
    },
    cameFromTheHost: (t) => [...t.matchAll(EPOCH_RE)]
      .some((m) => Math.abs(Number(m[2]) - Date.now() / 1000) < 3600) },

  // THE LAST BACKUP'S CLOCK. `measureContainment` is handed the whole `ctx`,
  // which carries `lastBackupAt` -- a stamp written during the tick, so it
  // differs on every run. FOUND by the artifact comparison on the run after the
  // scenario that first reached this seam was approved: the scenario was
  // non-deterministic from the moment it existed, and the determinism control
  // could not see it because that control runs a different pair of scenarios.
  //
  // Its OWN pattern rather than the cooldown's, though both are clocks. Sharing
  // the cooldown's origin would express this stamp as a distance from a rate
  // limit it has nothing to do with -- deterministic, and meaningless.
  { name: "last backup clock", kind: "provenance",
    apply: (s) => s.replace(/"lastBackupAt"\s*:\s*\d+/g, '"lastBackupAt":<epoch>'),
    cameFromTheHost: (t) => [...t.matchAll(/"lastBackupAt"\s*:\s*(\d+)/g)]
      .some((m) => Math.abs(Number(m[1]) - Date.now() / 1000) < 3600) },

  // MEASURED: six scenarios failed in CI against artifacts approved locally,
  // with no change to the tick at all. `spawnWorker` records an allow-rule
  // naming the running node binary.
  { name: "node interpreter path", kind: "provenance",
    apply: (s) => s.replace(NODE_PATH_RE, "<node>"),
    cameFromTheHost: (t) => t.includes(process.execPath) },

  // `providerClaim` is handed `pid: process.pid`, constant within a run and
  // different in every other process that ever compares these artifacts.
  //
  // SCOPED TO THE CLAIM, not matched by key and not matched by value either.
  //
  //   By KEY blanks a fixture's own pid: the bind path is handed 4242, which is
  //   behaviour, chosen by the scenario and identical on every machine.
  //   By VALUE still collides. The day this process is itself assigned 4242 the
  //   replacement swallows the fixture's pid too, the artifact mismatches for no
  //   reason but the host's process table, and the worker pid silently stops
  //   being checked at the same time.
  //
  // MEASURED: `"pid":<process.pid>` appears on the `providerClaim` seam line and
  // nowhere else, so the claim's arguments are the exact scope.
  { name: "process id", kind: "provenance",
    apply: (s) => s.split("\n").map((line) => (line.startsWith("providerClaim\t")
      ? line.replace(new RegExp(`"pid"\\s*:\\s*${process.pid}\\b`, "g"), '"pid":<pid>')
      : line)).join("\n"),
    cameFromTheHost: (t) => t.split("\n").some((line) => line.startsWith("providerClaim\t")
      && new RegExp(`"pid"\\s*:\\s*${process.pid}\\b`).test(line)) },
];

/**
 * Apply every redaction.
 *
 * `skip` omits one, which is how the per-pattern control proves a pattern is
 * load-bearing. `origin` fixes the cooldown's zero point for a whole artifact;
 * omitted, each string re-derives it locally, which is right when the caller IS
 * passing a whole artifact.
 */
const redact = (s, { skip = null, origin = null } = {}) =>
  REDACTIONS.reduce((acc, r) => (r.name === skip ? acc : r.apply(acc, origin)), String(s));

/**
 * Seam arguments, safely.
 *
 * A seam is handed live objects -- `providerClaim(db, a)` receives the database
 * handle -- and `JSON.stringify` on a CLOSED handle throws ERR_INVALID_STATE,
 * which kills the run after every assertion has printed PASS. Anything that is
 * not plain data is recorded as its TYPE, which is what a reader needs anyway:
 * that a handle was passed, not what was in it.
 */
const argsOf = (args) => {
  const one = (v) => {
    if (v === null || v === undefined) return v ?? null;
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") return v;
    if (t === "function") return "<fn>";
    if (Array.isArray(v)) return v.map(one);
    const name = v.constructor?.name ?? "Object";
    if (name !== "Object") return `<${name}>`;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, one(x)]));
  };
  try { return JSON.stringify(args.map(one)); }
  catch (e) { return `<unserialisable: ${e?.code ?? e?.message}>`; }
};

/** A carried map as its key line, then one indented line per stored identity. */
const carriedLines = (name, map) => {
  const entries = [...(map?.entries?.() ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [`${name}: ${entries.map(([k]) => k).join(",")}`,
          ...entries.map(([k, v]) => `  ${k}\t${JSON.stringify(v)}`)];
};

/**
 * The artifact.
 *
 * BUILT RAW FIRST, then redacted as a whole. Two reasons, both measured:
 * the cooldown's origin has to be chosen once across every section, and the
 * process-id redaction is scoped to the `providerClaim` line, which only exists
 * once the seam log is assembled -- redacting each seam's arguments on their own
 * left no line for it to recognise.
 */
const serialise = ({ seams, esc, log, r, ctx }, plain = false) => {
  const seamLog = seams.map(({ op, args }) => `${op}\t${argsOf(args)}`).join("\n");
  const escKeys = [...(r.escalations?.keys?.() ?? [])];
  const logText = String(log).trimEnd();
  const result = JSON.stringify({
    halted: r.halted ?? null,
    unreadable: r.unreadable ?? null,
    // NESTED. tick() stores `{ e, decision, cause, fp, spendKey }`, so reading
    // `d.action` yields null for every entry and the field records
    // `"decisions":[null]` -- populated-looking and vacuous. The control below
    // asserts at least one scenario names a real action, so this cannot regress
    // to nulls silently.
    decisions: (r.decisions ?? []).map((d) => d?.decision?.action ?? d?.action ?? null),
  });
  // THE VALUE, NOT ONLY THE KEY. A deferred release is retried against the
  // IDENTITY stored beside its key, and a retry whose identity has lost its
  // token is refused as `no-identity`, discarded, and leaves the lease consuming
  // capacity until it expires. Recording only the key left that invisible: the
  // key is unchanged in exactly that case.
  const held = carriedLines("providerRetry", ctx.providerRetry);
  const cooling = carriedLines("cooldownRetry", ctx.cooldownRetry);

  const origin = plain ? null : originOf([seamLog, ...escKeys, logText, result, ...held, ...cooling]);
  const red = plain ? String : (v) => redact(v, { origin });

  return [
    "== 1 SEAM LOG",
    red(seamLog),
    "",
    "== 2 ESCALATIONS",
    // REDACTED PER KEY, then sorted: an escalation key can carry a temp path --
    // the checkout-tampered one names the preserved checkout -- so sorting the
    // unredacted text would order them by a value that varies.
    escKeys.map(red).sort().join("\n"),
    "",
    "== 3 LOG FILE",
    red(logText),
    "",
    "== 4 RESULT",
    red(result),
    "",
    "== 5 CARRIED",
    ...held.map(red),
    ...cooling.map(red),
    "",
  ].join("\n");
};

/**
 * A scenario's options, fresh.
 *
 * Most are a plain object, but one needs state that must not survive into a
 * second run: the heartbeat scenario waits on a promise that is resolved by the
 * first beat, and a promise reused across runs is already resolved, so the
 * second run would record no heartbeat at all and still look like the first.
 */
const optionsOf = (o) => (typeof o === "function" ? o() : o);

// ── The scenarios ────────────────────────────────────────────────────────────
// Each is reachable through the fixture's existing seams. Scenarios 7 and 8 are
// the two EARLY EXITS and must be present: without them a move can reorder
// housekeeping past an exit and every other artifact stays green.
// What a previous tick left owed. A distinct pull request and lease id from
// anything this tick takes, so a release of THIS is never confusable with a
// release of the one the tick claims for itself.
// An EXISTING file, because `halted()` is an existence check. Under the
// temporary root, so the redactor normalises it like every other fixture path.
const HALT_MARKER = join(mkdtempSync(join(tmpdir(), "reeve-halt-")), "HALT");
writeFileSync(HALT_MARKER, "");

const CARRIED_RELEASE = [["o/r#41:FIX_CI",
  { owner: "guardian", repoId: 7, runRef: "o/r#41:FIX_CI", id: 9, token: "tok-carried-9" }]];

const SCENARIOS = [
  ["01-happy-path", {}],
  ["02-claim-at-limit", { claim: () => ({ ok: false, reason: "at-limit" }) }],
  ["03-claim-throws-fail-open", { claim: () => { throw new Error("database disk image is malformed"); } }],
  ["04-hub-unreadable-always", { hubGetter: () => ({ hub: null, why: "corrupt" }) }],
  ["05-hub-unreadable-first-read-only", { hubGetter: (() => { let n = 0; return (g) => (n++ === 0 ? { hub: null, why: "busy" } : { hub: g, why: null }); })() }],
  ["06-hub-absent", { hub: null }],
  ["09-repo-id-null-fail-closed", { repoId: null }],
  ["10-maintenance-on-release-and-cooldown", {
    // BOTH HALVES, because the name says both. A rate-limited worker is the only
    // thing that reaches the cooldown recorder at all; without it only the
    // release saw `maintenance`, the artifact contained no cooldown call, and
    // `cooldownRetry` stayed empty -- so an extraction could have dropped or
    // reordered the deferred cooldown and this scenario would still have passed
    // under a name that claimed to cover it.
    //
    // Each refusal is what makes its half DEFER to the next tick, which is the
    // behaviour worth recording: the obligation has to survive in `ctx`.
    spawnWorker: async () => ({ outcome: OUTCOMES.RATE_LIMITED,
                                why: "provider returned 429", ms: 1, cost: 0, sessionId: "s" }),
    noteRateLimit: () => ({ ok: false, reason: "maintenance" }),
    release: () => ({ ok: false, reason: "maintenance" }),
  }],

  // ── A RELEASE THIS TICK INHERITED ───────────────────────────────────────────
  //
  // These two are a CONTROL AND A PROBE, and they are only meaningful as a pair.
  // Both owe the same release from a previous tick; they differ in one thing,
  // whether the tick's FIRST hub read faults. Every other scenario starts a tick
  // owing nothing, which leaves the whole retry half of the scheduler -- and the
  // gate deciding whether an inherited release is attempted at all -- outside
  // the signature entirely.
  //
  // The gate consults the hub handle read once at the top of the tick, while
  // `releaseWithRetry` deliberately re-asks for a fresh one ("FRESH, not the
  // tick's opening snapshot"). So a hub that faults on the first read and is
  // healthy afterwards strands the inherited release for the whole tick, while a
  // release taken and given back within the same tick succeeds against the very
  // same hub. Recording both is what makes that difference visible.
  ["11-carried-release-hub-healthy", { carriedReleases: CARRIED_RELEASE }],
  ["12-carried-release-first-read-faults", {
    carriedReleases: CARRIED_RELEASE,
    hubGetter: (() => { let n = 0; return (g) => (n++ === 0 ? { hub: null, why: "busy" } : { hub: g, why: null }); })(),
  }],

  // ── The remaining scheduler seams ───────────────────────────────────────────
  //
  // Reaching a seam is not optional decoration. Three of the six the harness
  // installs appeared in NO artifact, so the extraction could have removed or
  // reordered all three and every byte-for-byte signature would have stayed
  // green -- the coverage control below now fails rather than letting that
  // happen quietly again.

  // A queued request for work this tick did not ask for is WITHDRAWN.
  ["13-withdraw-a-request-not-asked-for", { queuedRequests: () => [{ run_ref: "o/r#99:FIX_CI" }] }],

  // AND ONE IT DOES INTEND IS SERVED, so the canary is not blocked behind it.
  // These two differ in the run reference alone: `#99` is not something this
  // tick asks for, `#42` is. Scenario 13 covered only the withdrawal, and the
  // serve path -- a claim AND the release that follows it -- was the one
  // operation of the twelve that nothing would have noticed losing.
  ["18-serve-a-queued-request-this-tick-wants", {
    queuedRequests: () => [{ run_ref: "o/r#42:FIX_CI" }],
  }],

  // ── The paths no artifact was watching ──────────────────────────────────────
  //
  // MEASURED, by handing each hub accessor a WRONG handle and recording which
  // artifacts moved: four of the fourteen sites moved NONE. The halt path, the
  // canary's two, and the builder-hold read were outside the signature
  // entirely, so "the artifacts stay byte-identical" said nothing about them and
  // a rewrite could have pointed any of them anywhere.
  //
  // Two of the three levers needed to reach them were INERT -- `haltMarker` was
  // a declared option the harness never placed in ctx, and `openPrs` sat beside
  // a hardcoded literal that ignored it. An option that reaches nothing is worse
  // than an absent one: it reads as coverage.

  // The halt switch, which stops the tick and withdraws this guardian's queued
  // requests on the way out.
  ["15-halted-at-the-marker", { haltMarker: HALT_MARKER,
                                queuedRequests: () => [{ run_ref: "o/r#42:FIX_CI" }] }],

  // The canary runs only when containment could NOT be measured, which is what
  // `containmentThrows` produces. It claims and rebinds a lease of its own.
  // `containmentThrows` empties `ctx.containment`, which is what makes the tick
  // MEASURE it -- and the canary claims a lease of its own to do that. The
  // measurement must come back CLOSED or the tick refuses to dispatch and the
  // canary's own hub reads are never reached, which is exactly what the first
  // version of this scenario did.
  ["16-canary-claims-before-dispatch", {
    containmentThrows: true,
    // DRIVES THE CALLBACKS the real measurement drives. The canary's CLAIM
    // happens in `beforeSpawn` and its REBIND in `onSpawn`, so an override that
    // returns a verdict without calling them reaches neither of the two sites
    // this scenario exists to cover -- and its artifact then contains a single
    // claim for the pull request and no bind at all, while the name says
    // otherwise. MEASURED: exactly that, until it was pointed out.
    measureContainment: async (_ctx, _profile, _nwo, _logPath, { beforeSpawn, onSpawn } = {}) => {
      const gate = await beforeSpawn?.();
      if (gate && gate.ok === false)
        return { credentialRead: "open", why: `the canary was refused: ${gate.why ?? "?"}`, canary: { ran: false } };
      onSpawn?.({ pid: 4243, lstart: "canary-start" });
      return { credentialRead: "closed", why: "measured in the fixture",
               canary: { ran: true, evidence: { outcome: "ok" } } };
    },
    providerBind: () => ({ ok: true, bound: 1 }),
  }],

  // AN INHERITED RELEASE AGAINST A HUB THAT IS NEVER READABLE. The deferral path
  // reads the hub ITSELF -- it has to tell an ABSENT hub, where there is no
  // lease to give back, from an UNREADABLE one, where the obligation must be
  // carried -- and it reports that fault under the same once-only rule as every
  // other reader.
  //
  // MEASURED: nothing here reached that branch. The whole provider-lease suite
  // did, and it is what caught a ReferenceError this signature ran straight
  // past: `04-hub-unreadable-always` never carries an obligation, and
  // `12-carried-release-first-read-faults` has a hub that recovers before the
  // release. It takes both at once.
  ["17-carried-release-hub-never-readable", {
    carriedReleases: CARRIED_RELEASE,
    hubGetter: () => ({ hub: null, why: "busy" }),
  }],

  // A worker that announces itself is BOUND to the lease, and one that outlives
  // an interval is HEARTBEATED. A thunk, because the promise below must be fresh
  // per run: reused, it is already resolved and the run records no beat.
  ["14-worker-binds-and-heartbeats", () => {
    let sawBeat;
    const beaten = new Promise((resolve) => { sawBeat = resolve; });
    return {
      // Long enough that the worker returning on the first beat cannot race a
      // second one into the log, which would make the artifact depend on timing.
      heartbeatMs: 60,
      // Without this the real rebind answers `bound: 0` against a stubbed claim
      // that wrote no row, the daemon calls that a preparation failure, and the
      // run ends before a single beat -- under a name promising heartbeats.
      // MEASURED: exactly that, until the coverage control above refused it.
      providerBind: () => ({ ok: true, bound: 1 }),
      providerHeartbeat: () => { sawBeat(); return { ok: true }; },
      spawnWorker: async (a) => {
        a.onSpawn?.({ pid: 4242, lstart: "worker-start" });
        // BOUNDED, and the bound is VISIBLE. `await beaten` alone hangs for ever
        // if no beat arrives -- which is exactly what happens when the heartbeat
        // operation is removed, so the scenario that exists to watch that
        // operation would hang rather than fail. MEASURED: a coverage sweep
        // stalled here and produced no result at all for the last three sites.
        //
        // A test that hangs is worse than one that fails: it reports nothing, and
        // "no answer yet" is indistinguishable from "still working". The race
        // turns a missing beat into a DIFFERENT recorded outcome, which the
        // artifact then shows.
        const beat = await Promise.race([
          beaten.then(() => "beaten"),
          new Promise((r) => setTimeout(() => r("no-beat"), 5000)),
        ]);
        return beat === "beaten"
          ? { outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }
          : { outcome: "failed", why: "no provider heartbeat arrived", ms: 1, cost: 0, sessionId: "s" };
      },
    };
  }],
];

if (!existsSync(APPROVED)) mkdirSync(APPROVED, { recursive: true });

// THE RAW TEXT OF EVERY SCENARIO, kept as it is produced. The controls at the
// foot need text a tick actually emitted -- a redaction pattern proved against a
// hand-written sample proves only that the regex works, which was never the
// question. Costs no extra tick: the same run is serialised twice.
const rawRuns = [];

let approvedWritten = 0;
for (const [name, opts] of SCENARIOS) {
  const seams = [];
  let out;
  try {
    out = await run({ ...optionsOf(opts), seams });
  } catch (e) {
    check(false, `${name}: the tick ran`, String(e?.message ?? e));
    continue;
  }
  const actual = serialise({ ...out, seams });
  rawRuns.push(serialise({ ...out, seams }, true));
  const file = join(APPROVED, `${name}.txt`);

  if (!existsSync(file) && !APPROVE) {
    // A MISSING BASELINE IS A FAILURE, not an invitation. Regenerating it would
    // let a refactor delete a baseline and have CI bless the new output as if it
    // had been approved -- the deliberate step this file exists to require,
    // skipped by deleting a file.
    check(false, `${name}: has an approved signature`,
      `${file} is missing. If this scenario is new or deliberately changed, run:\n` +
      "        REEVE_APPROVE=1 node test/characterise-tick.test.mjs");
    continue;
  }
  if (APPROVE) {
    writeFileSync(file, actual);
    approvedWritten++;
    console.log(`APPROVED  ${name}`);
    continue;
  }
  const expected = readFileSync(file, "utf8");
  if (actual === expected) {
    check(true, `${name}: matches its approved signature`);
  } else {
    // The first differing line, because a whole-artifact dump buries it.
    const a = actual.split("\n"), b = expected.split("\n");
    const i = a.findIndex((l, k) => l !== b[k]);
    check(false, `${name}: matches its approved signature`,
      `first difference at line ${i + 1}\n        approved: ${JSON.stringify(b[i])}\n        actual:   ${JSON.stringify(a[i])}`);
  }
}

// ── The controls ─────────────────────────────────────────────────────────────
//
// Four runs, two scenarios twice each, serving every control below. The happy
// path reaches the most seams; the maintenance scenario is the only one that
// reaches the cooldown recorder, so between them they exercise every redaction
// pattern. Running them in pairs is what makes the per-pattern control possible
// at all: a pattern's justification is a DIFFERENCE between two runs, and one
// run cannot show a difference.
const PAIRED = ["01-happy-path", "10-maintenance-on-release-and-cooldown"];
const pairs = [];
for (const name of PAIRED) {
  const entry = SCENARIOS.find(([n]) => n === name);
  // A named scenario that no longer exists would otherwise skip its controls in
  // silence, which is the failure this whole file is about.
  check(!!entry, `control: the paired scenario ${name} is still in the list`);
  if (!entry) continue;
  const two = [];
  for (let i = 0; i < 2; i++) {
    const seams = [];
    const out = await run({ ...entry[1], seams });
    two.push({ done: serialise({ ...out, seams }), raw: serialise({ ...out, seams }, true) });
  }
  pairs.push([name, two[0], two[1]]);
  rawRuns.push(two[0].raw);
}

// 1. DETERMINISM IS THE PRECONDITION. If a scenario does not reproduce itself
//    within one process, comparing it across a refactor means nothing -- every
//    later difference would be unattributable.
for (const [name, a, b] of pairs) {
  check(a.done === b.done, `${name}: the same scenario twice is byte-identical, so a later difference is attributable`,
    a.done === b.done ? "" : `first diff: ${a.done.split("\n").find((l, i) => l !== b.done.split("\n")[i])}`);
}

// 2. EVERY REDACTION PATTERN MATCHES SOMETHING A TICK PRODUCED. A pattern that
//    never fires is not harmless: it reads as coverage, and it sits in the list
//    where a reader takes it for a reason that was checked. Four of the patterns
//    this list replaced had never matched anything.
for (const { name: pname, apply } of REDACTIONS) {
  const fires = rawRuns.some((t) => apply(t) !== t);
  check(fires, `control: the ${pname} redaction matches something a tick actually emitted`);
}

// 3. EVERY "varies" PATTERN IS LOAD-BEARING. Drop it, and two runs of one
//    scenario must stop matching. A pattern that is NOT load-bearing is
//    normalising something stable -- which is to say it is blanking behaviour,
//    and the signature can no longer see a change to it. This is the control
//    that would have caught a redactor blanking the lease id, the incarnation
//    token, the run reference and the head the worker was sent at.
for (const { name: pname, kind, cameFromTheHost } of REDACTIONS) {
  if (kind === "varies") {
    const bearing = pairs.some(([, a, b]) => redact(a.raw, { skip: pname }) !== redact(b.raw, { skip: pname }));
    check(bearing, `control: without the ${pname} redaction two runs differ, so it normalises variance rather than hiding behaviour`);
  } else {
    // The provenance half. `.some` over actual matches, so a text with no
    // occurrence cannot satisfy it -- the check cannot pass by finding nothing.
    check(rawRuns.some((t) => cameFromTheHost(t)),
      `control: the value the ${pname} redaction removes is demonstrably this host's, which is the reason for removing it`);
  }
}

// 4. AND THE ARTIFACTS MUST BE ABLE TO DIFFER. An approval mechanism that
//    reports success no matter what is the vacuous case, and it looks exactly
//    like a passing one.
check(pairs.length === 2 && pairs[0][1].done !== pairs[1][1].done,
  "control: two different scenarios produce different artifacts, so equality means something");

// 5. THE RESULT FIELD MUST NOT BE VACUOUS. It once recorded `"decisions":[null]`
//    for every scenario because the action is nested one level deeper than it
//    was read from -- a field that looks populated and measures nothing.
//    Asserted against the artifacts themselves, so it cannot regress silently.
{
  const withAction = SCENARIOS
    .map(([n]) => join(APPROVED, `${n}.txt`))
    .filter((f) => existsSync(f))
    .filter((f) => /"decisions":\[(?!null)[^\]]/.test(readFileSync(f, "utf8")));
  check(withAction.length > 0,
    "at least one artifact records a REAL decision action, so the result field is not vacuous",
    `${withAction.length} of ${SCENARIOS.length} artifacts name an action`);
}

// 6. THE RELEASE CARRIES THE IDENTITY THE CLAIM ISSUED. Not "an id and a token"
//    -- the ones that were handed out. The claim answers deterministically here,
//    so all three are behaviour, and asserting them literally is what stops the
//    redactor from ever blanking them again: a pattern wide enough to cover
//    `"id"` or `"token"` fails this check the moment it is added.
{
  const f = join(APPROVED, "01-happy-path.txt");
  const line = existsSync(f)
    ? readFileSync(f, "utf8").split("\n").find((l) => l.startsWith("providerRelease\t")) : null;
  const carries = !!line && line.includes(`"id":1,"token":"${CLAIM_TOKEN}"`)
    && line.includes('"runRef":"o/r#42:FIX_CI"');
  check(carries,
    "the recorded release carries the id, token and run reference the claim issued, so dropping any one of them changes the signature",
    line ?? "no providerRelease seam was recorded at all");
}

// 7. THE MAINTENANCE SCENARIO REACHES BOTH HALVES OF ITS NAME. A scenario named
//    for coverage it does not have is worse than a missing one: it is counted.
{
  const f = join(APPROVED, "10-maintenance-on-release-and-cooldown.txt");
  const t = existsSync(f) ? readFileSync(f, "utf8") : "";
  check(/^noteRateLimit\t/m.test(t),
    "the maintenance scenario reaches the cooldown recorder, not only the release");
  check(/^cooldownRetry: \S/m.test(t) && /^providerRetry: \S/m.test(t),
    "and BOTH deferred obligations survive into the next tick's carried state",
    `${(t.match(/^(?:cooldown|provider)Retry: .*/gm) ?? []).join("  |  ")}`);
}

// 8. AND THE ARTIFACTS MUST BE PORTABLE, not merely reproducible. The
//    determinism control above runs one process twice and cannot see host
//    dependence; six scenarios once failed in CI against artifacts approved
//    locally, with no behaviour change. These are the two "host" patterns'
//    positive side: control 2 proves each one FIRES, and these prove what it
//    fired on did not survive into the file.
{
  const files = SCENARIOS.map(([n]) => join(APPROVED, `${n}.txt`)).filter((f) => existsSync(f));
  const hostish = files.filter((f) => /\/(?:Users|home|root|opt)\//.test(readFileSync(f, "utf8")));
  check(hostish.length === 0,
    "no artifact embeds an absolute host path, so they compare on a machine that is not this one",
    hostish.join(", "));
  // A pid is not a path, so the check above cannot see it -- and it cannot be
  // asserted by ABSENCE either, in two different ways. Against `process.pid`:
  // artifacts are approved in one process and compared in another, so a check
  // for THIS process's id never matches the leaked one and passes on every real
  // leak. Against the SHAPE `"pid":<digits>`: a fixture may legitimately hand a
  // seam a pid of its own, and the bind path does, so shape alone cannot tell a
  // leak from behaviour.
  //
  // Asserted positively instead. Every artifact that records a claim must show
  // the claim's pid REPLACED, because the claim is handed `process.pid` and
  // nothing else. A redaction that stopped firing fails here; a fixture's own
  // pid is untouched and irrelevant.
  const claiming = files.filter((f) => /^providerClaim\t/m.test(readFileSync(f, "utf8")));
  const unmasked = claiming.filter((f) => !/"pid":<pid>/.test(readFileSync(f, "utf8")));
  check(claiming.length > 0 && unmasked.length === 0,
    "and every artifact recording a claim shows its pid replaced, since the claim is handed this process's",
    `${claiming.length} artifact(s) record a claim; unmasked: ${unmasked.join(", ") || "none"}`);
}

// 8b. THE HOST-PATH PATTERNS ARE DERIVED, AND THE DERIVATION HANDLES SHAPES THIS
//     MACHINE DOES NOT HAVE. The suite cannot run on Windows here, so the
//     artifacts prove nothing about it; what CAN be established is that the
//     construction covers a Windows interpreter path -- a space in it, no
//     `/bin/`, and separators that are doubled inside a JSON string. Asserted on
//     the builder directly, which is the part that would be wrong.
{
  const WIN = "C:\\Program Files\\nodejs\\node.exe";
  const winRe = new RegExp(pathForms(WIN), "g");
  check(winRe.test(`"bin":"${JSON.stringify(WIN).slice(1, -1)}"`),
    "the interpreter pattern matches a Windows path as it appears INSIDE a JSON string");
  check(new RegExp(pathForms(WIN), "g").test(`spawning ${WIN} --version`),
    "and as it appears bare in the log's prose");
  // The control: the shape this replaced could match NEITHER, which is why the
  // artifacts and the redaction controls both failed there.
  const OLD = /(?:\/[^\s"',)\]]*)?\bnode\/?[^\s"',)\]]*\/bin\/node\b|\/[^\s"',)\]]*\/bin\/node\b/g;
  check(!OLD.test(`"bin":"${JSON.stringify(WIN).slice(1, -1)}"`),
    "control: and the ends-in-/bin/node shape it replaced matches neither, so this is not a no-op");
  // And it still matches THIS host's, or the derivation would be untested where
  // it actually runs.
  check(new RegExp(pathForms(process.execPath), "g").test(process.execPath),
    "control: and the same construction matches this host's interpreter");
}

// 8c. THE PROCESS-ID REDACTION TOUCHES THE CLAIM AND NOTHING ELSE. A fixture
//     hands the bind path a pid of its own, and the day this process is assigned
//     that same number a value-only match would swallow it -- the artifact would
//     mismatch for no reason but the host's process table, and the worker pid
//     would quietly stop being checked. Asserted on a line pair carrying the
//     SAME number under both seams, which is that collision exactly, without
//     needing to be assigned any particular pid.
{
  const pat = REDACTIONS.find((r) => r.name === "process id");
  const pair = `providerClaim\t[{"pid":${process.pid}}]\nproviderBind\t[{"pid":${process.pid}}]`;
  const [claimLine, bindLine] = pat.apply(pair, null).split("\n");
  check(claimLine.includes('"pid":<pid>'), "the claim's pid is replaced", claimLine);
  check(bindLine.includes(`"pid":${process.pid}`),
    "and a seam that is not the claim keeps the same number, which is the collision case", bindLine);
  // And the fixture's own worker pid survives into the artifact it belongs to.
  const bind = existsSync(join(APPROVED, "14-worker-binds-and-heartbeats.txt"))
    ? readFileSync(join(APPROVED, "14-worker-binds-and-heartbeats.txt"), "utf8")
      .split("\n").find((l) => l.startsWith("providerBind\t")) : null;
  check(!!bind && /"pid":4242\b/.test(bind),
    "and the scenario's worker pid is on the page, where a refactor that stopped passing it would show",
    bind ?? "no providerBind seam recorded");
}

// 8d. THE COOLDOWN'S ORIGIN IS ONE ORIGIN FOR THE WHOLE ARTIFACT. Per section,
//     each chose its own minimum, so stamps moved together within one section
//     kept their offsets and vanished. Asserted on the redactor directly,
//     because the fixture's two sections legitimately agree today: the defect is
//     only visible once they diverge.
{
  const attempted = `noteRateLimit\t[{"observedAt":1000,"expiresAt":1600}]`;
  const deferred = `  k\t{"observedAt":1100,"expiresAt":1700}`;
  const origin = originOf([attempted, deferred]);
  const [a, d] = [attempted, deferred].map((x) => redact(x, { origin }));
  check(/"observedAt":<t0>/.test(a) && /"expiresAt":<t0\+600>/.test(a),
    "the earliest stamp anywhere is the origin", a);
  check(/"observedAt":<t0\+100>/.test(d) && /"expiresAt":<t0\+700>/.test(d),
    "and a section stamped later shows its distance from that same origin, not from its own", d);
  // The control: redacted independently, the deferred pair is indistinguishable
  // from the attempted one, which is the bug.
  const alone = redact(deferred, {});
  check(/"observedAt":<t0>/.test(alone),
    "control: and re-origined alone it reads as t0, which is why one origin is required", alone);
}

// 8e. EVERY FALLBACK IS THE FUNCTION THE DAEMON WOULD HAVE REACHED FOR.
//
//     A fallback that is merely A function satisfies a `typeof` guard and can
//     still be the wrong one. MEASURED: `containment.mjs` exports
//     `measureContainment`, while the daemon's fallback at that seam is
//     `measuredContainment` -- a different function, defined in daemon.mjs, with
//     a different signature. It imported cleanly, passed the guard, and crashed
//     the tick on a path no scenario here reaches.
//
//     DERIVED FROM THE DAEMON'S OWN SOURCE. It resolves each seam as
//     `(ctx.NAME ?? FALLBACK)`, so the pairs can be read rather than restated;
//     a list maintained here would drift the moment one changed.
{
  const daemonSrc = readFileSync(join(HERE, "..", "src", "daemon.mjs"), "utf8");
  // TWO FORMS, because the resolution mechanism moved. A seam is resolved either
  // inline as `(ctx.NAME ?? FALLBACK)` or through the session as
  // `session.perform("NAME", FALLBACK, ...)`, which is what makes the handle
  // unobtainable at the call site. Reading only the first form made this control
  // fail the moment a site moved -- correctly, since it could no longer see the
  // seam, but the fix is to read the new form too rather than to stop asking.
  const resolved = new Map();
  for (const m of daemonSrc.matchAll(/\(\s*ctx\.(\w+)\s*\?\?\s*(\w+)\s*\)/g)) resolved.set(m[1], m[2]);
  for (const m of daemonSrc.matchAll(/session\.perform\(\s*"(\w+)"\s*,\s*(\w+)\s*,/g)) resolved.set(m[1], m[2]);
  check(resolved.size > 0, "control: the daemon's seam resolutions are readable at all", `${resolved.size} found`);
  // AND BOTH FORMS ARE REALLY IN USE, or one half of this reader is dead weight
  // that would hide a seam resolved the way it no longer looks for.
  check(/session\.perform\(\s*"/.test(daemonSrc),
    "control: and the session-performed form is present, so reading for it is not dead weight");
  for (const seam of SCHEDULER_SEAMS) {
    const want = resolved.get(seam);
    check(!!want, `the daemon really resolves ${seam} as (ctx.${seam} ?? ...), so installing it means something`);
    if (!want) continue;
    check(SCHEDULER_FALLBACKS[seam]?.name === want,
      `and the harness's ${seam} fallback IS ${want}, not another function of a similar name`,
      `harness installs ${SCHEDULER_FALLBACKS[seam]?.name ?? "nothing"}`);
  }
}

// 9. EVERY SCHEDULER SEAM THE HARNESS INSTALLS IS REACHED BY SOME SCENARIO.
//    DERIVED from the harness's own list, never a copy of it: a hand-written
//    roster here would not grow when a seam is added, and the new seam would go
//    unwatched behind a green control. A seam that appears in no artifact is a
//    scheduler operation the extraction may remove or reorder freely.
{
  const logs = SCENARIOS.map(([n]) => join(APPROVED, `${n}.txt`)).filter((f) => existsSync(f))
    .map((f) => readFileSync(f, "utf8"));
  for (const seam of SCHEDULER_SEAMS) {
    const re = new RegExp(`^${seam}\\t`, "m");
    check(logs.some((t) => re.test(t)), `some scenario reaches the ${seam} seam, so a move cannot drop it unseen`);
  }
}

// 10. THE CARRIED PAIR: A FAULT ON THE TICK'S FIRST HUB READ COSTS NOTHING.
//
//    These two owe the same inherited release and differ in exactly one thing:
//    whether the tick's first hub read faults. Both must DISCHARGE it.
//
//    THIS ASSERTION MOVED WITH A FIX, deliberately. It previously required the
//    faulted half to STRAND the release, because that is what the tick did: the
//    release retry was gated on the handle read at the top of the tick, while
//    the release path itself re-asks for a fresh one. Removing that gate is the
//    behaviour change this pair was built to make visible, and an approved
//    signature exists precisely so a change like it cannot pass unnoticed --
//    the artifact moved, this line moved, and both are in the diff.
//
//    What keeps the pair a pair is no longer the carried state, which now agrees.
//    It is that the faulted half REPORTS its fault: without that the two are
//    copies of one scenario, both green, and nothing is being probed.
{
  const read = (n) => { const f = join(APPROVED, `${n}.txt`);
    return existsSync(f) ? readFileSync(f, "utf8") : ""; };
  const healthy = read("11-carried-release-hub-healthy");
  const faulted = read("12-carried-release-first-read-faults");
  const carried = (t) => (t.match(/^providerRetry: .*/m) ?? [""])[0];
  check(carried(healthy) === "providerRetry: " && carried(faulted) === "providerRetry: ",
    "a fault on the tick's FIRST hub read no longer costs the inherited release -- both halves discharge it",
    `healthy=${JSON.stringify(carried(healthy))}  faulted=${JSON.stringify(carried(faulted))}`);

  // VACUITY, both directions. The fault has to have HAPPENED, or the faulted
  // half is just the healthy one under another name and the line above is
  // reporting a success nothing was at risk in.
  check(/guardian:hub:unreadable/.test(faulted) && /hub: busy/.test(faulted),
    "control: and the faulted half really did fault, and said so rather than failing silently");
  check(!/guardian:hub:unreadable/.test(healthy),
    "control: while the healthy half has nothing to report, so the pair still differs in the one thing it varies");

  // BOTH releases in BOTH halves, or "discharge" is being read from a scenario
  // that never had two to discharge.
  for (const [label, t] of [["healthy", healthy], ["faulted", faulted]]) {
    check((t.match(/^providerRelease\t/gm) ?? []).length === 2,
      `control: the ${label} half performs both releases, the inherited one and the lease it took itself`,
      `${(t.match(/^providerRelease\t/gm) ?? []).length} release(s) recorded`);
  }
  // And the inherited one is released with the identity it was carrying, not
  // merely released: a retry that has lost its token is refused `no-identity`.
  check(/providerRelease\t.*"runRef":"o\/r#41:FIX_CI","id":9,"token":"tok-carried-9"/.test(faulted),
    "and the inherited release carries the identity it was stored with, which is what the next tick would need");
}

if (approvedWritten) console.log(`\n${approvedWritten} artifact(s) written. Review the diff; they are the record.`);
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exitCode = fail ? 1 : 0;
