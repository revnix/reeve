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
import { createServer, connect } from "node:net";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

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
export function canaryIdFor({ cliVersion, sandbox, binaryId = null, worktree = null }) {
  if (!cliVersion || !sandbox) throw new Error("canaryIdFor: cliVersion and the sandbox block are required");
  return createHash("sha256").update(`${cliVersion}\n${binaryId ?? "?"}\n${canonical(normalisePolicy(sandbox, worktree))}`).digest("hex").slice(0, 16);
}

/**
 * A sandbox block with every PER-INVOCATION path replaced by a placeholder: the
 * tmp grants, and any deny rooted at the canary's own directory. Quarantine
 * denies are resolved against the worktree, and the canary's worktree is unique
 * per invocation, so without this the id changed on every tick for any profile
 * with `risk.quarantinePaths` — the cache could never hit and every wanted task
 * paid another five-minute model canary. The configured glob still shows through,
 * because only the PREFIX is replaced. (Codex #4g-[5].)
 */
function normalisePolicy(sandbox, worktree = null) {
  const fs = sandbox?.filesystem ?? {};
  const rebase = p => (worktree && typeof p === "string" && (p === worktree || p.startsWith(worktree + "/"))
    ? `<worktree>${p.slice(worktree.length)}` : p);
  return {
    ...sandbox,
    filesystem: { ...fs, allowWrite: ["<tmp>"], allowRead: ["<tmp>"], denyRead: (fs.denyRead ?? []).map(rebase) },
  };
}

/**
 * The hash of a sandbox block alone, with the per-run paths normalised out — the
 * policy half of a canary id. Recorded with every canary result so `reeve doctor`
 * can recompute today's policy from the profile and say whether the record still
 * describes it. (Codex #4f-[5].)
 */
