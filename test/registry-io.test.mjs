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


// ── the io's surface is DERIVED from what resolveSnapshot reads ─────────────
//
// NOT a list retyped here. The brief specifies eight members and omits
// `lsTree`, and `resolveClaims` makes that one a PRECONDITION rather than an
// enhancement: `registry.mjs` refuses outright when it is not a function,
// because `io.lsTree?.()` made a missing capability read as "nothing is
// tracked" and an uninitialised submodule was admitted. An eight-member io
// refuses every filing, so a test that checked the brief's eight would have
// passed over exactly that.
{
  const { registryIo } = await import("../src/build/registryio.mjs");
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/build/registry.mjs", import.meta.url), "utf8");
  const needed = [...new Set([...src.matchAll(/io\.([a-zA-Z]+)/g)].map((m) => m[1]))].sort();

  check(needed.length > 0,
    "control: resolveSnapshot really reads members off io, so the comparison is not vacuous",
    `${needed.length}: ${needed.join(", ")}`);
  check(needed.includes("lsTree"),
    "control: and lsTree is among them, which the brief's eight-member list omits");

  const io = registryIo("/h", "p", { nwo: "o/r", repoPath: "/r", profilePath: "/f" });
  const missing = needed.filter((n) => typeof io[n] !== "function");
  check(missing.length === 0, "registryIo supplies every member resolveSnapshot reads",
    missing.join(", "));

  // AND NOT MORE. An io richer than the contract is the same defect as a
  // fixture richer than production: it hides that a member was never needed,
  // and the next reader cannot tell which ones carry weight.
  const extra = Object.keys(io).filter((k) => !needed.includes(k));
  check(extra.length === 0, "and supplies nothing it does not read", extra.join(", "));
}

// ── the two F1 fields resolve null BY CONSTRUCTION ─────────────────────────
//
// Until the founder names the spec repositories and the gate-definition paths
// there is nothing to read. `missingSnapshotFields` then names both and the
// filing is refused with the field names in it. That refusal is the CORRECT
// state, and asserting it is what keeps the block visible instead of silent.
{
  const { registryIo } = await import("../src/build/registryio.mjs");
  const io = registryIo("/h", "p", { nwo: "o/r", repoPath: "/r", profilePath: "/f" });
  check(await io.specRepoId("o/r") === null, "specRepoId is null until F1 names the spec repositories");
  check(await io.gateDefinitionHash("o/r") === null, "gateDefinitionHash is null until F1 names the paths");
  // CONTROL: a member that SHOULD read something does not also answer null for
  // the same reason, or "null by construction" would be indistinguishable from
  // "every lookup is a stub".
  check(typeof io.lstat === "function" && typeof io.repoId === "function",
    "control: the members that do read are still functions, so null is a choice and not a gap");
}

// ── a profile that cannot be read does not invent values ───────────────────
{
  const { registryIo } = await import("../src/build/registryio.mjs");
  const io = registryIo("/h", "p", { nwo: "o/r", repoPath: "/r", profilePath: "/nope.json" });
  check(await io.profileHash("/nope.json") === null,
    "an unreadable profile hashes to null, not to the hash of an empty string");
  check(await io.defaultBranch("o/r") === null && await io.visibility("o/r") === null,
    "and its fields are null rather than defaulted, so missingSnapshotFields can name them");
}

