// taskfile -- `reeve task file`, importable.
//
// Split from `bin/reeve` so the command's behaviour can be tested without
// spawning the binary, and so every statement it runs lives under src/build/,
// which is one of the two directories allowed to contain raw SQL.
import { randomBytes } from "node:crypto";
import { normalizeClaim, resolveSnapshot, admitTask } from "./registry.mjs";
import { readStart } from "../supervisor.mjs";
import { withWriterLease } from "./locks.mjs";
import { liveLeases, firstConflict, conflictRefusal } from "./territory.mjs";
import { titleHash, filingTextHash } from "./registryio.mjs";

const DEPTHS = ["trivial", "standard", "deep"];
const PRIORITIES = ["p1", "p2"];

// ONE refusal string, exported, so the test asserts the message the operator
// gets rather than a paraphrase of it. Territory is required at filing and the
// absence of a claim must never read as the absence of conflict, so this is the
// only place that decides how that requirement is explained.
export const TERRITORY_GRAMMAR =
  "a filing must declare its territory: pass --territory <path>, repeatable, " +
  "or --territory-file <file> with one path per line. A claim is a " +
  "repository-relative path -- no glob, no negation, no brace expansion, no " +
  "character class, no absolute path and no parent traversal. " +
  'Example: reeve task file --project nextly --title "..." ' +
  "--territory packages/x --territory packages/y/index.ts";

/**
 * Grammar only: no filesystem, no network, no database.
 *
 * A whitespace-only claim is NOT dropped. `normalizeClaim` returns the
 * repository root for it deliberately, and filtering it out here would turn a
 * claim that conflicts with everything into a filing that conflicts with
 * nothing -- the one reading the grammar exists to refuse.
 */
export function normalizeFiling({ title, territory, depth, priority }) {
  if (typeof title !== "string" || !title.trim())
    return { refusal: "a filing needs a --title; it is what the task is named in every later view" };
  if (depth !== null && depth !== undefined && !DEPTHS.includes(depth))
    return { refusal: `--depth must be one of ${DEPTHS.join(", ")}; got ${JSON.stringify(depth)}` };
  if (!PRIORITIES.includes(priority))
    return { refusal: `--priority must be one of ${PRIORITIES.join(", ")}; got ${JSON.stringify(priority)}` };
  if (!Array.isArray(territory) || territory.length === 0)
    return { refusal: TERRITORY_GRAMMAR };

  const claims = [];
  for (const raw of territory) {
    const c = normalizeClaim(raw, { kind: "prefix" });
    if (c.refusal) return { refusal: c.refusal };
    claims.push(c);
  }
  return { claims };
}

// bt:<ulid>. Crockford base32 over 48 bits of millisecond time and 80 bits of
// randomness, so ids sort by filing order in every listing that has only the id
// to sort by, and two filings in the same millisecond still differ.
const C32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function mintTaskId(at = Date.now(), rnd = randomBytes(10)) {
  let s = "";
  for (let i = 9; i >= 0; i--) { s = C32[at % 32] + s; at = Math.floor(at / 32); }
  let bits = 0n;
  for (const b of rnd) bits = (bits << 8n) | BigInt(b);
  for (let i = 0; i < 16; i++) { s += C32[Number((bits >> BigInt(75 - i * 5)) & 31n)]; }
  return `bt:${s}`;
}

// A pin is a DEADLINE, not a switch: `--pin-territory 48h`. `grantLease` stamps
// the deadline on the claim at the first grant and reads it back at every later
// one, so the value passed here is used exactly once and a wrong unit is a wrong
// promise the founder cannot see. Hours and days only; a bare number is refused
// rather than guessed at.
const PIN = /^(\d+)([hd])$/;
export function pinSeconds(raw) {
  if (raw === null || raw === undefined) return null;
  const m = PIN.exec(String(raw).trim());
  if (!m) return { refusal: `--pin-territory takes a duration like 48h or 3d; got ${JSON.stringify(raw)}` };
  return Number(m[1]) * (m[2] === "h" ? 3600 : 86400);
}

/**
 * Everything `--dry-run` prints, computed with no write of any kind.
 *
 * It reads the live leases rather than reasoning about them, because the whole
 * value of the flag is telling the founder what the real transaction would hit.
 */
