// The validator must REFUSE. Each case below is a real shape from the portfolio
// that would have caused a gate to judge the wrong thing, so each must produce an
// error rather than a default.
import { validate, withDefaults, FIELDS } from "../src/profile/schema.mjs";

const base = {
  schemaVersion: 1,
  project: { kind: "product" },
  identity: { key: "o/r", defaultBranch: "main", visibility: "private" },
  authority: { permission: "admin", policy: "propose_and_merge", profileLocation: "sidecar" },
  state: { mode: "in-repo" },
  units: [{ id: "root", root: ".", language: "typescript", packageManager: "pnpm",
            commands: { test: { cmd: "pnpm test", state: "present" } } }],
  ci: { provider: "github-actions", requiredChecks: [] },
  merge: { method: "squash", enforcement: "enforced" },
};

const clone = o => structuredClone(o);
let fail = 0;

function expectOk(name, p) {
  const r = validate(withDefaults(p));
  const ok = r.ok;
  console.log(`${ok ? "PASS" : "FAIL"}  accepts: ${name}`);
  if (!ok) { for (const e of r.errors) console.log("        unexpected error:", e); fail++; }
}

function expectRefusal(name, p, matcher) {
  const r = validate(withDefaults(p));
  const hit = !r.ok && r.errors.some(e => matcher.test(e));
  console.log(`${hit ? "PASS" : "FAIL"}  refuses: ${name}`);
  if (!hit) {
    console.log("        errors were:", r.errors.length ? r.errors.join(" | ") : "(none — it PASSED)");
    fail++;
  }
}

// Positive control: the baseline must pass, or every refusal below proves nothing.
expectOk("a well-formed product profile", base);

// A client repo must never carry a committed profile: agent artifacts must not
// live in a repo that can be handed to the client.
expectRefusal("a client profile that commits itself",
  (() => { const p = clone(base); p.project.kind = "client"; p.authority.profileLocation = "committed"; return p; })(),
  /client.*forbids.*committed/i);

// CAN is not MAY, but the reverse is a hard error: you cannot merge without push.
expectRefusal("a policy above the detected permission",
  (() => { const p = clone(base); p.authority.permission = "read"; p.authority.policy = "propose_and_merge"; return p; })(),
  /needs at least .* permission/i);

// A hard cap below the soft cap makes the severity gate unreachable.
expectRefusal("hardCap below softCap",
  (() => { const p = clone(base); p.rounds = { softCap: 10, hardCap: 3 }; return p; })(),
  /hardCap.*must be >=/i);

// Matrix names expand at runtime, so a required context containing ${{ }} can
// never be satisfied and the PR blocks forever. Measured live on nextly.
expectRefusal("an unexpanded matrix expression in requiredChecks",
  (() => { const p = clone(base); p.ci.requiredChecks = ["Scaffold smoke (${{ matrix.os }})"]; return p; })(),
  /unexpanded matrix expression/i);

// Required checks with no CI provider can never report, so the gate hangs.
expectRefusal("requiredChecks with ci.provider 'none'",
  (() => { const p = clone(base); p.ci = { provider: "none", requiredChecks: ["CI Gate"] }; return p; })(),
  /requiredChecks is set but ci.provider is 'none'/i);

// A typo that silently does nothing is how a lane ends up with no territory.
expectRefusal("an unknown key",
  (() => { const p = clone(base); p.merge.methd = "squash"; return p; })(),
  /unknown key: merge\.methd/);

// A reviewer with no refusal pattern cannot distinguish "rate limited" from
// "approved": CodeRabbit reports state=success while rate limited.
expectRefusal("a reviewer with no refusal pattern",
  (() => { const p = clone(base); p.reviewers = [{ login: "coderabbitai", kind: "blocking" }]; return p; })(),
  /refusal.*required/i);

// A command declared present with no cmd is a green that never ran anything.
expectRefusal("a 'present' command with no cmd",
  (() => { const p = clone(base); p.units[0].commands.test = { state: "present" }; return p; })(),
  /requires cmd/i);

expectRefusal("the wrong schemaVersion",
  (() => { const p = clone(base); p.schemaVersion = 2; return p; })(),
  /schemaVersion must be 1/);

// Kind defaults must fill in, not override.
{
  const p = clone(base); p.project.kind = "client"; p.authority.profileLocation = "sidecar";
  const d = withDefaults(p);
  const ok = d.rounds?.softCap === 3 && d.rounds?.hardCap === 5;
  console.log(`${ok ? "PASS" : "FAIL"}  client defaults apply (softCap 3, hardCap 5)`);
  if (!ok) { console.log("        got:", JSON.stringify(d.rounds)); fail++; }
}
{
  const p = clone(base); p.rounds = { softCap: 7 };
  const d = withDefaults(p);
  const ok = d.rounds.softCap === 7;
  console.log(`${ok ? "PASS" : "FAIL"}  defaults never override an explicit value`);
  if (!ok) fail++;
}


// The schema must declare every key the code READS. daemon.mjs and watcher.mjs
// consume profile.watch.*, and when the schema omitted them the validator
// refused reeve's own profile and `reeve doctor` exited before doing anything.
// Code that reads undeclared config is config that drifts unnoticed.
{
  const { readFileSync } = await import("node:fs");
  const src = ["../src/daemon.mjs", "../src/watcher.mjs", "../src/pr.mjs"]
    .map(f => { try { return readFileSync(new URL(f, import.meta.url), "utf8"); } catch { return ""; } }).join("\n");
  const read = new Set([...src.matchAll(/\b(?:profile|p|ctx\.profile)\?\.(\w+)\?\.(\w+)/g)].map(m => `${m[1]}.${m[2]}`));
  const declared = new Set(Object.keys(FIELDS));
  const missing = [...read].filter(k => !declared.has(k));
  console.log(`${missing.length === 0 ? "PASS" : "FAIL"}  every profile key the code reads is declared in the schema`);
  if (missing.length) { console.log("        undeclared:", missing.join(", ")); fail++; }
}


