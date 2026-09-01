// hubfault -- what is wrong with a hub's migration history, and what repairs it.
//
// ONE DECISION, TWO RENDERINGS. Two commands ask this question and answer it
// differently: `task file --dry-run` prints to stderr and stops, while the read
// routes (`task list|show|why|dash`) refuse through `fail()` with a machine kind
// and an exit code. Before this module they also DECIDED differently, and that is
// the defect #121 reported: the dry-run path split a missing TAIL from a HOLE and
// sent each to the remedy that works on it, while the read routes computed the
// same set subtraction by hand and gave every shape the tail's advice.
//
// A hub recording 1 and 3 with 2 absent was therefore told to run a command that
// writes -- which `openHub` refuses outright, because a migration beneath an
// applied one cannot be re-run over a store that has already moved past it. So
// the reader sent the operator to a second refusal, and the second refusal was
// the one naming the actual repair.
//
// The fix is not to copy the good branch into the second site. Two sites that
// agree today are two inventories of one rule, and this repository has paid for
// that shape repeatedly: the duplicate is what let the two answers drift in the
// first place. So the DECISION lives here and each caller renders it.
//
// Text, not booleans, because the remedy is the product. A caller handed
// `{ holed: true }` has to know what a hole implies, which is exactly the
// knowledge that went missing from one of the two sites.
import { HUB_SCHEMA_VERSION } from "./hubdb.mjs";

/**
 * The fault in a migration history, or null when there is none.
 *
 * Takes the state rather than a path or a connection: `migrationStateOf` already
 * reads it on the caller's own connection, and re-reading here would open a
 * second one -- leaving a window in which a newer reeve migrates and the answer
 * describes a hub that no longer exists.
 *
 * ORDER IS PART OF THE ANSWER. Ahead comes before invalid and invalid before
 * missing, because each earlier fault makes the later ones misleading rather than
 * merely less important:
 *
 *   - a hub NEWER than this binary is missing nothing it knows about, but every
 *     version this binary expects beyond its own reads as present; reporting it
 *     as anything else sends the operator to migrate a store that must not be
 *     touched by an older binary at all
 *   - an INVALID marker (`schema_version` is an INTEGER PRIMARY KEY, so a
 *     hand-edited `-1` is valid SQLite) makes every expected version read as
 *     missing and nothing read as a hole, so the missing branch would advise
 *     migrating -- which cannot repair a marker that is not a version
 *
 * @param {{readable:boolean, missing:number[], have:number[], holed:boolean, invalid:number[], version:number}} hist
 * @returns {{kind:string, detail:string, remedy:string}|null}
 */
export function historyFault(hist, { expect = HUB_SCHEMA_VERSION,
                                    migrateWith = "`reeve build run`" } = {}) {
  if (!hist || hist.readable !== true)
    return { kind: "unreadable",
             detail: "its schema_version cannot be read, so which migrations it carries is unknown",
             remedy: "restore a snapshot (`reeve restore --hub --force`), then retry" };

  // NO SNAPSHOT REMEDY FOR A NEWER HUB, and this is the one case where offering
  // the usual repair is dangerous rather than merely unhelpful.
  //
  // Every other fault here describes a BROKEN store, where installing a snapshot
  // trades lost recent state for a working hub. A forward-version store is not
  // broken: it is healthy and this binary is old. Restoring a snapshot taken at
  // this binary's version over it destroys everything the newer binary wrote --
  // rows, and semantics that did not exist at that version -- to fix nothing.
  //
  // The message this replaced said `run the newer binary, or restore a snapshot
  // taken at N`, which I carried over from the dry-run path when extracting this.
  // Review caught it, and the assertion I had written could not: it tested for the
  // WORD "downgrade" and the sentence recommends the ACT without using it.
  if (hist.version > expect)
    return { kind: "ahead",
             detail: `it is schema version ${hist.version}, and this binary knows ${expect}. ` +
                     "Migrations are forward-only, so this binary cannot read it",
             remedy: "run the newer binary. Do NOT restore a snapshot over it: this store is " +
                     "healthy and this binary is old, so an older snapshot would discard whatever " +
                     "the newer one wrote to fix nothing" };

  if (hist.invalid.length)
    return { kind: "invalid",
             detail: `it records ${hist.invalid.join(", ")} in schema_version, which is not a migration ` +
                     `number this binary can act on (they run 1 through ${expect})`,
             remedy: "the marker itself is wrong, so migrating cannot repair it: restore a snapshot " +
                     "(`reeve restore --hub --force`), then retry" };

  if (!hist.missing.length) return null;

  const carries = hist.have.join(", ") || "none";
  const detail = `it is missing migration(s) ${hist.missing.join(", ")} (it carries ${carries}, and this ` +
                 `binary expects 1 through ${expect})`;

  // THE TWO REMEDIES, and the whole reason this module exists. `openHub` re-runs
  // a missing TAIL and refuses a HOLE, so only one of these two faults migrates.
  return hist.holed
    ? { kind: "hole", detail,
        remedy: "this is a HOLE, not a missing tail, so migrating cannot repair it: the migrations " +
                "beneath the ones already applied cannot be re-run. Restore a snapshot " +
                "(`reeve restore --hub --force`), then retry" }
    // THE COMMAND IS THE CALLER'S, the DECISION is not -- and so are its backticks.
    //
    // The two hints are not the same shape: one is a bare command, the other is a
    // command plus a flag to leave off. Wrapping both in one pair of quotes here
    // rendered "`reeve task file` without --dry-run`", a stray backtick that every
    // assertion about that text passed straight over, because they match words and
    // not punctuation. I only saw it by printing the string.
    //
    // Which fault this is, and which CLASS of remedy it takes, is one rule and
    // lives here. Which concrete command to name is context: `task file
    // --dry-run` should tell an operator to re-run the command they are already
    // running, and a read route has no writing command of its own to offer, so it
    // names the builder. Hard-coding one of them here replaced the dry-run path's
    // contextual advice with a generic instruction to run something else, which a
    // control in `migration-history` caught immediately.
    : { kind: "tail", detail,
        remedy: `run a command that writes (for example ${migrateWith}) to migrate, then retry` };
}
