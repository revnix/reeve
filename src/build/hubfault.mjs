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
export function historyFault(hist, { expect = HUB_SCHEMA_VERSION } = {}) {
  if (!hist || hist.readable !== true)
    return { kind: "unreadable",
             detail: "its schema_version cannot be read, so which migrations it carries is unknown",
             remedy: "restore a snapshot (`reeve restore --hub --force`), then retry" };

  if (hist.version > expect)
    return { kind: "ahead",
             detail: `it is schema version ${hist.version}, and this binary knows ${expect}. ` +
                     "Migrations are forward-only, so this binary cannot read it",
             remedy: `run the newer binary, or restore a snapshot taken at ${expect}` };

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
    : { kind: "tail", detail,
        remedy: "run a command that writes (for example `reeve build run`) to migrate, then retry" };
}
