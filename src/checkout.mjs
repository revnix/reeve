// checkout — a worker's own copy of the repository, sharing nothing.
//
// Until now a worker was given a LINKED worktree: its own working directory, but
// the clone's `.git` underneath it. That is one directory away from the founder's
// checkout and it shares two things that turned out to matter:
//
//   · the ref store — a worker could move any branch of the clone, including
//     main, with no network and no credential;
//   · the configuration — a worker could write `core.fsmonitor` or a
//     `filter.<name>.clean` entry, and the daemon's own `git status` would then
//     run that program, unsandboxed, as the daemon user.
//
// Both were closed by detection (a config fingerprint, refusing to run git in a
// checkout whose config moved). This closes them by CONSTRUCTION: a standalone
// clone has its own refs and its own config, so there is nothing shared to move
// or to poison. Detection stays as the second layer.
//
// Measured on nextlyhq/nextly, 2026-08-22, APFS:
//
//   git clone --no-hardlinks   2.4s   251 MB   own .git, committed content only
//   cp -Rc node_modules       15.2s    31 MB   copy-on-write, 1.2 GB apparent
//
// The clone deliberately carries only COMMITTED content: a `cp` of the founder's
// checkout would hand the worker their uncommitted work and every ignored file
// (a `.env` among them). That keeps those files OUT of the worker's checkout,
// which is not the same as keeping them out of its reach: measured 2026-08-22,
// the sandbox denies writes outside the checkout but not reads, so a worker
// could read them where they still live. The founder's clone is therefore
// deny-read in the worker's policy too (sandbox.mjs, sourceCheckoutOf), and the
// claim rests on both facts rather than on this one.
//
// Dependencies are the one thing a fresh clone lacks and a fixer cannot live
// without — the network is denied, so it cannot install them — and they are
// supplied by a copy-on-write clone of the directory the founder already has,
// which costs almost nothing because unmodified blocks are shared. The DAEMON
// copies them before the worker starts, so denying the source costs the worker
// nothing: measured on nextlyhq/nextly, every symlink in its node_modules is
// relative and resolves inside the tree, so the copy resolves within the run
// checkout.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { GIT_NEUTRALISE, GIT_NEUTRALISE_FOUNDER, REFUSING_HOOK, recordConfig, reason, gitEnv, founderGitEnv } from "./gitguard.mjs";
import { writeFileSync, chmodSync } from "node:fs";

/** Every daemon git command in a worker-controlled directory carries the neutralisers. */
function git(cwd, args, opts) {
  return run(cwd, GIT_NEUTRALISE, args, gitEnv(), opts);
}

/**
 * A daemon git command whose repository is the FOUNDER's, not a worker's.
 *
 * The isolation exists because a worker's checkout holds pull-request content
 * and its configuration is therefore hostile input. The founder's own
 * repository is not that, and applying the isolation to it removed the very
 * things reeve needs there: measured 2026-08-22, `ls-remote origin` on this
 * repository succeeded ordinarily and failed under the isolation with "could
 * not read Username for 'https://github.com'", because the credential helper
 * lives in the founder's global configuration. Every fetch, ls-remote and push
 * reeve makes on the founder's behalf went through it. A global
 * `url.<base>.insteadOf` rewrite breaks the same way. (Codex #7-[10].)
 *
 * What stays is everything that stops git RUNNING a program; what goes is
 * everything that decides how git reaches a remote.
 *
 * Used for the ORIGIN-FACING commands only, not for every command in the
 * founder's checkout. A local-path fetch, a rev-parse and a merge-base need
 * nothing from the founder's configuration and can only be broken by it: a
 * founder who has hardened git with `protocol.file.allow=never` would have the
 * worker-to-founder fetch refused, and with it every valid fix. The isolation is
 * dropped exactly where reeve must reach the remote, and nowhere else.
 */
function founderGit(cwd, args) {
  return run(cwd, GIT_NEUTRALISE_FOUNDER, args, founderGitEnv());
}

function run(cwd, neutralise, args, env, { raw = false, input = undefined } = {}) {
  try {
    // 64 MiB, because the default 1 MiB is not enough for a repository-sized
    // answer: `changedFiles` raised it after about 1,800 long paths overflowed
    // it, and a helper that fails on SIZE turns a valid repair into a refusal.
    //
    // `raw` for NUL-delimited output, which is DATA and not text: leading and
    // trailing whitespace are legal in a git filename, and trimming ` leading`
    // to `leading` made a correctly declared repair unrecognisable. Only callers
    // reading a textual value want the trim.
    const out = execFileSync("git", ["-C", cwd, ...neutralise, ...args],
      { encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024, env, input });
    return { ok: true, out: raw ? out : out.trim() };
  // `reason` picks git's own fatal line rather than the last thing it printed,
  // which is usually progress narration and sends the reader somewhere else.
  } catch (e) { return { ok: false, out: "", err: reason(e.stderr || e.message) }; }
}

/** What reeve will read of a tree's attributes files before it refuses instead.
 * A real .gitattributes is a few hundred bytes; these are three and four orders
 * of magnitude above that, so they bound a hostile tree without reaching a
 * legitimate one. The TOTAL matters as much as the per-file bound: a tree can
 * commit any number of these, and the daemon reads all of them synchronously. */
