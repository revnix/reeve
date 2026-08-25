// The hub write lock is never held across a GitHub call. Network first,
// transaction second: resolveSnapshot reads repo id, visibility, spec repo id,
// default branch and profile hash as plain values, and admitTask receives those
// values and does no I/O at all.
//
// That is asserted rather than described -- structurally, by walking the module
// graph, because a negative property cannot be established by watching for a
// call that might be synchronous.
import { openHub } from "../src/build/hubdb.mjs";
import { resolveSnapshot, admitTask, resolveClaims, normalizeClaim, overlaps } from "../src/build/registry.mjs";
import { replayHub } from "../src/build/replay.mjs";
import { SNAPSHOT_FIELDS } from "../src/build/phases.mjs";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, resolve, basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { fail++; if (detail !== undefined) console.log(`        ${detail}`); }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-registry-"));

// The snapshot every block below is admitted against, declared as CODE at file
// scope. `founderUserId` is part of it rather than an afterthought: section 5
// authorises comment-based depth overrides against the founder's IMMUTABLE
// numeric id, so a task admitted without it cannot authenticate the very
// `/reeve depth` comments the depth-override edges exist to handle.
const snap = { repoId: 1, nwo: "o/r", repoPath: "/p", profilePath: "/f",
               profileHash: "h", defaultBranch: "main", visibility: "private",
               specRepoId: 9, gateDefinitionHash: "g", registryVersion: 3,
               founderUserId: 4242 };
