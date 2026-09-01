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
  json: Object.freeze(["doctor", "status", "builder", "task", "notify"]),

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
  // SUBCOMMAND-QUALIFIED, and it has to be. `task file` implements `--dry-run`;
  // `task list`, `task show` and `task why` are readers that never look at it, so
  // a route-level entry accepted it there and did nothing -- recreating, inside
  // the gate built to prevent it, exactly the accepted-and-inert flag it exists
  // to refuse. An entry containing a space names `<command> <subcommand>`.
  "dry-run": Object.freeze(["task file"]),

  // `--project` names the registry entry to file against, and the entry to filter
  // a listing by. `task show` and `task why` take a task id and cannot act on it
  // at all -- `reeve task show <id> --project other` printed the task regardless,
  // which is the accepted-and-inert shape this whole file exists to refuse.
  project: Object.freeze(["task file", "task list"]),

  // `--since` is the cursor a previous digest handed back, and only the digest
  // answers "what moved since then".
  since: Object.freeze(["task dash"]),

  // `--test` is the whole of `reeve notify`: there is no other thing that
  // command does. It is listed rather than left unconstrained so that typing it
  // at a command that sends nothing is refused instead of quietly ignored --
  // which, for a flag whose entire meaning is "do not treat this as real", is
  // the most expensive place to be wrong.
  test: Object.freeze(["notify"]),
});

/**
 * What each `task` read subcommand reads after its own name, and how it is typed.
 *
 * The parser refuses an unknown FLAG and `inapplicable` refuses a known flag on a
 * command that cannot act on it; a bare word was governed by neither. Measured on
 * all four: `task list` and `task dash` read no positional at all and `task show`
 * and `task why` read exactly one, so `reeve task dash 1234.1800000000` exited 0
 * having discarded the cursor -- the digest answered from the beginning of time
 * and looked correct doing it -- and `reeve task show a b c` answered about `a`
 * without saying it had ignored two arguments.
 *
 * THE WRITE ROUTE IS DELIBERATELY ABSENT. `task file` belongs to another lane and
 * takes its inputs as flags; an entry here would change its refusals as a side
 * effect of governing the readers.
 *
 * `usage` lives beside `takes` because the refusal has to say what the right
 * shape is, and the route already printed these four lines from its own literals.
 * One statement, read by both.
 */
export const TASK_ARGS = Object.freeze({
  list: Object.freeze({ takes: 0, usage: "reeve task list [--project <p>] [--json]" }),
  show: Object.freeze({ takes: 1, usage: "reeve task show <task-id> [--json]" }),
  why:  Object.freeze({ takes: 1, usage: "reeve task why <task-id> [--json]" }),
  dash: Object.freeze({ takes: 0, usage: "reeve task dash [--since <cursor>] [--json]" }),
});

/**
 * The arguments a `task` subcommand was given and does not read.
 *
 * Returns null when there are none, so a caller reads as a guard. A subcommand
 * with no entry is UNCONSTRAINED, for the same reason `APPLIES` is: the map can
 * be widened one subcommand at a time without a flag day, and it must never claim
 * a completeness it does not have.
 */
export function extraArgs(sub, rest) {
  const spec = TASK_ARGS[sub];
  if (!spec) return null;
  return rest.length > spec.takes ? rest.slice(spec.takes) : null;
}

/**
 * The refusal for a known flag typed at a command that cannot act on it.
 *
 * Returns null when every flag applies, so a caller reads as a guard rather than
 * as a branch. `cmd` may be undefined -- `reeve --json` with no command at all --
 * and that is a usage error the caller already answers, so it is not this one.
 */
export function inapplicable(cmd, flags, sub = null, valued = []) {
  if (!cmd) return null;
  // BOTH PARSED SETS. The argv walk puts boolean switches in `ARGS.flags` and
  // VALUED options in `ARGS.values`, so a gate reading only the first could never
  // see `--project`, `--title` or any other flag that takes a value -- a whole
  // category of flags exempt from the rule, inside the mechanism written to
  // enforce it. Sorted, so the refusal an operator sees does not depend on the
  // order they happened to type two inapplicable flags in.
  for (const name of [...new Set([...flags, ...valued])].sort()) {
    const allowed = APPLIES[name];
    if (!allowed) continue;
    if (allowed.includes(cmd)) continue;
    if (sub && allowed.includes(`${cmd} ${sub}`)) continue;
    // A SUBCOMMAND-QUALIFIED ENTRY WITH NO SUBCOMMAND TYPED IS NOT DECIDED HERE.
    // `reeve task --dry-run` names no subcommand, so the flag cannot yet be
    // called inapplicable -- and the route is about to refuse the missing
    // subcommand anyway. Answering the flag first would report the wrong error
    // for the wrong reason.
    const qualified = allowed.some(a => a.startsWith(`${cmd} `));
    if (!sub && qualified) continue;
    // NAME THE SUBCOMMAND ONLY WHERE ONE IS MEANT. `positionals[0]` is a
    // subcommand for the routes that have them and an ARGUMENT for the rest --
    // `reeve why 1 o/r` would otherwise be refused as `why 1`, naming a pull
    // request number as though it were a verb.
    return { flag: name, cmd: qualified ? `${cmd} ${sub}` : cmd, allowed: [...allowed] };
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
  "hub_incompatible",
  "store_absent",
]);
