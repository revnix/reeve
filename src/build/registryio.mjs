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

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

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
    ? Object.keys(v).sort().reduce((o, k) => (o[k] = canonical(v[k]), o), {})
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
  const isAbs = (v) => typeof v === "string" && v.startsWith("/");
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