// ── a lane that can never act ────────────────────────────────────────────────
//
// Measured live: the release lane's whole territory sat in sensitivePaths, and
// sensitive refuses before territory is read -- a mechanism dead by
// construction, visible to nobody. The validator now names it. sensitiveOk is
// the explicit way out, and it must be a boolean, not a truthy accident.
{
  const dead = clone(base);
  dead.risk = { sensitivePaths: [".changeset/**", "scripts/release/**"] };
  dead.lanes = [{ id: "release", territory: [".changeset/**", "scripts/release/**"] }];
  const r = validate(withDefaults(dead));
  const hit = r.warnings.some(w => /release.*can never act/.test(w));
  console.log(`${hit ? "PASS" : "FAIL"}  warns: a lane wholly inside sensitivePaths can never act`);
  if (!hit) { console.log("        warnings:", JSON.stringify(r.warnings)); fail++; }

  dead.lanes[0].sensitiveOk = true;
  const ok = validate(withDefaults(dead));
  const silent = !ok.warnings.some(w => /can never act/.test(w));
  console.log(`${silent ? "PASS" : "FAIL"}  and sensitiveOk silences exactly that warning`);
  if (!silent) fail++;

  // A PARTLY sensitive territory is not dead -- the lane can still act on the
  // rest -- so it must not warn.
  const part = clone(base);
  part.risk = { sensitivePaths: [".changeset/**"] };
  part.lanes = [{ id: "release", territory: [".changeset/**", "scripts/release/**"] }];
  const pr = validate(withDefaults(part));
  const quiet = !pr.warnings.some(w => /can never act/.test(w));
  console.log(`${quiet ? "PASS" : "FAIL"}  a partly-sensitive territory does not warn`);
  if (!quiet) fail++;
}

expectRefusal("a lane whose sensitiveOk is not a boolean",
  (() => { const p = clone(base); p.lanes = [{ id: "release", territory: ["x/**"], sensitiveOk: "yes" }]; return p; })(),
  /sensitiveOk/);

expectOk("a lane declaring sensitiveOk true",
  (() => { const p = clone(base); p.lanes = [{ id: "release", territory: ["x/**"], sensitiveOk: true }]; return p; })());



// ── capability switches: five booleans, every one default false ─────────────
//
// Authority is never inferred from repository fields: the live nextly profile
// already sets authority.policy=propose_and_merge, so that key cannot be the
// switch for anything. These five are, and a truthy accident must not flip one.
{
  const p = clone(base);
  const d = withDefaults(p);
  const caps = d.builder?.capabilities ?? {};
  const all = ["observe", "draftSpec", "implementLocal", "publishPr", "mergeBuilderPr"];
  const allFalse = all.every(k => caps[k] === false);
  console.log(`${allFalse ? "PASS" : "FAIL"}  every capability switch defaults to false`);
  if (!allFalse) { console.log("        got:", JSON.stringify(caps)); fail++; }

  const ok = d.worker?.maxOutputBytes === 67108864;
  console.log(`${ok ? "PASS" : "FAIL"}  worker.maxOutputBytes defaults to 64 MiB`);
  if (!ok) fail++;

  // Dispatch stays refused unless the founder declares an isolated worker, so
  // the default must be the un-isolated one; a dedicated-user value validates.
  const isoDefault = d.worker?.isolation === "none";
  console.log(`${isoDefault ? "PASS" : "FAIL"}  worker.isolation defaults to "none"`);
  if (!isoDefault) fail++;
  const isoOk = validate(withDefaults((() => { const q = clone(base); q.worker = { isolation: "scratch-home" }; return q; })())).ok;
  console.log(`${isoOk ? "PASS" : "FAIL"}  worker.isolation accepts the implemented mode`);
  if (!isoOk) fail++;
}

expectRefusal("an unknown worker.isolation value",
  (() => { const p = clone(base); p.worker = { isolation: "sandboxed" }; return p; })(),
  /worker\.isolation must be one of/);

expectRefusal("a capability switch that is not a boolean",
  (() => { const p = clone(base); p.builder = { capabilities: { mergeBuilderPr: "yes" } }; return p; })(),
  /builder\.capabilities\.mergeBuilderPr must be a boolean/);

{
  // A primitive container must produce a validation error, not a throw from
  // withDefaults trying to hang properties off a string.
  const p = clone(base); p.builder = "yes";
  let threw = null, r = null;
  try { r = validate(withDefaults(p)); } catch (e) { threw = e; }
  const ok = !threw && r.ok === false && r.errors.some(e => /builder must be an object/.test(e));
  console.log(`${ok ? "PASS" : "FAIL"}  refuses: a primitive builder container, without throwing`);
  if (!ok) { console.log("        ", threw ? String(threw.message) : JSON.stringify(r?.errors)); fail++; }
}

{
  // A top-level primitive profile is a validation error, never a throw from
  // withDefaults dereferencing it.
  let threw = null, results = [];
  for (const prim of ["yes", 1, true, null]) {
    try { results.push(validate(withDefaults(prim)).ok); } catch (e) { threw = e; }
  }
  const ok = !threw && results.length === 4 && results.every(x => x === false);
  console.log(`${ok ? "PASS" : "FAIL"}  refuses: a primitive or null profile, without throwing`);
  if (!ok) { console.log("        ", threw ? String(threw.message) : JSON.stringify(results)); fail++; }
}

expectRefusal("a capability container that is not an object",
  (() => { const p = clone(base); p.builder = { capabilities: [] }; return p; })(),
  /builder\.capabilities must be an object/);

expectRefusal("a founder user id that is not positive",
  (() => { const p = clone(base); p.builder = { founder: { userId: 0 } }; return p; })(),
  /builder\.founder\.userId must be a positive integer/);

expectRefusal("a founder user id that is not an integer",
  (() => { const p = clone(base); p.builder = { founder: { userId: "123" } }; return p; })(),
  /builder\.founder\.userId must be a positive integer/);

