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
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};

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
// keep the list, so the SECOND `--set` is the one asserted: if only the first
// survived, `project.kind` would still be listed as unanswered.
//
// `project.kind` is "not detectable", so init asks for it on every run and this
// discriminates with or without network.
{
  const none = run("init");
  check(/project\.kind/.test(none.out), "control: init asks for project.kind when nothing answers it", none.out.slice(0, 200));
  const two = run("init", "--set", "authority.policy=owner", "--set", "project.kind=product");
  check(!/answer:\s+--set project\.kind/.test(two.out),
    "the SECOND --set is applied too, so a repeatable flag keeps every occurrence",
    two.out.slice(0, 400));
}

// ── the home is resolved in ONE place, and every consumer reads it lazily ───
// `--home` reached only `bin/reeve`'s own constant. `credentialPaths()` denied
// the root named by the ENVIRONMENT, the canary wrote its decoy under
// `~/.reeve`, `init` consulted neither, and the App credentials were a
// module-level constant built from `homedir()` at import time. A canary that
// measures a decoy the policy has no rule about can report containment CLOSED.
//
// The fix makes the flag and the variable one mechanism, which only works if
// nothing captures the home before `bin/reeve` writes it back. Both halves are
// asserted: the structural one here, the behavioural one below.
{
  const files = [];
  const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.mjs$/.test(p)) files.push(p);
  } };
  walk(join(ROOT, "src"));
  files.push(join(ROOT, "bin", "reeve"));

  const offenders = [];
  let scanned = 0;
  for (const f of files) {
    if (f.endsWith(join("src", "home.mjs"))) continue;         // the one resolver
    const code = readFileSync(f, "utf8").split("\n")
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");  // comments are not code
    scanned++;
    for (const m of code.matchAll(/process\.env\.REEVE_HOME|homedir\(\)\s*,\s*"\.reeve"/g)) {
      // `bin/reeve` writing the resolved home BACK is the mechanism itself.
      if (f.endsWith(join("bin", "reeve")) && /process\.env\.REEVE_HOME = HOME/.test(code)
          && m[0] === "process.env.REEVE_HOME") continue;
      offenders.push(`${f.slice(ROOT.length + 1)}: ${m[0]}`);
    }
  }
  check(scanned > 15, "control: the scan read the source tree", `${scanned} files`);
  check(readFileSync(join(ROOT, "src", "home.mjs"), "utf8").includes("process.env.REEVE_HOME"),
    "control: and it would have matched, because home.mjs itself contains the pattern", "");
  check(offenders.length === 0,
    "only src/home.mjs resolves the reeve home; nothing else reads the variable",
    offenders.join("  |  "));
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
// The output test earlier shows restore's message is absent. This one is the
// file: `reeve init --write` writes `.ops/profile.json` into this repository
// (it detects as `committed`), so on the broken implementation the file exists
// afterwards and on the fixed one it does not.
{
  const ops = join(ROOT, ".ops", "profile.json");
  if (existsSync(ops)) {
    check(false, "SKIPPED: .ops/profile.json already exists, so its absence proves nothing", ops);
  } else {
    const r = run("init", "--set", "project.kind=product", "--set", "authority.policy=propose_only",
                  "--write", "--help");
    const wrote = existsSync(ops);
    if (wrote) rmSync(ops, { force: true });
    check(!wrote, "`--help` on `init --write` writes no profile", `created ${ops}`);
    check(r.status === 0 && /not yet built/.test(r.out), "and prints the usage instead", r.out.slice(0, 120));
    check(!existsSync(ops), "control: and the check cleaned up after itself", ops);
  }
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