// ── admitTask CANNOT perform I/O ─────────────────────────────────────────────
// This is a negative property, and the only sound way to establish a negative is
// to remove the capability and check it is gone -- not to watch for its use.
//
// Watching was tried twice and failed twice, in opposite ways. Passing an `io`
// whose methods throw tests nothing: a conforming implementation ignores the
// field, and a broken one that imports node:fs directly ignores it too. An
// async_hooks `init` hook is worse, because it looks like it works: `init` fires
// for ASYNCHRONOUS resources, so `lstatSync` -- the exact call this is meant to
// catch -- creates no event at all, and a filter of /FSREQ|STATWATCHER/ would
// not have named TCPWRAP or GETADDRINFOREQWRAP either. Both instruments report
// "no I/O" for a function doing synchronous filesystem or network work.
//
// So the guarantee is structural: every capability admitTask might want arrives
// as an injected `io` from resolveSnapshot, which runs BEFORE the transaction
// opens, and nothing in its module's import graph can reach the filesystem or
// the network. That is checkable, transitively.
{
  // `module` is in this list because `createRequire` is a door to every other
  // one, and `vm` because it can evaluate a specifier the walk never sees.
  const IO_MODULE = /^node:(fs|net|http|https|dns|tls|dgram|child_process|worker_threads|http2|cluster|inspector|module|vm)(\/|$)/;
  // Every module EDGE, not just static `import ... from`. A static-import scan
  // reports a clean graph for a module that does
  // `createRequire(import.meta.url)("node:fs")`, or reaches an I/O module
  // through `export ... from`, or `await import("node:fs")` -- three ways to the
  // same capability that the check was blind to, which makes "cannot reach the
  // filesystem" a claim about syntax rather than about capability.
  //
  // `node:module` is itself in IO_MODULE below, so createRequire cannot be
  // reached without tripping the walk regardless of what it is later used for.
  // That is deliberate: the boundary is easier to defend at the door.
  const EDGE = /(?:^\s*(?:import|export)\s(?:[^;]*?from\s+)?|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"']+)["']/gm;
  const importsOf = (f) => [...readFileSync(f, "utf8").matchAll(EDGE)].map(m => m[1]);
  const walk = (file, seen = new Set()) => {
    if (seen.has(file)) return [];
    seen.add(file);
    const bad = [];
    for (const spec of importsOf(file)) {
      if (IO_MODULE.test(spec)) { bad.push(`${basename(file)} imports ${spec}`); continue; }
      if (spec.startsWith(".")) bad.push(...walk(resolve(dirname(file), spec), seen));
    }
    return bad;
  };
  const srcFile = (rel) => fileURLToPath(new URL(rel, import.meta.url));

  // BOUNDED at the hub store. `registry.mjs` is required to import `hubdb.mjs`
  // for `hubTx`/`hubEvent`, and `hubdb.mjs` owns the migrations -- it reads
  // `hub.sql` through `node:fs` by design. An unbounded transitive walk therefore
  // reports a violation for the intended architecture and this assertion is
  // permanently red: an instrument that cannot return the answer it is asked for.
  //
  // The narrower claim is the one that matters and is still worth asserting:
  // `registry.mjs` and everything it pulls in BEYOND the hub store performs no
  // I/O, so `admitTask` cannot read the filesystem or the network on its own
  // account. The boundary is named explicitly rather than discovered, so adding
  // a third module to it is a deliberate act.
  const HUB_STORE = new Set(["hubdb.mjs", "locks.mjs"].map(f => srcFile("../src/build/" + f)));
  const reach = walk(srcFile("../src/build/registry.mjs"), new Set(HUB_STORE));
  check(reach.length === 0,
    "admitTask's module cannot reach the filesystem or the network, outside the hub store it must import",
    reach.join("; "));
  // CONTROL: the exclusion is doing real work, not hiding an empty graph. The
  // walk must actually REACH hubdb.mjs -- if registry.mjs stopped importing it,
  // this assertion would pass for a module that imports nothing at all.
  const unbounded = walk(srcFile("../src/build/registry.mjs"));
  check(unbounded.length > 0,
    "control: the same walk WITHOUT the exclusion finds the hub store's own I/O, so the boundary is real",
    JSON.stringify(unbounded));

  // CONTROL, and the half that carries the weight: run the same walk over a
  // module that demonstrably DOES perform I/O. Without it, a walker with a
  // broken regex -- or one that silently fails to read a file -- reports a clean
  // graph for everything, and the assertion above passes for every possible
  // implementation, including one that lstats on every claim.
  const capable = walk(srcFile("../src/backup.mjs"));
  check(capable.length > 0,
    "control: the same walk finds the I/O in a module that really does it",
    JSON.stringify(capable));

  // CONTROLS for the three edge forms the static-import scan missed. Each is a
  // synthetic source string, not a file, because the point is the SCANNER --
  // whether it can see the edge at all -- and writing three decoy modules into
  // src/ to prove it would be worse than the bug.
  const scan = (text) => [...text.matchAll(EDGE)].map(m => m[1]).filter(s => IO_MODULE.test(s));
  for (const [form, text] of [
    ["createRequire",  'import { createRequire } from "node:module";'],
    ["require call",   'const fs = require("node:fs");'],
    ["dynamic import", 'const fs = await import("node:fs");'],
    ["re-export",      'export { readFileSync } from "node:fs";'],
  ]) {
    check(scan(text).length > 0, `control: the walk sees an I/O edge reached by ${form}`, text);
  }
  check(scan('import { join } from "node:path";').length === 0,
    "control: and does NOT flag a module that is not I/O, so the check is not just 'contains node:'");
}

// ── the transaction is synchronous, and admits the filing ────────────────────
{
  const db = openHub(join(dir, "r1.db"));
  // admitTask takes the RESOLVED claims, not raw strings: resolveClaims is where
  // the symlink refusal lives, so passing filing.territory straight through lets
  // an implementation satisfy the root and no-territory cases while never
  // consulting the resolver at all.
  const resolved = resolveClaims([normalizeClaim("packages/x")], snap.repoPath,
    { lstat: () => ({ isSymbolicLink: () => false }), lsTree: () => ({ mode: "040000" }) });
  let threw = null, r;
  try {
    r = admitTask(db, snap, { id: "bt:1", project: "nextly", title: "t", claims: resolved.claims });
  } catch (e) { threw = e.message; }
  check(threw === null, "admitTask admits a resolved filing without throwing", String(threw));
  // Synchronous, asserted rather than assumed. An implementation that became
  // async returns a Promise here, and every field read below is undefined --
  // which surfaces as a pile of unrelated failures rather than as this one.
  check(!(r instanceof Promise), "and it is synchronous: one BEGIN IMMEDIATE, with no await inside the transaction");
  check(r.ok === true, "and admits the filing", JSON.stringify(r));
  const t = db.prepare("SELECT * FROM task WHERE id='bt:1'").get();
  check(t.generation === 1 && t.phase === "FILED", "at generation 1, in FILED");
  // The WHOLE snapshot, column by column, not three of it. A task carrying a
  // hybrid contract -- new profile hash, old repository path -- is the failure
  // this assertion exists to catch, and checking three columns cannot see it.
  for (const [col, want] of [["repo_id", 1], ["nwo_snapshot", "o/r"], ["repo_path", "/p"],
                             ["profile_path", "/f"], ["profile_hash", "h"],
                             ["default_branch", "main"], ["visibility", "private"],
                             ["spec_repo_id", 9], ["gate_definition_hash", "g"],
                             ["registry_version", 3], ["founder_user_id", 4242]])
    check(t[col] === want, `the snapshot's ${col} is persisted`, `${col}=${JSON.stringify(t[col])}`);
  check(db.prepare("SELECT count(*) c FROM territory_lease WHERE task='bt:1'").get().c === 1,
    "and the territory lease is granted in the same transaction");
  // The CLAIM's own row image, one per child. S2-A declares a
  // `task_territory.claimed` handler and nothing emitted it, so a snapshot
  // predating admission replayed the task and its lease with no claims beneath
  // them -- and after the next release or resume the task has no territory to
  // rebuild a lease from or to validate its diff against.
  check(db.prepare(
    "SELECT count(*) c FROM hub_event WHERE kind='task_territory.claimed' AND task='bt:1'").get().c === 1,
    "and each territory claim appends its own row image",
    JSON.stringify(db.prepare("SELECT kind FROM hub_event WHERE task='bt:1'").all()));

  // ACROSS REPLAY, which is the only thing that proves the image is usable.
  // Replay the admission's tail into an EMPTY hub and require the claim back:
  // an implementation emitting the lease event but not the claim event passes
  // every assertion above and fails exactly here.
  {
    const tail = db.prepare("SELECT seq, at, kind, task, payload FROM hub_event ORDER BY seq").all();
    const back = openHub(join(dir, "r-replay.db"));
    replayHub(back, tail);
    check(back.prepare("SELECT count(*) c FROM task_territory WHERE task='bt:1'").get().c === 1,
      "and a replay of the admission restores the claim, not only the lease",
      JSON.stringify(back.prepare("SELECT * FROM task_territory").all()));
    // CONTROL: the replay did something at all, so the assertion above is not
    // satisfied by a hub that happens to be identical for another reason.
    check(back.prepare("SELECT count(*) c FROM task WHERE id='bt:1'").get().c === 1,
      "control: the replay restored the task too, so it ran");
    back.close();
  }
  db.close();
}

// ── territory grammar: two shapes, and nothing else ──────────────────────────
{
  check(normalizeClaim("packages/x").kind === "prefix", "a bare path is a recursive prefix claim");
  // Kind comes from the CLAIM SHAPE the founder typed, not from guessing at the
  // path: `--territory-file` and a bare `--territory` are different flags, and
  // an extension heuristic gets `packages/x.js` (a directory some projects
  // really do have) and `packages/Makefile` (a file with no extension) both
  // wrong -- silently, and in opposite directions.
  check(normalizeClaim("packages/x/index.ts", { kind: "file" }).kind === "file",
    "an explicit file claim is a file claim");
  check(normalizeClaim("packages/x/index.ts").kind === "prefix",
    "and the same string with no kind given is a prefix: the shape is declared, never inferred");
  check(normalizeClaim("./packages/x/").path === "packages/x", "leading ./ and trailing / are normalized away");
  // INTERNAL aliases too. `packages/x`, `packages/./x` and `packages//x` name one
  // filesystem location, and segment-based `overlaps` compares them as different
  // paths -- so two tasks take concurrent leases over identical territory, which
  // is the single invariant this whole subsystem exists to hold. Empty and `.`
  // segments are dropped; `..` is already refused outright and stays refused,
  // because normalising it away would let a claim escape upward silently.
  for (const alias of ["packages/./x", "packages//x", "./packages/./x//"])
    check(normalizeClaim(alias).path === "packages/x",
      `${alias} canonicalises to packages/x`, JSON.stringify(normalizeClaim(alias)));
  check(overlaps(normalizeClaim("packages/x"), normalizeClaim("packages/./x")),
    "control: and the canonical forms therefore OVERLAP, which is the point");
  // Parent traversal is refused SEGMENT-WISE, not by prefix. A check for a
  // leading "../" accepts `packages/../secret`, which resolves outside the
  // claimed subtree while looking disjoint to the textual overlap comparison --
  // so two tasks can be granted what is really the same path.
  for (const bad of ["packages/*", "packages/**", "!packages/x", "packages/{a,b}", "/abs/path", "packages/[ab]",
                     "../up", "..", "packages/..", "packages/../secret", "packages/x/../../etc", "a/../../b"])
    check(!!normalizeClaim(bad).refusal, `${bad} is refused`, JSON.stringify(normalizeClaim(bad)));
  // CONTROL: the refusal is about the SEGMENT `..`, not about the two
  // characters. `..foo` and `foo..bar` are legal directory names, and a fix
  // written as a substring ban refuses real claims while still passing every
  // line above.
  for (const good of ["packages/..foo", "packages/foo..bar", "packages/a..b/c"])
    check(!normalizeClaim(good).refusal,
      `control: ${good} is accepted, so the refusal is segment-wise and not a substring ban`,
      JSON.stringify(normalizeClaim(good)));

  // The symlink refusal lives in the filesystem-aware half, with an injected io
  // so the test needs no real symlink and admitTask still performs no I/O.
  // The input has to be DECOMPOSED. An earlier revision passed an already
  // composed "é", which an implementation that returns its argument unchanged
  // satisfies while normalising nothing.
  const decomposed = "packages/cafe\u0301";              // e + COMBINING ACUTE ACCENT
  check(decomposed !== "packages/caf\u00e9",
    "control: the fixture really is the decomposed spelling, so the assertion below is not vacuous");
  check(normalizeClaim(decomposed).path === "packages/caf\u00e9",
    "claims are normalised to NFC, so one composition cannot hide beside another",
    JSON.stringify(normalizeClaim(decomposed).path));
  // `lsTree` too. resolveClaims checks EVERY component with both predicates, so
  // an io carrying only `lstat` makes a correct implementation throw on
  // `io.lsTree is not a function` the moment it reaches a non-symlink component
  // -- which is every ancestor in the control cases below. The fixture must
  // answer both questions, not just the interesting one.
  const io = { lstat: (p) => ({ isSymbolicLink: () => p.endsWith("/linked") }),
               lsTree: () => ({ mode: "040000" }) };
  const viaLink = resolveClaims([{ kind: "prefix", path: "packages/linked" }], "/repo", io);
  check(!!viaLink.refusal && /linked/.test(viaLink.refusal),
    "a claim ENDING at a symlink is refused, naming the path", JSON.stringify(viaLink));
  // The leaf case alone is passed by an implementation that lstats only the
  // final component -- which then admits a claim whose ANCESTOR is the symlink,
  // and that is the shape that actually escapes the repository.
  const belowLink = resolveClaims([{ kind: "file", path: "packages/linked/child.ts" }], "/repo", io);
  check(!!belowLink.refusal && /linked/.test(belowLink.refusal),
    "and so is a claim whose ANCESTOR is a symlink, naming the ancestor", JSON.stringify(belowLink));

  // A submodule root is an ordinary directory to lstat, so the symlink check
  // cannot see it. git's gitlink mode is what distinguishes it.
  const subIo = { lstat: () => ({ isSymbolicLink: () => false }),
                  lsTree: (_r, p) => (p === "vendor/lib" ? { mode: "160000" } : { mode: "040000" }) };
  const inSub = resolveClaims([{ kind: "prefix", path: "vendor/lib/src" }], "/repo", subIo);
  check(!!inSub.refusal && /vendor\/lib/.test(inSub.refusal),
    "a claim inside a SUBMODULE is refused, naming the submodule root", JSON.stringify(inSub));
  check(resolveClaims([{ kind: "prefix", path: "packages/x" }], "/repo", subIo).ok === true,
    "control: an ordinary directory still resolves");
  const plain = resolveClaims([{ kind: "prefix", path: "packages/x" }], "/repo", io);
  check(plain.ok === true, "control: an ordinary path resolves", JSON.stringify(plain));
  check(/packages\/x/.test(normalizeClaim("packages/*").refusal ?? ""),
    "and the refusal shows an example of the accepted grammar", String(normalizeClaim("packages/*").refusal));

  check(overlaps({kind:"prefix",path:"packages/x"}, {kind:"file",path:"packages/x/y.ts"}), "a prefix contains a file beneath it");
  // kind is part of the answer: an exact FILE claim has no descendants, so it
  // cannot contain anything. Treating it as a prefix refuses concurrent filings
  // that do not actually conflict -- a false conflict is as costly here as a
  // missed one, because it blocks work with a message naming the wrong reason.
  // These DO conflict, and the earlier expectation had it backwards. One task
  // claiming `packages/x` as an exact file and another claiming `packages/x/y`
  // as a prefix cannot both complete: the first requires `x` to be a file, the
  // second requires it to be a directory, and no filesystem offers both. Granting
  // both leases hands out territory that is structurally impossible to occupy --
  // and it contradicts §10.1's segment-prefix rule, which does not have a
  // file-claim exception. The claim KIND limits which diffs a task may make; it
  // cannot make incompatible paths safe to hold at once.
  check(overlaps({kind:"file",path:"packages/x"}, {kind:"prefix",path:"packages/x/y"}),
    "a file claim and a prefix BENEATH it conflict: x cannot be both a file and a directory");
  // CONTROL, so this does not become "everything overlaps": a file claim and a
  // prefix that is its SIBLING still do not.
  check(!overlaps({kind:"file",path:"packages/x"}, {kind:"prefix",path:"packages/z"}),
    "control: a file claim and an unrelated sibling prefix do not overlap");
}

// ── a claim for a path that does not exist yet is ORDINARY ───────────────────
// Described in the interface and asserted nowhere: an implementation that
// lstats every component and refuses on the first ENOENT blocks the commonest
// filing there is -- a task whose whole job is to add a module -- while one that
// stops before consulting the index admits territory inside another repository.
// Both directions are executable here.
{
  const ENOENT = () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; };
  const dirEntry = { isSymbolicLink: () => false };

  // (a) the LEAF is missing: ordinary, admitted.
  const leaf = resolveClaims([normalizeClaim("packages/x/new.ts")], "/repo", {
    lstat: (p) => (p.endsWith("/new.ts") ? ENOENT() : dirEntry),
    lsTree: () => ({ mode: "040000" }) });
  check(!leaf.refusal, "a claim whose LEAF does not exist yet is admitted", JSON.stringify(leaf));

  // (b) a MIDDLE ancestor is missing: also ordinary. Nothing below a path that
  //     does not exist can be a symlink.
  const mid = resolveClaims([normalizeClaim("packages/new/deep/file.ts")], "/repo", {
    lstat: (p) => (p.includes("/new") ? ENOENT() : dirEntry),
    lsTree: () => ({ mode: "040000" }) });
  check(!mid.refusal, "and one whose MIDDLE ancestor does not exist is admitted", JSON.stringify(mid));

  // (c) CONTROL: a symlink ABOVE a missing leaf is still refused, or "stop at
  //     ENOENT" has quietly become "stop checking".
  const above = resolveClaims([normalizeClaim("packages/linked/new.ts")], "/repo", {
    lstat: (p) => (p.endsWith("/new.ts") ? ENOENT() : { isSymbolicLink: () => p.endsWith("/linked") }),
    lsTree: () => ({ mode: "040000" }) });
  check(!!above.refusal && /linked/.test(above.refusal),
    "control: a symlink ABOVE a missing leaf is still refused", JSON.stringify(above));

  // (d) CONTROL, and the escape: an UNINITIALISED submodule has no worktree
  //     directory -- lstat says ENOENT -- while the superproject still records
  //     the same path as a 160000 gitlink. Honouring ENOENT without asking the
  //     index hands the task territory in a different repository, whose changed
  //     files the superproject's diff cannot inspect.
  const sub = resolveClaims([normalizeClaim("vendor/lib/src/x.ts")], "/repo", {
    lstat: (p) => (p.includes("/vendor/lib") ? ENOENT() : dirEntry),
    lsTree: (_r, p) => (p === "vendor/lib" ? { mode: "160000" } : { mode: "040000" }) });
  check(!!sub.refusal && /vendor\/lib/.test(sub.refusal),
    "control: a missing component that the INDEX records as a gitlink is refused anyway",
    JSON.stringify(sub));
  check(overlaps({kind:"file",path:"packages/x/y.ts"}, {kind:"file",path:"packages/x/y.ts"}),
    "control: two identical file claims still overlap");
  check(!overlaps({kind:"prefix",path:"packages/x"}, {kind:"prefix",path:"packages/xy"}),
    "packages/x and packages/xy do NOT overlap: prefix comparison is by path segment, not by string");
  check(overlaps({kind:"prefix",path:"packages/x"}, {kind:"prefix",path:"packages/x"}), "control: equal claims overlap");
}

