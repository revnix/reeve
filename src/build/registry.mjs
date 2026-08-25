// registry -- network first, transaction second.
//
// The hub write lock is never held across a GitHub call. `resolveSnapshot` is
// async and is where every lookup lives; `admitTask` is synchronous, opens one
// BEGIN IMMEDIATE, and performs no I/O of its own. That split is the whole
// module: a transaction that waits on the network holds the lock for as long as
// the network takes, and every other hub writer waits behind it.
//
// It is also why the symlink and submodule refusals live in `resolveClaims`
// rather than in `normalizeClaim`. Section 10.1 requires those paths to be
// refused at claim time, and a `normalizeClaim` given only a string can either
// skip the check or resolve it against whatever the process's current directory
// happens to be -- which is not the repository. So the check moves to where the
// I/O already legitimately happens, before the transaction opens.
//
// NOTHING BEYOND THE HUB STORE IS IMPORTED HERE. `hubdb.mjs` reads `hub.sql`
// through node:fs by design and `locks.mjs` comes with it; past that boundary
// this module's import graph cannot reach the filesystem or the network, which
// is what makes "admitTask performs no I/O" a property of capability rather than
// a claim about discipline.
import { hubTx, hubEvent } from "./hubdb.mjs";
import { assertWritable } from "./locks.mjs";
// ONE claim model, shared with `applyTransition`'s resume path. See
// territory.mjs for why admission and regrant may not each keep their own.
import { overlaps, liveLeases, firstConflict,
         conflictRefusal, grantLease } from "./territory.mjs";
// The admission snapshot's required fields, shared with the regenerate edge that
// already refused an incomplete one. See phases.mjs.
import { missingSnapshotFields } from "./phases.mjs";
// Re-exported because callers and tests import the predicate from here.
export { overlaps };
// `isSameProcess` is deliberately NOT imported. It lives in `supervisor.mjs`,
// which pulls in node:child_process and node:fs -- so importing it would give
// this module's graph exactly the capability `admitTask` is required not to
// have, and the structural check that proves the boundary would fail. Liveness
// is a process capability, so the caller that has one passes it in.

// A territory lease lasts while the task holds it; the loop renews.

// The constructs section 10.1 refuses. Globs and negations are refused rather
// than expanded because a claim is compared by SEGMENT against other claims, and
// two patterns that overlap in the filesystem can look disjoint as strings.
const REFUSED = [
  [/\*/,        "a glob"],
  [/^!/,        "a negation"],
  [/[{}]/,      "a brace expansion"],
  [/[\[\]]/,    "a character class"],
];

/**
 * Grammar only, and PURE: no filesystem, no repository, no I/O.
 *
 * `kind` is DECLARED by the caller, never inferred from the path. `--territory`
 * and `--territory-file` are different flags, and an extension heuristic gets
 * `packages/x.js` (a directory some projects really have) and `packages/Makefile`
 * (a file with no extension) wrong in opposite directions, silently.
 */
export function normalizeClaim(raw, { kind = "prefix" } = {}) {
  const example = `a claim is a repository-relative path, like packages/x`;
  if (raw === null || raw === undefined || String(raw).trim() === "")
    // The ROOT, never "no claim". The absence of a territory claim must never
    // read as the absence of conflict: a filing with nothing declared would then
    // overlap nothing and be granted beside every other task.
    return { kind, path: "" };

  let s = String(raw).trim();
  if (s.startsWith("/"))
    return { refusal: `absolute path ${JSON.stringify(s)} is not a claim; ${example}` };
  for (const [re, what] of REFUSED)
    if (re.test(s)) return { refusal: `${what} in ${JSON.stringify(s)} is not a claim; ${example}` };

  // NFC, as section 10.1 requires and as git itself compares. On macOS a path
  // typed in one composition and read back in another are different byte strings
  // for the same file, so two claims can look disjoint and address one tree.
  // Case is preserved and compared exactly, also as git does.
  s = s.normalize("NFC");

  // SEGMENT-WISE. A check for a leading "../" accepts `packages/../secret`,
  // which resolves outside the claimed subtree while looking disjoint to the
  // textual overlap comparison -- so two tasks can be granted what is really the
  // same path. And a substring ban on ".." refuses `packages/..foo`, which is an
  // ordinary directory name.
  const segments = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;      // internal aliases collapse
    if (seg === "..")
      return { refusal: `parent traversal in ${JSON.stringify(s)} is not a claim; ${example}` };
    segments.push(seg);
  }
  return { kind, path: segments.join("/") };
}

/**
 * Do two claims describe territory that cannot be held at once?
 *
 * By path SEGMENT, not by string: `packages/x` and `packages/xy` are unrelated,
 * and comparing them as strings makes one contain the other.
 *
 * KIND does not create an exception. A task claiming `packages/x` as an exact
 * file and another claiming `packages/x/y` as a prefix cannot both complete --
 * the first requires `x` to be a file and the second requires it to be a
 * directory, and no filesystem offers both. Granting both hands out territory
 * that is structurally impossible to occupy.
 */

