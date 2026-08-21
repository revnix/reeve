// Capture the live authority baseline for a repo: what the ruleset requires,
// who may bypass it, what classic branch protection requires, and what the
// profile's merge-related fields say. Written once per programme freeze and
// checked in under deploy/baselines/; doctor (R-13) compares every later
// reading against it so authority cannot widen without a decision.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { withDefaults } from "../src/profile/schema.mjs";
import { readLiveBaseline, baselinePathFor } from "../src/baseline.mjs";

const nwo = process.argv[2];
if (!nwo) { console.error("usage: capture-baseline.mjs <owner/repo> [branch]"); process.exit(2); }
const [owner, repo] = nwo.split("/");
// The same home every command uses: REEVE_HOME when set, ~/.reeve otherwise.
const HOME = process.env.REEVE_HOME ?? join(homedir(), ".reeve");
const profile = withDefaults(JSON.parse(readFileSync(join(HOME, "profiles", owner, `${repo}.json`), "utf8")));
let live;
try { live = readLiveBaseline(nwo, profile, { branch: process.argv[3] ?? null }); }
catch (e) { console.error(`capture-baseline: ${String(e.stderr ?? e.message).trim().split("\n")[0]}`); process.exit(1); }
// The script writes the file itself (creating the owner directory), so the
// documented command works for the first repository under a new owner; the
// JSON also goes to stdout for a reader who wants to see it.
const out = JSON.stringify({ capturedAt: new Date().toISOString(), ...live }, null, 2) + "\n";
const dest = baselinePathFor(nwo);
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, out);
process.stdout.write(out);
console.error(`wrote ${dest}`);
