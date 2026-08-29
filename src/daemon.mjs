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

import { evaluatePr, publishVerdict, prAnchor, isBuilderPr } from "./pr.mjs";
import { nextAction, describe, ACTIONS, ESCALATIONS } from "./watcher.mjs";
import { reconcilePr } from "./github/reconciler.mjs";
import { capacity, stayAwake, halted, runWorker, workerArgs, statedBlocker, isSameProcess, OUTCOMES } from "./supervisor.mjs";
import { promptFor, WORKER_ACTIONS, UNBUILT_ACTIONS } from "./prompts.mjs";
import { sandboxFor, writeSandbox, reviewDiff, validateSettings, validateToolGrant, scopeGrant, quarantineOsDenies, sourceCheckoutOf, siblingRootsOf } from "./sandbox.mjs";
import { verifyConfig, GIT_NEUTRALISE, gitEnv } from "./gitguard.mjs";
import { prepareRunCheckout, publishRunWork, releaseRunCheckout, dependencyPathsFor, commitRunWork, digestOf } from "./checkout.mjs";
import { rootCause, resolveFailureCause, flakeAssessment } from "./ci-rootcause.mjs";
import { workerEnv, writeGitConfig, readOauthToken, workerHomeFor } from "./workerenv.mjs";
import { measureContainment, revalidateContainment, probeKeychain, isolationTopologyReady, cheapContainmentReasons, binaryIdentity } from "./containment.mjs";
import { canaryIdFor, netListener, instrumentHash } from "./canary.mjs";
import { claimProvider, releaseProvider, bindProviderLease, noteRateLimit, heartbeatProvider,
         reapProviderLeases, cancelQueued, queuedGuardianRequests } from "./provider.mjs";
import { openHold } from "./build/holds.mjs";
import { resolveRepoId } from "./build/repoid.mjs";
import { readState, noteTick, cleanMergeRate } from "./status.mjs";
import { buildAlert, notify, printable } from "./notify.mjs";
import { countFixAttempts, recordFixAttempt, fixAttemptNote, noteFixAttempt, refundFixAttempt, startRun, notePid, finishRun, heartbeat, LEASE_SECONDS, recordWorkerContract, noteWorkerResult, noteWorkerBinding, bindRun, cancelRequested, sha256, tx, enqueue, supersedeEffects } from "./db/ops.mjs";
import { authenticate, apiAsInstallation } from "./github/app.mjs";
import { drainOutbox } from "./outbox/drain.mjs";
import { HANDLERS, permittedHandlers } from "./outbox/effects.mjs";
import { writeDash } from "./dash.mjs";
import { snapshot, snapshotAll } from "./backup.mjs";
import { selfAudit } from "./selfaudit.mjs";
import { observe, ingest, noteHead } from "./review/ingest.mjs";
import { derivePr, deriveSupply, reviewState } from "./review/derive.mjs";
import { compare, record as recordShadow, streak } from "./review/shadow.mjs";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, fstatSync, statSync, readFileSync, writeFileSync, rmSync, openSync, closeSync, readSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { resolveHome } from "./home.mjs";

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
/**
 * The commit message reeve writes for a worker's repair.
 *
 * Built from the worker's own report rather than from the failure text: `cause`
 * and `change` are the two sentences it was asked for, and they are what someone
 * reading `git log` a month later needs. The report is model output that has read
 * untrusted CI logs, so it goes through `printable` like every other worker
 * string that reaches a terminal.
 */
export function repairMessage(report, decision) {
  const clean = s => printable(String(s ?? "")).replace(/\s+/g, " ").trim();
  const change = clean(report?.change);
  const cause = clean(report?.cause);
  const scope = decision?.action === "FIX_FINDINGS" ? "review" : "ci";
  // Conventional Commits: a lowercase subject of at most 72 characters and no
  // trailing period. Truncation falls back to a word boundary, because a subject
  // cut mid-word reads as corruption rather than as brevity.
  const said = (change || "repair the failing check").replace(/\.+$/, "");
  const prefix = `fix(${scope}): `;
  const body = `${said.charAt(0).toLowerCase()}${said.slice(1)}`;
  const room = 72 - prefix.length;
  // A word boundary when there is one, a hard cut when there is not. Trimming to
  // the last space deleted the ENTIRE description when the first token was longer
  // than the room available -- measured, a 100-character first word produced
  // exactly `fix(ci):`, which is uninformative history and not a valid
  // Conventional Commit either, since the description is required.
  const cut = body.length <= room ? body
    : (body.slice(0, room).replace(/\s+\S*$/, "") || body.slice(0, room));
  const subject = prefix + cut;
  return cause ? `${subject}\n\n${cause}` : subject;
}

/**
 * Which of `wanted` are tracked in `worktree`, without buffering the index.
 *
 * `git ls-files -z` writes to a temp file rather than a pipe, so the output size
 * is the filesystem's problem rather than a subprocess buffer's, and the file is
 * then read in fixed chunks. Only the record being assembled and the caller's
 * bounded set are ever in memory, so a repository with any number of tracked
 * paths is answered the same way -- which is the point, because the alternative
 * failure mode is not a slow answer but a THROWN one, and this function's caller
 * reads a throw as "the checkout is unreadable" and holds back a finished repair.
 *
 * Returns only the intersection: the caller asked a membership question, and
 * returning the whole index would put the unbounded thing back in memory one
 * frame up.
 */
function trackedAmong(worktree, wanted) {
  const found = new Set();
  const tmp = join(tmpdir(), `reeve-lsfiles-${process.pid}-${randomBytes(6).toString("hex")}`);
  let fh = null;
  try {
    const sink = openSync(tmp, "w");
    try {
      execFileSync("git", ["-C", worktree, ...GIT_NEUTRALISE, "ls-files", "-z"],
                   { stdio: ["ignore", sink, "pipe"], env: gitEnv() });
    } finally { closeSync(sink); }

    fh = openSync(tmp, "r");
    const buf = Buffer.allocUnsafe(1 << 16);
    // A path can straddle a chunk boundary, so the tail of one read is the head of
    // the next. Kept as a Buffer, not a string: a multi-byte character split
    // across two reads would be corrupted by decoding each half on its own.
    let carry = Buffer.alloc(0);
    for (;;) {
      const n = readSync(fh, buf, 0, buf.length, null);
      if (n <= 0) break;
      let hay = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      let from = 0, nul;
      while ((nul = hay.indexOf(0, from)) !== -1) {
        const rel = hay.toString("utf8", from, nul);
        if (rel && wanted.has(rel)) found.add(rel);
        from = nul + 1;
      }
      carry = hay.subarray(from);
    }
    // git terminates every record with NUL, so a non-empty carry means the output
    // was truncated. Nothing is inferred from it.
    return found;
  } finally {
    if (fh !== null) { try { closeSync(fh); } catch {} }
    try { unlinkSync(tmp); } catch {}
  }
}

/**
 * Is reeve allowed to act on review threads at all?
 *
 * One reader, so the flag cannot be half-observed. It is OFF unless a profile says
 * otherwise, and that default is the point: this whole path performs real, visible
 * GitHub writes on someone else's pull request, and the founder turns it on
 * deliberately after the shadow week rather than inheriting it from a merge.
 */
/**
 * The escalation CAUSE for dead-lettered effects of one kind.
 *
 * A function, and it takes no count, because the count is not part of the cause.
 * `announceable` treats the key as identity and the map value as the count: a
 * changed value re-announces the SAME cause, while a changed key is a new cause
 * and leaves the old one standing until something clears it.
 *
 * Written with the number interpolated, every count was a different cause -- two
 * reads in one pass produced two keys instead of one updated one, so a single
 * notification could carry contradictory totals and the next tick would retire the
 * stale one as though it had been resolved.
 */
export const deadLetterCause = kind =>
  `${kind} effect(s) reeve could not perform and will not retry — they need a person`;

/**
 * The pull request an effect belongs to, read out of its idempotency key.
 *
 * `review-request:<owner>/<repo>:<pr>:...`. Anything that does not match returns
 * null, and a caller then treats the row as its own subject rather than silently
 * merging it with another pull request's.
 *
 * ONE parse, because two callers need it for opposite purposes -- one to count
 * dead letters per pull request, one to find out which of those pull requests are
 * over -- and a key that two readers disagree about is a row that is counted under
 * one identity and retired under another.
 */
export const prFromIdemKey = key => /^[^:]+:[^:]+\/[^:]+:(\d+):/.exec(String(key))?.[1] ?? null;

export const reviewActionsOn = profile => profile?.watch?.reviewActions === true;

export function uncommittedFiles(worktree, copiedBaseline = {}, { digest = digestOf } = {}) {
  try {
    // Read over EVERYTHING, then subtract what the daemon itself put there.
    //
    // Excluding the copied trees by path could not tell reeve's files from the
    // worker's: with `--` plus `:(exclude)` the tree vanished entirely, and with
    // `--untracked-files=no` inside it an undeclared new file vanished too. Either
    // way an incomplete repair published and the checkout holding the omitted part
    // was deleted. The baseline recorded at prepare time is the only thing that
    // separates them, because it is the one fact only reeve knows.
    // A path is only reeve's own if its CONTENT still matches what reeve left
    // there. git reports an edited copy exactly as it reports an untouched one, so
    // a pathname-only baseline subtracted the worker's edit and let an incomplete
    // repair publish. Re-hashed per reported path, so the ordinary tick pays
    // nothing: git mentions almost none of them.
    const baseline = copiedBaseline ?? {};
    // Memoised, because a path can be reached twice -- once from its status record
    // and once from the baseline sweep -- and each miss is a synchronous read of
    // up to MAX_FINGERPRINT_BYTES.
    const answered = new Map();
    const wasMine = rel => {
      if (answered.has(rel)) return answered.get(rel);
      const want = baseline[rel];
      const mine = typeof want === "string" && digest(join(worktree, rel)) === want;
      answered.set(rel, mine);
      return mine;
    };
    // `--untracked-files=all`, because the default COLLAPSES an entirely untracked
    // directory to `node_modules/` while the baseline holds file paths -- so the
    // subtraction missed and every copied tree read as one uncommitted change. The
    // two readings have to agree on granularity or the baseline cannot subtract.
    // NOT trimmed: `-z` output is data, and a filename may begin or end with
    // whitespace. Callers split on NUL and drop the empty tail themselves.
    const raw = args => execFileSync("git", ["-C", worktree, ...GIT_NEUTRALISE, ...args],
                                     { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: gitEnv() });
    const out = raw(["status", "--porcelain", "--untracked-files=all", "-z"]);
    // `-z` records are NUL-separated and a rename carries its source as the NEXT
    // record, so the walk has to consume it rather than read it as a status line.
    const records = out.split("\0");
    const left = [], reported = new Set();
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!rec) continue;
      const xy = rec.slice(0, 2), file = rec.slice(3);
      if (/[RC]/.test(xy)) { const src = records[++i]; if (src) { reported.add(src); if (!wasMine(src)) left.push(src); } }
      if (file) { reported.add(file); if (!wasMine(file)) left.push(file); }
    }
    // Only the baseline paths status never MENTIONED, because deleting an
    // untracked file produces no record at all -- there is nothing left for git to
    // report. A worker that removes a dependency file its fix depended on would
    // otherwise leave the checkout reading clean, and the source half of the
    // repair would publish without it.
    //
    // Keyed on what status reported rather than on what failed the check: an
    // untouched baseline file is mentioned by status and passes, so it never
    // reaches `left`, and keying on `left` would have re-hashed every one of them
    // after every paid worker run.
    //
    // TRACKED baseline paths are excluded, and that is not an exception to the
    // rule but the same rule read correctly. A worker may legitimately declare a
    // copied dependency it patched; reeve then force-stages and COMMITS it, after
    // which status is silent about it for the same reason a deletion is silent --
    // there is nothing outstanding. Its digest no longer matches the pre-worker
    // baseline precisely BECAUSE the repair is carried, so flagging it refused
    // exactly the case the declaration exists to permit. What the gate is looking
    // for is work the push would LOSE, and a committed file is not that.
    //
    // Which baseline paths are TRACKED, decided without ever holding a list whose
    // size the repository controls.
    //
    // Two sizes meet here and only one of them is bounded. Preparation accepts up
    // to MAX_COPIED_UNTRACKED baseline paths, so naming them as pathspecs put that
    // many into argv and breached ARG_MAX. Reading the index instead moved the
    // unbounded side to git's output, where a large enough repository breaches the
    // subprocess buffer. Both failures land in the same place -- the call throws,
    // this returns null, and the caller quarantines a repair that was fine -- so
    // both were the same defect wearing different limits, and swapping one for the
    // other is not a fix.
    //
    // So neither list is held. git streams the index to a file, and it is read
    // back in fixed-size chunks with only the current record and the bounded
    // baseline set in memory. There is no constant to tune, no ceiling for a
    // repository to breach, and the cost is one pass over the index. It stays
    // synchronous because the publication gate that calls it is.
    const names = Object.keys(baseline);
    let tracked = new Set();
    if (names.length) tracked = trackedAmong(worktree, new Set(names));
    for (const rel of names)
      if (!reported.has(rel) && !tracked.has(rel) && !wasMine(rel)) left.push(rel);
    return left;
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
  const cands = [logPath, ...dbFiles, join(stateDir, "runs"), join(stateDir, "canary"), join(stateDir, "backups"), resolveHome()]
    .filter(p => p && isAbsolute(p));
  return [...new Set(cands)].filter(p => !(worktree && under(p, worktree)));
}

/**
 * The containment verdict the daemon acts on: cheap gates first, then the paid
 * sandbox canary. Exported so `reeve canary` can run exactly this, rather than a
 * reconstruction of it that could drift from what dispatch actually does.
 */