// ── resolveSnapshot COMPOSES with resolveClaims ──────────────────────────────
// Calling resolveClaims standalone tests the resolver and says nothing about
// whether the filing path reaches it. An implementation can accept the declared
// `lstat`/`lsTree` and never call resolveClaims at all, leaving the real path
// with no symlink and no gitlink refusal while every assertion above passes.
{
  const lookups = { repoId: async () => 1, visibility: async () => "private",
                    specRepoId: async () => 9, profileHash: async () => "h",
                    defaultBranch: async () => "main", gateDefinitionHash: async () => "g",
                    founderUserId: async () => 4242 };
  // The registry supplies the four snapshot fields `io` does not: the NWO, the
  // repository path, the profile path, and the registry's own version. A fixture
  // carrying only `repoPath` cannot tell a complete resolveSnapshot from one that
  // returns four undefineds, because there is nothing for it to have read.
  const registry = { version: 3, projects: { nextly: {
    nwo: "o/r", repoPath: "/repo", profilePath: "/f" } } };

  const viaLink = await resolveSnapshot(registry, "nextly", [normalizeClaim("packages/linked/x")],
    { ...lookups, lstat: (p) => ({ isSymbolicLink: () => p.endsWith("/linked") }),
      lsTree: () => ({ mode: "040000" }) });
  check(!!viaLink.refusal && /linked/.test(viaLink.refusal),
    "resolveSnapshot refuses a symlinked claim, so the filing path really reaches resolveClaims",
    JSON.stringify(viaLink));

  const inSub = await resolveSnapshot(registry, "nextly", [normalizeClaim("vendor/lib/src")],
    { ...lookups, lstat: () => ({ isSymbolicLink: () => false }),
      lsTree: (_r, p) => (p === "vendor/lib" ? { mode: "160000" } : { mode: "040000" }) });
  check(!!inSub.refusal && /vendor\/lib/.test(inSub.refusal),
    "and refuses a claim inside a submodule, naming the submodule root", JSON.stringify(inSub));

  // CONTROL: an ordinary claim resolves and comes back RESOLVED, or the two
  // refusals above are satisfied by a resolveSnapshot that refuses everything.
  const ok = await resolveSnapshot(registry, "nextly", [normalizeClaim("packages/x")],
    { ...lookups, lstat: () => ({ isSymbolicLink: () => false }), lsTree: () => ({ mode: "040000" }) });
  check(!ok.refusal && ok.claims?.length === 1,
    "control: an ordinary claim resolves", JSON.stringify(ok));
  // EVERY field, not two. This is the only end-to-end successful resolveSnapshot
  // in the suite, so an implementation that omits the repository id, the NWO, the
  // paths, the spec repository id, the gate-definition hash or the registry
  // version passes a two-field control and then admits an incomplete contract on
  // the real filing path. The hand-built `snap` fixture above cannot catch it:
  // that asserts what admitTask does WITH a snapshot, not what resolveSnapshot
  // composes INTO one.
  for (const [field, want] of [["repoId", 1], ["nwo", "o/r"], ["repoPath", "/repo"],
                               ["profilePath", "/f"], ["profileHash", "h"],
                               ["defaultBranch", "main"], ["visibility", "private"],
                               ["specRepoId", 9], ["gateDefinitionHash", "g"],
                               ["registryVersion", 3], ["founderUserId", 4242]])
    check(ok[field] === want, `control: the resolved snapshot carries ${field}`,
          `${field}=${JSON.stringify(ok[field])}`);
}

