// hubguest -- the guardian's hub connection, and everything it cannot reach.
//
// Section 13 says the guardian's hub surface is exactly two touches: it WRITES
// the provider scheduler and it READS `pr_hold`. A comment saying "do not touch
// other tables" is checked by whoever remembers; a connection that refuses is
// checked by the connection. That is the whole reason this file exists -- a
// guardian that grew a third touch would pass every functional test it has, and
// this is the only thing that would notice.
//
// `maintenance_lock` is a third table and is deliberately included. It is not a
// third SURFACE: it is the precondition on the two the guardian already has.
// Every hub writer checks the lock before writing, and a guardian that could
// write `provider_lease` while a restore was replacing the file would reopen the
// race the lock exists to close. The DELETE is the ordinary reap of a lock whose
// holder is provably dead, identical to what every other writer does, and grants
// no new reach. Section 13 describes the surfaces the guardian acts ON; this is
// the check it acts UNDER.
//
// Transaction control is included for the same kind of reason. `claimProvider`
// and `releaseProvider` write through a `BEGIN IMMEDIATE`, and section 10.4
// REQUIRES admission to be evaluated under one -- so an allowlist of tables
// alone does not narrow the surface, it breaks it.
import { DatabaseSync, constants } from "node:sqlite";
import { HUB_BUSY_TIMEOUT_MS } from "./hubdb.mjs";

// What each permitted table may be asked to do. Anything absent is denied,
// including tables that do not exist: the default is refusal, so a table added
// to the schema later is unreachable from here until someone decides otherwise.
export const ALLOWED = Object.freeze({
  provider_lease: ["read", "insert", "update", "delete"],
  provider_state: ["read", "insert", "update", "delete"],
  // READ ONLY. The guardian renders a BLOCK from these rows; the builder is the
  // only thing that may write them.
  pr_hold: ["read"],
  // Read to see whether a restore holds it, delete to reap one whose holder is
  // dead. Never written: taking the lock is a restore's act, not a guest's.
  maintenance_lock: ["read", "delete"],
});

const OP = new Map([
  [constants.SQLITE_READ, "read"],
  [constants.SQLITE_INSERT, "insert"],
  [constants.SQLITE_UPDATE, "update"],
  [constants.SQLITE_DELETE, "delete"],
]);

// Actions that name no table and carry no reach of their own. SELECT is the
// "may a SELECT run at all" check -- the tables it touches arrive separately as
// READs, which is what makes a join, a subquery and a UNION all visible.
// FUNCTION covers `unixepoch()` and `count()`, without which nothing here runs.
// The only SQL functions the scheduler's statements use. SQLite's built-in set
// varies by build and release, so authorising the ACTION rather than the NAME
// silently widens this surface every time the runtime gains a function -- and
// the point of a default-deny allowlist is that new capability arrives refused
// rather than granted.
const FUNCTIONS_OK = new Set(["count", "unixepoch", "max", "coalesce"]);

const TABLELESS_OK = new Set([
  constants.SQLITE_SELECT,
  constants.SQLITE_RECURSIVE,
  // Shape is enforced by the scanner below, because the authorizer cannot see
  // it: measured on node v24.17.0, every flavour of BEGIN -- IMMEDIATE,
  // EXCLUSIVE, DEFERRED and bare -- arrives here as the string "BEGIN".
  constants.SQLITE_TRANSACTION,
]);

/**
 * Strip comments and string literals, leaving structure.
 *
 * The transaction SHAPE has to be read off the text, and reading text means
 * handling the two things that make text lie. A `--` inside a string literal is
 * not a comment, and treating it as one hides everything after it -- including a
 * semicolon and whatever follows. That is not hypothetical: `SELECT '--';
 * BEGIN EXCLUSIVE` is a one-line exclusive lock behind a regex that trusts
 * `--`.
 *
 * Replaced with spaces rather than removed, so offsets and word boundaries
 * survive: `a'x'b` must not become the single token `ab`.
 */
