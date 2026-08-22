// daemon — the loop that makes this run for hours instead of for one session.
//
// One tick: read every open PR at a pinned head, publish a verdict, decide the
// single next action, and act within capacity. Everything it learns is written
// to the store, so a restart resumes rather than restarting.
//
// Two properties are deliberate and they are the whole point:
//
//   · The halt switch fails CLOSED. A marker file stops the loop AND terminates
//     workers in flight. The previous system's hooks all ended in `|| true`,
//     which is the opposite: every failure was swallowed and the session
//     continued as if healthy.
//   · Execution is OPT-IN. By default a tick observes, publishes and reports what
//     it WOULD do. Shipping a loop that acts before its decisions have been
//     watched is how an unattended run becomes an incident.

import { evaluatePr, publishVerdict } from "./pr.mjs";
import { nextAction, describe, ACTIONS } from "./watcher.mjs";
import { reconcilePr } from "./github/reconciler.mjs";
import { capacity, stayAwake, halted, runWorker, workerArgs, statedBlocker, OUTCOMES } from "./supervisor.mjs";
import { promptFor, WORKER_ACTIONS, UNBUILT_ACTIONS } from "./prompts.mjs";
import { sandboxFor, writeSandbox, reviewDiff, validateSettings, validateToolGrant, scopeGrant, quarantineOsDenies, sourceCheckoutOf, siblingRootsOf } from "./sandbox.mjs";
import { verifyConfig, GIT_NEUTRALISE, gitEnv } from "./gitguard.mjs";
import { prepareRunCheckout, publishRunWork, releaseRunCheckout, dependencyPathsFor } from "./checkout.mjs";
import { rootCause, resolveFailureCause, flakeAssessment } from "./ci-rootcause.mjs";
import { workerEnv, writeGitConfig, readOauthToken, workerHomeFor } from "./workerenv.mjs";
import { measureContainment, revalidateContainment, probeKeychain, isolationTopologyReady, cheapContainmentReasons, binaryIdentity } from "./containment.mjs";
import { canaryIdFor, netListener } from "./canary.mjs";
import { readState, noteTick, cleanMergeRate } from "./status.mjs";
import { buildAlert, notify, printable } from "./notify.mjs";
import { countFixAttempts, recordFixAttempt, fixAttemptNote, noteFixAttempt, refundFixAttempt, startRun, notePid, finishRun, heartbeat, LEASE_SECONDS, recordWorkerContract, noteWorkerResult, noteWorkerBinding, bindRun, cancelRequested, sha256 } from "./db/ops.mjs";
import { writeDash } from "./dash.mjs";
import { snapshot, snapshotAll } from "./backup.mjs";
import { selfAudit } from "./selfaudit.mjs";
import { observe, ingest, noteHead } from "./review/ingest.mjs";
import { derivePr, deriveSupply, reviewState } from "./review/derive.mjs";
import { compare, record as recordShadow, streak } from "./review/shadow.mjs";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, fstatSync, statSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

const now = () => Math.floor(Date.now() / 1000);

// Read once per binary: the CLI version is part of every worker's contract,
// and asking on every dispatch would be a subprocess per tick for an answer
// that does not change. Resolved under the WORKER's environment, because the
// daemon's own PATH (launchd's) may not even hold the binary the worker runs;
// a version that cannot be read is a refusal, never the string "unknown".
// Keyed by the binary's real path and modification time, so an upgrade under a
// running daemon is re-read on the next dispatch rather than recorded as the
// version that was true at startup.
const CLI_VERSION = new Map();
// A PR whose worker could not be PREPARED (no binary, no contract table) would
// otherwise be leased, failed, refunded, and retried on every tick forever,
// with no one told. Failures back off per PR (doubling, capped at an hour)
// and stand as one escalation until a preparation succeeds. The map lives on
// the daemon's context: one per daemon, not one per module.
const PREP_BACKOFF_BASE_MS = 60_000, PREP_BACKOFF_CAP_MS = 3_600_000;
// The worker's PATH is pinned and does not contain the CLI's install dir (it
// lives under ~/.local/bin here), and spawn resolves a bare command through the
// CHILD's PATH. So the binary is resolved once on the daemon's PATH and passed
// by absolute path; a CLI that cannot be found is a refusal, not a guess.
let CLAUDE_BIN = null;
function resolveClaude(bin) {
  if (bin.startsWith("/")) return bin;
  if (CLAUDE_BIN) return CLAUDE_BIN;
  const out = execFileSync("which", [bin], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }).trim();
  if (!out) throw new Error(`${bin} is not on the daemon's PATH`);
  CLAUDE_BIN = out;
  return out;
}
function cliVersion(bin, env) {
  const key = binaryIdentity(bin);
  if (CLI_VERSION.has(key)) return CLI_VERSION.get(key);
  // Bounded: a stalled probe would freeze the tick and let the run's lease lapse.
  const out = execFileSync(bin, ["--version"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }).trim();
  if (!out) throw new Error(`${bin} --version printed nothing`);
  CLI_VERSION.set(key, out);
  return out;
}

// Whether this process's stdout already points at the log file. launchd's
// StandardOutPath names the very file the daemon appends to, so echoing as well
// writes every line twice — and the shadow week counts its evidence from this
// file, which makes a quiet night read as a busy one. Compared by (dev, ino)
// rather than by path, because a redirect leaves no path to compare. Cached per
// path: a daemon's stdout does not change underneath it.
const stdoutIsFile = new Map();
function stdoutAlreadyWrites(logPath) {
  if (stdoutIsFile.has(logPath)) return stdoutIsFile.get(logPath);
  let same = false;
  try {
    const out = fstatSync(1), file = statSync(logPath);
    same = out.dev === file.dev && out.ino === file.ino;
  } catch { same = false; }   // a pipe, a tty or an unreadable path is never the log
  stdoutIsFile.set(logPath, same);
  return same;
}

// Beat at a quarter of the lease: frequent enough that a live worker never lets
// its lease lapse, rare enough to cost nothing. Derived from LEASE_SECONDS rather
// than chosen, so the two cannot drift apart.
const HEARTBEAT_MS = (LEASE_SECONDS / 4) * 1000;

/**
 * Attempts already spent on this cause. A store that cannot be read does not
 * report zero: an unknown count returns the cap, so the decision blocks rather
 * than handing out a retry it cannot justify.
 */
