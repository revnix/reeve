// Worker safety was a PROMPT boundary. The profile declares sensitive paths,
// quarantined paths and forbidden commands, and every one of them was rendered as
// prose into the worker's prompt while the worker itself received
// `Read,Edit,Write,Grep,Glob,Bash` -- a full shell. Asking a model not to do
// something is not a control.
//
// Four things were measured against the installed CLI (2.1.237) before designing
// this, because a sandbox that does not actually deny is worse than none:
//
//   1. `permissions.deny` genuinely blocks in headless -p mode.
//   2. Denying Write/Edit while allowing bare Bash is THEATRE -- asked to write a
//      denied file, the model immediately used `printf > file` and succeeded.
//   3. A SCOPED allowlist contains Bash on its own. Granted only
//      `Bash(git status:*)`, `git status` ran, `git push` was refused, and three
//      separate attempts to write a file through the shell -- `printf >`,
//      `printf > … ; ls`, and `printf | tee` -- were each refused.
//   4. Path-scoped denies work: with the secrets directory denied for Edit, the
//      denied file was untouched while a control file in the same run changed.
//   5. But `deny: ["Bash"]` removes the tool from the session ENTIRELY, scoped
//      grants included. Under it a worker could edit files and never run the
//      tests, never commit, and never verify its own fix -- reporting success on
//      work nothing had checked. This cost a redesign: the first version of this
//      sandbox denied Bash as a class and would have shipped a fixer that could
//      not verify anything.
//
// And a sixth, unprompted: denied twice, the model reached for a THIRD tool that
// was not in the allowlist at all. Any tool that can run a command is a write
// primitive, so this must be a closed allowlist, never a denylist.
import { sandboxFor, reviewDiff } from "../src/sandbox.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const profile = {
  identity: { key: "o/r", defaultBranch: "main" },
  units: [{ id: "root", root: ".", language: "typescript", packageManager: "pnpm",
            commands: { test: { cmd: "pnpm test", state: "present" },
                        lint: { cmd: "pnpm lint", state: "present" } } }],
  lanes: [{ id: "schema", territory: ["packages/nextly/**"] }],
  risk: {
    sensitivePaths: ["packages/*/drizzle/**", ".github/**"],
    quarantinePaths: ["vendor-dumps/**"],
    forbiddenCommands: ["db:migrate:fresh", "npm publish"],
  },
};

const s = sandboxFor({ profile, action: "FIX_CI", worktree: "/tmp/wt" });

// --- the closed set ----------------------------------------------------------
{
  check(typeof s.allowedTools === "string" && s.allowedTools.length > 0,
    "control: a sandbox is produced at all", JSON.stringify(s.allowedTools));
  const tools = s.allowedTools.split(",").map(t => t.trim());
  check(!tools.includes("Bash"),
    "Bash is NEVER granted bare — measured: a bare Bash writes any file with printf",
    JSON.stringify(tools.filter(t => t.startsWith("Bash"))));
  check(tools.some(t => t.startsWith("Bash(")), "but scoped Bash IS granted, or nothing can be verified");
}
{
  // The runtime must be granted, not just the declared command. reeve's own
  // `npm test` is a shell loop over `node <file>`, and the first version of this
  // sandbox granted only `Bash(npm test:*)` -- so on its first real dispatch the
  // worker was denied eleven times trying to run one test, and the run failed.
  const tools = s.allowedTools;
  check(/Bash\(node:\*\)/.test(tools), "a typescript unit's runtime is granted", tools);
  check(/Bash\(ls:\*\)/.test(tools), "and enough to read the workspace — a fixer that cannot list a directory guesses at filenames", tools);
  const py = sandboxFor({ profile: { units: [{ id: "r", language: "python", packageManager: "uv", commands: {} }] },
                          action: "FIX_CI", worktree: "/tmp/wt" });
  check(/Bash\(pytest:\*\)/.test(py.allowedTools), "a python unit gets python's runtime, not node's", py.allowedTools);
  check(!/Bash\(node:\*\)/.test(py.allowedTools), "and only its own", py.allowedTools);
}
{
  // The model reached for a tool nobody offered. Only what is named may run.
  check(!/(^|,)\s*(Task|Agent|WebFetch|WebSearch|Monitor|NotebookEdit)\s*(,|$)/.test(s.allowedTools),
    "no tool outside the intended set is granted", s.allowedTools);
}

