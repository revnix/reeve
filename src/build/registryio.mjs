// registryio -- the registry file, and the io `resolveSnapshot` is handed.
//
// EVERYTHING THAT TOUCHES THE DISK LIVES HERE, and that is the whole reason
// this is a new module rather than an addition to `registry.mjs`.
// `test/hub-registry.test.mjs` walks `registry.mjs`'s import graph and asserts
// it reaches no `node:fs`, `node:child_process` or network module, with three
// controls proving the walk is not blind. That assertion is what makes
// "`admitTask` performs no I/O" a property of CAPABILITY rather than a claim
// about discipline. This loader is 78 lines built on `readFileSync`, so putting
// it there would turn that assertion red and take the guarantee with it.
//
// `parseRegistry` is PURE -- text in, rows out -- so every rule below is
// testable without a filesystem. `loadRegistry` is the only part that reads.

import { readFileSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, posix as pathPosix, win32 as pathWin32 } from "node:path";
const isAbsolutePosix = pathPosix.isAbsolute;
const isAbsoluteWin32 = pathWin32.isAbsolute;
import { execFileSync } from "node:child_process";
import { hubPathFor } from "../paths.mjs";
import { resolveRepoIdAt } from "./repoid.mjs";
import { validate, withDefaults } from "../profile/schema.mjs";

/**
 * A content fingerprint, used as `registry.version`.
 *
 * Section 1.5's registry format carries no version field, while
 * `task.registry_version` is NOT NULL and exists to detect that the registry
 * moved under a task admitted from it. So the version is DERIVED from the
 * content: an mtime changes when nothing did, and a hand-kept number is wrong
 * the first time somebody forgets it.
 *
 * Keys are sorted before hashing, so re-serialising the same registry with its
 * fields in another order is not a move.
 */
const canonical = (v) =>
  Array.isArray(v) ? v.map(canonical)
  : v && typeof v === "object"
    // NULL-PROTOTYPE ACCUMULATOR. `JSON.parse` creates an OWN property for a
    // `"__proto__"` key, so a project named that is really in the registry --
    // and assigning it into a plain object here invoked the inherited setter
    // instead, dropping it from the fingerprint. An empty registry and a
    // `__proto__`-only registry then hashed identically, so every change to
    // that project's paths or repository was invisible to the drift check.
    //
    // The projects map below was already null-prototype. This accumulator was
    // the same class and I missed it: fixing one site of a class is not fixing
    // the class.
    ? Object.keys(v).sort().reduce((o, k) => (o[k] = canonical(v[k]), o), Object.create(null))
    : v;

const versionOf = (reg) =>
  // 48 bits: comfortably inside a safe integer, and far past any collision that
  // matters for "did this file change".
  Number.parseInt(createHash("sha256").update(JSON.stringify(canonical(reg))).digest("hex").slice(0, 12), 16) || 1;

/**
 * Parse a registry's TEXT. `path` is used only to name it in an error.
 *
 * Returns `{ projects, registry, error }`. `bin/reeve` reads `.projects` and
 * `.error`; `resolveSnapshot` takes `.registry`.
 */
/**
 * Is this a path the daemon can resolve to the SAME place every time?
 *
 * PLATFORM IS A PARAMETER, not an ambient fact, so the Windows rule is testable
 * from a POSIX runner. It was not: the check lived inline, and the only
 * assertion available was a source-text search for the constant's name -- which
 * still passed when the constant was defined and no longer used. An assertion
 * that cannot fail for the right reason is not an assertion.
 *
 * `isAbsolute` is necessary and NOT sufficient on Windows. Both `\repo` and
 * `/repo` are absolute there and both are rooted on the process's current DRIVE:
 * measured with `path.win32.resolve`, the same `/repo` entry becomes `C:\repo`
 * from a C-drive daemon and `D:\repo` from a D-drive one. The registry would
 * then select a different checkout and profile depending on how the service was
 * started, which is the instability this validation exists to prevent.
 *
 * A NUL byte passes every string check and then reaches `lstatSync`, which
 * raises ERR_INVALID_ARG_VALUE rather than ENOENT. `resolveClaims` handles
 * ENOENT only, so snapshot resolution THREW instead of returning a refusal.
 */
