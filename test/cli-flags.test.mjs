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
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
