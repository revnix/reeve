/**
 * Substituting a parent effect's result into the child that waited for it.
 *
 * The problem this solves is narrow and it is the whole reason the dependency is
 * an edge between two rows rather than one handler doing both halves.
 *
 * `idem_key` is deterministic and is fixed at ENQUEUE time -- that is what makes a
 * double enqueue impossible. But a spill's reply has to name an issue number that
 * does not exist until the create has delivered, which is strictly later. So the
 * number cannot be baked into the child's args when the child is written, and the
 * child cannot be written later without giving up the transactional guarantee that
 * the decision and its effects are durable together.
 *
 * The answer is to enqueue the child with a TOKEN where the value will go, and to
 * resolve it from the parent's recorded result at delivery time. The args in the
 * table stay constant, so the row is still content-stable and still deduplicated
 * by its key; only what is handed to the handler is filled in.
 *
 * Values are substituted as TEXT, always. A typed substitution -- returning a
 * number when the whole string is one token -- was considered and dropped: every
 * consumer here passes the value to `gh`, which takes strings, so the only thing
 * types would add is a second code path to get wrong.
 */

/** `${dep.a.b}` -- a dotted path into the parent's recorded result. */
const TOKEN = /\$\{dep\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\}/g;

/**
 * Thrown when a token cannot be filled.
 *
 * A distinct class because the drainer has to settle it TERMINALLY. The parent is
 * `done`, so its result is final: asking again gets the same answer, and a retry
 * budget spent re-deriving a fixed value is a budget spent on nothing. It means
 * the producer and the handler disagree about the shape of the result, which is a
 * programming error and needs a person.
 *
 * The alternative is far worse and is the failure this class exists to make
 * impossible: substituting an empty string and delivering, which posts a comment
 * reading "see #" or "see ${dep.number}" to a real pull request. A visibly broken
 * comment on someone's pull request is not a smaller failure than a dead letter,
 * it is a louder one that reeve cannot take back.
 */
export class DependencyResolutionError extends Error {
  constructor(message) { super(message); this.name = "DependencyResolutionError"; }
}

/** Walk a dotted path, returning `undefined` for any missing link. */
function at(obj, path) {
  let cur = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object" || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Whether anything anywhere in `args` asks for a substitution. */
export function needsDependency(args) {
  let found = false;
  walk(args, s => { TOKEN.lastIndex = 0; if (TOKEN.test(s)) found = true; return s; });
  return found;
}

/** Map every string in a JSON-ish value, preserving shape. */
function walk(value, fn) {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map(v => walk(v, fn));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, fn);
    return out;
  }
  return value;
}

/**
 * Fill every `${dep.…}` in `args` from `parentResult`.
 *
 * Returns args unchanged when there is nothing to fill, so a row with no edge and
 * a row whose args happen to contain no token take the same path.
 *
 * THROWS rather than returning a partial result. A half-substituted body is the
 * one outcome with no honest reading: it looks like a delivered effect and reads
 * as a broken one.
 */
export function resolveDependencyArgs(args, parentResult) {
  if (!needsDependency(args)) return args;

  // A token with no parent at all is a producer that wrote a dependent effect and
  // forgot the edge. Named separately from a missing FIELD because the repair is
  // different: one is a missing `dependsOn`, the other is a result shaped
  // differently from what the producer expected.
  if (parentResult == null)
    throw new DependencyResolutionError(
      "these args carry a ${dep.…} token but the effect has no dependency, so there is no result to read from");

  const missing = new Set();
  const filled = walk(args, s => s.replace(TOKEN, (whole, path) => {
    const v = at(parentResult, path);
    // `null` counts as missing. A handler that recorded an explicit null is saying
    // it does not have the value, and interpolating "null" into a comment body is
    // the visibly-broken delivery this refuses to make.
    if (v === undefined || v === null) { missing.add(path); return whole; }
    return String(v);
  }));

  if (missing.size)
    throw new DependencyResolutionError(
      `the dependency's result has no ${[...missing].map(p => `\`${p}\``).join(", ")}; ` +
      `it recorded ${JSON.stringify(parentResult)}`);

  return filled;
}
