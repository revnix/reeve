// Flag discipline: a misspelled flag must not be indistinguishable from an
// absent one, and a flag's VALUE must never be read as a repository name.
//
// Both failures were silent and both had already fired. `--home` did not exist,
// so `reeve backup --hub --home /tmp/x` skipped it and operated on the
// operator's real ~/.reeve -- which is how a hub was created there during
// development. And six flags that take values were missing from `VALUED`, whose
// own comment says it exists so "a valued flag consumes the token after it, so
// that token is never mistaken for a repo name however much it looks like one":
// measured, `reeve backup --to some/place` answered
// `no state at <home>/state/some/place.db`.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// `--home` has to reach the profile destination, which is init's to decide.
import { profilePath } from "../src/init.mjs";
// A real hub is what the `--help` side-effect drill needs to observe a write.
import { openHub } from "../src/build/hubdb.mjs";
// R-15 is where the token path becomes an instruction to an operator.
import { checkKeychain } from "../src/doctor.mjs";
import { hubPathFor } from "../src/paths.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "reeve-flags-"));
const run = (...args) => {
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), ...args],
    { encoding: "utf8", env: { ...process.env, REEVE_HOME: join(dir, "envhome") } });
  // stdout and stderr SEPARATELY, additively. `out` is the concatenation every
  // existing assertion here reads; the two halves are needed because one contract
  // asserted below is precisely that the machine shape goes to stdout and the
  // human one to stderr, and a helper that concatenates them cannot see that.
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""),
           stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

// A repository of our own, for the two drills that run `init`.
//
// They used to run in THIS checkout, and that made an otherwise valid build
// fail for reasons unrelated to the parser: a source archive or a clone with no
// `origin` answers `no git remote named origin` before the assertion is
// reached, and a developer who has legitimately created `.ops/profile.json`
// made the side-effect drill fail forever. A fixture removes both -- and it also
// means `init --write` writes into a directory we made, so the drill has a real
// observable side effect that cannot touch anyone's work.
//
// The remote is NAMED but never fetched from: detection reports what it could
// not read (an HTTP 404 for the repo) and carries on, and neither assertion is
// about anything it would have learned.
const repo = join(dir, "fixture-repo");
mkdirSync(repo, { recursive: true });
for (const args of [["init", "-q"],
                    ["remote", "add", "origin", "https://github.com/octo-example/fixture.git"],
                    ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "seed"]])
  spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const runIn = (...args) => {
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), ...args],
    { encoding: "utf8", cwd: repo, env: { ...process.env, REEVE_HOME: join(dir, "envhome") } });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};
check(existsSync(join(repo, ".git")),
  "control: the init fixture is a git repository of our own", repo);