function attemptsFor(db, nwo, pr, fp, logPath) {
  try { return countFixAttempts(db, nwo, pr, fp); }
  catch (err) {
    log(logPath, `  #${pr}: could not read fix attempts (${err.message}) — treating as exhausted`);
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Files the worker actually changed, staged or not. Read from git rather than
 * from anything the worker says about itself: the whole point of this gate is
 * that the actor does not get to be the only witness.
 */
/**
 * The paths a worker changed but never COMMITTED.
 *
 * Publishing moves commits, not working trees: reeve fetches the checkout's
 * branch into its own repository and pushes from there. So an uncommitted edit
 * passes the diff gate, is counted in "published N file(s)", and is then deleted
 * with the checkout, having never left the machine. (Codex #5-[2].)
 */
function uncommittedFiles(worktree) {
  try {
    const out = execFileSync("git", ["-C", worktree, ...GIT_NEUTRALISE, "status", "--porcelain"], { encoding: "utf8", env: gitEnv() }).trim();
    return out ? out.split("\n").map(l => l.slice(3).trim().split(" -> ").pop()).filter(Boolean) : [];
  } catch { return null; }
}

/**
 * Does the work about to be published carry a secret reeve itself handed over?
 *
 * A worker holds a working OAuth token in its environment, because it needs one
 * to run, and it is granted language runtimes that can read that environment. The
 * diff gate judges FILENAMES, so a token written into an ordinary source file
 * passes it, and reeve — not the worker — then pushes it. Denying the network
 * does not close that route: the daemon is the one that publishes. (Codex #5-[3].)
 *
 * This is a literal match, and it is honest about being one: a worker that
 * encodes the value walks around it. It costs nothing, it closes the accidental
 * case and the obvious deliberate one, and the residual is stated in the docs
 * rather than papered over. The value is never logged.
 */
async function diffCarriesSecret(worktree, since, ref, secrets) {
  const present = secrets.filter(x => typeof x?.value === "string" && x.value.length >= 16);
  if (!present.length) return null;
  // EVERY newly reachable object, not the net patch.
  //
  // A push carries commits, so it carries every intermediate one. A worker that
  // committed the token and deleted it in a later commit left a clean net diff
  // and published the secret blob anyway. Binary blobs never appear in patch
  // text at all. So the check walks the objects the push would add: every blob,
  // and every commit's message and identities. (Codex #5-[13], #5-[7].)
  //
  // STREAMED, not buffered. `cat-file --batch` over a range containing large
  // assets exceeded the child-output limit, and the catch path then refused a
  // perfectly good publication as unreadable — a check that fails closed on
  // size is a check that stops the work for the wrong reason. It scans as the
  // bytes arrive, keeping only an overlap between chunks so a value split
  // across a boundary is still found. (Codex #7-[3].)
  const hit = t => present.find(sx => t.includes(sx.value)) ?? null;
  const longest = Math.max(...present.map(sx => sx.value.length));
  // Enough of the previous chunk is carried forward that a value split across a
  // read boundary is still whole in the next scan.
  const overlap = Math.max(0, longest - 1);
  let objs;
  try {
    const run = args => execFileSync("git", ["-C", worktree, ...GIT_NEUTRALISE, ...args],
                                     { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: gitEnv() });
    const meta = hit(run(["log", `${since}..${ref}`, "--format=%B%n%an%n%ae%n%cn%n%ce"]));
    if (meta) return { label: meta.label, why: `the change carries ${meta.label}` };
    objs = run(["rev-list", "--objects", "--no-walk=unsorted", `${since}..${ref}`])
      .split("\n").map(l => l.split(" ")[0]).filter(Boolean);
  } catch { return { label: "unreadable", why: "reeve could not read the change to check it for its own credentials" }; }
  if (!objs.length) return null;

  // Truly streamed: the bytes are scanned as they arrive and never held whole.
  // A window keeps an overlap of one value's length so a match straddling a
  // chunk boundary is still seen, and the child is killed the moment one is.
  // Latin-1 rather than UTF-8, because the objects are arbitrary bytes and a
  // decoder that replaces invalid sequences could destroy what is being sought.
  return await new Promise(resolve => {
    const child = spawn("git", ["-C", worktree, ...GIT_NEUTRALISE, "cat-file", "--batch"], { env: gitEnv() });
    let tail = "", done = false;
    const finish = v => { if (done) return; done = true; try { child.kill("SIGKILL"); } catch { /* already gone */ } resolve(v); };
    child.on("error", () => finish({ label: "unreadable", why: "reeve could not read the change's objects to check them for its own credentials" }));
    child.stdout.on("data", buf => {
      const chunk = tail + buf.toString("latin1");
      const found = hit(chunk);
      if (found) return finish({ label: found.label, why: `the change carries ${found.label}` });
      tail = chunk.slice(-overlap);
    });
    child.on("close", code => finish(done ? null : (code === 0 ? null
      : { label: "unreadable", why: "reeve could not read the change's objects to check them for its own credentials" })));
    child.stdin.on("error", () => { /* a killed child closes the pipe; the close handler answers */ });
    child.stdin.end(objs.join("\n") + "\n");
  });
}

/** Where a named branch points inside a checkout, or null if it cannot be read. */
function branchHead(worktree, branch) {
  if (!branch) return null;
  try {
    return execFileSync("git", ["-C", worktree, ...GIT_NEUTRALISE, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
                        { encoding: "utf8", env: gitEnv() }).trim() || null;
  } catch { return null; }
}

function changedFiles(worktree, since = null, ref = "HEAD") {
  // The same 64 MiB the secret scanner reads under. `execFileSync` buffers 1 MiB
  // by default and throws ENOBUFS past it, which a per-commit path walk reaches
  // sooner than it looks: measured 2026-08-22, one commit of 1,800 files under
  // long directory names produced 1,123,200 bytes of pathnames on its own.
  const run = args => {
    try { return execFileSync("git", ["-C", worktree, ...GIT_NEUTRALISE, ...args],
                              { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: gitEnv() }); }
    catch { return null; }
  };

  // Uncommitted work, for a worker that stopped part-way.
  //
  // NUL-separated, because git's default output QUOTES any path holding a
  // non-ASCII byte or a newline: `secrets/kéy.txt` arrives as
  // `"secrets/k\303\251y.txt"`, and that leading quote means the risk globs
  // stop matching. Measured 2026-08-22 — reviewDiff returned ok for the quoted
  // form of a path it refused in raw form, so a sensitive file published itself
  // by being named in a language with accents.
  const dirty = run(["status", "--porcelain", "-z"]);
  if (dirty === null) return null;   // could not ask, which reviewDiff refuses on its own terms
  // Porcelain -z: two status columns, a space, then the path, verbatim.
  const uncommitted = [];
  const records = dirty.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const path = record.slice(3);
    if (path) uncommitted.push(path);
    // A rename or copy carries its SOURCE as the NEXT record, with no status
    // columns of its own. Both paths are judged: a worker that renames a
    // sensitive file to a harmless name has still touched the sensitive one,
    // and the "old -> new" parser this replaces kept only the destination.
    if (/[RC]/.test(record.slice(0, 2))) { const source = records[++i]; if (source) uncommitted.push(source); }
  }

  // And COMMITTED work, which is what a worker that finished produces. The prompt
  // tells it to commit; committing leaves a clean tree; and reading only the tree
  // therefore reported a complete, correct, committed fix as "nothing was changed"
  // and refused to publish it. The instrument could not represent the success case
  // it was written to check.
  //
  // EVERY commit's paths, not the range's endpoints. `--name-only` over a range
  // names what the DIFF contains, so a worker that touched a sensitive or
  // out-of-territory path in one commit and restored it in a later one showed
  // nothing at the endpoints — while the push still carries that commit and its
  // objects, and the diff gate had approved it. `--name-only` with `-m` over the
  // whole range names the paths of each commit in it. (Codex #7-[8].)
  //
  // `--no-renames` because rename detection is ON by default and collapses a
  // rename to its DESTINATION alone: measured 2026-08-22, moving
  // `secrets/key.txt` to `public.txt` reported `public.txt` and nothing else,
  // so the gate never saw the sensitive path the commit carried away.
  //
  // A failed read is `null` here exactly as it is for the status above, and is
  // returned as such. `?? ""` read an UNREADABLE range as an EMPTY one, so a
  // large completed fix was refused with "the worker produced an empty diff —
  // nothing was changed": a reason that is not true, and one that sends whoever
  // reads it to look at the worker instead of at the read. (Codex #10-[2].)
  let fromCommits = [];
  if (since) {
    const committed = run(["log", "--no-ext-diff", "--name-only", "--no-renames", "--pretty=format:", "-m", "-z", `${since}..${ref}`]);
    if (committed === null) return null;
    fromCommits = committed.split("\0").filter(Boolean);
  }

  return [...new Set([...fromCommits, ...uncommitted])];
}

/**
 * The measured containment verdict for this daemon: the CLI it would dispatch,
 * the environment it would hand a worker, and the sandbox block every worker
 * runs under, put to the canary once per (CLI build, block) and to the
 * keychain probe every time. A preparation that fails (no CLI, no worktree
 * root) is an OPEN verdict with the reason, never a thrown tick.
 */
/**
 * The reeve-owned trees a worker must not read, as SPECIFIC paths.
 *
 * Never `dirname(logPath)`: with `--log ~/reeve.log` that is the home directory,
 * and denying it also denies the worktree the fixer was dispatched to read — the
 * boundary would break the work instead of containing it. So: the log file, the
 * run artifacts, the canary records, the backups, and the configured state root.
 * Any candidate that is an ANCESTOR of the worktree is dropped for the same
 * reason, and `~/.reeve` is denied by `credentialPaths()` regardless.
 * (Codex #4e-[5].)
 */
export /** The daemon's log path, always absolute: everything else is derived from it. */
function logPathOf(ctx) { return ctx.logPath ? resolve(ctx.logPath) : "/tmp/x"; }

export function stateRootsFor(stateDir, logPath, worktree, dbPath = null) {
  const under = (p, child) => child === p || child.startsWith(p.endsWith("/") ? p : p + "/");
  // The database the daemon was pointed at, with its WAL and shared-memory
  // files: `--db` can name a path outside every other protected tree, and it
  // holds the event history, prompts and operational state. (Codex #4f-[7].)
  const dbFiles = dbPath ? [dbPath, `${dbPath}-wal`, `${dbPath}-shm`] : [];
  const cands = [logPath, ...dbFiles, join(stateDir, "runs"), join(stateDir, "canary"), join(stateDir, "backups"), process.env.REEVE_HOME]
    .filter(p => p && isAbsolute(p));
  return [...new Set(cands)].filter(p => !(worktree && under(p, worktree)));
}

/**
 * The containment verdict the daemon acts on: cheap gates first, then the paid
 * sandbox canary. Exported so `reeve canary` can run exactly this, rather than a
 * reconstruction of it that could drift from what dispatch actually does.
 */
export async function measuredContainment(ctx, profile, nwo, logPath) {
  const cache = (ctx.containmentCache ??= new Map());
  try {
    const root = profile.identity?.worktreeRoot;
    if (!root || !isAbsolute(root)) return { credentialRead: "open", why: "no absolute identity.worktreeRoot to run the canary under" };
    // Cheap gates FIRST: on a host where the verdict is already open, preparing a
    // canary would create a per-invocation tmp tree every tick that nothing then
    // cleans up, because the canary itself never runs. (Codex #4e-[9].)
    // Only an arrangement reeve has actually BUILT can close containment. A
    // profile that declares "dedicated-user" is declaring something that does
    // not exist yet, and saying so is better than quietly treating it as the
    // weaker thing that does.
    const mode = profile.worker?.isolation ?? "none";
    const isolated = mode === "scratch-home" && (ctx.isolationReady ?? isolationTopologyReady)();
    if (mode === "dedicated-user") log(logPath, `  containment: worker.isolation is "dedicated-user", which is not built; use "scratch-home"`);
    const cheapKc = typeof ctx.keychain === "function" ? await ctx.keychain() : ctx.keychain ?? null;
    const cheap = cheapContainmentReasons({ platform: ctx.platform ?? process.platform, isolated, keychain: cheapKc });
    if (cheap.reasons.length) {
      return { credentialRead: "open", why: cheap.reasons.join("; "),
               canary: { ok: false, id: null, why: "not run: containment is already open for a cheaper reason", skipped: true },
               keychain: cheap.keychain, platform: ctx.platform ?? process.platform, isolated, at: Date.now() };
    }
    const stateDir = dirname(logPathOf(ctx));
    // The canary result is read back by `reeve doctor`, which looks under a
    // fixed home, so it is written there too — never under a --log directory
    // that doctor would not know to read. (Codex #4-[4].)
    const canaryStateDir = ctx.canaryStateDir ?? stateDir;
    // Per repository AND per invocation for ALL of the canary's working
    // directories, not just the decoy: two daemons (same repo, or repos sharing
    // a worktree root) each rm/recreate these during a run up to 5 min long, and
    // the cross-run deletion keeps containment open forever. (Codex #4d-[16].)
    const inv = `${nwo.replace("/", "-")}-${process.pid}-${Date.now()}`;
    const canaryRoot = join(root, ".reeve-canary", inv);
    const canaryPaths = {
      dir: join(canaryRoot, "run"), outsideDir: join(canaryRoot, "outside"), tmpDir: join(canaryRoot, "tmp"),
      // Under the CONFIGURED state root (deny-read, so it is measurable), per
      // repository AND per invocation: two daemons sharing one decoy could delete
      // each other's and read the ENOENT as a denial. (Codex #4-[1], #4b-[11].)
      decoyPath: join(process.env.REEVE_HOME ?? join(homedir(), ".reeve"), "canary", nwo.replace("/", "-"), `decoy-${process.pid}-${Date.now()}.txt`),
    };
    const claudeBin = resolveClaude(ctx.claudeBin ?? "claude");
    // The credential-less git config lives in the run's tmp, which the sandbox
    // grants read: putting it under ~/.reeve (deny-read) left the sandboxed git
    // unable to read its own configured global config, so the worker could not
    // even commit. (Codex #4-[8].)
    // A home of reeve's making, outside the deny-read state tree: with the
    // founder's home a worker reads their keychain, which no setting can deny.
    const workerHome = workerHomeFor(root, nwo);
    const token = (ctx.oauthToken ?? readOauthToken)();
    if (!token?.ok) return { credentialRead: "open", why: `no worker authentication token: ${token?.why ?? "unreadable"}` };
    const env = workerEnv({ gitConfigPath: writeGitConfig(join(canaryPaths.tmpDir, "git")), tmpDir: canaryPaths.tmpDir,
                            bgWaitMs: 5 * 60_000, extraPath: [dirname(claudeBin)],
                            home: workerHome, oauthToken: token.token });
    const version = ctx.cliVersion ?? cliVersion(claudeBin, env);
    // The block every worker gets; the canary's id covers it, so a block that
    // changes (a new deny, a new domain) is measured again before it is trusted.
    // The reeve-owned trees are denied to workers too; the canary proves the
    // block that includes them. (Codex #4d-[15], #4e-[5].)
    const stateRoots = stateRootsFor(stateDir, logPathOf(ctx), canaryPaths.dir, ctx.dbPath ?? null);
    const policy = sandboxFor({ profile, action: "FIX_CI", worktree: canaryPaths.dir, tmpDir: canaryPaths.tmpDir, stateRoots });
    // The resolved binary's identity is part of the canary id, so a swapped
    // executable that prints the same --version is re-measured. (Codex #4-[3].)
    const binaryId = binaryIdentity(claudeBin);
    // The network positive control is a daemon-local listener the sandboxed curl
    // tries to reach. The daemon knows the listener is reachable (it self-pings),
    // so a sandboxed curl that cannot reach it proves a DENIAL — no external
    // dependency, no timing window, and a hit at any point in the run is a leak.
    // (Codex #4d-[12], #4c-[13].) Injectable for tests.
    const netProbe = ctx.netProbe ?? netListener();
    // Computed exactly as measureContainment computes it. A cache key that
    // drifts from the id is how every tick came to pay for a five-minute canary.
    const before = cache.get(canaryIdFor({ cliVersion: version, sandbox: policy.settings.sandbox, binaryId, worktree: canaryPaths.dir,
                                           permissionsDeny: policy.settings.permissions.deny, allowedTools: policy.allowedTools }))?.ok === true;
    if (!before) log(logPath, `containment: running the sandbox canary under ${version}`);
    let c;
    try {
      c = await measureContainment({
      cliVersion: version, sandbox: policy.settings.sandbox, permissionsDeny: policy.settings.permissions.deny,
      allowedTools: policy.allowedTools, binaryId,
      canaryPaths, bin: claudeBin, env, stateDir: canaryStateDir, nwo, cache, netProbe, stateRoots,
      // process.platform in production; injectable so a test on one OS can
      // exercise the verdict for another (the fail-closed matrix is per-OS).
      platform: ctx.platform ?? undefined,
      // The profile LABEL is necessary but not sufficient: it closes containment
      // only when the topology it names is actually in place. The scratch-home
      // arrangement (a home of reeve's making, a per-run standalone clone, a
      // token instead of ~/.claude) is built, so this reads true; it stays a
      // seam because the next topology will not be. (Codex #4c-[9].)
      isolated,
      canary: ctx.canary ?? null, keychain: cheap.keychain,
      });
    } finally {
      // The listener is torn down whatever happened, so a canary run never
      // leaves a socket bound.
      if (!ctx.netProbe) netProbe.close?.();
      // And so is the per-invocation tree, unless the canary itself is the one
      // holding it. sandboxCanary is the only code that removes these paths, and
      // it never runs on a cache hit -- so every tick under a cached pass left
      // another directory behind, each with a git config and the shims in it. A
      // FAILED canary keeps its own directory for evidence, which is why this
      // removes the tree only when the canary did not run. (Codex #5-[6].)
      if (c?.canary?.skipped || c?.canary?.cached) rmSync(canaryRoot, { recursive: true, force: true });
    }
    if (!before) log(logPath, `containment: canary ${c.canary?.id ?? "?"} ${c.canary?.ok ? "passed" : `FAILED: ${c.canary?.why}`}; keychain: ${c.keychain?.measured ? (c.keychain.items.length ? c.keychain.why : "no GitHub credential") : `unmeasured (${c.keychain?.why})`}`);
    return c;
  } catch (err) {
    return { credentialRead: "open", why: `containment could not be measured: ${err.message}` };
  }
}

export function log(logPath, line) {
  // `printable`, because a line can carry a pathname a pull request chose, and a
  // newline in one forges a log entry while an ANSI sequence rewrites what a
  // human reading the log sees. One boundary rather than one escape per call
  // site: the next thing that logs a worker-supplied string is covered too.
  const stamped = `${new Date().toISOString()} ${printable(line)}`;
  if (!logPath) { console.log(stamped); return; }
  let appended = false;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, stamped + "\n");
    appended = true;
  } catch { /* logging must never kill the loop */ }
  // Stat after the append, so the first line of a fresh log has a file to compare.
  if (!appended || !stdoutAlreadyWrites(logPath)) console.log(stamped);
}

