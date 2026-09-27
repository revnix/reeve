// The authority baseline reads every page of a list with the gh Ubuntu ships.
//
// `reeve doctor`'s authority baseline (R-13) read the repository's rulesets with
// `gh api --paginate --slurp`. The gh in Ubuntu's own archive is 2.46, which has
// no `--slurp` and answers "unknown flag: --slurp". So on a WSL host with that gh
// the check could never read the live rules, and said UNKNOWN for good.
// Measured in docs/measured/2026-09-27-gh-2.46-has-no-slurp.md.
import test from "node:test";
import assert from "node:assert/strict";
import { ghApi } from "../src/baseline.mjs";

// gh 2.46, as far as this reader uses it, with the given pages behind a list:
// `--slurp` is an unknown flag; `--paginate --jq '.[] | tojson'` prints each item
// of every page as one line of JSON; plain `--paginate` prints the pages' bodies
// one after another, which is not one JSON document.
const gh246 = (pages, single = { default_branch: "main" }) => (file, args) => {
  assert.equal(file, "gh");
  if (args.includes("--slurp")) {
    const e = /** @type {Error & { status?: number, stderr?: string }} */ (new Error(`Command failed: gh ${args.join(" ")}\nunknown flag: --slurp`));
    e.status = 1;
    e.stderr = "unknown flag: --slurp\n";
    throw e;
  }
  if (!args.includes("--paginate")) return JSON.stringify(single);
  const at = args.indexOf("--jq");
  if (at >= 0 && args[at + 1] === ".[] | tojson") return pages.flat().map(x => JSON.stringify(x) + "\n").join("");
  return pages.map(p => JSON.stringify(p)).join("");
};

test("a paged list is read in full with the gh Ubuntu ships, which has no --slurp", () => {
  const pages = [[{ id: 1, name: "a" }, { id: 2, name: "b" }], [{ id: 3, name: "c\nwith a line break" }]];
  let got;
  assert.doesNotThrow(() => { got = ghApi("repos/o/r/rulesets", { list: true, exec: gh246(pages) }); });
  assert.deepEqual(got, pages.flat());
});

test("an empty list reads as empty, not as a failure", () => {
  let got;
  assert.doesNotThrow(() => { got = ghApi("repos/o/r/rulesets", { list: true, exec: gh246([]) }); });
  assert.deepEqual(got, []);
});

test("a single read still returns its object", () => {
  assert.deepEqual(ghApi("repos/o/r", { exec: gh246([]) }), { default_branch: "main" });
});

test("a read that fails still throws, so it can never become a baseline", () => {
  const refused = () => { throw new Error("Command failed: gh api repos/o/r/rulesets\nHTTP 403: Resource not accessible"); };
  assert.throws(() => ghApi("repos/o/r/rulesets", { list: true, exec: refused }), /HTTP 403/);
});
