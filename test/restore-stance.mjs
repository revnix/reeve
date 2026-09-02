// WHAT COUNTS AS RECOMMENDING A SNAPSHOT RESTORE.
//
// One rule, in one place, read by every assertion that cares. It used to be
// written per-assertion, and each copy was a different, smaller target for the
// same miss: `hubfault`'s forward-version remedy is the one fault whose correct
// advice is the ABSENCE of a restore, and two separate assertions guarding it
// passed a remedy that recommended the downgrade anyway.
//
// The command is unambiguous. The prose is not, and the difference is MOOD
// rather than vocabulary:
//
//   "a restore WOULD replace a healthy hub"   explains why not to
//   "restore a snapshot taken at 6"           tells the operator to
//
// Both contain the word. So the mood decides, and it is read per CLAUSE: an
// assertion reading the whole sentence cannot tell a forbidding clause from the
// explanation that follows it, which is exactly how "Do NOT restore ..., and a
// restore would replace a healthy hub" defeated a whole-string check.
const RESTORE_CMD = /reeve restore --hub --force/;
const clauses = (s) => s.split(/(?:\.\s|:\s|--\s)/);
const FORBIDDING = /\b(?:do not|does not|never|must not|cannot|rather than)\b/i;
// `needs` WAS HERE AND WAS A HOLE. It was added for "a restore needs more room
// rather than less", but that clause is already excused by `rather than` -- so the
// exemption bought nothing and cost the affirmative reading of "this store needs a
// snapshot restore", which is an instruction rather than a hypothesis. Found by
// review, in the rule written to close exactly this shape.
const SUBJUNCTIVE = /\b(?:would|could)\b/i;

/** Does this remedy tell the operator to install a snapshot over the live store? */
export const recommendsRestore = (remedy) => RESTORE_CMD.test(remedy)
  || clauses(remedy).some((c) => /\b(?:restor|downgrad)\w*/i.test(c)
       && !FORBIDDING.test(c) && !SUBJUNCTIVE.test(c));