const MAX_ATTRIBUTES_BYTES = 1 << 20;

/** How many daemon-copied files reeve will remember in order to tell them from
 * the worker's. A gitignored dependency tree contributes none of these; only an
 * unignored one does, and a project with more than this in one is misdeclaring a
 * source directory as a dependency. */
export const MAX_COPIED_UNTRACKED = 20000;

/** The largest file reeve will hash to decide whether it is still its own copy.
 * A dependency file past this is treated as changed, which holds the work for a
 * human rather than reading an unbounded amount of worker-controlled bytes. */
const MAX_FINGERPRINT_BYTES = 64 * 1024 * 1024;
const MAX_ATTRIBUTES_TOTAL = 4 << 20;

/** The conventional directory for one run's checkout. Keyed by run, not by PR:
 * two runs for the same pull request must never share a directory. */
export const runPathFor = (root, pr, runId) => join(root, `run-${pr}-${runId}`);

/**
 * The dependency trees a fresh clone lacks, per language.
 *
 * IN-TREE paths only. A worker has no network and a scratch HOME, so a language
 * whose dependencies live under the home directory (Go's module cache, cargo's
 * registry, a pip cache) has nothing here to copy and its checks cannot resolve
 * anything. That is a real limit and it is REPORTED rather than hidden: naming
 * only node_modules and saying nothing left a fixer unable to run the tests it
 * was dispatched to fix, with no line anywhere saying why. (Codex #5-[5].)
 */
const DEPENDENCY_PATHS = {
  typescript: ["node_modules"],
  javascript: ["node_modules"],
  python: [".venv"],
};
const HOME_CACHED = { go: "~/go/pkg/mod", rust: "~/.cargo" };

/**
 * What to copy into a run checkout for this profile, and what cannot be copied.
 *
 * `worker.dependencyPaths` overrides the table entirely, for a project whose
 * dependencies live somewhere this does not know about.
 */
export function dependencyPathsFor(profile) {
  const declared = profile?.worker?.dependencyPaths;
  if (Array.isArray(declared)) return { paths: declared.filter(p => typeof p === "string" && p.length), unsupported: [] };
  const paths = new Set(), unsupported = new Set();
  for (const u of profile?.units ?? []) {
    const lang = String(u.language ?? "").toLowerCase();
    for (const d of DEPENDENCY_PATHS[lang] ?? []) paths.add(u.root && u.root !== "." ? join(u.root, d) : d);
    if (!DEPENDENCY_PATHS[lang] && HOME_CACHED[lang]) unsupported.add(`${lang} (${HOME_CACHED[lang]})`);
  }
  return { paths: [...paths], unsupported: [...unsupported] };
}

/**
 * Can this filesystem clone files copy-on-write?
 *
 * `cp -c` fails on anything but APFS (and cross-volume), which is a fact about
 * the host, not an error: the caller falls back to a plain copy and pays the
 * space. Measured once per process against the directory that will actually be
 * copied, because the answer is per-volume.
 */
export function canCloneFiles(nearPath) {
  const probe = join(nearPath, `.reeve-cow-probe-${process.pid}`);
  const copy = `${probe}.copy`;
  try {
    writeFileSync(probe, "probe\n");
    execFileSync("cp", ["-c", probe, copy], { stdio: ["ignore", "ignore", "pipe"] });
    return true;
  } catch { return false; }
  finally { rmSync(probe, { force: true }); rmSync(copy, { force: true }); }
}

/**
 * Copy a dependency tree into the run's checkout, sharing blocks where the
 * filesystem allows it. Returns `{ ok, why, cow }`; `cow` says whether the cheap
 * path was taken, so the caller can report honestly rather than assume.
 */
export function copyDeps(from, to, { cow = null } = {}) {
  if (!existsSync(from)) return { ok: true, why: "nothing to copy", cow: false, skipped: true };
  const useCow = cow ?? canCloneFiles(from.replace(/\/[^/]+$/, "") || "/tmp");
  const args = useCow ? ["-Rc", from, to] : ["-R", from, to];
  try {
    execFileSync("cp", args, { stdio: ["ignore", "ignore", "pipe"] });
    return { ok: true, why: null, cow: useCow };
  } catch (e) {
    // A failed copy-on-write copy is retried as a plain one: the host may be
    // APFS while this particular pair of paths crosses volumes.
    if (!useCow) return { ok: false, why: `could not copy dependencies: ${String(e.stderr || e.message).trim()}`, cow: false };
    try { execFileSync("cp", ["-R", from, to], { stdio: ["ignore", "ignore", "pipe"] }); return { ok: true, why: null, cow: false }; }
    catch (e2) { return { ok: false, why: `could not copy dependencies: ${String(e2.stderr || e2.message).trim()}`, cow: false }; }
  }
}

/**
 * Would copying into `rel` write outside the checkout?
 *
 * Checked component by component, because it is the PARENTS that matter: a link
 * at `api` sends everything under it elsewhere, whatever `api/.venv` is. A
 * component that does not exist yet is fine -- it will be a real directory,
 * created here. Returns a reason, or null when the destination is safe.
 */