// ── the registry cannot be missing a flag the code reads ────────────────────
// This is the control that matters most. A registry that omits a real flag
// turns `unknown flag` into a refusal of a LEGITIMATE command -- so the fix for
// a silent failure would become a loud one, on commands that used to work.
// Derived from the source rather than a list, because a second list is the thing
// that drifts, which is the defect being fixed here.
{
  const src = readFileSync(join(ROOT, "bin", "reeve"), "utf8");
  const used = new Set([
    ...[...src.matchAll(/\bflag\("([a-z0-9-]+)"\)/g)].map(m => m[1]),
    ...[...src.matchAll(/\bopt\("([a-z0-9-]+)"\)/g)].map(m => m[1]),
  ]);
  const declared = new Set([...src.matchAll(/^\s{2}"?([a-z0-9-]+)"?:\s*\{ value:/gm)].map(m => m[1]));
  const missing = [...used].filter(f => !declared.has(f)).sort();
  check(used.size > 20, "control: the scan found the flags the code reads", `${used.size} names`);
  check(declared.size > 20, "control: and the registry it must agree with", `${declared.size} names`);
  check(missing.length === 0,
    "every flag the code reads is declared, so no working command is refused as unknown",
    missing.map(f => "--" + f).join(", "));
  // And every VALUED flag is one the code actually reads as a value. A stale
  // entry is harmless but it means the list is no longer a description of the
  // program, which is how the two drifted apart in the first place.
  // `all(` too: a repeatable valued flag is read through it, and a scan that
  // did not know that would report `--set` as an entry nothing reads.
  const optNames = new Set([...src.matchAll(/\b(?:opt|all)\("([a-z0-9-]+)"\)/g)].map(m => m[1]));
  const valuedDecl = [...src.matchAll(/^\s{2}"?([a-z0-9-]+)"?:\s*\{ value: true/gm)].map(m => m[1]);
  const stale = valuedDecl.filter(f => !optNames.has(f) && f !== "home").sort();
  check(stale.length <= 2,
    "and the valued set is not accumulating entries nothing reads",
    `unread: ${stale.map(f => "--" + f).join(", ") || "(none)"}`);
}

// ── an unknown flag is refused, by name, with a suggestion ──────────────────
{
  const r = run("backup", "--hub", "--keeep", "3");
  check(r.status !== 0, "a misspelled flag is refused rather than ignored", `status=${r.status}`);
  check(/unknown flag --keeep/.test(r.out), "and the message names it", r.out.slice(0, 160));
  check(/did you mean --keep\?/.test(r.out),
    "and suggests the flag that was meant, which is the whole difference between this and a silent default",
    r.out.slice(0, 160));
  check(/--hub/.test(r.out) && /--keep/.test(r.out),
    "and lists what is accepted, so the operator does not have to read the source", r.out.slice(0, 400));

  // CONTROL: a flag that IS known is not refused. Without this, a fix that
  // refuses everything satisfies every assertion above.
  const ok = run("build", "status");
  check(ok.status === 0 && !/unknown flag/.test(ok.out),
    "control: a command with only known flags still runs", ok.out.slice(0, 120));
  const okFlag = run("builder", "doctor", "--json");
  check(!/unknown flag/.test(okFlag.out),
    "control: and a known boolean flag is accepted", okFlag.out.slice(0, 120));
}

// ── --home is real, not silently ignored ───────────────────────────────────
{
  const home = join(dir, "explicit");
  mkdirSync(join(home, "state"), { recursive: true });
  const r = run("build", "status", "--home", home);
  check(r.status === 0 && /not running/.test(r.out),
    "`--home` scopes the command to that home", r.out.slice(0, 160));
  // The decisive half: it must be THAT home, not the environment's. If the flag
  // were ignored again this would report on `envhome` and pass for the wrong
  // reason, so the assertion is on the path the command names.
  const doc = run("builder", "doctor", "--home", home);
  check(doc.out.includes(home),
    "and the command reports on the home the FLAG named, not the environment's",
    doc.out.slice(0, 240));
}

// ── a valued flag's value is never taken for a repository ──────────────────
// One case per flag that was missing from VALUED. `owner/name` is the shape the
// nwo detector matches, so each of these used to be read as the repo.
{
  for (const f of ["to", "from", "backups", "tail", "keep", "days"]) {
    const r = run("backup", "--" + f, "some/place", "--home", join(dir, "vhome"));
    check(!/some\/place/.test(r.out),
      `\`--${f} some/place\` does not read its own value as the repository name`,
      r.out.slice(0, 200));
  }
  // CONTROL: a real positional IS still read as the repository, so the fix did
  // not simply stop detecting repositories.
  const r = run("backup", "owner/name", "--home", join(dir, "vhome"));
  check(/owner\/name/.test(r.out),
    "control: a genuine positional is still taken as the repository", r.out.slice(0, 200));
}

// ── a valued flag with no value is REFUSED, never defaulted ────────────────
// This is the failure `--home` itself reintroduced. `opt` returned `argv[i+1]`
// with no question asked, so a trailing `--home` yielded `undefined`, `??` sent
// it back to $REEVE_HOME, and the command ran against the very home the
// operator had just typed a flag to avoid. `--home --json` was worse: it ran
// under a relative directory literally called `--json`.
//
// On the broken implementation both of these SUCCEED (status 0) against
// `envhome`, so the status assertions are the discriminator, not decoration.
{
  const trailing = run("build", "status", "--home");
  check(trailing.status !== 0, "a valued flag with no value is refused, not silently defaulted", `status=${trailing.status} ${trailing.out.slice(0, 160)}`);
  check(/--home expects a value/.test(trailing.out), "and the message names the flag and what it wanted", trailing.out.slice(0, 200));

  const eaten = run("build", "status", "--home", "--json");
  check(eaten.status !== 0, "a valued flag followed by another flag is refused rather than eating it", `status=${eaten.status} ${eaten.out.slice(0, 160)}`);
  check(/Got the flag --json/.test(eaten.out), "and the message says which flag it found where a value belonged", eaten.out.slice(0, 200));

  // `--home=/dir` is refused too, but by explaining the syntax rather than
  // claiming the flag does not exist -- which is what `unknown flag --home=/x`
  // told an operator who had spelled `--home` perfectly.
  const eq = run("build", "status", "--home=" + join(dir, "eqhome"));
  check(eq.status !== 0 && /--home takes its value as the next argument/.test(eq.out),
    "`--flag=value` is refused by explaining the syntax, not by denying the flag", eq.out.slice(0, 200));

  // A NUMBER is a value, not a flag: no flag begins with a digit, so there is
  // nothing to protect against. Refusing every token that starts with `-` took
  // `--keep -1` away from `--keep`'s own validator and replaced "must be a
  // positive whole number" with "Got the flag -1" -- a worse message for the
  // same refusal. That message is asserted in test/hub-doctor.test.mjs; the
  // assertion here is that the parser hands the token over at all.
  const neg = run("backup", "--hub", "--keep", "-1", "--home", join(dir, "neghome"));
  check(!/Got the flag -1/.test(neg.out),
    "a negative number is a value, so the flag's own validator is the one that answers it",
    neg.out.slice(0, 200));

  // CONTROL: a valued flag WITH a value still works. Without this, refusing
  // every valued flag satisfies all four assertions above.
  const good = join(dir, "valuehome");
  mkdirSync(join(good, "state"), { recursive: true });
  const ok = run("build", "status", "--home", good);
  check(ok.status === 0 && !/expects a value/.test(ok.out),
    "control: a valued flag with a value is accepted", ok.out.slice(0, 160));
}

// ── single-dash flags are refused, not swallowed as positionals ────────────
// The old scan matched `--` tokens only, so `-w` was never examined at all: it
// fell through to the positionals and the command ran as though the flag had
// not been typed. That is the same silence as an ignored `--home`, one syntax
// over.
{
  // `build status`, not `init`: measured, plain `reeve init` exits 1 on its own
  // because it has unanswered questions, so `init -w` would have satisfied
  // "status !== 0" on the BROKEN implementation too -- a green for a different
  // reason. `build status` exits 0 in an empty home, so the status here is
  // about the refusal and nothing else.
  const w = run("build", "status", "-w");
  check(w.status !== 0, "a single-dash flag is refused rather than read as a positional", `status=${w.status} ${w.out.slice(0, 160)}`);
  check(/unknown flag -w/.test(w.out) && /no single-dash flags/.test(w.out),
    "and the message says both which token and why", w.out.slice(0, 200));
  // A suggestion that is not one is worse than none: `-w` was answered "did you
  // mean --db?", an edit distance of 2 that is the whole length of both names.
  check(!/did you mean/.test(w.out),
    "and it does not suggest a flag that shares nothing with what was typed", w.out.slice(0, 200));

  const f = run("backup", "--hub", "-f");
  check(f.status !== 0 && /unknown flag -f/.test(f.out),
    "a single-dash flag is refused even beside a valid one", f.out.slice(0, 200));

  for (const t of ["-", "--"]) {
    const r = run("backup", t);
    check(r.status !== 0 && /is not a flag or a repository/.test(r.out),
      `\`${t}\` is refused rather than taken for a repository name`, r.out.slice(0, 160));
  }

  // CONTROL: the double-dash spelling of the same intent is accepted.
  const ok = run("backup", "--hub", "--force", "--home", join(dir, "shorthome"));
  check(!/unknown flag/.test(ok.out), "control: the `--force` it was reaching for is still accepted", ok.out.slice(0, 160));
}

// ── --help describes a command, it does not run it ─────────────────────────
// `help` was in the registry, described as "show this help", and NO route
// checked it. `reeve restore --hub --help` therefore selected the newest
// snapshot and performed the restore.
//
// The discriminator is restore's own message: on the broken implementation the
// output is `reeve restore --hub: no usable snapshot under ...` (measured), and
// the control below proves that message is still reachable. What this does NOT
// prove is that no write occurred -- an empty home has no snapshot to restore.
// The observable-side-effect half is `init --write --help` in the home test.
{
  const h = run("restore", "--hub", "--help");
  check(h.status === 0, "`--help` on a mutating route exits 0", `status=${h.status}`);
  check(/doctor \[owner\/repo\]/.test(h.out) && /not yet built/.test(h.out),
    "and prints the usage", h.out.slice(0, 120));
  check(!/no usable snapshot/.test(h.out),
    "and the restore route never ran", h.out.slice(0, 240));

  // CONTROL: without `--help` the route IS reached, so the assertion above is
  // about `--help` rather than about restore being unreachable in this home.
  const bare = run("restore", "--hub");
  check(/no usable snapshot/.test(bare.out),
    "control: the same command without `--help` does reach the restore route", bare.out.slice(0, 240));

  // A leading `--help` is not a command name. `argv.shift()` took the first
  // token whatever it was, so `reeve --help` consumed `--help` AS the command,
  // saw no flags, fell through to the default and exited 1.
  const bareHelp = run("--help");
  check(bareHelp.status === 0 && /doctor \[owner\/repo\]/.test(bareHelp.out),
    "`reeve --help` with no command prints the usage and exits 0", `status=${bareHelp.status}`);

  // AND A LEADING GLOBAL FLAG DOES NOT SWALLOW THE COMMAND. The first repair
  // for the line above treated any leading flag as "no command", so
  // `reeve --home /x backup --hub` left `backup` in the positionals, fell
  // through to the default, printed the help and exited ZERO -- a backup that
  // never ran, reporting success. The status is the discriminator: on that
  // implementation this passes with 0 and no backup.
  const leadHome = join(dir, "lead-home");
  mkdirSync(join(leadHome, "state"), { recursive: true });
  const lead = run("--home", leadHome, "backup", "--hub");
  const trail = run("backup", "--hub", "--home", leadHome);
  check(!/doctor \[owner\/repo\]/.test(lead.out),
    "a global flag BEFORE the command does not turn the command into a positional",
    lead.out.slice(0, 200));
  check(lead.status === trail.status && lead.out === trail.out,
    "and the command behaves identically whichever side the flag is on",
    `lead(${lead.status}) ${lead.out.slice(0, 90)} | trail(${trail.status}) ${trail.out.slice(0, 90)}`);
  // CONTROL: that pair is only meaningful if the command actually ran and said
  // something of its own.
  check(/there is no hub database/.test(trail.out),
    "control: and the command really reached its route", trail.out.slice(0, 200));

  // `reeve --home /x` with NO command is still just the help, and still 0.
  const flagOnly = run("--home", leadHome);
  check(flagOnly.status === 0 && /doctor \[owner\/repo\]/.test(flagOnly.out),
    "a global flag with no command prints the usage, like the bare command",
    `status=${flagOnly.status}`);
}

// ── the help describes THIS CLI, in both directions ────────────────────────
// `export-events`, `shadow`, `builder` and `build` were all shipped and none of
// them appeared in the only help reeve had -- so `--help` would have documented
// a CLI that no longer existed. Derived from the switch rather than a list,
// because a second list is what drifts.
{
  const src = readFileSync(join(ROOT, "bin", "reeve"), "utf8");
  const cases = [...src.matchAll(/^  case "([a-z-]+)":/gm)].map(m => m[1]);
  const helpText = run("--help").out;
  check(cases.length >= 12, "control: the scan found the switch's commands", `${cases.length}: ${cases.join(" ")}`);
  check(/doctor \[owner\/repo\]/.test(helpText), "control: and the help text was read", helpText.slice(0, 60));
  const undocumented = cases.filter(c => !new RegExp(`(^|[\\s\`-])${c}([\\s\`]|$)`, "m").test(helpText)).sort();
  check(undocumented.length === 0,
    "every command the switch accepts is named in the help",
    undocumented.join(", "));
}

// ── one parse, not five ────────────────────────────────────────────────────
// Four readers of `argv` disagreed, and two of the disagreements were the
// defects above. A fifth reader is how the next one arrives, so a route that
// indexes `process.argv` directly is refused here rather than in review.
{
  const src = readFileSync(join(ROOT, "bin", "reeve"), "utf8");
  const stripped = src.split("\n").filter(l => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  const indexed = [...stripped.matchAll(/process\.argv\[\d+\]/g)].map(m => m[0]);
  check(indexed.length === 0,
    "no route reads process.argv by index; subcommands come from the one parse",
    indexed.join(", "));
  check(/process\.argv\.slice\(2\)/.test(stripped),
    "control: the scan can see process.argv where it legitimately appears", "");
}

// ── a repeatable valued flag keeps every occurrence ────────────────────────
// `--set` used to be read by its own walk over argv, which collected all of
// them; `opt` returns only the first. Reading it through the one parse had to
// keep the list, so the SECOND `--set` is the one asserted: measured in the
// fixture, answering only `authority.policy` leaves `project.kind` unanswered,
// so if the second occurrence were dropped this would still be asking for it.
{
  const one = runIn("init", "--set", "authority.policy=propose_only");
  check(/answer:\s+--set project\.kind/.test(one.out),
    "control: with one answer given, init is still asking for the other",
    one.out.slice(0, 300));
  const two = runIn("init", "--set", "authority.policy=propose_only", "--set", "project.kind=product");
  check(!/NEEDS AN ANSWER/.test(two.out),
    "the SECOND --set is applied too, so a repeatable flag keeps every occurrence",
    two.out.slice(0, 400));
  check(/^PLAN /m.test(two.out),
    "control: and with both answered it produces a plan, so the check above is not passing on an early exit",
    two.out.split("\n").find(l => l.startsWith("PLAN")) ?? two.out.slice(0, 200));
}

// ── the write-back is what makes --home reach anything at all ──────────────
// The mechanism is one line in `bin/reeve`: the resolved home is written back
// into `process.env.REEVE_HOME` before any route runs. Removing it leaves
// `--home` changing bin/reeve's own constant and NOTHING else -- which is the
// original defect exactly -- and the rest of this file did not notice: measured,
// stubbing that line out produced zero failures across every assertion above.
//
// So the assertion is on a value a MODULE resolved, not on one bin/reeve held:
// `doctor` reports `resolveHome()`, which equals the flag's home only if the
// write-back happened. The environment is deliberately set to a DIFFERENT home,
// so a fallback to it is a visible wrong answer rather than an invisible one.
{
  const custom = join(dir, "writeback-home");
  mkdirSync(join(custom, "state"), { recursive: true });
  const r = run("doctor", "revnix/reeve", "--home", custom, "--json");
  let reported = null;
  try { reported = JSON.parse(r.out.slice(r.out.indexOf("{"))).home; } catch { /* reported below */ }
  check(reported !== null, "control: doctor --json parsed", r.out.slice(0, 200));
  check(reported === custom,
    "a module asked for the home gets the one --home named, not the environment's",
    `reported ${reported}, expected ${custom}`);
  // CONTROL: with no flag it IS the environment's, so the assertion above is
  // about the flag rather than about `custom` appearing by some other route.
  const env = run("doctor", "revnix/reeve", "--json");
  let envHome = null;
  try { envHome = JSON.parse(env.out.slice(env.out.indexOf("{"))).home; } catch { /* reported below */ }
  check(envHome === join(dir, "envhome"),
    "control: and with no flag it is the environment's home", `reported ${envHome}`);
}

// ── a home set after import is honoured, so nothing captured it eagerly ────
// This is the half the structural scan cannot see. `CRED_DIR` was a
// module-level constant: rewriting it to read the home would still have been
// evaluated at import, which is BEFORE `bin/reeve` resolves `--home`.
{
  const probe = join(dir, "late-home");
  const script = `
    const s = await import(${JSON.stringify(pathToFileURL(join(ROOT, "src", "sandbox.mjs")).href)});
    const a = await import(${JSON.stringify(pathToFileURL(join(ROOT, "src", "github", "app.mjs")).href)});
    const w = await import(${JSON.stringify(pathToFileURL(join(ROOT, "src", "workerenv.mjs")).href)});
    process.env.REEVE_HOME = ${JSON.stringify(probe)};          // AFTER every import
    console.log(JSON.stringify({
      denied: s.credentialPaths().includes(${JSON.stringify(probe)}),
      creds:  a.loadAppCredentials("nope").why,
      token:  w.readOauthToken().why,
    }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  let seen = null;
  try { seen = JSON.parse((r.stdout ?? "").trim().split("\n").pop()); } catch { /* reported below */ }
  check(seen !== null, "control: the late-home probe ran", (r.stderr ?? "").slice(0, 240));
  check(seen?.denied === true,
    "a home set after import still reaches the sandbox's deny list", JSON.stringify(seen));
  check(typeof seen?.creds === "string" && seen.creds.includes(probe),
    "and the App credentials, which were a module-level constant", seen?.creds);
  check(typeof seen?.token === "string" && seen.token.includes(probe),
    "and the worker's token path", seen?.token);
}

// ── --home reaches init's sidecar profiles ─────────────────────────────────
// `profilePath` selected `~/.reeve/profiles` unconditionally -- it read neither
// the flag nor REEVE_HOME -- so `reeve init --home /custom --write` could
// overwrite the operator's real profile while the caller believed the run was
// isolated. There IS a real profile at ~/.reeve/profiles/revnix/reeve.json, so
// this was not hypothetical.
//
// NOT covered end to end: this repository detects as `committed`, so no CLI
// invocation here takes the sidecar branch. The assertion is on profilePath and
// on the route passing `home` down; the sidecar write itself is unexercised.
{
  const custom = join(dir, "sidecar-home");
  check(profilePath("o/r", "sidecar", custom) === join(custom, "profiles", "o/r.json"),
    "an explicit home decides where a sidecar profile goes",
    profilePath("o/r", "sidecar", custom));
  const saved = process.env.REEVE_HOME;
  process.env.REEVE_HOME = custom;
  check(profilePath("o/r", "sidecar") === join(custom, "profiles", "o/r.json"),
    "and REEVE_HOME does too, which it also never did", profilePath("o/r", "sidecar"));
  process.env.REEVE_HOME = saved;
  // CONTROL: the committed branch is about the REPO, not the home, and must not
  // have moved.
  check(profilePath("o/r", "committed", custom) === join(process.cwd(), ".ops", "profile.json"),
    "control: a committed profile still belongs to the repository", profilePath("o/r", "committed", custom));
  // And the route hands it over, rather than relying on the ambient variable.
  check(/init\(\{ root: process\.cwd\(\), answers, write: flag\("write"\), home: HOME \}\)/
    .test(readFileSync(join(ROOT, "bin", "reeve"), "utf8")),
    "and the init route passes the resolved home explicitly", "");
}

// ── --help does not run a MUTATING route, observed by its side effect ──────
// The output test earlier shows restore's message is absent. This one is a
// FILE: `export-events --hub <path>` writes one, so on the broken
// implementation the path exists afterwards and on the fixed one it does not.
//
// `export-events`, not `init --write`. The init drill ran in THIS checkout,
// which made a developer's legitimate `.ops/profile.json` a permanent test
// failure -- and moving it to a fixture only traded that for a refusal about
// `merge.method`, which a fixture's history cannot supply. A control that
// cannot perform the write proves nothing about `--help` having stopped one.
// This route needs only a hub, which the test can make.
{
  const eHome = join(dir, "helpdrill-home");
  mkdirSync(join(eHome, "state"), { recursive: true });
  openHub(hubPathFor(eHome)).close();
  const runH = (...args) => {
    const r = spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), ...args],
      { encoding: "utf8", env: { ...process.env, REEVE_HOME: eHome } });
    return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  };
  const out1 = join(eHome, "helped.jsonl");
  const helped = runH("export-events", "--hub", out1, "--help");
  check(!existsSync(out1), "`--help` on a route that writes a file writes nothing", out1);
  check(helped.status === 0 && /not yet built/.test(helped.out),
    "and prints the usage instead", helped.out.slice(0, 120));

  // CONTROL: the same command without `--help` DOES write it, so the assertion
  // above is about `--help` and not about the route being unable to run here.
  const out2 = join(eHome, "real.jsonl");
  const real = runH("export-events", "--hub", out2);
  check(real.status === 0 && existsSync(out2),
    "control: without --help the same command writes the file",
    `status=${real.status} ${real.out.slice(0, 160)}`);
}

// ── an EMPTY value is a missing value ──────────────────────────────────────
// `reeve restore --hub --home "$SCRATCH"` with the variable unset hands over
// `""`, and `resolve("")` is the CURRENT DIRECTORY -- so a command explicitly
// told to use another home would have backed up, built or restored against
// `<cwd>/state`. An operator who names a home and gets nothing has said
// something, and it is not "use wherever I happen to be standing".
{
  const empty = run("build", "status", "--home", "");
  check(empty.status !== 0, "an empty valued flag is refused", `status=${empty.status} ${empty.out.slice(0, 160)}`);
  check(/--home expects a value/.test(empty.out),
    "and refused the same way a missing one is, because it is one", empty.out.slice(0, 200));
  // The decisive half: it must not have resolved to the working directory. On
  // the broken implementation this succeeds and reports on `<cwd>/state`.
  check(!/not running/.test(empty.out),
    "and the command did not run against the current directory", empty.out.slice(0, 200));
}

// ── a boolean flag is never recommended a value ────────────────────────────
// `--flag=value` was answered "takes its value as the next argument" for EVERY
// known flag, so `--force=false` got `write --force false` -- which turns force
// ON and leaves `false` as an unused positional. The operator was asking for the
// opposite, and on `restore` that flag waives the live-daemon safety refusal.
{
  const b = run("restore", "--hub", "--force=false");
  check(b.status !== 0, "a boolean written with a value is refused", `status=${b.status}`);
  check(/--force is a switch and takes no value/.test(b.out),
    "and told that it is a switch", b.out.slice(0, 200));
  check(!/write --force false/.test(b.out) && !/--force false/.test(b.out),
    "and NOT handed a command that turns on the thing they asked to turn off", b.out.slice(0, 240));
  check(/--force=false does not turn it off/.test(b.out),
    "and told plainly that `=false` is not how it is turned off", b.out.slice(0, 240));

  // CONTROL: a VALUED flag written the same way still gets the advice that is
  // correct for it, so the fix did not simply delete the helpful message.
  const v = run("build", "status", "--home=" + join(dir, "eqhome2"));
  check(/--home takes its value as the next argument/.test(v.out),
    "control: a valued flag written with = is still shown the form that works", v.out.slice(0, 200));
}

// ── the token remediation names the path that was checked ──────────────────
// `readOauthToken`'s default follows the resolved home now, so R-15 looks under
// a custom home while the instruction still said `~/.reeve/claude-token`. An
// operator could follow it exactly and stay degraded, with every `--execute`
// dispatch unable to authenticate.
{
  const tokenHome = join(dir, "token-home");
  mkdirSync(tokenHome, { recursive: true });
  const r = checkKeychain({ probe: () => ({ measured: true, items: [], why: null }),
                            isolation: "scratch-home", topologyReady: () => true,
                            token: () => ({ ok: false, path: join(tokenHome, "claude-token"),
                                            why: `${join(tokenHome, "claude-token")} could not be read (ENOENT)` }) });
  const advice = r.lines[r.lines.length - 1];
  check(advice.includes(join(tokenHome, "claude-token")),
    "the remediation names the file the check actually looked at", advice);
  check(!/~\/\.reeve\/claude-token/.test(advice),
    "and not the default one, which is where it used to send everybody", advice);
  // CONTROL: the reported reason still names it too, so the two halves agree.
  check(r.lines.some(l => l.includes(join(tokenHome, "claude-token")) && /could not be read/.test(l)),
    "control: and the diagnosis and the remediation name the same file", r.lines.join(" | ").slice(0, 200));
}

// ── Every flag the task route reads is REGISTERED ────────────────────────────
//
// An unregistered flag is not ignored by this CLI, it is refused -- so a route
// that reads `opt("title")` for a flag absent from FLAGS can never be given one,
// and the failure is a did-you-mean suggestion that never names the route.
{
  const valued = ["project", "title", "territory", "territory-file", "body-file",
                  "depth", "priority", "idempotency-key", "pin-territory"];
  for (const f of valued) {
    const r = run("task", "file", `--${f}`);
    check(/expects a value/.test(r.out) && !/unknown flag/.test(r.out),
      `--${f} is registered and takes a value`, r.out.split("\n")[0]);
  }
  for (const f of ["anyway", "dry-run"]) {
    const r = run("task", "file", `--${f}=yes`);
    check(/is a switch and takes no value/.test(r.out) && !/unknown flag/.test(r.out),
      `--${f} is registered as a switch`, r.out.split("\n")[0]);
  }
  // CONTROL: the refusal machinery still refuses something that really is
  // unknown, so the assertions above are not passing on a widened parser.
  const bad = run("task", "file", "--terrritory", "packages/x");
  check(/unknown flag --terrritory/.test(bad.out),
    "control: a misspelled flag is still refused", bad.out.split("\n")[0]);
  check(/did you mean --territory/.test(bad.out),
    "and the suggestion now reaches the new flag", bad.out.split("\n")[0]);
}

// ── `--dry-run` is scoped to the commands that implement it ─────────────────
//
// Every flag in this CLI's table is accepted by every command, so a flag whose
// entire promise is "write nothing" was parsed cleanly by `restore` -- which
// never reads it and restores for real. Refusing is the only safe direction: a
// command that accepts the flag and writes anyway is worse than one that never
// took it.
{
  const r = run("restore", "--dry-run", "--from", "/nonexistent");
  check(/--dry-run is not implemented by/.test(r.out),
    "a destructive command REFUSES --dry-run rather than ignoring it", r.out.split("\n")[0]);
  check(/restore/.test(r.out), "and names the command that cannot honour it", r.out.split("\n")[0]);
  check(!/unknown flag/.test(r.out),
    "and it is a scope refusal, not the parser failing to know the flag", r.out.split("\n")[0]);

  // CONTROL: the command that DOES implement it still gets through, so the
  // refusal above is about scope rather than about the flag being disabled.
  const t = run("task", "--dry-run");
  check(/reeve task:/.test(t.out) && !/--dry-run is not implemented/.test(t.out),
    "control: the command that implements it still reaches its own body", t.out.split("\n")[0]);

  // AND IT IS THE SAME GATE that refuses an inapplicable `--json`. Two allow-lists
  // for one rule agree right up until a third flag has to choose which of them to
  // copy, so the scoping this file already proved for `--dry-run` is asserted here
  // to be the SAME mechanism rather than a parallel one.
  const { APPLIES } = await import("../bin/reeve.flags.mjs");
  check(Array.isArray(APPLIES["dry-run"]) && APPLIES["dry-run"].includes("task file"),
    "--dry-run is scoped by the same map as --json, not by a second allow-list",
    JSON.stringify(APPLIES));
  const BIN2 = readFileSync(new URL("../bin/reeve", import.meta.url), "utf8");
  check(!/DRY_RUN_COMMANDS/.test(BIN2),
    "and the allow-list it used to have its own copy of is gone",
    (BIN2.match(/.*DRY_RUN_COMMANDS.*/) ?? [""])[0]);
  check(/\binapplicable\(\s*cmd\b/.test(BIN2),
    "counter-control: the extraction can find the gate that replaced it, so the absence above is real",
    (BIN2.match(/.*inapplicable\(cmd.*/) ?? [""])[0]);
}

// ── A bare `-` is a value, not a flag ───────────────────────────────────────
//
// `--body-file -` is documented and is the universal stdin sentinel, but every
// token beginning with `-` was classified as a flag, so the parser refused the
// documented form before any route could read stdin.
{
  const r = run("task", "file", "--body-file", "-");
  check(!/expects a value/.test(r.out),
    "--body-file - is accepted as a value rather than refused as a flag", r.out.split("\n")[0]);
  check(!/Got the flag -/.test(r.out), "and is not reported as a flag", r.out.split("\n")[0]);

  // CONTROL: a real flag in a value position is STILL refused, so the change
  // admits exactly `-` rather than widening the parser.
  const bad = run("task", "file", "--title", "--territory");
  check(/expects a value/.test(bad.out),
    "control: a real flag in a value position is still refused", bad.out.split("\n")[0]);
  const neg = run("task", "file", "--title", "-x");
  check(/expects a value/.test(neg.out),
    "control: and so is a token that merely starts with a dash", neg.out.split("\n")[0]);
}

// ── An empty --territory is the repository root, and must be typeable ───────
//
// `normalizeClaim` supports the root claim deliberately, and the territory-file
// refusal tells the founder to write it as `--territory ""` -- advice the parser
// then refused, so the recommended remedy could not be typed at all.
{
  const r = run("task", "file", "--project", "p", "--title", "t", "--territory", "");
  check(!/--territory expects a value/.test(r.out),
    "--territory \"\" is accepted, because an empty claim is the repository root",
    r.out.split("\n")[0]);

  // CONTROLS: the allowance is for that flag alone. Everywhere else an empty
  // value is still a missing one -- `--home ""` resolves to the CURRENT
  // directory, which is how a command explicitly told to use another home
  // silently used this one.
  const h = run("--home", "", "task");
  check(/--home expects a value/.test(h.out),
    "control: an empty --home is still refused", h.out.split("\n")[0]);
  const t = run("task", "file", "--title", "");
  check(/--title expects a value/.test(t.out),
    "control: and so is an empty --title", t.out.split("\n")[0]);
}


// ── a flag that cannot apply is refused, not silently ignored ────────────────
//
// A flag a command accepts and cannot act on is indistinguishable from a flag
// that does not exist. Measured before this change: nine read commands accepted
// --json, three honoured it, and for the other six the output was byte-identical
// with the flag and without it. The parser already refuses UNKNOWN flags; this is
// the missing second layer -- known, but not applicable here.
{
  const BIN = readFileSync(new URL("../bin/reeve", import.meta.url), "utf8");

  // The denominator is DERIVED from the route table, not written out by hand: a
  // hand-built list returns the commands the author thought of, and nothing in
  // the output says it is partial.
  const ROUTES = [...BIN.matchAll(/^  case "([a-z-]+)":/gm)].map(m => m[1]);
  check(ROUTES.length >= 12, `control: the route table yields ${ROUTES.length} cases`, ROUTES.join(","));
  check(ROUTES.includes("doctor") && ROUTES.includes("why"),
    "control: the extraction finds two routes known by name to exist", ROUTES.join(","));

  const { APPLIES } = await import("../bin/reeve.flags.mjs");
  check(Array.isArray(APPLIES.json) && APPLIES.json.length > 0,
    "APPLIES declares which commands --json can change", JSON.stringify(APPLIES.json));
  const unknown = APPLIES.json.filter(c => !ROUTES.includes(c));
  check(unknown.length === 0,
    "every command APPLIES.json names is a real route", `not routes: ${unknown.join(",")}`);
  check(Object.isFrozen(APPLIES) && Object.isFrozen(APPLIES.json),
    "and the map cannot be widened at runtime");

  // The refusal, on a command that provably ignored the flag before.
  const r = run("why", "1", "o/r", "--json");
  check(r.status === 2, "reeve why --json is refused rather than silently ignored",
    `rc=${r.status} ${r.out.slice(0, 200)}`);
  check(/--json/.test(r.out) && /why/.test(r.out),
    "and says which flag and which command", r.out.slice(0, 240));
  check(/commands that implement it/.test(r.out) && /doctor/.test(r.out),
    "and names the commands that do implement it, so the operator is not left guessing",
    r.out.slice(0, 240));

  // CONTROL: a command that DOES honour it is untouched, or the change is a ban
  // rather than a contract.
  const ok = run("doctor", "revnix/reeve", "--json");
  let parsed = null; try { parsed = JSON.parse(ok.stdout); } catch { /* stays null */ }
  check(parsed !== null, "control: doctor --json still parses", ok.stdout.slice(0, 200));

  // CONTROL: an unknown flag is still refused by the FIRST layer, with its own
  // message. If this goes quiet, the new layer has swallowed the old one.
  const bad = run("why", "1", "o/r", "--nonsense");
  check(/unknown flag --nonsense/.test(bad.out),
    "control: an unknown flag is still refused by the parser, not by APPLIES", bad.out.slice(0, 200));

  // CONTROL: --help still describes a command whatever else was typed beside it.
  // The applicability layer sits BELOW it deliberately: a flag that asks a command
  // to describe itself must not be answerable with a refusal about another flag.
  const helped = run("why", "--json", "--help");
  check(helped.status === 0 && /doctor \[owner\/repo\]/.test(helped.out),
    "control: --help still wins over an inapplicable flag", helped.out.slice(0, 200));
}

// ── every refusal names a kind, an exit code, and whether retrying can help ──
//
// An exit code with no declaration is three routes agreeing by accident. `3`
// meant degraded in `doctor`, in `shadow` and in `builder doctor`, and the only
// statement of what it meant was the usage text -- while the comment that cited a
// line number for it cited the argv parser.
{
  const { EXITS, ERROR_KINDS } = await import("../bin/reeve.flags.mjs");
  check(EXITS.ok === 0 && EXITS.refused === 1 && EXITS.misuse === 2 && EXITS.degraded === 3,
    "the four exit codes have one declaration", JSON.stringify(EXITS));
  check(new Set(Object.values(EXITS)).size === Object.keys(EXITS).length,
    "and no two names share a code", JSON.stringify(EXITS));
  check(ERROR_KINDS.length > 0 && ERROR_KINDS.every(k => /^[a-z][a-z0-9_]*$/.test(k)),
    "every error kind is snake_case", ERROR_KINDS.join(","));
  check(new Set(ERROR_KINDS).size === ERROR_KINDS.length,
    "and the list has no duplicate", ERROR_KINDS.join(","));

  // Every kind the source passes to fail() is in the closed list, and every kind
  // in the list is one the source can emit. BOTH directions: a vocabulary padded
  // with kinds nothing produces reads as coverage and is not.
  const BIN = readFileSync(new URL("../bin/reeve", import.meta.url), "utf8");
  const CALL = /\bfail\(\s*"([a-z0-9_]+)"/g;
  const used = [...BIN.matchAll(CALL)].map(m => m[1]);
  check(used.length > 0, `control: the extraction finds ${used.length} fail() call sites`, used.join(","));

  // Paired with a LITERAL counter-control, because a regex over source text that
  // stops matching after a rename reports PASS while guarding nothing. This one
  // reads a string it has never seen, so it stays green whatever the source says
  // -- which is how "the source has no violations" is told apart from "the check
  // can no longer see one". They are different facts.
  const FIXTURE = 'fail("some_new_kind", "x");\nfail("flag_not_applicable", "y");';
  const fromFixture = [...FIXTURE.matchAll(new RegExp(CALL.source, "g"))].map(m => m[1]);
  check(fromFixture.length === 2 && fromFixture.includes("some_new_kind"),
    "counter-control: the extraction still finds a kind in a literal it has never seen",
    fromFixture.join(","));

  const undeclared = [...new Set(used)].filter(k => !ERROR_KINDS.includes(k));
  check(undeclared.length === 0, "every kind passed to fail() is declared", undeclared.join(","));
  const unused = ERROR_KINDS.filter(k => !used.includes(k));
  check(unused.length === 0, "and every declared kind is one the CLI can actually emit", unused.join(","));

  // The JSON shape an operator scripts against.
  const r = run("why", "1", "o/r", "--json");
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* stays null */ }
  check(j !== null, "a refusal under --json is itself JSON on stdout", r.stdout.slice(0, 240));
  check(j?.ok === false && typeof j?.kind === "string" && typeof j?.retryable === "boolean",
    "carrying ok, a kind and a retryable bit", JSON.stringify(j));
  check(j?.format_version === 1, "and the envelope's format_version", JSON.stringify(j));
  check(r.status === 2, "and the exit code is the misuse one", `rc=${r.status}`);
  check(r.stderr.trim() === "",
    "and NOTHING on stderr: the machine shape goes to one stream, never to both", r.stderr.slice(0, 200));

  // Without --json the message is prose on stderr and stdout stays empty, so a
  // pipeline reading stdout gets nothing rather than half a document.
  const p = run("why", "1", "o/r", "--nonsense");
  check(p.stdout.trim() === "", "a refusal without --json writes nothing to stdout", p.stdout.slice(0, 200));
}

// ── every read command emits parseable JSON, enumerated rather than remembered ─
//
// The enumeration is DERIVED from APPLIES.json, which the block above already
// proves is a subset of the real route table. A hand-written list here would
// return the commands whoever wrote it thought of, and nothing in the output
// would say so.
{
  const { APPLIES } = await import("../bin/reeve.flags.mjs");

  // `run`, `tick`, `canary`, `backup`, `restore`, `init` and `build run` are
  // deliberately NOT invoked: they dispatch, spend, or write. Every command below
  // is a reader, and the list is FILTERED from APPLIES rather than retyped, so a
  // route added to APPLIES is covered the day it is added.
  const INVOCATION = {
    doctor: ["doctor", "revnix/reeve"],
    status: ["status", "revnix/reeve"],
    builder: ["builder", "doctor"],
    build: ["build", "status"],
    task: ["task", "list"],
  };
  const missing = APPLIES.json.filter(c => !INVOCATION[c]);
  check(missing.length === 0,
    `every command APPLIES.json names has an invocation here (${APPLIES.json.length} of them)`,
    `no invocation for: ${missing.join(",")}`);

  let checked = 0;
  for (const c of APPLIES.json.filter(c => INVOCATION[c])) {
    const r = run(...INVOCATION[c], "--json");
    let ok = false; try { JSON.parse(r.stdout); ok = true; } catch { /* stays false */ }
    // `task list` in a home with no hub answers a TYPED REFUSAL, which is JSON and
    // is the contract: what is asserted here is the SHAPE, not the verdict.
    check(ok, `reeve ${INVOCATION[c].join(" ")} --json emits parseable JSON`, r.out.slice(0, 240));
    checked++;
  }
  check(checked === APPLIES.json.length,
    `all ${checked} read commands were exercised, not a subset`, String(checked));

  // CONTROL: the loop can fail. A command known to emit prose, run through the
  // same parse, must NOT parse -- otherwise every check above passes on any
  // output at all.
  const prose = run("statusline", "revnix/reeve");
  let proseParsed = false; try { JSON.parse(prose.stdout); proseParsed = true; } catch { /* expected */ }
  check(!proseParsed, "control: the same parse rejects a command that emits prose", prose.stdout.slice(0, 200));
}


// ── applicability is subcommand-aware where a subcommand is what differs ────
//
// `task file` implements --dry-run; `task list`, `task show` and `task why` are
// readers that never look at it. A route-level entry accepted it there and did
// nothing -- recreating, INSIDE the gate built to prevent it, exactly the
// accepted-and-inert flag it exists to refuse.
{
  const { APPLIES, inapplicable } = await import("../bin/reeve.flags.mjs");
  check(APPLIES["dry-run"].every(a => a.includes(" ")),
    "--dry-run's scope names a subcommand, not a whole route", JSON.stringify(APPLIES["dry-run"]));

  const listed = run("task", "list", "--dry-run");
  check(listed.status === 2 && /--dry-run is not implemented by/.test(listed.out),
    "a task READ subcommand refuses --dry-run rather than accepting it and doing nothing",
    `rc=${listed.status} ${listed.out.split("\n")[0]}`);
  check(/task list/.test(listed.out),
    "and names the subcommand, not just the route", listed.out.split("\n")[0]);

  // CONTROL: the subcommand that DOES implement it is untouched. Without this the
  // change above is satisfied by banning the flag from `task` entirely.
  const filed = run("task", "file", "--dry-run");
  check(!/--dry-run is not implemented by/.test(filed.out),
    "control: `task file` still reaches its own body with --dry-run", filed.out.split("\n")[0]);

  // A route-qualified flag with NO subcommand typed is not decided by this gate:
  // the route is about to refuse the missing subcommand, and answering the flag
  // first would report the wrong error for the wrong reason.
  const bare = run("task", "--dry-run");
  check(/reeve task:/.test(bare.out) && !/--dry-run is not implemented/.test(bare.out),
    "control: `reeve task --dry-run` still reports the missing subcommand, not the flag",
    bare.out.split("\n")[0]);

  // And a route whose entries are NOT subcommand-qualified still reports the bare
  // route name: `positionals[0]` is an argument there, not a verb.
  check(inapplicable("why", new Set(["json"]), "1")?.cmd === "why",
    "a route with no qualified entry is named bare, so `reeve why 1` is not refused as `why 1`",
    JSON.stringify(inapplicable("why", new Set(["json"]), "1")));
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
