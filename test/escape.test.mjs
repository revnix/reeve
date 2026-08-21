// Can a worker publish, or read the founder's credentials, from inside the
// contract this stage ships? Measured, shape by shape, under exactly the
// environment `runWorker` hands a worker.
//
// Two kinds of assertion live here and they must never be confused:
//
//   HELD        the layer stops the shape today, and the assertion says so.
//   KNOWN-OPEN  the shape WORKS today. The assertion says it works, so that the
//               stage which closes it (the OS sandbox's write and network deny,
//               or a dedicated worker user) turns this test red and must
//               rewrite the line. A hole that is written down as a hole cannot
//               be forgotten; a hole that a green suite cannot see can.
//
// Never print what a credential probe returns: presence is the only thing read.
import { acquireWorktree } from "../src/worktree.mjs";
import { workerEnv, writeGitConfig, CONTAINMENT } from "../src/workerenv.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0, skipped = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const skip = (name, why) => { console.log(`SKIP  ${name} (${why})`); skipped++; };

// ── fixture: origin, clone, a worker's worktree, and a second destination ─────
const root = mkdtempSync(join(tmpdir(), "reeve-escape-"));
const sh = (cwd, cmd, args, env = process.env) => spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
const git = (cwd, ...args) => { const r = sh(cwd, "git", args); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };

const origin = join(root, "origin.git"); git(root, "init", "--bare", "-q", origin);
const clone = join(root, "clone"); git(root, "clone", "-q", origin, clone);
git(clone, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
git(clone, "push", "-q", "origin", "HEAD:main");
git(clone, "checkout", "-q", "-b", "feature"); git(clone, "push", "-q", "origin", "feature");
const head = git(clone, "rev-parse", "HEAD");
git(clone, "checkout", "-q", "main");   // the clone keeps main; the worker's worktree takes the branch
const wt = acquireWorktree({ repoRoot: clone, root: join(root, "wts"), pr: 1, branch: "feature", head });
check(wt.ok, "control: a worker worktree exists", JSON.stringify(wt));
writeFileSync(join(wt.path, "change.txt"), "from the worker\n");
git(wt.path, "add", "-A"); git(wt.path, "-c", "user.email=w@w", "-c", "user.name=w", "commit", "-q", "-m", "worker change");
const dest = join(root, "dest.git"); git(root, "init", "--bare", "-q", dest);

const env = workerEnv({ gitConfigPath: writeGitConfig(join(root, "git")), tmpDir: join(root, "tmp"), bgWaitMs: 1 });
const refsAt = bare => git(bare, "for-each-ref", "--format=%(refname)");
const push = (args) => sh(wt.path, "git", args, env);

// ── publishing shapes ────────────────────────────────────────────────────────
{
  const r = push(["push", "origin", "HEAD:refs/heads/escape-origin"]);
  check(r.status !== 0 && !refsAt(origin).includes("escape-origin"), "HELD: a push to origin is refused by the bogus pushurl", r.stderr.slice(0, 120));
}
{
  const r = push(["push", dest, "HEAD:refs/heads/escape-url"]);
  check(r.status !== 0 && /does not publish/.test(r.stderr) && !refsAt(dest).includes("escape-url"),
    "HELD: a push to an explicit URL is refused by the worktree hook", r.stderr.slice(0, 120));
}
{
  const r = push(["push", "--no-verify", dest, "HEAD:refs/heads/escape-noverify"]);
  check(r.status === 0 && refsAt(dest).includes("refs/heads/escape-noverify"),
    "KNOWN-OPEN: `git push --no-verify <url>` bypasses the hook (closes when the sandbox denies writes outside the worktree and network)", r.stderr.slice(0, 120));
}
{
  const r = push(["-c", "core.hooksPath=/dev/null", "push", dest, "HEAD:refs/heads/escape-hookspath"]);
  check(r.status === 0 && refsAt(dest).includes("refs/heads/escape-hookspath"),
    "KNOWN-OPEN: `git -c core.hooksPath=/dev/null push <url>` bypasses the hook (same closure)", r.stderr.slice(0, 120));
}
{
  // The clone's ref store is shared with the worktree: a worker can move any
  // branch in it without a network or a credential.
  const r = push(["update-ref", "refs/heads/main", "HEAD"]);
  check(r.status === 0 && git(clone, "rev-parse", "refs/heads/main") === git(wt.path, "rev-parse", "HEAD"),
    "KNOWN-OPEN: a worker can move the clone's own branches through the shared ref store (closes with the controller-created commit and a per-run clone)", r.stderr.slice(0, 120));
}

// ── credential shapes ────────────────────────────────────────────────────────
{
  const r = sh(wt.path, "gh", ["auth", "token"], env);
  check(r.status !== 0 && /refused/.test(r.stderr), "HELD: a bare `gh` on the worker PATH is the refusing shim", r.stderr.slice(0, 120));
}
const loggedIn = sh(root, "gh", ["auth", "status"]).status === 0;
if (!loggedIn) {
  skip("KNOWN-OPEN: `git -c credential.helper=... credential fill` returns the founder's token", "no gh login on this host; cannot measure");
  skip("KNOWN-OPEN: an absolute-path `gh auth token` returns the founder's token", "no gh login on this host; cannot measure");
} else {
  const helper = process.platform === "darwin" ? "osxkeychain" : "!gh auth git-credential";
  const r = spawnSync("git", ["-c", `credential.helper=${helper}`, "credential", "fill"], { cwd: wt.path, env, encoding: "utf8", input: "protocol=https\nhost=github.com\n\n" });
  const got = r.status === 0 && /^password=.+/m.test(r.stdout);
  check(got, "KNOWN-OPEN: `git -c credential.helper=... credential fill` returns the founder's token under the worker env (closes when the sandbox denies the keychain and ~/.config/gh, or a worker user exists)", `status=${r.status}`);
  const ghAbs = sh(root, "which", ["gh"]).stdout.trim();
  const r2 = spawnSync(ghAbs, ["auth", "token"], { cwd: wt.path, env, encoding: "utf8" });
  check(r2.status === 0 && r2.stdout.trim().length > 20, "KNOWN-OPEN: an absolute-path `gh auth token` returns the founder's token under the worker env (same closure)", `status=${r2.status}`);
}

// ── the declaration the daemon reads must agree with what was measured ──────
check(CONTAINMENT.credentialRead === "open", "control: the module declares the credential read open, as measured above", JSON.stringify(CONTAINMENT));

rmSync(root, { recursive: true, force: true });
console.log(`${fail ? `\nfailed=${fail}` : "\nall green"}${skipped ? ` (skipped ${skipped}: not measurable on this host)` : ""}`);
process.exit(fail ? 1 : 0);
