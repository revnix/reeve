// A check the profile names and the base's rules bind to an App (#290). The two
// were kept side by side, the profile's bound to no App, so any App's run of that
// name counted, and another App's failing run of it made the base red, and held
// every pull request into it, while GitHub, going by the rule, let them merge.
import test from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/github/reconciler.mjs";
import { requiredChecksOf, gatingOf } from "../src/pr.mjs";

const ACTIONS = "15368", OTHER = "999";
/** A check run at a commit, completed with `conclusion`, by the App `app`. */
const run = (/** @type {string} */ name, /** @type {string} */ conclusion, app = ACTIONS) =>
  ({ name, source: "check_run", appId: app, id: "1", state: "completed", conclusion, completedAt: new Date(0).toISOString() });
/** What's required, with the profile naming `named` and the base's rules requiring `base`. */
const required = (/** @type {string[]} */ named, /** @type {{ context: string, app: string | null }[]} */ base) =>
  requiredChecksOf({ nwo: "o/r", baseRef: "main", profile: /** @type {any} */ ({ ci: { requiredChecks: named } }), appId: "4242", requirements: () => base });

test("a check the base binds to an App is required only as it binds it, though the profile names it too", () => {
  const req = required(["CI gate"], [{ context: "CI gate", app: ACTIONS }]);
  assert.deepEqual(req.required, [{ context: "CI gate", app: ACTIONS, origin: "base" }]);
});

test("another App's failing run of a check the base binds doesn't make the base red, though the profile names it", () => {
  const req = required(["CI gate"], [{ context: "CI gate", app: ACTIONS }]);
  const h = classify([run("CI gate", "success"), run("CI gate", "failure", OTHER)], [], { evidence: false, failuresOf: gatingOf(req) });
  assert.equal(h.verdict, "GREEN", h.why);
});

test("control: a check the profile names and the base doesn't is still required, bound to no App", () => {
  const req = required(["lint"], [{ context: "CI gate", app: ACTIONS }]);
  assert.deepEqual(req.required, [{ context: "lint", app: null, origin: "profile" }, { context: "CI gate", app: ACTIONS, origin: "base" }]);
});

test("control: a check both name, the base binding it to no App, is one entry, the base's", () => {
  const req = required(["CI gate"], [{ context: "CI gate", app: null }]);
  assert.deepEqual(req.required, [{ context: "CI gate", app: null, origin: "base" }]);
});

test("control: the base's App's own failing run of it still makes the base red", () => {
  const req = required(["CI gate"], [{ context: "CI gate", app: ACTIONS }]);
  const h = classify([run("CI gate", "failure")], [], { evidence: false, failuresOf: gatingOf(req) });
  assert.equal(h.verdict, "RED");
});