/**
 * The filesystem-aware half, run before the transaction opens.
 *
 * Walks each claim AND every ancestor, refusing a symlink or a submodule root
 * anywhere along the way. The leaf alone is not enough: a claim whose ANCESTOR
 * is the symlink is the shape that actually escapes the repository.
 */
export function resolveClaims(claims, repoPath, io) {
  for (const claim of claims ?? []) {
    if (claim?.refusal) return { refusal: claim.refusal };
    const segments = (claim.path ?? "").split("/").filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
      const partial = segments.slice(0, i + 1).join("/");
      let entry = null, missing = false;
      try { entry = io.lstat(`${repoPath}/${partial}`); }
      catch (e) {
        if (e?.code !== "ENOENT") throw e;
        missing = true;
      }
      if (!missing && entry?.isSymbolicLink?.())
        return { refusal: `${partial} is a symlink; a claim may not traverse one` };

      // THE INDEX, asked either way. An uninitialised submodule has no worktree
      // directory -- `lstat` says ENOENT -- while the superproject still records
      // the same path as a mode-160000 gitlink. Stopping on ENOENT alone hands
      // the task territory inside a DIFFERENT repository, whose changed files
      // the superproject's diff cannot inspect: the gitlink refusal defeated by
      // the very case it exists for.
      const tracked = io.lsTree?.(repoPath, partial) ?? null;
      if (tracked?.mode === "160000")
        return { refusal: `${partial} is a submodule; its contents belong to another repository` };

      // Only NOW is it safe to stop. A path in neither the worktree nor the
      // index can be neither a symlink nor a submodule, so nothing below it can
      // be either -- and territory describes work a task is GOING to do, so a
      // claim on a file that does not exist yet is the commonest filing there is.
      if (missing && !tracked) break;
    }
  }
  return { ok: true, claims };
}

/**
 * Every network call, and nothing else. Async by design: this is the half that
 * must NOT run inside the transaction.
 */
export async function resolveSnapshot(registry, project, claims, io) {
  const entry = registry?.projects?.[project];
  if (!entry) return { refusal: `${project} is not a project in the registry` };

  // The claims are resolved HERE because this is the only place with both the
  // repository path and an I/O capability. Without it `resolveClaims` has no
  // caller on the filing path, and the symlink and gitlink refusals are
  // unreachable from the command that needs them.
  const resolved = resolveClaims(claims, entry.repoPath, io);
  if (resolved.refusal) return { refusal: resolved.refusal };

  return {
    repoId: await io.repoId(entry.nwo),
    nwo: entry.nwo,
    repoPath: entry.repoPath,
    profilePath: entry.profilePath,
    profileHash: await io.profileHash(entry.profilePath),
    defaultBranch: await io.defaultBranch(entry.nwo),
    visibility: await io.visibility(entry.nwo),
    specRepoId: await io.specRepoId(entry.nwo),
    gateDefinitionHash: await io.gateDefinitionHash(entry.nwo),
    registryVersion: registry.version,
    // Section 5 authorises comment-based depth overrides against the founder's
    // IMMUTABLE numeric id, so it is snapshotted at admission for the same
    // reason as the profile hash: a later change to who the founder is must not
    // retroactively authorise old comments.
    founderUserId: await io.founderUserId(entry.nwo),
    claims: resolved.claims,
  };
}


/**
 * One BEGIN IMMEDIATE. No I/O. Every value it writes was resolved before it.
 */