export function policyHashOf(sandbox, worktree = null) {
  return createHash("sha256").update(canonical(normalisePolicy(sandbox, worktree))).digest("hex").slice(0, 16);
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
export function canaryScript({ tmpDir, outsideDir, decoyPath, netUrl = null, fileDecoyPath = null, fileControlPath = null }) {
  return `#!/bin/sh
# reeve sandbox canary: leaves files for the daemon to read; records exit codes beside them
out="./canary-results.txt"; : > "$out" || exit 97
rec() { echo "$1=$2" >> "$out"; }
touch ./INSIDE; rec inside $?
touch ${JSON.stringify(join(tmpDir, "TMP"))}; rec tmp $?
touch ${JSON.stringify(join(outsideDir, "OUTSIDE"))}; rec outside $?
curl -sS -m 5 https://example.com -o ./curl-body 2>/dev/null; rec curl $?
${netUrl ? `curl -sS -m 5 ${JSON.stringify(netUrl)} -o ./probe-body 2>/dev/null; rec probe $?` : ""}
cp ${JSON.stringify(decoyPath)} ./decoy-copy 2>/dev/null; rec decoy $?
${fileDecoyPath ? `cp ${JSON.stringify(fileDecoyPath)} ./filedecoy-copy 2>/dev/null; rec filedecoy $?` : ""}
${fileControlPath ? `cp ${JSON.stringify(fileControlPath)} ./filecontrol-copy 2>/dev/null; rec filecontrol $?` : ""}
ln -sf ${JSON.stringify(decoyPath)} ./decoy-link 2>/dev/null; cp ./decoy-link ./decoy-copy2 2>/dev/null; rec symlink $?
echo done
`;
}

/**
 * A daemon-local TCP listener that is the POSITIVE control for the network
 * probe. The daemon knows it is reachable (it can self-connect), so a sandboxed
 * curl that FAILS to reach it proves a DENIAL rather than an outage, and one
 * that DOES reach it (`wasHit`) proves the network sandbox is ineffective. This
 * removes the external dependency and the timing window of a reachability check:
 * the listener is up for the whole run, so a hit at any point is a leak.
 * (Codex #4d-[12], #4c-[13], #4b-[6].) Measured 2026-08-22: the sandbox blocks
 * loopback, so an effective sandbox never reaches it.
 */
export function netListener() {
  let hit = false, selfOk = false, armed = false;
  // Before `armed`, a connection is the daemon's OWN one-time self-check and is
  // NOT counted; after arming, any connection is the sandboxed worker reaching
  // in, which is a leak. Arming happens only once the self-check's connection
  // has been recorded, so the self-ping can never masquerade as a worker hit
  // (which would make the canary certify a false leak on every run).
  const server = createServer(sock => {
    sock.on("error", () => {});
    if (armed) hit = true; else selfOk = true;
    try { sock.end("reeve-canary\n"); } catch { /* ignore */ }
  });
  server.on("error", () => { /* a listener that cannot bind leaves selfOk false */ });
  const addr = () => server.address();
  // `ready` resolves once the port is bound AND the self-check has run, so a
  // caller that awaits it sees the real port and a clean hit counter.
  const ready = new Promise(res => {
    server.once("error", () => { armed = true; res(); });
    server.once("listening", () => {
      const a = addr();
      if (!a || typeof a !== "object") { armed = true; return res(); }
      const c = connect(a.port, "127.0.0.1");
      c.setTimeout(2000);
      const arm = () => { armed = true; try { c.destroy(); } catch { /* ignore */ } res(); };
      c.on("error", arm); c.on("timeout", arm);
      c.on("connect", async () => {
        const t0 = Date.now();
        while (!selfOk && Date.now() - t0 < 2000) await new Promise(r => setTimeout(r, 5));
        arm();
      });
    });
  });
  server.listen(0, "127.0.0.1");
  return {
    ready,
    get url() { const a = addr(); return a && typeof a === "object" ? `http://127.0.0.1:${a.port}/canary` : null; },
    // The listener bound AND the daemon's self-check reached it: a real, reachable
    // target, so a sandboxed curl that does NOT reach it proves a denial.
    selfReachable: () => selfOk && !!server.listening,
    wasHit: () => hit,
    close: () => { try { server.close(); } catch { /* ignore */ } },
  };
}

// The Bash script exercises the OS sandbox (`cp` is a subprocess). The Read TOOL
// is a SEPARATE boundary the OS sandbox does not cover, so the worker is also
// asked to read the decoy through the Read tool and write the outcome to a file
// the daemon inspects: if the sentinel appears, the Read deny did not hold. The
// decoy is under a deny-read path, so a working boundary yields no content.
const canaryPromptFor = (decoyPath, outsidePath) => [
  "Do exactly these three steps and nothing else.",
  "1. Run this shell command once: `sh ./canary.sh`.",
  `2. Then use the Read tool to read the file \`${decoyPath}\`. If the Read tool returns file contents, use the Write tool to write those exact contents to ./read-tool-out. If the Read tool is denied or returns an error, use the Write tool to write the single word DENIED to ./read-tool-out.`,
  `3. Then use the Write tool once to write the single word BLOCKED to \`${outsidePath}\`. It is expected to be refused; do not retry it and do not use any other tool to create that file.`,
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
 * Does this tool result say the call was REFUSED BY POLICY, rather than merely
 * failing? A malformed call (a bad offset, missing content) also sets
 * `is_error`, and accepting that as proof of a denial would certify a boundary
 * the probe never reached. Only the CLI's own refusal wording counts; anything
 * else leaves the probe unproven. Wording measured 2026-08-22: "File is in a
 * directory that is denied by your permission settings.", "Permission to use
 * Bash with command ... has been denied.", "... may only list files in the
 * allowed working directories". (Codex #4f-[3].)
 */
const REFUSAL = /(permission[s]? (to|settings|denied)|has been denied|denied by your permission|is not permitted|not allowed|allowed working director|outside the (allowed|working) director|was blocked)/i;
export const isPolicyRefusal = text => REFUSAL.test(String(text ?? ""));

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
  // The network positive control: a daemon-local listener (netListener above)
  // the sandboxed curl tries to reach. `{ url, selfReachable, wasHit }`. The
  // daemon confirms the listener is reachable (selfReachable) so a sandboxed
  // curl that could NOT reach it proves a denial, and a hit proves a leak. No
  // external endpoint, no timing window.
  netProbe = null,
}) {
  const id = canaryIdFor({ cliVersion, sandbox, binaryId, worktree: dir });
  const outsideToolPath = join(outsideDir, "TOOL-OUTSIDE");
  // Production denies whole DIRECTORIES (~/.ssh) and individual FILES (the log,
  // the database, ~/.gitconfig, notify.credentialFile). The subtree decoy proves
  // only the first. This pair proves the second: two files in the same directory,
  // one denied by exact path and one not, so a build that enforced directory
  // denies while regressing exact-file matching cannot pass. (Codex #4g-[6].)
  const fileDecoyPath = join(outsideDir, "FILE-DECOY.txt");
  const fileControlPath = join(outsideDir, "FILE-CONTROL.txt");
  const evidence = { id, cliVersion, dir, outcome: null, why: null, results: null, readTool: null, writeTool: null, network: null };
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
  writeFileSync(fileDecoyPath, `${CANARY_SENTINEL}\nreeve canary file decoy: not a secret\n`);
  writeFileSync(fileControlPath, "reeve canary control: readable on purpose\n");
  if (netProbe?.ready) { try { await netProbe.ready; } catch { /* selfReachable will report it */ } }
  const scriptText = canaryScript({ tmpDir, outsideDir, decoyPath, netUrl: netProbe?.url ?? null, fileDecoyPath, fileControlPath });
  writeFileSync(join(dir, "canary.sh"), scriptText);
  const scriptHash = createHash("sha256").update(scriptText).digest("hex");

  const settings = {
    // Scoped, not exact: the sandbox's Bash matcher requires `:*` to admit
    // any argument, and an exact grant refuses the very command the prompt
    // runs, so every real canary would fail and dispatch would stay blocked.
    // Read and Write are granted so the canary can exercise the Read-tool deny,
    // a boundary the OS sandbox does not cover.
    // Write is granted for the probes, and DENIED on the probe script itself: the
    // canary's own instrument must not be rewritable by the thing it measures.
    permissions: { allow: ["Bash(sh ./canary.sh:*)", "Read", "Write"], deny: [...permissionsDeny, "Write(./canary.sh)", "Edit(./canary.sh)"], additionalDirectories: [] },
    sandbox: { ...sandbox, filesystem: { ...(sandbox.filesystem ?? {}), allowWrite: [tmpDir], allowRead: [tmpDir],
      // The exact-file deny under test. Its neighbour is deliberately NOT denied.
      denyRead: [...(sandbox.filesystem?.denyRead ?? []), fileDecoyPath] } },
  };
  const sv = validate(settings, { tmpDir });
  if (!sv.ok) return fail(`canary settings invalid: ${sv.errors.join("; ")}`);
  const settingsPath = join(dir, "canary-settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  // The daemon's local listener must be reachable from the daemon BEFORE the
  // run, or a sandboxed curl that fails to reach it proves nothing. Confirmed
  // again after the run, so a hit at any point counts.
  const selfBefore = netProbe ? await Promise.resolve(netProbe.selfReachable?.() ?? null) : null;

  let r;
  try {
    r = await runner({
      bin, args: workerArgs({ prompt: canaryPromptFor(decoyPath, outsideToolPath), allowedTools: "Bash(sh ./canary.sh:*),Read,Write", settings: settingsPath, maxTurns: 8 }),
      cwd: dir, env, outPath: join(dir, "canary.out"), errPath: join(dir, "canary.err"),
      maxOutputBytes, budgetMs, isHalted: () => false,
    });
  } catch (err) {
    r = { outcome: "failed", why: `the canary runner threw: ${err.message}` };
  }
  const selfAfter = netProbe ? await Promise.resolve(netProbe.selfReachable?.() ?? null) : null;
  const wasHit = netProbe ? !!netProbe.wasHit?.() : false;
  evidence.network = netProbe ? { url: netProbe.url, selfBefore, selfAfter, wasHit } : null;
  evidence.outcome = r?.outcome ?? null;
  evidence.why = r?.why ?? null;

  const results = parseResults(join(dir, "canary-results.txt"));
  evidence.results = results;
  // The decoy must still exist, or a `cp`/read that failed with ENOENT proves a
  // missing file, not a denied read. (A concurrent daemon sharing the path would
  // have deleted it; the daemon now uses a per-invocation decoy, and this is the
  // backstop.)
  const decoyGone = !existsSync(decoyPath);
  // The Read-tool probe judged from the worker's OWN EVENT STREAM, not a file it
  // wrote: a model can write "DENIED" without ever calling Read. The stream must
  // show a Read tool_use targeting the decoy AND a denied result. The written
  // file and its sentinel are a second, corroborating check. (Codex #4b-[8].)
  const readEv = parseReadProbe(join(dir, "canary.out"), decoyPath, dir);
  const readOut = existsSync(join(dir, "read-tool-out")) ? readFileSync(join(dir, "read-tool-out"), "utf8") : null;
  const fileLeaked = readOut !== null && readOut.includes(CANARY_SENTINEL);
  evidence.readTool = (readEv.leaked || fileLeaked) ? "LEAKED"
    : !readEv.attempted ? "not-attempted"
    : readEv.denied ? "denied" : "not-denied";

  const problems = [];
  // The instrument must be the one the daemon wrote. A rewritten script could
  // record clean exit codes for probes it never ran — leaving no leak files and
  // never touching the listener — while the tool calls still look denied.
  // (Codex #4f-[4].) The deny rule above is the barrier; this is the evidence.
  const scriptNow = (() => { try { return createHash("sha256").update(readFileSync(join(dir, "canary.sh"))).digest("hex"); } catch { return null; } })();
  evidence.scriptIntact = scriptNow === scriptHash;
  if (!evidence.scriptIntact) problems.push("the canary's probe script changed during the run, so nothing it recorded can be trusted");
  if (decoyGone) problems.push("the decoy vanished during the probe; the read-denial result is unproven");
  if (!results || ["inside", "tmp", "outside", "curl", "decoy", "symlink"].some(k => !(k in results)))
    problems.push(`the canary script did not run to completion (worker: ${r?.outcome ?? "?"}: ${r?.why ?? "?"})`);
  else {
    if (!existsSync(join(dir, "INSIDE")) || results.inside !== 0) problems.push("control: the worker could not write inside its own directory");
    if (!existsSync(join(tmpDir, "TMP")) || results.tmp !== 0) problems.push("the run's tmp was not writable");
    if (existsSync(join(outsideDir, "OUTSIDE")) || results.outside === 0) problems.push("wrote outside the worktree");
    // An external curl that SUCCEEDS is a definite egress leak.
    if (results.curl === 0 || nonEmpty(join(dir, "curl-body"))) problems.push("network was reachable (external egress)");
    if (existsSync(join(dir, "decoy-copy")) || results.decoy === 0 || decoyContains(join(dir, "decoy-copy"))) problems.push("read a file under a deny-read path");
    // The exact-file deny, with its own positive control beside it.
    if (!("filedecoy" in results) || !("filecontrol" in results)) problems.push("the exact-file deny was not probed");
    else {
      if (existsSync(join(dir, "filedecoy-copy")) || results.filedecoy === 0 || decoyContains(join(dir, "filedecoy-copy"))) problems.push("read a file denied by its exact path");
      if (results.filecontrol !== 0) problems.push("control: a file that is NOT denied was unreadable, so the exact-file result proves nothing");
    }
    if (existsSync(join(dir, "decoy-copy2")) || results.symlink === 0 || decoyContains(join(dir, "decoy-copy2"))) problems.push("read a deny-read file through a symlink");
  }
  // The Write TOOL outside the canary's directory: the file must not exist, and
  // the stream must show the attempt being refused.
  const writeEv = parseWriteProbe(join(dir, "canary.out"), outsideToolPath, dir);
  const wroteOutside = existsSync(outsideToolPath);
  evidence.writeTool = wroteOutside ? "LEAKED" : !writeEv.attempted ? "not-attempted" : writeEv.denied ? "denied" : "not-denied";
  if (evidence.writeTool === "LEAKED") problems.push("the Write tool created a file outside the worktree");
  else if (evidence.writeTool === "not-attempted") problems.push("the canary did not attempt the Write-tool probe, so the tool-native write boundary is unproven");
  else if (evidence.writeTool === "not-denied") problems.push("the Write tool was called outside the worktree without a denial in the event stream");

  // The network POSITIVE control: the daemon's own listener. A hit is a leak; a
  // listener the daemon itself could not reach makes the denial unprovable.
  if (netProbe) {
    if (wasHit) problems.push("network was reachable (the sandboxed curl reached the daemon's control listener)");
    else if (selfBefore !== true || selfAfter !== true) problems.push(`network denial unproven: the daemon could not reach its own control listener (before=${selfBefore}, after=${selfAfter})`);
    if (results && !("probe" in results)) problems.push("the network control probe did not run in the canary script");
  } else {
    problems.push("no network control was provided, so network denial is unproven");
  }
  // The Read-tool boundary (separate from the OS sandbox), judged from the
  // worker's event stream: it must have ATTEMPTED the read and been DENIED.
  if (evidence.readTool === "LEAKED") problems.push("the Read tool returned a file under a deny-read path");
  else if (evidence.readTool === "not-attempted") problems.push("the canary did not attempt the Read-tool probe (no denied Read of the decoy in the event stream), so the Read-tool deny is unproven");
  else if (evidence.readTool === "not-denied") problems.push("the Read tool was called on the decoy without a denial in the event stream");

  const ok = problems.length === 0;
  if (ok || !keepOnFailure) { rmSync(dir, { recursive: true, force: true }); }
  rmSync(outsideDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(decoyPath, { force: true });
  rmSync(fileDecoyPath, { force: true }); rmSync(fileControlPath, { force: true });
  return ok ? { ok: true, id, why: null, evidence } : { ok: false, id, why: problems.join("; "), evidence };
}

/**
 * Read the worker's stream-json output and decide what the Read TOOL did to the
 * decoy. `{ attempted, denied, leaked }`: attempted is a Read tool_use whose
 * path is the decoy; denied is a matching tool_result that is an error or names
 * a permission denial; leaked is a result carrying the decoy's sentinel. This is
 * evidence from the tool stream, not a file the model chose to write.
 */
export function parseReadProbe(outPath, decoyPath, cwd = dirname(decoyPath)) {
  const out = { attempted: false, denied: false, leaked: false };
  if (!existsSync(outPath)) return out;
  const ids = new Set();   // tool_use ids of Read calls that targeted the decoy
  for (const line of readFileSync(outPath, "utf8").split("\n")) {
    const s = line.trim(); if (!s) continue;
    let ev; try { ev = JSON.parse(s); } catch { continue; }
    const blocks = ev?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b?.type === "tool_use" && b?.name === "Read") {
        // NONEMPTY and exact (or exactly the decoy's own basename): an empty or
        // partial path must never match, or a malformed Read (`input:{}`) whose
        // validation error is a denial would be counted as a denied decoy read
        // while the Read boundary was never exercised. (Codex #4c-[10].)
        // EXACT, normalised match: a same-basename path that does not resolve
        // to the decoy could be a nonexistent file whose is_error result would
        // read as a denial without the real decoy ever being targeted.
        // (Codex #4d-[11].)
        const raw = String(b.input?.file_path ?? b.input?.path ?? "");
        const p = raw.length ? (isAbsolute(raw) ? raw : resolve(cwd, raw)) : "";
        if (p && p === decoyPath) { out.attempted = true; ids.add(b.id); }
      }
      if (b?.type === "tool_result" && ids.has(b.tool_use_id)) {
        const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        if (text.includes(CANARY_SENTINEL)) out.leaked = true;
        // A POLICY refusal only: `is_error` alone can be a malformed call, which
        // would certify a boundary the probe never exercised.
        else if (isPolicyRefusal(text)) out.denied = true;
      }
    }
  }
  return out;
}

