// The prompt told the worker to push. The sandbox denied push, by design, because
// reeve publishes after checking the diff — the actor and the only claim the
// action was allowed must not be the same party.
//
// So the worker obeyed, was refused, retried, and the run was marked DENIED: a
// finished fix thrown away because two halves of reeve disagreed about who
// publishes. Five denials in the fifth proof run were exactly this.
//
// A prompt that instructs an action the sandbox forbids is a contradiction the
// worker cannot resolve, and it costs a whole dispatch to discover.
import { promptFor } from "../src/prompts.mjs";
import { sandboxFor } from "../src/sandbox.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const profile = {
  identity: { key: "o/r", defaultBranch: "main" },
  units: [{ id: "root", language: "typescript", packageManager: "pnpm",
            commands: { test: { cmd: "pnpm test", state: "present" } } }],
  risk: { forbiddenCommands: ["db:migrate:fresh"] },
};
const ctx = { profile, nwo: "o/r", pr: 1, head: "a".repeat(40), attempt: 1,
              cause: { ok: true, job: "CI", step: "test", cause: [{ where: "f.ts", message: "boom" }] } };

for (const action of ["FIX_CI", "FIX_FINDINGS"]) {
  const spec = promptFor({ action, why: "x" }, ctx);
  if (!spec) continue;
  const sb = sandboxFor({ profile, action, worktree: "/tmp/wt" });
  const deny = sb.settings.permissions.deny.join(" ");
  const p = spec.prompt;

  check(p.length > 200, `control: ${action} produces a real prompt`, String(p.length));

  // Anything the sandbox refuses outright must not be INSTRUCTED. A line that
  // explains why something is refused is not an instruction to do it, so the
  // check looks for the imperative form rather than for the word.
  const instructions = p.split("\n").filter(l => /^\s*(?:[0-9]+\.|[-*])?\s*(?:then\s+)?(?:push|run|execute|merge)\b/i.test(l.trim()));
  for (const [verb, rule] of [["push", "Bash(git push"], ["merge", "gh pr merge"]]) {
    const told = instructions.some(l => new RegExp(`\\b${verb}\\b`, "i").test(l) && !/do not|never|cannot|not able/i.test(l));
    check(!(told && deny.includes(rule)),
      `${action}: never INSTRUCTED to ${verb}, which the sandbox denies`,
      instructions.filter(l => new RegExp(verb, "i").test(l)).join(" | ").slice(0, 160));
  }

  // The worker must be TOLD it cannot publish, or it will try and be refused --
  // which is what marked a finished fix untrustworthy and threw it away.
  check(/do not push|never push|not able to|reeve does it/i.test(p),
    `${action}: the prompt says explicitly that reeve publishes, not the worker`,
    p.split("\n").filter(l => /push/i.test(l)).join(" | ").slice(0, 200));

  // A forbidden command must appear ONLY in a forbidding sentence, never as a
  // suggested way to verify anything.
  for (const c of profile.risk.forbiddenCommands)
    for (const line of p.split("\n").filter(l => l.includes(c)))
      check(/never|do not|forbidden|irreversible/i.test(line),
        `${action}: "${c}" is only ever mentioned as forbidden`, line.trim());
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
