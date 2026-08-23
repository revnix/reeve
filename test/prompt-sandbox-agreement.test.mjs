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
import { promptFor, claimedCommands } from "../src/prompts.mjs";
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

// ---------------------------------------------------------------------------
// Every command the prompt NAMES as runnable must actually be granted.
//
// The fixture above declares pnpm, which is why this went unmeasured until a
// real dispatch found it: rule 0 hardcoded "`pnpm test` is permitted", and the
// only profile ever tested against it also said pnpm, so prose and grant agreed
// by coincidence. A worker on an npm project was told pnpm was permitted, tried
// it, and was refused. That was the sixth measured instance of this shape.
//
// So the profiles below vary the one field that coincidence depended on.
const PROFILES = {
  "pnpm project": { units: [{ id: "root", language: "typescript", packageManager: "pnpm",
                              commands: { test: { cmd: "pnpm test", state: "present" } } }], risk: {} },
  "npm project": { units: [{ id: "root", language: "typescript", packageManager: "npm",
                             commands: { test: { cmd: "npm test", state: "present" } } }], risk: {} },
  "python project": { units: [{ id: "root", language: "python", packageManager: "uv",
                                commands: { test: { cmd: "pytest -q", state: "present" } } }], risk: {} },
  // `javascript` is not a RUNTIMES key, so this worker gets no named runtime at
  // all. The prompt must not invent one for it.
  "unrecognised language": { units: [{ id: "root", language: "javascript", packageManager: "npm",
                                       commands: { test: { cmd: "npm test", state: "present" } } }], risk: {} },
  // Nothing declared: the prompt still has to name only what exists.
  "no units": { units: [], risk: {} },
  // Declared, granted from its own declaration, and DENIED by NEVER. Deny wins,
  // so this must never be offered as the runnable example.
  "a publishing command": { units: [{ id: "root", language: "typescript", packageManager: "npm",
                                      commands: { release: { cmd: "npm publish --access public", state: "present" },
                                                  test: { cmd: "npm test", state: "present" } } }], risk: {} },
  // The profile forbids `git` itself, which the prompt otherwise hardcodes as
  // always available.
  "git forbidden": { units: [{ id: "root", language: "typescript", packageManager: "npm",
                               commands: { test: { cmd: "npm test", state: "present" } } }],
                     risk: { forbiddenCommands: ["git"] } },
  // A declared command of nothing but whitespace. It is truthy, so it passes
  // profile validation, and it trims to an empty head.
  "a blank command": { units: [{ id: "root", language: "typescript", packageManager: "npm",
                                 commands: { lint: { cmd: "   ", state: "present" },
                                             test: { cmd: "npm test", state: "present" } } }], risk: {} },
  // A deny rule LONGER than the head the sandbox grants: `Bash(npm run:*)` is
  // allowed, and `npm run release` is refused, so the head looks clean while the
  // command the worker is told to run is not.
  "a long deny rule": { units: [{ id: "root", language: "typescript", packageManager: "npm",
                                  commands: { release: { cmd: "npm run release", state: "present" },
                                              test: { cmd: "npm test", state: "present" } } }],
                        risk: { forbiddenCommands: ["npm run release"] } },
  // Every declared command refused. The project HAS verification commands; the
  // worker may not run them, which is different from the project having none.
  "all commands denied": { units: [{ id: "root", root: ".", language: "typescript", packageManager: "npm",
                                     commands: { release: { cmd: "npm publish", state: "present" } } }], risk: {} },
  // Nothing runnable at all: no units, and git plus every read-only utility
  // forbidden.
  "nothing runnable": { units: [],
                        risk: { forbiddenCommands: ["git", "ls", "cat", "head", "tail", "wc", "find", "which", "pwd"] } },
  // The profile forbids one of its own language's runners.
  "a forbidden runner": { units: [{ id: "root", language: "typescript", packageManager: "npm",
                                    commands: { test: { cmd: "npm test", state: "present" } } }],
                          risk: { forbiddenCommands: ["npx"] } },
};