// --- the profile's declarations become RULES, not prose ---------------------
const deny = s.settings.permissions.deny.join(" | ");
{
  // Execution is NOT what this restricts, and pretending otherwise was the first
  // version's error: a worker holding Write can write a script and run it through
  // any granted runner, so denying `node -e` bought nothing and only made the
  // failure confusing. What is enforced is authority, network and paths.
  check(!deny.includes("Bash(node -e:*)"),
    "execution is not restricted, because with Write it cannot be",
    JSON.stringify(deny.split(" | ").filter(d => d.includes("node"))));
  check(/Bash\(curl/.test(deny) && /Bash\(git push/.test(deny),
    "but the network and the authority to publish still are");
}
{
  check(/db:migrate:fresh/.test(deny), "a forbidden command is denied", deny);
  check(/npm publish/.test(deny), "every forbidden command is denied, not just the first", deny);
}
{
  check(/vendor-dumps/.test(deny), "quarantined paths are denied");
  check(/drizzle/.test(deny), "sensitive paths are denied");
  // Quarantine is data that must never be SEEN — every verb, reads included.
  for (const verb of ["Read", "Edit", "Write"])
    check(new RegExp(`${verb}\\(\\./vendor-dumps`).test(deny),
      `quarantine is denied for ${verb} — one unguarded verb is the whole hole`, deny);

  // Sensitive paths are the opposite case: a fixer must not CHANGE auth code, a
  // migration or the workflow judging it, but reading them is how it works out
  // what went wrong. Denying the read left a worker unable to see what CI ran,
  // and it spent its turns guessing.
  check(/Write\(\.\/packages\/\*\/drizzle/.test(deny), "a sensitive path is write-denied", deny);
  check(!/Read\(\.\/packages\/\*\/drizzle/.test(deny),
    "but NOT read-denied — understanding a failure requires reading what failed", deny);
  check(!/Read\(\.\/\.github/.test(deny),
    "and the workflow that judges the work is readable, just not writable", deny);
  check(/Write\(\.\/\.github/.test(deny), "it is still write-denied", deny);
}

// --- the authority the worker must never hold -------------------------------
{
  check(/Bash\(git push/.test(deny),
    "the worker may never push: reeve pushes after checking the diff, so the worker cannot both make a change and be the only claim it was allowed");
  check(/gh pr merge/.test(deny), "and may never merge");
}
{
  // Measured, and it cost a redesign: `deny: ["Bash"]` removes the tool from the
  // session entirely, scoped grants included. A worker under it could edit files
  // but never run the tests, never commit, and never verify its own fix -- it
  // would report success on work nothing had checked. The allowlist does the
  // containing; the class deny only breaks the fixer.
  check(!s.settings.permissions.deny.includes("Bash"),
    "Bash is NOT denied as a class, because that removes scoped grants too",
    JSON.stringify(s.settings.permissions.deny.filter(d => d === "Bash")));
  check(s.settings.permissions.allow.some(a => a.startsWith("Bash(")),
    "the scoped grants are what contain it, and they are present",
    JSON.stringify(s.settings.permissions.allow.slice(0, 3)));
}
{
  check(!(s.settings.permissions.additionalDirectories ?? []).length,
    "no directory outside the worktree is added",
    JSON.stringify(s.settings.permissions.additionalDirectories));
}

// --- fail closed --------------------------------------------------------------
{
  // A profile that declares no risk rules is not a profile that has no risk.
  const bare = sandboxFor({ profile: { units: [] }, action: "FIX_CI", worktree: "/tmp/wt" });
  check(!bare.allowedTools.split(",").map(t => t.trim()).includes("Bash"),
    "a profile with no risk section still never gets bare Bash", bare.allowedTools);
  check(/git push/.test(bare.settings.permissions.deny.join(" ")),
    "and still cannot push");
}

// --- the diff gate: territory enforced OUTSIDE the model ---------------------
const lane = { id: "schema", territory: ["packages/nextly/**"] };
{
  const r = reviewDiff({ files: ["packages/nextly/src/a.ts"], profile, lane });
  check(r.ok, "control: a change inside the lane's territory passes", JSON.stringify(r));
}
{
  const r = reviewDiff({ files: ["packages/nextly/src/a.ts", "packages/admin/src/b.ts"], profile, lane });
  check(!r.ok && /territory/i.test(r.why ?? ""), "a change outside the territory refuses", JSON.stringify(r));
}
{
  const r = reviewDiff({ files: ["vendor-dumps/dump.sql"], profile, lane });
  check(!r.ok && /quarantin/i.test(r.why ?? ""), "a quarantined path refuses", JSON.stringify(r));
}
{
  const r = reviewDiff({ files: [".github/workflows/ci.yml"], profile, lane });
  check(!r.ok, "editing the gate that judges the work refuses", JSON.stringify(r));
}
{
  const r = reviewDiff({ files: [], profile, lane });
  check(!r.ok && /no change|empty/i.test(r.why ?? ""),
    "an empty diff refuses rather than pushing nothing as success", JSON.stringify(r));
}
{
  // "could not ask" is not "nothing changed". Both refuse, but only one of them
  // is the worker's fault, and a person reading the log has to be able to tell.
  const r = reviewDiff({ files: null, profile, lane });
  check(!r.ok && /could not read/i.test(r.why ?? ""),
    "an unreadable diff refuses with its own reason, not as an empty one", JSON.stringify(r));
}
{
  // No lane means no territory, and no territory is not "everywhere".
  const r = reviewDiff({ files: ["packages/nextly/src/a.ts"], profile, lane: null });
  check(r.ok, "with no lane, territory is not enforced but the risk rules still are", JSON.stringify(r));
  const q = reviewDiff({ files: ["vendor-dumps/x"], profile, lane: null });
  check(!q.ok, "quarantine still refuses without a lane", JSON.stringify(q));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
