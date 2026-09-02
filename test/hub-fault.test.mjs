// The migration-history decision, as a table.
//
// `historyFault` is consulted by two callers that render it differently -- `task
// file --dry-run` prints and stops, the read routes refuse through `fail()` -- so
// the ORDER of its cases is the part neither caller can check. Two review findings
// were both ordering: a store recording `[-1, 6]` was declared a healthy newer hub
// because the version comparison ran before the invalid-marker check, and one
// recording `[1, 6]` likewise, though a forward-only history cannot be ahead AND
// missing something below it.
//
// A TABLE RATHER THAN PROSE, because the failures are all "this shape reached the
// wrong branch", and a table is the only form where adding a shape is one line and
// the neighbours stay visible beside it.
import { historyFault } from "../src/build/hubfault.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const EXPECT = 5;
const hist = (o) => ({ readable: true, missing: [], have: [], holed: false, invalid: [], version: 0, ...o });
const kindOf = (h) => historyFault(h, { expect: EXPECT })?.kind ?? "none";

// ── the ordering table ────────────────────────────────────────────────────────
const TABLE = [
  { name: "a complete history is no fault at all",
    h: hist({ have: [1, 2, 3, 4, 5], version: 5 }), kind: "none" },
  { name: "a missing tail is a tail",
    h: hist({ have: [1, 2, 3, 4], missing: [5], version: 4 }), kind: "tail" },
  { name: "a gap beneath an applied migration is a hole",
    h: hist({ have: [1, 3], missing: [2, 4, 5], holed: true, version: 3 }), kind: "hole" },
  { name: "a sound history above this binary is AHEAD, and healthy",
    h: hist({ have: [1, 2, 3, 4, 5, 6], version: 6 }), kind: "ahead" },
  // The two findings, as rows.
  { name: "ahead AND missing something below it is damage, not a newer hub",
    h: hist({ have: [1, 6], missing: [2, 3, 4, 5], holed: true, version: 6 }), kind: "ahead-and-holed",
    why: "a forward-only history that reached 6 carries every version below it" },
  { name: "an invalid marker beats a high version, because it is not a version",
    h: hist({ have: [6], missing: [1, 2, 3, 4, 5], invalid: [-1], version: 6 }), kind: "invalid",
    why: "schema_version is an INTEGER PRIMARY KEY, so a hand-edited -1 stores" },
  { name: "a gap ABOVE this binary's range is still not a newer hub",
    h: hist({ have: [1, 2, 3, 4, 5, 7], holed: true, version: 7 }), kind: "ahead-and-holed",
    why: "missing is about 1..expect and reports none here, so only `holed` sees the gap at 6" },
  { name: "a marker no reader can represent is not a transient view",
    h: { readable: false, missing: [], have: [], holed: false, invalid: [], version: 0,
         cause: Object.assign(new Error("Value is too large to be represented as a JavaScript number: 9223372036854775807"),
                              { code: "ERR_OUT_OF_RANGE" }) },
    kind: "unreadable-marker",
    why: "re-running cannot help because the value IS the fault, and restoreHub reads versions the same way" },
  { name: "an unreadable history is its own answer",
    h: { readable: false, missing: [], have: [], holed: false, invalid: [], version: 0 }, kind: "unreadable" },
];
for (const row of TABLE) {
  const got = kindOf(row.h);
  check(got === row.kind, row.name, `got ${got}, expected ${row.kind}${row.why ? ` — ${row.why}` : ""}`);
}
check(new Set(TABLE.map(r => r.kind)).size === 8 && TABLE.length === 9,
  "control: nine rows over eight DISTINCT answers, so it is not asserting one branch nine times",
  [...new Set(TABLE.map(r => r.kind))].join(","));

