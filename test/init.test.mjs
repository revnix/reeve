// init must never destroy what it cannot detect, and must never write agent
// artifacts into a repo that may not carry them.
import { mergeProfile, semanticDiff, profilePath, compose, prove, canonical } from "../src/init.mjs";
import { resolveHome } from "../src/home.mjs";
import { join } from "node:path";

let fail = 0;
const check = (n, got, want) => { const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) { console.log(`        got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); fail++; } };

// ── merge, not replace ────────────────────────────────────────────────────
// Lanes, risk paths, reviewer refusal patterns and tool pins are NOT detectable.
// Replacing an existing profile silently destroys the part a human wrote, which
// is most of the part that matters.
{
  const existing = {
    schemaVersion: 1, project: { kind: "product" },
    identity: { key: "o/r", defaultBranch: "main", visibility: "private", worktreeRoot: "../wt" },
    authority: { permission: "admin", policy: "propose_and_merge", profileLocation: "committed" },
    state: { mode: "in-repo" },
    units: [{ id: "root", root: ".", language: "typescript", packageManager: "pnpm",
              toolPins: { ruff: "0.13.0" },
              commands: { test: { cmd: "old", state: "present" } } }],
    lanes: [{ id: "schema", territory: ["packages/nextly/**"] }],
    risk: { sensitivePaths: ["auth/**"], forbiddenCommands: ["db:migrate:fresh"] },
    reviewers: [{ login: "coderabbitai", kind: "blocking", refusal: "Review rate limited" }],
    ci: { provider: "github-actions" }, merge: { method: "squash", enforcement: "enforced" },
  };
  const detected = {
    schemaVersion: 1, project: { kind: "product" },
    identity: { key: "o/r", defaultBranch: "trunk", visibility: "public" },
    authority: { permission: "write", policy: "propose_only", profileLocation: "sidecar" },
    state: {}, units: [{ id: "root", root: ".", language: "typescript", packageManager: "pnpm",
                         commands: { test: { cmd: "new", state: "present" }, lint: { cmd: "l", state: "present" } } }],
    ci: { provider: "none" }, merge: { enforcement: "attested" }, reviewers: [],
  };
  const m = mergeProfile(existing, detected);

  check("hand-written lanes survive", m.lanes?.[0]?.id, "schema");
  check("hand-written risk paths survive", m.risk?.forbiddenCommands?.[0], "db:migrate:fresh");
  check("hand-written tool pins survive", m.units[0].toolPins?.ruff, "0.13.0");
  check("hand-written worktreeRoot survives", m.identity.worktreeRoot, "../wt");
  check("the reviewer roster survives", m.reviewers[0].refusal, "Review rate limited");

  // Facts about the repo ARE detection's to update.
  check("a changed default branch is taken", m.identity.defaultBranch, "trunk");
  check("a changed visibility is taken", m.identity.visibility, "public");
  check("a changed permission is taken", m.authority.permission, "write");
  check("a changed enforcement is taken", m.merge.enforcement, "attested");
  check("a refreshed command is taken", m.units[0].commands.test.cmd, "new");
  check("a newly seen command is added", m.units[0].commands.lint.state, "present");

  // Detection has no opinion on merge method when the history is mixed, and
  // silence must not erase a settled answer.
  check("a merge method detection could not infer is NOT erased", m.merge.method, "squash");
}
{
  // A unit that stops being detected must not silently vanish: a temporarily
  // unreadable directory would otherwise drop that lane's territory.
  const existing = { units: [{ id: "root", root: "." }, { id: "e2e", root: "e2e" }] };
  const m = mergeProfile(existing, { units: [{ id: "root", root: ".", language: "typescript" }] });
  check("an undetected unit is kept, not dropped", m.units.some(u => u.id === "e2e"), true);
}
check("with no existing profile, detection is used whole",
  mergeProfile(null, { units: [{ id: "x" }] }).units[0].id, "x");

// ── the location rule ─────────────────────────────────────────────────────
// This is the anonymity requirement enforced by code rather than by remembering.
{
  const q = [{ field: "project.kind" }, { field: "authority.policy" }];
  const base = { schemaVersion: 1, project: {}, identity: { key: "o/r", visibility: "private" },
                 authority: { permission: "admin" }, state: {}, units: [], ci: {}, merge: {}, reviewers: [] };
  const client = compose(structuredClone(base), q, { "project.kind": "client", "authority.policy": "propose_only" });
  check("a client profile is never committed", client.profile.authority.profileLocation, "sidecar");
  check("and its state goes to a hub", client.profile.state.mode, "hub");

  const pub = compose({ ...structuredClone(base), identity: { key: "o/r", visibility: "public" } }, q,
                      { "project.kind": "product", "authority.policy": "propose_and_merge" });
  check("a public repo is never committed either", pub.profile.authority.profileLocation, "sidecar");
  check("and its state goes to a sibling", pub.profile.state.mode, "sibling");

  const priv = compose(structuredClone(base), q, { "project.kind": "product", "authority.policy": "propose_and_merge" });
  check("a private product repo may commit its profile", priv.profile.authority.profileLocation, "committed");
}
// THE PROPERTY, not the spelling. This asserted that the path contains the
// literal `.reeve/profiles`, which is only true when REEVE_HOME happens to be a
// directory NAMED `.reeve` -- so the standing rule to scope every run with a
// scratch REEVE_HOME made this fail on a correct configuration. What matters is
// that a sidecar profile lands under the reeve home and never inside the
// repository it describes.
check("a sidecar path never points inside the repo",
  profilePath("o/r", "sidecar").startsWith(join(resolveHome(), "profiles")), true);

// ── an unanswered question is fatal ───────────────────────────────────────
// Every unanswerable question is one where a wrong guess makes a gate judge the
// wrong thing, so none of them gets a default.
{
  const r = compose({ schemaVersion: 1, project: {}, identity: { key: "o/r", visibility: "private" },
                      authority: { permission: "admin" }, state: {}, units: [], ci: {}, merge: {}, reviewers: [] },
                    [{ field: "project.kind" }, { field: "authority.policy" }], {});
  check("unanswered questions are reported, not defaulted", r.unanswered.length, 2);
}

// ── the semantic diff ─────────────────────────────────────────────────────
// A line diff of reformatted JSON reports every line as changed and hides the
// one that actually did.
{
  const a = { x: 1, nested: { y: "same" } };
  const b = { x: 1, nested: { y: "same" } };
  check("identical objects diff to nothing", semanticDiff(a, b).length, 0);
  check("a real change is found", semanticDiff(a, { x: 2, nested: { y: "same" } })[0].path, "x");
  check("a nested change reports its full path", semanticDiff(a, { x: 1, nested: { y: "other" } })[0].path, "nested.y");
}

// ── the proof is honest about what it cannot promise ──────────────────────
{
  const p = prove({ units: [{ id: "root", packageManager: "npm", language: "typescript",
                              commands: { lint: { state: "broken", reason: "eslint not installed" } } }],
                    ci: { provider: "none" }, merge: { enforcement: "attested" }, reviewers: [] });
  check("a broken command is flagged", p.findings.some(f => /broken/.test(f.text)), true);
  check("no CI is flagged as 'green is unreachable'", p.findings.some(f => /not a reachable state/.test(f.text)), true);
  check("attested enforcement is flagged", p.findings.some(f => /attested/.test(f.text)), true);
  check("no reviewer is flagged", p.findings.some(f => /no reviewer/.test(f.text)), true);
  check("and none of that is an error", p.ok, true);
  const bad = prove({ units: [] });
  check("but no buildable unit IS an error", bad.ok, false);
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