// ── an empty or unparseable claim is the ROOT, never no-claim ────────────────
// The absence of a territory claim must never read as the absence of conflict.
{
  for (const empty of ["", "   ", null, undefined]) {
    const c = normalizeClaim(empty);
    check(c.kind === "prefix" && c.path === "", `an empty claim (${JSON.stringify(empty)}) becomes the repository root`, JSON.stringify(c));
  }
  const db = openHub(join(dir, "r2.db"));
  // `claims`, not `territory`: the filing admitTask receives carries RESOLVED
  // claims (see its interface above), and a fixture that passes raw strings
  // tests a signature the implementation does not have.
  const claim = (s) => [normalizeClaim(s)];
  admitTask(db, snap, { id: "bt:root", project: "p", title: "t", claims: claim("") });
  const blocked = admitTask(db, snap, { id: "bt:2", project: "p", title: "t", claims: claim("packages/anything") });
  check(blocked.ok === false, "a root-prefix task blocks every concurrent grant in its project");
  check(String(blocked.refusal).includes("bt:root"), "and the refusal names the blocking task", String(blocked.refusal));

  // CONTROL: the identical claim in a DIFFERENT project must still be granted.
  // Without this, a lease-conflict query that forgot its project predicate
  // passes every assertion above while serialising unrelated repositories that
  // both happen to contain `packages/x` -- a deadlock between projects that
  // share nothing, reported as a territory conflict.
  const elsewhere = admitTask(db, { ...snap, repoId: 2, nwo: "o/other" },
    { id: "bt:other", project: "q", title: "t", claims: claim("packages/anything") });
  check(elsewhere.ok === true,
    "control: the same path in another project is granted, so conflicts are scoped by project",
    JSON.stringify(elsewhere));
  // and the reverse direction, so the predicate cannot be satisfied by luck:
  // a root claim in project q blocks q, and still does not touch p.
  const alsoBlocked = admitTask(db, snap, { id: "bt:3", project: "p", title: "t", claims: claim("packages/other") });
  check(alsoBlocked.ok === false, "control: project p is still blocked by its own root claim");
  db.close();
}

