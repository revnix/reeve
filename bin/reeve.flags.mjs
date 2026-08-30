// The CLI's two closed vocabularies: which commands a flag can change, and what
// a refusal is allowed to be.
//
// A SIBLING MODULE rather than a block inside `bin/reeve`, because `bin/reeve`
// runs its route table on import: nothing can import it to look at, so anything
// declared there can only ever be asserted by a regex over source text. This
// repository already carries 74 assertions of that shape, two of them negative
// regexes that a rename disables while still printing PASS.

/**
 * Which commands each flag can change the behaviour of.
 *
 * The parser already refuses an UNKNOWN flag. This is the second layer: a flag
 * that is known, accepted, and inert on the command it was typed at. Measured
 * before this file existed, nine read commands accepted `--json`, three honoured
 * it, and for the other six the output was byte-identical with the flag and
 * without it -- so an operator scripting against one of the six got prose and an
 * exit status of zero, which is the one combination nothing downstream can
 * detect.
 *
 * ABSENT MEANS UNCONSTRAINED. A flag with no entry here behaves exactly as it
 * always has, so the map can be widened one flag at a time without a flag day.
 * What it must never do is claim a completeness it does not have.
 */
export const APPLIES = Object.freeze({
  // The read surfaces that emit a data shape. These are ROUTE names; a route's
  // subcommands are checked by the route itself, because the parser never sees
  // `positionals[0]`.
  //
  // `build` IS DELIBERATELY ABSENT, and it is the measurement that put this file
  // here: counting the token `json` inside each route's own line range gives
  // doctor 2, builder 8, task 8 -- and `build` 0, across all 447 of its lines. The
  // flag is accepted there and cannot do anything, on any of its subcommands. So
  // it is refused until something honours it, rather than advertised and inert.
  json: Object.freeze(["doctor", "status", "builder", "task"]),

  // `--dry-run` was the first flag to need this and had its own allow-list, one
  // gate above the dispatch switch, for the right reason: a per-route check is a
  // rule that depends on the next author remembering it. It is folded in here
  // rather than kept beside this map, because two mechanisms for one rule is the
  // second-inventory defect that this repository keeps paying for -- the two
  // agree today and the third flag decides which of them to copy.
  //
  // The hazard it was written for is the sharpest one available: every flag in
  // this CLI's table is accepted by every command, so `reeve restore --dry-run`
  // parsed cleanly and restore never read it. The flag whose entire promise is
  // "write nothing" was silently ignored by the most destructive command here.
  "dry-run": Object.freeze(["task"]),
});

/**
 * The refusal for a known flag typed at a command that cannot act on it.
 *
 * Returns null when every flag applies, so a caller reads as a guard rather than
 * as a branch. `cmd` may be undefined -- `reeve --json` with no command at all --
 * and that is a usage error the caller already answers, so it is not this one.
 */
export function inapplicable(cmd, flags) {
  if (!cmd) return null;
  // Sorted, so the refusal an operator sees does not depend on the order they
  // happened to type two inapplicable flags in.
  for (const name of [...flags].sort()) {
    const allowed = APPLIES[name];
    if (!allowed || allowed.includes(cmd)) continue;
    return { flag: name, cmd, allowed: [...allowed] };
  }
  return null;
}

/**
 * The exit codes, in one place.
 *
 * `3` was produced by three separate routes and its meaning was written down
 * exactly once, in the usage text -- while the comment that cited a line number
 * for it pointed at the argv parser instead. Three routes agreeing by accident
 * is not a convention, and a second statement of one fact is the inventory
 * problem that this file exists to avoid elsewhere.
 *
 * 0  the answer is yes, or nothing is wrong
 * 1  a refusal, or a state the operator has to act on
 * 2  the command was typed wrongly and nothing was attempted
 * 3  DEGRADED: the command ran, and the answer is partial or the system is unwell
 */
export const EXITS = Object.freeze({ ok: 0, refused: 1, misuse: 2, degraded: 3 });

/**
 * Closed. A kind not named here cannot be emitted, so a script matching on
 * `kind` never meets one it has no branch for, and adding a kind is a deliberate
 * act rather than a call site's invention.
 *
 * Only kinds this build can actually emit are listed. A vocabulary padded with
 * kinds nothing produces reads as coverage and is not: the test that every kind
 * reaching `fail()` is declared would stay green over a route that emits none.
 */
export const ERROR_KINDS = Object.freeze([
  "flag_not_applicable",
  "usage",
  "task_not_found",
  "project_unknown",
  "hub_absent",
  "hub_unreadable",
  "store_absent",
]);