{
  // JSON null is not "absent": withDefaults must still produce the fail-closed
  // default, and the validated profile must carry a boolean.
  const p = clone(base); p.builder = { capabilities: { mergeBuilderPr: null } };
  const d = withDefaults(p);
  const ok = d.builder.capabilities.mergeBuilderPr === false && validate(d).ok;
  console.log(`${ok ? "PASS" : "FAIL"}  a null capability switch becomes false, never a null that validates`);
  if (!ok) { console.log("        got:", JSON.stringify(d.builder.capabilities), JSON.stringify(validate(d).errors)); fail++; }
}

expectRefusal("a worker output cap that is not positive",
  (() => { const p = clone(base); p.worker = { maxOutputBytes: 0 }; return p; })(),
  /worker\.maxOutputBytes must be a positive integer/);

expectOk("all five switches set explicitly",
  (() => { const p = clone(base); p.builder = { capabilities: { observe: true, draftSpec: false, implementLocal: false, publishPr: false, mergeBuilderPr: false } }; return p; })());

// ── the dependency override must be declarable ───────────────────────────────
//
// It is the only way to give a network-isolated worker a dependency tree the
// unit's language does not imply — and an override the loader REJECTS is not an
// override at all: the profile fails to load and nothing dispatches.
expectOk("a profile that declares worker.dependencyPaths",
  (() => { const p = clone(base); p.worker = { dependencyPaths: ["node_modules", "api/.venv"] }; return p; })());
expectRefusal("an absolute dependency path: it is copied INTO the checkout",
  (() => { const p = clone(base); p.worker = { dependencyPaths: ["/etc"] }; return p; })(), /relative/);
expectRefusal("a dependency path that climbs out of the checkout",
  (() => { const p = clone(base); p.worker = { dependencyPaths: ["../../secrets"] }; return p; })(), /relative/);


// A key with zero readers is a false affordance: it looks like it configures
// something. This one would have been worse than inert if wired -- the shipped
// flake rule is DEMONSTRATED flake (a job seen both passing and failing across
// attempts), and a name pattern asserts flakiness before any evidence, which
// would let a reproducible failure be filed as noise.
//
// Written with THIS file's helpers. The plan's version calls `minimalProfile()`
// and a bare `check()`, neither of which exists here -- the file is built on
// `clone(base)` with `expectOk`/`expectRefusal`, and those carry the positive
// control for free.
expectRefusal("ci.flakePatterns, even as an empty array: the key has no readers",
  (() => { const p = clone(base); p.ci.flakePatterns = []; return p; })(),
  /unknown key: ci\.flakePatterns/);
expectRefusal("ci.flakePatterns as a populated one",
  (() => { const p = clone(base); p.ci.flakePatterns = ["timeout"]; return p; })(),
  /unknown key: ci\.flakePatterns/);
// CONTROL: the same profile WITHOUT the key still validates, so the two
// refusals above are about that key and not about the fixture.
expectOk("control: the same profile without ci.flakePatterns", clone(base));

// And the key is gone from the declared field set itself, not merely refused by
// an unknown-key path that some future edit could route around.
{
  const known = Object.keys(FIELDS).filter(k => /flakePattern/i.test(k));
  console.log(`${known.length === 0 ? "PASS" : "FAIL"}  refuses: ci.flakePatterns is absent from FIELDS entirely`);
  if (known.length) { console.log("        still declared:", known.join(", ")); fail++; }
}

// ── builder.budgets ─────────────────────────────────────────────────────────
//
// ONE KEY, NOT EIGHTEEN. `validate`'s unknown-key sweep waves through any leaf
// beneath a declared key, so declaring `builder.budgets.BUILD_SIZE.budgetMinutes`
// and its siblings would make `builder.budgets.BUILD_NOPE.budgetMinutes` a leaf
// under a known prefix and accept it. The action names and the field names are
// refused INSIDE the validator or they are not refused at all -- which is why
// every refusal below is about something the sweep structurally cannot see.
const withBudget = (b) => { const p = clone(base); p.builder = { ...(p.builder ?? {}), budgets: b }; return p; };

expectOk("a per-action budget for every phase action",
  withBudget({ BUILD_SIZE:     { budgetMinutes: 8,  maxTurns: 15, model: "sonnet", effort: "low" },
               BUILD_RESEARCH: { budgetMinutes: 60, maxTurns: 60, model: "fable", effort: "high",
                                 maxBudgetUsd: 4.5, maxAttempts: 3 },
               BUILD_DESIGN:   { budgetMinutes: 60, maxTurns: 60 } }));
expectOk("a budget naming only some of the actions", withBudget({ BUILD_SIZE: { budgetMinutes: 8 } }));

expectRefusal("a budget for an action that has no phase",
  withBudget({ BUILD_NOPE: { budgetMinutes: 8 } }), /BUILD_NOPE is not one of/);

// ZERO IS REFUSED, NOT DEFAULTED, and each of these is a different way of
// writing a decision as a setting.
expectRefusal("zero attempts, which is an off switch nobody chose",
  withBudget({ BUILD_SIZE: { maxAttempts: 0 } }), /BUILD_SIZE\.maxAttempts must be a positive integer/);
expectRefusal("zero budget minutes, which kills the worker at spawn",
  withBudget({ BUILD_SIZE: { budgetMinutes: 0 } }), /BUILD_SIZE\.budgetMinutes must be a positive integer/);
expectRefusal("zero turns",
  withBudget({ BUILD_SIZE: { maxTurns: 0 } }), /BUILD_SIZE\.maxTurns must be a positive integer/);

// A MISSPELLED FIELD would be read as ABSENT by whatever consumes it, falling
// back to a default nobody chose -- and the sweep cannot see it.
expectRefusal("a misspelled budget field",
  withBudget({ BUILD_SIZE: { budgtMinutes: 8 } }), /BUILD_SIZE\.budgtMinutes is not one of/);

// MONEY IS NOT AN INTEGER. A budget of 4.5 dollars is ordinary; refusing it
// because the other five fields are integers would be a rule applied by shape
// rather than by meaning.
expectOk("a fractional dollar budget", withBudget({ BUILD_SIZE: { maxBudgetUsd: 4.5 } }));
expectRefusal("a negative dollar budget",
  withBudget({ BUILD_SIZE: { maxBudgetUsd: -1 } }), /BUILD_SIZE\.maxBudgetUsd must be a positive number/);
