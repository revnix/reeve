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
}

expectRefusal("a capability switch that is not a boolean",
  (() => { const p = clone(base); p.builder = { capabilities: { mergeBuilderPr: "yes" } }; return p; })(),
  /builder\.capabilities\.mergeBuilderPr must be a boolean/);

expectRefusal("a founder user id that is not an integer",
  (() => { const p = clone(base); p.builder = { founder: { userId: "123" } }; return p; })(),
  /builder\.founder\.userId must be an integer/);

expectOk("all five switches set explicitly",
  (() => { const p = clone(base); p.builder = { capabilities: { observe: true, draftSpec: false, implementLocal: false, publishPr: false, mergeBuilderPr: false } }; return p; })());

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