export function admitTask(db, snapshot, filing, { isAlive = () => true } = {}) {
  return hubTx(db, () => {
    // It writes four authority-bearing rows, so admitting a filing while a
    // restore holds `maintenance_lock` races the snapshot replacement and can be
    // lost by the replay that follows. "Every hub writer calls it" is a rule with
    // no exceptions, and admission was one.
    // The default treats any recorded restore holder as ALIVE, which refuses
    // admission rather than reaping a lock this module cannot check. That is the
    // conservative direction: a filing refused while a stale lock sits is
    // retried by its operator, and a filing admitted during a live restore can
    // be lost by the replay that follows it.
    assertWritable(db, { isAlive, inTx: true });

    // THE RETRY IS THE ORDINARY CASE. A script that times out mid-request re-runs
    // the whole command; without this the second run mints a task that then
    // competes with the first for its own territory and is refused as a conflict
    // -- naming the first, which is itself.
    if (filing.idempotencyKey != null) {
      const seen = db.prepare("SELECT id FROM task WHERE idempotency_key = ?").get(filing.idempotencyKey);
      if (seen) return { ok: true, taskId: seen.id, replayed: true };
    }

    // BEFORE ANYTHING IS WRITTEN. An incomplete snapshot used to reach the
    // INSERT: every one of these columns is nullable, so SQLite accepted the
    // malformed task, and it had already taken its territory and entered FILED
    // by the time anyone could notice it could not gate a spec PR or
    // authenticate a founder override.
    const missing = missingSnapshotFields(snapshot);
    if (missing.length)
      return { ok: false,
               refusal: `the registry snapshot is incomplete; missing ${missing.join(", ")}. ` +
                        `Resolve it before admission, as section 2.2 requires: a task cannot gate ` +
                        `its spec PR or authenticate a founder override without these` };

    const claims = filing.claims ?? [];
    if (!claims.length)
      return { ok: false, refusal: `a filing must declare its territory; pass --territory` };
    for (const c of claims)
      if (c?.refusal) return { ok: false, refusal: c.refusal };

    // THE FULL INTERSECTION CHECK, scoped BY PROJECT. Without the project
    // predicate two unrelated repositories that both contain `packages/x`
    // serialise against each other -- a deadlock between projects that share
    // nothing, reported as a territory conflict.
    const at = db.prepare("SELECT unixepoch() n").get().n;
    const held = liveLeases(db, filing.project);
    for (const claim of claims) {
      const lease = firstConflict(claim, held, filing.id);
      if (lease) return { ok: false, refusal: conflictRefusal(claim, lease) };
    }

    db.prepare(
      `INSERT INTO task(id, project, repo_id, nwo_snapshot, title, body, phase, generation,
                        source_kind, source_key, idempotency_key,
                        repo_path, profile_path, profile_hash, default_branch, visibility,
                        spec_repo_id, gate_definition_hash, registry_version, founder_user_id,
                        created_at, updated_at)
       VALUES(?,?,?,?,?,?,'FILED',1,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch(),unixepoch())`)
      .run(filing.id, filing.project, snapshot.repoId, snapshot.nwo, filing.title,
           filing.body ?? null, filing.sourceKind ?? "founder",
           filing.sourceKey ?? filing.idempotencyKey ?? filing.id,
           filing.idempotencyKey ?? null,
           snapshot.repoPath, snapshot.profilePath, snapshot.profileHash,
           snapshot.defaultBranch, snapshot.visibility, snapshot.specRepoId,
           snapshot.gateDefinitionHash, snapshot.registryVersion, snapshot.founderUserId);

    // THE PARENT EVENT FIRST. Replay applies the tail in seq order, and
    // `task_territory` and `territory_lease` both declare a foreign key to
    // `task(id)` -- so emitting the children first makes a replay of this very
    // admission fail on the constraint before the task exists. The order the
    // events are appended in IS the order they are restored in.
    hubEvent(db, { kind: "task.filed", task: filing.id,
      payload: db.prepare(
        `SELECT id, project, repo_id, nwo_snapshot, title, body, phase, generation,
                source_kind, source_key, idempotency_key, repo_path, profile_path, profile_hash,
                default_branch, visibility, spec_repo_id, gate_definition_hash,
                registry_version, founder_user_id, created_at, updated_at
         FROM task WHERE id = ?`).get(filing.id) });

    for (const claim of claims) {
      db.prepare(
        `INSERT INTO task_territory(task, kind, path, pinned) VALUES(?,?,?,?)`)
        .run(filing.id, claim.kind, claim.path, filing.pinTerritory ? 1 : 0);
      // ITS OWN ROW IMAGE. S2-A declares the handler and nothing emitted it, so
      // a snapshot predating admission replayed the task and its lease with no
      // claims beneath them -- and after the next release or resume the task has
      // no territory to rebuild a lease from or to validate its diff against.
      hubEvent(db, { kind: "task_territory.claimed", task: filing.id,
        payload: db.prepare(
          `SELECT task, kind, path, pinned FROM task_territory WHERE task=? AND kind=? AND path=?`)
          .get(filing.id, claim.kind, claim.path) });

      // AN EXPIRED ROW FOR THE SAME PATH IS NOT A CONFLICT, and a plain INSERT
      // treated it as one -- the scan above deliberately excludes dead leases,
      // so admission proceeded and the primary key aborted the whole filing.
      // Reachable after any daemon outage or missed renewal, and it surfaced as
      // an uncaught database error rather than a reasoned refusal.
      const granted = grantLease(db, { project: filing.project, claim, taskId: filing.id,
                                       at, pinned: !!filing.pinTerritory });
      // And the GRANT's event: `territory_lease` is in COMPARISON_SET, so an
      // ungranted event means a post-snapshot admission loses its lease at
      // replay and the task runs with territory nothing records it holding.
      hubEvent(db, { kind: "territory_lease.granted", task: filing.id, payload: granted });
    }

    return { ok: true, taskId: filing.id };
  });
}