expectRefusal("a budget that is not an object",
  withBudget({ BUILD_SIZE: 8 }), /BUILD_SIZE must be an object/);
expectRefusal("budgets that are not an object", withBudget([]), /builder\.budgets must be an object/);

// ── the generated reference ──────────────────────────────────────────────────
//
// A stale generated file is a lie a reader cannot detect: it looks exactly like
// a fresh one. So the test regenerates and compares, and names the command.
//
// EQUALITY ALONE PROVES NOTHING HERE, and that is the whole difficulty. The
// committed file and the fresh one come from the SAME generator, so a generator
// that reads nothing produces a document of empty cells that matches a committed
// document of empty cells, and this check goes green over a reference that
// documents the schema not at all. Every control below exists because some
// version of this generator passed the equality check while being wrong.
{
  const { profileReference, noteFor, fieldsBounds, rowsFor } =
    await import("../scripts/profile-reference.mjs");
  const { readFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");

  const SRC    = readFileSync(new URL("../src/profile/schema.mjs", import.meta.url), "utf8");
  const fresh  = profileReference();
  const onDisk = readFileSync(new URL("../docs/profile-reference.md", import.meta.url), "utf8");

  const current = onDisk === fresh;
  console.log(`${current ? "PASS" : "FAIL"}  docs: profile-reference.md is current`);
  if (!current) { console.log("        run: node scripts/profile-reference.mjs"); fail++; }

  // CONTROL: the comparison is not two empty documents agreeing. The generator
  // must carry this PR's keys and a real count.
  //
  // The two keys named here are the ones THIS lane landed -- `builder.budgets`
  // (#81) and a capability switch (#80) -- so the control is anchored to keys
  // that exist. The plan specified `builder.provider.concurrencyLimit`, which no
  // task has added yet; a control naming an absent key fails for a reason that
  // has nothing to do with the generator, and the tempting repair is to delete
  // the control.
  const carries = fresh.includes("`builder.budgets`") &&
                  fresh.includes("`builder.capabilities.observe`") &&
                  new RegExp(`^${Object.keys(FIELDS).length} keys\\.`, "m").test(fresh);
  console.log(`${carries ? "PASS" : "FAIL"}  control: the reference names the new keys and counts them`);
  if (!carries) fail++;

  // CONTROL: prose written ABOVE a key reaches it. `builder.budgets` carries a
  // comment block above its declaration.
  const above = noteFor(SRC, "builder.budgets");
  const gotAbove = /ONE KEY, NOT EIGHTEEN/.test(above ?? "");
  console.log(`${gotAbove ? "PASS" : "FAIL"}  control: a key's comment BLOCK reaches its entry`);
  if (!gotAbove) { console.log(`        got: ${JSON.stringify((above ?? "").slice(0, 60))}`); fail++; }

  // CONTROL: prose written BESIDE a key reaches it too. Thirteen keys are
  // documented only by a trailing comment, and the first version of this
  // generator read the block form alone -- rendering all thirteen empty while
  // every assertion above stayed green, because the committed file was produced
  // by the same blind reader.
  const beside = noteFor(SRC, "identity.key");
  const gotBeside = /owner\/repo from the REMOTE/.test(beside ?? "");
  console.log(`${gotBeside ? "PASS" : "FAIL"}  control: a key's TRAILING comment reaches its entry`);
  if (!gotBeside) { console.log(`        got: ${JSON.stringify((beside ?? "").slice(0, 60))}`); fail++; }

  // CONTROL: coverage is pinned, in the idiom the capability keys already use.
  // It fails when a description is LOST, and equally when one is added -- and
  // updating the number is how the person adding it acknowledges the change.
  const documented = rowsFor(SRC).filter((r) => r.note !== "").length;
  // 30 since the misplaced watcher comment moved to the key it describes:
  // `watch.reviewActions` had no detail at all while its warning was attributed
  // to `notify.provider`.
  // ONE NUMBER, NAMED. The check said 30 while the label said 29, because an
  // earlier edit updated the comparison and missed the string inside the
  // template literal -- two places holding one fact, and the one a reader sees
  // was the wrong one. The label is derived from the constant now.
  const PINNED_DOCUMENTED = 35;
  const pinned = documented === PINNED_DOCUMENTED;
  console.log(`${pinned ? "PASS" : "FAIL"}  control: ${PINNED_DOCUMENTED} of the declared keys carry a description`);
  if (!pinned) {
    console.log(`        ${documented} do. If you added or removed one, update this number`);
    console.log("        and regenerate docs/profile-reference.md in the same commit.");
    fail++;
  }

  // ── THE DUPLICATE-KEY TRAP ────────────────────────────────────────────────
  //
  // Key strings are NOT unique in schema.mjs: `builder.capabilities.observe` is
  // declared in `FIELDS` and seeded again in `UNIVERSAL_DEFAULTS`. A whole-file
  // "first match" lookup -- which is what this generator was first specified to
  // do -- lands on the right one today only because `FIELDS` happens to be
  // declared earlier in the file.
  //
  // Reorder those two declarations and every duplicated key silently takes its
  // prose from the wrong block. NOTHING GOES RED: the committed file and a fresh
  // generation are wrong in the same way, so the equality check above passes.
  //
  // THE FIXTURE PUTS THE DECOY FIRST, so it can actually exhibit the defect. A
  // fixture built from the real file in its current order would pass under both
  // the bounded and the unbounded reader and would prove nothing.
  {
    const decoyFirst = [
      "const UNIVERSAL_DEFAULTS = {",
      "  // DECOY PROSE that belongs to the defaults block, not to the schema.",
      '  "builder.capabilities.observe": false,',
      "};",
      "",
      "export const FIELDS = {",
      "  // THE REAL PROSE, above the declaration inside FIELDS.",
      '  "builder.capabilities.observe":        [false, isBool],',
      "};",
    ].join("\n");

    const [lo, hi] = fieldsBounds(decoyFirst.split("\n"));
    const bounded = hi >= lo;
    console.log(`${bounded ? "PASS" : "FAIL"}  control: the FIELDS block is located and non-empty`);
    if (!bounded) fail++;

    const picked = noteFor(decoyFirst, "builder.capabilities.observe");
    const right = /THE REAL PROSE/.test(picked ?? "");
    console.log(`${right ? "PASS" : "FAIL"}  a key declared TWICE takes its prose from FIELDS, not from the defaults`);
    if (!right) { console.log(`        got: ${JSON.stringify(picked)}`); fail++; }

    // NEGATIVE CONTROL: the fixture really can tell the two readers apart. An
    // unbounded first-match reader must get the DECOY from this same input --
    // otherwise the assertion above would pass for a reader with the bug, and
    // would be measuring nothing.
    const naive = (() => {
      const lines = decoyFirst.split("\n");
      const at = lines.findIndex((l) => /^\s*"?builder\.capabilities\.observe"?\s*:/.test(l));
      const m = lines[at - 1].match(/^\s*\/\/ ?(.*)$/);
      return m ? m[1] : "";
    })();
    const discriminates = /DECOY/.test(naive);
    console.log(`${discriminates ? "PASS" : "FAIL"}  negative control: an unbounded reader takes the DECOY from that same fixture`);
    if (!discriminates) { console.log(`        got: ${JSON.stringify(naive)}`); fail++; }
  }

  // CONTROL: every declared key was actually FOUND in the FIELDS block. A key
  // the reader cannot locate must be an error, never an empty cell -- an empty
  // cell is indistinguishable from "documented nowhere yet".
  let threw = null;
  try { rowsFor(SRC.replace(/^\s*"?identity\.key"?\s*:.*$/m, "")); } catch (e) { threw = e; }
  console.log(`${threw ? "PASS" : "FAIL"}  a declared key missing from the source THROWS rather than rendering blank`);
  if (!threw) fail++;

  // `--check` answers without writing, the shape gofmt/terraform-docs settled on.
  let checkOk = false;
  try {
    // fileURLToPath, NOT `.pathname`. A checkout whose path contains a space
    // arrives percent-encoded, so `.pathname` hands node
    // `/tmp/reeve%20space/scripts/...`, which does not exist -- and the test
    // fails for a reason that has nothing to do with staleness. The generator
    // already decodes; this did not.
    execFileSync(process.execPath,
      [fileURLToPath(new URL("../scripts/profile-reference.mjs", import.meta.url)), "--check"],
      { stdio: "pipe" });
    checkOk = true;
  } catch { checkOk = false; }
  console.log(`${checkOk ? "PASS" : "FAIL"}  --check exits 0 while the committed file is current`);
  if (!checkOk) fail++;
}

// ── requirement is what an operator must AUTHOR ──────────────────────────────
//
// NOT the raw `FIELDS` flag. `bin/reeve` calls `withDefaults(raw)` and only then
// `validate(profile)`, so a key the defaults supply is accepted when a profile
// omits it. Reporting the flag labelled `authority.profileLocation` "required"
// and misstated the contract: every profile may omit it, and both kinds get one.
{
  const { requirementOf, mustAuthor, exampleFor, profileReference, EXAMPLE_SEED_KEYS,
          composedKeys } = await import("../scripts/profile-reference.mjs");
  const { PROJECT_KIND, withDefaults, validate } = await import("../src/profile/schema.mjs");
  // This file reports with `expectOk`/`expectRefusal` and a bare `fail++`; the
  // assertions below are not refusal cases, so they get a local reporter in the
  // same shape rather than a second global one.
  const at = (o, path) => path.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
  const check = (ok, name, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) { if (detail) console.log("        " + detail); fail++; }
  };
  const fresh = profileReference();

  check(FIELDS["authority.profileLocation"][0] === true,
    "control: authority.profileLocation IS flagged required in FIELDS",
    "if this flips, the case below stops being the interesting one");
  check(requirementOf("authority.profileLocation") === "defaulted",
    "a required key the defaults supply is reported as `defaulted`, not `required`",
    requirementOf("authority.profileLocation"));
  // AND IT REALLY IS ACCEPTED WITHOUT IT -- asserted through the loader's own
  // order rather than by restating which keys have defaults.
  for (const kind of PROJECT_KIND) {
    const omitted = exampleFor(kind);
    delete omitted.authority.profileLocation;
    const r = validate(withDefaults(omitted));
    check(r.ok === true,
      `control: a ${kind} profile omitting authority.profileLocation is accepted by the loader's order`,
      JSON.stringify(r.errors?.slice(0, 2)));
  }
  check(requirementOf("identity.key") === "required",
    "control: a key with no default is still reported as `required`", requirementOf("identity.key"));
  check(requirementOf("identity.prHost") === "optional",
    "control: and an unflagged key with no default is optional", requirementOf("identity.prHost"));
  // AN OPTIONAL KEY THAT THE DEFAULTS SUPPLY. `watch.staleSeconds` carries a
  // false required flag and a universal default of 900, so an early return on
  // the flag labelled it `optional` directly above its own description reading
  // "Defaulted rather than optional" -- the document contradicting itself.
  check(FIELDS["watch.staleSeconds"][0] === false,
    "control: watch.staleSeconds IS flagged optional in FIELDS");
  check(requirementOf("watch.staleSeconds") === "defaulted",
    "an OPTIONAL key the defaults supply is reported as `defaulted`, not `optional`",
    requirementOf("watch.staleSeconds"));
  check(at(withDefaults({ project: { kind: "product" } }), "watch.staleSeconds") === 900,
    "control: and every profile really does receive that value",
    String(at(withDefaults({ project: { kind: "product" } }), "watch.staleSeconds")));

  // ── the examples, which are the other half of §11.6 ────────────────────────
  //
  // "documentation AND examples generated from the validator". An example an
  // operator copies is worse than none if it does not validate, so each is run
  // through `validate()` rather than eyeballed.
  for (const kind of PROJECT_KIND) {
    const r = validate(exampleFor(kind));
    check(r.ok === true, `the generated ${kind} example is accepted by the validator`,
      JSON.stringify(r.errors?.slice(0, 3)));
    check((r.warnings ?? []).length === 0,
      `and the ${kind} example raises no warnings, so it does not model what the validator advises against`,
      JSON.stringify(r.warnings));
    check(fresh.includes(JSON.stringify(exampleFor(kind), null, 2)),
      `and the ${kind} example in the document is that same object`);
  }

  // THE SEED IS PINNED TO THE DERIVED SET, BOTH DIRECTIONS. Sample values are
  // the one thing here that cannot be derived -- the schema says a key must be a
  // string, not what a plausible string looks like -- so the risk is a new
  // required key landing with no sample and the example quietly failing to
  // validate. This fails first, and says which key.
  //
  // COMPARED IN BOTH DIRECTIONS, against the SEED's own key paths rather than
  // the example's top-level keys. Checking only "every must-author key reaches
  // the example" misses the other failure entirely: when a key stops being
  // must-author -- it becomes optional, or gains a default -- its seed entry
  // stays valid and keeps OVERRIDING that default in every generated example,
  // while the document says the value came from `withDefaults()`. Nothing goes
  // red, because a stale seed entry is still a legal profile value.
  {
    const need = mustAuthor();
    const seed = EXAMPLE_SEED_KEYS;
    const composed = composedKeys();
    // A must-author key is covered either by the seed or by `compose`, which
    // derives it from the project kind. Derived by differencing rather than
    // listed, so the two stay in step without either restating the other.
    const unseeded = need.filter((k) => !seed.includes(k) && !composed.includes(k));
    const stale    = seed.filter((k) => !need.includes(k));

    check(composed.length > 0,
      "control: `compose` really does fill some must-author key, so the exemption is not a hole",
      composed.join(", "));
    check(unseeded.length === 0,
      "every key an operator must author is seeded or composed",
      unseeded.length ? `no sample for: ${unseeded.join(", ")} — add one in scripts/profile-reference.mjs` : "");
    check(stale.length === 0,
      "and the seed authors NOTHING an operator would not have to author",
      stale.length ? `${stale.join(", ")} no longer needs authoring — remove it from EXAMPLE_SEED, ` +
                     `or the example overrides a default while claiming it came from withDefaults()` : "");
    check(need.length > 0 && seed.length > 0,
      "control: both sets are non-empty, so the two comparisons above are not vacuous",
      `mustAuthor=${need.length} seed=${seed.length}`);

    // AND THE SEED REALLY REACHES THE EXAMPLE. Comparing two key lists says
    // nothing about the object that is actually emitted.
    const example = exampleFor("product");
    const at = (o, path) => path.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
    const absent = seed.filter((k) => at(example, k) === undefined);
    check(absent.length === 0,
      "control: every seeded key is present in the generated example", absent.join(", "));
  }
}

