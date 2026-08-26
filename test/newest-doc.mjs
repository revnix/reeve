// Which handoff and which prompt are the CURRENT ones — decided ONCE.
//
// Two tests need this answer and each had its own version. The single-source
// guard matched only the unsuffixed name; the agreement test learned to read a
// same-day `-2` revision. So the moment such a revision existed, one test would
// have policed the live document and the other would have gone on certifying the
// superseded one, and the gap between them is exactly where a volatile claim
// lives. Two statements of one fact, in a pair of tests written to stop that.
//
// This repository revises within a day using a numeric suffix, so a document is
// ordered by its DATE first and then by that suffix NUMERICALLY -- `-10` must not
// sort before `-2`, which a lexical sort would do.
import { readdirSync } from "node:fs";

const rankOf = (file, kind) => {
  const m = new RegExp(`^(\\d{4}-\\d\\d-\\d\\d)-${kind}(?:-(\\d+))?\\.md$`).exec(file);
  return m ? [m[1], Number(m[2] ?? 1)] : null;
};

/** The newest `session-handoff` or `resume-prompt` in `docs`, or throws. */
export function newestDoc(docs, kind) {
  const found = readdirSync(docs)
    .map(f => [f, rankOf(f, kind)])
    .filter(([, r]) => r)
    .sort(([, [da, na]], [, [db, nb]]) => (da === db ? na - nb : (da < db ? -1 : 1)));
  if (!found.length) throw new Error(`no docs/*-${kind}.md at all`);
  return found[found.length - 1][0];
}