export function stripSql(sql) {
  let out = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i], d = sql[i + 1];
    // EVERY QUOTING FORM SQLITE HAS, not just the two that look like strings.
    //
    // SQLite also quotes IDENTIFIERS with backticks and with square brackets, and
    // a comment marker inside one of those is no more a comment than one inside a
    // string. Handling only ' and " left a real bypass of the single thing this
    // module exists to prevent: `SELECT count(*) AS ` + "`--`" + ` FROM
    // provider_state; BEGIN EXCLUSIVE` had everything after the marker stripped,
    // so the scanner saw one harmless statement, and `exec` then ran both and
    // opened an EXCLUSIVE transaction -- blocking the builder and every restore.
    // Verified by reproducing it before the fix.
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      // A doubled quote inside a literal is an escaped quote, not the end of it.
      // Brackets do not nest and have no escape, so the first ] closes them.
      out += " "; i++;
      while (i < sql.length) {
        if (close !== "]" && sql[i] === close && sql[i + 1] === close) { out += "  "; i += 2; continue; }
        if (sql[i] === close) { out += " "; i++; break; }
        out += sql[i] === "\n" ? "\n" : " "; i++;
      }
      continue;
    }
    if (c === "-" && d === "-") {
      while (i < sql.length && sql[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (c === "/" && d === "*") {
      out += "  "; i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        out += sql[i] === "\n" ? "\n" : " "; i++;
      }
      if (i < sql.length) { out += "  "; i += 2; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

class GuestRefused extends Error {
  constructor(message) { super(message); this.name = "GuestRefused"; }
}

/**
 * Refuse any transaction the guardian is not allowed to open.
 *
 * ONE permitted shape: `BEGIN IMMEDIATE`. A guest holding an EXCLUSIVE lock
 * blocks the builder and every restore for as long as it holds it, and a
 * DEFERRED one takes its write lock late -- which is precisely the read-then-
 * write race that admission is a transaction to avoid. `SAVEPOINT` is a
 * transaction under another name and arrives as its own action code.
 *
 * EVERY statement in the string, not the first: an `exec` wrapper that validates
 * only what comes before the first semicolon lets everything after it through.
 */
function refuseBadTransactions(sql) {
  const parts = stripSql(sql).split(";").filter(x => x.trim().length);
  // ONE STATEMENT PER CALL, on both doors, and this is not fussiness.
  //
  // `prepare` compiles the FIRST statement and discards the tail, so the
  // authorizer never sees the second one at all: `SELECT * FROM provider_lease;
  // SELECT * FROM task` reaches the table boundary through a door the boundary
  // cannot watch. And a multi-statement `exec` that is denied part-way has
  // already run what came before it -- `BEGIN IMMEDIATE; DELETE FROM approval`
  // opens a write transaction, is refused on the delete, and leaves the guest
  // holding the hub's write lock with nothing left to release it. Refusing the
  // shape outright removes both, and nothing here needs it: every statement the
  // scheduler issues is a single one.
  if (parts.length > 1)
    throw new GuestRefused(
      `more than one statement in a call is not permitted on the guardian's hub ` +
      `connection: ${parts.length} statements`);
  for (const part of parts) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const head = words[0].toUpperCase();
    if (head === "SAVEPOINT" || head === "RELEASE")
      throw new GuestRefused(
        `a savepoint is not permitted on the guardian's hub connection: ${part.trim().slice(0, 60)}`);
    if (head !== "BEGIN") continue;
    if ((words[1] ?? "").toUpperCase() !== "IMMEDIATE")
      throw new GuestRefused(
        `${[head, words[1] ?? ""].join(" ").trim()} is not permitted on the guardian's ` +
        `hub connection; only BEGIN IMMEDIATE is`);
  }
}

/**
 * Open the hub as the guardian sees it.
 *
 * Returns a FACADE, not the database. `DatabaseSync` exposes seventeen methods
 * on node v24.17.0, and gating `prepare` and `exec` leaves the mutation-capable
 * ones -- `deserialize`, `applyChangeset`, `loadExtension`, `createSession`,
 * `serialize` -- wide open beside them. Worse, `setAuthorizer` would let the
 * holder switch off the very thing restraining it. So the allowlist is not a
 * flag on the handle: the handle simply does not have the other methods.
 */
export function openHubAsGuest(path) {
  // THE MODULE CHECKS ITS OWN PRECONDITION, rather than trusting a floor
  // declared somewhere else. `engines` is advisory -- npm warns and installs
  // anyway unless the operator opted into engine-strict -- and `bin/reeve`'s
  // runtime check protects the CLI, not an import from anywhere else. This
  // module's whole promise is that the connection it returns is restrained, so
  // it must not return one it could not restrain. Fail closed and say why.
  if (typeof DatabaseSync.prototype.setAuthorizer !== "function")
    throw new Error(
      `node ${process.versions.node} has no DatabaseSync.setAuthorizer (added in 24.10.0), so the ` +
      `guardian's hub connection cannot be restricted; refusing to open an unrestricted one`);

  // THE SAME BUSY TIMEOUT AS EVERY OTHER HUB CONNECTION -- the same VALUE, read
  // from the one place that defines it, not a copy that happens to agree today.
  // A guest on SQLite's default of zero fails instantly with SQLITE_BUSY the
  // moment a builder or a restore holds the write lock for an instant. The
  // guardian treats a scheduler exception as FAIL-OPEN and dispatches
  // unscheduled, so routine write contention would quietly defeat the global
  // quota this connection exists to enforce.
  //
  // Set BEFORE the authorizer is installed, because the authorizer denies PRAGMA
  // -- correctly, since a guest must not reach the schema sideways. The
  // constructor option and the pragma say the same thing; both are set because
  // `openHub` sets both and a guest that behaved differently under contention
  // would be a second answer to the same question.
  const db = new DatabaseSync(path, { timeout: HUB_BUSY_TIMEOUT_MS });
  db.exec(`PRAGMA busy_timeout = ${HUB_BUSY_TIMEOUT_MS}`);
  db.setAuthorizer((action, arg1, arg2) => {
    if (TABLELESS_OK.has(action)) return constants.SQLITE_OK;
    // THE NAME IS arg2 FOR SQLITE_FUNCTION, measured rather than assumed: SQLite
    // passes NULL as the third C argument for this action and the function name
    // as the fourth, so arg1 is null here and reading it denied `count` -- which
    // is the first function every one of these statements uses.
    if (action === constants.SQLITE_FUNCTION)
      return FUNCTIONS_OK.has(String(arg2).toLowerCase()) ? constants.SQLITE_OK : constants.SQLITE_DENY;
    const op = OP.get(action);
    if (!op) return constants.SQLITE_DENY;          // DROP, ATTACH, PRAGMA, everything else
    return (ALLOWED[arg1] ?? []).includes(op) ? constants.SQLITE_OK : constants.SQLITE_DENY;
  });

  const guard = (sql) => { refuseBadTransactions(String(sql)); return sql; };
  // Exactly three methods, and `close` only so a caller can release the file.
  // Adding to this object widens the guardian's reach, which is the one thing
  // this module exists to make hard to do by accident.
  return {
    prepare: (sql) => db.prepare(guard(sql)),
    exec: (sql) => db.exec(guard(sql)),
    close: () => db.close(),
  };
}