// ── the same filing key twice admits ONE task ────────────────────────────────
// The retry is the ordinary case, not the exotic one: a script that times out
// mid-request re-runs the whole command. Two tasks for one filing then compete
// for the same territory, and the second is refused as a conflict -- naming the
// first, which is itself.
{
  const db = openHub(join(dir, "r4.db"));
  const filing = { id: "bt:idem", project: "p", title: "t",
                   idempotencyKey: "founder:2026-08-23:001", claims: [normalizeClaim("packages/x")] };
  const first = admitTask(db, snap, filing);
  check(first.ok === true && first.replayed !== true, "the first filing is admitted", JSON.stringify(first));
  const again = admitTask(db, snap, { ...filing, id: "bt:different" });
  check(again.ok === true && again.replayed === true,
    "and the same key again returns the ORIGINAL task rather than minting a second",
    JSON.stringify(again));
  check(again.taskId === "bt:idem", "naming the first task's id, not the retry's", String(again.taskId));
  check(db.prepare("SELECT count(*) c FROM task").get().c === 1,
    "exactly one task exists", String(db.prepare("SELECT count(*) c FROM task").get().c));
  check(db.prepare("SELECT count(*) c FROM territory_lease").get().c === 1,
    "and exactly one territory lease, so the retry did not conflict with itself");
  // CONTROL: a DIFFERENT key still admits, or "idempotent" has become "admits once".
  const other = admitTask(db, snap, { id: "bt:other", project: "p", title: "t",
    idempotencyKey: "founder:2026-08-23:002", claims: [normalizeClaim("packages/y")] });
  check(other.ok === true && other.replayed !== true,
    "control: a different key admits a new task", JSON.stringify(other));
  db.close();
}