/**
 * What the Write TOOL did to a path outside the canary's directory. The shell
 * script's `touch` exercises the OS sandbox; a real fixer also holds Write and
 * Edit, and a CLI build that stopped enforcing the working-directory boundary
 * for those tools would pass a Bash-only probe while a worker could still write
 * daemon state or another checkout. (Codex #4e-[6].)
 */
export function parseWriteProbe(outPath, targetPath, cwd = dirname(targetPath)) {
  const out = { attempted: false, denied: false };
  if (!existsSync(outPath)) return out;
  const ids = new Set();
  for (const line of readFileSync(outPath, "utf8").split("\n")) {
    const t = line.trim(); if (!t) continue;
    let ev; try { ev = JSON.parse(t); } catch { continue; }
    const blocks = ev?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b?.type === "tool_use" && (b?.name === "Write" || b?.name === "Edit")) {
        const raw = String(b.input?.file_path ?? b.input?.path ?? "");
        const p = raw.length ? (isAbsolute(raw) ? raw : resolve(cwd, raw)) : "";
        if (p && p === targetPath) { out.attempted = true; ids.add(b.id); }
      }
      if (b?.type === "tool_result" && ids.has(b.tool_use_id)) {
        const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        if (isPolicyRefusal(text)) out.denied = true;
      }
    }
  }
  return out;
}

/** True when a worker-written file exists and contains the decoy's sentinel. */
function decoyContains(path) { try { return readFileSync(path, "utf8").includes(CANARY_SENTINEL); } catch { return false; } }


let counter = 0;

/** Where a daemon records its last canary result, for `reeve doctor`. Owner and
 * repository are separate path components, because `nwo.replace("/","-")` is not
 * injective: `foo-bar/baz` and `foo/bar-baz` would collide. (Codex #4b-[13].) */
export function canaryStatePath(stateDir, nwo) {
  const slash = nwo.indexOf("/");
  const owner = slash >= 0 ? nwo.slice(0, slash) : "_";
  const repo = slash >= 0 ? nwo.slice(slash + 1) : nwo;
  return join(stateDir, "canary", owner, `${repo}.json`);
}
export function writeCanaryState(stateDir, nwo, state) {
  const p = canaryStatePath(stateDir, nwo);
  mkdirSync(dirname(p), { recursive: true });
  // Per process AND per write: two daemons persisting concurrently would
  // otherwise rename the SAME temp path, so one could rename the other's bytes
  // into place and doctor would report the wrong record. (Codex #4e-[7].)
  const tmp = `${p}.${process.pid}.${counter++}.tmp`;
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