for (const [name, prof] of Object.entries(PROFILES)) {
  const perms = sandboxFor({ profile: prof, action: "FIX_CI", worktree: "/tmp/wt", tmpDir: "/tmp/t" })
    .settings.permissions;
  const { allow, deny } = perms;
  // The matcher compares from the START of the command, so a grant is a prefix.
  // DENY beats allow, and reading only the allowlist is how a command could be
  // both declared by the profile and refused by the sandbox: `npm publish` is
  // granted from a unit's own declaration and denied by NEVER.
  const prefixes = list => list.map(a => /^Bash\((.+):\*\)$/.exec(a)?.[1]).filter(Boolean);
  const granted = prefixes(allow);
  const refused = prefixes(deny);
  const matches = (cmd, set) => set.some(g => cmd === g || cmd.startsWith(g + " "));
  const isGranted = cmd => matches(cmd, granted) && !matches(cmd, refused);

  const claimed = claimedCommands(prof);
  // "nothing runnable" is the one profile where an empty list is correct.
  if (name !== "nothing runnable")
    check(claimed.length > 0, `control: ${name} claims at least one command`, JSON.stringify(claimed));
  else
    check(claimed.length === 0, `control: ${name} claims nothing, because nothing survives`, JSON.stringify(claimed));

  for (const cmd of claimed)
    check(isGranted(cmd), `${name}: the prompt names \`${cmd}\`, and the grant carries it`,
          `granted: ${granted.join(", ")}`);

  // And the prose really does contain them, or the check above is measuring a
  // list nobody reads.
  const prompt = promptFor({ action: "FIX_CI", why: "x" },
    { profile: prof, nwo: "o/r", pr: 1, head: "a".repeat(40), attempt: 1,
      cause: { ok: true, job: "CI", step: "t", cause: [{ where: "f", message: "boom" }] } })?.prompt ?? "";
  for (const cmd of claimed)
    check(prompt.includes(`\`${cmd}`), `${name}: \`${cmd}\` appears in the prompt text`,
          prompt.split("\n").filter(l => l.includes("permitted") || l.includes("plain command")).join(" | ").slice(0, 200));

  // The direct property, read off the PROSE rather than off the list that built
  // it: no backticked command in rule 0 may be one the grant does not carry.
  // Without this, a hardcoded example could be reintroduced beside a correct
  // claimedCommands() and both checks above would still pass.
  const rule0 = /^0\.[\s\S]*?(?=\n1\.)/m.exec(prompt.slice(prompt.indexOf("RULES")))?.[0] ?? "";
  check(rule0.length > 200, `control: ${name} rule 0 was extracted`, String(rule0.length));
  // Shapes rule 0 names in order to forbid them. A sentence explaining what is
  // refused is not a claim that it works.
  const REFUSED_BY_DESIGN = ["env", "sh", "for"];
  const mentioned = [...rule0.matchAll(/`([^`]+)`/g)]
    .map(m => m[1].replace(/\s*…\s*$/, "").trim())
    .filter(c => !c.includes("2>&1") && !REFUSED_BY_DESIGN.includes(c));
  if (name !== "nothing runnable")
    check(mentioned.length > 0, `control: ${name} rule 0 names commands at all`, JSON.stringify(mentioned));
  // The verify section is the other place the prompt names commands, and a rule
  // above may forbid one BY NAME while this section prints it as the way to check
  // the work. Measured: a profile forbidding `npm run release` was told never to
  // run it and then handed it as its release command.
  const verify = /HOW TO VERIFY\n([\s\S]*?)\n\n/.exec(prompt)?.[1] ?? "";
  check(!/\bundefined\b/.test(verify), `${name}: the verify section names no undefined root`, verify.slice(0, 140));
  for (const line of verify.split("\n")) {
    const cmd = /^\s{2}\S+\s+(\S.*)$/.exec(line)?.[1];
    if (!cmd) continue;
    check(isGranted(cmd.trim()), `${name}: the verify section offers \`${cmd.trim()}\`, and it is granted`, `granted: ${granted.join(", ")}`);
  }

  // Rule 0 must describe MATCHING, not promise permission: a granted prefix can
  // always have a more specific deny under it, and `git` is the standing example
  // -- `Bash(git:*)` is granted while `git push` is denied.
  check(!/is permitted/.test(rule0), `${name}: rule 0 does not promise that every form of the example is permitted`,
        rule0.split("\n").filter(l => /permitted/.test(l)).join(" | ").slice(0, 160));

  // A profile with nothing else granted still has the interpreter, by absolute
  // path, and must be pointed at it rather than told it has nothing.
  if (name === "nothing runnable") {
    check(prompt.includes(process.execPath), "nothing runnable: the worker is pointed at the interpreter it does have", "");
    check(!/no shell commands granted/.test(prompt), "and is not told it has none", "");
  }

  // Declared-but-refused must not be reported as never declared.
  if (name === "all commands denied") {
    check(/all refused by this sandbox/.test(prompt), "all commands denied: the prompt says the commands exist and are refused",
          verify.slice(0, 160) || prompt.split("HOW TO VERIFY")[1]?.slice(0, 200) || "");
    check(!/declares no verification commands/.test(prompt), "and does not claim the project declares none", "");
  }

  check(!/`undefined|`null/.test(rule0), `${name}: rule 0 never prints a placeholder as a command`,
        rule0.split("\n").filter(l => /undefined|null/.test(l)).join(" | ").slice(0, 160));
  check(!mentioned.some(c => c === ""), `${name}: rule 0 names no EMPTY command`, JSON.stringify(mentioned));
  for (const cmd of mentioned)
    check(isGranted(cmd), `${name}: rule 0 names \`${cmd}\`, and it is granted`,
          `granted: ${granted.join(", ")}`);
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