// ── a filing with no --territory at all is refused ───────────────────────────
{
  const db = openHub(join(dir, "r3.db"));
  const r = admitTask(db, snap, { id: "bt:4", project: "p", title: "t", claims: [] });
  check(r.ok === false, "a filing with no territory is refused");
  check(db.prepare("SELECT count(*) c FROM task WHERE id='bt:4'").get().c === 0,
    "and nothing is inserted, so a refused filing leaves no half-task behind");
  db.close();
}
// ── a lease is dead when its TASK is, not when its clock says so ───────────
// hub.sql: "a task is a row, not a process, so dead is a state question... never
// merely because it looks old". The scan asked `expires_at > now` instead, and
// nothing in this system renews a territory lease -- the only writes are the
// grant and release-territory's delete. So every active task's lease became
// invisible one hour after it was granted and its paths were handed to the next
// filing, while the original task was still editing them.
{
  const db = openHub(join(dir, "r5.db"));
  const first = admitTask(db, snap, { id: "bt:old", project: "p", title: "t",
                                      claims: [normalizeClaim("packages/x")] });
  check(first.ok === true, "a task is admitted and holds its territory", JSON.stringify(first));
  // The clock runs out while the task is very much alive.
  db.prepare("UPDATE territory_lease SET expires_at = 1 WHERE task = 'bt:old'").run();

  // CAUGHT, because the failure this covers is defence-in-depth: if the SCAN
  // stops excluding the row, `grantLease`'s read-back still refuses and THROWS,
  // which ends the file rather than failing one assertion. A crash is a red, but
  // it is a red that takes every later block with it and prints no name.
  let stolen = null, stoleThrew = null;
  try {
    stolen = admitTask(db, snap, { id: "bt:live", project: "p", title: "t",
                                   claims: [normalizeClaim("packages/x")] });
  } catch (e) { stoleThrew = e; }
  check(stoleThrew === null,
    "the scan refuses it as a conflict rather than letting the grant throw",
    String(stoleThrew?.message));
  check(stolen?.ok === false,
    "an EXPIRED lease held by a LIVE task still excludes a new filing", JSON.stringify(stolen));
  check(String(stolen?.refusal).includes("bt:old"),
    "and the refusal names the task that still holds it", String(stolen.refusal));
  check(db.prepare("SELECT task FROM territory_lease WHERE path='packages/x'").get().task === "bt:old",
    "and the live task keeps its lease");

  // NOW the task ends. A terminal task's lease is dead, whatever the clock says
  // -- and the row can survive its task when release-territory never ran, which
  // is what used to abort the whole next filing on the primary key.
  db.prepare("UPDATE task SET phase = 'CANCELLED' WHERE id = 'bt:old'").run();
  let threw = null, next = null;
  try {
    next = admitTask(db, snap, { id: "bt:new", project: "p", title: "t",
                                 claims: [normalizeClaim("packages/x")] });
  } catch (e) { threw = e; }
  check(threw === null, "admitting over a TERMINAL task's leftover row does not throw",
    String(threw?.message));
  check(next?.ok === true, "and the filing is admitted", JSON.stringify(next));
  const row = db.prepare("SELECT task, expires_at FROM territory_lease WHERE path='packages/x'").get();
  check(row?.task === "bt:new", "the lease now belongs to the new task", JSON.stringify(row));
  check(row?.expires_at > 1, "with a live expiry rather than the dead one", JSON.stringify(row));

  // CONTROL: a lease held by a live task on the same path is still refused, or
  // "replaces a dead task's row" has become "replaces any row".
  const thief = admitTask(db, snap, { id: "bt:thief", project: "p", title: "t",
                                      claims: [normalizeClaim("packages/x")] });
  check(thief.ok === false, "control: a LIVE lease on the same path is still refused",
    JSON.stringify(thief));
  check(db.prepare("SELECT task FROM territory_lease WHERE path='packages/x'").get().task === "bt:new",
    "control: and the live holder still holds it");
  db.close();
}