const DRIVE_OR_UNC = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/;

export function isRootedPath(v, platform = process.platform) {
  if (typeof v !== "string" || v.length === 0) return false;
  if (v.includes("\0")) return false;
  const abs = platform === "win32" ? isAbsoluteWin32(v) : isAbsolutePosix(v);
  if (!abs) return false;
  return platform !== "win32" || DRIVE_OR_UNC.test(v);
}

export function parseRegistry(text, path) {
  const fail = (why) => ({ projects: [], registry: { version: 0, projects: Object.create(null) }, error: `${path}: ${why}` });
  let reg;
  try {
    reg = JSON.parse(text);
  } catch (e) {
    // The read failure is ITSELF a finding, and the route below emits it.
    // Returning a bare [] made an unreadable registry indistinguishable from a
    // legitimately empty one -- and since H-4 reports projects that have NO
    // gate-state row, an empty expected set suppresses every one of them. So a
    // machine whose registry cannot be parsed reported a clean hub, which is the
    // exact absence-read-as-success this doctor exists to refuse.
    return fail(e.message);
  }

  // A MALFORMED ENTRY IS AN ERROR, not a row to drop.
  //
  // Filtering it out returned `error: null`, so doctor set `projectsKnown:
  // true` over a project set the registry did not actually describe -- and
  // `hubFindings` then SUPPRESSES gate-state rows absent from that set. A
  // registry of `{ "prod": "bad" }` therefore reported a clean hub while
  // hiding exactly the H-4 authority findings the H-7 path exists to preserve.
  // Silently narrowing the input is how a check answers a smaller question
  // than the one it was asked.
  if (reg === null || typeof reg !== "object" || Array.isArray(reg))
    return fail(`the registry must be an object of name -> project, not ${Array.isArray(reg) ? "an array" : typeof reg}`);

  // The SHAPE and the FIELD. Checking that an entry is an object was one shape
  // short: `{ "prod": {} }` passed, `projectsKnown` went true over a project
  // with `nwo: null`, and `hubFindings` then suppressed every real
  // `repo_gate_state` row as unregistered while emitting `H-4:null` in their
  // place. That is the same failure the object check was added to close,
  // reached through a different malformation -- so the rule is what the
  // registry has to PROVIDE, not what it has to avoid being.
  //
  // `owner/repo`, because that is the only form `nwo_snapshot` ever holds and
  // the only form H-4 can match a gate-state row against. A name that cannot
  // match is not a name.
  // A SEGMENT MUST BE MORE THAN DOTS. `[\w.-]+` accepts `.`, `..`, `../..` and
  // `owner/..`, none of which can ever equal an `nwo_snapshot` -- so a registry
  // carrying one still set `projectsKnown`, and `hubFindings` went on
  // suppressing every real gate-state row against a name that matches nothing.
  // That is the unsafe-authority hiding this validation exists to stop,
  // reached through a name that is syntactically a name and semantically not.
  //
  // GitHub's own rule for the repository half is the same one: a segment may
  // hold letters, digits, `-`, `_` and `.`, and may not be `.` or `..`.
  // The first lookahead ends at the SLASH, not at the end of the string:
  // `(?!\.+$)` on the owner asks whether the WHOLE REMAINDER is dots, so
  // `./repo` sailed through it. Measured, on the first attempt at this rule.
  // THE OWNER IS A GITHUB LOGIN, and it does not obey the repository-name
  // character class. `-/repo` passed the previous rule -- a segment that is
  // not only dots, and therefore "a name" -- while `-` can never be an owner.
  // A login is alphanumeric with single hyphens INSIDE it: it may not start
  // or end with one. The repository half keeps the looser class, which really
  // does allow `.`, `_` and `-` anywhere except as the whole name.
  // SINGLE internal hyphens only. `[A-Za-z0-9-]*` allowed `a--b`, which GitHub
  // does not: a login is alphanumeric segments joined by ONE hyphen each.
  // AND BOUNDED. A GitHub login is at most 39 characters, so a 40-character
  // owner cannot name one -- and an impossible name still marked the registry
  // KNOWN, which is the suppression this validation exists to stop.
  // A REPETITION BOUND COUNTS REPETITIONS, NOT CHARACTERS. `{0,38}` limits how
  // many alphanumerics may follow the first, and each of those repetitions may
  // bring a hyphen with it -- so `Array(39).fill("a").join("-")` is 77
  // characters and matched the shape rule perfectly. The length has to be
  // measured over the whole segment, which is what the lookahead does: it
  // requires a slash within 39 non-slash characters before the shape rule runs
  // at all. Shape and length are two facts, and one quantifier cannot carry
  // both.
  const OWNER = String.raw`(?=[^/]{1,39}/)[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}`;
  const REPO  = String.raw`(?!\.+$)[\w.-]+`;
  const NWO = new RegExp(`^${OWNER}/${REPO}$`);

  // AND THE TWO PATHS, required for the same reason the nwo is. `resolveSnapshot`
  // reads `entry.repoPath` and `entry.profilePath`; an entry missing either is a
  // row it cannot complete, so admission would key on nothing. Absolute, because
  // a relative path resolves against whatever directory the daemon was started
  // in -- the same defect `identity.worktreeRoot` already carries a rule for.
  // PLATFORM-AWARE. `startsWith("/")` is POSIX-only, so on Windows every
  // ordinary entry -- `C:\repos\app`, or a UNC path -- was rejected as
  // malformed and no project could be discovered at all. These are FILESYSTEM
  // paths, not claim paths: claims are slash-separated on every platform by
  // rule, but a repoPath is whatever the operating system uses. reeve has to
  // run on macOS, Windows and Ubuntu.
  const isAbs = (v) => isRootedPath(v, process.platform);

  const bad = Object.entries(reg)
    .filter(([, v]) => !v || typeof v !== "object" || Array.isArray(v) ||
                       typeof v.nwo !== "string" || !NWO.test(v.nwo) ||
                       !isAbs(v.repoPath) || !isAbs(v.profilePath))
    .map(([n]) => n);
  if (bad.length)
    return fail(`${bad.length} malformed entr${bad.length === 1 ? "y" : "ies"} (${bad.slice(0, 5).join(", ")}); ` +
                `each project must be an object with an "owner/repo" nwo and absolute repoPath and profilePath`);

  // NULL-PROTOTYPE: the keys are project names the FILE chooses, and a project
  // named `__proto__` assigned into a plain object reaches the inherited setter
  // instead of becoming a property. Same class as the schema reader's
  // inventories and the JSONL migration's counters.
  const projects = Object.create(null);
  for (const [name, p] of Object.entries(reg)) projects[name] = p;

  return {
    projects: Object.entries(reg).map(([name, p]) =>
      ({ name, nwo: p.nwo, repoPath: p.repoPath, profilePath: p.profilePath })),
    registry: { version: versionOf(reg), projects },
    error: null,
  };
}