/**
 * Is this pull request finished -- merged or closed?
 *
 * Asked ONLY about a PR that already holds a standing escalation and is missing
 * from the open list, and answered by GitHub rather than by that absence. The
 * open list is capped, so a PR beyond the cap is unread rather than gone, and
 * retiring a human's escalation on that would be absence read as success again.
 *
 * Anything other than a clear MERGED or CLOSED leaves the escalation standing.
 */
function prIsFinished(nwo, pr) {
  try {
    const out = execFileSync("gh", ["pr", "view", String(pr), "--repo", nwo,
      "--json", "state", "--jq", ".state"], { encoding: "utf8" }).trim();
    return out === "MERGED" || out === "CLOSED";
  } catch { return false; }
}

/**
 * PRs whose escalation should retire because the PR itself is over.
 *
 * Measured on nextly #1127: it merged, left the open list, and could therefore
 * never be evaluated again -- so its escalation could never be retired and sat in
 * NEEDS YOU permanently. A surface whose target state is empty fills up with
 * finished work, and an operator stops reading it. That is the same muting the
 * repeat-push guard exists to prevent, arriving from the other direction.
 */
function finishedSubjects(db, nwo, open, io = {}) {
  const isFinished = io.prIsFinished ?? prIsFinished;
  const gone = new Set();
  let rows = [];
  try { rows = db.prepare("SELECT why FROM escalation").all(); } catch { return gone; }
  for (const { why } of rows) {
    const m = why.match(/^#(\d+):/);
    if (!m) continue;
    const pr = Number(m[1]);
    if (open.has(pr) || gone.has(pr)) continue;
    if (isFinished(nwo, pr)) gone.add(pr);
  }
  return gone;
}

function openPrs(nwo, limit = 20) {   // bounded; the caller LOGS when the bound bites
  try {
    const out = execFileSync("gh", ["pr", "list", "--repo", nwo, "--state", "open",
      "--limit", String(limit), "--json", "number", "--jq", ".[].number"], { encoding: "utf8" }).trim();
    return out ? out.split("\n").map(Number) : [];
  } catch { return null; }   // null means "could not ask", which is not "none"
}

/**
 * Record what a tick decided, so the dashboard and `reeve why` can answer without
 * re-deriving anything, and so a restart knows how long a clause has been UNKNOWN.
 */
function record(db, { pr, head, verdict, decision }) {
  try {
    db.prepare(`INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)`)
      .run(now(), "daemon", "pr.decided", `pr:${pr}`, JSON.stringify({
        head, state: verdict.state, summary: verdict.summary,
        action: decision.action, why: decision.why,
        clauses: verdict.clauses.map(c => ({ id: c.id, state: c.state })),
      }));
  } catch { /* a store that cannot record must not stop the loop */ }
}

/** How long has this PR been sitting in UNKNOWN? Read from the event log, not memory. */
function unknownSince(db, pr) {
  try {
    const rows = db.prepare(
      `SELECT at, payload FROM event WHERE subject = ? AND op = 'pr.decided' ORDER BY seq DESC LIMIT 30`
    ).all(`pr:${pr}`);
    let since = null;
    for (const r of rows) {
      const p = JSON.parse(r.payload);
      if (p.state === "UNKNOWN") since = r.at; else break;
    }
    return since;
  } catch { return null; }
}

/**
 * One pass over one project.
 * @returns {{decisions: object[], escalations: Map, halted: boolean}}
 */
// `ctx` may override evaluate, publish, spawnWorker, openPrs and resolveCause. The dispatch
// path is the one place where a mistake costs real work, and it was the only
// path with no test at all -- because driving it otherwise needs GitHub and a
// live `claude`. A ReferenceError sat in it undetected for exactly that reason.
export async function tick(ctx) {
  const { nwo, profile, db, execute = false, shadow = true } = ctx;
  // Absolute, once, before ANYTHING derives from it. A relative `--log` made
  // every state path relative — the run dir, the worker's tmp, its git config and
  // the `--settings` argument — and those are consumed after the worker's cwd has
  // become the WORKTREE, so the file it was handed was not the file that was
  // validated; the state denies silently vanished as well, because they are
  // filtered to absolute paths. (Codex #4f-[1].)
  const logPath = ctx.logPath ? resolve(ctx.logPath) : ctx.logPath;
  if (logPath !== ctx.logPath) ctx = { ...ctx, logPath };
  const decisions = [];
  const escalations = new Map();

  if (halted(ctx.haltMarker)) {
    log(logPath, `HALTED: ${ctx.haltMarker} exists — no work will be started`);
    return { decisions, escalations, halted: true };
  }

  const prs = (ctx.openPrs ?? openPrs)(nwo, profile.watch?.maxOpenPrs ?? 20);
  if (prs === null) {
    // Could not ask is not none. Returning an empty list here would look exactly
    // like a quiet, healthy fleet.
    log(logPath, `tick: could not list PRs for ${nwo} — skipping this pass rather than assuming zero`);
    return { decisions, escalations, halted: false, unreadable: true };
  }
  // A cap that does not say it capped reads as "covered everything". The portfolio
  // includes repositories with 100 open pull requests against a bound of 20, and
  // it is always the SAME 20 -- so the remainder would never be looked at once,
  // silently, forever.
  const CAP = profile.watch?.maxOpenPrs ?? 20;
  log(logPath, `tick: ${nwo} — ${prs.length} open PR(s)` +
      (prs.length >= CAP ? ` — AT THE ${CAP} CAP: any beyond this are not being watched at all` : ""));

  const evaluated = new Set();
  // Evaluated is not the same as settled. A PR whose decision this tick is WAIT
  // was looked at and found to be IN FLIGHT, which says nothing about whether the
  // human-needed condition behind its escalation still holds.
  const waiting = new Set();
  for (const pr of prs) {
    if (halted(ctx.haltMarker)) { log(logPath, "HALTED mid-tick"); return { decisions, escalations, halted: true }; }

    const e = (ctx.evaluate ?? evaluatePr)({ nwo, pr, profile, db });
    if (!e.ok) { log(logPath, `  #${pr}: could not evaluate — ${e.why}`); continue; }

    // GitHub is authoritative for PR facts; this is also what releases a lease
    // when a PR merges.
    evaluated.add(pr);
    const rec = reconcilePr(db, { nwo, pr, profile });
    if (rec.ok && rec.released) log(logPath, `  #${pr}: released ${rec.released} lease(s) — PR merged`);

    // Review ingest, in SHADOW: it writes and nothing reads. Landing raw
    // observations now means the derivation that comes next has history to fold
    // rather than starting from whatever it happens to see on its first tick.
    //
    // Skipped unless the PR moved, because re-polling a quiet PR costs API quota
    // for rows the content key would reject anyway. `updatedAt` is GitHub's, so a
    // change reeve has not seen yet still triggers a read.
    if (ctx.reviewIngest !== false && e.ok) {
      noteHead(db, nwo, pr, e.head);
      // `updatedAt` is NOT a complete change signal for review state. MEASURED
      // 2026-08-22 on revnix/reeve #4: resolving a thread, and unresolving one,
      // leave `pull_request.updated_at` byte-identical. So on a pull request
      // whose only activity is threads being resolved or reopened -- which is
      // most of a review's life -- this guard skips the ingest forever and the
      // projection keeps counts that stopped being true.
      //
      // That is the fail-OPEN direction for PR-5: the verdict would read fewer
      // unresolved threads than exist. It also starves the shadow, because a
      // tick that does not observe has no snapshot to compare.
      //
      // So the projection is refreshed when the pull request moved OR when what
      // reeve holds is older than the window the fold itself calls stale. A
      // quiet pull request costs one observation per window, not one per tick.
      const staleAfter = (profile?.watch?.staleSeconds ?? 900) * 1000;
      const last = ctx.lastIngest?.get?.(pr) ?? null;
      const moved = !last || last.updatedAt !== e.updatedAt || (now() * 1000) - last.at >= staleAfter;
      // Whether this tick's ingest changed anything, which decides below whether
      // the live read taken back in evaluate() still describes the same moment
      // as the projection.
      // The live side of the shadow comparison, taken from the SAME read that
      // feeds the ingest below. Null when this tick did not observe.
      let snapshot = null;
      if (moved) {
        try {
          const seen = (ctx.observe ?? observe)(nwo, pr);
          const w = (ctx.ingest ?? ingest)(db, nwo, pr, seen.observations, { at: now() });
          // AFTER the ingest, not before it. An ingest that throws leaves the
          // projection built from the PREVIOUS inbox, so an observation that
          // never reached the database is not a reading of the same moment —
          // and comparing them would record a storage failure as the derivation
          // disagreeing, which is the exact confusion this whole change removes.
          // (Codex #6-[2].)
          snapshot = seen.threads ?? null;
          if (w.inserted || w.generations) {
            log(logPath, `  #${pr}: ingest +${w.inserted} new, +${w.generations} edit(s)` +
                         `${seen.incomplete ? " — INCOMPLETE read" : ""}`);
          }
          // Only a COMPLETE read updates the watermark. Skipping a PR on the
          // strength of a partial read is how a gap becomes permanent.
          if (!seen.incomplete) (ctx.lastIngest ??= new Map()).set(pr, { updatedAt: e.updatedAt, at: now() * 1000 });
          // And whether it was whole is carried to the fold. Positively named and
          // fail-closed: a pull request reeve has never wholly observed is NOT
          // complete, so it answers UNKNOWN rather than confidently from a
          // partial view.
          (ctx.ingestComplete ??= new Map()).set(pr, !seen.incomplete);
        } catch (err) {
          log(logPath, `  #${pr}: ingest failed — ${err.message}`);
        }
      }
      // Derived EVERY tick, even when ingest was skipped: clearing depends on the
      // head under judgement, so a push with no new review still changes the
      // answer -- it un-clears everything until a reviewer speaks at the new head.
      try {
        const d = (ctx.derivePr ?? derivePr)(db, nwo, pr, profile,
          { at: now(), head: e.head, complete: ctx.ingestComplete?.get?.(pr) === true });
        const st = (ctx.reviewState ?? reviewState)(db, nwo, pr, profile, { at: now() });
        if (st.readable && (st.open || st.unspilledCritical)) {
          log(logPath, `  #${pr}: review ${st.open}/${st.total} open, ` +
                       `${st.unspilledCritical} blocking, round ${st.rounds} (shadow)`);
        } else if (!st.readable) {
          log(logPath, `  #${pr}: review projection not readable — ${st.why}`);
        }
        void d;

        // The shadow comparison. e.threads is the LIVE read the verdict already
        // trusts, so this asks the only question that matters before PR-5 swaps
        // them over: does the derived view say the same thing?
        //
        // Both readings must describe the SAME MOMENT. They did not: the live
        // read happens inside evaluate(), the ingest above runs after it, and
        // the projection is built from what that ingest just wrote — so a pull
        // request that moved in between was recorded as the derivation
        // disagreeing, which is a different claim entirely.
        //
        // Measured 2026-08-22: every one of the week's four recorded
        // divergences AGREED exactly when the pair was taken together, and the
        // probe's own ingest was still inserting five threads on #1128 — the
        // very count that PR's divergence reported.
        // (docs/measured/2026-08-22-the-shadow-compared-two-moments.md)
        //
        // The live side is the observation that FED the projection, not a second
        // read taken after it: a second read is a second moment, and re-reading
        // only narrows the window rather than closing it. There is no extra API
        // call either — `observe` already paginates the whole thread set, so the
        // counts come from a read reeve was making anyway.
        //
        // A tick that did not observe has no snapshot, and comparing the older
        // projection against anything would be comparing two moments again. That
        // is INCOMPARABLE: a tick where nothing was learned, counted as neither
        // agreement nor disagreement. It costs volume on quiet pull requests,
        // and buys an instrument whose every remaining comparison is sound.
        const cmp = snapshot
          ? compare(snapshot, st)
          : { comparable: false, agree: false, why: "no observation this tick to compare the projection against" };
        recordShadow(db, nwo, pr, cmp, now());
        if (cmp.comparable && !cmp.agree) {
          log(logPath, `  #${pr}: SHADOW DIVERGENCE — ${cmp.why}`);
        }
      } catch (err) {
        log(logPath, `  #${pr}: derive failed — ${err.message}`);
      }
    }

    // The root cause is resolved BEFORE the decision, not after it. The watcher's
    // retry cap reads `h.fingerprint`, and the daemon never supplied one -- so the
    // cap read zero attempts every time and could not fire at all. Resolving it
    // here costs nothing extra: the same cause is reused for the worker's prompt
    // below, where it used to be computed a second time.
    // Every failing check is read, not just the first. Where CI ends in an
    // aggregate gate, the first failure is the gate, whose message is the same
    // sentence whatever broke -- an identity two unrelated failures would share
    // and a cause that names nothing for the worker to reproduce.
    const red = e.checks?.verdict === "RED" && (e.checks?.failing ?? []).length > 0;
    let cause = null, fp = null;
    if (red) ({ cause, fp } = resolveFailureCause(nwo, e.checks, ctx.resolveCause ?? rootCause));

    const decision = nextAction(e, profile, {
      now: now(),
      unknownSince: unknownSince(db, pr),
      // From the store, not from a map rebuilt empty on every tick.
      fingerprint: fp,
      // Guarded: an unreadable store must not take down the whole tick, and a
      // count that cannot be read is not zero. Unknown attempts block rather
      // than grant a free retry.
      fixAttempts: fp ? new Map([[fp, attemptsFor(db, nwo, pr, fp, logPath)]]) : new Map(),
    });

    record(db, { pr, head: e.head, verdict: e.verdict, decision });
    if (decision.action === ACTIONS.WAIT) waiting.add(pr);
    // Carried on the entry rather than left in this block's scope: the dispatch
    // loop below is a SEPARATE block, and reaching for these there threw a
    // ReferenceError on every FIX_CI the moment --execute was on.
    decisions.push({ e, decision, cause, fp });
    log(logPath, "  " + describe(e, decision));

    // Republish on every tick: a verdict is bound to a revision, so when the head
    // moves the old check stops applying to anything. Without this the shadow
    // record silently decays to nothing.
    const pub = await (ctx.publish ?? publishVerdict)({ nwo, verdict: e.verdict, shadow });
    if (!pub.ok) log(logPath, `    could not publish: ${pub.why}`);

    // A shared cause is one problem, not N. Four PRs blocked on a red base is a
    // single escalation, or the phone becomes noise and gets muted.
    if (decision.shared) escalations.set(decision.why, (escalations.get(decision.why) ?? 0) + 1);
    else if (decision.action === ACTIONS.ESCALATE) {
      // "The same failure survived a second fix" assumes a fix was attempted. When
      // the previous worker declined -- because the change belonged to a human --
      // nothing survived anything, and a founder reading that goes looking for a
      // bad fix that was never made. The reason it gave is carried on the ledger
      // row for exactly this moment.
      const note = fp ? fixAttemptNote(db, nwo, pr, fp) : null;
      escalations.set(note ? `#${pr}: needs a human — ${note}` : `#${pr}: ${decision.why}`, 1);
    }
  }

  // A worker that can read the founder's credentials is not dispatched, whatever
  // --execute says. Containment is MEASURED, on this host, under this CLI and
  // this sandbox block (containment.mjs): the sandbox canary must have passed
  // and the login keychain must hold no GitHub credential. Anything unmeasured
  // is open, and the founder is told once, by identity. The verdict is
  // injectable for tests only; the default measures, and measures only when a
  // worker task actually wants dispatching, so a quiet tick runs no canary.
  const wanted = decisions.filter(d => WORKER_ACTIONS.includes(d.decision.action));
  let containment = ctx.containment ?? null;
  if (execute && wanted.length && !containment) containment = await measuredContainment(ctx, profile, nwo, logPath);
  if (execute && wanted.length && containment.credentialRead !== "closed") {
    log(logPath, `execute: NOT dispatching ${wanted.length} worker task(s) — worker containment is open: ${containment.why}`);
    escalations.set("guardian:containment:open", 1);
  }

  if (execute && wanted.length && containment.credentialRead === "closed") {
    // Injectable: the real reading is the machine's load average, which is right
    // for production and wrong for a test — a busy host makes canStart 0 and the
    // suite reports "no worker dispatched" about the laptop rather than the code.
    const cap = (ctx.capacity ?? capacity)({ maxWorkers: profile.watch?.maxWorkers ?? 5, running: ctx.running ?? 0 });
    log(logPath, `execute: capacity allows ${cap.canStart} worker(s) (load ${cap.load1?.toFixed?.(2) ?? "?"}, ${cap.perfCores} perf cores)`);
    let started = 0;

    const PREP_BACKOFF = (ctx.prepBackoff ??= new Map());   // pr -> { until, failures }
    for (const { e, decision, cause, fp } of decisions) {
      if (UNBUILT_ACTIONS[decision.action]) {
        log(logPath, `  #${e.pr}: NOT dispatching ${decision.action} — ${UNBUILT_ACTIONS[decision.action]}`);
        escalations.set(`#${e.pr}: ${decision.action.toLowerCase().replace("_", " ")} needs a GitHub effect reeve does not yet perform`, 1);
        continue;
      }
      const prepKey = e.pr;
      const backoff = PREP_BACKOFF.get(prepKey);
      if (backoff && backoff.until > Date.now() && WORKER_ACTIONS.includes(decision.action)) {
        log(logPath, `  #${e.pr}: NOT dispatching — worker preparation failed ${backoff.failures} time(s); backing off until ${new Date(backoff.until).toISOString()}`);
        escalations.set(`#${e.pr}: the worker could not be prepared; reeve is backing off`, 1);
        continue;
      }
      if (started >= cap.canStart) { log(logPath, `  capacity reached; ${decisions.length - started} decision(s) deferred to the next tick`); break; }
      if (halted(ctx.haltMarker)) { log(logPath, "HALTED before dispatch"); break; }

      // Only some decisions are worker tasks. WAIT, PARK, MERGE and ESCALATE are
      // not: two of them are for a human and one is the gate's own job.
      let promptCtx = { profile, nwo, pr: e.pr, head: e.head, branch: e.headRef };
      if (decision.action === "FIX_CI") {
        // Already resolved above, where it gated the decision. If it could not be
        // resolved there, there is nothing to tell a fixer to repair.
        if (!cause) { log(logPath, `  #${e.pr}: cannot dispatch FIX_CI — no resolvable root cause`); continue; }
        // Paying a fixer for randomness is the measured hazard on a base that
        // is red 6 of its last 9 runs: the worker "fixes" a failure that never
        // existed, then the founder is paged about the fix. Only DEMONSTRATED
        // flake changes the decision — the same job passing and failing across
        // attempts of one run — never suspicion. The escalation key stays an
        // identity; the run ids and job names go to the log.
        const flake = flakeAssessment(nwo, cause, ctx.flakeProbe);
        if (flake.allFlaky) {
          escalations.set(`#${e.pr}: every failing check is a demonstrated flake — reeve will not pay a fixer for randomness`, 1);
          log(logPath, `  #${e.pr}: NOT dispatching — demonstrated flake: ${flake.flaky.map(p => `${p.job} (run ${p.runId})`).join(", ")}`);
          continue;
        }
        // A mixed failure still gets its fixer, told which job is noise so its
        // budget goes to the failure that exists.
        const worked = flake.flaky.length
          ? { ...cause, note: `${flake.flaky.map(p => p.job).join(", ")}: demonstrated flake across attempts — do not chase; fix the rest` }
          : cause;
        // The attempt is NOT spent here. Several refusals still lie between this
        // point and a running worker -- no prompt, no worktree, no run -- and
        // spending an attempt on a dispatch that never happened burns the one
        // retry the design allows.
        promptCtx = { ...promptCtx, cause: worked, attempt: countFixAttempts(db, nwo, e.pr, fp) + 1 };
      } else if (decision.action === "FIX_FINDINGS") {
        promptCtx = { ...promptCtx, threads: e.threadDetails ?? [] };
      } else if (decision.action === "REQUEST_REVIEW") {
        promptCtx = { ...promptCtx, reviewers: (profile.reviewers ?? []).filter(r => r.trigger) };
      } else if (decision.action === "SPILL") {
        promptCtx = { ...promptCtx, findings: e.threadDetails ?? [] };
      }

      const spec = promptFor(decision, promptCtx);
      if (!spec) continue;

      // The checkout is prepared AFTER the run exists, because it is keyed by the
      // run: two runs for one pull request must never share a directory, and the
      // lease should be held while the (slow) preparation happens rather than
      // leaving a window another daemon could race into. A preparation that
      // fails is handled as one, below: refunded, backed off, nothing published.
      const checkoutRoot = profile.identity?.worktreeRoot ?? null;
      const repoCheckout = profile.identity?.checkout ?? null;
      if (!checkoutRoot || !repoCheckout) {
        const why = !checkoutRoot ? "no identity.worktreeRoot in the profile" : "no identity.checkout in the profile — a checkout is made FROM a clone";
        escalations.set(`#${e.pr}: cannot dispatch — ${why}`, 1);
        log(logPath, `  #${e.pr}: NOT dispatching — ${why}`);
        continue;
      }

      // A durable run is the ONLY way a worker may start. The exclusive right to
      // act on this PR is taken FIRST, so a restarted daemon cannot re-dispatch
      // work already in flight -- the log shows exactly that happening, the same
      // fix launched at 15:02 and again at 15:12.
      const run = startRun(db, { nwo, pr: e.pr, action: decision.action, head: e.head, cause });
      // Spent here, beside the run: past every refusal, before any work. A crash
      // after this point costs an attempt, which is the correct direction --
      // a crashed fix that silently earns a free retry is the runaway loop.
      if (run.ok && decision.action === "FIX_CI" && fp) recordFixAttempt(db, nwo, e.pr, fp, e.head);
      if (!run.ok) {
        // Refusing to act is the only safe answer when the transition cannot be
        // recorded: an unrecorded worker is one nothing can reason about later.
        log(logPath, `  #${e.pr}: NOT dispatching — ${run.why}`);
        continue;
      }

      log(logPath, `  #${e.pr}: dispatching ${decision.action} (run ${run.runId}, attempt ${run.attempt})`);
      started++;
      // The heartbeat's answer is read, not discarded. `heartbeat` already
      // reports a lost lease; the interval used to swallow it, so a worker kept
      // acting with no claim on its run. A failed write is the same: unknown is
      // not alive.
      let revoked = null;
      const beat = setInterval(() => {
        try {
          const hb = (ctx.heartbeat ?? heartbeat)(db, { runId: run.runId });
          if (!hb.alive) revoked = hb.reason ?? "lease not alive";
        } catch (err) { revoked = `heartbeat write failed: ${err.message}`; }
      }, ctx.heartbeatMs ?? HEARTBEAT_MS);
      // The deterministic boundary, built from the profile rather than described
      // to the model. Measured against the CLI first: a scoped allowlist refuses
      // `printf > file`, `| tee`, `git push` and a chained `git remote -v`, while
      // still letting the worker run the project's own commands -- which it must,
      // or it cannot tell whether its fix worked.
      const lane = (profile.lanes ?? []).find(l => l.id === decision.lane) ?? null;
      // The run dir is keyed by repository, PR, and run id: the log dir is
      // shared by every repo's daemon, and two repos can share a PR number.
      // Known before the policy is built, because the run's own tmp is the one
      // write grant the OS sandbox carries beyond the worktree.
      const stateDir = dirname(logPathOf(ctx));
      const runDir = join(stateDir, "runs", nwo.replace("/", "-"), String(e.pr), run.runId);
      const tmpDir = join(runDir, "tmp");
      // Declared out here, not inside the try: the publish path below reads it,
      // and a const in the try block is a ReferenceError at that point -- the
      // exact shape that once threw on every FIX_CI with every unit test green.
      let r, prepFailed = false, worktree = null, workerToken = null;
      try {
        // Everything from here runs inside the cleanup scope: the run is
        // already leased and its heartbeat already ticking, so a failure in
        // preparing the worker must release both, exactly as a failure in the
        // worker would. Measured: a contract write that threw outside this
        // block left the interval renewing a lease for a worker that never
        // ran, refusing every later dispatch for the PR until a restart.
        //
        // The worker's environment is built, never inherited: no token, no ssh
        // agent, no founder git config. Its output streams to files beside the
        // run so a restart can read the report the worker left. The run dir is
        // keyed by repository, PR, and run id: the log dir is shared by every
        // repo's daemon, and two repos can share a PR number.
        // A standalone clone, not a linked worktree: its own ref store and its own
        // configuration, so a worker cannot move the founder's branches or plant
        // git config the daemon would execute. Dependencies come from the
        // founder's tree copy-on-write, because the network is denied and a fixer
        // that cannot run the tests cannot check its own fix.
        // Which trees to copy comes from the PROFILE's languages, not from a
        // hard-coded node_modules: a python unit needs its .venv, and a language
        // whose dependencies live under the home directory has nothing in the
        // tree to copy at all. The worker has no network and a scratch home, so
        // that last case cannot resolve anything and is SAID rather than left to
        // be discovered as a mystery test failure. (Codex #5-[5].)
        const wantDeps = dependencyPathsFor(profile);
        const prepared = (ctx.prepareCheckout ?? prepareRunCheckout)({
          repoRoot: repoCheckout, root: checkoutRoot, pr: e.pr, runId: run.runId,
          branch: e.headRef, head: e.head, depsFrom: wantDeps.paths,
        });
        if (!prepared.ok) throw new Error(`could not prepare the checkout: ${prepared.why}`);
        worktree = prepared.path;
        log(logPath, `  #${e.pr}: checkout ready at ${worktree}` +
                     `${prepared.deps?.copied?.length ? ` (deps: ${prepared.deps.copied.join(", ")}${prepared.deps.cow ? ", copy-on-write" : ""})` : ""}`);
        if (wantDeps.unsupported.length)
          log(logPath, `  #${e.pr}: no dependency tree to copy for ${wantDeps.unsupported.join(", ")} — those checks may not resolve`);

        // The policy is built AFTER the checkout, because it is written in terms
        // of that directory: the write scope, the quarantine denies and the
        // overlap check all resolve against it.
        const dStateRoots = stateRootsFor(stateDir, logPathOf(ctx), worktree, ctx.dbPath ?? null);
        const sandbox = sandboxFor({ profile, action: decision.action, worktree, lane, tmpDir, stateRoots: dStateRoots });
        const budgetMs = (profile.watch?.workerBudgetMinutes ?? 20) * 60_000;
        const claudeBin = resolveClaude(ctx.claudeBin ?? "claude");
        // In the run's tmp (sandbox-readable), never under the deny-read ~/.reeve:
        // a global config the sandboxed git cannot read stops it committing.
        const dToken = (ctx.oauthToken ?? readOauthToken)();
        if (!dToken?.ok) throw new Error(`no worker authentication token: ${dToken?.why ?? "unreadable"}`);
        workerToken = dToken.token;
        const env = workerEnv({ gitConfigPath: writeGitConfig(join(tmpDir, "git")),
                                tmpDir, bgWaitMs: budgetMs,
                                extraPath: [dirname(claudeBin)],
                                home: workerHomeFor(profile.identity?.worktreeRoot ?? dirname(worktree), nwo),
                                oauthToken: dToken.token });
        const outPath = join(runDir, "worker.out"), errPath = join(runDir, "worker.err");
        // Validated BEFORE it is written or hashed. Measured: under -p the CLI
        // drops an invalid settings file whole and silently, deny rules
        // included, so a worker launched on one would run with no boundary at
        // all and a contract row claiming otherwise. A failure here is a
        // preparation failure: refunded, backed off, escalated, never launched.
        // A quarantined path the OS layer cannot express is a hole, not a
        // detail: the worker holds `cat`, so a tool-only deny would not stop it.
        // (Codex #4e-[8].)
        if (sandbox.unrepresentableQuarantine?.length)
          throw new Error(`quarantined path(s) cannot be enforced by the OS sandbox: ${sandbox.unrepresentableQuarantine.join(", ")}`);
        // A denied path that CONTAINS the worktree would deny the worker its own
        // code, and the failure would read as a broken sandbox rather than the
        // configuration error it is. (Codex #4g-[4].)
        if (sandbox.stateHomeContainsWorktree?.length)
          throw new Error(`a denied path (${sandbox.stateHomeContainsWorktree.join(", ")}) contains the checkout ${worktree}, so the policy would deny the worker its own code — move identity.worktreeRoot apart from REEVE_HOME and from identity.checkout`);
        const qDenies = quarantineOsDenies(worktree, profile.risk?.quarantinePaths ?? []).paths;
        const notifyCred = typeof profile.notify?.credentialFile === "string" && isAbsolute(profile.notify.credentialFile) ? [profile.notify.credentialFile] : [];
        const sv = (ctx.settingsValidator ?? validateSettings)(sandbox.settings, { tmpDir, stateRoots: dStateRoots, quarantineDenies: qDenies,
                                                                                  extraDenies: notifyCred, sourceCheckout: sourceCheckoutOf(profile),
                                                                                  siblingRoots: siblingRootsOf(profile).filter(r => worktree !== r && !r.startsWith(worktree + "/")),
                                                                                  worktree });
        if (!sv.ok) throw new Error(`settings invalid: ${sv.errors.join("; ")}`);
        // The settings file is immutable per run, in the run's own directory:
        // a path keyed by PR alone was shared by every daemon on the host, and
        // one could overwrite it between this run's hash and its spawn.
        const settingsPath = writeSandbox(runDir, sandbox);
        const maxTurns = profile.watch?.maxTurns ?? 40;
        // A prompt spec may name its own tools, and those strings cannot know the
        // worktree; they are scoped here, at the one place that knows both.
        const tools = scopeGrant(spec.tools ?? sandbox.allowedTools, worktree);
        // The grant travels beside the settings file, not inside it, so the
        // settings validator never sees it -- and it is where the file tools are
        // granted. A bare `Read` there is a grant to read the whole disk: the
        // file tools are not covered by the OS sandbox. A prompt spec may
        // override the grant, which is exactly the path that needs checking.
        const tv = (ctx.toolValidator ?? validateToolGrant)(tools, { worktree });
        if (!tv.ok) throw new Error(`tool grant invalid: ${tv.errors.join("; ")}`);
        const argv = workerArgs({ prompt: spec.prompt, allowedTools: tools, settings: settingsPath, maxTurns });
        // The complete argv is kept beside the hash: a hash proves what ran, the
        // file lets a later attempt run the same thing.
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, "argv.json"), JSON.stringify(argv));
        // The contract is recorded before the process exists, so that a crash
        // between here and the first heartbeat still leaves the answer to "what
        // was this worker asked to run as".
        recordWorkerContract(db, {
          runId: run.runId, cliVersion: ctx.cliVersion ?? cliVersion(claudeBin, env),
          argvHash: sha256(JSON.stringify(argv)), promptHash: sha256(spec.prompt),
          settingsHash: sha256(readFileSync(settingsPath, "utf8")),
          toolContract: tools, maxTurns, outPath, errPath,
          envHash: sha256(JSON.stringify(Object.keys(env).sort().map(k => [k, env[k]]))),
        });

        // TOCTOU: the containment verdict was measured once for this tick, but
        // the CLI binary and the keychain can change between then and NOW — after
        // preparation (which includes a git fetch), immediately before the spawn.
        // Re-check both cheap facts here, at the last moment, so a swap or a new
        // credential during preparation reopens the gate. (Codex #4c-[11],[12],
        // #4d-[13].)
        const reval = await revalidateContainment(containment, {
          bin: claudeBin, binaryIdentity, keychain: ctx.keychain ?? null, platform: ctx.platform ?? undefined,
        });
        if (!reval.ok) {
          log(logPath, `  #${e.pr}: NOT dispatching — ${reval.why}`);
          escalations.set("guardian:containment:changed", 1);
          // The attempt is NOT refunded here: this is an UNBOUND outcome, and the
          // finally block below refunds every pre-execution outcome once. Doing
          // it in both places took a cause from two attempts to zero and handed
          // back retries the cap had already spent. (Codex #4h-[3].)
          r = { outcome: OUTCOMES.UNBOUND, why: `containment changed before spawn: ${reval.why}`, ms: 0, cost: null, sessionId: null };
        } else {
        r = await (ctx.spawnWorker ?? runWorker)({
          bin: claudeBin,
          args: argv,
          cwd: worktree, env, outPath, errPath,
          maxOutputBytes: profile.worker?.maxOutputBytes ?? 64 * 1024 * 1024,
          budgetMs,
          isHalted: () => halted(ctx.haltMarker),
          // The heartbeat answers every 30 seconds; a cancel must not wait for
          // it. The poll asks the store directly, so a cancel requested after
          // the binding ends the worker within one poll interval.
          isRevoked: () => revoked ?? (cancelRequested(db, run.runId) ? "cancelled" : null),
          // Bind the process to the run the instant it exists, before it can
          // touch anything, so a crash leaves something probeable.
          onSpawn: ({ pid, lstart }) => { bindRun(db, { runId: run.runId, pid, boot: lstart }); noteWorkerBinding(db, { runId: run.runId, pid, lstart }); },
        });
        }
      } catch (err) {
        // A worker that could not be prepared or launched is a failed attempt
        // with its reason, never a thrown tick: the run below is closed, the
        // lease released, and the next PR still gets its turn. The attempt
        // spent above is refunded: this failure is reeve's, not the fix's.
        r = { outcome: OUTCOMES.FAILED, why: `could not prepare the worker: ${err.message}`, ms: 0, cost: null, sessionId: null };
        prepFailed = true;
        if (decision.action === "FIX_CI" && fp) { try { refundFixAttempt(db, nwo, e.pr, fp); } catch { /* the run still closes */ } }
        const prev = PREP_BACKOFF.get(prepKey)?.failures ?? 0;
        PREP_BACKOFF.set(prepKey, { failures: prev + 1, until: Date.now() + Math.min(PREP_BACKOFF_CAP_MS, PREP_BACKOFF_BASE_MS * 2 ** prev) });
        escalations.set(`#${e.pr}: the worker could not be prepared; reeve is backing off`, 1);
      } finally {
        clearInterval(beat);
        // Classified FIRST, before anything is recorded: a binding refused
        // because a cancel landed first is a cancellation, not a preparation
        // failure, and the audit trail must say so (run.finish, cancelled),
        // not record a refused unbound worker. Nothing ran, so the fixer's
        // attempt is given back as well.
        if (r?.outcome === OUTCOMES.UNBOUND && /cancel/.test(r?.why ?? "")) {
          r = { ...r, outcome: OUTCOMES.CANCELLED, why: r.why };
          if (decision.action === "FIX_CI" && fp) { try { refundFixAttempt(db, nwo, e.pr, fp); } catch { /* the run still closes */ } }
        }
        // Pre-execution outcomes are classified BEFORE the recorder and the
        // finish, so a recorder that fails cannot rewrite them into a spent
        // failure. A worker that never executed (the gate refused its binding) spent no
        // fixer's attempt; it is refunded like any pre-execution failure, and it
        // backs off like one: a binding that keeps failing would otherwise
        // lease and refuse the PR on every tick with nobody told.
        if (r?.outcome === OUTCOMES.UNBOUND) {
          prepFailed = true;
          if (decision.action === "FIX_CI" && fp) { try { refundFixAttempt(db, nwo, e.pr, fp); } catch { /* the run still closes */ } }
          const prev = PREP_BACKOFF.get(prepKey)?.failures ?? 0;
          PREP_BACKOFF.set(prepKey, { failures: prev + 1, until: Date.now() + Math.min(PREP_BACKOFF_CAP_MS, PREP_BACKOFF_BASE_MS * 2 ** prev) });
          escalations.set(`#${e.pr}: the worker could not be prepared; reeve is backing off`, 1);
        }
        // The flag, not the reason string: a recorder that fails for the same
        // cause rewrites the reason, and a backoff inferred from it vanished.
        // What the worker said it ran as, and whether its durable record is whole.
        // Facts that cannot be recorded are facts nobody can audit later, so a
        // run whose facts did not land is not a successful run, whatever the
        // worker said: the outcome becomes failed before the run is closed.
        try { (ctx.noteWorkerResult ?? noteWorkerResult)(db, { runId: run.runId, modelResolved: r?.model ?? null, truncated: r?.truncated === true || r?.stderrTruncated === true, stdoutBytes: r?.stdoutBytes ?? null }); }
        catch (err) {
          // A pre-execution outcome stays what it is (nothing ran, nothing to
          // publish); only an outcome that could have been published is
          // downgraded to failed when its facts did not land.
          const pre = r?.outcome === OUTCOMES.UNBOUND || r?.outcome === OUTCOMES.CANCELLED || r?.outcome === OUTCOMES.LEASE_LOST;
          r = pre ? { ...r, why: `${r.why}; result facts could not be recorded: ${err.message}` }
                  : { ...(r ?? {}), outcome: OUTCOMES.FAILED, why: `the run's result facts could not be recorded: ${err.message}` };
        }
        // Closed in `finally`: a throw between spawn and result would otherwise
        // leave the run leased forever, and the PR unworkable until it expired.
        // finishRun itself refuses a run this process no longer owns (a lost
        // lease means another actor already moved it), so a stale outcome can
        // never overwrite the newer state.
        const fin = finishRun(db, { runId: run.runId, outcome: r?.outcome ?? "failed",
                                    why: r?.why ?? "the worker threw before returning a result",
                                    ms: r?.ms, cost: r?.cost, sessionId: r?.sessionId });
        if (!prepFailed) PREP_BACKOFF.delete(prepKey);
        if (fin?.applied === false) {
          // The store refused the outcome: the claim was gone or withdrawn by
          // the time the worker finished. Whatever it produced is not published.
          log(logPath, `  #${e.pr}: run ${run.runId} not finished by this process: ${fin.why}`);
          r = { ...(r ?? {}), outcome: /cancel/.test(fin.why) ? OUTCOMES.CANCELLED : OUTCOMES.LEASE_LOST, why: fin.why };
        }
      }
      log(logPath, `  #${e.pr}: ${decision.action} -> ${r.outcome} (${r.why}) in ${Math.round(r.ms / 1000)}s${r.cost != null ? `, ${r.cost.toFixed(3)}` : ""}`);

      // Nothing was prepared, so there is no checkout to read, judge or publish.
      // Preparation happens inside the try-block above, so a failure there leaves
      // this path null while everything below it still runs -- and the
      // configuration check reads a null path as "no recorded configuration",
      // which is a refusal. That reported the most ordinary failure there is (no
      // disk, no token, a clone that would not clone) as the worker having
      // tampered with git config, against a worker that never started.
      if (!worktree) continue;

      // What the worker PRODUCED, judged after it has stopped talking. The
      // permission layer stops it reaching a forbidden path; this answers the
      // different question of whether the change is inside the work it was given.
      // A model that argued its way to a plausible edit outside its territory
      // still does not get it published.
      // A worker that did not finish still leaves its work behind. Each run gets
      // its own checkout now, so a half-finished one no longer blocks the next
      // attempt -- but it still holds work nobody else has a copy of, which is
      // why the release below preserves it rather than deleting it.
      //
      // Measured: a worker repaired the planted bug and then hit its turn limit
      // before committing. The fix was correct, cost real money, and would have
      // blocked every later attempt while looking like nothing had happened.
      // WHAT was refused, on every run, and declared BEFORE anything reads it —
      // the first version of this sat below its own use sites and threw a
      // ReferenceError after the worker had finished, losing a completed run.
      //
      // A denial no longer disqualifies the work: a model explores, and a correct
      // refusal is not a failed repair. But refusals are how the sandbox gets
      // tuned, and a worker that could not run the tests produced something
      // nothing verified. Both facts have to be visible.
      const refused = [...new Set((r.denials ?? []).map(x => {
        const i = x.tool_input ?? {};
        return String(i.command ?? i.file_path ?? x.tool_name ?? "?").replace(/\s+/g, " ").slice(0, 100);
      }))];
      for (const w of refused) log(logPath, `  #${e.pr}: refused -> ${w}`);

      // Being unable to VERIFY is different from being unable to explore. If the
      // project's own check command was among the refusals, whatever was produced
      // is unverified, and that must reach a human even when it publishes.
      const checkCmds = (profile.units ?? []).flatMap(u2 =>
        Object.values(u2.commands ?? {}).map(c => c?.cmd).filter(Boolean));
      const couldNotVerify = refused.some(w =>
        checkCmds.some(c => w.includes(c.split(/\s+/)[0])) && /test|lint|check|build/i.test(w));

      // Before ANY git command runs in a directory the worker just held: a
      // changed repository configuration is one git would EXECUTE, as the daemon
      // user, outside the sandbox (core.fsmonitor and friends). Nothing is read
      // from it and nothing is published; the worktree is kept for a human.
      // (Codex #4f-[6].)
      const cfg = (ctx.verifyConfig ?? verifyConfig)(worktree);
      if (!cfg.ok) {
        log(logPath, `  #${e.pr}: NOT reading or publishing this checkout — ${cfg.why}`);
        escalations.set(`#${e.pr}: the worker changed its checkout's git configuration; the checkout is preserved at ${worktree} for inspection`, 1);
        escalations.set("guardian:checkout:config-tampered", 1);
        continue;
      }

      if (r.outcome !== OUTCOMES.OK) {
        const left = changedFiles(worktree, e.head);
        // `changedFiles` reads HEAD, and a worker that committed on the pull
        // request's branch and then checked out something else leaves HEAD back
        // at the pinned commit with the work still on the BRANCH. Publishing
        // fetches that branch, so it is the branch that decides whether anything
        // would be lost -- reading HEAD alone deleted the only copy of a
        // candidate fix. (Codex #5-[11].)
        const branchAt = branchHead(worktree, e.headRef);
        const branchMoved = branchAt === null || branchAt !== e.head;
        if (left?.length || branchMoved) {
          const rel = releaseRunCheckout(worktree, { workFetched: false });
          const why = left?.length ? `left ${left.length} changed file(s) unfinished`
            : branchAt === null ? `left ${e.headRef} unreadable`
            : `committed on ${e.headRef} without finishing`;
          log(logPath, `  #${e.pr}: the worker ${why} — ${rel.quarantined ? `preserved at ${rel.path}` : "released"}`);
          escalations.set(`#${e.pr}: an unfinished candidate fix was preserved rather than published — ${left?.length ? left.slice(0, 3).join(", ") : `commits on ${e.headRef}`}`, 1);
        } else {
          releaseRunCheckout(worktree, { workFetched: true });
        }
      }

      // Attached now rather than at dispatch: the reason only exists once the
      // worker has spoken, and it is what the retry cap will quote when it fires.
      if (decision.action === "FIX_CI" && fp) noteFixAttempt(db, nwo, e.pr, fp, statedBlocker(r.report));

      if (r.outcome === OUTCOMES.OK) {
        // Everything accepted must be COMMITTED before anything is published or
        // released. reeve publishes by fetching the checkout's BRANCH, so an
        // uncommitted edit is invisible to the push and would then be deleted
        // with the checkout while the log said it was published. The work is
        // kept and a human is told, because a candidate fix nobody has a copy of
        // is not spare disk space. (Codex #5-[2].)
        const stillDirty = uncommittedFiles(worktree);
        if (stillDirty === null || stillDirty.length) {
          const why = stillDirty === null
            ? "reeve could not read the checkout's status, so it cannot say the work was committed"
            : `the worker finished with ${stillDirty.length} uncommitted change(s), which a push cannot carry`;
          const rel = releaseRunCheckout(worktree, { workFetched: false });
          log(logPath, `  #${e.pr}: NOT published — ${why}${rel.quarantined ? `; preserved at ${rel.path}` : ""}`);
          escalations.set(`#${e.pr}: a finished fix was NOT published — ${why}` +
                          `${stillDirty?.length ? ` (${stillDirty.slice(0, 3).join(", ")})` : ""}`, 1);
          continue;
        }
        // Against the ref that will actually be PUSHED, not against HEAD.
        //
        // publishRunWork pushes `e.headRef`. A worker can commit anything on that
        // branch, then check out an auxiliary branch carrying an allowed change:
        // every gate reads HEAD, passes, and the push carries the content none of
        // them looked at. Both commits can descend from the pinned head, so
        // nothing else notices. (Codex #5-[12].)
        const publishRef = `refs/heads/${e.headRef}`;
        const atRef = branchHead(worktree, e.headRef);
        if (!atRef) {
          const rel = releaseRunCheckout(worktree, { workFetched: false });
          log(logPath, `  #${e.pr}: NOT published — ${e.headRef} cannot be read in the checkout${rel.quarantined ? `; preserved at ${rel.path}` : ""}`);
          escalations.set(`#${e.pr}: a finished fix was NOT published — reeve could not read ${e.headRef} in the worker's checkout`, 1);
          continue;
        }
        const changed = changedFiles(worktree, e.head, publishRef);
        const gate = reviewDiff({ files: changed, profile, lane, action: decision.action });
        if (!gate.ok) {
          log(logPath, `  #${e.pr}: NOT published — ${gate.why}`);
          // A worker that DECLINED is not a worker that failed. Told to stop when
          // a fix belongs in a sensitive path, it stops and says why -- and
          // reporting that as "a fix was produced but refused publication --
          // empty diff" states two things that cannot both be true, about the
          // one outcome the rules asked for. Its own reason is the only witness
          // to why it stopped, so it is the one a human is given.
          const blocker = statedBlocker(r.report);
          escalations.set(blocker
            ? `#${e.pr}: needs a human — ${blocker}`
            : `#${e.pr}: a fix was produced but refused publication — ${gate.why}`, 1);
        } else {
          // Before reeve puts its name on it: the worker had a working token in
          // its environment and every runtime needed to read it. A filename gate
          // cannot see that, and reeve is the party that pushes.
          const leak = await diffCarriesSecret(worktree, e.head, publishRef, [{ label: "reeve's worker authentication token", value: workerToken }]);
          if (leak) {
            const rel = releaseRunCheckout(worktree, { workFetched: false });
            log(logPath, `  #${e.pr}: NOT published — ${leak.why}${rel.quarantined ? `; preserved at ${rel.path}` : ""}`);
            escalations.set(`#${e.pr}: a fix was refused publication because ${leak.why}; rotate the token with \`claude setup-token\``, 1);
            escalations.set("guardian:worker:credential-in-diff", 1);
            continue;
          }
          // reeve publishes, not the worker: the actor and the only claim that
          // the action was allowed must not be the same party.
          const pushed = (ctx.publishWork ?? publishRunWork)({ repoRoot: repoCheckout, path: worktree,
                                                               branch: e.headRef, expectedRemote: e.head });
          if (!pushed.ok) {
            log(logPath, `  #${e.pr}: NOT published — ${pushed.why}`);
            escalations.set(`#${e.pr}: a fix was produced but could not be published — ${pushed.why}`, 1);
          } else {
            log(logPath, `  #${e.pr}: published ${changed.length} file(s)` + (refused.length ? ` (${refused.length} call(s) refused along the way)` : ""));
            // Published, and still escalated: CI at the new head is the check that
            // matters, and a fix nothing ran the tests over should be watched.
            if (couldNotVerify)
              escalations.set(`#${e.pr}: a fix was published but the worker could not run the project's checks — watch CI at the new head`, 1);
            // Only ever release what pushed cleanly. Anything else quarantines,
            // because a directory holding work nobody has a copy of is not spare
            // disk space.
            // Only what published cleanly is deleted; the release refuses to
            // remove a checkout whose commits reeve never took out of it.
            const rel = releaseRunCheckout(worktree, { workFetched: true });
            if (!rel.ok) log(logPath, `  #${e.pr}: checkout kept — ${rel.why}`);
          }
        }
      }

      // A worker whose tools were denied wrote a plausible answer it could not
      // support. Treating that as progress is the fail-open this exists to close.
      if (r.outcome === OUTCOMES.RATE_LIMITED) { escalations.set("the provider is rate limiting; work is paused", 1); break; }
    }
  }

  // Regenerate the glance surface every tick. A dashboard that is only refreshed
  // on request is one that shows a state that stopped being true hours ago.
  if (ctx.dashPath) {
    // Computed here rather than left to the CLI, which is why the dashboard's
    // headline was permanently blank: nothing ever set ctx.health. Recomputed only
    // when the open set has SHRUNK, because that is the only moment a merge can
    // have happened and the rate can have moved -- a per-tick recount would spend
    // API calls to learn nothing.
    if (ctx.lastOpenCount == null || prs.length < ctx.lastOpenCount) {
      const clean = cleanMergeRate(nwo, 20, null, { required: profile.ci?.requiredChecks ?? [] });
      ctx.health = { clean };
      log(logPath, `health: clean-merge ${clean.ok ? Math.round(clean.rate * 100) + "% over " + clean.judged + " judged" : clean.why}` +
                   (clean.unjudged ? `, ${clean.unjudged} unjudged` : ""));
    }
    ctx.lastOpenCount = prs.length;

    try { writeDash(ctx.dashPath, { nwo, state: readState(db), health: ctx.health ?? {} }); }
    catch (e) { log(logPath, `could not write the dashboard: ${e.message}`); }
  }


  // Recorded last, so it means "a tick completed" rather than "a tick began".
  // That is the difference between a daemon that is working and one that is
  // wedged part-way through every pass.
  // A second copy, taken from the tick that just finished writing. `VACUUM INTO`
  // holds a read lock, so this is consistent even mid-loop, and it is skipped when
  // one was already taken within the window -- a backup every 150 seconds would
  // fill the disk of the machine it is meant to protect.
  if (ctx.backupRoot !== false) {
    const at = now();
    if (!ctx.lastBackupAt || at - ctx.lastBackupAt >= (profile.watch?.backupIntervalSeconds ?? 3600)) {
      // EVERY store, not only the one this tick is about. A store no daemon
      // watches is never snapshotted and never audited, and that is precisely
      // the one that is lost.
      const root = ctx.backupRoot ?? join(dirname(logPath ?? "/tmp/x"), "backups");
      const home = ctx.home ?? dirname(logPath ?? join(homedir(), ".reeve", "x"));
      const all = (ctx.snapshotAll ?? snapshotAll)(home, root, { at });
      for (const r of all) {
        if (!r.ok) log(logPath, `backup FAILED (${r.nwo}): ${r.why}`);
      }
      const okd = all.filter(r => r.ok);
      if (okd.length) log(logPath, `backup: ${okd.length} store(s) — ${okd.map(r => r.nwo).join(", ")}`);
      // A tick that snapshotted nothing at all is a backup that is not happening.
      if (!all.length) log(logPath, "backup FAILED: no state store found to snapshot");
      ctx.lastBackupAt = at;
    }
  }

  // AFTER the backup, deliberately. Running it first meant the audit reported a
  // gap that the very same tick then closed 54 milliseconds later, and escalated
  // it -- measured on revnix/reeve, which was named as never backed up and backed
  // up in the same breath. An audit should describe the state a tick LEAVES, not
  // the one it found, or every fix it performs pages a human first.
  //
  // On EVERY tick. The checks are local and cost about a
  // millisecond; running them on a slower cadence would make them ABSENT from
  // most ticks, and absence within a tick is what the layer below reads as
  // resolved. Their findings ride the same dedup, so a standing fault is said
  // once and clears when it goes.
  if (ctx.selfAudit !== false) {
    for (const f of (ctx.runSelfAudit ?? selfAudit)(db, {
      nwo, profile, at: now(),
      backupRoot: ctx.backupRoot === false ? null
                : (ctx.backupRoot ?? join(dirname(logPath ?? "/tmp/x"), "backups")),
      // Without this the store-wide backup check is inert, and an unwatched
      // store stays invisible exactly as it did before.
      home: ctx.home ?? dirname(logPath ?? join(homedir(), ".reeve", "x")),
    })) {
      log(logPath, `self: ${f.level} ${f.why}${f.detail ? ` — ${f.detail}` : ""}`);
      escalations.set(f.why, f.count ?? 1);
    }
  }

  // Announced LAST, so it reduces the escalations this tick actually leaves --
  // including anything the self-audit added, and excluding anything the backup
  // step above just fixed. Running it earlier meant a gap closed 54ms later was
  // still paged to a human.
  //
  // A PR that merged or closed will never be evaluated again, so its escalation
  // needs a positive answer about the PR itself or it stands forever.
  const finished = finishedSubjects(db, nwo, new Set(prs), ctx);
  for (const pr of finished) log(logPath, `  #${pr}: is merged or closed — retiring what it was escalating`);
  const { fresh, cleared } = announceable(db, escalations,
    { covered: evaluated, waiting, finished, complete: evaluated.size === prs.length });

  if (ctx.reviewIngest !== false) {
    const sk = streak(db, nwo, now());
    log(logPath, `shadow: ${sk.days} consecutive day(s) agreeing over ${sk.comparisons} comparison(s)` +
                 (sk.firstDivergence ? ` — last divergence ${sk.firstDivergence.day}` : ""));
  }

  // Repo-wide, so once per tick rather than once per pull request.
  if (ctx.reviewIngest !== false) {
    try { (ctx.deriveSupply ?? deriveSupply)(db, nwo, profile, { at: now() }); }
    catch (err) { log(logPath, `supply derive failed — ${err.message}`); }
  }

  noteTick(db);

  for (const { why, count } of fresh) log(logPath, `NEEDS YOU: ${why}${count > 1 ? ` (${count} PRs)` : ""}`);
  for (const why of cleared) log(logPath, `CLEARED: ${why}`);

  // Only what ARRIVED goes to a phone. `fresh` is already the deduplicated set,
  // so a standing cause is pushed once rather than every two and a half minutes --
  // which is how a channel gets muted and stops being a channel.
  const alert = buildAlert({ nwo, escalations: fresh });
  if (alert) {
    const sent = (ctx.notify ?? notify)({ profile, alert });
    // Logged either way. A push channel nobody knows is broken is the same as no
    // push channel, so a decline is never swallowed.
    log(logPath, sent.ok ? `pushed ${fresh.length} escalation(s) to ${profile.notify?.topic}`
                         : `did NOT push: ${sent.why}`);
    // Recorded as well as logged: the self-audit reads this to notice a channel
    // that has been refusing for days, and a log line does not survive a restart
    // as something queryable.
    try {
      db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
        .run(now(), "daemon", sent.ok ? "notify.sent" : "notify.failed", `repo:${nwo}`,
             JSON.stringify({ count: fresh.length, why: sent.why ?? null }));
    } catch { /* recording a push must never fail a tick */ }
  }
  return { decisions, escalations, halted: false };
}

