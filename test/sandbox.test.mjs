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
import { sandboxFor, reviewDiff, validateSettings, credentialPaths, CREDENTIAL_PATHS } from "../src/sandbox.mjs";
import { readFileSync } from "node:fs";

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

// ── a repair that changes only the exam ──────────────────────────────────────
//
// SELF_GOVERNING covers .github/**, so a worker cannot rewrite the workflow that
// judges it. Tests judge it exactly as much, and were never covered: a FIX_CI
// worker could have deleted the failing assertion and reeve would have published
// the resulting green. Run 15 measured that this worker does NOT do that -- it
// fixed the source and ADDED two assertions -- but the gate must not rest on the
// worker choosing well.
//
// Tests cannot simply be denied: the prompt REQUIRES a test that fails on the
// broken code, so a repair carrying one is the intended shape.
{
  const profile = { risk: {} };

  // Control: the fixture must be able to pass. This is exactly run 15's diff.
  const real = reviewDiff({ files: ["src/db/ops.mjs", "test/lifecycle.test.mjs"],
                            profile, action: "FIX_CI" });
  check(real.ok, "control: a source fix carrying a new test is published", real.why);

  const only = reviewDiff({ files: ["test/lifecycle.test.mjs"], profile, action: "FIX_CI" });
  check(!only.ok, "a repair whose whole diff is a test is refused", JSON.stringify(only));
  check(/only what judges it/.test(only.why ?? ""),
    "and says why in words a human can act on", only.why);

  const many = reviewDiff({ files: ["test/a.test.mjs", "spec/b_test.py", "src/x/__tests__/c.js"],
                            profile, action: "FIX_CI" });
  check(!many.ok, "several test files are still only tests", JSON.stringify(many));

  // A non-repairing action may legitimately produce a test-only diff.
  const finding = reviewDiff({ files: ["test/lifecycle.test.mjs"], profile, action: "FIX_FINDINGS" });
  check(finding.ok, "a review finding may be that the TEST is wrong, so that is not refused", finding.why);

  // A project whose tests are somewhere else says so in its profile.
  const custom = { risk: { testPaths: ["t/**"] } };
  check(!reviewDiff({ files: ["t/x.js"], profile: custom, action: "FIX_CI" }).ok,
    "a profile can name where its tests live");
  check(reviewDiff({ files: ["test/x.test.mjs"], profile: custom, action: "FIX_CI" }).ok,
    "and naming them replaces the built-in globs rather than adding to them");
}

// The rule above is inert unless the daemon PASSES an action: the parameter
// defaults to null, and null is not a repairing action. A guard that quietly
// stops applying because its input narrowed is the exact shape this codebase has
// been bitten by, so the call site is asserted rather than assumed.
{
  const src = readFileSync(new URL("../src/daemon.mjs", import.meta.url), "utf8");
  const call = (src.match(/reviewDiff\(\{[^}]*\}\)/) ?? [null])[0];

  // Control: prove the matcher found the real call and not an empty string, or
  // the assertion below would be testing nothing.
  check(!!call && /files:/.test(call) && /profile/.test(call),
    "control: found the daemon's actual reviewDiff call site", String(call));

  check(/\baction:/.test(call ?? ""),
    "and it passes an action, without which the test-only rule never runs", String(call));
}