/** Read and parse `<home>/projects.json`. The only function here that touches disk. */
export function loadRegistry(home) {
  const path = join(home, "projects.json");
  try {
    return parseRegistry(readFileSync(path, "utf8"), path);
  } catch (e) {
    return { projects: [], registry: { version: 0, projects: Object.create(null) }, error: `${path}: ${e.message}` };
  }
}

/**
 * The `io` object `resolveSnapshot` takes, built for one registry entry.
 *
 * NINE MEMBERS, NOT EIGHT. The brief's specification lists eight and omits
 * `lsTree`. Measured: `resolveClaims` makes it a PRECONDITION rather than an
 * enhancement -- `src/build/registry.mjs:152` refuses outright when it is not a
 * function, with its own comment recording why. `io.lsTree?.()` made a missing
 * capability read as "nothing is tracked", so every ENOENT became "does not
 * exist yet" and an uninitialised submodule was admitted. An eight-member io
 * refuses every filing.
 *
 * The surface is not copied from the brief. It is the nine names
 * `resolveSnapshot` actually reads, and the test asserts that by scanning for
 * them rather than by listing them here a second time.
 *
 * WHAT IS LOCAL AND WHAT IS INJECTED. `profileHash`, `defaultBranch`,
 * `visibility` and `founderUserId` come from the profile file the entry names --
 * the profile already carries `identity.defaultBranch`, `identity.visibility`
 * and `builder.founder.userId` -- so none of them is a network call. `lstat` and
 * `lsTree` are the filesystem and the checkout's git index. `repoId` goes
 * through `resolveRepoIdAt`, which asks the HUB first and falls back only to an
 * injected `fetchRepoId`; S3-A injects none, so a project the hub has never
 * admitted a task for yields `null` rather than reaching the network.
 *
 * `specRepoId` and `gateDefinitionHash` resolve `null` BY CONSTRUCTION. They are
 * F1's, and until the founder names the spec repositories and the gate
 * definition paths there is nothing to read. `missingSnapshotFields` then names
 * them and the filing is refused with both field names in it. That refusal is
 * the correct state, and it is what makes the block visible rather than silent.
 */
