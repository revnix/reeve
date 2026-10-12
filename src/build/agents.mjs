// agents -- the subagent panel a builder phase may fan out to, as data.
//
// Versioned in reeve and hashed into the contract snapshot, so a task that ran
// under one panel cannot silently be compared against another. The definitions
// are reeve's rather than the repository's: a panel a project could supply would
// be a repository instructing the worker reeve sent.
import { createHash } from "node:crypto";

/**
 * The four definitions, in DECLARATION ORDER, which is what the depth slices cut.
 *
 * `standard` takes the first three and `deep` takes all four, so the critic is
 * last deliberately -- adding a definition before it would move who is on the
 * standard panel without anyone editing a depth rule.
 *
 * TOOLS ARE READ-ONLY, and that is a boundary rather than a preference: a
 * subagent runs inside its worker's sandbox, and the worker for these phases is
 * granted `Read`, `Grep` and `Glob` and nothing else. A definition naming a
 * fourth tool would be asking for authority its parent does not have, and the
 * grant it would need is the one `sandboxFor` refuses.
 */
export const AGENT_DEFS = Object.freeze([
  Object.freeze({
    name: "measurer",
    description: "Establishes what the repository actually contains, with the command that shows it.",
    tools: Object.freeze(["Read", "Grep", "Glob"]),
    prompt: "You establish facts about this repository and nothing else. For every claim you " +
      "return, name the file and line that shows it, and prefer a count over an adjective: " +
      "\"41 call sites\" rather than \"many\". If a question cannot be answered from the checkout " +
      "in front of you, say that it cannot rather than inferring an answer. You never propose a " +
      "change, never judge the code, and never speculate about intent — another agent does that " +
      "with what you find.",
  }),
  Object.freeze({
    name: "prior-art-scout",
    description: "Finds how this problem is already solved here, and where the pattern is broken.",
    tools: Object.freeze(["Read", "Grep", "Glob"]),
    prompt: "You look for existing solutions to the problem at hand inside this repository: the " +
      "helper that already does it, the convention the surrounding code follows, the second copy " +
      "that has drifted from the first. Report each with its path and the shape of the call. Say " +
      "explicitly when you find nothing, because 'no prior art' is a finding and an absence " +
      "reported as silence is not. You do not evaluate whether the existing solution is good; you " +
      "report that it is there.",
  }),
  Object.freeze({
    name: "judge",
    description: "Decides what the evidence supports, and refuses where it does not reach.",
    tools: Object.freeze(["Read", "Grep", "Glob"]),
    prompt: "You weigh what the other agents established and say what it supports. Every " +
      "conclusion you draw must name the evidence it rests on, and where the evidence does not " +
      "reach you say so rather than closing the gap with a guess. A conclusion you cannot source " +
      "is a conclusion you do not return. When two findings conflict, report the conflict and " +
      "what would settle it, rather than choosing the more plausible one.",
  }),
  Object.freeze({
    name: "adversarial-critic",
    description: "Attacks the conclusion: what would have to be true for it to be wrong?",
    tools: Object.freeze(["Read", "Grep", "Glob"]),
    prompt: "You try to break the conclusion the other agents reached. Ask what would have to be " +
      "true for it to be wrong, then go and check whether that thing is true. Look for the case " +
      "the evidence does not cover, the fixture that could not have exhibited the defect, and the " +
      "claim that is supported only by an absence. If you cannot break it, say what you tried and " +
      "why each attempt failed — an unsuccessful attack is evidence, and 'looks fine' is not.",
  }),
]);

// How many of the panel each depth may use, cut from DECLARATION ORDER above.
// Null-prototype for the same reason the dispatcher's phase table is: `depth`
// arrives on a task row, so this lookup takes input from the database.
const WIDTH_FOR = Object.freeze(Object.assign(Object.create(null), {
  trivial: 0,
  standard: 3,
  deep: 4,
}));

/**
 * The panel this depth may fan out to: the `--agents` payload and its width.
 *
 * ONE FUNCTION FOR BOTH, because they are one fact. The width is the subagent
 * count the caller budgets and reports; deriving it separately by parsing the
 * JSON back is a second spelling of the same slice, and two spellings of one
 * rule is what drifts.
 *
 * THE PAYLOAD IS AN OBJECT KEYED BY NAME, not an array. Verified against the
 * installed CLI rather than assumed: `--agents <json>` documents itself as
 * "JSON object defining custom agents", with the example
 * '{"reviewer": {"description": "...", "prompt": "..."}}'. An array is a string
 * the flag cannot parse, so the worker would fail at startup carrying a contract
 * that named a panel it never had.
 *
 * `trivial` answers the EMPTY STRING rather than "{}" so `workerArgs` omits the
 * flag entirely — its `if (agents)` is falsy — and a phase with no fan-out is
 * dispatched with no `--agents` at all rather than with an empty panel.
 */
export function agentsFor(depth) {
  const width = Object.hasOwn(WIDTH_FOR, depth) ? WIDTH_FOR[depth] : 0;
  const chosen = AGENT_DEFS.slice(0, width);
  if (chosen.length === 0) return { json: "", width: 0 };
  const payload = {};
  for (const a of chosen) payload[a.name] = { description: a.description, prompt: a.prompt, tools: [...a.tools] };
  return { json: JSON.stringify(payload), width: chosen.length };
}

/**
 * The digest of the panel a run was dispatched with.
 *
 * TAKES THE JSON, not the depth. Hashing from the depth re-derives the payload
 * internally, so the hash describes what the function would build rather than
 * what the worker was handed — and a caller that passed anything else to
 * `--agents` would be recorded under a digest naming different bytes. That is
 * the same class of defect the dispatcher's argv check exists for.
 */
export const agentsHash = (json) => createHash("sha256").update(json ?? "").digest("hex");
