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

// ── both halves of the entry contract, frozen ──────────────────────────────
//
// They fail DIFFERENTLY, which is why one freeze cannot stand for both. A row
// field added without a snapshot field is a value nothing consumes; a snapshot
// field added without a row field is an admission that can never complete.
// Neither freeze can see the other's half.
{
  const { readFileSync } = await import("node:fs");
  const { SNAPSHOT_FIELDS } = await import("../src/build/phases.mjs");
  const frozen = JSON.parse(readFileSync(
    new URL("./fixtures/registry-entry-v1.json", import.meta.url), "utf8"));

  // CONTROL: the fixture carries both halves, non-empty. A freeze read from a
  // file that failed to parse into what was expected compares two empty lists
  // and agrees with everything.
  check(Array.isArray(frozen.row_fields) && frozen.row_fields.length > 0 &&
        Array.isArray(frozen.snapshot_fields) && frozen.snapshot_fields.length > 0,
    "control: the freeze fixture carries both halves, non-empty",
    JSON.stringify({ row: frozen.row_fields?.length, snap: frozen.snapshot_fields?.length }));

  const row = parseRegistry(JSON.stringify(
    { p: { nwo: "o/r", repoPath: "/r", profilePath: "/f" } }), "/x").projects[0];
  check(Object.keys(row).sort().join(",") === frozen.row_fields.join(","),
    "freeze: a registry row carries exactly the fields it was frozen with",
    `${Object.keys(row).sort().join(",")} vs ${frozen.row_fields.join(",")}`);
  check([...SNAPSHOT_FIELDS].sort().join(",") === frozen.snapshot_fields.join(","),
    "freeze: and SNAPSHOT_FIELDS is unchanged, which is the other half",
    `${[...SNAPSHOT_FIELDS].sort().join(",")} vs ${frozen.snapshot_fields.join(",")}`);
}