export function registryIo(home, project, entry, { fetchRepoId = null, git = execFileSync, connect = null } = {}) {
  // Read ONCE per io, not once per lookup: four members read the same file, and
  // four reads could disagree if the profile changed between them -- a snapshot
  // assembled from two different profiles is not a snapshot of either.
  let profile = null;
  let profileBytes = null;
  let profileOk = false;
  const loadProfile = () => {
    if (profile !== null) return profile;
    profile = {};
    try {
      // THE BYTES ARE READ AS BYTES. Decoding to utf8 first replaces malformed
      // sequences with U+FFFD before the hash sees them, so `0x80` and `0x81`
      // inside a JSON string produce the SAME digest while the text still
      // parses -- a profile change invisible to drift detection, under a
      // comment claiming the hash was of the file's bytes. It is now.
      profileBytes = readFileSync(entry.profilePath);
      const parsed = JSON.parse(profileBytes.toString("utf8"));
      // VALIDATED, AND BOUND TO THIS ENTRY. An unvalidated profile at a path the
      // registry names could belong to ANOTHER repository, and `resolveSnapshot`
      // would then combine repository A's id and nwo with repository B's default
      // branch and founder id. `missingSnapshotFields` only checks for nulls, so
      // compatible-looking values would be admitted and incompatible ones would
      // surface later as SQLite constraint errors, far from the cause.
      const r = validate(withDefaults(parsed));
      const key = parsed?.identity?.key ?? null;
      if (r.ok && key === entry.nwo) { profile = parsed; profileOk = true; }
      else { profileBytes = null; }
    } catch { profileBytes = null; }
    return profile;
  };
  const at = (path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), loadProfile());

  return {
    // `{ name, nwo }`, NOT the bare project name. `repoIdFromHub` reads
    // `project?.name` and `resolveRepoId` reads `project?.nwo`, so a string here
    // makes both undefined and the lookup returns `null` for every project --
    // which is the ORDINARY answer meaning "no id is known", so it is
    // indistinguishable from a project the hub has never admitted. Every filing
    // would then be refused for a missing repoId, fail-closed and therefore
    // silent. Caught by Task 9's positive control, not by reading this line.
    repoId: async () => resolveRepoIdAt(hubPathFor(home), { name: project, nwo: entry.nwo },
                                        { fetchRepoId, ...(connect ? { connect } : {}) }),
    // The hash is of the profile's BYTES, not of a re-serialisation: the point is
    // to detect that the file changed, and re-serialising normalises away the
    // very differences that would tell you it did.
    profileHash: async () => (loadProfile(), profileBytes === null ? null
      : createHash("sha256").update(profileBytes).digest("hex")),
    defaultBranch: async () => at("identity.defaultBranch") ?? null,
    visibility: async () => at("identity.visibility") ?? null,
    founderUserId: async () => at("builder.founder.userId") ?? null,
    specRepoId: async () => null,
    gateDefinitionHash: async () => null,
    lstat: (path) => lstatSync(path),
    // THE INDEX, NOT `HEAD`. `ls-tree` takes a tree-ish, so a gitlink that is
    // STAGED but not yet committed returns no entry -- and an initialised
    // submodule lstats as an ordinary directory, so `resolveClaims` would admit
    // territory inside another repository. `ls-files --stage` documents itself
    // as showing staged contents, which is the state the checkout is actually
    // in. The same gap hid a staged mode-120000 entry whose worktree link was
    // absent.
    lsTree: (repoPath, path) => {
      // `--literal-pathspecs` BEFORE the subcommand. A tracked name beginning
      // with `:` is read as pathspec MAGIC rather than as a path, so a symlink
      // called `:(literal)link` returned no entry and `resolveClaims` admitted
      // it as untracked. `src/checkout.mjs` and `src/mergecheck.mjs` already
      // carry this option for the same reason.
      // `-z`: NUL-TERMINATED AND UNQUOTED. Git's default `core.quotePath` emits
      // display output, so `módulo` comes back as `"m\303\263dulo"` and an exact
      // comparison never matches -- the ancestor reads as untracked and the
      // claim is admitted through it. `-z` is the machine-readable form.
      //
      // BOUNDED, AND THE OVERFLOW IS AN ANSWER RATHER THAN A FAILURE. Probing an
      // ancestor DIRECTORY lists every tracked descendant, and `execFileSync`
      // defaults to a 1 MiB buffer, so a large tree raised ENOBUFS -- which
      // `resolveClaims` does not catch, aborting snapshot resolution for every
      // claim beneath it. Overflow can only happen when many rows came back; many
      // rows means the path is a directory prefix; and a directory has no index
      // entry of its own. So `null` is the CORRECT answer there, not a fallback:
      // a single row cannot exceed the buffer, since a path is at most a few
      // thousand bytes.
      let out;
      try {
        out = String(git("git", ["--literal-pathspecs", "-C", repoPath,
                                 "ls-files", "--stage", "-z", "--", path],
                         { encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
                           stdio: ["ignore", "pipe", "ignore"] }));
      } catch (e) {
        if (e?.code === "ENOBUFS") return null;
        throw e;
      }
      if (!out) return null;
      // ONE ROW PER TRACKED DESCENDANT. Probing an ordinary directory lists
      // everything beneath it, and taking the first row's mode reported the
      // directory as whatever its first child happened to be -- a tracked
      // symlink under `packages` made `packages` look like mode 120000 and
      // refused an unrelated claim under `packages/normal`. A gitlink first in
      // the listing did the same. So the entry whose PATH is exactly the one
      // asked about is the only row that answers the question.
      // EVERY MATCHING STAGE, not the first. An unresolved merge puts the same
      // pathname in the index several times, and returning the first row missed
      // a later stage carrying 120000 or 160000 -- so a symlink or gitlink was
      // ignored, the claim admitted, and resolving the conflict to that side
      // turned granted territory into a traversal boundary. The most dangerous
      // mode present is the answer, because any stage may become the resolution.
      const DANGEROUS = new Set(["120000", "160000"]);
      let found = null;
      for (const line of out.split("\0")) {
        if (!line) continue;
        const tab = line.indexOf("\t");
        if (tab < 0) continue;
        if (line.slice(tab + 1) !== path) continue;
        const [mode] = line.slice(0, tab).split(/\s+/);
        if (DANGEROUS.has(mode)) return { mode };
        found ??= { mode };
      }
      return found;
    },
  };
}
