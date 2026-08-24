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