function escapesCheckout(root, rel) {
  const realRoot = (() => { try { return realpathSync(root); } catch { return root; } })();
  const parts = rel.split("/").filter(p => p && p !== ".");
  if (parts.includes("..")) return `dependency path ${rel} climbs out of the checkout`;
  let at = realRoot;
  for (const part of parts) {
    at = join(at, part);
    let st;
    try { st = lstatSync(at); } catch { return null; }        // not there yet: this call creates it
    if (st.isSymbolicLink()) return `dependency path ${rel} passes through a symlink (${part}), which would write outside the checkout`;
    const real = (() => { try { return realpathSync(at); } catch { return at; } })();
    if (real !== realRoot && !real.startsWith(realRoot + "/")) return `dependency path ${rel} resolves outside the checkout`;
  }
  return null;
}

/**
 * A standalone checkout for one run.
 *
 * `head` is the revision reeve pinned when it decided. The clone is made from
 * the founder's local checkout (fast, and no credential is needed) but it is
 * VERIFIED against that revision: a local clone can only be as current as the
 * last fetch, and a worker sent to fix a pull request must stand on the commit
 * the decision was made about, not on whatever the checkout happened to hold.
 */
export function prepareRunCheckout({ repoRoot, root, pr, runId, branch, head = null, depsFrom = null, cow = null }) {
  const path = runPathFor(root, pr, runId);
  if (existsSync(path)) return { ok: false, path, why: `a checkout already exists at ${path}` };
  mkdirSync(root, { recursive: true });

  // Fetch first, so the clone can see a head the local checkout has not yet
  // heard of. A clone of a stale checkout is the wrong code, silently.
  //
  // With an EXPLICIT refspec, because the remote-tracking ref is what the clone
  // below reads and a bare `git fetch origin <branch>` only updates it when the
  // remote carries the conventional refspec. Naming it makes the guarantee this
  // depends on the one git is actually given.
  const fetched = founderGit(repoRoot, ["fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  if (!fetched.ok) return { ok: false, path: null, why: `could not fetch ${branch}: ${fetched.err}` };

  // An EMPTY repository plus one fetched ref, not a clone.
  //
  // `git clone` copies every one of the source's branches and tags and the
  // objects behind them, so a local `private` branch in the founder's checkout
  // arrives as `origin/private` in the worker's — readable with the worker's own
  // unrestricted git grant, and copyable into an allowed path for reeve to
  // publish. Denying the founder's checkout by path does nothing about a copy of
  // its object database sitting inside the worker's own. (Codex #5-[17].)
  //
  // A single-ref fetch brings only what that revision reaches. It also removes
  // the earlier `--branch` problem entirely: nothing asks the source for a local
  // head that a pull request's branch does not have.
  // HEAD is put on a name that CANNOT be the target branch. `git init` leaves it
  // on the host's `init.defaultBranch`, and git refuses to fetch into a branch
  // that is checked out — so a pull request whose branch happened to carry that
  // name (`main` on most hosts) could not be prepared at all. Found by the
  // control beside the filter test, not by the case it was written for.
  // `git`, not `founderGit`, though its cwd is the founder's checkout: the
  // repository this CREATES is the worker's, and the founder's global
  // `init.templateDir` would otherwise install its hooks into it.
  const init = git(repoRoot, ["init", "-q", "-b", `${branch}.reeve-init`, "--", path]);
  if (!init.ok) { rmSync(path, { recursive: true, force: true }); return { ok: false, path: null, why: `could not create the checkout: ${init.err}` }; }
  // By the pinned REVISION where there is one, so the fetch cannot race a branch
  // that moves between the decision and the preparation.
  const want = head ?? `refs/remotes/origin/${branch}`;
  const fetchedRef = git(path, ["fetch", "--no-tags", "-q", "--no-write-fetch-head", repoRoot, `+${want}:refs/heads/${branch}`]);
  if (!fetchedRef.ok) { rmSync(path, { recursive: true, force: true }); return { ok: false, path: null, why: `could not fetch ${branch} into the checkout: ${fetchedRef.err}` }; }
  const onBranch = git(path, ["checkout", "-q", branch]);
  if (!onBranch.ok) { rmSync(path, { recursive: true, force: true }); return { ok: false, path: null, why: `could not check out ${branch}: ${onBranch.err}` }; }
  // origin is set so the checkout is a normal repository to work in; the push
  // URL below is what stops it publishing.
  git(path, ["remote", "add", "origin", repoRoot]);

  // The clone followed the local branch, which may lag the revision reeve
  // pinned; move it onto that revision explicitly and check it landed.
  if (head) {
    const at = git(path, ["reset", "--hard", "-q", head]);
    if (!at.ok) { rmSync(path, { recursive: true, force: true }); return { ok: false, path: null, why: `could not stand on ${head.slice(0, 10)}: ${at.err}` }; }
    const now = git(path, ["rev-parse", "HEAD"]);
    if (!now.ok || now.out !== head) { rmSync(path, { recursive: true, force: true }); return { ok: false, path: null, why: `checkout is at ${now.out || "?"}, not the pinned ${head.slice(0, 10)}` }; }
  }

  // A checkout filter the tree DECLARES but this environment cannot supply.
  //
  // Daemon git runs with no global or system configuration, which is what stops
  // a founder's filter driver executing on pull-request content — and it also
  // means Git LFS's driver, which `git lfs install` registers globally, is not
  // there. Git treats an undefined filter as PASS-THROUGH rather than an error,
  // so the checkout succeeds holding pointer files, and the worker then edits
  // and tests the wrong tree while everything reports success.
  //
  // Refused rather than reported, because a fixer working against unmaterialised
  // content produces a fix about a file it never saw. (Codex #7-[6].)
  const attrs = declaredFilters(path);
  if (attrs.why) {
    rmSync(path, { recursive: true, force: true });
    return { ok: false, path: null, why: attrs.why };
  }
  if (attrs.filters.length) {
    rmSync(path, { recursive: true, force: true });
    return { ok: false, path: null, why: `this tree declares checkout filter(s) reeve cannot supply (${attrs.filters.slice(0, 3).join(", ")}); ` +
      `daemon git runs with no global configuration, so the content would be left unmaterialised — a worker would edit pointer files` };
  }

  const h = hardenClone(path);
  if (!h.ok) { rmSync(path, { recursive: true, force: true }); return { ok: false, path: null, why: h.why }; }

  // `depsFrom` is a list of paths RELATIVE to the founder's checkout, copied to
  // the same place in the run's. A tree that is not there is not an error: a
  // project simply may not have one.
  let deps = { ok: true, cow: false, skipped: true, copied: [], untracked: [], why: "no dependency source given" };
  if (depsFrom?.length) {
    const copied = [];
    let anyCow = false;
    for (const rel of depsFrom) {
      const from = join(repoRoot, rel), to = join(path, rel);
      if (!existsSync(from)) continue;
      // The destination is inside PR-CONTROLLED content. A pull request can
      // commit a symlink where a unit root belongs, and both `mkdirSync` and
      // `cp -R` follow it -- so the copy lands wherever the link points, written
      // by the DAEMON, outside the checkout entirely. Every component is checked,
      // and the resolved destination must still be under the run's own path.
      // (Codex #5-[18].)
      const esc = escapesCheckout(path, rel);
      if (esc) { rmSync(path, { recursive: true, force: true }); return { ok: false, path: null, why: esc }; }
      mkdirSync(dirname(to), { recursive: true });
      const one = copyDeps(from, to, { cow });
      if (!one.ok) { rmSync(path, { recursive: true, force: true }); return { ok: false, path: null, why: one.why }; }
      if (!one.skipped) { copied.push(rel); anyCow = anyCow || one.cow; }
    }
    // What the DAEMON left untracked, recorded before the worker starts.
    //
    // Excluding the copied trees by PATH afterwards cannot tell reeve's own files
    // from the worker's: an undeclared new file inside a copied, unignored tree
    // was invisible to every exclusion shape tried, so an incomplete repair
    // published and the checkout carrying the omitted part was deleted. A
    // baseline is the only thing that distinguishes them, because it is the one
    // fact only reeve knows.
    //
    // Empty for the ordinary case, where a dependency tree is gitignored and
    // `--exclude-standard` never lists it. Bounded because an unignored tree can
    // be enormous, and a refusal that says so beats a list nobody reads.
    const listed = copied.length
      ? git(path, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...copied], { raw: true })
      : { ok: true, out: "" };
    if (!listed.ok) { rmSync(path, { recursive: true, force: true }); return { ok: false, path: null, why: `could not record what was copied in: ${listed.err}` }; }
    const untracked = listed.out ? listed.out.split("\0").filter(Boolean) : [];
    if (untracked.length > MAX_COPIED_UNTRACKED) {
      rmSync(path, { recursive: true, force: true });
      return { ok: false, path: null, why: `the dependency trees ${copied.join(", ")} put ${untracked.length} files into the checkout that git does not ignore, past the ${MAX_COPIED_UNTRACKED} reeve will track; ignore them or declare a narrower path` };
    }
    // Names alone cannot tell an untouched copy from one the worker EDITED: git
    // reports the same `?? vendor/dep.js` either way, so a pathname baseline
    // subtracts the modification and an incomplete repair publishes. The digest is
    // what distinguishes them, and it is only paid for in the unignored case --
    // a gitignored tree contributes no baseline at all.
    deps = { ok: true, cow: anyCow, skipped: copied.length === 0, copied,
             untracked: fingerprint(path, untracked), why: null };
  }

  return { ok: true, path, why: null, deps };
}

/**
 * Filter drivers this checkout's own .gitattributes files ask for.
 *
 * Read from the checked-out tree, and only the names: a driver reeve does not
 * provide cannot be run, and the point is to notice that rather than to run it.
 */
function declaredFilters(path) {
  const names = new Set();
  const listed = git(path, ["ls-files", "-z", "--", "*.gitattributes", ".gitattributes"]);
  const files = listed.ok ? listed.out.split("\0").filter(Boolean) : [];
  let budget = MAX_ATTRIBUTES_TOTAL;
  for (const rel of files) {
    // lstat before reading, and never on the strength of the listing alone.
    // This tree is PULL-REQUEST content, and `.gitattributes` can be committed
    // as a symlink -- mode 120000 -- which a clone materialises. Measured
    // 2026-08-22 on git 2.50.1: one pointing at /dev/zero was listed by
    // `ls-files` and killed the reading process outright (SIGKILL, exit 137),
    // so a pull request could take the daemon down before a worker was ever
    // launched. git itself refuses to follow these, warning "unable to access
    // '.gitattributes': Too many levels of symbolic links" -- so a tree that
    // relies on one is not getting the attributes it thinks it has either way.
    //
    // Nothing else writes this tree at this point: the clone is finished and
    // the worker has not started, so there is no window between the stat and
    // the read.
    let st;
    try { st = lstatSync(join(path, rel)); }
    catch { return { filters: [], why: `this tree's ${rel} cannot be examined, and an attributes file reeve cannot read may declare a filter it cannot supply` }; }
    if (!st.isFile())
      return { filters: [], why: `this tree commits ${rel} as a ${st.isSymbolicLink() ? "symbolic link" : "special file"} rather than a file, which reeve will not read` };
    if (st.size > MAX_ATTRIBUTES_BYTES)
      return { filters: [], why: `this tree's ${rel} is ${st.size} bytes, past the ${MAX_ATTRIBUTES_BYTES} reeve will read of an attributes file` };
    budget -= st.size;
    if (budget < 0)
      return { filters: [], why: `this tree's attributes files total more than the ${MAX_ATTRIBUTES_TOTAL} bytes reeve will read of them` };

    let text;
    try { text = readFileSync(join(path, rel), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      for (const m of t.matchAll(/(?:^|\s)filter=([^\s]+)/g)) names.add(m[1]);
    }
  }
  return { filters: [...names], why: null };
}

/**
 * The same two physical layers a linked worktree carried, applied to a clone:
 * a push URL git cannot resolve, and a hook that refuses every push. They are
 * belt and braces here rather than the boundary — the clone shares nothing, and
 * the OS sandbox denies the network — but a layer that costs nothing to keep is
 * kept.
 */
function hardenClone(path) {
  const pu = git(path, ["config", "--local", "remote.origin.pushurl", "reeve://refused-the-worker-does-not-publish"]);
  if (!pu.ok) return { ok: false, why: `pushurl: ${pu.err}` };
  const hooks = `${path}.hooks`;
  try {
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-push"), REFUSING_HOOK);
    chmodSync(join(hooks, "pre-push"), 0o755);
  } catch (e) { return { ok: false, why: `could not write the refusing hook: ${e.message}` }; }
  const hp = git(path, ["config", "--local", "core.hooksPath", hooks]);
  if (!hp.ok) return { ok: false, why: `hooksPath: ${hp.err}` };

  // Read back rather than trust the writes, and only then record the baseline
  // the config check compares against.
  const readPu = git(path, ["config", "--local", "remote.origin.pushurl"]);
  const readHp = git(path, ["config", "--local", "core.hooksPath"]);
  if (!readPu.ok || readPu.out !== "reeve://refused-the-worker-does-not-publish") return { ok: false, why: "pushurl did not read back" };
  if (!readHp.ok || readHp.out !== hooks || !existsSync(join(hooks, "pre-push"))) return { ok: false, why: "hooksPath or hook did not read back" };
  if ((statSync(join(hooks, "pre-push")).mode & 0o111) === 0) return { ok: false, why: "the hook is not executable" };
  if (!recordConfig(path)) return { ok: false, why: "the checkout's git configuration could not be recorded" };
  return { ok: true, why: null };
}

/**
 * Take the worker's commits OUT of its checkout without running git inside it.
 *
 * The clone is disposable, so nothing there is worth preserving — but the work
 * is, and it only exists in the clone. reeve FETCHES it into its own checkout
 * (a fetch reads the other repository's objects; it runs no hook and no filter
 * of theirs) and publishes from there, exactly as before: the worker is never
 * the party that publishes.
 */
export function fetchRunWork({ repoRoot, path, branch, into = null }) {
  const ref = into ?? `refs/reeve/run/${branch}`;
  // `git`, not `founderGit`, though the repository is the founder's: the SOURCE
  // is a local path, so this needs neither their credentials nor their URL
  // rewrites — and a founder who has hardened git with `protocol.file.allow=never`
  // would otherwise have every valid fix refused before it could be pushed.
  // Measured 2026-08-22 on git 2.50.1: with that key in the global config the
  // same fetch fails `fatal: transport 'file' not allowed`, and succeeds under
  // the isolation. (Codex #10-[1].)
  const f = git(repoRoot, ["fetch", "--no-tags", "-q", path, `+${branch}:${ref}`]);
  if (!f.ok) return { ok: false, ref: null, why: `could not fetch the worker's branch: ${f.err}` };
  const at = git(repoRoot, ["rev-parse", ref]);
  if (!at.ok) return { ok: false, ref: null, why: `fetched but ${ref} does not resolve` };
  return { ok: true, ref, head: at.out, why: null };
}

/**
 * Publish the worker's work, from REEVE's checkout, never the worker's.
 *
 * The commits exist only in the run's clone, so they are fetched into reeve's
 * own repository first (a fetch reads the other repository's objects and runs
 * none of its hooks or filters) and pushed from there. The separation the
 * linked worktree gave by sharing a ref store is kept by moving the objects
 * explicitly: the worker still holds no credential and still cannot push.
 */
export function publishRunWork({ repoRoot, path, branch, expectedRemote = null }) {
  if (expectedRemote) {
    const ls = founderGit(repoRoot, ["ls-remote", "origin", `refs/heads/${branch}`]);
    if (!ls.ok) return { ok: false, why: `could not read the remote head: ${ls.err}` };
    const now = ls.out.split(/\s+/)[0] ?? "";
    // An EMPTY result is not "unchanged": `git ls-remote` exits 0 and prints
    // nothing when the ref is gone, so a branch the contributor deleted while
    // the worker ran read as a match, and the push RECREATED it. Only
    // `--exit-code` makes an unmatched ref nonzero, and reading the output is
    // clearer than relying on that. (Codex #5-[15].)
    if (!now) return { ok: false, why: `${branch} no longer exists on the remote; publishing would recreate a branch someone deleted` };
    if (now !== expectedRemote)
      return { ok: false, why: `the remote moved while the worker ran: expected ${expectedRemote.slice(0, 10)}, found ${now.slice(0, 10)}` };
  }
  const fetched = fetchRunWork({ repoRoot, path, branch });
  if (!fetched.ok) return { ok: false, why: fetched.why };
  // A push of a ref that already equals the remote head succeeds and moves
  // nothing. Reporting that as a publish is how "published 3 file(s)" gets
  // logged for a worker that committed nothing at all.
  if (expectedRemote && fetched.head === expectedRemote)
    return { ok: false, why: "the worker committed nothing: the branch is exactly where it was" };
  // The ls-remote above is a look, not a lock: the branch can be deleted or moved
  // between it and the push, and an ordinary push would then RECREATE a deleted
  // branch or land on a head nobody checked. The remote is asked to verify the
  // expectation itself, atomically. (Codex #7-[7].)
  //
  // A lease is not a licence to rewrite. `--force-with-lease` would happily
  // replace a matching remote with an unrelated history, which is exactly what
  // "never force" exists to prevent — so the push is refused first unless the
  // work DESCENDS from what is being replaced. The lease then adds atomicity to
  // a push that was already a fast-forward.
  if (expectedRemote) {
    const ff = git(repoRoot, ["merge-base", "--is-ancestor", expectedRemote, fetched.ref]);
    if (!ff.ok) return { ok: false, why: `the worker's branch does not descend from ${expectedRemote.slice(0, 10)}; reeve does not rewrite published history` };
    const leased = founderGit(repoRoot, ["push", `--force-with-lease=refs/heads/${branch}:${expectedRemote}`,
                                       "origin", `${fetched.ref}:refs/heads/${branch}`]);
    if (!leased.ok) return { ok: false, why: `push refused: ${leased.err}` };
    return { ok: true, why: null, head: fetched.head };
  }
  // Never force: a worker's fix is not worth another party's commit.
  const pushed = founderGit(repoRoot, ["push", "origin", `${fetched.ref}:refs/heads/${branch}`]);
  if (!pushed.ok) return { ok: false, why: `push refused: ${pushed.err}` };
  return { ok: true, why: null, head: fetched.head };
}

/**
 * The identity reeve commits under.
 *
 * A worker checkout runs with GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM at
 * /dev/null, so git has no configured identity there and invents one from the
 * username and the hostname -- measured 2026-08-23: `Mobeen <mobeen@192.168.1.18>`.
 * That address is not routable, links to no account, and a ruleset requiring a
 * verified committer refuses it. reeve pushes as the founder, so it commits as
 * the founder, read from the founder's own repository where that configuration
 * is deliberately still visible.
 *
 * Null when either half is missing, rather than half an identity: git would
 * invent the other half and the commit would carry a plausible address nobody
 * owns.
 */
export function founderIdentity(repoRoot) {
  const read = key => {
    const r = founderGit(repoRoot, ["config", "--get", key]);
    return r.ok && r.out ? r.out : null;
  };
  const name = read("user.name");
  const email = read("user.email");
  return name && email ? { name, email } : null;
}

/**
 * Stage and commit what the worker changed.
 *
 * The worker cannot do this itself. Its sandbox denies Bash writes to `.git`, so
 * `git add` and `git commit` fail with EPERM on `.git/index.lock`: measured
 * 2026-08-23 across seven attempts in one run, which then spent thirteen of its
 * thirty-six turns correctly diagnosing an instruction it could not carry out.
 * Nothing published, three runs of three, with a correct fix sitting in the
 * working tree each time (docs/measured/2026-08-23-three-real-dispatches.md).
 *
 * Moving the commit here is the answer already applied to the PUSH, one step
 * earlier in the same sequence: the party that decides what may ship is the party
 * that writes it. The worker is now unable to touch git's state at all.
 *
 * What gets staged is exactly what the worker declared in `filesTouched`, and
 * nothing is JUDGED here. The diff gate runs after this, against the ref that
 * gets pushed, so what may ship is still decided where it was always decided.
 */
/**
 * Why reeve will not stage this declared path, or null if it will.
 *
 * git rejects an escaping pathspec itself, but the refusal a worker sees should
 * be reeve's and should name the rule, and `.git` is worth refusing here rather
 * than relying on `add` to decline it. Nothing is normalised away beyond a
 * leading `./`: leading and trailing whitespace are legal in a git filename.
 */
function badDeclaredPath(f) {
  if (typeof f !== "string" || !f.length) return `${JSON.stringify(f)} is not a filename`;
  const rel = f.replace(/^\.\//, "");
  if (rel.startsWith("/")) return `${rel} is absolute`;
  if (rel.split("/").includes("..")) return `${rel} climbs out of the checkout`;
  if (rel === ".git" || rel.startsWith(".git/")) return `${rel} is git's own state`;
  return null;
}

/**
 * A path -> content digest map, for telling a file reeve put somewhere from the
 * same file after a worker has edited it.
 *
 * Hashed in-process rather than through `git hash-object --stdin-paths`, which
 * takes NEWLINE-separated paths and would break on a filename containing one --
 * a shape this codebase has already been bitten by once.
 *
 * An unreadable file is recorded as null, which never equals a later digest, so
 * it reads as changed and fails closed.
 */
export function fingerprint(root, paths) {
  const out = {};
  for (const rel of paths) out[rel] = digestOf(join(root, rel));
  return out;
}

/**
 * The digest of one REGULAR file within a bounded size, or null.
 *
 * `lstat`, not `stat`, and a size ceiling: this runs in the DAEMON, unsandboxed,
 * over paths a worker controls. A copied file replaced with a symlink to
 * `/dev/zero` would be followed and read forever; one pointed at a huge host file
 * would exhaust memory before the catch could run. Neither is reachable if only a
 * bounded regular file is ever opened.
 *
 * Anything else -- a symlink, a device, a directory, an oversized file, an
 * unreadable one -- returns null, which never equals a recorded digest, so it
 * reads as CHANGED and the work is held rather than published.
 */
export function digestOf(abs) {
  try {
    const st = lstatSync(abs);
    if (!st.isFile() || st.size > MAX_FINGERPRINT_BYTES) return null;
    return createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch { return null; }
}

export function commitRunWork({ repoRoot, path, branch, message, secrets = [], declared = [] }) {
  if (!String(message ?? "").trim()) return { ok: false, why: "no commit message was given" };

  // The message is built from the worker's report, which is model output that has
  // read untrusted CI logs. The publication gate scans commit messages for these
  // values too, but only after the commit exists -- and a secret in git history is
  // not undone by refusing the push. Checked here so the commit is never made.
  const leaked = secrets.find(s => typeof s?.value === "string" && s.value.length >= 16 && message.includes(s.value));
  if (leaked) return { ok: false, why: `the commit message reeve derived carries ${leaked.label}` };

  // The commit has to land on the branch that gets published. A worker that
  // checked out something else would otherwise have its work committed where
  // nothing looks for it, while the push carried the pinned head.
  //
  // A mismatch is a SKIP, not a failure. Refusing outright here would return
  // before the gates below, and one of them reads the pushed ref for reeve's own
  // worker token: a worker that commits a credential on the branch and then
  // checks out another would have been reported as "wrong branch" rather than as
  // carrying a token. Not committing is enough -- the gates still judge the ref,
  // and the uncommitted-work check still refuses anything that would be lost.
  //
  // `branch --show-current` because it is the only one of the three that answers
  // for every state of HEAD: it prints the branch on an unborn one, prints the
  // branch normally, and prints NOTHING while exiting zero when detached.
  // `symbolic-ref --quiet` exits nonzero when detached and `rev-parse
  // --abbrev-ref` exits nonzero when unborn -- both of which read as an
  // unreadable repository and take the hard-failure return, which happens BEFORE
  // the gate that scans the pushed ref for reeve's own token.
  const on = git(path, ["branch", "--show-current"]);
  if (!on.ok) return { ok: false, why: `could not read the checked-out branch: ${on.err}` };
  if (on.out !== branch)
    return { ok: true, committed: false, files: [], why: `not committing: the checkout is on ${on.out || "a detached head"}, not ${branch}` };

  // reeve stages EXACTLY what the worker declared, and nothing else.
  //
  // The previous design staged by heuristic -- `git add --all` minus the
  // dependency trees preparation had copied in -- and produced three separate
  // defects in three review rounds: a tree excluded from staging still made the
  // checkout dirty; a TRACKED file inside such a tree had its edit silently
  // dropped; and a NEW file inside one was dropped while the rest published as if
  // complete. Each fix was another exclusion rule, which is the shape that says
  // the design is wrong rather than the instances.
  //
  // Only the worker can say which of its files were the repair and which were a
  // reproduction script, so the declaration is the INSTRUCTION here rather than a
  // cross-check applied afterwards. That removes every special case at once: a
  // path inside a copied tree stages because it was declared, and a scratch file
  // does not because it was not.
  const bad = declared.map(badDeclaredPath).filter(Boolean);
  if (bad.length) return { ok: false, why: `the worker declared ${bad.length} path(s) reeve will not stage: ${bad.slice(0, 5).join("; ")}` };
  const wanted = [...new Set(declared.map(f => f.replace(/^\.\//, "")))];
  // Nothing declared is not an error: the gates below judge whatever the branch
  // already holds, and a worker that committed nothing has changed nothing.
  if (!wanted.length) return { ok: true, why: null, committed: false, files: [] };

  // `--force`, because a declared path may sit inside an ignored or copied tree,
  // and the worker saying it is part of the repair outranks the ignore rule. The
  // diff gate still judges the result.
  //
  // Through stdin rather than argv: a repository-sized repair overruns ARG_MAX,
  // and `--pathspec-from-file=-` with `--pathspec-file-nul` is git's own answer
  // for a list of arbitrary length holding arbitrary bytes.
  // `--literal-pathspecs` BEFORE the subcommand, because a filename may begin with
  // `:` and git would read the entry as pathspec magic rather than as a name --
  // measured, a real file called `:x` was rejected with "did not match any files"
  // and every repair touching one would have been refused.
  const added = git(path, ["--literal-pathspecs", "add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"],
                    { input: wanted.join("\0") + "\0" });
  if (!added.ok) return { ok: false, why: `could not stage the declared work: ${added.err}` };

  // `-z` and RAW, because git quotes a path it considers unusual -- `kéy.txt`
  // comes back as `"k\303\251y.txt"` from `--name-only` -- and because trimming
  // the output would eat a leading space that is part of the filename.
  // `--no-renames`, because rename detection reports only the DESTINATION: a
  // repair that renames a file and correctly declares both sides had the source
  // read as never-changed, and the bidirectional check refused it. Both
  // filesystem paths the worker touched have to be visible to be compared.
  const staged = git(path, ["diff", "--cached", "--name-only", "--no-renames", "-z"], { raw: true });
  if (!staged.ok) return { ok: false, why: `could not read what was staged: ${staged.err}` };
  const files = staged.out ? staged.out.split("\0").filter(Boolean) : [];

  // BOTH directions, and the index is reset on either so a human gets the
  // checkout exactly as the worker left it.
  //
  // Declared-but-unstaged is the one that used to lose work: a declared path with
  // no change means the worker mis-reported or something dropped it, and
  // publishing the remainder as a complete repair is how the omitted part goes in
  // the bin with the checkout. Staged-but-undeclared cannot happen now by
  // construction, and is asserted rather than assumed.
  const have = new Set(files), said = new Set(wanted);
  const missing = wanted.filter(f => !have.has(f));
  const extra = files.filter(f => !said.has(f));
  if (missing.length || extra.length) {
    git(path, ["reset", "--quiet", "HEAD", "--"]);
    return { ok: false, why: missing.length
      ? `the worker reported ${missing.length} file(s) that are not changed in the checkout: ${missing.slice(0, 5).join(", ")}`
      : `staging produced ${extra.length} file(s) the worker did not report: ${extra.slice(0, 5).join(", ")}` };
  }

  const id = founderIdentity(repoRoot);
  if (!id) return { ok: false, why: "the founder's git identity is not configured, so a commit would carry an address nobody owns" };

  // As ENVIRONMENT, not as `-c user.*`. Git gives GIT_AUTHOR_* and GIT_COMMITTER_*
  // precedence over configuration, and `gitEnv()` passes the daemon's own
  // environment through: measured, `GIT_AUTHOR_NAME=Injected` beside
  // `-c user.name=Founder` produces `Injected`. A daemon launched from a wrapper
  // that exports them would have attributed every repair to that identity, and a
  // ruleset requiring a verified committer would refuse the push.
  const done = run(path, GIT_NEUTRALISE, ["commit", "--quiet", "-m", message], gitEnv({
    GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email,
    GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email,
  }));
  if (!done.ok) return { ok: false, why: `commit refused: ${done.err}` };

  const head = git(path, ["rev-parse", "HEAD"]);
  if (!head.ok) return { ok: false, why: `committed, but the new head could not be read: ${head.err}` };
  return { ok: true, why: null, committed: true, files, head: head.out };
}

/**
 * Remove a run's checkout. A standalone clone holds nothing reeve has not
 * already fetched, so this is a deletion rather than the worktree reaper's
 * careful quarantine — but it refuses when the caller has not confirmed the
 * work was taken out, so a deletion can never be the thing that loses it.
 */
export function releaseRunCheckout(path, { workFetched = false, quarantineRoot = null } = {}) {
  if (!existsSync(path)) return { ok: true, why: "already gone", quarantined: false };
  if (!workFetched) {
    const q = quarantineRoot ?? `${path}.unfetched`;
    try { execFileSync("mv", [path, q]); return { ok: true, why: "kept: the worker's commits were never fetched", quarantined: true, path: q }; }
    catch (e) { return { ok: false, why: `could not preserve the checkout: ${e.message}`, quarantined: false }; }
  }
  rmSync(path, { recursive: true, force: true });
  rmSync(`${path}.hooks`, { recursive: true, force: true });
  rmSync(`${path}.cfg`, { force: true });
  return { ok: true, why: null, quarantined: false };
}