// ── the pin travels with the replacement ────────────────────────────────────
// `territory_lease.pinned_until` is the ONLY home of the pin. A replacement that
// refreshed `task` and `expires_at` but not the pin left the previous holder's
// value in place -- so an unpinned row stayed unpinned under a pinned claim, and
// anything reading that column acted on a value no live claim asked for.
{
  const db = openHub(join(dir, "r6.db"));
  admitTask(db, snap, { id: "bt:unpinned", project: "p", title: "t",
                        claims: [normalizeClaim("packages/x")] });
  check(db.prepare("SELECT pinned_until FROM territory_lease WHERE path='packages/x'").get().pinned_until === null,
    "an unpinned filing leaves the pin empty");
  db.prepare("UPDATE task SET phase = 'DONE' WHERE id = 'bt:unpinned'").run();
  // Caught for the same reason as the block above: a replacement rule that stops
  // recognising a terminal task's row refuses inside `grantLease`, which throws.
  let pinned = null, pinThrew = null;
  try {
    pinned = admitTask(db, snap, { id: "bt:pinned", project: "p", title: "t",
                                   pinTerritory: true, claims: [normalizeClaim("packages/x")] });
  } catch (e) { pinThrew = e; }
  check(pinThrew === null, "replacing a terminal task's row does not throw", String(pinThrew?.message));
  check(pinned?.ok === true, "a pinned filing replaces a terminal task's row", JSON.stringify(pinned));
  const row = db.prepare("SELECT task, pinned_until FROM territory_lease WHERE path='packages/x'").get();
  check(row.task === "bt:pinned", "the replacement transferred the task", JSON.stringify(row));
  check(row.pinned_until !== null && row.pinned_until > 1,
    "AND the pin, which the replacement previously dropped", JSON.stringify(row));

  // CONTROL, the other direction: a replacement by an UNPINNED claim must clear
  // an inherited pin rather than leaving the old one standing.
  db.prepare("UPDATE task SET phase = 'DONE' WHERE id = 'bt:pinned'").run();
  let plainThrew = null;
  try {
    admitTask(db, snap, { id: "bt:plain", project: "p", title: "t",
                          claims: [normalizeClaim("packages/x")] });
  } catch (e) { plainThrew = e; }
  check(plainThrew === null, "control: and neither does the unpinned replacement",
    String(plainThrew?.message));
  const after = db.prepare("SELECT task, pinned_until FROM territory_lease WHERE path='packages/x'").get();
  check(after.task === "bt:plain" && after.pinned_until === null,
    "control: replacing a pinned row with an unpinned claim clears the pin", JSON.stringify(after));
  db.close();
}