// ── four review findings, each with the case that exhibits it ──────────────
{
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { registryIo } = await import("../src/build/registryio.mjs");
  const dir = mkdtempSync(join(tmpdir(), "reeve-rio4-"));

  // ── the fingerprint must see a project named `__proto__` ─────────────────
  //
  // `JSON.parse` creates an OWN property for that key, so such a project really
  // is in the registry. The canonicaliser assigned it into a plain object,
  // which invoked the inherited setter and dropped it -- so an empty registry
  // and a `__proto__`-only registry hashed identically and every change to that
  // project was invisible to the drift check.
  const vOf = (t) => parseRegistry(t, "/x").registry.version;
  const empty = vOf("{}");
  const proto = vOf(String.raw`{"__proto__":{"nwo":"o/a","repoPath":"/a","profilePath":"/a.json"}}`);
  check(empty !== proto,
    "a project named `__proto__` changes the registry version, so drift can see it",
    `${empty} vs ${proto}`);
  check(vOf(String.raw`{"__proto__":{"nwo":"o/a","repoPath":"/a","profilePath":"/a.json"}}`) !==
        vOf(String.raw`{"__proto__":{"nwo":"o/a","repoPath":"/b","profilePath":"/a.json"}}`),
    "and changing that project's path changes it too");
  // CONTROL: JSON.parse really does produce an own key here, or the case above
  // is about a registry that cannot exist.
  check(Object.keys(JSON.parse(String.raw`{"__proto__":{"a":1}}`)).includes("__proto__"),
    "control: JSON.parse creates an own `__proto__` property, so such a registry is real");

  // ── the profile hash is of the BYTES ──────────────────────────────────────
  //
  // Decoding to utf8 first replaces malformed sequences with U+FFFD before the
  // hash sees them, so two different files hash the same while both still parse.
  //
  // THE FIRST VERSION OF THIS BLOCK PROVED NOTHING. Both fixtures were
  // schema-invalid, so validation made both hashes `null`, and the assertion
  // accepted `(null, null)` explicitly -- it would have stayed green if hashing
  // were deleted outright. The profiles below are VALID and differ only in one
  // byte inside a permitted string field, and both hashes are required to be
  // non-null as well as different.
  const mk = (name, bytes) => { const f = join(dir, name); writeFileSync(f, bytes); return f; };
  const validBytes = (b) => Buffer.concat([
    Buffer.from(`{"schemaVersion":1,"project":{"kind":"product"},` +
      `"identity":{"key":"o/r","defaultBranch":"`), Buffer.from([b]),
    Buffer.from(`","visibility":"private"},` +
      `"authority":{"permission":"admin","policy":"owner"},"state":{"mode":"in-repo"},` +
      `"units":[{"id":"u","root":".","language":"ts"}],"ci":{"provider":"github-actions"},` +
      `"merge":{"method":"squash","enforcement":"enforced"}}`)]);
  const p80 = mk("p80.json", validBytes(0x80));
  const p81 = mk("p81.json", validBytes(0x81));
  const hashOf = async (f) => registryIo(dir, "p", { nwo: "o/r", repoPath: dir, profilePath: f })
                                .profileHash(f);
  const h80 = await hashOf(p80), h81 = await hashOf(p81);

  // CONTROL FIRST: both profiles are actually ACCEPTED, or two nulls would
  // agree with each other and the assertion below would be about nothing.
  check(h80 !== null && h81 !== null,
    "control: both byte-fixtures are valid profiles and DO hash, so the comparison is real",
    JSON.stringify([h80, h81]));
  check(h80 !== h81,
    "two profiles differing only in a malformed byte do not share a hash",
    `${h80} vs ${h81}`);
  // CONTROL: they really do differ only in that byte -- same length, one byte apart.
  check(validBytes(0x80).length === validBytes(0x81).length,
    "control: the two files differ in exactly one byte, not in their shape");

  // ── an absolute path is whatever the PLATFORM says it is ─────────────────
  //
  // `startsWith("/")` is POSIX-only, so on Windows every ordinary entry --
  // `C:\repos\app`, or a UNC path -- was rejected as malformed and no project
  // could be discovered at all. These are FILESYSTEM paths, not claim paths:
  // claims are slash-separated on every platform by rule, a repoPath is not.
  {
    const { isAbsolute } = await import("node:path");
    const entry = (rp) => ({ nextly: { nwo: "o/r", repoPath: rp, profilePath: rp } });
    const posix = parseRegistry(JSON.stringify(entry("/repo")), "/x");
    check(posix.error === null, "control: a POSIX absolute path is still accepted", String(posix.error));

    // WHAT CAN AND CANNOT BE CHECKED FROM HERE, stated rather than fudged.
    //
    // On a POSIX runner `C:\repos\app` genuinely is NOT absolute, so the parse
    // correctly refuses it and there is no behavioural difference to observe.
    // Round-tripping a Windows path would therefore pass on this machine for
    // the wrong reason and hide the regression on the only platform it matters
    // on. The checkable fact is which PREDICATE the module uses.
    //
    // Asserted on the import, not on a text search for the old expression: my
    // first attempt grepped for `startsWith` and matched the COMMENT explaining
    // why it was wrong -- a source-text instrument tripping on prose, which is
    // the same fragility that broke a gate-state assertion on a pure move
    // earlier today.
    // The source-text assertion that stood here is retired: it searched for an
    // import and went stale the moment the module imported `posix`/`win32`
    // instead. The rule is exercised directly further down, against an injected
    // platform, which is strictly better than any statement about the source.
    check(isAbsolute("/repo") === true && isAbsolute("repo") === false,
      "control: node:path answers correctly for the cases this runner can exercise");
    check(parseRegistry(JSON.stringify(entry("repo")), "/x").error !== null,
      "control: and a relative path is still refused, so the rule did not simply go away");
  }

  // ── the probe reads the INDEX, not HEAD ──────────────────────────────────
  //
  // A gitlink that is staged but not committed returns nothing from a tree-ish,
  // and an initialised submodule lstats as an ordinary directory -- so territory
  // inside another repository would be admitted.
  {
    let asked = null;
    const io = registryIo(dir, "p", { nwo: "o/r", repoPath: "/repo", profilePath: "/f" },
      { git: (_bin, args) => { asked = args; return "160000 abc 0\tpackages/x"; } });
    const got = io.lsTree("/repo", "packages/x");
    check(asked?.includes("ls-files") && asked?.includes("--stage"),
      "the submodule probe inspects the staged index, not the HEAD tree", JSON.stringify(asked));
    check(!asked?.includes("ls-tree") && !asked?.includes("HEAD"),
      "and no longer asks a tree-ish, which cannot see a staged gitlink", JSON.stringify(asked));
    check(got?.mode === "160000", "control: it still reads the mode out of the answer", JSON.stringify(got));

    // ONE ROW PER TRACKED DESCENDANT. Probing an ordinary directory lists
    // everything beneath it, and taking the FIRST row's mode reported the
    // directory as whatever its first child happened to be -- a tracked symlink
    // under `packages` made `packages` look like mode 120000 and would refuse an
    // unrelated claim under `packages/normal`.
    const many = registryIo(dir, "p", { nwo: "o/r", repoPath: "/repo", profilePath: "/f" },
      // NUL-SEPARATED, because the probe now asks git for `-z`. This fixture
      // used newlines and went stale the moment the format changed -- the
      // suite caught it, which is what a fixture built to mimic a producer
      // costs you when the producer moves.
      { git: () => "120000 aaa 0\tpackages/a-link\u0000100644 bbb 0\tpackages/normal/x.ts\u0000" });
    check(many.lsTree("/repo", "packages") === null,
      "a DIRECTORY whose first tracked child is a symlink is not itself reported as one",
      JSON.stringify(many.lsTree("/repo", "packages")));
    check(many.lsTree("/repo", "packages/a-link")?.mode === "120000",
      "control: while the symlink itself still answers with its own mode",
      JSON.stringify(many.lsTree("/repo", "packages/a-link")));

    // PATHSPEC MAGIC. A tracked name beginning with `:` is read as magic rather
    // than as a path, so a symlink called `:(literal)link` returned no entry and
    // resolveClaims admitted it as untracked.
    check(asked?.[0] === "--literal-pathspecs",
      "`--literal-pathspecs` is passed BEFORE the subcommand, so a `:`-leading name is a path",
      JSON.stringify(asked));
  }

  // ── the profile is VALIDATED and BOUND to the entry ──────────────────────
  //
  // A profile at the path the registry names could belong to another repository.
  // Unbound, resolveSnapshot would combine repository A's id and nwo with
  // repository B's default branch and founder id, and missingSnapshotFields --
  // which only looks for nulls -- would admit it.
  {
    const good = mk("good.json", JSON.stringify({ schemaVersion: 1,
      project: { kind: "product" },
      identity: { key: "o/r", defaultBranch: "main", visibility: "private" },
      authority: { permission: "admin", policy: "owner" }, state: { mode: "in-repo" },
      units: [{ id: "u", root: ".", language: "ts" }], ci: { provider: "github-actions" },
      merge: { method: "squash", enforcement: "enforced" },
      builder: { founder: { userId: 4242 } } }));
    const mine = registryIo(dir, "p", { nwo: "o/r", repoPath: dir, profilePath: good });
    check(await mine.defaultBranch("o/r") === "main" && await mine.founderUserId("o/r") === 4242,
      "control: a valid profile whose identity.key matches the entry is read",
      JSON.stringify([await mine.defaultBranch("o/r"), await mine.founderUserId("o/r")]));

    // The SAME file, claimed by a different entry.
    const theirs = registryIo(dir, "p", { nwo: "o/OTHER", repoPath: dir, profilePath: good });
    check(await theirs.defaultBranch("o/OTHER") === null && await theirs.founderUserId("o/OTHER") === null,
      "a profile whose identity.key names a DIFFERENT repository supplies nothing",
      JSON.stringify([await theirs.defaultBranch("o/OTHER"), await theirs.founderUserId("o/OTHER")]));
    check(await theirs.profileHash(good) === null,
      "and it does not hash either, so the snapshot cannot complete from it");

    // CARRIES a defaultBranch, deliberately. Without one the assertion below
    // passes on the unvalidated reader too -- there would be nothing to leak,
    // so it would be green for a reason unrelated to validation.
    const invalid = mk("bad.json", JSON.stringify({ schemaVersion: 99,
      identity: { key: "o/r", defaultBranch: "leaked", visibility: "private" } }));
    const io2 = registryIo(dir, "p", { nwo: "o/r", repoPath: dir, profilePath: invalid });
    check(await io2.defaultBranch("o/r") === null,
      "a profile the validator refuses supplies nothing, rather than its raw values",
      String(await io2.defaultBranch("o/r")));
  }
  rmSync(dir, { recursive: true, force: true });
}