// ── the remedies that must NOT be given ──────────────────────────────────────
//
// Each of these is a remedy that is correct for some other fault and destructive
// for this one. Asserting the absence is the point: they are the cases where the
// usual repair is the wrong answer.
{
  const ahead = historyFault(hist({ have: [1, 2, 3, 4, 5, 6], version: 6 }), { expect: EXPECT });
  check(!/restore a snapshot(?! over it)/i.test(ahead.remedy),
    "a HEALTHY newer hub is never offered a snapshot restore",
    `it is not broken -- this binary is old -- so an older snapshot discards what the newer one wrote: ${ahead.remedy}`);
  check(/newer binary/.test(ahead.remedy),
    "control: and it is told to run the newer binary instead", ahead.remedy);

  // THE OUT-OF-RANGE MARKER GETS THE RUNNABLE FORM, and "runnable" here is
  // measured rather than argued. A hub carrying 9223372036854775807 makes
  // `restoreHub` refuse with "could not be examined (Value is too large...)", and
  // moving all three files aside and restoring then succeeds, leaving a hub at the
  // current version with the evidence beside it.
  const marker = historyFault({ readable: false, missing: [], have: [], holed: false, invalid: [], version: 0,
                                cause: Object.assign(new Error("Value is too large to be represented as a JavaScript number: 1"),
                                                     { code: "ERR_OUT_OF_RANGE" }) },
                              { expect: EXPECT });
  check(/move the hub aside/.test(marker.remedy),
    "an out-of-range marker is told to move the store aside, because the restore reads it the same way",
    marker.remedy);
  check(!/^re-run/.test(marker.remedy),
    "control: and is NOT told to re-run, because the value is the fault rather than a moment in time",
    marker.remedy);

  const unreadable = historyFault({ readable: false, missing: [], have: [], holed: false, invalid: [], version: 0 },
                                  { expect: EXPECT });
  check(/re-run/i.test(unreadable.remedy),
    "an UNREADABLE history is told to look again before concluding damage",
    `openHub creates the file and then runs the DDL, so a reader in that window sees no schema_version on a healthy hub: ${unreadable.remedy}`);
  check(/if it persists/i.test(unreadable.remedy),
    "control: with a restore named only as what a PERSISTENT failure earns", unreadable.remedy);

  // A REMEDY HAS TO BE RUNNABLE. This one told the operator to `reeve restore --hub
  // --force`, and `restoreHub` refuses a live hub recording a newer version BEFORE
  // it takes the lock, with `--force` not reaching that check -- so following it
  // produced the second refusal this module exists to prevent. Upgrading does not
  // help either: a newer binary reads the same non-contiguous history and refuses
  // it for the same reason.
  const ahd = historyFault(hist({ have: [1, 6], missing: [2, 3, 4, 5], holed: true, version: 6 }), { expect: EXPECT });
  check(/move the hub aside/i.test(ahd.remedy),
    "an ahead-and-holed hub is told to move the store aside, which is the only thing that unblocks a restore",
    ahd.remedy);
  check(/no binary will repair this in place/i.test(ahd.remedy),
    "control: and it says plainly that neither a restore nor an upgrade repairs it where it stands",
    ahd.remedy);
  // ALL THREE, because a hub is not one file. `openHub` forces WAL, so a live
  // store is `.db`, `.db-wal` and `.db-shm`; a crash or a reader still holding it
  // leaves the WAL behind with committed pages, which is the state this remedy is
  // reached in. Naming only the `.db` splits the evidence and leaves a stale -wal
  // beside whatever the restore puts back.
  check(/hub\.db-wal/.test(ahd.remedy) && /hub\.db-shm/.test(ahd.remedy),
    "and the move names all THREE files of a WAL database, not just the .db",
    ahd.remedy);
  check(/keep them/i.test(ahd.remedy),
    "control: and to KEEP them, because they are the evidence of what happened",
    ahd.remedy);

  // THE CONDITION IS THE STORE, NOT THE DIAGNOSIS. `restoreHub` refuses any live
  // hub recording a version above this binary's, before `--force` can act -- so
  // whether the plain restore command is runnable depends on `version > expect`
  // and NOT on which fault was named. Three findings were the same defect in three
  // different branches; asserting it per branch is what keeps the fourth from
  // being written.
  const aheadForms = [
    ["invalid marker on a store that is also ahead",
     hist({ have: [6], missing: [1, 2, 3, 4, 5], invalid: [-1], version: 6 })],
    ["ahead and holed",
     hist({ have: [1, 6], missing: [2, 3, 4, 5], holed: true, version: 6 })],
  ];
  for (const [label, h] of aheadForms) {
    const r = historyFault(h, { expect: EXPECT });
    check(/move the hub aside/.test(r.remedy),
      `${label}: is told to move the store aside, because a plain restore refuses it`,
      `${r.kind}: ${r.remedy}`);
  }
  const plainForms = [
    ["invalid marker on a store within range",
     hist({ have: [3], missing: [1, 2, 4, 5], holed: true, invalid: [-1], version: 3 })],
    ["a hole within range",
     hist({ have: [1, 3], missing: [2, 4, 5], holed: true, version: 3 })],
  ];
  for (const [label, h] of plainForms) {
    const r = historyFault(h, { expect: EXPECT });
    check(!/move the hub aside/.test(r.remedy) && /reeve restore --hub --force/.test(r.remedy),
      `control: ${label} gets the PLAIN restore, so the move is a decision rather than a habit`,
      `${r.kind}: ${r.remedy}`);
  }

  const holed = historyFault(hist({ have: [1, 3], missing: [2, 4, 5], holed: true, version: 3 }), { expect: EXPECT });
  check(/restore a snapshot/i.test(holed.remedy) && !/reeve build run/.test(holed.remedy),
    "control: and a HOLE still gets the snapshot, so absence above is a decision rather than a habit",
    holed.remedy);
}

// ── the caller names the command, the module decides the class ───────────────
{
  const t = (migrateWith) =>
    historyFault(hist({ have: [1, 2, 3, 4], missing: [5], version: 4 }), { expect: EXPECT, migrateWith }).remedy;
  check(/`reeve build run`/.test(t(undefined)), "the default migrate hint names the builder", t(undefined));
  check(/`reeve task file` without --dry-run/.test(t("`reeve task file` without --dry-run")),
    "and a caller can name the command IT is being run as, which is what --dry-run needs",
    t("`reeve task file` without --dry-run"));
  check(!/``/.test(t("`reeve task file` without --dry-run")),
    "control: the hint is not double-wrapped, which no assertion about the WORDS would notice",
    t("`reeve task file` without --dry-run"));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
