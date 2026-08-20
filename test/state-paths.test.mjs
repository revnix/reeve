// State was keyed by the SHORT repository name, so `owner-a/api` and
// `owner-b/api` shared one database and one dashboard. Two projects would have
// written each other's runs, settlement, fix attempts and escalations into the
// same rows, and the second one's dashboard would have overwritten the first's.
//
// reeve's stated primary requirement is serving many projects. A key that cannot
// tell two of them apart is a direct contradiction of it, and the failure would
// have been silent: nothing errors when two repositories share a store, it just
// quietly answers questions about the wrong one.
import { statePathFor, dashPathFor, legacyStatePathFor } from "../src/paths.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const HOME = "/home/x/.reeve";

// The collision, stated as an assertion.
{
  const a = statePathFor(HOME, "owner-a/api");
  const b = statePathFor(HOME, "owner-b/api");
  check(a !== b, "two repositories with the same short name get different databases", `${a}\n        ${b}`);
  check(a.includes("owner-a") && b.includes("owner-b"), "and the owner is what distinguishes them", a);
}
{
  const a = dashPathFor(HOME, "owner-a/api");
  const b = dashPathFor(HOME, "owner-b/api");
  check(a !== b, "and different dashboards, so one cannot overwrite the other", `${a}\n        ${b}`);
}

// Stable and idempotent: the same repo always resolves to the same place.
{
  check(statePathFor(HOME, "nextlyhq/nextly") === statePathFor(HOME, "nextlyhq/nextly"),
    "control: the same repository always resolves to the same path");
}

// A path is not a place to put a repository name unescaped.
{
  const p = statePathFor(HOME, "owner/../../etc/passwd");
  check(!p.includes(".."), "a repository name cannot escape the state directory with ..", p);
  check(p.startsWith(HOME), "and the result stays under the reeve home", p);
}

// The old location has to remain nameable, or an existing store cannot be found
// and moved -- and a silently new empty database is how a thousand events of real
// history stop being read without anything failing.
{
  const old = legacyStatePathFor(HOME, "nextlyhq/nextly");
  check(old.endsWith("nextly.db"), "the legacy short-name path is still computable", old);
  check(old !== statePathFor(HOME, "nextlyhq/nextly"), "and differs from the new one", old);
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