// ── the example is what `reeve init` writes ──────────────────────────────────
//
// NOT a plausible profile assembled here. `reeve init` derives `state.mode` and
// `authority.profileLocation` from the project kind and the repository's
// visibility, so a seed picking the first enum member globally gave both kinds
// `in-repo` -- a validator-valid profile that contradicts the file `reeve init`
// writes for the same project, which is worse than no example because it looks
// authoritative.
//
// The example is composed by the same exported function `reeve init` uses. These
// assertions therefore check the RULE is being followed, not that this file
// remembers it.
{
  const { exampleFor } = await import("../scripts/profile-reference.mjs");
  const { compose } = await import("../src/init.mjs");
  const check = (ok, name, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) { if (detail) console.log("        " + detail); fail++; }
  };
  const at = (o, path) => path.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);

  const client  = exampleFor("client");
  const product = exampleFor("product");

  check(client.state.mode === "hub",
    "the client example takes state.mode `hub` from the composer, not the first enum member",
    client.state.mode);
  check(client.authority.profileLocation === "sidecar",
    "and a client profile is a sidecar, because a client repo carries no agent artifacts",
    client.authority.profileLocation);
  check(product.state.mode === "in-repo" && product.authority.profileLocation === "committed",
    "while a private product example gets in-repo and committed",
    `${product.state.mode} / ${product.authority.profileLocation}`);
  check(client.state.mode !== product.state.mode,
    "control: the two kinds really do differ, so a single global seed could not have produced both");

  // CONTROL: the seed answers everything `compose` would otherwise ask. An
  // unanswered question means the example is missing a value an operator must
  // supply, and it would silently ship incomplete.
  const authored = { project: { kind: "product" }, identity: {}, authority: {}, state: {} };
  const put = (o, path, v) => { const ps = path.split("."); let c = o;
    for (const k of ps.slice(0, -1)) c = (c[k] ??= {}); c[ps.at(-1)] = v; return o; };
  const { EXAMPLE_SEED_KEYS: seedKeys } = await import("../scripts/profile-reference.mjs");
  for (const k of seedKeys) put(authored, k, at(exampleFor("product"), k));
  const { unanswered } = compose(authored, [], {});
  check(unanswered.length === 0,
    "control: the seed leaves `compose` nothing to ask, so the example is complete",
    unanswered.map((q) => q.field).join(", "));
}

