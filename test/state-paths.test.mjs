// State was keyed by the SHORT repository name, so `owner-a/api` and
// `owner-b/api` shared one database and one dashboard. Two projects would have
// written each other's runs, settlement, fix attempts and escalations into the
// same rows, and the second one's dashboard would have overwritten the first's.
//
// reeve's stated primary requirement is serving many projects. A key that cannot
// tell two of them apart is a direct contradiction of it, and the failure would
// have been silent: nothing errors when two repositories share a store, it just
// quietly answers questions about the wrong one.
import { statePathFor, dashPathFor, legacyStatePathFor,
         taskPathFor, artifactPathFor, runPathFor } from "../src/paths.mjs";
import { join, resolve, relative, isAbsolute } from "node:path";

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

// ── A task's tree, and the paths beneath it ────────────────────────────────
{
  const id = "bt:01JABCDEFGHJKMNPQRSTVWXYZ0";
  check(taskPathFor(HOME, id).startsWith(join(HOME, "tasks")),
    "a task's tree lives under the reeve home's tasks directory", taskPathFor(HOME, id));

  // CONTAINMENT IS THE PROPERTY, and a search for ".." is only a proxy for it.
  // `safe` replaces every character outside [A-Za-z0-9._-], which includes both
  // separators, so what comes back is a SINGLE path segment -- `../../etc`
  // becomes `--..-etc`, which still contains two dots and still cannot traverse,
  // because a segment is not a path. Asserting the dots were removed would fail
  // against code that is correct, and would pass against code that stripped the
  // dots while leaving a separator in. So the assertion resolves the path and
  // requires it to stay inside, which is the thing that actually matters.
  const tasks = resolve(join(HOME, "tasks"));
  for (const hostile of ["../../etc", "..", "a/../../b", "/etc/passwd", "....//x", "a\\..\\b"]) {
    const got = resolve(taskPathFor(HOME, hostile));
    const rel = relative(tasks, got);
    check(rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes("/"),
      `a task id cannot escape the tasks directory: ${JSON.stringify(hostile)}`,
      `${got} -> relative ${JSON.stringify(rel)}`);
  }
  // CONTROL: an ordinary id resolves to exactly one segment inside, so the loop
  // above is not passing because every input lands somewhere harmless.
  check(relative(tasks, resolve(taskPathFor(HOME, id))) === "bt-01JABCDEFGHJKMNPQRSTVWXYZ0",
    "control: and a real id is one segment beneath it, unchanged apart from its colon",
    relative(tasks, resolve(taskPathFor(HOME, id))));

  check(artifactPathFor(HOME, id, "RESEARCH").endsWith(join("artifacts", "research.md")),
    "RESEARCH's artifact is research.md", artifactPathFor(HOME, id, "RESEARCH"));
  check(artifactPathFor(HOME, id, "SIZING").endsWith(join("artifacts", "sizing.json")),
    "and SIZING's is sizing.json, because the extension follows the phase",
    artifactPathFor(HOME, id, "SIZING"));
  check(runPathFor(HOME, id, { generation: 2, phase: "RESEARCH", slice: 0, attempt: 1, stream: "out" })
        .endsWith(join("runs", "g2-RESEARCH-s0-a1.out")),
    "and a run's output file names its generation, phase, slice and attempt",
    runPathFor(HOME, id, { generation: 2, phase: "RESEARCH", slice: 0, attempt: 1, stream: "out" }));

  let threw = null;
  try { artifactPathFor(HOME, id, "IMPLEMENTING"); } catch (e) { threw = String(e.message); }
  check(threw !== null, "and a phase with no artifact has no artifact path", String(threw));
  check(/reviewDiff/.test(threw ?? ""),
    "and says what reviews that phase's product instead", String(threw));

  // EVERY RUN FIELD IS REQUIRED. A run path that omits the attempt overwrites
  // the previous attempt's transcript, so an absent field must throw rather than
  // render as "undefined" in a filename.
  for (const missing of ["generation", "phase", "slice", "attempt", "stream"]) {
    const run = { generation: 2, phase: "RESEARCH", slice: 0, attempt: 1, stream: "out" };
    delete run[missing];
    let t = null;
    try { runPathFor(HOME, id, run); } catch (e) { t = String(e.message); }
    check(t !== null, `a run path without ${missing} throws rather than naming a file`, String(t));
  }
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