// ── an incomplete snapshot is refused BEFORE anything is written ───────────
// `specRepoId`, `gateDefinitionHash` and `founderUserId` are all nullable
// columns, so a snapshot whose lookups returned null was inserted without
// complaint -- and the task had already taken its territory and entered FILED by
// the time anyone could notice it could not gate its spec PR or authenticate the
// founder comment overrides section 5 authorises against that immutable id.
// Regeneration already refused exactly this shape; the field list lived inside
// its branch, where admission could not consult it.
{
  const db = openHub(join(dir, "r7.db"));
  for (const field of ["specRepoId", "gateDefinitionHash", "founderUserId", "repoId", "profileHash"]) {
    const partial = { ...snap, [field]: null };
    const r = admitTask(db, partial, { id: `bt:${field}`, project: "p", title: "t",
                                       claims: [normalizeClaim(`packages/${field}`)] });
    check(r.ok === false, `a snapshot missing ${field} is refused`, JSON.stringify(r));
    check(String(r.refusal).includes(field), `and the refusal names ${field}`, String(r.refusal));
    check(db.prepare("SELECT count(*) c FROM task WHERE id=?").get(`bt:${field}`).c === 0,
      `and no task row was written for the ${field} case`);
    check(db.prepare("SELECT count(*) c FROM territory_lease WHERE path=?").get(`packages/${field}`).c === 0,
      `and NO TERRITORY was taken -- the half-admitted task is what made this expensive`);
  }
  // CONTROL: the complete snapshot still admits, or "validates" has become
  // "refuses".
  const ok = admitTask(db, snap, { id: "bt:complete", project: "p", title: "t",
                                   claims: [normalizeClaim("packages/complete")] });
  check(ok.ok === true, "control: a complete snapshot is admitted", JSON.stringify(ok));
  db.close();
}

// The list is SHARED with the regenerate edge, not copied beside it. Two lists
// drift, and the drift is silent: whichever edge is not exercised admits the
// field the other refuses.
{
  const fromPhases = new Set(SNAPSHOT_FIELDS);
  check(fromPhases.size === 11, "the snapshot contract names eleven fields",
    String(fromPhases.size));
  for (const f of ["repoId", "nwo", "specRepoId", "gateDefinitionHash", "founderUserId"])
    check(fromPhases.has(f), `control: ${f} is in the shared contract`);
  const reg = readFileSync(new URL("../src/build/registry.mjs", import.meta.url), "utf8");
  check(/missingSnapshotFields/.test(reg),
    "and admission consults it rather than keeping its own", "checked");
  const ph = readFileSync(new URL("../src/build/phases.mjs", import.meta.url), "utf8");
  check((ph.match(/"gateDefinitionHash"/g) ?? []).length === 1,
    "control: the field list exists in exactly one place",
    String((ph.match(/"gateDefinitionHash"/g) ?? []).length));
}

// ── a filing's claims are a SET ────────────────────────────────────────────
// `task_territory`'s primary key is (task, kind, path) and normalisation
// collapses aliases, so `packages/x` and `packages/./x` arrive as the same claim.
// A filing that named a path twice inserted the same row twice and the whole
// admission rolled back on an uncaught SQLite constraint error -- neither a task
// nor a reasoned refusal, from the ordinary mistake of repeating yourself.
{
  const db = openHub(join(dir, "r8.db"));
  let threw = null, r = null;
  try {
    r = admitTask(db, snap, { id: "bt:dup", project: "p", title: "t",
      claims: [normalizeClaim("packages/x"), normalizeClaim("packages/./x"),
               normalizeClaim("packages/y")] });
  } catch (e) { threw = e; }
  check(threw === null, "a filing that repeats a claim does not throw", String(threw?.message));
  check(r?.ok === true, "and is admitted", JSON.stringify(r));
  const paths = db.prepare("SELECT path FROM task_territory WHERE task='bt:dup' ORDER BY path").all()
    .map(x => x.path);
  check(JSON.stringify(paths) === '["packages/x","packages/y"]',
    "with the alias collapsed rather than inserted twice", JSON.stringify(paths));
  check(db.prepare("SELECT count(*) c FROM territory_lease WHERE task='bt:dup'").get().c === 2,
    "and one lease per DISTINCT claim");

  // CONTROL: repeating yourself is not a conflict with yourself -- the scan
  // compares this filing against OTHER tasks, never against itself.
  check(String(r?.refusal ?? "") === "", "control: no self-conflict was reported",
    String(r?.refusal));
  // CONTROL: the same path claimed by ANOTHER task is still a conflict.
  const other = admitTask(db, snap, { id: "bt:other", project: "p", title: "t",
                                      claims: [normalizeClaim("packages/x")] });
  check(other.ok === false, "control: another task claiming it is still refused",
    JSON.stringify(other));
  db.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