/**
 * Reduce this tick's escalations against the standing set, so a cause is
 * announced when it arrives and when its shape changes, never on every tick.
 * Clearing is announced too: an operator who is only ever told about problems
 * cannot distinguish "resolved" from "reeve stopped looking".
 *
 * @param {Map<string, number>} escalations  cause -> how many PRs share it
 * @returns {{fresh: {why: string, count: number}[], cleared: string[]}}
 */
export function announceable(db, escalations, { covered = null, waiting = null, finished = null, complete = true, at = Math.floor(Date.now() / 1000) } = {}) {
  const fresh = [], cleared = [];
  const standing = new Map(
    db.prepare("SELECT why, count, announced_count FROM escalation").all().map(r => [r.why, r]));

  for (const [why, count] of escalations) {
    const prev = standing.get(why);
    if (!prev) {
      db.prepare(`INSERT INTO escalation(why,count,first_seen_at,last_seen_at,announced_count)
                  VALUES(?,?,?,?,?)`).run(why, count, at, at, count);
      fresh.push({ why, count });
    } else {
      db.prepare("UPDATE escalation SET count=?, last_seen_at=? WHERE why=?").run(count, at, why);
      // The count is the shape of a shared cause: 1 PR on a red base and 4 PRs
      // on it are different situations and both deserve saying.
      if (prev.announced_count !== count) {
        db.prepare("UPDATE escalation SET announced_count=? WHERE why=?").run(count, why);
        fresh.push({ why, count });
      }
    }
  }

  for (const why of standing.keys()) {
    if (escalations.has(why)) continue;
    // Absent from THIS tick is not the same as gone. A tick that could not
    // evaluate a PR -- a rate limit, a network blip, an early continue -- simply
    // does not produce its escalation, and retiring it on that silence announces
    // "resolved" for a problem nobody looked at. Absence is not success here
    // either, and this is the surface a human trusts to tell them it is over.
    //
    // Nor is being LOOKED at the same as being settled. Measured on nextly #834:
    // its decisions ran ESCALATE, then seven ticks of WAIT while CI was in
    // flight, then ESCALATE again -- and because a waiting tick produces no
    // escalation, the standing cause was retired and re-announced twice, four
    // and twenty-five minutes apart, with the reason string identical each time.
    // WAIT means "something is in flight; check again later", never "the thing a
    // human was needed for is resolved". Two pushes for one unchanged condition
    // is how the channel earns being muted, and a muted channel is worse than
    // none.
    const subject = why.match(/^#(\d+):/)?.[1];
    const pr = subject ? Number(subject) : null;
    const looked = !subject
      // A shared cause names no PR, so only a tick that finished what it set out
      // to do is entitled to retire it.
      ? complete
      // GitHub says the pull request is over. That is a positive fact about the
      // subject, not an absence, and it is the ONLY way an escalation for a PR
      // that has left the open list can ever retire.
      : finished?.has(pr) ? true
      // In flight this tick, which says nothing either way.
      : waiting?.has(pr) ? false
      : (covered === null || covered.has(pr));
    if (!looked) continue;
    db.prepare("DELETE FROM escalation WHERE why=?").run(why);
    cleared.push(why);
  }
  return { fresh, cleared };
}

/** The long-running loop. Ticks until halted or stopped. */
export async function run(ctx) {
  const { logPath, intervalMs = 90_000 } = ctx;
  log(logPath, `reeve daemon starting — node ${process.version}, pid ${process.pid}`);

  // Assert the floor rather than trusting the environment: node on this machine's
  // PATH is v22, and launchd never sources a shell profile.
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 24) { log(logPath, `FATAL: node ${process.version} is below the 24 floor`); process.exit(1); }

  // The assertion dies with this process, so a crashed daemon can never leave the
  // Mac permanently unable to sleep.
  const caffeinatePid = stayAwake(process.pid);
  if (caffeinatePid) log(logPath, `staying awake via caffeinate pid ${caffeinatePid}`);

  let stop = false;
  const shutdown = sig => { log(logPath, `${sig} — finishing this tick then stopping`); stop = true; };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  for (;;) {
    try {
      const r = await tick(ctx);
      if (r.halted) { log(logPath, "halted — sleeping until the marker is removed"); }
    } catch (e) {
      // A tick that throws must not kill the daemon: launchd would restart it on a
      // 10s floor and the failure would repeat invisibly.
      log(logPath, `tick threw: ${e.stack?.split("\n").slice(0, 3).join(" | ") ?? e.message}`);
    }
    if (stop) break;
    await new Promise(r => setTimeout(r, intervalMs));
    if (stop) break;
  }
  log(logPath, "daemon stopped");
}
