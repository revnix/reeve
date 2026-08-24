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
  const optNames = new Set([...src.matchAll(/\bopt\("([a-z0-9-]+)"\)/g)].map(m => m[1]));
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

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
