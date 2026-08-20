// The validator must REFUSE. Each case below is a real shape from the portfolio
// that would have caused a gate to judge the wrong thing, so each must produce an
// error rather than a default.
import { validate, withDefaults } from "../src/profile/schema.mjs";

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

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
