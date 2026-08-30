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
export function dryRunPlan({ project, snapshot, claims, held, switches, pinSeconds = null }) {
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
    // NOT EVALUATED, and said so rather than left empty. The deterministic floors
    // read `risk.sensitivePaths` and `builder.budget.maxPackages` and are applied
    // by the classifier at SIZING; nothing here has either of those, and claim
    // COUNT is not a stand-in for either predicate. Substituting it reported no
    // floor for a single claim inside a sensitive path, and a floor for two
    // claims in one package that exceeds no threshold -- wrong in both
    // directions.
    //
    // An empty list would read as "no floor will fire", which is a claim this
    // function cannot make. Saying it is not evaluated is the honest shape.
    floors: ["not evaluated before SIZING: the deterministic floors read " +
             "risk.sensitivePaths and builder.budget.maxPackages, and the classifier applies them there"],
    switches,
    // THE PIN, so the founder can see it was understood. It is also the only
    // thing that makes the wiring observable: the route parsed and validated the
    // duration and then did not forward it, and every message stayed correct. A
    // preview that shows the pin fails visibly when nothing carries it, where an
    // assertion over the route's source text would only have been testing that
    // the source had not moved.
    pin: pinSeconds == null ? null : { seconds: pinSeconds },
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

  // A RETRY IS INERT EVEN WHEN THE WORLD MOVED. `admitTask` resolves the
  // idempotency key inside its transaction, which is the authority -- but the
  // snapshot is rebuilt BEFORE that, and rebuilding walks the checkout. A script
  // re-running a filing that already succeeded, against a tree where an ancestor
  // of its territory has since become a symlink, was refused or thrown out of
  // rather than told the task it already has. The key exists; the answer is
  // known; nothing about the checkout changes it.
  //
  // This read does not replace the transactional lookup, it precedes it, so a
  // miss here is still caught there. It cannot admit anything.
  if (idempotencyKey != null && db) {
    const seen = db.prepare(
      "SELECT id, phase, generation FROM task WHERE idempotency_key = ?").get(idempotencyKey);
    if (seen) {
      const ev = db.prepare(
        "SELECT MAX(seq) s FROM hub_event WHERE task = ? AND kind = 'task.filed'").get(seen.id).s;
      return { ok: true, task: seen.id, prev: null,
               next: { phase: seen.phase, generation: seen.generation }, evidence_id: ev,
               next_action: "none: this filing was already admitted and nothing was done",
               replayed: true };
    }
  }

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
    plan: dryRunPlan({ project, snapshot, claims: filing.claims, held, switches, pinSeconds }) };

  // --anyway coexists with UNIQUE(source_kind, source_key) by SALTING with the
  // task's own id, so the near-twin admits, the constraint still holds, and the
  // provenance records that the collision was seen and accepted.
  // THE CANONICAL KEY FIRST, ALWAYS. `--anyway` means "proceed despite a
  // collision", not "never take the canonical key": salting unconditionally left
  // the unsalted title hash unclaimed, so the FIRST filing of a title made with
  // --anyway did not occupy it -- and a later filing of the identical title
  // WITHOUT --anyway was admitted silently, receiving no near-twin warning at
  // all. The flag meant to acknowledge a duplicate was what disabled the
  // detection of one.
  //
  // So the canonical key is attempted, and the salt is used only when the
  // database actually refuses it.
  const id = mintTaskId();
  const canonicalKey = titleHash(title);
  const admit = (sourceKey) => withWriterLease(db,
    { command: "reeve task file", pid, lstart, isAlive },
    () => admitTask(db, snapshot, { id, project, title, body, depth, priority,
      sourceKind: "founder", sourceKey, idempotencyKey,
      textHash: filingTextHash(title, body), filedVia: "cli",
      pinTerritory: pinSeconds != null,
      pinnedUntil: pinSeconds != null ? Math.trunc(Date.now() / 1000) + pinSeconds : undefined },
      { isAlive }));

  const collided = (e) =>
    /UNIQUE constraint failed: task\.source_kind, task\.source_key/.test(String(e?.message));

  try {
    let r;
    try {
      r = admit(canonicalKey);
    } catch (e) {
      // ONLY NOW. The canonical key was refused by the database, which is the
      // only thing that can establish a real collision, and `--anyway` is the
      // founder saying to proceed past one. Without a collision there is nothing
      // to proceed past, so the canonical key is simply taken.
      if (!(anyway && collided(e))) throw e;
      r = admit(`${canonicalKey}:${id}`);
    }
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
    if (collided(e)) {
      const twin = db.prepare(
        "SELECT id, title FROM task WHERE source_kind = 'founder' AND source_key = ?")
        .get(canonicalKey);
      return { ok: false, refusal:
        `a task with this title was already filed${twin ? ` as ${twin.id} (${JSON.stringify(twin.title)})` : ""}. ` +
        `Titles are compared with spacing and case normalized, so near twins collide on purpose. ` +
        `Pass --anyway to file this one beside it, or give it a title that says how it differs` };
    }
    throw e;
  }
}