// ── five findings that arrived AFTER the pull request merged ───────────────
//
// Codex submitted them seven minutes past the merge, so they are findings
// against `main` rather than against a branch, and nothing surfaces them again.
{
  const { registryIo, parseRegistry: parse2 } = await import("../src/build/registryio.mjs");
  const io = (out) => {
    let args = null;
    const r = registryIo("/h", "p", { nwo: "o/r", repoPath: "/r", profilePath: "/f" },
      { git: (_b, a) => { args = a; if (out instanceof Error) throw out; return out; } });
    return { probe: r, argv: () => args };
  };
  const SEP = "\u0000";
  const row = (mode, stage, path) => `${mode} aaa ${stage}\t${path}${SEP}`;

  // ── the index is read in a MACHINE-READABLE form ─────────────────────────
  //
  // Git's default `core.quotePath` emits DISPLAY output, so a non-ASCII name
  // comes back as a quoted escape sequence and an exact comparison never
  // matches -- the ancestor reads as untracked and the claim is admitted.
  {
    const h = io("");
    h.probe.lsTree("/r", "x");
    check(h.argv()?.includes("-z"),
      "the index probe asks for machine-readable, unquoted pathnames", JSON.stringify(h.argv()));
    const quoted = io(row("100644", "0", String.raw`"m\303\263dulo"`));
    check(quoted.probe.lsTree("/r", "m\u00f3dulo") === null,
      "control: a QUOTED pathname does not match the real name, which is the defect");
    const unquoted = io(row("100644", "0", "m\u00f3dulo"));
    check(unquoted.probe.lsTree("/r", "m\u00f3dulo")?.mode === "100644",
      "while the unquoted form does");
  }

  // ── a buffer overflow is an ANSWER, not a crash ──────────────────────────
  //
  // Probing an ancestor directory lists every tracked descendant, and
  // execFileSync defaults to 1 MiB, so a large tree raised ENOBUFS -- uncaught
  // by resolveClaims, aborting resolution for every claim beneath it. Overflow
  // can only mean many rows; many rows means a directory prefix; a directory has
  // no index entry of its own. So null is CORRECT there, not a fallback.
  {
    const enobufs = Object.assign(new Error("stdout maxBuffer exceeded"), { code: "ENOBUFS" });
    check(io(enobufs).probe.lsTree("/r", "packages") === null,
      "an oversized listing answers `no entry of its own` rather than throwing");
    let threw = null;
    try { io(Object.assign(new Error("git not found"), { code: "ENOENT" })).probe.lsTree("/r", "x"); }
    catch (e) { threw = e.code; }
    check(threw === "ENOENT",
      "control: any OTHER git failure still propagates, so this is not a blanket catch", String(threw));
  }

  // ── every stage of an unmerged entry ─────────────────────────────────────
  //
  // An unresolved merge lists the same pathname several times. Returning the
  // first row missed a later stage carrying 120000 or 160000, so the claim was
  // admitted -- and resolving the conflict to that side then turned granted
  // territory into a traversal boundary.
  {
    const stages = row("100644", "1", "x") + row("100644", "2", "x") + row("120000", "3", "x");
    check(io(stages).probe.lsTree("/r", "x")?.mode === "120000",
      "an unmerged entry answers with the DANGEROUS stage, not the first one",
      JSON.stringify(io(stages).probe.lsTree("/r", "x")));
    const plain = row("100644", "1", "x") + row("100644", "2", "x");
    check(io(plain).probe.lsTree("/r", "x")?.mode === "100644",
      "control: and one with no dangerous stage still answers normally");
  }

  // ── a path must be ROOTED and ADDRESSABLE ────────────────────────────────
  {
    const entry = (rp) => JSON.stringify({ p: { nwo: "o/r", repoPath: rp, profilePath: "/f" } });
    check(parse2(entry(`/a${SEP}b`), "/x").error !== null,
      "a zero byte in a path is refused while parsing, not at the first lstat");
    check(parse2(entry("/ab"), "/x").error === null,
      "control: the same path without it is accepted, so the rule is about the byte");
    // THE WINDOWS RULE, EXERCISED FROM A POSIX RUNNER, because the platform is a
    // parameter. The previous assertion here searched the source for the
    // constant's name and still passed when the constant was defined and no
    // longer used -- it could not fail for the right reason.
    const { isRootedPath } = await import("../src/build/registryio.mjs");
    check(isRootedPath("C:\\repos\\app", "win32") === true,
      "on Windows a drive-qualified path is rooted");
    check(isRootedPath("\\\\server\\share\\x", "win32") === true,
      "and so is a UNC path");
    check(isRootedPath("/repo", "win32") === false,
      "but `/repo` is NOT, because on Windows it is rooted on the process's current DRIVE");
    check(isRootedPath("\\repo", "win32") === false,
      "and neither is a leading backslash, for the same reason");
    // CONTROL: the same predicate still accepts the ordinary POSIX case, so the
    // Windows rule did not simply refuse everything.
    check(isRootedPath("/repo", "linux") === true && isRootedPath("repo", "linux") === false,
      "control: and on POSIX the ordinary rule is unchanged");
  }
}
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
