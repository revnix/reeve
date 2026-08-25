// A ruleset requiring signed commits refuses every repair reeve makes, because
// reeve commits in a checkout whose global and system configuration are
// /dev/null and it has no signing key there. That has to be said BEFORE a worker
// run is paid for, not discovered at the push.
//
// But only where the rule can actually reach a repair. A disabled ruleset, one
// targeting tags, or one scoped to `release/*` governs nothing reeve pushes, and
// reporting those as broken would condemn a repository that is fine.
import { checkMergeAuthority } from "../src/doctor.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// Branch protection that is otherwise healthy, so the level under test is the
// ruleset's and not something else's.
const HEALTHY_PROTECTION = JSON.stringify({
  enforce_admins: { enabled: true },
  required_status_checks: { contexts: ["CI"], strict: true },
});

const apiFor = ruleset => path => {
  if (/\/branches\/main\/protection$/.test(path)) return { ok: true, out: HEALTHY_PROTECTION };
  if (/\/rulesets$/.test(path)) return { ok: true, out: JSON.stringify(ruleset ? [{ id: 1 }] : []) };
  if (/\/rulesets\/1$/.test(path)) return { ok: true, out: JSON.stringify(ruleset) };
  return { ok: false, err: "404" };
};

const SIGNED = { type: "required_signatures" };
const CHECKS = { type: "required_status_checks" };
const base = extra => ({ name: "r", enforcement: "active", target: "branch", bypass_actors: [],
                         rules: [CHECKS, SIGNED], ...extra });

// The control first: without a signature rule, nothing here should fire.
{
  const r = checkMergeAuthority("o/r", { api: apiFor(base({ rules: [CHECKS] })) });
  check(!r.lines.some(l => /signed commits/.test(l)), "control: a ruleset with no signature rule says nothing about signing", r.lines.join(" | "));
  check(r.level === "OK", "control: and the check is otherwise healthy", `${r.level}: ${r.lines.join(" | ")}`);
}

// Covers every branch: a repair on any pull request head is refused.
for (const cond of [undefined, { include: ["~ALL"] }, { include: ["~ALL"], exclude: [] }]) {
  const r = checkMergeAuthority("o/r", { api: apiFor(base(cond ? { conditions: { ref_name: cond } } : {})) });
  check(r.level === "BROKEN", `required_signatures over ${JSON.stringify(cond) ?? "no condition"} is BROKEN`, `${r.level}: ${r.lines.join(" | ")}`);
  check(r.lines.some(l => /every branch/.test(l) && /unsigned/.test(l)), "and says reeve commits unsigned", r.lines.join(" | "));
  // The bypass remedy describes the OPPOSITE failure. Here the gates hold and
  // reeve cannot get through them; telling an operator to remove a bypass sends
  // them after something that is not there.
  check(!r.lines.some(l => /bypass/.test(l)), "and does NOT tell the operator to remove a bypass", r.lines.join(" | "));
}

// A bypass actor changes whether the refusal is CERTAIN. An actuator inside an
// `always` bypass pushes straight through the signature rule, so a flat "every
// repair will be refused" points an operator at the wrong problem.
{
  const both = base({ rules: [{ type: "required_status_checks" }, { type: "required_signatures" }],
                      bypass_actors: [{ actor_type: "OrganizationAdmin", bypass_mode: "always" }] });
  const r = checkMergeAuthority("o/r", { api: apiFor(both) });
  const sig = r.lines.filter(l => /signed commits/.test(l)).join(" | ");

  // Asserted as a DIFFERENCE rather than as a phrase. The property is that a
  // bypass changes the prediction from certain to conditional; "inside the
  // bypass" is one wording of that and pinning it means the assertion goes red
  // when someone improves the sentence, which is the opposite of what a guard
  // should do. The same ruleset without a bypass is rendered here and the two are
  // compared, so any wording that actually distinguishes the cases passes.
  const flat = base({ rules: [{ type: "required_status_checks" }, { type: "required_signatures" }],
                      bypass_actors: [] });
  const plain = checkMergeAuthority("o/r", { api: apiFor(flat) })
    .lines.filter(l => /signed commits/.test(l)).join(" | ");
  check(sig !== plain, "a bypass changes what the signature line says at all", `${sig}\n        vs ${plain}`);
  // No length comparison. It looked like a property and is not: a correct rewrite
  // can make the conditional form SHORTER -- replacing the flat prediction instead
  // of appending to it -- and would be rejected for its character count while
  // distinguishing the cases perfectly. That is the same phrasing sensitivity this
  // block was rewritten to remove, wearing a numeric disguise.
  check(/OrganizationAdmin/.test(sig) && !/OrganizationAdmin/.test(plain),
    "and what it adds is the actor, which the flat form never names", sig);
}

