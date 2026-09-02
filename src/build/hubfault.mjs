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
import { HUB_SCHEMA_VERSION, faultKind } from "./hubdb.mjs";

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
 * @returns {{kind:string, detail:string, remedy:string,
 *            snapshotRestore:"forbidden"|"in-place"|"aside-first"|"unneeded"}|null}
 */
/**
 * How to install a snapshot over a store this binary may not touch.
 *
 * ONE PLACE, because three separate findings were the same defect: a remedy
 * naming `reeve restore --hub --force` for a store whose recorded version exceeds
 * this binary's. `restoreHub` refuses exactly that, BEFORE it takes the lock and
 * where `--force` cannot reach -- so the advice produced the second refusal this
 * module exists to prevent, three times, in three different branches.
 *
 * Patching the third instance would have left the fourth. The condition is not a
 * property of WHICH fault was diagnosed; it is a property of the STORE, so it is
 * asked once here and every damage branch consults it.
 *
 * `plainRestoreRefused` is the question, not one of its causes. There are two so
 * far -- a store recording a version above this binary's, and a `schema_version`
 * marker outside JavaScript's safe integer range, which `restoreHub` re-reads the
 * same way and refuses with the same error. Both were found the same way: a
 * remedy that read correctly and could not be executed.
 */
/**
 * Is this failure a marker no reader can represent?
 *
 * By CODE first, since that is what `node:sqlite` sets, with the message as a
 * fallback for a cause that arrived wrapped. Not by `instanceof RangeError`: a
 * cause that crossed a module boundary can fail that while carrying the code.
 */
const outOfRange = (cause) =>
  cause?.code === "ERR_OUT_OF_RANGE" || /too large to be represented/i.test(cause?.message ?? "");

/**
 * WHERE A REMEDY'S MEANING LIVES. Every fault here takes one of four stances
 * toward installing a snapshot over the live store, and the stance is a FIELD
 * rather than a sentence:
 *
 *   "forbidden"    the store is healthy; a restore would destroy what it holds
 *   "in-place"     the store is broken; `reeve restore --hub --force` repairs it
 *   "aside-first"  a restore is right but refuses in place; move the hub first
 *   "unneeded"     migrating repairs it; no snapshot is involved
 *
 * The assertion guarding the "forbidden" case has been rewritten three times and
 * passed a remedy recommending the downgrade twice. It asserted the WORD
 * ("downgrade") against a sentence that recommended the act without it; then the
 * PHRASE ("restore a snapshot over it"), which exempted the phrase and left the
 * "Do NOT" carrying the meaning unasserted; then the literal forbidding clause,
 * which goes red on a correct reword to "on top of it". Word, phrase, longer
 * phrase: each a smaller target for the same miss, because prose was the only
 * place the meaning existed. It is here now, and a reword cannot move it.
 */
const restoreAdvice = (stance) => stance === "aside-first"
  ? "no binary will repair this in place: a restore refuses a store recording a newer version, " +
    "and a newer binary refuses a history it cannot read. Stop the daemon, move the hub aside -- " +
    "`hub.db` AND `hub.db-wal` AND `hub.db-shm`, together, since a WAL database is all three and " +
    "the -wal can hold committed pages -- and keep them, they are the evidence. Then " +
    "`reeve restore --hub --force` installs the newest usable snapshot in their place"
  : "restore a snapshot (`reeve restore --hub --force`), then retry";