// ── every key states what it accepts ─────────────────────────────────────────
//
// Read off each validator, which now carries its own description, so the type
// and enum a key allows are never a second list beside `schema.mjs`. Without
// this an operator could not tell from the reference that
// `identity.visibility` takes only `public` or `private`.
{
  const { profileReference } = await import("../scripts/profile-reference.mjs");
  const fresh = profileReference();
  const check = (ok, name, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) { if (detail) console.log("        " + detail); fail++; }
  };
  const at = (o, path) => path.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
  const undescribed = Object.entries(FIELDS).filter(([, [, v]]) => !v?.describe).map(([k]) => k);
  check(undescribed.length === 0,
    "every declared key's validator describes what it accepts",
    undescribed.length ? `${undescribed.join(", ")} — wrap the validator in describe()` : "");
  check(FIELDS["identity.visibility"][1].describe === "one of public, private",
    "control: an enum validator names its members",
    FIELDS["identity.visibility"][1].describe);
  check(/one of public, private/.test(fresh),
    "and that description reaches the generated reference");
  // CONTROL: it is not one blanket sentence repeated. Distinct descriptions are
  // what make the column worth reading.
  const distinct = new Set(Object.values(FIELDS).map(([, v]) => v.describe)).size;
  check(distinct > 5, "control: the descriptions are distinct, not one sentence repeated", String(distinct));
}

