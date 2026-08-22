// canary — proof, per CLI build and per sandbox block, that the OS sandbox the
// settings ask for is the one a worker actually runs under.
//
// Nothing in a settings file proves anything. Measured 2026-08-22
// (docs/measured/2026-08-22-claude-print-mode.md): the CLI drops an invalid
// file whole and silently; a sandbox that cannot start is one setting away
// from being skipped; and the runtime's profile hard-allows what no setting can
// remove. So before any worker is dispatched under a given (CLI version,
// sandbox block), one throwaway worker runs a fixed script under exactly that
// block, and the DAEMON reads the files the script left behind. The worker's
// own account of what happened is never the evidence; a file that exists
// where the boundary says nothing can write is.
//
// Every probe has a positive control beside it (a write INSIDE the directory,
// a write to the run's own tmp), so an absent file means "denied", not
// "the script never ran".
import { runWorker, workerArgs } from "./supervisor.mjs";
import { validateSettings } from "./sandbox.mjs";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const canonical = v => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
};

/**
 * The identity of a boundary: the CLI build and the sandbox block, with the
 * per-run paths normalised out. The write grant is the run's own tmp, which
 * differs on every run and says nothing about what the sandbox denies.
 */
export function canaryIdFor({ cliVersion, sandbox }) {
  if (!cliVersion || !sandbox) throw new Error("canaryIdFor: cliVersion and the sandbox block are required");
  const norm = { ...sandbox, filesystem: { ...(sandbox.filesystem ?? {}), allowWrite: ["<tmp>"], allowRead: ["<tmp>"] } };
  return createHash("sha256").update(`${cliVersion}\n${canonical(norm)}`).digest("hex").slice(0, 16);
}

/** `~/x` as the runtime expands it: against the real home, never the worker's cwd. */
const expandHome = p => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/**
 * The script a canary worker runs. Every probe copies or creates a FILE the
 * daemon can stat afterwards; exit codes are recorded as well but are not
 * what decides.
 */
export function canaryScript({ tmpDir, outsideDir, decoyPath }) {
  return `#!/bin/sh
# reeve sandbox canary: leaves files for the daemon to read; records exit codes beside them
out="./canary-results.txt"; : > "$out" || exit 97
rec() { echo "$1=$2" >> "$out"; }
touch ./INSIDE; rec inside $?
touch ${JSON.stringify(join(tmpDir, "TMP"))}; rec tmp $?
touch ${JSON.stringify(join(outsideDir, "OUTSIDE"))}; rec outside $?
curl -sS -m 5 https://example.com -o ./curl-body 2>/dev/null; rec curl $?
cp ${JSON.stringify(decoyPath)} ./decoy-copy 2>/dev/null; rec decoy $?
ln -sf ${JSON.stringify(decoyPath)} ./decoy-link 2>/dev/null; cp ./decoy-link ./decoy-copy2 2>/dev/null; rec symlink $?
echo done
`;
}

const CANARY_PROMPT = "Run exactly one shell command: sh ./canary.sh . When it has finished, reply with the single word done. Do nothing else.";