// ── a lane whose territory IS sensitive ──────────────────────────────────────
//
// Measured on the live nextly profile: the release lane's whole territory
// (.changeset/**, scripts/release/**) also sat in risk.sensitivePaths, and the
// lane was dead at BOTH layers -- the tool layer denied the write that would
// have produced the file, and the diff gate refused the file before territory
// was ever consulted. The exemption is explicit and narrow: lane.sensitiveOk,
// honoured only for files inside that lane's own declared territory, and only
// below quarantine and self-governing, which no declaration can reach.
{
  const relProfile = {
    ...profile,
    lanes: [...profile.lanes,
      { id: "release", territory: [".changeset/**", "scripts/release/**"], sensitiveOk: true }],
    risk: { ...profile.risk,
      sensitivePaths: [...profile.risk.sensitivePaths, ".changeset/**", "scripts/release/**"] },
  };
  const release = relProfile.lanes.find(l => l.id === "release");
  const schemaLane = relProfile.lanes.find(l => l.id === "schema");

  const a = reviewDiff({ files: [".changeset/two-cats-dance.md"], profile: relProfile, lane: release });
  check(a.ok === true, "a sensitiveOk lane may change sensitive files INSIDE its territory", JSON.stringify(a));

  const b = reviewDiff({ files: ["packages/x/drizzle/0001.sql"], profile: relProfile, lane: release });
  check(!b.ok && /sensitive/.test(b.why ?? ""),
    "but a sensitive file OUTSIDE its territory still refuses as sensitive", JSON.stringify(b));

  const c = reviewDiff({ files: [".changeset/two-cats-dance.md"], profile: relProfile, lane: schemaLane });
  check(!c.ok && /sensitive/.test(c.why ?? ""),
    "and the exemption grants nothing to a lane that did not declare it", JSON.stringify(c));

  // No declaration reaches above sensitive in the refusal order.
  const gh = { id: "gh", territory: [".github/**"], sensitiveOk: true };
  const d = reviewDiff({ files: [".github/workflows/ci.yml"], profile: relProfile, lane: gh });
  check(!d.ok && /judges/.test(d.why ?? ""), "sensitiveOk cannot reach the self-governing refusal", JSON.stringify(d));

  const q = { id: "q", territory: ["vendor-dumps/**"], sensitiveOk: true };
  const e = reviewDiff({ files: ["vendor-dumps/dump.sql"], profile: relProfile, lane: q });
  check(!e.ok && /quarantin/i.test(e.why ?? ""), "and cannot reach quarantine", JSON.stringify(e));

  // The tool layer must agree with the diff gate, or the worker is denied the
  // write whose result the gate would have accepted. The lift is by VERBATIM
  // glob only -- glob-subset reasoning cannot be done safely here, and the diff
  // gate still checks every actual file afterwards.
  const s = sandboxFor({ profile: relProfile, action: "FIX_FINDINGS", worktree: "/tmp/wt", lane: release });
  const deny = s.settings.permissions.deny.join(" ");
  check(!/\.changeset/.test(deny), "tool layer: the lane's own sensitive territory is writable", deny.slice(0, 200));
  check(/drizzle/.test(deny), "while every other sensitive glob stays denied", "");

  const plain = sandboxFor({ profile: relProfile, action: "FIX_FINDINGS", worktree: "/tmp/wt", lane: schemaLane });
  check(/\.changeset/.test(plain.settings.permissions.deny.join(" ")),
    "and a lane without sensitiveOk keeps every deny", "");
}


