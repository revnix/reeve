// taskfile -- `reeve task file`, importable.
//
// Split from `bin/reeve` so the command's behaviour can be tested without
// spawning the binary, and so every statement it runs lives under src/build/,
// which is one of the two directories allowed to contain raw SQL.
import { randomBytes } from "node:crypto";
import { normalizeClaim, resolveSnapshot, admitTask } from "./registry.mjs";
import { readStart } from "../supervisor.mjs";

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
 * File one task: grammar, then the network reads, then one admission.
 *
 * The ordering is load-bearing. A filing that cannot be admitted on its
 * grammar must not cost a round trip to find that out, so `normalizeFiling`
 * runs before anything reaches `io`.
 */
export async function fileTask({ db, registry, project, title, territory,
                                 body = null, depth = null, priority = "p2",
                                 idempotencyKey = null, io, isAlive,
                                 pid = process.pid, lstart = readStart(process.pid) }) {
  // NO DEFAULT, and a throw rather than a fallback. `admitTask` defaults
  // `isAlive` to `() => true`, which treats a live restore's holder as dead and
  // admits a filing while the hub file is being replaced underneath it. The
  // caller that owns a process is the caller that can answer the question.
  if (typeof isAlive !== "function")
    throw new Error("fileTask needs a liveness predicate; pass isSameProcess. A default here fails open.");

  const filing = normalizeFiling({ title, territory, depth, priority });
  if (filing.refusal) return { ok: false, refusal: filing.refusal };

  const snapshot = await resolveSnapshot(registry, project, filing.claims, io);
  if (snapshot.refusal) return { ok: false, refusal: snapshot.refusal };

  const id = mintTaskId();
  const r = admitTask(db, snapshot, { id, project, title, body,
    sourceKind: "founder", idempotencyKey }, { isAlive });
  if (!r.ok) return { ok: false, refusal: r.refusal };
  return { ok: true, task: r.taskId, replayed: r.replayed === true };
}
