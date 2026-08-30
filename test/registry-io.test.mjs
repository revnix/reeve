// The registry file, parsed.
//
// A MALFORMED ENTRY IS AN ERROR, not a row to drop: filtering one out returns
// `error: null`, doctor then sets `projectsKnown: true` over a project set the
// registry does not describe, and `hubFindings` SUPPRESSES every gate-state row
// absent from that set -- so a broken registry reports a clean hub while hiding
// exactly the H-4 authority findings the H-7 path exists to preserve.
//
// WHY THIS IS A NEW MODULE AND NOT AN ADDITION TO `registry.mjs`.
// `test/hub-registry.test.mjs` walks `registry.mjs`'s import graph and asserts
// it reaches no `node:fs`, `node:child_process` or network module, with controls
// proving the walk is not blind. That assertion is what makes "admitTask
// performs no I/O" a property of CAPABILITY rather than a claim about
// discipline, and this loader is built on `readFileSync`. Moving it into
// `registry.mjs` would turn that assertion red and take the guarantee with it.

import { parseRegistry } from "../src/build/registryio.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const P = "/x/projects.json";
const good = { nextly: { nwo: "o/r", repoPath: "/repo", profilePath: "/p.json" } };
const parse = (obj) => parseRegistry(typeof obj === "string" ? obj : JSON.stringify(obj), P);

// ── the shape both callers take ─────────────────────────────────────────────
{
  const r = parse(good);
  check(r.error === null && r.projects.length === 1, "a well-formed registry parses", JSON.stringify(r.error));
  check(r.projects[0].repoPath === "/repo" && r.projects[0].profilePath === "/p.json",
    "and every row carries the repository path and the profile path", JSON.stringify(r.projects[0]));
  check(r.registry.projects.nextly?.nwo === "o/r",
    "and the same read yields the shape resolveSnapshot takes", JSON.stringify(r.registry.projects));
  check(r.projects[0].name === "nextly", "and the row is named by its registry key",
    JSON.stringify(r.projects[0]));
}

// ── the two new required fields ─────────────────────────────────────────────
//
// Each refused for the same reason the nwo is: a row `resolveSnapshot` cannot
// complete is a row admission would key on nothing.
for (const [label, entry] of [
  ["no repoPath",         { nwo: "o/r", profilePath: "/p.json" }],
  ["no profilePath",      { nwo: "o/r", repoPath: "/repo" }],
  ["a relative repoPath", { nwo: "o/r", repoPath: "repo", profilePath: "/p.json" }],
  ["a relative profilePath", { nwo: "o/r", repoPath: "/repo", profilePath: "p.json" }],
]) {
  const r = parse({ nextly: entry });
  check(r.projects.length === 0 && typeof r.error === "string" && /nextly/.test(r.error),
    `an entry with ${label} is a registry ERROR naming it`, JSON.stringify(r));
}

// ── the discipline carried over from the CLI, verbatim ──────────────────────
//
// Each of these was a MEASURED hiding of an H-4 finding. They are asserted here
// so that moving the code cannot quietly narrow it.
for (const [label, body] of [
  ["a top level that is an array", ["nextly"]],
  ["a top level that is null",     null],
  ["an entry that is a string",    { nextly: "bad" }],
  ["an entry with no nwo",         { nextly: { repoPath: "/repo", profilePath: "/p.json" } }],
  ["an nwo that is not owner/repo",{ nextly: { nwo: "notanwo", repoPath: "/repo", profilePath: "/p.json" } }],
  ["an nwo of dot segments",       { nextly: { nwo: "../..",  repoPath: "/repo", profilePath: "/p.json" } }],
  ["a bare hyphen as the owner",   { nextly: { nwo: "-/repo", repoPath: "/repo", profilePath: "/p.json" } }],
  ["consecutive hyphens",          { nextly: { nwo: "a--b/r", repoPath: "/repo", profilePath: "/p.json" } }],
  ["an owner past 39 characters",  { nextly: { nwo: "a".repeat(40) + "/r", repoPath: "/repo", profilePath: "/p.json" } }],
  ["a hyphenated owner past it",   { nextly: { nwo: Array(39).fill("a").join("-") + "/r", repoPath: "/repo", profilePath: "/p.json" } }],
]) {
  const r = parse(body);
  check(r.error !== null && r.projects.length === 0, `${label} is a registry error`,
    JSON.stringify(r.error));
}

// CONTROLS: the names that must keep working, or the rules above are refusing
// everything and prove nothing.
for (const nwo of ["owner/repo.js", "octo-example/my-repo", Array(20).fill("a").join("-") + "/repo"])
  check(parse({ nextly: { nwo, repoPath: "/repo", profilePath: "/p.json" } }).error === null,
    `control: ${nwo} is a name`, nwo);
check(parse("{ not json").error !== null, "unparseable JSON is an error, not an empty registry");
check(parse({}).error === null && parse({}).projects.length === 0,
  "control: an EMPTY registry is valid and has no rows, which is not the same as broken");

// ── a registry key that is also a prototype key ─────────────────────────────
//
// The names are chosen by the file. Keying a plain object by them is the class
// that hid a trigger in the schema reader and a counter in the JSONL migration.
{
  const r = parse({ __proto__: { nwo: "o/r", repoPath: "/repo", profilePath: "/p.json" } });
  check(r.projects.length === 0 || r.projects.every(p => typeof p.name === "string"),
    "a `__proto__` registry key does not reach a prototype setter", JSON.stringify(r));
  const c = parse({ constructor: { nwo: "o/r", repoPath: "/repo", profilePath: "/p.json" } });
  check(c.error === null && c.projects.length === 1 && c.projects[0].name === "constructor",
    "and a project named `constructor` is an ordinary row", JSON.stringify(c));
}

// ── the version is DERIVED from the content ─────────────────────────────────
//
// Section 1.5's registry format carries no version field, while
// `task.registry_version` is NOT NULL and exists to detect that the registry
// moved under a task admitted from it. So it is a fingerprint of the CONTENT: an
// mtime changes when nothing did, and a hand-kept number is wrong the first time
// somebody forgets it.
{
  const a = parse(good).registry.version;
  check(Number.isInteger(a) && a > 0, "the registry version is a positive integer", String(a));
  check(parse(good).registry.version === a, "and is stable for identical content");
  check(parse({ nextly: { profilePath: "/p.json", repoPath: "/repo", nwo: "o/r" } }).registry.version === a,
    "and does not change when only key ORDER changes");
  check(parse({ nextly: { nwo: "o/r", repoPath: "/repo2", profilePath: "/p.json" } })
          .registry.version !== a, "and DOES change when a value changes");
  // CONTROL: two DIFFERENT registries do not collide onto one version, or
  // "changes when a value changes" could be true by luck on this pair alone.
  const seen = new Set();
  for (let i = 0; i < 50; i++)
    seen.add(parse({ nextly: { nwo: `o/r${i}`, repoPath: "/repo", profilePath: "/p.json" } }).registry.version);
  check(seen.size === 50, "control: fifty distinct registries produce fifty distinct versions",
    `${seen.size} of 50`);
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