// ── the OS sandbox is in the settings, and the settings are validated ─────────
//
// Measured 2026-08-22 (docs/measured/2026-08-22-claude-print-mode.md): the
// sandbox block applies under -p; an invalid settings file is dropped WHOLE,
// silently, exit 0 -- its deny rules included. So the block is emitted for
// every worker and validated before spawn, and the validator is a closed
// allowlist of keys with exact values: a key it does not know is refused,
// because a key it does not know is a key that may weaken the boundary.
const TMP = "/Users/x/.reeve/runs/o-r/1/run1/tmp";
{
  const s = sandboxFor({ profile, action: "FIX_CI", worktree: "/tmp/wt", tmpDir: TMP });
  const sb = s.settings.sandbox;
  check(sb?.enabled === true && sb.failIfUnavailable === true && sb.allowUnsandboxedCommands === false && sb.autoAllowBashIfSandboxed === false,
    "every worker's settings enable the OS sandbox with no unsandboxed fallback and no auto-allow", JSON.stringify(sb));
  check(Array.isArray(sb?.excludedCommands) && sb.excludedCommands.length === 0, "nothing runs outside the sandbox", JSON.stringify(sb?.excludedCommands));
  check(Array.isArray(sb?.network?.allowedDomains) && sb.network.allowedDomains.length === 0, "and deny network by default", JSON.stringify(sb?.network));
  check(sb?.network?.allowLocalBinding === false && sb.network.allowAllUnixSockets === false && sb.network.allowUnixSockets.length === 0 && sb.network.allowMachLookup.length === 0,
    "no local binding, no unix sockets, no extra mach services", JSON.stringify(sb?.network));
  const fs = sb?.filesystem ?? {};
  check(CREDENTIAL_PATHS.every(c => fs.denyRead?.includes(c)) && fs.denyRead.includes("~/.reeve") && fs.denyRead.includes("~/.ssh") && fs.denyRead.includes("~/.config/gh"),
    "credential paths are deny-read at the OS layer", JSON.stringify(fs.denyRead));
  check(JSON.stringify(fs.allowWrite) === JSON.stringify([TMP]) && JSON.stringify(fs.allowRead) === JSON.stringify([TMP]),
    "the run's own tmp is the only write grant beyond cwd, carved back out of the deny-read", JSON.stringify([fs.allowWrite, fs.allowRead]));
  const deny = s.settings.permissions.deny;
  check(CREDENTIAL_PATHS.every(c => deny.includes(`Read(${c}/**)`) || deny.includes(`Read(${c})`)),
    "and the Read tool, which the OS sandbox does not cover, is denied the same paths", deny.filter(d => d.startsWith("Read(")).join(" "));
  const v = validateSettings(s.settings, { tmpDir: TMP });
  check(v.ok === true, "control: generated settings validate", JSON.stringify(v.errors));
  const r = sandboxFor({ profile: { ...profile, builder: { network: { research: { allowedDomains: ["docs.example.com"] } } } },
                         action: "BUILD_RESEARCH", worktree: "/tmp/wt", tmpDir: TMP });
  check(JSON.stringify(r.settings.sandbox.network.allowedDomains) === JSON.stringify(["docs.example.com"]),
    "research may reach the profile's research domains", JSON.stringify(r.settings.sandbox.network.allowedDomains));
  const f = sandboxFor({ profile: { ...profile, builder: { network: { research: { allowedDomains: ["docs.example.com"] } } } },
                         action: "FIX_CI", worktree: "/tmp/wt", tmpDir: TMP });
  check(f.settings.sandbox.network.allowedDomains.length === 0, "and no other action does", JSON.stringify(f.settings.sandbox.network.allowedDomains));
}
{
  const good = () => structuredClone(sandboxFor({ profile, action: "FIX_CI", worktree: "/tmp/wt", tmpDir: TMP }).settings);
  const errs = s => validateSettings(s, { tmpDir: TMP }).errors.join(" | ");
  let b = good(); b.sandbox.allowUnsandboxedCommands = true;
  check(!validateSettings(b, { tmpDir: TMP }).ok && /allowUnsandboxedCommands/.test(errs(b)), "an unsandboxed fallback is refused", errs(b));
  b = good(); b.sandbox.enabled = "yes";
  check(!validateSettings(b, { tmpDir: TMP }).ok && /enabled/.test(errs(b)), "a truthy string is not enabled", errs(b));
  b = good(); b.sandbox.failIfUnavailable = false;
  check(!validateSettings(b, { tmpDir: TMP }).ok && /failIfUnavailable/.test(errs(b)), "a sandbox that may silently be absent is refused", errs(b));
  b = good(); b.sandbox.autoAllowBashIfSandboxed = true;
  check(!validateSettings(b, { tmpDir: TMP }).ok && /autoAllowBashIfSandboxed/.test(errs(b)), "auto-allowing every Bash command is refused", errs(b));
  b = good(); b.sandbox.excludedCommands = ["docker *"];
  check(!validateSettings(b, { tmpDir: TMP }).ok && /excludedCommands/.test(errs(b)), "an excluded command runs unsandboxed, so none is allowed", errs(b));
  b = good(); b.hooks = {};
  check(!validateSettings(b, { tmpDir: TMP }).ok && /hooks/.test(errs(b)), "an unexpected top-level key is refused", errs(b));
  b = good(); b.sandbox.enableWeakerNestedSandbox = true;
  check(!validateSettings(b, { tmpDir: TMP }).ok && /enableWeakerNestedSandbox/.test(errs(b)), "an unknown sandbox key is refused, weakening ones included", errs(b));
  b = good(); b.sandbox.network.allowLocalBinding = true;
  check(!validateSettings(b, { tmpDir: TMP }).ok && /allowLocalBinding/.test(errs(b)), "local binding is refused", errs(b));
  b = good(); b.sandbox.filesystem.allowWrite = [TMP, "/Users/x"];
  check(!validateSettings(b, { tmpDir: TMP }).ok && /allowWrite/.test(errs(b)), "a write grant outside the run's tmp is refused", errs(b));
  b = good(); b.sandbox.filesystem.denyRead = b.sandbox.filesystem.denyRead.filter(x => x !== "~/.ssh");
  check(!validateSettings(b, { tmpDir: TMP }).ok && /denyRead/.test(errs(b)), "a missing credential deny is refused", errs(b));
  b = good(); b.permissions.additionalDirectories = ["/Users/x"];
  check(!validateSettings(b, { tmpDir: TMP }).ok && /additionalDirectories/.test(errs(b)), "an additional directory widens the boundary and is refused", errs(b));
  b = good(); b.permissions.deny = b.permissions.deny.filter(d => !d.startsWith("Read(~/.reeve"));
  check(!validateSettings(b, { tmpDir: TMP }).ok && /Read\(/.test(errs(b)), "a missing Read deny is refused", errs(b));
  b = good(); delete b.sandbox;
  check(!validateSettings(b, { tmpDir: TMP }).ok && /sandbox/.test(errs(b)), "a settings object without the block is refused", errs(b));
  check(validateSettings(null, { tmpDir: TMP }).ok === false, "absent settings are invalid, not empty");
  check(validateSettings(good(), {}).ok === false && /tmpDir/.test(validateSettings(good(), {}).errors.join(" ")),
    "the validator itself refuses to judge without knowing the run's tmp", validateSettings(good(), {}).errors.join(" "));
}


// ── the configured REEVE_HOME state root is denied, not just ~/.reeve ─────────
//
// REEVE_HOME can point the state root elsewhere; a root the sandbox does not
// deny is readable, and a worker could copy the profile or another run's output
// into its worktree for reeve to publish. (Codex #4b-[11].)
{
  const saved = process.env.REEVE_HOME;
  process.env.REEVE_HOME = "/var/lib/reeve-state";
  try {
    check(credentialPaths().includes("/var/lib/reeve-state"), "credentialPaths includes a non-default REEVE_HOME", credentialPaths().join(","));
    const s = sandboxFor({ profile, action: "FIX_CI", worktree: "/tmp/wt", tmpDir: "/tmp/run/tmp" });
    check(s.settings.sandbox.filesystem.denyRead.includes("/var/lib/reeve-state"), "and the OS denyRead denies that root", JSON.stringify(s.settings.sandbox.filesystem.denyRead.slice(-3)));
    check(s.settings.permissions.deny.includes("Read(/var/lib/reeve-state/**)"), "and the Read tool is denied it too", "");
    check(validateSettings(s.settings, { tmpDir: "/tmp/run/tmp" }).ok === true, "and the generated settings still validate", "");
  } finally { if (saved === undefined) delete process.env.REEVE_HOME; else process.env.REEVE_HOME = saved; }
  // Default REEVE_HOME (or unset) adds nothing beyond ~/.reeve.
  const before = process.env.REEVE_HOME; delete process.env.REEVE_HOME;
  try { check(credentialPaths().length === CREDENTIAL_PATHS.length, "an unset REEVE_HOME adds no extra deny", ""); }
  finally { if (before !== undefined) process.env.REEVE_HOME = before; }
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);