// ── a description states the EFFECTIVE contract ──────────────────────────────
//
// A true statement about a field's own check can be a false one about what the
// loader accepts. `schemaVersion` was described as "an integer" while `validate`
// refuses every value but one, so the reference advertised values that fail at
// load time -- which is worse than saying nothing, because an operator acts on it.
{
  const { profileReference } = await import("../scripts/profile-reference.mjs");
  const { SCHEMA_VERSION, validate, withDefaults } = await import("../src/profile/schema.mjs");
  const fresh = profileReference();
  const check = (ok, name, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) { if (detail) console.log("        " + detail); fail++; }
  };

  check(FIELDS.schemaVersion[1].describe === `exactly ${SCHEMA_VERSION}`,
    "schemaVersion is described as the one value the loader accepts, not as `an integer`",
    FIELDS.schemaVersion[1].describe);
  // CONTROL: the field's OWN validator now refuses a wrong version, so the
  // description is a statement about this check rather than about a rule
  // enforced somewhere the reference cannot see.
  check(FIELDS.schemaVersion[1](SCHEMA_VERSION + 1) !== null,
    "control: and the field's validator itself refuses another integer");
  check(FIELDS.schemaVersion[1](SCHEMA_VERSION) === null,
    "control: while accepting the right one");

  // NESTED VALIDATORS. `a list of values` hid a real restriction behind a
  // sentence that looked like documentation, so an operator writes an absolute
  // path or a full URL and the loader rejects it.
  check(/relative path inside the checkout/.test(FIELDS["worker.dependencyPaths"][1].describe),
    "a list's ELEMENT restriction reaches the description",
    FIELDS["worker.dependencyPaths"][1].describe);
  check(/bare domain name/.test(FIELDS["builder.network.research.allowedDomains"][1].describe),
    "and so does the allowed-domains restriction",
    FIELDS["builder.network.research.allowedDomains"][1].describe);
  check(!/a list of values/.test(fresh),
    "no key is documented as `a list of values`, which describes nothing");

  // AND IT CANNOT SILENTLY RECUR: `isArr` refuses an undescribed inner at module
  // load. This is the guard rather than the count, because the count only
  // notices what someone remembered to look at -- it found a third case
  // (`lanes`) that no review had named.
  {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/profile/schema.mjs", import.meta.url), "utf8");
    check(/isArr needs a described inner validator/.test(src),
      "isArr REFUSES an undescribed inner validator, so the gap cannot be shipped");
  }
}

// ── a comment belongs to the key it sits above ───────────────────────────────
//
// `noteFor` takes the contiguous `//` run above a declaration, so a run that
// describes a GROUP is attributed to whichever key follows it. That happened:
// the watcher-group preface and the `watch.reviewActions` warning sat above
// `notify.provider`, and the reference said the notification provider was "OFF
// until review ingest exists" while `watch.reviewActions` had no detail at all.
//
// The repair was in the SOURCE -- the comments now sit above the keys they
// describe -- because a heuristic that guesses topic boundaries in prose would
// keep producing this. These assertions pin the attribution so the comments
// cannot drift back.
{
  const { noteFor } = await import("../scripts/profile-reference.mjs");
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/profile/schema.mjs", import.meta.url), "utf8");
  const check = (ok, name, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) { if (detail) console.log("        " + detail); fail++; }
  };

  const provider = noteFor(src, "notify.provider") ?? "";
  const review   = noteFor(src, "watch.reviewActions") ?? "";

  check(!/review ingest/.test(provider),
    "notify.provider's description does not carry another key's warning",
    provider.slice(0, 90));
  check(/escalation/.test(provider),
    "control: and it does carry its own", provider.slice(0, 90));
  check(/review ingest/.test(review),
    "watch.reviewActions carries the warning that is actually about it",
    review.slice(0, 90));
  check(review.length > 0 && provider.length > 0,
    "control: both keys are documented at all, so neither check passes by absence",
    `provider=${provider.length} review=${review.length}`);
}

// ── the declared key set, frozen ─────────────────────────────────────────────
//
// Nothing reads this fixture to make a decision; it is not a second inventory
// the code consults. It exists so that adding a key is a DELIBERATE act with a
// diff, rather than a line that lands in `FIELDS` and nowhere else -- which is
// measured behaviour in this repository, not a hypothetical, and it reached
// exactly one machine.
//
// It freezes BOTH halves: the key set, and a hash of the rendered reference. The
// key set alone would not notice a key whose PROSE changed, and the hash alone
// would not say WHICH key moved.
{
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { profileReference } = await import("../scripts/profile-reference.mjs");

  const frozen = JSON.parse(readFileSync(
    new URL("./fixtures/profile-fields-v1.json", import.meta.url), "utf8"));
  const now = Object.keys(FIELDS).sort();

  // CONTROL: the fixture really carries a key set. An empty or unparsed one
  // would make both comparisons below pass vacuously -- the same nothing-shaped
  // failure a derived-but-empty set produces.
  const loaded = Array.isArray(frozen.keys) && frozen.keys.length === frozen.count
                 && frozen.count > 0;
  console.log(`${loaded ? "PASS" : "FAIL"}  control: the freeze fixture carries a non-empty, self-consistent key set`);
  if (!loaded) { console.log(`        keys=${frozen.keys?.length} count=${frozen.count}`); fail++; }

  const added   = now.filter((k) => !frozen.keys.includes(k));
  const removed = frozen.keys.filter((k) => !now.includes(k));
  const same = added.length === 0 && removed.length === 0;
  console.log(`${same ? "PASS" : "FAIL"}  freeze: the declared key set is unchanged`);
  if (!same) {
    console.log(`        added: ${added.join(",") || "(none)"} | removed: ${removed.join(",") || "(none)"}`);
    console.log("        If this change is intended, regenerate test/fixtures/profile-fields-v1.json");
    console.log("        AND docs/profile-reference.md in the same commit.");
    fail++;
  }

  const shaNow = createHash("sha256").update(profileReference()).digest("hex");
  const shaSame = shaNow === frozen.reference_sha256;
  console.log(`${shaSame ? "PASS" : "FAIL"}  freeze: the rendered reference is unchanged`);
  if (!shaSame) {
    console.log(`        frozen ${frozen.reference_sha256?.slice(0, 12)} vs now ${shaNow.slice(0, 12)}`);
    console.log("        A key's prose or its required-ness changed. Regenerate both halves.");
    fail++;
  }
}

