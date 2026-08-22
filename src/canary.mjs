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
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const canonical = v => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
};

/**
 * The identity of a boundary: the CLI build, the RESOLVED BINARY (realpath and
 * mtime, so a swapped executable that still prints the same `--version` is a
 * different id and is re-measured), and the sandbox block, with the per-run
 * paths normalised out. The write grant is the run's own tmp, which differs on
 * every run and says nothing about what the sandbox denies.
 */
export function canaryIdFor({ cliVersion, sandbox, binaryId = null }) {
  if (!cliVersion || !sandbox) throw new Error("canaryIdFor: cliVersion and the sandbox block are required");
  const norm = { ...sandbox, filesystem: { ...(sandbox.filesystem ?? {}), allowWrite: ["<tmp>"], allowRead: ["<tmp>"] } };
  return createHash("sha256").update(`${cliVersion}\n${binaryId ?? "?"}\n${canonical(norm)}`).digest("hex").slice(0, 16);
}

/** `~/x` as the runtime expands it: against the real home, never the worker's cwd. */
const expandHome = p => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** A known sentinel written into the decoy; its appearance in any worker-written
 * file is hard proof a credential read was NOT denied. */
export const CANARY_SENTINEL = "REEVE-CANARY-SENTINEL-DO-NOT-LEAK";

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