export function historyFault(hist, { expect = HUB_SCHEMA_VERSION,
                                    migrateWith = "`reeve build run`" } = {}) {
  // UNKNOWN IS NOT DAMAGED, and this remedy used to say it was.
  //
  // A reader can see `no such table: schema_version` on a perfectly healthy hub:
  // `openHub` creates the file and then runs the schema DDL, and a command that
  // opens it in that window holds a read transaction whose view has the file and
  // not the table. Telling that operator to force-restore is telling them to
  // replace a healthy store that was one moment from being ready.
  //
  // So the refusal stands -- nothing may proceed against a history it cannot read
  // -- and the remedy is to look again before concluding anything. A restore is
  // named only as what a PERSISTENT failure earns.
  // A MARKER NO READER CAN HOLD IS NOT A TRANSIENT VIEW. `schema_version` is an
  // INTEGER PRIMARY KEY, so a value beyond JavaScript's safe range is valid
  // SQLite -- and `node:sqlite` throws ERR_OUT_OF_RANGE reading it. Re-running
  // cannot help, because the value is the fault; and the plain restore cannot
  // help either, because `restoreHub` reads versions the same way.
  //
  // MEASURED, in both directions: a hub carrying 9223372036854775807 makes
  // `migrationStateOf` answer unreadable with that cause, `restoreHub` refuses it
  // with "could not be examined (Value is too large...)", and moving all three
  // files aside and restoring then SUCCEEDS, leaving a hub at version 5 with the
  // evidence beside it.
  if (hist?.readable !== true && outOfRange(hist?.cause))
    return { kind: "unreadable-marker",
             detail: "its schema_version holds a value no reader can represent " +
                     `(${hist.cause.message}), so the migration history cannot be read at all`,
             remedy: restoreAdvice("aside-first"),
             snapshotRestore: "aside-first",
             // THE ONLY UNREADABLE CASE THAT IS NEVER WORTH RETRYING: the value
             // itself is the fault, so every read reproduces it exactly.
             retryable: false };

  if (!hist || hist.readable !== true)
    return { kind: "unreadable",
             // THE CAUSE TRAVELS IN THE DETAIL, so a caller rendering this does not
             // have to reach past it for the one fact that decides whether trying
             // again can help.
             detail: "its schema_version cannot be read, so which migrations it carries is unknown" +
                     (hist?.cause?.message ? ` — ${hist.cause.message}` : ""),
             // THREE KINDS, because `faultKind` RETURNS three and this asked a
             // yes/no question of it. The fallback then caught everything it did
             // not name -- so `SQLITE_FULL`, which the classifier reports as its
             // own value precisely because it is resource exhaustion rather than
             // damage, was told the store is damaged and to restore. `openHub`'s
             // own full branch says the opposite in as many words: there is
             // nothing wrong with the file, and a restore needs MORE room rather
             // than less.
             //
             // RETRYABILITY IS DECIDED HERE TOO, beside the sentence it has to
             // agree with. The caller derived it from `faultKind` separately and
             // the two disagreed: a hub read during its own creation answers
             // errcode 1, which the classifier calls damage, so the envelope said
             // `retryable: false` while the remedy said to look again. One
             // decision, one place -- the same rule this module exists for.
             //
             // For every shape of an unreadable history, trying again CAN produce
             // a different answer: the holder may release, room may be freed, and
             // a hub mid-creation finishes. That is what `retryable` means, and it
             // is why the marker branch above is the only unreadable case that is
             // never retryable -- there the value itself is the fault.
             ...(() => {
               const kind = faultKind(hist?.cause);
               if (kind === "operational")
                 return { snapshotRestore: "forbidden",
                          remedy: "another process may hold the file, or its permissions may be wrong. " +
                                  "Find out which and re-run. Do NOT restore over it on this evidence: " +
                                  "nothing here says the store is damaged, and a restore would replace a " +
                                  "healthy hub to fix a lock" };
               if (kind === "full")
                 return { snapshotRestore: "forbidden",
                          remedy: "the store ran out of room. Free space on the filesystem holding it, or " +
                                  "check `PRAGMA max_page_count` against `PRAGMA page_count` if the database " +
                                  "has hit its own limit, then re-run. Do NOT restore over it: nothing is " +
                                  "wrong with the file, and a restore needs more room rather than less" };
               return { snapshotRestore: "in-place",
                        remedy: "re-run: a hub being created for the first time reads this way for an " +
                                "instant. If it persists, the store is damaged and `reeve restore --hub " +
                                "--force` installs the newest usable snapshot" };
             })(),
             retryable: true };

  // AN INVALID MARKER COMES FIRST, before the version comparison. `schema_version`
  // is an INTEGER PRIMARY KEY, so a hand-edited `-1` is valid SQLite -- and a store
  // recording `[-1, 6]` is not a newer hub, it is a damaged one that also happens
  // to carry a high number. Comparing versions first declared it healthy.
  if (hist.invalid.length) {
    // ONE const for both, because a field that restates a condition the sentence
    // computes separately is two facts that can drift apart.
    const restore = hist.version > expect ? "aside-first" : "in-place";
    return { kind: "invalid",
             detail: `it records ${hist.invalid.join(", ")} in schema_version, which is not a migration ` +
                     `number this binary can act on (they run 1 through ${expect})`,
             remedy: "the marker itself is wrong, so migrating cannot repair it: " +
                     restoreAdvice(restore),
             snapshotRestore: restore };
  }

  // AHEAD **AND SOUND**. A forward-only history that reached version N carries
  // every version below it, so a store that is ahead AND missing one of the
  // versions this binary knows cannot have been produced by migrating. It is
  // damage wearing a high number, and the healthy-ahead remedy below would tell
  // an operator not to restore the one kind of store that needs it.
  // `holed` AS WELL AS `missing`, because they answer different questions.
  // `missing` is about the range this binary KNOWS -- 1 through `expect` -- and a
  // history like [1,2,3,4,5,7] against expect 5 is missing none of it while
  // skipping 6. `migrationStateOf` reports that as `holed`, and without this the
  // store fell through to the healthy-ahead remedy and was told not to restore.
  // The gap is above this binary's range, so this binary cannot say WHICH
  // migration is absent -- but it can say the history is not one migrating
  // produced, which is the part that decides the remedy.
  if (hist.version > expect && (hist.missing.length || hist.holed))
    return { kind: "ahead-and-holed",
             detail: `it records version ${hist.version}, which is newer than the ${expect} this binary ` +
                     `knows, and its history is not contiguous` +
                     (hist.missing.length ? ` (missing ${hist.missing.join(", ")} below that)` : "") +
                     ". A forward-only history cannot be both, so this store has been altered outside reeve",
             // A REMEDY THAT CAN ACTUALLY BE RUN, and the first version of this
             // could not. `restoreHub` refuses a live hub whose recorded version
             // exceeds this binary's BEFORE it takes the lock, and `--force` does
             // not reach that check -- so `reeve restore --hub --force` answers
             // "Upgrade reeve" and nothing is repaired. That is the second refusal
             // this whole module exists to stop an operator walking into, written
             // into the module by me.
             //
             // Upgrading does not help either: the newer binary reads the same
             // non-contiguous history and refuses it for the same reason. The hub
             // has to stop being the live hub before anything will touch it, so
             // the remedy names the move, and the move keeps the file as evidence
             // rather than deleting it.
             remedy: restoreAdvice("aside-first"),
             snapshotRestore: "aside-first" };

  // NO SNAPSHOT REMEDY FOR A HEALTHY NEWER HUB, and this is the one case where
  // offering the usual repair is dangerous rather than merely unhelpful.
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
                     "the newer one wrote to fix nothing",
             snapshotRestore: "forbidden" };

  if (!hist.missing.length) return null;

  const carries = hist.have.join(", ") || "none";
  const detail = `it is missing migration(s) ${hist.missing.join(", ")} (it carries ${carries}, and this ` +
                 `binary expects 1 through ${expect})`;

  // THE TWO REMEDIES, and the whole reason this module exists. `openHub` re-runs
  // a missing TAIL and refuses a HOLE, so only one of these two faults migrates.
  const restore = hist.version > expect ? "aside-first" : "in-place";
  return hist.holed
    ? { kind: "hole", detail,
        remedy: "this is a HOLE, not a missing tail, so migrating cannot repair it: the migrations " +
                "beneath the ones already applied cannot be re-run. " + restoreAdvice(restore),
        snapshotRestore: restore }
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
        remedy: `run a command that writes (for example ${migrateWith}) to migrate, then retry`,
        snapshotRestore: "unneeded" };
}