// ── the scheduling knobs, and their defaults ─────────────────────────────────
const withBuilder = (b) => { const p = clone(base); p.builder = b; return p; };

expectOk("the four scheduler knobs, the concurrency cap, the package floor and the starve window",
  withBuilder({ maxConcurrentTasks: 3, budget: { maxPackages: 4 }, lease: { starvedHours: 12 },
                provider: { concurrencyLimit: 4, guardianReserved: 0, cooldownSeconds: 30,
                            preemptAtBoundary: false } }));
expectRefusal("zero concurrent tasks", withBuilder({ maxConcurrentTasks: 0 }),
  /builder\.maxConcurrentTasks must be a positive integer/);
expectRefusal("a negative reservation", withBuilder({ provider: { guardianReserved: -1 } }),
  /builder\.provider\.guardianReserved must be a non-negative integer/);
// Asserted on the REASON, not just the key name. Before the key was declared
// this same case was refused as `unknown key`, so a bare key-name pattern went
// green while the validator did not exist at all.
expectRefusal("a truthy string where a boolean switch belongs",
  withBuilder({ provider: { preemptAtBoundary: "true" } }),
  /builder\.provider\.preemptAtBoundary must be a boolean/);

// Section 10.4's admission rule admits a builder request only when held leases
// are below `concurrencyLimit` MINUS `guardianReserved`. Reserving the whole
// pool is therefore a silent, permanent off switch for the builder that reads
// as a tuning choice -- so it is refused where it can still be explained.
expectRefusal("a reservation that leaves the builder no slot at all",
  withBuilder({ provider: { concurrencyLimit: 2, guardianReserved: 2 } }),
  /guardianReserved \(2\) must be less than builder\.provider\.concurrencyLimit \(2\)/);
expectOk("control: a reservation that leaves exactly one slot",
  withBuilder({ provider: { concurrencyLimit: 2, guardianReserved: 1 } }));

// The container guard: an array or a string here would take the defaults as
// named properties, validate, and serialize to nothing.
expectRefusal("builder.provider as an array", withBuilder({ provider: [] }),
  /builder\.provider must be an object/);
expectRefusal("builder.budget as an array", withBuilder({ budget: [] }),
  /builder\.budget must be an object/);
expectRefusal("builder.lease as an array", withBuilder({ lease: [] }),
  /builder\.lease must be an object/);

// ── the defaults reach a profile that sets none of them ──────────────────────
{
  const check = (ok, name, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) { if (detail) console.log("        " + detail); fail++; }
  };
  const d = withDefaults(clone(base));
  for (const [path, want] of [["maxConcurrentTasks", 2], ["budget.maxPackages", 2],
                              ["lease.starvedHours", 24], ["provider.concurrencyLimit", 2],
                              ["provider.guardianReserved", 1], ["provider.cooldownSeconds", 300],
                              ["provider.preemptAtBoundary", true]]) {
    const got = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), d.builder);
    check(got === want, `defaults: builder.${path} is ${want}`, `got ${JSON.stringify(got)}`);
  }
  // CONTROL: an explicit value is NEVER overridden by the default.
  const explicit = withDefaults(withBuilder({ maxConcurrentTasks: 7 }));
  check(explicit.builder.maxConcurrentTasks === 7, "defaults: an explicit value wins",
    JSON.stringify(explicit.builder.maxConcurrentTasks));
  // And the defaulted profile is itself valid, or the defaults have invented a
  // profile the validator would refuse.
  expectOk("control: the defaulted profile validates", clone(base));

  // CONTROL: the shipped defaults SATISFY the cross-field rule. A default pair
  // that refused itself would make every bare profile invalid, which is the
  // opposite failure and one the rule above cannot see.
  check(d.builder.provider.guardianReserved < d.builder.provider.concurrencyLimit,
    "control: the default reservation leaves the builder a slot",
    `${d.builder.provider.guardianReserved} of ${d.builder.provider.concurrencyLimit}`);
}

// ── the generated profile writes builder and worker in a declared position ───
//
// A declared key with no default AND no position is a key that reaches one
// machine: `commitPattern` was in FIELDS and appeared zero times in init.mjs, so
// every freshly initialised profile gave the reviewer no way to bind a clean
// pass to a revision, and the live profile had it only because someone added it
// by hand.
{
  const check = (ok, name, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) { if (detail) console.log("        " + detail); fail++; }
  };
  const { canonical } = await import("../src/init.mjs");
  const order = Object.keys(canonical(withDefaults(withBuilder({ maxConcurrentTasks: 2 }))));
  check(order.indexOf("builder") >= 0 && order.indexOf("worker") >= 0 &&
        order.indexOf("builder") < order.indexOf("watch"),
    "init: builder and worker have a declared position", "order was: " + order.join(","));

  // CONTROL: `canonical` really orders by ORDER rather than by insertion, so the
  // assertion above is about the declaration and not about the object it was
  // handed. Built with `watch` FIRST; a pass-through would keep it there.
  const scrambled = canonical({ watch: { intervalSeconds: 1 }, project: { kind: "product" },
                                schemaVersion: 1 });
  const ks = Object.keys(scrambled);
  check(ks.indexOf("schemaVersion") < ks.indexOf("watch"),
    "control: canonical orders by the declaration, not by insertion", ks.join(","));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