// Naming the CLASS is not naming the actor. Two entries of the same type render
// identically unless the id comes with them, and then the caveat tells an operator
// a bypass exists while withholding the only field that could tell them whose it
// is. For `Integration` that id is the App id reeve identifies itself by, so this
// is the difference between a usable diagnostic and a rhetorical one.
{
  const two = base({ rules: [{ type: "required_status_checks" }, { type: "required_signatures" }],
                     bypass_actors: [{ actor_type: "Team", actor_id: 1, bypass_mode: "always" },
                                     { actor_type: "Team", actor_id: 2, bypass_mode: "always" },
                                     { actor_type: "Integration", actor_id: 987654, bypass_mode: "always" }] });
  const r = checkMergeAuthority("o/r", { api: apiFor(two) });
  const sig = r.lines.filter(l => /signed commits/.test(l)).join(" | ");
  const allow = r.lines.filter(l => /bypass ALWAYS/.test(l)).join(" | ");
  for (const [where, line] of [["the signature caveat", sig], ["the bypass line", allow]]) {
    check(/Team:1/.test(line) && /Team:2/.test(line),
      `${where} tells two same-type actors apart`, line);
    check(/Integration:987654/.test(line),
      `${where} carries the App id, which is how reeve identifies itself`, line);
  }
  // Control: the fixture really does contain two actors that are identical apart
  // from the id. Without this the assertions above pass equally well on a fixture
  // that never had the ambiguity in it.
  check(two.bypass_actors.filter(b => b.actor_type === "Team").length === 2,
    "control: the fixture holds two actors of the same type", JSON.stringify(two.bypass_actors));
}

// An actor type carrying no id degrades to the bare type. A dangling colon reads
// as a truncated id, which is worse than saying less.
{
  const noId = base({ rules: [{ type: "required_status_checks" }, { type: "required_signatures" }],
                      bypass_actors: [{ actor_type: "OrganizationAdmin", bypass_mode: "always" }] });
  const r = checkMergeAuthority("o/r", { api: apiFor(noId) });
  const sig = r.lines.filter(l => /signed commits/.test(l)).join(" | ");
  check(/OrganizationAdmin(?!:)/.test(sig) && !/OrganizationAdmin:/.test(sig),
    "an actor with no id is named without a trailing colon", sig);
}

// Without one, it stays a flat prediction.
{
  const noBypass = base({ rules: [{ type: "required_status_checks" }, { type: "required_signatures" }],
                          bypass_actors: [] });
  const r = checkMergeAuthority("o/r", { api: apiFor(noBypass) });
  const sig = r.lines.filter(l => /signed commits/.test(l)).join(" | ");
  // The converse, and still not a phrase match: with nobody able to bypass, no
  // bypass actor may be named at all. That is the property; how the certainty is
  // worded is not this test's business.
  check(sig.length > 0 && !/OrganizationAdmin|Team:|Integration:/.test(sig),
    "control: with no bypass, the line names no bypass actor", sig);
}

// The bypass remedy is still there when a bypass is what broke it.
{
  const withBypass = base({ bypass_actors: [{ actor_type: "OrganizationAdmin", bypass_mode: "always" }] });
  const r = checkMergeAuthority("o/r", { api: apiFor(withBypass) });
  check(r.level === "BROKEN", "control: a bypass actor is still BROKEN", `${r.level}: ${r.lines.join(" | ")}`);
  check(r.lines.some(l => /bypass/.test(l) && /decorative/.test(l)), "and the bypass remedy is still given for it", r.lines.join(" | "));
}

// Scoped to branches a repair will not land on: a possibility, not a certainty.
{
  const r = checkMergeAuthority("o/r", { api: apiFor(base({ conditions: { ref_name: { include: ["refs/heads/release/*"] } } })) });
  check(r.level === "DEGRADED", "a ruleset scoped to release/* is DEGRADED, not BROKEN", `${r.level}: ${r.lines.join(" | ")}`);
  check(r.lines.some(l => /release\/\*/.test(l)), "and names the branches it covers", r.lines.join(" | "));
}

// Cannot reach a repair at all.
for (const [what, extra] of [["disabled", { enforcement: "disabled" }], ["tag-targeted", { target: "tag" }]]) {
  const r = checkMergeAuthority("o/r", { api: apiFor(base(extra)) });
  check(!r.lines.some(l => /signed commits/.test(l)), `a ${what} ruleset's signature rule is not reported`, r.lines.join(" | "));
  check(r.level === "OK", `and a ${what} ruleset does not make the repository broken`, `${r.level}: ${r.lines.join(" | ")}`);
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