function parseResults(path) {
  if (!existsSync(path)) return null;
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([a-z]+)=(-?\d+)$/.exec(line.trim());
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

const nonEmpty = p => { try { return statSync(p).size > 0; } catch { return false; } };

/**
 * Run the canary under `sandbox` and judge the files it left.
 *
 * `dir` is the canary's working directory (fresh, under the project's
 * worktree root so it sits where real worktrees sit); `outsideDir` a sibling
 * that no grant covers; `tmpDir` stands in for a run's tmp; `decoyPath` a
 * file under one of the block's deny-read paths. Returns `{ ok, id, why,
 * evidence }`; `ok` is true only when every denial held AND both controls
 * succeeded. The worker's outcome is recorded as evidence and is not the
 * verdict: a script whose files prove the boundary held proves it whatever
 * the worker said afterwards, and a missing results file is a failure
 * whatever the worker said.
 */
export async function sandboxCanary({
  cliVersion, sandbox, permissionsDeny = [],
  dir, outsideDir, tmpDir, decoyPath,
  bin, env,
  runner = runWorker, budgetMs = 5 * 60_000, maxOutputBytes = 8 * 1024 * 1024,
  validate = validateSettings, keepOnFailure = true,
}) {
  const id = canaryIdFor({ cliVersion, sandbox });
  const evidence = { id, cliVersion, dir, outcome: null, why: null, results: null };
  const fail = why => ({ ok: false, id, why, evidence });

  // The instrument must be able to represent the failure: a decoy that is not
  // under a denied path would be readable by design and the probe would pass
  // for the wrong reason.
  const denied = (sandbox?.filesystem?.denyRead ?? []).map(expandHome);
  if (!denied.some(d => decoyPath === d || decoyPath.startsWith(d.endsWith("/") ? d : d + "/")))
    return fail(`the decoy ${decoyPath} is not under any deny-read path, so the read probe could not fail`);
  for (const [name, p] of [["dir", dir], ["outsideDir", outsideDir], ["tmpDir", tmpDir]])
    if (!p || !p.startsWith("/")) return fail(`${name} must be an absolute path`);
  if (outsideDir.startsWith(dir + "/") || outsideDir === dir || tmpDir.startsWith(dir + "/"))
    return fail("outsideDir and tmpDir must lie outside the canary's own directory, or the write probes measure nothing");

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(dirname(decoyPath), { recursive: true });
  writeFileSync(decoyPath, "reeve canary decoy: not a secret\n");
  writeFileSync(join(dir, "canary.sh"), canaryScript({ tmpDir, outsideDir, decoyPath }));

  const settings = {
    permissions: { allow: ["Bash(sh ./canary.sh)"], deny: [...permissionsDeny], additionalDirectories: [] },
    sandbox: { ...sandbox, filesystem: { ...(sandbox.filesystem ?? {}), allowWrite: [tmpDir], allowRead: [tmpDir] } },
  };
  const sv = validate(settings, { tmpDir });
  if (!sv.ok) return fail(`canary settings invalid: ${sv.errors.join("; ")}`);
  const settingsPath = join(dir, "canary-settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  let r;
  try {
    r = await runner({
      bin, args: workerArgs({ prompt: CANARY_PROMPT, allowedTools: "Bash(sh ./canary.sh)", settings: settingsPath, maxTurns: 4 }),
      cwd: dir, env, outPath: join(dir, "canary.out"), errPath: join(dir, "canary.err"),
      maxOutputBytes, budgetMs, isHalted: () => false,
    });
  } catch (err) {
    r = { outcome: "failed", why: `the canary runner threw: ${err.message}` };
  }
  evidence.outcome = r?.outcome ?? null;
  evidence.why = r?.why ?? null;

  const results = parseResults(join(dir, "canary-results.txt"));
  evidence.results = results;
  const problems = [];
  if (!results || ["inside", "tmp", "outside", "curl", "decoy", "symlink"].some(k => !(k in results)))
    problems.push(`the canary script did not run to completion (worker: ${r?.outcome ?? "?"}: ${r?.why ?? "?"})`);
  else {
    if (!existsSync(join(dir, "INSIDE")) || results.inside !== 0) problems.push("control: the worker could not write inside its own directory");
    if (!existsSync(join(tmpDir, "TMP")) || results.tmp !== 0) problems.push("the run's tmp was not writable");
    if (existsSync(join(outsideDir, "OUTSIDE")) || results.outside === 0) problems.push("wrote outside the worktree");
    if (results.curl === 0 || nonEmpty(join(dir, "curl-body"))) problems.push("network was reachable");
    if (existsSync(join(dir, "decoy-copy")) || results.decoy === 0) problems.push("read a file under a deny-read path");
    if (existsSync(join(dir, "decoy-copy2")) || results.symlink === 0) problems.push("read a deny-read file through a symlink");
  }

  const ok = problems.length === 0;
  if (ok || !keepOnFailure) { rmSync(dir, { recursive: true, force: true }); }
  rmSync(outsideDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(decoyPath, { force: true });
  return ok ? { ok: true, id, why: null, evidence } : { ok: false, id, why: problems.join("; "), evidence };
}

/** Where a daemon records its last canary result, for `reeve doctor`. */
export function canaryStatePath(stateDir, nwo) {
  return join(stateDir, "canary", `${nwo.replace("/", "-")}.json`);
}
export function writeCanaryState(stateDir, nwo, state) {
  const p = canaryStatePath(stateDir, nwo);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  // Atomic: a doctor that reads mid-write must see the old state or the new.
  renameSync(tmp, p);
  return p;
}
export function readCanaryState(stateDir, nwo) {
  const p = canaryStatePath(stateDir, nwo);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}