// ── resolving a snapshot writes nothing, and takes no lock ─────────────────
//
// THIS IS A NEGATIVE, and a negative asserted in passing beside the positive it
// accompanies is the shape that has twice been satisfied here by an instrument
// that could not see the thing. Watching for a write does not work either:
// `resolveSnapshot` takes no db at all, so there is nothing to watch, and the
// write that would matter happens inside `registryIo`'s hub lookup.
//
// So: two INDEPENDENT checks, and both are needed.
{
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openHub } = await import("../src/build/hubdb.mjs");
  const { hubPathFor } = await import("../src/paths.mjs");
  const { registryIo } = await import("../src/build/registryio.mjs");
  const { resolveSnapshot, normalizeClaim } = await import("../src/build/registry.mjs");

  const dir = mkdtempSync(join(tmpdir(), "reeve-regio-"));
  const home = join(dir, "nw");    mkdirSync(join(home, "state"), { recursive: true });
  const repo = join(dir, "nwrepo"); mkdirSync(join(repo, "packages", "x"), { recursive: true });
  const prof = join(home, "np.json");
  writeFileSync(prof, JSON.stringify({ schemaVersion: 1,
    identity: { defaultBranch: "main", visibility: "private" },
    builder: { founder: { userId: 4242 } } }));
  const entry = { nwo: "o/r", repoPath: repo, profilePath: prof };
  const registry = { version: 7, projects: { nextly: entry } };

  const db = openHub(hubPathFor(home));
  // A real admitted task, so the hub HAS an id to answer with. That is the
  // positive control which makes "nothing changed" mean something.
  db.prepare(
    `INSERT INTO task(id, project, repo_id, nwo_snapshot, title, phase, generation,
                      source_kind, source_key, repo_path, profile_path, profile_hash,
                      default_branch, visibility, registry_version, created_at, updated_at)
     VALUES('bt:n','nextly',77,'o/r','t','FILED',1,'founder','k','/r','/p','h','main','private',1,
            unixepoch(),unixepoch())`).run();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const censusOf = (h) => JSON.stringify(Object.fromEntries(tables.map((t) =>
    [t, h.prepare(`SELECT count(*) c FROM "${t}"`).get().c])));
  const before = censusOf(db);
  const seqBefore = db.prepare("SELECT COALESCE(max(seq), 0) s FROM hub_event").get().s;
  db.close();

  const io = registryIo(home, "nextly", entry, { git: () => "040000 tree abc\tpackages/x" });
  const snap = await resolveSnapshot(registry, "nextly", [normalizeClaim("packages/x")], io);

  // CHECK ONE: the state is unchanged -- with the read PROVEN, because "no row
  // changed" is equally true of a lookup that never opened the hub.
  const after = openHub(hubPathFor(home));
  check(!snap.refusal && snap.repoId === 77,
    "control: the snapshot really resolved, and carries the repo id the hub recorded",
    JSON.stringify(snap).slice(0, 200));
  check(censusOf(after) === before, "resolving a snapshot changed no row in any hub table",
    `${before}\n        ${censusOf(after)}`);
  check(after.prepare("SELECT COALESCE(max(seq), 0) s FROM hub_event").get().s === seqBefore,
    "and appended no hub_event, which a row count alone would not notice if one replaced another");
  check(after.prepare("SELECT count(*) c FROM writer_lease").get().c === 0 &&
        after.prepare("SELECT count(*) c FROM maintenance_lock").get().c === 0,
    "and took neither the writer lease nor the maintenance lock");
  after.close();

  // CHECK TWO: the CAPABILITY is removed. Independent of the state comparison,
  // because a write that is made and rolled back leaves the census identical.
  // The connection refuses `exec` outright and refuses any prepare whose SQL is
  // not a plain SELECT, so if a snapshot comes back at all, nothing wrote.
  {
    const real = openHub(hubPathFor(home));
    let attempted = null;
    const readOnly = {
      prepare: (sql) => {
        if (!/^\s*SELECT\b/i.test(sql)) { attempted = sql; throw new Error(`refused a non-SELECT: ${sql}`); }
        return real.prepare(sql);
      },
      exec: (sql) => { attempted = sql; throw new Error(`refused exec: ${sql}`); },
      close: () => {},
    };
    const io2 = registryIo(home, "nextly", entry,
      { git: () => "040000 tree abc\tpackages/x", connect: () => readOnly });
    const snap2 = await resolveSnapshot(registry, "nextly", [normalizeClaim("packages/x")], io2);
    check(!snap2.refusal, "a connection that refuses every write still resolves a snapshot",
      JSON.stringify(snap2).slice(0, 160));
    check(attempted === null, "and nothing was even ATTEMPTED against it", String(attempted));
    // CONTROL: the refusing connection really would have caught a write. Without
    // this, "nothing attempted" is equally true of a harness that was never used.
    let caught = null;
    try { readOnly.exec("INSERT INTO task DEFAULT VALUES"); } catch (e) { caught = e.message; }
    check(caught !== null && /refused exec/.test(caught),
      "control: that connection does refuse a write when one is made", String(caught));
    real.close();
  }
  rmSync(dir, { recursive: true, force: true });
}
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
