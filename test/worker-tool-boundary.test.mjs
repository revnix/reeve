// The tools a worker never gets, and the fact that something enforces it.
//
// reeve's sandbox is built out of SHELL COMMAND rules -- `Bash(curl:*)` and forty
// others. `WebFetch` is not a shell command, so no rule of that shape can reach
// it, and until 2026-08-24 the word did not appear anywhere in `src/` while the
// grant's own docblock said "it cannot reach the network".
//
// It was true. It was true by CONSEQUENCE: a tool that is not on the allow list
// falls through to a permission prompt, and a headless run has nobody to answer
// one. A boundary that holds because of what nobody wrote is one a CLI default can
// move without anything noticing, and this project has already paid for that shape
// twice -- a read deny list that was inert, and a `.git` block imposed beneath
// reeve's own settings.
//
// So: the list is stated, the worker is told, and this asserts all three layers.
import { sandboxFor, NEVER_TOOLS } from "../src/sandbox.mjs";
import { workerArgs } from "../src/supervisor.mjs";
import { promptFor } from "../src/prompts.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const root = mkdtempSync(join(tmpdir(), "reeve-toolbound-"));
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(root, "src", "a.mjs"), "export const a = 1;\n");
writeFileSync(join(root, "package.json"), JSON.stringify({ name: "p", private: true, type: "module" }));
execFileSync("git", ["-C", root, "init", "-q", "-b", "m"]);

const profile = {
  identity: { key: "probe/probe", defaultBranch: "m", visibility: "private" },
  units: [{ id: "root", root: ".", language: "typescript", packageManager: "npm" }],
  risk: { sensitivePaths: [], quarantinePaths: [] },
};
const sb = sandboxFor({ action: "FIX_CI", profile, worktree: root, tmp: join(root, ".tmp"),
                        stateRoots: [], nwo: "probe/probe" });

// --- the capabilities, named rather than assumed ------------------------------
//
// Asserted by CAPABILITY, not by counting the list. A count passes after someone
// deletes an entry and adds two others, which is precisely when it should not.
{
  for (const [capability, tool] of [
    ["network egress", "WebFetch"],
    ["network egress", "WebSearch"],
    ["agent delegation", "Task"],
    ["cross-session reach", "SendMessage"],
    ["work outliving the run", "CronCreate"],
    ["leaving the checkout", "EnterWorktree"],
  ]) check(NEVER_TOOLS.includes(tool), `${tool} is withheld (${capability})`, NEVER_TOOLS.join(","));

  // And the converse: a tool the repair NEEDS must not drift into this list. A
  // worker that cannot read or run is one that reports success on work nothing
  // checked, which is worse than the failure being fixed.
  for (const needed of ["Read", "Edit", "Write", "Bash", "Grep", "Glob"])
    check(!NEVER_TOOLS.includes(needed), `${needed} is NOT withheld — a repair needs it`, "");
}

// --- all three layers carry it ------------------------------------------------
{
  check(typeof sb.disallowedTools === "string" && sb.disallowedTools.length > 0,
    "the sandbox exposes a disallowed-tools list", String(sb.disallowedTools));
  const asFlag = new Set((sb.disallowedTools ?? "").split(","));
  const missingFromFlag = NEVER_TOOLS.filter(t => !asFlag.has(t));
  check(missingFromFlag.length === 0, "every withheld tool reaches the CLI flag", missingFromFlag.join(","));

  const denied = new Set(sb.settings.permissions.deny);
  const missingFromDeny = NEVER_TOOLS.filter(t => !denied.has(t));
  check(missingFromDeny.length === 0, "and is written into the settings file a reader sees",
    missingFromDeny.join(","));

  // Never in the ALLOW list, which would be the one way to have both and mean
  // neither.
  const allowed = new Set([...(sb.settings.permissions.allow ?? []), ...sb.allowedTools.split(",")]);
  const alsoAllowed = NEVER_TOOLS.filter(t => allowed.has(t));
  check(alsoAllowed.length === 0, "and none of them is also granted", alsoAllowed.join(","));
}

// --- the flag actually appears on the command line ----------------------------
{
  const argv = workerArgs({ prompt: "x", settings: "/tmp/s.json",
                            allowedTools: sb.allowedTools, disallowedTools: sb.disallowedTools });
  const i = argv.indexOf("--disallowedTools");
  check(i !== -1, "workerArgs puts --disallowedTools on the command line", argv.join(" ").slice(0, 200));
  check(i !== -1 && argv[i + 1] === sb.disallowedTools,
    "and passes the sandbox's list verbatim", String(argv[i + 1]).slice(0, 120));
  // Control: this parameter existed for weeks with no caller, so the assertion
  // above must be able to fail. Without a value, the flag must be absent.
  const bare = workerArgs({ prompt: "x", settings: "/tmp/s.json", allowedTools: sb.allowedTools });
  check(!bare.includes("--disallowedTools"),
    "control: with no list passed, the flag does not appear", bare.join(" ").slice(0, 120));
}

// --- and the worker is TOLD, so it does not pay turns to find out -------------
{
  const spec = promptFor({ action: "FIX_CI" },
                         { profile, nwo: "probe/probe", pr: 1, head: "abc1234", branch: "b",
                           cause: [{ where: "src/a.mjs", message: "boom" }] });
  const text = typeof spec === "string" ? spec : (spec?.prompt ?? JSON.stringify(spec));
  for (const tool of ["WebFetch", "Task", "SendMessage"])
    check(text.includes(tool), `the prompt names ${tool} as withheld`, "");
  // I removed this assertion as redundant and was wrong: it covers a DIFFERENT
  // property, and deleting it lost real coverage. Naming WebFetch and WebSearch
  // tells the worker two tools are absent. It says nothing about `curl`, `git
  // fetch` or a package installer -- shell-level network, blocked by the OS
  // sandbox, which is the larger share of what a worker would actually reach for
  // and exactly the paid turns this section exists to save.
  //
  // Restored as one word rather than a sentence. "network" survives any rewrite
  // that still warns about the network and fails the deletion or contradiction
  // that matters, which is the line between a property and a phrasing.
  check(/network/i.test(text), "the worker is warned about the network, not only about two tool names",
    "no mention of the network in the worker's rules");
  // The prompt renders FROM the grant. If it were typed out separately the two
  // would drift, which is the defect this file has produced six times.
  const named = NEVER_TOOLS.filter(t => !text.includes(t));
  check(named.length === 0, "every withheld tool is named to the worker", named.join(","));
}

rmSync(root, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