export async function measuredContainment(ctx, profile, nwo, logPath, { beforeSpawn = null, onSpawn = null } = {}) {
  // THE CACHE LIVES ON THE CALLER'S PERSISTENT CONTEXT, and that is why these
  // two hooks are parameters rather than fields on it.
  //
  // `tick` used to build `{ ...ctx, canaryBeforeSpawn, canaryOnSpawn }` purely to
  // carry two functions, and this lazy `??=` then created the Map on that
  // per-tick COPY. `run` loops on ONE persistent ctx, so every tick began with an
  // empty cache and paid for the containment canary again -- and since nothing in
  // the repository ever seeded the field, the cache had never once survived a
  // tick since it was written.
  //
  // Seeding the copy before spreading would have fixed this call site and left
  // the mechanism intact: the next field a callee lazily attaches to `ctx` is the
  // same defect again. Removing the copy removes the class.
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
      // `resolveHome()`: with `--home` the decoy used to be written under
      // `~/.reeve` while the policy denied the home the operator named, so the
      // canary measured a file the sandbox had no rule about and could report
      // containment CLOSED for a policy that closed nothing.
      decoyPath: join(resolveHome(), "canary", nwo.replace("/", "-"), `decoy-${process.pid}-${Date.now()}.txt`),
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
                                           permissionsDeny: policy.settings.permissions.deny, allowedTools: policy.allowedTools,
                                           instrument: instrumentHash({ hasNet: !!netProbe }) }))?.ok === true;
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
      // BOUND BEFORE IT RUNS, like every other dispatch. The canary is a
      // detached model call of up to five minutes; without this its provider
      // lease stays on the guardian's own pid, so a guardian that dies mid-canary
      // leaves a lease whose holder reads dead while the call is still being
      // paid for -- and a restore or a reap then frees a slot the provider is
      // still serving.
      onSpawn: onSpawn ?? (() => {}),
      beforeSpawn: beforeSpawn ?? (async () => ({ ok: true })),
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
export function finishedSubjects(db, nwo, open, io = {}) {
  const isFinished = io.prIsFinished ?? prIsFinished;
  const gone = new Set();
  const candidates = new Set();

  // Two sources, because a pull request can be standing in this store under an
  // identity the other source cannot express.
  //
  // An escalation names its subject as `#<pr>:`. A dead-letter escalation
  // deliberately does NOT -- `deadLetterCause` is keyed by kind alone, so that two
  // reads in one pass update one cause instead of raising two -- and the aggregate
  // it carries is a count, with the pull requests already summed away. So when a
  // dead letter is the only escalation a pull request has, scanning escalations
  // alone finds nothing, the retirement below never runs for it, and its terminal
  // row and its alert stand for good with a count nothing can reduce. The rows
  // themselves still know: the pull request is in the idempotency key.
  try {
    for (const { why } of db.prepare("SELECT why FROM escalation").all()) {
      const m = String(why).match(/^#(\d+):/);
      if (m) candidates.add(Number(m[1]));
    }
  } catch { return gone; }
  try {
    // Queued as well as terminal. A pending effect for a finished pull request is
    // the same standing claim on a person's attention, arriving a little earlier:
    // on the degraded path nothing evaluates the pull request, so nothing else is
    // ever going to withdraw it.
    for (const { idem_key } of db.prepare(
      `SELECT idem_key FROM outbox WHERE status IN ('pending','dead_letter')`).all()) {
      const pr = prFromIdemKey(idem_key);
      if (pr !== null) candidates.add(Number(pr));
    }
  } catch { /* an unreadable outbox must not cost us the escalation half */ }

  for (const pr of candidates) {
    if (open.has(pr)) continue;
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
function record(db, { pr, head, verdict, decision, effects = [], retire = new Map() }) {
  try {
    // ONE transaction, and that is the outbox's whole reason for existing. The
    // decision and the side effect it implies have to become durable together or
    // neither: a crash between them leaves a store saying a review round was
    // requested and a pull request where nothing was said, and re-deriving on the
    // next tick is not a repair -- the head, the profile, the PR's state or an
    // UNKNOWN timeout can all have moved, so the next tick may legitimately decide
    // something else and the effect is simply lost.
    return tx(db, () => {
      db.prepare(`INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)`)
        .run(now(), "daemon", "pr.decided", `pr:${pr}`, JSON.stringify({
          head, state: verdict.state, summary: verdict.summary,
          action: decision.action, why: decision.why,
          clauses: verdict.clauses.map(c => ({ id: c.id, state: c.state })),
        }));
      // `enqueue` returns null for a key it already holds, which is success: the
      // effect is durable, it was simply made durable by an earlier tick.
      let queued = 0, known = 0, dropped = 0;
      // Reconcile BEFORE enqueuing, and against the whole desired set rather than
      // one key at a time.
      //
      // Doing it per-effect meant cleanup only happened while creating a
      // replacement -- so when the desired set became EMPTY it never ran at all,
      // and a request for a reviewer since removed from the profile would still be
      // posted, while a dead letter for one would escalate forever. `retire`
      // carries the desired set even when it is empty, which is the case that
      // needed it.
      for (const [prefix, keep] of retire) dropped += supersedeEffects(db, { prefix, keep });
      for (const eff of effects) {
        // Withdraw what this one supersedes, in the SAME transaction. A transient
        // failure leaves a row pending on a backoff; if the pull request gets a new
        // commit before that retry comes due, the new head enqueues its own effect
        // and both are pending. They carry different markers, so neither
        // idempotency check can see the other, and the reviewer is asked twice for
        // what is now the same head.
        //
        // The prefix stops before the head, so it matches this reviewer's requests
        // on this pull request at ANY head, and `keep` spares the one just made.
        (enqueue(db, eff) !== null ? queued++ : known++);
      }
      return { ok: true, queued, known, dropped };
    });
  } catch (err) {
    // A store that cannot record must not stop the loop -- but it must not report
    // an effect as queued either. The caller says so out loud.
    return { ok: false, queued: 0, known: 0, why: err.message };
  }
}

/**
 * The GitHub effects a decision implies, ready to be made durable WITH it.
 *
 * Built here rather than at dispatch, because dispatch is about workers and these
 * are not worker tasks. Returns an empty list for every action that has no such
 * effect, so the caller has one shape to handle.
 *
 * The key is per HEAD on purpose: a new head is a new round and must ask again,
 * while a repeated tick at one head must not.
 */
/** The identity of one reviewer's request at one head, in ONE place.
 *
 * Written twice it would drift, and the drift would appear as a request being
 * retired the moment after it was created -- the reconciliation would compute a
 * key the enqueue did not use, find the new row unaccounted for, and delete it. */
const keyFor = (nwo, e, r) =>
  `review-request:${nwo}:${e.pr}:${r.login}:${e.head}:${sha256(r.trigger).slice(0, 12)}`;

export function effectsFor({ nwo, e, decision, profile, execute }) {
  // BOTH gates, and they answer different questions. `--execute` is "may reeve act
  // at all"; `watch.reviewActions` is "may it act on review threads". An
  // observational run must not queue a visible GitHub write any more than it may
  // perform one -- a queue outlives the run that made it, so producing while
  // disarmed only moves the acting to whichever run drains it next.
  if (!execute || !reviewActionsOn(profile)) return { effects: [], unsummonable: [], retire: new Map() };
  const reviewers = profile.reviewers ?? [];
  // A BLOCKING reviewer with no trigger is the dangerous shape, and it is quiet by
  // construction: the profile validator only warns, the filter drops them, and if
  // any other reviewer does have a trigger the effect list is non-empty -- so the
  // tick reports comments queued, later ticks deduplicate the same head, and a
  // reviewer whose approval is REQUIRED is never summoned and never mentioned.
  // The pull request then waits on a round nobody asked for.
  // `kind === "blocking"`, which is how a profile actually says it -- the schema
  // validator, the verdict and the review derivation all read it that way. I wrote
  // `r.blocking`, a property no profile has, so this list was ALWAYS empty and the
  // escalation it feeds could never fire. The validator warns about this exact
  // reviewer at schema.mjs:379, which is the case this is meant to carry further.
  const unsummonable = reviewers.filter(r => r.kind === "blocking" && !r.trigger).map(r => r.login);
  const effects = reviewers.filter(r => r.trigger).map(r => ({
    // The REVIEWER precedes the head in the key, and that ordering is the whole
    // mechanism. With the head first, no prefix can name one reviewer's requests,
    // so the supersede below matched every reviewer on the pull request -- and
    // since the effects are enqueued in a loop, the second reviewer's supersede
    // deleted the first reviewer's row that had just been created. Only the last
    // reviewer would ever have been summoned.
    // The trigger's CONTENT is part of the identity, not just who and where.
    //
    // Without it, correcting a trigger an operator got wrong -- a comment the bot
    // accepted syntactically and then ignored -- produces the same key, so the
    // existing done or dead-lettered row wins the conflict and the corrected body
    // is never enqueued. That reviewer then cannot be summoned at all until some
    // other commit happens to move the head, which is an unrelated event that may
    // never come. A key that ignores what is being SENT cannot tell "already sent
    // this" from "already sent something else to the same place".
    //
    // The supersedes prefix stops before the head, so a corrected trigger at the
    // SAME head withdraws the obsolete request as well as replacing it.
    idemKey: keyFor(nwo, e, r),
    // What this replaces: THIS reviewer, this pull request, any earlier head.

    kind: "gh.pr.comment",
    // `head` travels with the effect so the handler can refuse a request that has
    // been overtaken. Withdrawing superseded PENDING rows covers the ordinary
    // case; it deliberately leaves INFLIGHT rows alone, because deleting one its
    // drainer holds would leave it settling into nothing. That leaves exactly one
    // window -- a head that moves while a delivery is in flight -- and the only
    // thing that can close it is the delivery itself declining to post.
    args: { nwo, pr: e.pr, body: r.trigger, head: e.head },
  }));
  // What SHOULD be queued for this pull request, computed from the profile and the
  // current head — deliberately independent of what this tick decided.
  //
  // The decision answers "ask now?". This answers "what is still wanted?", and
  // they are different questions. A request stays wanted while its reviewer is
  // configured with that trigger and the head has not moved; it stops being wanted
  // when the reviewer is removed, the trigger is corrected, or the head changes —
  // none of which is a decision.
  //
  // Keyed by the reviewer's prefix so one reviewer's requests can be reconciled
  // without touching another's.
  const retire = new Map();
  for (const r of reviewers.filter(x => x.trigger)) {
    const prefix = `review-request:${nwo}:${e.pr}:${r.login}:`;
    retire.set(prefix, new Set([keyFor(nwo, e, r)]));
  }
  // A reviewer no longer in the profile leaves rows nothing above will name, so the
  // pull-request-wide prefix is reconciled too, sparing every key still wanted.
  retire.set(`review-request:${nwo}:${e.pr}:`, new Set(effects.map(x => x.idemKey)));

  // Only the REQUEST_REVIEW decision enqueues. Everything else still reconciles:
  // a stale request must not be posted just because this tick decided to WAIT.
  const asking = decision.action === "REQUEST_REVIEW";
  return { effects: asking ? effects : [], unsummonable: asking ? unsummonable : [], retire };
}

/**
 * What a FIX_FINDINGS worker is actually sent, given what the decision decided.
 *
 * The decision decides WHAT is dispatched, not merely whether to dispatch.
 * `nextAction` withholds a body finding while its reviewer has not covered this
 * head, because nothing a worker does can close one — there is no thread to
 * resolve — and repairing it only pushes a head that re-opens it. That judgement
 * was being made and then discarded: on a MIXED pull request, a stale body finding
 * beside an unresolved thread, the branch still fires for the thread and the whole
 * list went to the prompt, body finding included.
 *
 * A named function rather than a line inside `tick`, because a rule buried in a
 * branch of a 2000-line loop is a rule nothing can test. Pure, so it can be.
 */
/**
 * The identity of a findings-repair problem: WHICH findings are open.
 *
 * Keyed by the SET rather than by revision, matching how the CI cap is keyed by
 * cause. Fixing one changes the set, which is a different problem and earns a
 * fresh budget; changing nothing leaves the same set, which does not.
 *
 * Sorted, so the identity does not depend on the order a projection happened to
 * return. Null for an empty set, because "nothing is open" is not a problem to be
 * capped and a fingerprint over nothing would collide with every other empty case.
 */
export function findingsFingerprint(items, ledgerIds) {
  const ids = [
    // Only findings that can GATE. `gates === false` marks one that is neither
    // dispatched nor blocking — an advisory reviewer's body finding — and letting
    // it into the identity meant advisory churn reset the brake's budget against
    // an unchanged problem. Undefined counts as gating, so a caller that does not
    // mark items keeps the previous behaviour rather than silently narrowing.
    ...(items ?? []).filter(t => t?.gates !== false).map(t => String(t?.id ?? "")),
    // LEDGER BLOCKERS COUNT TOO. `FIX_FINDINGS` is selected by the `findings`
    // clause as well as the thread ones, and when a ledger blocker is the only
    // reason there are no review findings at all — so a key built from review
    // threads alone was null, `attemptKey` recorded nothing, and the brake never
    // engaged for the one kind of repair that has no GitHub state to change.
    ...(ledgerIds ?? []).map(id => `ledger:${String(id ?? "")}`),
  ].filter(Boolean).sort();
  return ids.length ? `findings:${sha256(ids.join("\n")).slice(0, 16)}` : null;
}

/**
 * What identifies the attempt this decision is about to spend, or null for a
 * decision that spends nothing.
 *
 * One function rather than a conditional per action, because the two were drifting
 * apart: FIX_CI had a budget from the day it was written and FIX_FINDINGS had none
 * at all, and nothing in either call site said the other should exist. Asking
 * "what identifies this attempt" in one place makes a missing answer visible.
 *
 * The caller decides WHETHER to spend — an attempt that never started is not an
 * attempt — and this decides WHAT would be spent.
 */
export function attemptKey(decision, ciFingerprint, threadDetails, ledgerIds) {
  if (decision?.action === "FIX_CI") return ciFingerprint || null;
  if (decision?.action === "FIX_FINDINGS") return findingsFingerprint(threadDetails, ledgerIds);
  return null;
}

export function dispatchable(decision, threadDetails) {
  const items = threadDetails ?? [];
  return decision?.bodyFindings ? items : items.filter(t => t?.anchor !== "body");
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
// How long before the guardian re-asks for a repository id it could not resolve.
// A constant, not a profile key: the value only matters when the answer is
// missing, and a knob the schema does not declare fails validation for anyone
// who tries to turn it.
const REPO_ID_RETRY_SECONDS = 600;
// How long the provider is treated as exhausted after a worker comes back rate
// limited. A constant for the same reason as the retry above: an undeclared
// profile key fails validation for anyone who tries to turn it.
const RATE_LIMIT_COOLDOWN_SECONDS = 600;

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
  // Pull requests this tick could not read. Their queued provider requests are
  // preserved rather than cancelled: absence from `decisions` means "unknown",
  // not "no longer wanted".
  const unreadable = new Set();
  // Run refs this tick actually put to the scheduler, and the queued rows it
  // read. The cancel phase after the dispatch loop needs both.
  const askedFor = new Set();
  // Run refs this tick WANTS but could not put to the scheduler, because the
  // SCHEDULER refused rather than because this tick decided against the work.
  // The sweep must tell those apart: a local refusal is a withdrawal, a `queued`
  // is the scheduler saying "not yet".
  const heldByScheduler = new Set();
  let queuedNow = [];
  let intendedNow = new Set();
  const escalations = new Map();
  /**
   * Raise a cause. The count is the VALUE and can never be part of the key.
   *
   * `announceable` treats a changed key as a new cause and a changed value as the
   * same cause with a new shape, so a volatile number interpolated into the key
   * turns one standing outage into a stream of alerts, each of which retires the
   * last as though it had been resolved. `deadLetterCause` was written to fix
   * exactly that, and three sites drifted back afterwards -- two with a queue
   * depth in the key, one setting a shared key to 1 per pull request so the last
   * iteration overwrote the rest and the notification never said how many were
   * affected.
   *
   * Correcting the third instance of a shape is not the fix; removing the way to
   * write it is. `set` is not called directly any more: every raise goes through
   * here, accumulates rather than overwrites, and takes the count as an argument
   * so that putting it in the key requires deliberately going around this.
   */
  const raise = (cause, n = 1) => escalations.set(cause, (escalations.get(cause) ?? 0) + n);

  // Carrying out queued effects does not depend on being able to LIST pull
  // requests, and the two use different credentials -- `openPrs` uses the ambient
  // `gh` login, the outbox uses the GitHub App. A broken ambient credential would
  // otherwise leave review requests undelivered indefinitely while everything
  // needed to deliver them was healthy. So this is a function both exits call,
  // rather than a block only the successful path reaches.
  // Counted in PULL REQUESTS, not in rows, because that is the unit the
  // announcement renders: `announceable` prints any count above one as "(N PRs)".
  // Two failed reviewer triggers on ONE pull request are two rows and one PR, and
  // reporting the row count claimed two repositories' worth of trouble where
  // there was one.
  //
  // The identity comes from the key rather than the args, because a row whose args
  // cannot be parsed still belongs to a pull request and still needs counting.
  const deadLetters = () => {
    const rows = db.prepare(`SELECT kind, idem_key FROM outbox WHERE status='dead_letter'`).all();
    const byKind = new Map();
    for (const r of rows) {
      const pr = prFromIdemKey(r.idem_key) ?? r.idem_key;
      if (!byKind.has(r.kind)) byKind.set(r.kind, new Set());
      byKind.get(r.kind).add(pr);
    }
    return [...byKind].map(([kind, prs]) => ({ kind, prs: prs.size, rows: rows.filter(r => r.kind === kind).length }));
  };

  /**
   * Retire queued review requests the CURRENT profile no longer wants.
   *
   * `effectsFor` reconciles per pull request while that pull request is being
   * evaluated. A row can outlive that: authentication failed, or a delivery backed
   * off, and by the next tick the operator has removed the reviewer or corrected
   * the trigger. On the degraded path there is no evaluation at all, so nothing
   * reconciles and the drain posts the obsolete trigger -- the handler checks the
   * pull request's state and head, neither of which knows anything about the
   * profile.
   *
   * This is the half that needs no pull request: a request whose REVIEWER is gone,
   * or whose TRIGGER no longer matches any configured one, is unwanted whatever
   * head it was for. The head-specific half stays in `effectsFor`, because only an
   * evaluated pull request knows its head.
   */
  const retireUnconfigured = () => {
    if (!reviewActionsOn(profile)) return 0;
    const wanted = new Set((profile.reviewers ?? []).filter(r => r.trigger)
      .map(r => `${r.login}:${sha256(r.trigger).slice(0, 12)}`));
    const rows = db.prepare(`SELECT id, idem_key FROM outbox
                             WHERE status IN ('pending','dead_letter') AND idem_key LIKE 'review-request:%'`).all();
    let dropped = 0;
    for (const r of rows) {
      // review-request:<nwo>:<pr>:<login>:<head>:<trigger-hash>
      const m = /^review-request:[^:]+\/[^:]+:\d+:([^:]+):[^:]+:([0-9a-f]+)$/.exec(r.idem_key);
      if (!m) continue;                                  // an unfamiliar shape is not ours to retire
      if (wanted.has(`${m[1]}:${m[2]}`)) continue;
      dropped += tx(db, () => supersedeEffects(db, { prefix: r.idem_key, keep: new Set() }));
    }
    if (dropped) log(logPath, `  outbox: withdrew ${dropped} review request(s) the profile no longer asks for`);
    return dropped;
  };

  // `finished` is passed IN rather than captured. It is declared far below this
  // closure, so the degraded exit -- which runs early -- would hit its temporal
  // dead zone and throw. The catch would have swallowed that, leaving the feature
  // silently inert on exactly the path it was added for.
  const drainDueEffects = async (finishedPrs = []) => {
    // `--execute` gates DELIVERY as well as dispatch, and that is the CLI's own
    // definition of the flag: act, rather than observe. Posting a comment on
    // someone's pull request is acting -- it is visible, it is not undoable, and a
    // run started to watch must not do it.
    //
    // Two gates, not one, and they answer different questions. `--execute` is "may
    // reeve act at all"; `watch.reviewActions` is "may it act on review threads".
    // A queue persisted by an earlier armed run is exactly the case that makes the
    // first one necessary: without it, an observational run started afterwards
    // would drain that queue and post.
    //
    // The dead-letter escalation below still runs. Refusing to ACT is not a reason
    // to stop SAYING what is stuck -- an observational run is the one most likely
    // to be looked at by a person.
    // HALTED is rechecked here, not inherited from the per-pull-request loop. The
    // marker can appear after the last of those checks and before this runs --
    // backup and the self-audit both sit in between -- and posting a comment is
    // exactly what an emergency stop exists to prevent. It is read at the moment
    // of acting, because that is the only reading that decides anything.
    //
    // `reviewActionsOn` is here as well as in the producer. Gating production
    // alone left the case the queue exists to create: rows persisted by an earlier
    // run, drained after the operator turned the switch OFF. A safety switch that
    // stops new work but not the work already queued has not stopped anything a
    // person can see.
    //
    // Expressed as a FILTER over handlers rather than a condition on the block,
    // so a kind reeve may not perform is simply not performable -- the drainer
    // never leases it, and the "pending with no handler" line already says so.
    //
    // GATED BY DEFAULT, exempted by declaration. This was written the other way
    // round -- a list of kinds that are gated, everything else permitted -- which
    // is fail-open by construction: adding a handler silently added an ungated
    // externally-visible effect, and that is precisely how `gh.issue.create`
    // arrived unprotected. The exemption list lives beside the handlers in
    // src/outbox/effects.mjs so adding one and deciding whether the switch governs
    // it are the same edit.
    const permitted = permittedHandlers(ctx.handlers ?? HANDLERS, reviewActionsOn(profile));
    // BEFORE the drain, on every path. A request the profile no longer asks for
    // must not be posted by a tick that happens to be unable to evaluate the pull
    // request it belongs to.
    try { retireUnconfigured(); } catch (e) { log(logPath, `  outbox: could not reconcile against the profile — ${e.message}`); }

    if (execute && !halted(ctx.haltMarker) && Object.keys(permitted).length && ctx.drain !== false) {
      try {
        // The QUEUE is read before the credential. Authenticating first meant an
        // installation lookup and a fresh token mint on every ordinary tick --
        // roughly a thousand a day per repository -- to discover there was nothing
        // to do, which also made the comment above about an idle tick costing one
        // query untrue. Rows recoverable from a dead drainer count as work, or a
        // crashed delivery waits for a tick that happens to have new work in it.
        // Dead letters FIRST, and outside every branch below.
        //
        // Nested inside "there is work due" it disappeared exactly when it mattered:
        // once the last due row is dead-lettered, `due` is 0, the query is skipped,
        // and `announceable` sees a standing escalation absent on a complete tick and
        // CLEARS it -- so the permanent loss announces itself once and is then
        // retracted. The same held while authentication failed, and across a restart.
        // A terminal row is a fact about the store, not about this tick's work.
        // The KEY is the cause; the COUNT is the value. `announceable` reads them
        // that way -- the key is identity, and a changed value is what makes a
        // known cause worth re-announcing.
        //
        // Putting the number in the string made every count a different cause. Two
        // reads in one pass produced two keys rather than one updated one, so a
        // single notification could carry contradictory totals, and the next tick
        // would clear the stale one as though it had been resolved. This is also
        // why it is read ONCE, after the drain, rather than before and after.


        // Counted over the kinds this build can actually DRAIN.
        //
        // Unfiltered, a due row whose kind has no handler here -- or one gated off
        // by `reviewActions` -- made the daemon mint a token for work the drainer
        // deliberately will not lease. Harmless when authentication works, and
        // actively misleading when it does not: the tick then reports that
        // credentials are blocking an effect that no credential would have moved,
        // and never reaches the drainer's accurate "pending with no handler" line.
        // The same filter the drainer leases by, so the two cannot disagree about
        // what is drainable.
        const kinds = Object.keys(permitted);
        const due = kinds.length ? db.prepare(`SELECT count(*) n FROM outbox
                                WHERE kind IN (${kinds.map(() => "?").join(",")})
                                  AND ((status='pending' AND not_before<=unixepoch())
                                    OR (status='inflight' AND lease_expires_at<unixepoch()))`).get(...kinds).n : 0;
        if (!due) { /* nothing to carry; do not mint a token to find that out */ }
        else {
        const auth = await (ctx.authenticate ?? authenticate)(nwo);
        if (!auth.ok) {
          log(logPath, `  outbox: ${due} effect(s) waiting; cannot authenticate — ${auth.why}`);
          // Escalated, not merely logged. No row is leased on this path, so nothing
          // spends an attempt, nothing reaches its retry budget and nothing becomes
          // a dead letter -- the queue simply stops, silently, and a blocking review
          // request can wait forever without anything reaching the notification
          // channel. Missing credentials and an uninstalled App both land here, and
          // neither fixes itself.
          // The DEPTH is the count, not part of the cause. With it interpolated,
          // every change in the queue while an outage persisted was a brand new
          // cause: another notification, and the previous one retired as resolved.
          raise(`queued effect(s) cannot be performed: reeve cannot authenticate — ${auth.why}`, due);
        } else {
          const api = (args, opts) => apiAsInstallation(auth.token, args, opts);
          // `auth.actor` is the login reeve's own comments carry. A handler needs it
          // to tell its own writing from a contributor's; null means GitHub did not
          // say, and a handler must read that as "cannot tell" rather than "matches".
          const r = await drainOutbox({ db, log: m => log(logPath, m), handlers: permitted,
                                        api, actor: auth.actor ?? null });
          const posted = r.done.filter(d => d.verdict === "done").length;
          if (posted) log(logPath, `  outbox: performed ${posted} effect(s)`);
          // A dead letter is PERMANENT: no later drain leases the row again, so the
          // effect is not late, it is gone. It had only a log line to say so, and a
          // log line is not a channel -- nothing reads dead-lettered rows, so the
          // one signal that a review request was lost forever scrolled past.
          //
          // Counted from the store rather than from this pass, because recovery can
          // dead-letter a row in a tick that performed nothing, and because a
          // restart must not make the backlog disappear.
          /* the dead-letter escalation is raised once, below, after every branch */
        }
        }
      } catch (err) {
        log(logPath, `  outbox: drain failed — ${err.message}`);
        // Escalated, not merely logged, and for the same reason the `!auth.ok`
        // branch is: nothing on this path leases a row, so nothing spends an
        // attempt, reaches a retry budget or becomes a dead letter. The queue just
        // stops.
        //
        // This catch is reachable in a way the `ok:false` branch is not:
        // `authenticate` can THROW rather than return -- `apiAsApp` uses an
        // uncaught `fetch`, so a DNS, TLS or connection failure arrives here. And
        // silence would be worse than a missing alert: on an otherwise complete
        // tick, a standing authentication escalation that this tick did not
        // re-raise is CLEARED, so a persistent outage would announce itself once
        // and then quietly retire its own alarm.
        //
        // Counted from the store rather than carried from above, because the
        // throw may have happened before `due` was read.
        try {
          // Filtered like `due` above, and for the same reason: a row this build
          // cannot perform is not evidence that the drain is failing.
          const kinds = Object.keys(permitted);
          const stuck = kinds.length ? db.prepare(`SELECT count(*) n FROM outbox
                                    WHERE kind IN (${kinds.map(() => "?").join(",")})
                                      AND ((status='pending' AND not_before<=unixepoch())
                                        OR (status='inflight' AND lease_expires_at<unixepoch()))`).get(...kinds).n : 0;
          if (stuck) raise(`queued effect(s) cannot be performed: the drain is failing — ${err.message}`, stuck);
        } catch { /* a store that cannot be read must not take the tick down */ }
      }
    }
    // A terminal row whose pull request is over is retired before it is counted.
    //
    // Nothing else can reach it: `effectsFor` only reconciles a pull request that
    // is being EVALUATED, and a closed one leaves the open list and is never
    // evaluated again. The aggregate below also discards the pull-request
    // identity, and the clearing rule only recognises a `#<pr>:` escalation key --
    // so a shared dead-letter alert for a merged pull request would stand forever,
    // with a count nothing could ever reduce.
    try {
      for (const pr of finishedPrs) {
        const prefix = `review-request:${nwo}:${pr}:`;
        const n = tx(db, () => supersedeEffects(db, { prefix, keep: new Set() }));
        if (n) log(logPath, `  outbox: withdrew ${n} effect(s) for #${pr}, which is finished`);
      }
    } catch (e) { log(logPath, `  outbox: could not retire finished pull requests — ${e.message}`); }

    // OUTSIDE the execute gate, deliberately. A terminal row is a fact about the
    // store, not about whether this run is allowed to act -- and an observational
    // run is the one most likely to have a person reading it. Raised after every
    // branch for the same reason: if it were raised only where work happened it
    // would vanish on the tick after the last row died, and `announceable` would
    // then clear it as resolved.
    try {
      for (const d of deadLetters())
        raise(deadLetterCause(d.kind), d.prs);
    } catch { /* an unreadable store is reported by the audit, not by crashing here */ }
  };

  // Turning escalations into announcements, as a function BOTH exits call.
  //
  // A tick that cannot list pull requests still drains, and a drain can recover a
  // row or newly dead-letter one -- a permanent loss. That reached `escalations`
  // and then hit an immediate `return`, so it was logged and never announced, for
  // as long as listing stayed broken. The one thing that must not depend on
  // reading the repository is telling a person the queue has lost something.
  //
  // `complete: false` on the degraded path is the honest reading: nothing was
  // covered, so a standing escalation must not be cleared merely because this
  // tick did not see the pull request that raised it.
  const announce = (scope = {}) => {
    const { fresh, cleared } = announceable(db, escalations, {
      covered: scope.covered ?? new Set(),
      waiting: scope.waiting ?? new Set(),
      finished: scope.finished ?? new Set(),
      complete: scope.complete ?? false,
    });
    for (const { why, count } of fresh) log(logPath, `NEEDS YOU: ${why}${count > 1 ? ` (${count} PRs)` : ""}`);
    for (const why of cleared) log(logPath, `CLEARED: ${why}`);
    const alert = buildAlert({ nwo, escalations: fresh });
    if (alert) {
      const sent = (ctx.notify ?? notify)({ profile, alert });
      log(logPath, sent.ok ? `pushed ${fresh.length} escalation(s) to ${profile.notify?.topic}`
                           : `did NOT push: ${sent.why}`);
      try {
        db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
          .run(now(), "daemon", sent.ok ? "notify.sent" : "notify.failed", `repo:${nwo}`,
               JSON.stringify({ count: fresh.length, why: sent.why ?? null }));
      } catch { /* a store that cannot record must not stop the tick */ }
    }
    return { fresh, cleared };
  };

  // ── the hub, the repository id, and the provider scheduler ───────────────
  //
  // ABOVE THE PULL-REQUEST LOOP, because the loop needs both: the verdict reads
  // `pr_hold` per PR, and the dispatch below claims a lease scoped to the
  // repository id.
  //
  // `ctx.hub` is a GETTER, not a handle. `restoreHub` replaces the hub file, and
  // a connection opened before that stays attached to the unlinked inode -- so a
  // daemon holding one for its lifetime would schedule in a database nobody else
  // can see, letting the guardian and the builder each admit up to the global
  // limit. It is re-asked once per tick.
  // ASKED AT EVERY OPERATION, not once per tick. A tick spans PR evaluation and
  // worker preparation, which is plenty of time for a restore to rename the hub
  // underneath it -- and a snapshot taken at the top would then serve an unlinked
  // inode for the rest of the pass, so a later claim succeeds in a scheduler
  // database nobody else can see and the restored hub admits work past the limit
  // at the same time. The getter compares the file's identity and reopens; it is
  // a stat and a comparison, so asking often is cheap.
  let projectFaultSaid = false;

  /**
   * THE SESSION THAT OWNS THE HUB RULES.
   *
   * The rules were previously three helpers and a flag, applied by whoever
   * remembered to. That is the shape every finding in this area has had: a rule
   * that must hold at N call sites, applied at N-1. Twenty-two sites reach the
   * hub or the provider scheduler in this function, and the point of gathering
   * them is that **a new call site cannot skip a rule by being written
   * elsewhere** -- there is no raw handle in scope to reach for.
   *
   * Three rules, and they are the whole of it:
   *
   *   FRESH, ALWAYS.   `restoreHub` replaces the hub file mid-tick, so a handle
   *                    taken earlier can be an unlinked inode: a claim then
   *                    reserves capacity in a database nobody else can see while
   *                    the restored scheduler admits its own. There is no safe
   *                    old handle. The getter is a stat and a comparison, so
   *                    asking often is cheap.
   *   NO HANDLE, NO OPERATION.  `?? hub` was written as a safety fallback and
   *                    WAS the defect. There is a current handle or there is
   *                    none.
   *   SAID ONCE.       An outage is one cause. Raising it per operation turns a
   *                    standing failure into a stream of alerts that each retire
   *                    the last.
   *
   * The session owns the HANDLE, deliberately not the arguments: each caller
   * still passes what it passes. Centralising the arguments would change what
   * the scheduler is asked, and this step is meant to change nothing at all.
   */
  // A VALUE NO SCHEDULER CAN RETURN, so "there was no scheduler" is never
  // mistaken for something the scheduler said.
  const NO_HUB = Symbol("no-hub");
  const hubSession = ({ getter, onFault, overrides }) => {
    const now = () => (typeof getter === "function" ? getter() : { hub: getter ?? null, why: null });
    let faultSaid = false;
    // SAID ONCE, wherever the reading came from. A caller that reads the hub
    // itself -- because it needs to tell an ABSENT hub from an unreadable one --
    // must still be able to report the fault under the same once-only rule, or
    // that rule holds at every site but one.
    const sayFault = (why) => { if (why && !faultSaid) { faultSaid = true; onFault(why); } };
    const handle = (fallback) => {
      const a = now();
      sayFault(a.why);
      return a.why ? fallback(a.why) : a.hub;
    };
    /**
     * Perform ONE scheduler operation on a CURRENT handle.
     *
     * This is what makes the rules unskippable rather than merely gathered. A
     * session that hands a handle back leaves every caller free to keep it, and
     * "adding a new call site must not be able to skip a rule" is a convention
     * again -- the thing #50 exists to stop it being.
     *
     * The handle is acquired here, used once, and never returned, so a stale
     * handle is not something a new site can obtain by accident; it would have
     * to be smuggled out deliberately.
     *
     * `whenAbsent` is the caller's own answer to "there is no scheduler right
     * now", and those answers are NOT interchangeable: housekeeping skips, a
     * release DEFERS and carries its obligation to the next tick, a claim fails
     * open and says so. The session owns the handle; the policy stays beside the
     * operation it governs.
     *
     * `overrides` is read at CALL time, not at construction, because the daemon
     * has always resolved these as `(ctx.NAME ?? fallback)` and a test that
     * replaces a seam must still be honoured.
     */
    const perform = (name, fallbackFn, args, whenAbsent) => {
      const h = handle(() => null);
      if (!h) return whenAbsent === undefined ? undefined : whenAbsent();
      return (overrides?.[name] ?? fallbackFn)(h, args);
    };
    return {
      // The raw reading, for the two callers that need to tell an ABSENT hub
      // from an unreadable one -- a fact the handle alone cannot carry.
      read: now,
      // For the callers that read directly: the once-only report, unbundled.
      sayFault,
      // IS THERE A SCHEDULER? For the sites that ask only that. It takes the
      // same reading at the same moment an operation would, and answers yes or
      // no WITHOUT handing the handle back -- so asking the question cannot
      // leave a handle in scope for a later line to use.
      available: () => Boolean(handle(() => null)),
      perform,
    };
  };
  const session = hubSession({
    overrides: ctx,
    getter: ctx.hub,
    // Reported ONCE per tick even though the hub is asked many times.
    onFault: (why) => { log(logPath, `hub: ${why}`); raise("guardian:hub:unreadable"); },
  });
  // READ ONCE, HERE, so a hub that EXISTS and cannot be opened is reported as the
  // outage it is rather than passing for an ordinary machine with no builder on
  // it. The result is deliberately NOT retained: every later user re-asks, because
  // a restore can replace the hub file at any point during a tick and a handle
  // taken at the top stops describing the scheduler the moment it does.
  session.available();

  // RESOLVED OUTSIDE THE GUEST CONNECTION. `repoIdFromHub` reads `task`, which is
  // not on the guardian's allowlist -- section 13 gives it the provider scheduler
  // and `pr_hold`, and reading the builder's work table would be the third touch
  // the guest exists to refuse. Handing the guest to the resolver made every
  // production tick throw and fail closed on every dispatch, while the fixture
  // that was supposed to cover it injected a plain object as the hub and could
  // not exhibit it. `bin/reeve` answers this with a privileged handle held for
  // one statement; issue #46 removes even that.
  //
  // RE-ASKED WHEN IT IS STILL UNKNOWN, on a fixed cadence. A project whose first
  // task is admitted after the daemon started would otherwise leave the guardian
  // fail-closed on every dispatch until someone restarted it. The cadence is a
  // constant rather than a profile key: an earlier revision read
  // `builder.provider.repoIdRetryMinutes`, which the profile schema does not
  // declare, so an operator who tuned the knob it advertised made `reeve run`
  // fail validation instead.
  // A REGISTRY THAT COULD NOT BE PARSED IS NOT A MISSING PROJECT. `bin/reeve`
  // rejects the whole registry when any single entry is malformed, so an
  // unrelated bad entry leaves this repository with no project, no repository
  // id, every dispatch fail-closed and every builder-PR hold UNKNOWN. Failing
  // closed is right; doing it silently is not.
  if (ctx.projectError && !projectFaultSaid) {
    projectFaultSaid = true;
    log(logPath, `registry: ${ctx.projectError}`);
    raise("the project registry could not be read; this repository has no resolvable identity");
  }
  if (ctx.repoId == null && ctx.resolveRepoId) {
    const at = Math.floor(Date.now() / 1000);
    if (at - (ctx._repoIdTriedAt ?? 0) >= REPO_ID_RETRY_SECONDS) {
      ctx._repoIdTriedAt = at;
      try {
        ctx.repoId = await ctx.resolveRepoId();
      } catch (err) {
        log(logPath, `provider: the repository id could not be resolved — ${err.message}`);
        raise("guardian:hub:unreadable");
      }
    }
  }
  const repoId = ctx.repoId ?? null;

  // Releases refused because a restore holds `maintenance_lock`, carried to the
  // next tick. A refusal is a REAL outcome to inspect and retry, never something
  // to swallow: a `catch {}` here leaves a lease held until expiry while the
  // scheduler counts it against the limit, so the guardian throttles itself for
  // five minutes over a restore that took one second.
  //
  // The IDENTITY is stored and never the id. A restore clears `provider_lease`
  // and SQLite reuses the integer key, so an id-keyed retry deletes whatever
  // inherited it -- an unrelated live lease, and the limit is breached by the
  // very bookkeeping meant to protect it.
  const pendingReleases = (ctx.providerRetry ??= new Map());
  const releaseWithRetry = (key, identity) => {
    // FRESH, not the tick's opening snapshot: a release is the operation most
    // likely to run long after the hub was first opened.
    const a = session.read();
    // RETAINED, NOT DROPPED. This early return handled the exception path and
    // the maintenance refusal and then threw the identity away on the third
    // route out -- a hub that is momentarily unreadable between the claim and
    // the cleanup. A pre-bind lease is still attached to the guardian's own
    // always-alive pid, so even past its expiry the liveness-aware reaper keeps
    // it and the slot is lost for good.
    //
    // Only a hub that is genuinely ABSENT drops it: there is no scheduler, so
    // there is no lease and nothing to give back.
    if (!a.hub) {
      if (a.why) {
        pendingReleases.set(key, identity);
        session.sayFault(a.why);
        log(logPath, `provider: release deferred — the hub could not be reached; retrying next tick (${key})`);
      }
      return;
    }
    const h = a.hub;
    let r;
    // A THROW IS NOT A REFUSAL, and only the refusal was handled. On the worker
    // path this runs at the top of the `finally`, so an exception here skips the
    // result recording and `finishRun` below it, masks whatever the worker
    // actually did, and takes the rest of the tick with it. Cleanup must not be
    // able to destroy the outcome it exists to record.
    try {
      r = session.perform("providerRelease", releaseProvider, { ...identity, isAlive: isSameProcess },
        () => { pendingReleases.set(key, identity);
                log(logPath, `provider: release deferred — the hub could not be reached; retrying next tick (${key})`);
                return NO_HUB; });
      if (r === NO_HUB) return;
    } catch (err) {
      pendingReleases.set(key, identity);
      log(logPath, `provider: release THREW — ${err.message}; retrying next tick (${key})`);
      raise("the provider scheduler is unreadable; dispatching unscheduled");
      return;
    }
    if (r?.ok === false && r.reason === "maintenance") {
      pendingReleases.set(key, identity);
      log(logPath, `provider: release deferred — a restore holds the hub; retrying next tick (${key})`);
    } else {
      pendingReleases.delete(key);
    }
  };
  // AND THE SAME TREATMENT FOR THE COOLDOWN. `noteRateLimit` REFUSES rather than
  // throws while a restore holds `maintenance_lock`, and handling only the
  // exception lost the refusal silently -- so a rate limit hit during a restore
  // was never recorded, the release was retried, and admissions resumed straight
  // back into the exhausted window the moment the restore finished. A refusal is
  // a result to inspect, and it is the same shape as the one two lines above.
  const pendingCooldowns = (ctx.cooldownRetry ??= new Map());
  const noteCooldownWithRetry = (key, note) => {
    // THE WINDOW STARTED WHEN THE 429 WAS SEEN, not when we managed to record it.
    //
    // A deferred note that only carries a DURATION restarts the whole cooldown
    // at retry time, so an outage longer than the cooldown recovers and then
    // imposes a fresh ten-minute block on every builder and guardian admission
    // for a window that had already passed. The absolute expiry is stamped at
    // observation and carried; the retry asks for whatever is left of it.
    //
    // AND THE OBSERVATION TIME IS CARRIED TOO, not just the expiry. `recordRateLimit`
    // keeps whichever metadata is latest by timestamp, so a note re-derived from
    // the RETRY time looks newer than a 429 seen after it -- and the older
    // signature then overwrites the newer one, leaving doctor naming the wrong
    // throttling cause. Both facts are stamped once, at observation, and neither
    // is re-derived from the other.
    const nowSec = Math.floor(Date.now() / 1000);
    const stamped = note.expiresAt != null ? note
      : { ...note, observedAt: nowSec, expiresAt: nowSec + (note.cooldownSeconds ?? 0) };
    const left = stamped.expiresAt - nowSec;
    // Already elapsed while we could not write it. Recording a zero or negative
    // cooldown would be recording a fact that has stopped being true.
    if (left <= 0) { pendingCooldowns.delete(key); return; }
    const send = { signature: stamped.signature, cooldownSeconds: left,
                   observedAt: stamped.observedAt ?? null, expiresAt: stamped.expiresAt };

    let r;
    try {
      // DEFERRED, not skipped, when there is no scheduler to record it on: the
      // window started when the 429 was seen and the obligation outlives this tick.
      r = session.perform("noteRateLimit", noteRateLimit, { ...send, isAlive: isSameProcess },
                          () => { pendingCooldowns.set(key, stamped); return NO_HUB; });
      if (r === NO_HUB) return;
    } catch (err) {
      pendingCooldowns.set(key, stamped);
      log(logPath, `provider: could not record the rate limit — ${err.message}; retrying next tick`);
      raise("the provider scheduler is unreadable; dispatching unscheduled");
      return;
    }
    if (r?.ok === false && r.reason === "maintenance") {
      pendingCooldowns.set(key, stamped);
      log(logPath, `provider: cooldown deferred — a restore holds the hub; retrying next tick (${key})`);
    } else {
      pendingCooldowns.delete(key);
    }
  };
  if (pendingCooldowns.size) {
    for (const [key, note] of [...pendingCooldowns]) noteCooldownWithRetry(key, note);
  }

  // NOT GATED ON THE TICK'S OPENING SNAPSHOT. `releaseWithRetry` re-asks with
  // `session.read()` -- its own comment says "FRESH, not the tick's opening snapshot" --
  // and then handles an absent hub, an unreadable one and a refusal separately.
  // Consulting a handle read hundreds of lines earlier could only overrule that
  // with staler information, and it did: a hub that faulted on the tick's FIRST
  // read stranded every inherited release for the whole tick, while releases
  // taken and given back within the same tick succeeded against the same hub. A
  // pre-bind lease sits on the guardian's always-alive pid, so the liveness-aware
  // reaper preserves it and the slot is held against the global limit until it
  // expires.
  if (pendingReleases.size) {
    for (const [key, identity] of [...pendingReleases]) releaseWithRetry(key, identity);
  }

  // ── the scheduler's own housekeeping, before ANYTHING can end the tick ────
  //
  // Ahead of the pull-request listing, because that listing can return early:
  // when GitHub cannot be asked, the tick stops there. Housekeeping needs
  // nothing from GitHub -- it is SQLite and a liveness check -- so leaving it
  // downstream meant a prolonged GitHub outage let an expired lease from a dead
  // guardian go on counting against capacity, and a stale queued row go on
  // blocking every builder admission, while the database that could have
  // cleared them was healthy the whole time.
  //
  // REAP FIRST. `claimProvider` counts held rows and does not reap, and nothing
  // in production called `reapProviderLeases` at all -- so a guardian or a
  // detached worker that died before its `finally` left a held row that outlived
  // its expiry and went on being counted for ever. Enough crashes and the
  // scheduler returns `at-limit` permanently, to both the guardian and the
  // builder, with no lease that any live process holds.
  //
  // Expiry AND liveness together: a row past `expires_at` whose holder is still
  // running is a long job, not an abandoned one.
  // NOT gated on `wanted.length`. A guardian that died holding a lease leaves a
  // row only its successor can clear, and a successor with nothing to dispatch
  // this tick is exactly the state a restart lands in -- so gating housekeeping
  // on local demand meant the rows that most need reaping were reaped least. The
  // builder never calls the reaper at all, so a held row would count against
  // capacity for ever and a queued one would block every builder admission.
  //
  // NOT GATED ON `execute` EITHER, and that was the third gate found in front of
  // this block in as many rounds. Dispatch authority is about whether THIS
  // guardian may start work; reaping is about rows a DEAD one left behind. An
  // observational guardian -- the default, and exactly what someone restarts
  // into after an armed guardian crashed -- would skip the only production call
  // to the reaper, so the dead guardian's queued row sat for ever and
  // `claimProvider` refused every builder admission while it did. The builder
  // never reaps at all, so nothing else was coming.
  {
    {
      try {
        // Housekeeping SKIPS with no scheduler: there are no leases to reap.
        const rp = session.perform("reapProvider", reapProviderLeases, { isAlive: isSameProcess },
                                   () => undefined);
        if (rp?.reaped) log(logPath, `provider: reaped ${rp.reaped} expired lease(s) whose holder is gone`);
      } catch (err) {
        // Housekeeping must never take the tick with it.
        log(logPath, `provider: could not reap expired leases — ${err.message}`);
        raise("the provider scheduler is unreadable; dispatching unscheduled");
      }
    }
  }

  // ONE READER for this guardian's queued rows. Two callers need them now -- the
  // dispatch phase, to serve the head of the queue and to cancel what this tick
  // will not ask for, and the halt path, to withdraw the lot -- and a second copy
  // of the query would be a second thing to keep in step with `owner` and
  // `repo_id`. A read that fails answers with nothing AND says so: an empty list
  // returned silently would let the halt path report that it withdrew everything
  // when it had read nothing.
  const readQueuedNow = () => {
    try {
      return session.perform("queuedRequests", queuedGuardianRequests, { repoId }, () => []) ?? [];
    } catch (err) {
      log(logPath, `provider: could not read the queued requests — ${err.message}`);
      raise("the provider scheduler is unreadable; dispatching unscheduled");
      return [];
    }
  };

  /**
   * Stop for the halt marker -- through here, and only through here.
   *
   * A HALTED GUARDIAN MUST NOT HOLD A QUEUE POSITION. `claimProvider` serves
   * guardian requests in order and refuses builder admission while any queued
   * guardian row exists, and expiry cannot clear this one because the holder pid
   * is alive and sleeping. So a halt turned into a deadlock that neither party
   * could break: the guardian is not going to ask for the work, and the builder
   * cannot have the slot.
   *
   * The gate itself moved BELOW the hub and repository-id resolution and the
   * reaper for this reason -- housekeeping depends on nothing the halt is about,
   * and it was the third gate found sitting in front of it. What a halted
   * guardian now does before returning is: read the hub, read its repository id,
   * retry its own deferred releases and cooldown writes, reap rows whose holders
   * are gone, and withdraw its own queue position. Every one of those either
   * completes an obligation it already incurred or removes something that blocks
   * another process. None of them starts work. The outbox drain is untouched: it
   * asks `halted` for itself.
   *
   * ONE FUNCTION, because three sites stop for this marker and a fourth will be
   * added by someone who does not know about the queue.
   */
  const haltStop = (why) => {
    log(logPath, why);
    if (repoId != null) {
      for (const row of readQueuedNow()) {
        try {
          // A SHAPED REFUSAL, so the line below names the real reason instead of
          // reporting `undefined` as the scheduler's answer.
          const c = session.perform("cancelQueued", cancelQueued, {
            owner: "guardian", repoId, runRef: row.run_ref, isAlive: isSameProcess },
            () => ({ ok: false, reason: "the hub went away while withdrawing" }));
          if (c?.ok) log(logPath, `provider: withdrew a queued request while halted (${row.run_ref})`);
          else log(logPath, `provider: could not withdraw ${row.run_ref} — ${c?.reason}`);
        } catch (err) {
          log(logPath, `provider: could not withdraw ${row.run_ref} — ${err.message}`);
        }
      }
    }
    return { decisions, escalations, halted: true };
  };

  // NAMING WHAT STILL HAPPENS. This line is the operator's only signal, and they
  // read it while debugging whatever made them halt -- so "no work will be
  // started" being TRUE is not enough if the tick also mutates shared state. It
  // reaps rows whose holders are dead, completes releases and cooldown writes it
  // already owed, withdraws its own queue position, and retires review requests
  // the profile no longer asks for. None of those starts work; every one of them
  // either finishes an obligation or stops blocking another process. But an
  // operator who believes nothing at all is moving will misread the hub.
  if (halted(ctx.haltMarker))
    return haltStop(`HALTED: ${ctx.haltMarker} exists — no work will be started; ` +
                    `releasing this guardian's scheduler claims and finishing what it already owed`);


  const prs = (ctx.openPrs ?? openPrs)(nwo, profile.watch?.maxOpenPrs ?? 20);
  if (prs === null) {
    // Could not ask is not none. Returning an empty list here would look exactly
    // like a quiet, healthy fleet.
    log(logPath, `tick: could not list PRs for ${nwo} — skipping this pass rather than assuming zero`);
    // Still drain. An effect already made durable is owed whether or not this tick
    // could read the repository, and an inflight row whose drainer died is
    // recovered here or waits for a tick that happens to succeed.
    await drainDueEffects();
    // Announce what that drain raised. A dead letter is permanent, and "we could
    // not list pull requests" must not also mean "nobody is told the queue lost
    // something".
    announce();
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
  // How the anchor is obtained, decided ONCE for the whole loop.
  //
  // In production it is `prAnchor` -- one small read that pins the revision
  // before anything is folded or judged against it.
  //
  // A test that injects `evaluate` gets its anchor from that double instead, so
  // the ORDER under test is the real one: fold first, evaluate second. The
  // alternative was to make every such test inject a second seam, and a double
  // that has to be kept in step with another double is how a suite starts
  // agreeing with itself rather than with the product. Calling the double twice
  // costs nothing -- it is a pure function of its inputs, which is exactly what
  // production's separate `prAnchor` read is not, and why production pins once
  // and hands the result on.
  const anchorFor = ctx.prAnchor
    ?? (ctx.evaluate
        ? ({ nwo: n, pr: p }) => {
            const probe = ctx.evaluate({ nwo: n, pr: p, profile, db });
            return probe.ok
              ? { ok: true, head: probe.head, headRef: probe.headRef, updatedAt: probe.updatedAt }
              : probe;
          }
        : prAnchor);

  const waiting = new Set();
  for (const pr of prs) {
    if (halted(ctx.haltMarker)) return haltStop("HALTED mid-tick");

    // THE HEAD IS PINNED FIRST, and the fold runs before the evaluation.
    //
    // The order used to be evaluate, then observe, ingest and derive -- so every
    // decision read a projection built from the PREVIOUS tick, and two P1s came
    // out of that one fact. The head check could not see it, because a reviewer
    // acting on the SAME revision leaves the head matching while the content
    // moves; and a count cross-check could not see it either, because a thread
    // EDITED in place changes no total. Comparing aggregates catches things
    // appearing and disappearing, never things changing.
    //
    // A third check would have detected one more instance of an ordering that can
    // simply be corrected, at a cost paid on every tick for every pull request.
    // This removes the class instead. The anchor is pinned once and handed to
    // both, so the fold and the evaluation cannot disagree about which revision
    // they describe -- which pinning twice would have permitted.
    const anchor = anchorFor({ nwo, pr });
    if (!anchor.ok) {
      // UNREAD, exactly as an evaluation failure is. The marker was added at the
      // `evaluate` failure only, and a pull request whose ANCHOR could not be
      // read takes this earlier exit -- so the sweep saw it missing from
      // `wanted`, read that as withdrawal, and cancelled its queued request.
      // Two ways to fail a read; the rule covered one.
      unreadable.add(pr);
      log(logPath, `  #${pr}: could not read — ${anchor.why}`);
      continue;
    }

    if (ctx.reviewIngest !== false) {
      noteHead(db, nwo, pr, anchor.head);
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
      const moved = !last || last.updatedAt !== anchor.updatedAt || (now() * 1000) - last.at >= staleAfter;
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
          if (!seen.incomplete) (ctx.lastIngest ??= new Map()).set(pr, { updatedAt: anchor.updatedAt, at: now() * 1000 });
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
          { at: now(), head: anchor.head, complete: ctx.ingestComplete?.get?.(pr) === true });
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


    // AFTER the fold, and handed the anchor the fold used. `foldPrecedesEvaluation`
    // is what releases the thread details to the decision: they were withheld
    // precisely because this order was the other way round.
    // THE BUILDER'S HOLD, read here because this is where the hub connection is.
    //
    // `evaluatePr` holds the per-repository state database; `pr_hold` is a HUB
    // row, so the reading is taken by the caller that can take it and handed in.
    // It was imported and never called in the first revision of this change:
    // every unit test passed against a hold object supplied by hand, the clause
    // worked perfectly, and no production tick ever produced one -- so a pull
    // request the builder had parked could still reach FIX_CI or MERGE. Proving
    // a mechanism works is not proving it is wired.
    //
    // Null when there is no hub or no repository id, which `computeVerdict`
    // renders as NO CLAUSE rather than an UNKNOWN one: a guardian that cannot be
    // asked about holds must not drag every verdict it renders to UNKNOWN.
    // ONLY FOR THE BUILDER'S OWN PULL REQUESTS. `pr_hold` records nothing else,
    // so consulting it for a dependency bump or a stranger's feature branch can
    // only ever produce PASS -- or, when the table cannot be read, an UNKNOWN
    // that publishes an action-required merge-policy result. A builder-store
    // fault would then block every pull request in the repository over a table
    // that has no row for any of them.
    const builderPr = isBuilderPr({ headRef: anchor?.headRef, authorLogin: anchor?.authorLogin });
    // AND THE FAILURE REASON TRAVELS. Passing a bare `null` when the hub could
    // not be opened made `computeVerdict` omit the clause entirely -- which reads
    // as "not asked" and lets the same tick publish a passing verdict or choose
    // FIX_CI while the builder's holds are unreadable. That is the fail-open this
    // clause exists to close, reintroduced at the wiring. Absent is null;
    // unreadable is a reading that says so.
    let hold = null;
    if (builderPr) {
      const access = session.read();
      if (access.why) hold = { readable: false, why: access.why };
      // NO HUB IS NOT "NOT ASKED", HERE, and the scoping is what makes that safe.
      //
      // Everywhere else an absent hub means an ordinary machine with no builder
      // on it, and dragging a verdict to UNKNOWN over a question nobody put to it
      // would be wrong. But this branch sits inside `if (builderPr)`: an ordinary
      // pull request never reaches it. What is in front of us is a pull request
      // the BUILDER opened, and the builder shares this guardian's hub -- so a
      // builder PR with no hub is not "a machine with no builder", it is the
      // authority database for this PR's merge safety being gone: deleted, its
      // mount vanished, or the store not yet migrated.
      //
      // Answering `null` omitted the clause, which reads as "not asked", and the
      // required policy check could then pass while the guardian had no way to
      // know whether an active `pr_hold` existed -- the fail-open this clause was
      // written to close, reintroduced at the wiring for the one case where the
      // hub is the whole answer.
      else if (!access.hub) hold = { readable: false, why: "there is no hub on this machine, so this builder pull request's holds cannot be read" };
      else hold = openHold(access.hub, { repoId, pr });
    }
    const e = (ctx.evaluate ?? evaluatePr)({ nwo, pr, profile, db, anchor, hold,
                                             io: { foldPrecedesEvaluation: true } });
    if (!e.ok) {
      // UNREAD IS NOT WITHDRAWN. A pull request whose anchor or evaluation
      // failed transiently contributes nothing to `wanted`, and the queued sweep
      // below reads that absence as "this tick no longer wants it" and cancels
      // its provider request. The PR has not closed and its action has not
      // changed -- reeve simply could not look -- so cancelling costs the
      // guardian its queue position, lets a builder take the opening it was
      // holding, and re-queues the work at the tail once the read succeeds.
      unreadable.add(pr);
      log(logPath, `  #${pr}: could not evaluate — ${e.why}`);
      continue;
    }

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

    // The findings-repair budget, read from the store like the CI one beside it
    // rather than from a map rebuilt empty on every tick.
    const ffp = findingsFingerprint(e.threadDetails, e.ledgerBlockerIds);
    const decision = nextAction(e, profile, {
      now: now(),
      unknownSince: unknownSince(db, pr),
      findingsFingerprint: ffp,
      // Guarded the same way as the CI count: an unreadable store must not grant a
      // free retry, so it reads as exhausted rather than as zero.
      findingsAttempts: ffp ? attemptsFor(db, nwo, pr, ffp, logPath) : 0,
      // From the store, not from a map rebuilt empty on every tick.
      fingerprint: fp,
      // Guarded: an unreadable store must not take down the whole tick, and a
      // count that cannot be read is not zero. Unknown attempts block rather
      // than grant a free retry.
      fixAttempts: fp ? new Map([[fp, attemptsFor(db, nwo, pr, fp, logPath)]]) : new Map(),
    });

    // ONE KEY for the whole attempt: the count read before, the write after, and
    // every refund in between. They were three separate expressions and only two
    // of them knew about findings, so a transient failure BEFORE the worker ran
    // spent a findings attempt that nothing gave back — and with the default cap
    // of one, the next tick escalated instead of retrying.
    const spendKey = attemptKey(decision, fp, e.threadDetails, e.ledgerBlockerIds);

    // Posting a comment launches no worker and hands no credential to one, so it
    // is decided and made durable HERE -- not below, where dispatch is gated on
    // worker containment. A review request withheld because a sandbox could not be
    // proved closed is a pull request left without the round it needed, for a
    // reason that has nothing to do with it.
    const { effects, unsummonable, retire } = effectsFor({ nwo, e, decision, profile, execute });
    for (const login of unsummonable) {
      log(logPath, `  #${pr}: ${login} BLOCKS this pull request and declares no trigger comment — reeve cannot summon them`);
      // ACCUMULATED. The key is shared by design -- one reviewer misconfigured
      // once, however many pull requests they block -- so setting it to 1 per pull
      // request meant the last iteration overwrote the rest, the alert never said
      // how many were affected, and it never re-announced when that number grew.
      raise(`${login} blocks merges but declares no trigger comment, so reeve cannot request their review`);
    }
    const decided = record(db, { pr, head: e.head, verdict: e.verdict, decision, effects, retire });
    if (effects.length && !decided.ok) {
      log(logPath, `  #${pr}: REQUEST_REVIEW — the decision and its ${effects.length} effect(s) could NOT be recorded: ${decided.why}`);
      // Escalated, not merely logged. Nothing else covers this: no worker is
      // dispatched for the action, no row exists to spend an attempt or become a
      // dead letter, and the pull request simply waits. A locked, read-only or
      // full database is a state that does not fix itself.
      raise(`#${pr}: reeve could not record the review request it decided to make — ${decided.why}`);
    }
    else if (decided.queued)
      log(logPath, `  #${pr}: REQUEST_REVIEW — queued ${decided.queued} trigger comment(s) for reeve to post`
                 + (decided.dropped ? `, withdrawing ${decided.dropped} for a head that has moved on` : ""));
    else if (effects.length)
      log(logPath, `  #${pr}: REQUEST_REVIEW — already requested at this head`);
    // A decision that WANTED effects and produced none names the reason, because
    // a profile with no trigger declared looks identical to one already asked.
    if (decision.action === "REQUEST_REVIEW" && execute && reviewActionsOn(profile) && !effects.length)
      log(logPath, `  #${pr}: REQUEST_REVIEW — no reviewer in this profile declares a trigger`);
    if (decision.action === ACTIONS.WAIT) waiting.add(pr);
    // Carried on the entry rather than left in this block's scope: the dispatch
    // loop below is a SEPARATE block, and reaching for these there threw a
    // ReferenceError on every FIX_CI the moment --execute was on.
    decisions.push({ e, decision, cause, fp, spendKey });
    log(logPath, "  " + describe(e, decision));

    // Republish on every tick: a verdict is bound to a revision, so when the head
    // moves the old check stops applying to anything. Without this the shadow
    // record silently decays to nothing.
    const pub = await (ctx.publish ?? publishVerdict)({ nwo, verdict: e.verdict, shadow });
    if (!pub.ok) log(logPath, `    could not publish: ${pub.why}`);

    // A shared cause is one problem, not N. Four PRs blocked on a red base is a
    // single escalation, or the phone becomes noise and gets muted.
    if (decision.shared) raise(decision.why);
    else if (decision.action === ACTIONS.ESCALATE) {
      // "The same failure survived a second fix" assumes a fix was attempted. When
      // the previous worker declined -- because the change belonged to a human --
      // nothing survived anything, and a founder reading that goes looking for a
      // bad fix that was never made. The reason it gave is carried on the ledger
      // row for exactly this moment.
      // Looked up for the escalation it BELONGS TO, and no other.
      //
      // Two repairs each store a blocker, under their own identity. Consulting
      // whichever one happens to exist meant a stale findings note displaced the
      // real reason on any HIGHER-priority escalation that came later — a
      // conflicted branch, an unreadable review body — so the operator was shown
      // a blocker from a different problem and announcement reconciliation treated
      // the actual one as absent.
      //
      // Matching on the escalation's own cause rather than on which fingerprint
      // happens to be non-null: the cause is what the note is about.
      const note = decision.why === ESCALATIONS.REPEATED_FAILURE && fp
                     ? fixAttemptNote(db, nwo, pr, fp)
                 : decision.why === ESCALATIONS.FINDINGS_UNMOVED && ffp
                     ? fixAttemptNote(db, nwo, pr, ffp)
                 : null;
      raise(note ? `#${pr}: needs a human — ${note}` : `#${pr}: ${decision.why}`);
    }
  }

  // A worker that can read the founder's credentials is not dispatched, whatever
  // --execute says. Containment is MEASURED, on this host, under this CLI and
  // this sandbox block (containment.mjs): the sandbox canary must have passed
  // and the login keychain must hold no GitHub credential. Anything unmeasured
  // is open, and the founder is told once, by identity. The verdict is
  // injectable for tests only; the default measures, and measures only when a
  // worker task actually wants dispatching, so a quiet tick runs no canary.
  // A REQUEST_REVIEW reeve performs itself is not a worker task, so it must not
  // count towards the worker gates -- otherwise an open containment blocks a
  // comment that no worker was ever going to post.
  const wanted = decisions.filter(d => WORKER_ACTIONS.includes(d.decision.action)
                                    && !(d.decision.action === "REQUEST_REVIEW" && execute && reviewActionsOn(profile)));

  // Whether this tick will ask for a canary lease at all. Declared ONCE and read
  // by both the queued sweep below and the canary block further down: two
  // statements of the same condition drift, and the sweep cancelling a request
  // the next few lines are about to make is the shape that drift takes here.
  // Whether this tick MIGHT ask for a canary lease. Used only by the queued
  // sweep, to decide whether a `canary:<nwo>` row is still wanted.
  //
  // Deliberately NOT a prediction of whether the canary will actually run: two
  // rounds were spent trying to make one and both were wrong, once by claiming
  // for a call the cheap gates refuse and once by skipping the claim for a call
  // a failed cache entry does not satisfy. The claim itself now happens inside
  // the paid path (`canaryBeforeSpawn`), where the question does not arise. What
  // the sweep needs is only "could this tick still want one", and an injected
  // verdict is the one case where it certainly cannot.
  const mightClaimCanary = Boolean(execute && wanted.length && !(ctx.containment ?? null));

  // AND CANCEL WHAT THIS TICK IS NO LONGER GOING TO ASK FOR.
  //
  // A `queued` request is a standing claim on the next free slot, and it is
  // owned by the guardian process -- which is alive, so expiry reaping preserves
  // it. If the pull request closed, became held, or changed action between
  // ticks, its run ref is never claimed or released again and the row sits there
  // for ever, with `queuedGuardianCount` blocking every subsequent BUILDER
  // admission behind work nobody is going to do.
  //
  // A per-path cancel on the way out of the dispatch block cannot fix this: the
  // request whose PR has since closed never enters that block at all. So the
  // live queued rows are compared against what this tick actually decided, and
  // the difference is cancelled. This was deliberately left out of the first
  // revision and named as a follow-up; that was the wrong call, because the row
  // it leaves behind blocks the other lane.
  if (execute && repoId != null) {
    if (session.available()) {
      try {
        // THE CANARY ONLY IF THIS TICK WILL ATTEMPT IT. Treating its run ref as
        // intended unconditionally meant a queued canary request survived every
        // later tick that had no worker decisions -- never claimed, never
        // cancelled, and owned by the live guardian so the reaper preserves it,
        // while `queuedGuardianCount` blocks every builder admission behind it.
        // The same predicate the canary block uses, not a second one that agrees
        // today.
        const intended = new Set([
          ...(mightClaimCanary ? [`canary:${nwo}`] : []),
          ...wanted.map(d => `${nwo}#${d.e.pr}:${d.decision.action}`)]);
        const queued = readQueuedNow();
        // THE CANCEL PHASE RUNS AFTER THE DISPATCH LOOP, not here. `wanted` is
        // every worker DECISION, and the loop then applies capacity, the
        // preparation backoff, root-cause resolution, flake assessment, prompt
        // construction and checkout preparation on top -- so a request can be
        // "intended" by this set and never actually re-asked. Cancelling from
        // intent leaves those queued; cancelling from what the tick ACTUALLY
        // asked for is the honest predicate, and it is only known afterwards.
        //
        // Recorded here so the post-loop phase has the rows it read.
        queuedNow = queued;
        intendedNow = intended;

        // AND SERVE THE HEAD OF THE QUEUE BEFORE ASKING FOR ANYTHING NEW.
        //
        // `claimProvider` serves guardian requests in order: a claim is granted
        // only when there is no queued guardian request older than this
        // caller's. The canary asks FIRST every tick and is therefore refused
        // the moment any worker request is already queued -- and that refusal
        // sets `skipDispatch`, which stops the per-decision loop, which is the
        // only thing that would have re-asked for that worker. Neither ever
        // moves again, and `queuedGuardianCount` blocks every BUILDER admission
        // behind two requests nobody will ever serve.
        //
        // Reproduced against the real scheduler before fixing: with a limit of
        // one, the canary is granted on tick 1, the worker queues, and from tick
        // 2 onward the canary is refused `queued` for ever.
        //
        // So the oldest request this tick still wants is re-asked here, ahead of
        // the canary. Granting it is what removes it from the queue; it is
        // released again immediately because this tick has not measured
        // containment yet and may never dispatch. A wasted promote-and-release
        // is the price of the queue draining in order, and the next tick finds
        // it empty.
        const head = queued.find(r => intended.has(r.run_ref) && r.run_ref !== `canary:${nwo}`);
        if (head) {
          // NOT `askedFor`, and marking it here was a regression this PR
          // introduced against its own rule.
          //
          // `askedFor` means "this tick put this run ref to the scheduler AND
          // still wants it", and the sweep cancels every queued row outside it.
          // Marking at the preflight marks from INTENT -- the thing the sweep's
          // own comment says is dishonest -- because the per-decision loop below
          // still applies local capacity, the preparation backoff, root-cause
          // resolution, prompt construction and checkout preparation. A row the
          // preflight touched and those gates then refused was neither re-asked
          // nor cancelled: it sat queued under the live guardian, and
          // `queuedGuardianCount` blocks every builder admission behind it.
          //
          // Nothing is lost by not marking. A GRANTED claim removes the row from
          // the queue, so the sweep has nothing to cancel. A REFUSED one leaves
          // it queued, and then the honest question is the one the sweep already
          // asks: did the dispatch path actually ask for this work? If it did, it
          // marks `askedFor` itself; if it did not, the row should go.
          // Not serving the head is the right answer with no scheduler: the
          // queue lives in the hub that is not there.
          const got = session.perform("providerClaim", claimProvider, {
            owner: "guardian", repoId, runRef: head.run_ref,
            pid: process.pid, lstart: ctx.lstart, isAlive: isSameProcess },
            () => undefined);
          if (got?.ok) {
            log(logPath, `provider: served the queue head (${head.run_ref}) so the canary is not blocked behind it`);
            releaseWithRetry(head.run_ref, { owner: "guardian", repoId, runRef: head.run_ref,
                                             id: got.id, token: got.token ?? null });
          }
        }
      } catch (err) {
        log(logPath, `provider: could not sweep queued requests — ${err.message}`);
        raise("the provider scheduler is unreadable; dispatching unscheduled");
      }
    }
  }

  let containment = ctx.containment ?? null;

  // THE CANARY IS A DISPATCH. It runs a real model under a real sandbox and
  // spends real quota, so it takes its own lease exactly as a worker does.
  //
  // THE CLAIM IS MADE INSIDE THE PAID PATH, not predicted from outside it, and
  // two rounds of trying to predict it is why. Whether a canary actually runs
  // depends on the cheap platform gates and on a cache hit under an EXACT key
  // with `ok: true` -- so an outside guess is wrong in both directions:
  // claiming for a call the cheap gates will refuse (queuing the canary and
  // blocking builder admission every tick, for a call that never happens), and
  // skipping the claim when the cache holds a FAILED or obsolete entry (a paid
  // model call with no lease at all, which is unmetered spend and strictly worse
  // than the waste it replaced).
  //
  // `beforeSpawn` is asked immediately before the runner and can refuse. The
  // claim now coincides with the spend by construction, and no predicate is
  // restated anywhere.
  let skipDispatch = false;
  let canaryLease = null;
  if (execute && wanted.length && !containment) {
    const canaryBeforeSpawn = async () => {
        const scheduler = session.available();
        // NO HUB IS NO SCHEDULER, and that answer comes FIRST.
        //
        // Asking for the repository id before asking whether a scheduler exists
        // turned the documented fail-open case into a total outage: with an
        // unreadable hub the id lookup also fails, so the canary was refused and
        // `skipDispatch` set, and the guardian did nothing at all -- over a lease
        // that could not have been written to the unavailable hub anyway. The
        // worker path already had this order; the canary did not, and two paths
        // disagreeing about the same question is the defect.
        if (!scheduler) return { ok: true };
        // FAIL CLOSED on an unscopeable lease, once a scheduler is known to
        // exist. A lease keyed on a null repo_id is invisible to the
        // live-request index, so the guardian would insert a fresh live request
        // every tick and the limit would never bind.
        if (repoId == null) {
          raise("the repository numeric id is unknown; provider leases cannot be scoped");
          skipDispatch = true;
          return { ok: false, why: "the repository id is unknown" };
        }
        let got;
        // FAIL OPEN on an unreadable scheduler. An exception outside a catch
        // would abort the tick instead of letting the guardian proceed.
        try {
          got = session.perform("providerClaim", claimProvider, {
            owner: "guardian", repoId, runRef: `canary:${nwo}`,
            pid: process.pid, lstart: ctx.lstart, isAlive: isSameProcess },
            () => { raise("the provider scheduler is unreadable; dispatching unscheduled");
                    log(logPath, `execute: provider unreadable, running the containment canary unscheduled: the hub went away between the check and the claim`);
                    return NO_HUB; });
          if (got === NO_HUB) return { ok: true };
          askedFor.add(`canary:${nwo}`);
        } catch (err) {
          raise("the provider scheduler is unreadable; dispatching unscheduled");
          log(logPath, `execute: provider unreadable, running the containment canary unscheduled: ${err.message}`);
          return { ok: true };
        }
        if (!got.ok) {
          // `queued`, `cooldown` and `at-limit` are the scheduler working.
          // `no-identity` is not: this process cannot read its own start time,
          // so no lease it takes could ever be matched by liveness, and waiting
          // repairs nothing.
          if (got.reason === "no-identity") raise("the guardian cannot read its own process identity; no work can be scheduled");
          log(logPath, `execute: NOT running the containment canary — provider ${got.reason}`);
          skipDispatch = true;
          return { ok: false, why: `provider ${got.reason}` };
        }
        if (got.id != null) canaryLease = { owner: "guardian", repoId, runRef: `canary:${nwo}`, id: got.id, token: got.token ?? null };
        return { ok: true };
    };
      // BOUND OR IT DOES NOT RUN, the same rule as a worker's. I made this
      // non-fatal and argued that refusing would abort a measurement that is
      // otherwise fine -- which privileged completing the measurement over the
      // invariant the whole change exists for. A throw here means `withhold`,
      // `killGroup` and an UNBOUND outcome, so the canary fails and containment
      // stays open: no dispatch this tick, which is safe and self-correcting.
      // An unbound canary lease is not.
    const canaryOnSpawn = ({ pid, lstart }) => {
        if (!canaryLease) return;
        // NAMED, not inferred. Without this the throw below reports "matched no
        // row(s)" -- a fact about the query -- when the truth is that there was
        // no scheduler to ask.
        const b = session.perform("providerBind", bindProviderLease,
          { ...canaryLease, pid, lstart, isAlive: isSameProcess },
          () => ({ ok: false, reason: "the hub went away before the canary's lease could be rebound" }));
        if (b?.ok === false)
          throw new Error(`the canary's provider lease could not be rebound: ${b.reason}`);
        if (b?.bound !== 1)
          throw new Error(`the canary's provider lease rebind matched ${b?.bound ?? "no"} row(s); it would stay on the guardian`);
    };
    try {
      // INJECTABLE, like the other fifty-eight collaborators this tick reaches
      // through `ctx`. `beforeSpawn` is reachable only on the PAID branch of
      // `measuredContainment` -- the cheap gates, an injected verdict and a cache
      // hit all return before it -- so `skipDispatch`, and everything downstream
      // of it, could not be exercised by any fixture. It appeared in the suite
      // only inside comments.
      containment = await (ctx.measureContainment ?? measuredContainment)(ctx, profile, nwo, logPath,
        { beforeSpawn: canaryBeforeSpawn, onSpawn: canaryOnSpawn });
    } finally {
      // THE CANARY IS A PAID MODEL CALL, so its rate limit is the provider's
      // state and not this measurement's private business. `sandboxCanary`
      // preserves the worker's outcome in `evidence.outcome`, and a failed
      // canary is never a cache hit -- so without this the next tick claims
      // another slot and spends another request into the same exhausted window,
      // while builders stay eligible against the same untouched `provider_state`.
      // The cooldown goes in BEFORE the slot goes back, exactly as on the worker
      // path.
      if (containment?.canary?.evidence?.outcome === OUTCOMES.RATE_LIMITED) {
        noteCooldownWithRetry(`cooldown:canary:${nwo}`,
          { signature: profile.watch?.model ?? "claude", cooldownSeconds: RATE_LIMIT_COOLDOWN_SECONDS });
      }
      // RELEASED WHATEVER HAPPENED. The canary can throw, and a lease left
      // behind by a throw is counted against the limit until it expires -- five
      // minutes of the guardian throttling itself over one failed measurement.
      if (canaryLease) releaseWithRetry(`canary:${nwo}`, canaryLease);
    }
  }
  if (execute && wanted.length && !skipDispatch && containment.credentialRead !== "closed") {
    log(logPath, `execute: NOT dispatching ${wanted.length} worker task(s) — worker containment is open: ${containment.why}`);
    raise("guardian:containment:open");
  }

  if (execute && wanted.length && !skipDispatch && containment.credentialRead === "closed") {
    // Injectable: the real reading is the machine's load average, which is right
    // for production and wrong for a test — a busy host makes canStart 0 and the
    // suite reports "no worker dispatched" about the laptop rather than the code.
    const cap = (ctx.capacity ?? capacity)({ maxWorkers: profile.watch?.maxWorkers ?? 5, running: ctx.running ?? 0 });
    log(logPath, `execute: capacity allows ${cap.canStart} worker(s) (load ${cap.load1?.toFixed?.(2) ?? "?"}, ${cap.perfCores} perf cores)`);
    let started = 0;

    const PREP_BACKOFF = (ctx.prepBackoff ??= new Map());   // pr -> { until, failures }
    for (const { e, decision, cause, fp, spendKey } of decisions) {
      // Already handled at decision time, in the same transaction as the decision.
      // Nothing to dispatch: reeve posts it.
      // The same condition the producer uses. If they disagree, a disarmed run
      // skips the dispatch for an action it never queued -- so the request is
      // neither made by reeve nor handed to a worker, and nothing says so.
      if (decision.action === "REQUEST_REVIEW" && execute && reviewActionsOn(profile)) continue;
      if (UNBUILT_ACTIONS[decision.action]) {
        log(logPath, `  #${e.pr}: NOT dispatching ${decision.action} — ${UNBUILT_ACTIONS[decision.action]}`);
        raise(`#${e.pr}: ${decision.action.toLowerCase().replace("_", " ")} needs a GitHub effect reeve does not yet perform`);
        continue;
      }
      const prepKey = e.pr;
      const backoff = PREP_BACKOFF.get(prepKey);
      if (backoff && backoff.until > Date.now() && WORKER_ACTIONS.includes(decision.action)) {
        log(logPath, `  #${e.pr}: NOT dispatching — worker preparation failed ${backoff.failures} time(s); backing off until ${new Date(backoff.until).toISOString()}`);
        raise(`#${e.pr}: the worker could not be prepared; reeve is backing off`);
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
          raise(`#${e.pr}: every failing check is a demonstrated flake — reeve will not pay a fixer for randomness`);
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
        promptCtx = { ...promptCtx, threads: dispatchable(decision, e.threadDetails) };
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
        raise(`#${e.pr}: cannot dispatch — ${why}`);
        log(logPath, `  #${e.pr}: NOT dispatching — ${why}`);
        continue;
      }

      // A PROVIDER LEASE BEFORE A DURABLE RUN, in that order and not the other
      // way round. `startRun` spends a fixer's attempt two lines below it, so a
      // dispatch refused for capacity AFTER the run exists burns the single
      // retry the design allows on work that never ran.
      let prLease = null;
      const prRunRef = `${nwo}#${e.pr}:${decision.action}`;
      // THE SAME FRESH HANDLE THE CLAIM WILL USE. This guarded on the snapshot
      // taken at the top of the tick while the claim below took a current one --
      // so a hub that was absent or unreadable at that first read and usable by
      // dispatch time meant the worker skipped `claimProvider` entirely and ran
      // UNSCHEDULED against a scheduler that was available. I noticed this
      // asymmetry last round and judged it acceptable; it is not, and "the guard
      // and the operation must ask the same question at the same moment" is the
      // rule I had already applied everywhere else.
      if (session.available()) {
        if (repoId == null) {
          // FAIL CLOSED, the same as the canary: a lease that cannot be scoped
          // is invisible to the live-request index, so the guardian would insert
          // a fresh request every tick and the limit would never bind.
          log(logPath, `  #${e.pr}: NOT dispatching — the repository id is unknown, so a provider lease cannot be scoped`);
          raise("the repository numeric id is unknown; provider leases cannot be scoped");
          continue;
        }
        let got;
        // FAIL OPEN on an unreadable scheduler. The founder's decision is that a
        // broken scheduler must not stop the guardian working -- but it must say
        // so, because dispatching unscheduled is exactly what the limit exists
        // to prevent and a silent version of it is indistinguishable from a
        // working one.
        try {
          askedFor.add(prRunRef);
          got = session.perform("providerClaim", claimProvider, {
            owner: "guardian", repoId, runRef: prRunRef,
            pid: process.pid, lstart: ctx.lstart, isAlive: isSameProcess },
            () => { raise("the provider scheduler is unreadable; dispatching unscheduled");
                    log(logPath, `  #${e.pr}: provider unreadable, dispatching unscheduled: the hub went away between the check and the claim`);
                    return { ok: true, id: null }; });
        } catch (err) {
          raise("the provider scheduler is unreadable; dispatching unscheduled");
          log(logPath, `  #${e.pr}: provider unreadable, dispatching unscheduled: ${err.message}`);
          got = { ok: true, id: null };
        }
        if (!got.ok) {
          // ORDINARY OUTCOMES. `queued`, `cooldown` and `at-limit` are the
          // scheduler working, not failing: this PR waits for the next tick and
          // the others in this loop still get their turn.
          //
          // `no-identity` is not the scheduler working. It means this process
          // could not read its own start time, so no lease it takes could ever
          // be matched by liveness -- and no amount of waiting repairs it. It
          // still fails closed, but it says so to a human.
          if (got.reason === "no-identity") raise("the guardian cannot read its own process identity; no work can be scheduled");
          log(logPath, `  #${e.pr}: NOT dispatching — provider ${got.reason}${got.until ? ` until ${got.until}` : ""}`);
          continue;
        }
        if (got.id != null) prLease = { owner: "guardian", repoId, runRef: prRunRef, id: got.id, token: got.token ?? null };
      }

      // A durable run is the ONLY way a worker may start. The exclusive right to
      // act on this PR is taken FIRST, so a restarted daemon cannot re-dispatch
      // work already in flight -- the log shows exactly that happening, the same
      // fix launched at 15:02 and again at 15:12.
      const run = startRun(db, { nwo, pr: e.pr, action: decision.action, head: e.head, cause });
      // READ BEFORE, so the refund below can tell whether THIS call spent an
      // attempt. `attemptsFor` answers MAX_SAFE_INTEGER when it cannot read, and
      // that is the safe sentinel in both directions here: an unreadable count
      // makes "did it go up?" answer no, and no attempt is taken back.
      const attemptsBefore = (decision.action === "FIX_CI" && fp)
        ? attemptsFor(db, nwo, e.pr, fp, logPath) : 0;
      // Spent here, beside the run: past every refusal, before any work. A crash
      // after this point costs an attempt, which is the correct direction --
      // a crashed fix that silently earns a free retry is the runaway loop.
      // GUARDED, because the provider lease is already held by this point and the
      // worker block's try/finally has not begun. `fix_attempt` is an ordinary
      // local write and it can throw -- a damaged table, a full store -- and a
      // throw here left the tick with the lease still held, bound to the live
      // guardian pid, which the expiry reaper preserves for ever. Nothing
      // reclaims it if the next tick decides differently about this PR.
      try {
        if (run.ok && spendKey) (ctx.recordFixAttempt ?? recordFixAttempt)(db, nwo, e.pr, spendKey, e.head);
      } catch (err) {
        if (prLease) { releaseWithRetry(prRunRef, prLease); prLease = null; }
        // AND RETIRE THE RUN, because nothing else ever will.
        //
        // `startRun` has already succeeded by this point, so a durable run is
        // live. Releasing only the provider lease left it `leased` for ever:
        // `run_one_live_per_task` is UNIQUE, so every later `startRun` for this
        // pull request answers "already live", and there is no run reaper in
        // production -- the only reaper the tick calls is `reapProviderLeases`,
        // which is about provider rows. Repairing the table that threw would not
        // have restored dispatch; the row had to be cleared by hand.
        //
        // UNBOUND rather than failed: nothing ran and nothing was learned, so the
        // node returns to `ready` and the pull request is dispatchable again on
        // the next tick. `finishRun` retires the row on every outcome for exactly
        // this reason, and it is the caller's job to ask.
        // GUARDED, because this is a CATCH and the tick is fail-soft here.
        //
        // `finishRun` writes several rows in a transaction and rethrows database
        // errors, and the store that just refused `recordFixAttempt` is the same
        // store — full, locked, damaged. An unguarded throw inside this catch
        // escapes `tick` entirely: the escalation is never raised, the remaining
        // pull requests are never seen, the queued-request sweep never runs, and
        // the run this block exists to retire is left live anyway. A repair that
        // can take the tick with it is worse than the leak it repairs.
        //
        // AND REFUND THE ATTEMPT THIS CALL ACTUALLY SPENT — no more than that.
        //
        // `recordFixAttempt` INSERTs and then RETURNS a count, so the write can
        // commit and the trailing read still throw: an attempt spent for work
        // that never started. The next tick then reads the cause as exhausted and
        // escalates rather than redispatching, contradicting this path's own
        // UNBOUND outcome.
        //
        // BUT AN UNCONDITIONAL REFUND IS NOT A NO-OP. I claimed it was, having
        // checked only the case where no row exists at all. `refundFixAttempt` is
        // an UPDATE with a WHERE: against a cause that already carries a
        // LEGITIMATE prior attempt it decrements THAT row. Measured — a prior
        // attempt of 1 becomes 0 — so with `maxFixAttemptsPerFinding` above one,
        // a pre-commit failure here would erase a real attempt and hand out a
        // repair beyond the configured cap. The schema permits any integer.
        //
        // So the count is compared across the call and the refund is taken only
        // when this invocation is the one that raised it.
        if (run.ok) {
          try {
            if (decision.action === "FIX_CI" && fp
                && attemptsFor(db, nwo, e.pr, fp, logPath) > attemptsBefore)
              if (spendKey) refundFixAttempt(db, nwo, e.pr, spendKey);
          } catch (e2) {
            log(logPath, `  #${e.pr}: the fix attempt could not be refunded — ${e2.message}`);
          }
          try {
            const fin = finishRun(db, { runId: run.runId, outcome: OUTCOMES.UNBOUND,
                                        why: `the fix attempt could not be recorded: ${err.message}` });
            if (!fin?.applied) log(logPath, `  #${e.pr}: the run could not be retired — ${fin?.why}`);
          } catch (e2) {
            log(logPath, `  #${e.pr}: the run could not be retired — ${e2.message}`);
            raise(`#${e.pr}: a run was left live because it could not be retired`);
          }
        }
        log(logPath, `  #${e.pr}: NOT dispatching — the fix attempt could not be recorded: ${err.message}`);
        raise(`#${e.pr}: the fix attempt could not be recorded`);
        continue;
      }
      if (!run.ok) {
        // Refusing to act is the only safe answer when the transition cannot be
        // recorded: an unrecorded worker is one nothing can reason about later.
        // The lease taken above is given back here: nothing is going to run
        // under it, and holding it until expiry throttles the guardian for five
        // minutes over a store that refused one row.
        if (prLease) releaseWithRetry(prRunRef, prLease);
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
        // AND THE PROVIDER LEASE, on the same beat.
        //
        // `LEASE_SECONDS` is 300 and `watch.workerBudgetMinutes` defaults to 20,
        // so without this every worker spends three quarters of its run holding
        // a lease that expired, and `expires_at` means nothing for exactly the
        // runs it was meant to bound. Nothing over-admits today -- `heldCount`
        // counts held rows whatever their expiry, and the reaper spares one
        // whose holder is alive -- so this is not a live defect; it is a column
        // that has stopped describing reality, and `expiredLeases` is one
        // liveness misread away from acting on it.
        //
        // Renewed by IDENTITY, which is why this works before and after the
        // spawn rebinds the row from the guardian's pid to the worker's.
        //
        // Failure is logged, never fatal: the run is under way, and a lease that
        // stops being renewed still ends when the process does.
        if (prLease) {
          try {
            {
              // A renewal that could not be attempted is NOT lease loss: only
              // `ok && beat === 0` is, and undefined is neither.
              const phb = session.perform("providerHeartbeat", heartbeatProvider,
                                          { ...prLease, isAlive: isSameProcess },
                                          () => undefined);
              // A ZERO-ROW RENEWAL IS LEASE LOSS, and the result was discarded.
              //
              // `heartbeatProvider` answers `{ ok: true, beat: 0 }` when the
              // fenced row is GONE -- reaped after a liveness misread, cleared by
              // a restore -- which is `ok` in the sense that the query ran and
              // nothing in the sense that matters. The worker went on consuming
              // provider capacity while the scheduler counted no lease for it and
              // could admit replacement work beside it, which is the double-spend
              // the scheduler exists to prevent.
              //
              // The run heartbeat three lines above already feeds `revoked`; this
              // half never reached `runWorker`'s gate. Only `ok && beat === 0` is
              // loss: a REFUSAL is the hub being held by a restore, which says
              // nothing about whether the lease still exists.
              if (phb?.ok === true && phb.beat === 0)
                revoked = "the provider lease is gone; the scheduler no longer counts this worker";
            }
          } catch (err) { log(logPath, `  #${e.pr}: provider lease not renewed — ${err.message}`); }
        }
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
      let r, prepFailed = false, worktree = null, workerToken = null, copiedDeps = {};  // the baseline: path -> digest of what preparation left untracked
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
        // What preparation ACTUALLY copied, not what the profile declared. A
        // declared path that did not exist is skipped, and excluding it anyway
        // would hide the worker's own creation of it from staging AND from the
        // uncommitted check -- losing that part of the fix while the rest ships.
        copiedDeps = prepared.deps?.untracked ?? {};
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
        // The disallow list comes from the SANDBOX, never from `spec`. A prompt
        // spec may widen the allow grant, which is a lane's business; it may not
        // narrow this one, because these are the tools no lane has a reason to
        // hold and the whole point is that the refusal does not depend on who
        // asked. Passed as a flag AND written into the settings file: the flag is
        // what the CLI acts on, the file is what a reader of the sandbox sees.
        const argv = workerArgs({ prompt: spec.prompt, allowedTools: tools, settings: settingsPath, maxTurns,
                                  disallowedTools: sandbox.disallowedTools });
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
          raise("guardian:containment:changed");
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
          onSpawn: ({ pid, lstart }) => {
            bindRun(db, { runId: run.runId, pid, boot: lstart });
            noteWorkerBinding(db, { runId: run.runId, pid, lstart });
            // AND THE PROVIDER LEASE, onto the process actually spending the
            // quota. The claim above is recorded against the guardian's own pid,
            // which is long-lived and therefore always alive -- so liveness was
            // being asked about the wrong process. `runWorker` launches a
            // DETACHED child: if the guardian dies while that child works on, the
            // next scheduler transaction sees the guardian pid gone, reaps the
            // lease as abandoned, and admits replacement work while the original
            // worker is still consuming the window.
            //
            // The full identity, because `bindProviderLease` refuses anything
            // less: an id-only call matches nothing and returns a silent
            // `{ ok: true, bound: 0 }` wearing a success.
            // A GATE, NOT AN OBSERVER -- and the first revision had this exactly
            // backwards. `onSpawn` is called BEFORE `runWorker` releases the
            // child's execution gate: a throw here means `withhold()`,
            // `killGroup(SIGKILL)` and an UNBOUND outcome, which is the same
            // treatment `bindRun` already gets one line above. The comment in
            // `supervisor.mjs` states the rule: a worker whose binding could not
            // be written is one a restart can neither adopt nor kill with
            // confidence, so it does not get to run at all.
            //
            // Logging and continuing left the lease attached to the guardian's
            // own always-alive pid -- so a guardian that died during a detached
            // run left a row the reaper would collect while the worker was still
            // spending the window. The whole point of rebinding.
            //
            // EXACTLY ONE ROW. `bindProviderLease` returns `{ ok: true, bound: 0 }`
            // when its predicate matches nothing, which is a silent no-op wearing
            // a success, and zero rebound is indistinguishable in effect from not
            // having called it.
            if (prLease) {
              const b = session.perform("providerBind", bindProviderLease,
                { ...prLease, pid, lstart, isAlive: isSameProcess },
                () => ({ ok: false, reason: "the hub went away before the lease could be rebound" }));
              if (b?.ok === false)
                throw new Error(`the provider lease could not be rebound to the worker: ${b.reason}`);
              if (b?.bound !== 1)
                throw new Error(`the provider lease rebind matched ${b?.bound ?? "no"} row(s); the lease would stay on the guardian`);
            }
          },
        });
        }
      } catch (err) {
        // A worker that could not be prepared or launched is a failed attempt
        // with its reason, never a thrown tick: the run below is closed, the
        // lease released, and the next PR still gets its turn. The attempt
        // spent above is refunded: this failure is reeve's, not the fix's.
        r = { outcome: OUTCOMES.FAILED, why: `could not prepare the worker: ${err.message}`, ms: 0, cost: null, sessionId: null };
        prepFailed = true;
        if (spendKey) { try { refundFixAttempt(db, nwo, e.pr, spendKey); } catch { /* the run still closes */ } }
        const prev = PREP_BACKOFF.get(prepKey)?.failures ?? 0;
        PREP_BACKOFF.set(prepKey, { failures: prev + 1, until: Date.now() + Math.min(PREP_BACKOFF_CAP_MS, PREP_BACKOFF_BASE_MS * 2 ** prev) });
        raise(`#${e.pr}: the worker could not be prepared; reeve is backing off`);
      } finally {
        clearInterval(beat);
        // THE PROVIDER LEASE GOES BACK HERE, and this is the only place it does
        // for a dispatched run. Every exit from this block passes through --
        // success, worker failure, a throw during preparation -- so there is one
        // release path rather than one per outcome, which is how the outcome
        // nobody thought of ends up holding a lease until it expires.
        //
        // THE COOLDOWN GOES IN BEFORE THE SLOT GOES BACK.
        //
        // A worker that came back rate-limited proves the provider's window is
        // exhausted, and that is a fact about the PROVIDER rather than about
        // this run. Releasing the lease without recording it hands the slot
        // straight back, so the next tick claims it and spends another request
        // into the same exhausted window -- and the builder, admitting against
        // the same `provider_state`, does too. `raise` alone told a human and
        // changed nothing the scheduler reads.
        //
        // Read before the classification below, which only ever rewrites UNBOUND
        // and CANCELLED: a RATE_LIMITED outcome is already final here.
        if (r?.outcome === OUTCOMES.RATE_LIMITED) {
          noteCooldownWithRetry(`cooldown:${nwo}#${e.pr}`,
            { signature: r?.model ?? profile.watch?.model ?? "claude",
              cooldownSeconds: RATE_LIMIT_COOLDOWN_SECONDS });
        }
        // A release refused because a restore holds the hub is RETRIED, not
        // swallowed: `releaseWithRetry` carries the identity to the next tick.
        if (prLease) { releaseWithRetry(prRunRef, prLease); prLease = null; }
        // Classified FIRST, before anything is recorded: a binding refused
        // because a cancel landed first is a cancellation, not a preparation
        // failure, and the audit trail must say so (run.finish, cancelled),
        // not record a refused unbound worker. Nothing ran, so the fixer's
        // attempt is given back as well.
        if (r?.outcome === OUTCOMES.UNBOUND && /cancel/.test(r?.why ?? "")) {
          r = { ...r, outcome: OUTCOMES.CANCELLED, why: r.why };
          if (spendKey) { try { refundFixAttempt(db, nwo, e.pr, spendKey); } catch { /* the run still closes */ } }
        }
        // Pre-execution outcomes are classified BEFORE the recorder and the
        // finish, so a recorder that fails cannot rewrite them into a spent
        // failure. A worker that never executed (the gate refused its binding) spent no
        // fixer's attempt; it is refunded like any pre-execution failure, and it
        // backs off like one: a binding that keeps failing would otherwise
        // lease and refuse the PR on every tick with nobody told.
        if (r?.outcome === OUTCOMES.UNBOUND) {
          prepFailed = true;
          if (spendKey) { try { refundFixAttempt(db, nwo, e.pr, spendKey); } catch { /* the run still closes */ } }
          const prev = PREP_BACKOFF.get(prepKey)?.failures ?? 0;
          PREP_BACKOFF.set(prepKey, { failures: prev + 1, until: Date.now() + Math.min(PREP_BACKOFF_CAP_MS, PREP_BACKOFF_BASE_MS * 2 ** prev) });
          raise(`#${e.pr}: the worker could not be prepared; reeve is backing off`);
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
        raise(`#${e.pr}: the worker changed its checkout's git configuration; the checkout is preserved at ${worktree} for inspection`);
        raise("guardian:checkout:config-tampered");
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
          raise(`#${e.pr}: an unfinished candidate fix was preserved rather than published — ${left?.length ? left.slice(0, 3).join(", ") : `commits on ${e.headRef}`}`);
        } else {
          releaseRunCheckout(worktree, { workFetched: true });
        }
      }

      // Attached now rather than at dispatch: the reason only exists once the
      // worker has spoken, and it is what the retry cap will quote when it fires.
      // Stored under the SAME key the attempt was spent against, whichever repair
      // it was. Two identities, one place to look them up.
      if (spendKey) noteFixAttempt(db, nwo, e.pr, spendKey, statedBlocker(r.report));

      if (r.outcome === OUTCOMES.OK) {
        // The worker cannot commit its own work. Its sandbox denies Bash writes
        // to `.git`, so `git add` and `git commit` fail with EPERM on
        // `.git/index.lock`: measured 2026-08-23, seven attempts in one run and
        // thirteen of its thirty-six turns spent correctly diagnosing an
        // instruction it could not carry out. Three dispatches produced three
        // correct fixes and published none of them
        // (docs/measured/2026-08-23-three-real-dispatches.md).
        //
        // reeve commits instead, and does it HERE -- before every gate below, so
        // this decides nothing about what may ship. It only makes the work
        // pushable; the gates then judge the ref that results, exactly as they
        // judged the worker's own commits before.
        // A worker that says it did NOT fix this must not have its exploration
        // published. `classifyResult` judges the process, so a declined run still
        // arrives as OK, and the output contract calls `fixed: false` a good
        // outcome. Before reeve committed, such a run was stopped by the
        // uncommitted-work gate below; committing first would turn a declared
        // non-fix into a publishable repair. The edits are left exactly where they
        // are, so that gate preserves them and names a human.
        // Affirmative, not merely not-negative. `parseReport` returns null when the
        // worker omits the fenced JSON or emits something malformed, and
        // `classifyResult` still says OK -- so optional-chained checks for
        // `fixed: false` both read false and reeve would commit an exploratory
        // edit under a generic message. A publication needs the worker to have
        // SAID it fixed this.
        const declined = !r.report ? "the worker returned no usable report"
          : r.report.fixed !== true ? "the worker did not report a fix"
          // An absent or malformed `filesTouched` would reach `commitRunWork` as
          // null and turn the declaration check OFF, so a scratch file would be
          // committed with the fix. A field reeve cannot read is not permission
          // to skip the guard it feeds.
          : !Array.isArray(r.report.filesTouched) ? "the worker did not report which files it changed"
          : r.report.needsHuman ? `the worker reported it needs a human: ${printable(String(r.report.needsHuman)).slice(0, 160)}`
          : null;
        const landed = declined ? { ok: true, committed: false, files: [], why: `not committing: ${declined}` }
                                : (ctx.commitWork ?? commitRunWork)({
          repoRoot: repoCheckout, path: worktree, branch: e.headRef,
          message: repairMessage(r.report, decision),
          secrets: [{ label: "reeve's worker authentication token", value: workerToken }],
          // The diff gate judges paths and territory, never intent, so a
          // reproduction script inside the lane passes it. reeve commits what the
          // worker SAID it changed, and refuses when the checkout holds anything
          // it did not.
          declared: r.report.filesTouched,
        });
        if (!landed.ok) {
          const rel = releaseRunCheckout(worktree, { workFetched: false });
          log(logPath, `  #${e.pr}: NOT published — reeve could not commit the work: ${landed.why}${rel.quarantined ? `; preserved at ${rel.path}` : ""}`);
          raise(`#${e.pr}: a finished fix was NOT published — reeve could not commit it: ${landed.why}`);
          continue;
        }
        if (landed.committed) log(logPath, `  #${e.pr}: committed ${landed.files.length} file(s) the worker left in the checkout`);
        else if (landed.why) log(logPath, `  #${e.pr}: ${landed.why}`);

        // Everything accepted must be COMMITTED before anything is published or
        // released. reeve publishes by fetching the checkout's BRANCH, so an
        // uncommitted edit is invisible to the push and would then be deleted
        // with the checkout while the log said it was published. The work is
        // kept and a human is told, because a candidate fix nobody has a copy of
        // is not spare disk space. (Codex #5-[2].)
        const stillDirty = uncommittedFiles(worktree, copiedDeps);
        if (stillDirty === null || stillDirty.length) {
          const why = stillDirty === null
            ? "reeve could not read the checkout's status, so it cannot say the work was committed"
            : `the worker finished with ${stillDirty.length} uncommitted change(s), which a push cannot carry`;
          const rel = releaseRunCheckout(worktree, { workFetched: false });
          log(logPath, `  #${e.pr}: NOT published — ${why}${rel.quarantined ? `; preserved at ${rel.path}` : ""}`);
          raise(`#${e.pr}: a finished fix was NOT published — ${why}` +
                `${stillDirty?.length ? ` (${stillDirty.slice(0, 3).join(", ")})` : ""}`);
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
          raise(`#${e.pr}: a finished fix was NOT published — reeve could not read ${e.headRef} in the worker's checkout`);
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
          raise(blocker
            ? `#${e.pr}: needs a human — ${blocker}`
            : `#${e.pr}: a fix was produced but refused publication — ${gate.why}`);
        } else {
          // Before reeve puts its name on it: the worker had a working token in
          // its environment and every runtime needed to read it. A filename gate
          // cannot see that, and reeve is the party that pushes.
          const leak = await diffCarriesSecret(worktree, e.head, publishRef, [{ label: "reeve's worker authentication token", value: workerToken }]);
          if (leak) {
            const rel = releaseRunCheckout(worktree, { workFetched: false });
            log(logPath, `  #${e.pr}: NOT published — ${leak.why}${rel.quarantined ? `; preserved at ${rel.path}` : ""}`);
            raise(`#${e.pr}: a fix was refused publication because ${leak.why}; rotate the token with \`claude setup-token\``);
            raise("guardian:worker:credential-in-diff");
            continue;
          }
          // reeve publishes, not the worker: the actor and the only claim that
          // the action was allowed must not be the same party.
          const pushed = (ctx.publishWork ?? publishRunWork)({ repoRoot: repoCheckout, path: worktree,
                                                               branch: e.headRef, expectedRemote: e.head });
          if (!pushed.ok) {
            log(logPath, `  #${e.pr}: NOT published — ${pushed.why}`);
            raise(`#${e.pr}: a fix was produced but could not be published — ${pushed.why}`);
          } else {
            log(logPath, `  #${e.pr}: published ${changed.length} file(s)` + (refused.length ? ` (${refused.length} call(s) refused along the way)` : ""));
            // Published, and still escalated: CI at the new head is the check that
            // matters, and a fix nothing ran the tests over should be watched.
            if (couldNotVerify)
              raise(`#${e.pr}: a fix was published but the worker could not run the project's checks — watch CI at the new head`);
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
      if (r.outcome === OUTCOMES.RATE_LIMITED) { raise("the provider is rate limiting; work is paused"); break; }
    }
  }

  // ── withdraw what this tick did not actually ask for ──────────────────────
  //
  // AFTER the loop, and keyed on what was ASKED rather than on what was
  // intended. `wanted` is every worker decision; the loop then applies capacity,
  // the preparation backoff, root-cause resolution, flake assessment, prompt
  // construction and checkout preparation on top. A request that survives the
  // first filter and not the rest was never re-asked, so cancelling from intent
  // preserved it and cancelling from the ask withdraws it -- and a queued row
  // owned by the live guardian blocks builder admission for as long as it sits
  // there.
  //
  // A pull request this tick could not READ is still exempt: absence there means
  // unknown, not unwanted, and only a positive evaluation may withdraw one.
  if (execute && repoId != null && queuedNow.length) {
    if (session.available()) {
      const unread = [...unreadable].map(pr => `${nwo}#${pr}:`);
      // EVERYTHING THIS TICK STILL WANTS BUT NEVER GOT TO ASK FOR.
      //
      // The distinction is whose refusal it was. When the per-decision loop RUNS,
      // it is the authority: it marks `askedFor` before every claim, so a request
      // it asked for is kept whatever the scheduler answered, and one it refused
      // locally — capacity, the preparation backoff, a failed checkout — is a
      // genuine withdrawal and the row should go.
      //
      // `skipDispatch` is the case where the loop never ran at all, because the
      // scheduler refused the CANARY. No decision was made about any pull
      // request, so cancelling would surrender queue positions the tick still
      // wants, and the next tick would re-queue them at the BACK behind whatever
      // arrived in between. Removing the preflight's unconditional mark was
      // right; removing it without this was one step short.
      if (skipDispatch) for (const ref of intendedNow) heldByScheduler.add(ref);
      for (const row of queuedNow) {
        if (askedFor.has(row.run_ref)) continue;
        if (heldByScheduler.has(row.run_ref)) {
          log(logPath, `provider: keeping a queued request the SCHEDULER refused, not this tick (${row.run_ref})`);
          continue;
        }
        if (unread.some(prefix => row.run_ref.startsWith(prefix))) {
          log(logPath, `provider: keeping the queued request for a PR this tick could not read (${row.run_ref})`);
          continue;
        }
        try {
          const c = session.perform("cancelQueued", cancelQueued, {
            owner: "guardian", repoId, runRef: row.run_ref, isAlive: isSameProcess },
            () => ({ ok: false, reason: "the hub went away while cancelling" }));
          if (c?.ok) log(logPath, `provider: cancelled a queued request this tick never asked for (${row.run_ref})`);
          else log(logPath, `provider: could not cancel ${row.run_ref} — ${c?.reason}`);
        } catch (err) {
          log(logPath, `provider: could not cancel ${row.run_ref} — ${err.message}`);
          raise("the provider scheduler is unreadable; dispatching unscheduled");
        }
      }
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
      const home = ctx.home ?? dirname(logPath ?? join(resolveHome(), "x"));
      const all = (ctx.snapshotAll ?? snapshotAll)(home, root, { at });
      for (const r of all) {
        if (r.ok) continue;
        log(logPath, `backup FAILED (${r.nwo}): ${r.why}`);
        // ESCALATED, not only logged. `snapshotAll` has always returned an
        // `escalate` key on a failed snapshot and nothing anywhere consumed it,
        // so a backup that wrote an unreadable file and deleted it produced one
        // log line and no finding. The self-audit below cannot cover the gap
        // either: the previous GOOD snapshot is deliberately retained, so it
        // still looks fresh and reports nothing -- and the failure stays silent
        // until that retained copy ages out, which is exactly the window in
        // which there is no working backup.
        // ON ctx, not only in this tick's map. `escalations` is rebuilt every
        // tick and a backup is attempted once an INTERVAL, so the finding
        // existed for one tick and was then absent -- which `announceable`
        // reads as resolved, so the next ordinary tick could announce CLEARED
        // while no backup had succeeded. The retained previous snapshot is
        // still fresh enough that the self-audit does not recreate it either.
        // It stands until a snapshot for that store is actually TAKEN.
        if (r.escalate) (ctx.backupFailures ??= new Map()).set(r.nwo, `${r.escalate}: ${r.nwo}`);
      }
      // `taken`, not `ok`. A deferred result is `ok` -- another process
      // published this second and that is not a failure -- but this daemon did
      // not take it, and counting it here would report a backup this tick did
      // not perform.
      const okd = all.filter(r => (r.outcome ?? (r.ok ? "taken" : "failed")) === "taken");
      if (okd.length) log(logPath, `backup: ${okd.length} store(s) — ${okd.map(r => r.nwo).join(", ")}`);
      // A snapshot that was TAKEN clears that store's standing failure, and
      // nothing else does. `deferred` does not: another process published this
      // second, which says nothing about whether THIS daemon can.
      for (const r of okd) ctx.backupFailures?.delete(r.nwo);
      // A tick that snapshotted nothing at all is a backup that is not happening.
      if (!all.length) log(logPath, "backup FAILED: no state store found to snapshot");
      ctx.lastBackupAt = at;
    }
    // RE-EMITTED EVERY TICK, after the block above so a success this tick has
    // already cleared it. Between backup attempts there is nothing to recreate
    // the finding, and absence within a tick is what the layer below reads as
    // resolved.
    for (const line of (ctx.backupFailures ?? new Map()).values()) raise(line);
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
      home: ctx.home ?? dirname(logPath ?? join(resolveHome(), "x")),
    })) {
      log(logPath, `self: ${f.level} ${f.why}${f.detail ? ` — ${f.detail}` : ""}`);
      raise(f.why, f.count ?? 1);
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
  // Drain AFTER the decisions and BEFORE the announcement. After, so an effect
  // enqueued in this tick goes out in this tick. Before, because a dead letter it
  // raises must reach the same tick's escalations -- `announceable` reads the map
  // once, so anything added later is written to a set nobody looks at again, and
  // the permanent loss of a review request would be announced by nothing. Unconditional: with nothing
  // enqueued it leases nothing and costs one query, and gating it as well as the
  // producers would mean the path that performs the writes had never run by the
  // time the flag was first flipped.
  //
  // A drain failure never fails the tick. Watching, judging and escalating do not
  // depend on it, and a queue that cannot move is a reason to say so rather than to
  // stop reading pull requests.
  await drainDueEffects([...finished]);

  const { fresh, cleared } = announce({ covered: evaluated, waiting, finished,
                                        complete: evaluated.size === prs.length });

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
/**
 * The commit this PROCESS is running, read from the tree its own modules came from.
 *
 * A commit that cannot be read is reported as unreadable, never guessed: an
 * invented value here is worse than the checkout reading it replaces.
 */
export function runningCommit(from = dirname(fileURLToPath(import.meta.url))) {
  try {
    return execFileSync("git", ["-C", from, ...GIT_NEUTRALISE, "rev-parse", "--short", "HEAD"],
                        { encoding: "utf8", timeout: 10_000 }).trim() || "unreadable";
  } catch { return "unreadable"; }
}

export async function run(ctx) {
  const { logPath, intervalMs = 90_000 } = ctx;
  // The COMMIT this process is about to run from, recorded at startup.
  //
  // Nothing else can answer the question. `git log -1 HEAD` in the checkout
  // describes the working tree as it is NOW, and a running daemon holds modules
  // loaded when it started: fast-forward the checkout and the tree moves while the
  // process does not, and it does not move until a restart actually succeeds --
  // which it may not, if tests fail or the session doing it is interrupted between
  // the two. Reading the checkout then reports a fix as deployed that is not
  // running anywhere. This line is the only witness taken at the moment that
  // decides, so it is the one to grep for.
  //
  // A commit that cannot be read is recorded as unreadable, never guessed. An
  // invented value here would be worse than the checkout it replaces.
  log(logPath, `reeve daemon starting — node ${process.version}, pid ${process.pid}, running commit ${runningCommit()}`);

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