export function dryRunPlan({ project, snapshot, claims, held, switches }) {
  // DEDUPLICATED, because admission is. `packages/x` and `packages/./x`
  // normalize to one claim and `admitTask` collapses them, so a plan that
  // counted both would report two claims and two identical conflicts for
  // territory that resolves to one -- a preview that does not describe the
  // transaction it is previewing.
  const seen = new Set();
  const unique = (claims ?? []).filter(c => {
    const key = `${c.kind}\u0000${c.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    project, nwo: snapshot.nwo, profileHash: snapshot.profileHash,
    territory: unique.map(c => ({ kind: c.kind, path: c.path })),
    conflicts: unique.map(c => { const l = firstConflict(c, held, null); return l ? conflictRefusal(c, l) : null; })
                     .filter(Boolean),
    // The classifier has not run, so no floor can have fired yet. The list is
    // the floors that WOULD apply to this territory, which is what the founder
    // is asking; an empty array here means none of them can, not that none were
    // considered.
    floors: unique.length > 1 ? ["territory spans more than one claim; sizing floors are evaluated after SIZING"] : [],
    switches,
  };
}

/**
 * File one task: grammar, then the network reads, then one admission.
 *
 * The ordering is load-bearing. A filing that cannot be admitted on its
 * grammar must not cost a round trip to find that out, so `normalizeFiling`
 * runs before anything reaches `io`.
 */
export async function fileTask({ db, registry, project, title, territory,
                                 body = null, depth = null, priority = "p2",
                                 idempotencyKey = null, anyway = false, dryRun = false,
                                 pinSeconds = null, switches = {}, io, isAlive,
                                 pid = process.pid, lstart = readStart(process.pid) }) {
  // NO DEFAULT, and a throw rather than a fallback, because NEITHER default is
  // safe and the choice is not this function's to make. `assertWritable` throws
  // exactly when the predicate says the restore's holder is ALIVE, so `() => true`
  // never reaps a lock whose holder is long dead and wedges the hub read-only for
  // good, while `() => false` reaps a lock whose holder is still restoring and
  // admits a filing into a file being replaced underneath it. One costs
  // availability and the other costs the write; only the caller that owns a
  // process can tell the two apart, so the caller answers or nothing proceeds.
  if (typeof isAlive !== "function")
    throw new Error("fileTask needs a liveness predicate; pass isSameProcess. A default here fails open.");

  const filing = normalizeFiling({ title, territory, depth, priority });
  if (filing.refusal) return { ok: false, refusal: filing.refusal };

  const snapshot = await resolveSnapshot(registry, project, filing.claims, io);
  if (snapshot.refusal) return { ok: false, refusal: snapshot.refusal };

  // THE LEASE COVERS THE WRITE, and the write only. `withWriterLease` inserts
  // its row in one transaction, runs the callback outside any transaction, and
  // deletes the row in a second -- so `admitTask`'s own BEGIN IMMEDIATE nests
  // nothing. Restore reads `writer_lease` to decide whether a command is
  // mid-write, and a lease taken across the network calls above would make a
  // slow GitHub read look like an in-progress hub write for its whole duration.
  // READ, never write. A dry run that opened a transaction and rolled it back
  // would still take and release the writer lease in its own committed
  // transactions outside the rollback, and restore would see a writer that a
  // dry run should never have created.
  // A DRY RUN MAY HAVE NO STORE. The route declines to create one, so there are
  // no leases to read and no conflicts to report -- which is the true answer for
  // a home where nothing has ever been filed, not a missing one.
  const held = db ? liveLeases(db, project) : [];
  if (dryRun) return { ok: true, dryRun: true,
    plan: dryRunPlan({ project, snapshot, claims: filing.claims, held, switches }) };

  // --anyway coexists with UNIQUE(source_kind, source_key) by SALTING with the
  // task's own id, so the near-twin admits, the constraint still holds, and the
  // provenance records that the collision was seen and accepted.
  const id = mintTaskId();
  const sourceKey = anyway ? `${titleHash(title)}:${id}` : titleHash(title);
  try {
    const r = withWriterLease(db,
      { command: "reeve task file", pid, lstart, isAlive },
      () => admitTask(db, snapshot, { id, project, title, body, depth, priority,
        sourceKind: "founder", sourceKey, idempotencyKey,
        textHash: filingTextHash(title, body), filedVia: "cli",
        pinTerritory: pinSeconds != null,
        pinnedUntil: pinSeconds != null ? Math.trunc(Date.now() / 1000) + pinSeconds : undefined },
        { isAlive }));
    if (!r.ok) return { ok: false, refusal: r.refusal };
    // The evidence id is the seq of the row `admitTask` appended for THIS task,
    // read back rather than guessed: `hubEvent` returns the seq inside the
    // transaction and nothing carries it out, and MAX(seq) over the whole table
    // would name a concurrent writer's row.
    const ev = db.prepare(
      "SELECT MAX(seq) s FROM hub_event WHERE task = ? AND kind = 'task.filed'").get(r.taskId).s;
    return { ok: true, task: r.taskId, prev: null,
             next: { phase: "FILED", generation: 1 }, evidence_id: ev,
             next_action: "none: the builder tick takes FILED to SIZING with no further condition",
             replayed: r.replayed === true };
  } catch (e) {
    // `assertWritable` THROWS while a live restore holds the lock, and it is
    // reached from two places inside this call. A throw here is an operator
    // condition with a useful message, not a defect, so it is returned as the
    // refusal it is; anything else is re-raised unchanged.
    if (/restore is in progress/.test(String(e?.message))) return { ok: false, refusal: e.message };

    // THE NEAR TWIN, and the constraint is the authority rather than a SELECT
    // taken first. `UNIQUE(source_kind, source_key)` is what actually decides,
    // so reading the table before the insert would be a check-then-act race that
    // two concurrent filings of the same title lose in exactly the way the
    // constraint exists to prevent. The write is attempted, the database
    // refuses, and the refusal is translated here into something the founder can
    // act on -- a collision is a warning plus `--anyway`, never a dead end.
    //
    // The lookup names the task that already holds the key. It is best effort:
    // if it comes back empty the refusal still explains itself and still tells
    // the founder what to do, because a message that cannot name the twin is far
    // better than a raw constraint error.
    if (/UNIQUE constraint failed: task\.source_kind, task\.source_key/.test(String(e?.message))) {
      const twin = db.prepare(
        "SELECT id, title FROM task WHERE source_kind = 'founder' AND source_key = ?")
        .get(titleHash(title));
      return { ok: false, refusal:
        `a task with this title was already filed${twin ? ` as ${twin.id} (${JSON.stringify(twin.title)})` : ""}. ` +
        `Titles are compared with spacing and case normalized, so near twins collide on purpose. ` +
        `Pass --anyway to file this one beside it, or give it a title that says how it differs` };
    }
    throw e;
  }
}