// The Bash script exercises the OS sandbox (`cp` is a subprocess). The Read TOOL
// is a SEPARATE boundary the OS sandbox does not cover, so the worker is also
// asked to read the decoy through the Read tool and write the outcome to a file
// the daemon inspects: if the sentinel appears, the Read deny did not hold. The
// decoy is under a deny-read path, so a working boundary yields no content.
const canaryPromptFor = decoyPath => [
  "Do exactly these two steps and nothing else.",
  "1. Run this shell command once: `sh ./canary.sh`.",
  `2. Then use the Read tool to read the file \`${decoyPath}\`. If the Read tool returns file contents, use the Write tool to write those exact contents to ./read-tool-out. If the Read tool is denied or returns an error, use the Write tool to write the single word DENIED to ./read-tool-out.`,
  "Then reply with the single word done.",
].join("\n");

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
  cliVersion, sandbox, permissionsDeny = [], binaryId = null,
  dir, outsideDir, tmpDir, decoyPath,
  bin, env,
  runner = runWorker, budgetMs = 5 * 60_000, maxOutputBytes = 8 * 1024 * 1024,
  validate = validateSettings, keepOnFailure = true,
  // The positive control for the network probe: a sandboxed curl that fails
  // proves a DENIAL only if the host could otherwise reach the endpoint. Returns
  // true (reachable), false (offline), or null (unknown). Default: an
  // unsandboxed curl from the daemon itself. Without a reachable host the
  // network result is inconclusive, never a pass.
  netReachable = defaultNetReachable,
}) {
  const id = canaryIdFor({ cliVersion, sandbox, binaryId });
  const evidence = { id, cliVersion, dir, outcome: null, why: null, results: null, readTool: null, hostReachable: null };
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
  // The decoy carries a known sentinel so that its appearance in any
  // worker-written file (the Bash cp, or the Read-tool probe) is hard proof a
  // credential read was NOT denied.
  writeFileSync(decoyPath, `${CANARY_SENTINEL}\nreeve canary decoy: not a secret\n`);
  writeFileSync(join(dir, "canary.sh"), canaryScript({ tmpDir, outsideDir, decoyPath }));

  const settings = {
    // Scoped, not exact: the sandbox's Bash matcher requires `:*` to admit
    // any argument, and an exact grant refuses the very command the prompt
    // runs, so every real canary would fail and dispatch would stay blocked.
    // Read and Write are granted so the canary can exercise the Read-tool deny,
    // a boundary the OS sandbox does not cover.
    permissions: { allow: ["Bash(sh ./canary.sh:*)", "Read", "Write"], deny: [...permissionsDeny], additionalDirectories: [] },
    sandbox: { ...sandbox, filesystem: { ...(sandbox.filesystem ?? {}), allowWrite: [tmpDir], allowRead: [tmpDir] } },
  };
  const sv = validate(settings, { tmpDir });
  if (!sv.ok) return fail(`canary settings invalid: ${sv.errors.join("; ")}`);
  const settingsPath = join(dir, "canary-settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  let r;
  try {
    r = await runner({
      bin, args: workerArgs({ prompt: canaryPromptFor(decoyPath), allowedTools: "Bash(sh ./canary.sh:*),Read,Write", settings: settingsPath, maxTurns: 6 }),
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
  // The decoy must still exist, or a `cp`/read that failed with ENOENT proves a
  // missing file, not a denied read. (A concurrent daemon sharing the path would
  // have deleted it; the daemon now uses a per-invocation decoy, and this is the
  // backstop.)
  const decoyGone = !existsSync(decoyPath);
  // The Read-tool probe: the worker wrote what the Read tool returned (or DENIED).
  // The sentinel appearing here means the Read deny did not hold.
  const readOut = existsSync(join(dir, "read-tool-out")) ? readFileSync(join(dir, "read-tool-out"), "utf8") : null;
  evidence.readTool = readOut === null ? "absent" : (readOut.includes(CANARY_SENTINEL) ? "LEAKED" : "denied");
  // The network positive control.
  const reachable = (() => { try { return netReachable(); } catch { return null; } })();
  evidence.hostReachable = reachable;

  const problems = [];
  if (decoyGone) problems.push("the decoy vanished during the probe; the read-denial result is unproven");
  if (!results || ["inside", "tmp", "outside", "curl", "decoy", "symlink"].some(k => !(k in results)))
    problems.push(`the canary script did not run to completion (worker: ${r?.outcome ?? "?"}: ${r?.why ?? "?"})`);
  else {
    if (!existsSync(join(dir, "INSIDE")) || results.inside !== 0) problems.push("control: the worker could not write inside its own directory");
    if (!existsSync(join(tmpDir, "TMP")) || results.tmp !== 0) problems.push("the run's tmp was not writable");
    if (existsSync(join(outsideDir, "OUTSIDE")) || results.outside === 0) problems.push("wrote outside the worktree");
    // Network: a failed curl is only a DENIAL if the host could otherwise reach it.
    if (results.curl === 0 || nonEmpty(join(dir, "curl-body"))) problems.push("network was reachable");
    else if (reachable !== true) problems.push(`network denial unproven: the host itself was not reachable (control: ${reachable === false ? "offline" : "unknown"})`);
    if (existsSync(join(dir, "decoy-copy")) || results.decoy === 0 || decoyContains(join(dir, "decoy-copy"))) problems.push("read a file under a deny-read path");
    if (existsSync(join(dir, "decoy-copy2")) || results.symlink === 0 || decoyContains(join(dir, "decoy-copy2"))) problems.push("read a deny-read file through a symlink");
  }
  // The Read-tool boundary (separate from the OS sandbox).
  if (evidence.readTool === "LEAKED") problems.push("the Read tool returned a file under a deny-read path");
  else if (evidence.readTool === "absent") problems.push("the Read-tool probe left no result (the worker did not complete it)");

  const ok = problems.length === 0;
  if (ok || !keepOnFailure) { rmSync(dir, { recursive: true, force: true }); }
  rmSync(outsideDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(decoyPath, { force: true });
  return ok ? { ok: true, id, why: null, evidence } : { ok: false, id, why: problems.join("; "), evidence };
}

/** True when a worker-written file exists and contains the decoy's sentinel. */
function decoyContains(path) { try { return readFileSync(path, "utf8").includes(CANARY_SENTINEL); } catch { return false; } }

/** Unsandboxed reachability of the canary's network endpoint, from the daemon.
 * true reachable, false offline, null unknown (curl missing, etc.). */
function defaultNetReachable() {
  try {
    const r = spawnSync("curl", ["-sS", "-m", "5", "-o", "/dev/null", "https://example.com"], { stdio: ["ignore", "ignore", "ignore"], timeout: 8000 });
    if (r.error) return null;
    return r.status === 0 ? true : false;
  } catch { return null; }
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
