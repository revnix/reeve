// `reeve doctor` could not find its own state database.
//
// Measured against the live store: doctor printed
//
//   UNKNOWN
//     R-06  leases
//           no state database
//
// while ~/.reeve/state/nextlyhq/nextly.db sat there with 3,600 events in it.
//
// The cause was that doctor resolved the path from `profile.state.location`,
// which the profile schema defines as the SIBLING REPOSITORY holding a project's
// ledger -- nextly's reads "nextlyhq/nextly-ledger". existsSync said no, and
// doctor rendered that absence as UNKNOWN.
//
// So the one check that exists to catch a lease outliving its worker had never
// run against a real store, and runDoctor folds UNKNOWN into DEGRADED, so the
// exit code was wrong too. That is the failure this system is built to refuse:
// absence rendered as a status.
//
// The test drives the real entry point, because the defect was in the wiring
// rather than in any function runDoctor could be handed.
import { open } from "../src/db/ops.mjs";
import { statePathFor } from "../src/paths.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const NWO = "owner-x/repo-y";
const home = mkdtempSync(join(tmpdir(), "reeve-doctor-"));

// A profile carrying the exact trap: state.location naming a sibling REPOSITORY.
const profilePath = join(home, "profiles", "owner-x", "repo-y.json");
mkdirSync(dirname(profilePath), { recursive: true });
writeFileSync(profilePath, JSON.stringify({
  schemaVersion: 1,
  project: { kind: "product" },
  identity: { key: NWO, defaultBranch: "main", visibility: "private" },
  authority: { permission: "admin", policy: "propose_and_merge", profileLocation: "sidecar" },
  // The trap, exactly as nextly's profile carries it: a sibling REPOSITORY name.
  state: { mode: "sibling", location: "owner-x/repo-y-ledger" },
  units: [{ id: "root", root: ".", language: "typescript", packageManager: "npm",
            commands: { test: { cmd: "npm test", state: "present" } } }],
  ci: { provider: "none" },
  merge: { method: "squash", enforcement: "attested" },
}));

// A real store at the canonical path, holding a live run whose lease has expired.
const dbPath = statePathFor(home, NWO);
mkdirSync(dirname(dbPath), { recursive: true });
{
  const db = open(dbPath);
  db.prepare(
    `INSERT INTO node (id, kind, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run("task-1", "task", "a task someone leased", 1, 1);
  db.prepare(
    `INSERT INTO run (id, task_id, lane, status, lease_expires_at, heartbeat_at, owner_host, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("run-1", "task-1", "lane-a", "leased", 1, 1, "test-host", 1);
  db.close();
}

// gh is unreachable from here, so the network-bound checks degrade rather than
// hang. That is deliberate: this test is about R-06 and nothing else.
const bin = new URL("../bin/reeve", import.meta.url).pathname;
const r = spawnSync(process.execPath, [bin, "doctor", NWO, "--json"], {
  encoding: "utf8",
  env: { ...process.env, REEVE_HOME: home, PATH: join(home, "no-tools") },
});

const out = JSON.parse(r.stdout);
const leases = out.checks.find(c => c.id === "R-06");

check(!!leases, "control: doctor ran and reported on leases at all",
  `stdout=${r.stdout.slice(0, 200)} stderr=${r.stderr.slice(0, 200)}`);

check(leases && leases.level !== "UNKNOWN",
  "doctor finds the state database at the path every other command uses",
  leases && `level=${leases.level} lines=${JSON.stringify(leases.lines)}`);

check(leases && !leases.lines.some(l => /no state database/.test(l)),
  "and does not report a store that exists as absent",
  leases && JSON.stringify(leases.lines));

// The store was seeded with an expired lease, so the check must SAY so. Finding
// the database and then reporting nothing would pass the two assertions above
// while still telling the operator nothing.
check(leases && leases.level === "DEGRADED" && leases.lines.some(l => /past lease expiry/.test(l)),
  "and reads the rows: one live run, past its lease",
  leases && `level=${leases.level} lines=${JSON.stringify(leases.lines)}`);

// ── the profile is read from the same home as the state ──────────────────────
//
// loadProfile hard-coded homedir(), so REEVE_HOME moved the store but not the
// profile. The run above proves the pairing: a profile found ONLY under the
// scratch home is what supplied identity.nwo to the checks that ran.
check(out.checks.some(c => c.id === "R-03"),
  "the profile was read from REEVE_HOME too, not from the real one",
  JSON.stringify(out.checks.map(c => c.id)));

rmSync(home, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
