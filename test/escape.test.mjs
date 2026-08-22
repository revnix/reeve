// Can a worker publish, or read the founder's credentials, from inside the
// contract? Measured, shape by shape, twice: under the ENVIRONMENT alone (what
// runWorker hands a worker, no OS sandbox), and UNDER THE SANDBOX the settings
// ask for (the same Seatbelt profile generator the CLI bundles, driven by
// `srt`, no model in the loop).
//
// Two kinds of assertion live here and they must never be confused:
//
//   HELD        the layer stops the shape, and the assertion says so.
//   KNOWN-OPEN  the shape WORKS. The assertion says it works, so that the
//               change which closes it turns this test red and must rewrite
//               the line. A hole that is written down as a hole cannot be
//               forgotten; a hole that a green suite cannot see can.
//
// The sandboxed section is mandatory on macOS, the only measured platform
// (docs/measured/2026-08-22-claude-print-mode.md); elsewhere it is SKIPPED
// with a count, never silently green. The daemon's own canary (canary.mjs)
// is the runtime proof under the real CLI; this file is the development-time
// proof under the runtime, and both read files, never a worker's word.
//
// Never print what a credential probe returns: presence is the only thing read.
import { REFUSING_HOOK } from "../src/gitguard.mjs";
import { workerEnv, writeGitConfig, CONTAINMENT } from "../src/workerenv.mjs";
import { sandboxFor } from "../src/sandbox.mjs";
import { probeKeychain } from "../src/containment.mjs";
import { netListener } from "../src/canary.mjs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

// A worker never gets the founder's HOME (that is where the keychain lives) and
// authenticates from a token instead of ~/.claude.
const WORKER_HOME = mkdtempSync(join(tmpdir(), "reeve-worker-home-"));
const FAKE_TOKEN = "sk-ant-oat01-test-token-not-a-real-credential-000000000000";

let fail = 0, skipped = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const skip = (name, why) => { console.log(`SKIP  ${name} (${why})`); skipped++; };

// ── fixture: origin, clone, a worker's worktree, a standalone clone, a destination
//
// Under the founder's HOME, not the system tmp: the sandbox's own write scope
// includes temp areas, and a fixture placed there measured nothing (same doc).
const root = join(homedir(), ".cache", "reeve-tests", `escape-${process.pid}`);
rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
const sh = (cwd, cmd, args, env = process.env, input) => spawnSync(cmd, args, { cwd, env, encoding: "utf8", input });
const git = (cwd, ...args) => { const r = sh(cwd, "git", args); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };

const origin = join(root, "origin.git"); git(root, "init", "--bare", "-q", origin);
const clone = join(root, "clone"); git(root, "clone", "-q", origin, clone);
git(clone, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
git(clone, "push", "-q", "origin", "HEAD:main");
git(clone, "checkout", "-q", "-b", "feature"); git(clone, "push", "-q", "origin", "feature");
const head = git(clone, "rev-parse", "HEAD");
git(clone, "checkout", "-q", "main");   // the clone keeps main; the worker's worktree takes the branch
// The LINKED worktree below is built here rather than by production code: reeve
// no longer makes them, and the point of keeping the shape is to compare it with
// the standalone clone that replaced it. Both hardening layers it used to carry
// are reproduced, because two assertions measure what they stop.
const makeLinkedWorktree = () => {
  const path = join(root, "wts", "pr-1");
  mkdirSync(dirname(path), { recursive: true });
  git(clone, "worktree", "add", "--force", "-B", "feature", path, "origin/feature");
  git(clone, "config", "extensions.worktreeConfig", "true");
  git(path, "config", "--worktree", "remote.origin.pushurl", "reeve://refused-the-worker-does-not-publish");
  const hooks = `${path}.hooks`;
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-push"), REFUSING_HOOK, { mode: 0o755 });
  chmodSync(join(hooks, "pre-push"), 0o755);
  git(path, "config", "--worktree", "core.hooksPath", hooks);
  return { ok: existsSync(join(path, ".git")) && existsSync(join(hooks, "pre-push")), path };
};
const wt = makeLinkedWorktree();
check(wt.ok, "control: a worker worktree exists, with both layers reeve used to give it", JSON.stringify(wt));
writeFileSync(join(wt.path, "change.txt"), "from the worker\n");
git(wt.path, "add", "-A"); git(wt.path, "-c", "user.email=w@w", "-c", "user.name=w", "commit", "-q", "-m", "worker change");
// The founder's uncommitted work and an ignored secret, in the checkout a run
// clone is made FROM. The clone carries neither, by construction -- but the
// original files are still on this disk, and the probe below is what says
// whether a worker can walk to them.
const founderWip = join(clone, "WIP.txt"); writeFileSync(founderWip, "the founder unfinished work\n");
const founderEnv = join(clone, ".env"); writeFileSync(founderEnv, "SECRET=hunter2\n");
const dest = join(root, "dest.git"); git(root, "init", "--bare", "-q", dest);
const standalone = join(root, "standalone"); git(root, "clone", "-q", origin, standalone); git(standalone, "checkout", "-q", "feature");

const tmpDir = join(root, "tmp"); mkdirSync(tmpDir, { recursive: true });
const env = workerEnv({ home: WORKER_HOME, oauthToken: FAKE_TOKEN, gitConfigPath: writeGitConfig(join(root, "git")), tmpDir, bgWaitMs: 1 });
const refsAt = bare => git(bare, "for-each-ref", "--format=%(refname)");
const push = (args) => sh(wt.path, "git", args, env);

// ══ ENVIRONMENT ONLY ══════════════════════════════════════════════════════════
console.log("── environment only (no OS sandbox)");
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
    "KNOWN-OPEN (env only): `git push --no-verify <url>` bypasses the hook; the sandbox closes it below", r.stderr.slice(0, 120));
  git(dest, "update-ref", "-d", "refs/heads/escape-noverify");
}
{
  const r = push(["-c", "core.hooksPath=/dev/null", "push", dest, "HEAD:refs/heads/escape-hookspath"]);
  check(r.status === 0 && refsAt(dest).includes("refs/heads/escape-hookspath"),
    "KNOWN-OPEN (env only): `git -c core.hooksPath=/dev/null push <url>` bypasses the hook; the sandbox closes it below", r.stderr.slice(0, 120));
  git(dest, "update-ref", "-d", "refs/heads/escape-hookspath");
}
{
  const r = sh(wt.path, "gh", ["auth", "token"], env);
  check(r.status !== 0 && /refused/.test(r.stderr), "HELD: a bare `gh` on the worker PATH is the refusing shim", r.stderr.slice(0, 120));
}

// ══ UNDER THE SANDBOX ═════════════════════════════════════════════════════════
console.log("── under the OS sandbox (the runtime's own profile, via srt)");
let srt = null;
try { srt = join(dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime")), "cli.js"); } catch { srt = null; }

if (process.platform !== "darwin") {
  skip("every sandboxed shape", `the OS sandbox is measured on macOS only; this is ${process.platform}`);
} else if (!srt || !existsSync(srt)) {
  check(false, "the sandbox runtime is installed (npm install; it is a devDependency, and on macOS the sandboxed shapes are mandatory)", "srt not resolvable");
} else {
  // The block every worker gets, turned into the runtime's own settings
  // shape. The CLI adds cwd to the write scope implicitly; srt adds nothing,
  // so cwd (and, where noted, what the CLI was measured to add) is listed.
  // Two policies, from the real generator. The LINKED one is built from a
  // profile that names no clone, because that is the arrangement it documents:
  // reeve had no source-checkout deny then, and adding one here would make the
  // shared-ref shape look closed for a reason that did not exist. The STANDALONE
  // one names the clone, so its denyRead is generated rather than hand-written
  // -- the assertions below then measure the generator AND the OS together.
  const policyFor = (profile, worktree) => sandboxFor({ profile, action: "FIX_CI", worktree, tmpDir }).settings.sandbox;
  const policy = policyFor({ units: [] }, wt.path);
  const policyStandalone = policyFor({ units: [], identity: { checkout: clone } }, standalone);
  const settingsFor = (cwd, extraWrite = [], pol = policy) => {
    const p = join(root, `srt-${extraWrite.length ? "wide" : "cwd"}-${cwd.split("/").pop()}.json`);
    writeFileSync(p, JSON.stringify({
      network: { allowedDomains: pol.network.allowedDomains, deniedDomains: [], allowUnixSockets: [], allowLocalBinding: false },
      filesystem: { allowWrite: [cwd, tmpDir, ...extraWrite], denyWrite: [], allowRead: [tmpDir], denyRead: [...pol.filesystem.denyRead, fileDecoy] },
    }));
    return p;
  };
  // A decoy under a deny-read path stands in for every file credential; its
  // content is not a secret and is never printed.
  const decoy = join(homedir(), ".reeve", "canary", `escape-decoy-${process.pid}.txt`);
  mkdirSync(dirname(decoy), { recursive: true }); writeFileSync(decoy, "decoy\n");
  const outside = join(root, "outside"); mkdirSync(outside, { recursive: true });
  // Production denies whole directories AND individual files (the log, the
  // database, ~/.gitconfig, notify.credentialFile). This pair proves the second
  // kind holds, with its own control beside it.
  const fileDecoy = join(outside, "FILE-DECOY.txt"), fileControl = join(outside, "FILE-CONTROL.txt");
  writeFileSync(fileDecoy, "secret\n"); writeFileSync(fileControl, "readable\n");
  // Two git configs to prove Codex #4-[8]: one under the deny-read tree (where
  // the daemon USED to put it), one in the run's readable tmp (where it puts it
  // now). Both are created OUTSIDE the sandbox; the sandboxed git can reach only
  // the second.
  // Git's `store` helper writes tokens here under the XDG layout; the deny must
  // cover it, so a decoy of our own goes there and is removed afterwards.
  const xdgDecoy = join(homedir(), ".config", "git", `reeve-escape-probe-${process.pid}`);
  mkdirSync(dirname(xdgDecoy), { recursive: true }); writeFileSync(xdgDecoy, "decoy\n");
  const deniedCfg = join(homedir(), ".reeve", "canary", `escape-cfg-${process.pid}`);
  writeFileSync(deniedCfg, "[user]\n\temail = x@x\n");
  writeFileSync(join(tmpDir, "gitconfig"), "[user]\n\temail = x@x\n");
  const gh = sh(root, "which", ["gh"]).stdout.trim();
  // The daemon's network positive control: a local listener the sandboxed curl
  // must NOT reach. Proven against the REAL sandbox here.
  const listener = netListener(); await listener.ready;
  const netUrl = listener.url;
  // gh auth token resolves the ACTIVE account's token, so the crafted config
  // must name the real account, and the keyring item is stored under it. The
  // account is metadata, not the secret (no -w/-g); read it so the probe
  // reproduces the hole on any host without a username baked into this file.
  const acct = (() => { const r = sh(root, "security", ["find-internet-password", "-s", "github.com"]); const m = /"acct"<blob>="([^"]+)"/.exec(r.stdout ?? ""); return m ? m[1] : null; })();
  const script = (cwd) => `#!/bin/sh
out="./probe-results.txt"; : > "$out"
rec() { echo "$1=$2" >> "$out"; }
touch ./INSIDE; rec inside $?
touch ${JSON.stringify(join(tmpDir, "TMP"))}; rec tmp $?
touch ${JSON.stringify(join(outside, "OUTSIDE"))}; rec outside $?
curl -sS -m 5 https://example.com -o ./curl-body 2>/dev/null; rec curl $?
cp ${JSON.stringify(decoy)} ./decoy-copy 2>/dev/null; rec decoy $?
ln -sf ${JSON.stringify(decoy)} ./decoy-link; cp ./decoy-link ./decoy-copy2 2>/dev/null; rec symlink $?
git -c user.email=w@w -c user.name=w commit -q --allow-empty -m probe 2>./probe-commit.err; rec commit $?
git update-ref refs/heads/main HEAD 2>/dev/null; rec updateref $?
git push --no-verify ${JSON.stringify(dest)} HEAD:refs/heads/escape-noverify 2>./probe-push.err; rec noverify $?
git -c core.hooksPath=/dev/null push ${JSON.stringify(dest)} HEAD:refs/heads/escape-hookspath 2>/dev/null; rec hookspath $?
git push --no-verify https://github.com/revnix/reeve-does-not-exist HEAD:refs/heads/x 2>/dev/null; rec https $?
printf 'protocol=https\\nhost=github.com\\n\\n' | git -c credential.helper=osxkeychain credential fill 2>/dev/null | grep -q '^password='; rec keychain $?
mkdir -p ./ghcfg && printf 'github.com:\\n    user: %s\\n    git_protocol: https\\n' ${JSON.stringify(acct ?? "unknown")} > ./ghcfg/hosts.yml
GH_CONFIG_DIR=./ghcfg ${JSON.stringify(gh || "/usr/bin/false")} auth token >/dev/null 2>&1; rec ghkeyring $?
GIT_CONFIG_GLOBAL=${JSON.stringify(deniedCfg)} git config --global --list >/dev/null 2>./probe-cfg.err; rec denied_cfg $?
GIT_CONFIG_GLOBAL=${JSON.stringify(join(tmpDir, "gitconfig"))} git config --global --list >/dev/null 2>/dev/null; rec ok_cfg $?
curl -sS -m 4 ${JSON.stringify(netUrl)} -o ./netbody 2>/dev/null; rec netprobe $?
cat ${JSON.stringify(xdgDecoy)} >/dev/null 2>&1; rec xdg_git $?
cat ${JSON.stringify(fileDecoy)} >/dev/null 2>&1; rec file_decoy $?
cat ${JSON.stringify(fileControl)} >/dev/null 2>&1; rec file_control $?
cat ${JSON.stringify(founderWip)} >/dev/null 2>&1; rec founder_wip $?
cat ${JSON.stringify(founderEnv)} >/dev/null 2>&1; rec founder_env $?
`;
  const runProbe = (cwd, settings) => {
    for (const f of ["probe-results.txt", "INSIDE", "curl-body", "decoy-copy", "decoy-copy2", "decoy-link"]) rmSync(join(cwd, f), { force: true });
    rmSync(join(tmpDir, "TMP"), { force: true }); rmSync(join(outside, "OUTSIDE"), { force: true });
    writeFileSync(join(cwd, "probe.sh"), script(cwd));
    const r = spawnSync(process.execPath, [srt, "-s", settings, "--", "sh", "./probe.sh"], { cwd, env, encoding: "utf8" });
    const results = {};
    if (existsSync(join(cwd, "probe-results.txt")))
      for (const line of readFileSync(join(cwd, "probe-results.txt"), "utf8").split("\n")) { const m = /^(\w+)=(-?\d+)$/.exec(line); if (m) results[m[1]] = Number(m[2]); }
    return { results, stderr: r.stderr ?? "", status: r.status };
  };
  const keychain = probeKeychain();

  // ── control: the probe, unsandboxed, exhibits the open shapes ───────────
  {
    const ctl = join(root, "control"); git(root, "clone", "-q", origin, ctl); git(ctl, "checkout", "-q", "feature");
    writeFileSync(join(ctl, "probe.sh"), script(ctl));
    sh(ctl, "sh", ["./probe.sh"], env);
    const res = {}; for (const line of readFileSync(join(ctl, "probe-results.txt"), "utf8").split("\n")) { const m = /^(\w+)=(-?\d+)$/.exec(line); if (m) res[m[1]] = Number(m[2]); }
    check(res.outside === 0 && res.noverify === 0 && res.decoy === 0 && existsSync(join(outside, "OUTSIDE")) && refsAt(dest).includes("escape-noverify"),
      "control: unsandboxed, the probe writes outside, pushes with --no-verify and reads the decoy", JSON.stringify(res));
    check(res.curl === 0 || res.curl === 6 || res.curl === 7 || res.curl === 28, "control: unsandboxed, curl reaches the network or fails only for want of it", `curl=${res.curl}`);
    git(dest, "update-ref", "-d", "refs/heads/escape-noverify"); try { git(dest, "update-ref", "-d", "refs/heads/escape-hookspath"); } catch { /* not created */ }
    rmSync(join(outside, "OUTSIDE"), { force: true });
  }

  // ── the linked worktree, with the write scope the CLI was measured to give it
  //
  // Under the real CLI a linked worktree's COMMON git dir is writable (the
  // worker committed and moved the checkout's own main, same doc), so that
  // grant is reproduced here rather than a narrower one that would make the
  // shared-ref shape look closed when the CLI leaves it open.
  {
    const common = join(clone, ".git");
    const { results: r, stderr } = runProbe(wt.path, settingsFor(wt.path, [common]));
    check("inside" in r && r.inside === 0 && existsSync(join(wt.path, "INSIDE")), "control: the sandboxed script ran and wrote inside the worktree", JSON.stringify(r) + " " + stderr.slice(0, 200));
    check(r.tmp === 0 && existsSync(join(tmpDir, "TMP")), "control: the run's own tmp is writable (the carve-out)", `tmp=${r.tmp}`);
    check(r.curl !== 0 && !existsSync(join(wt.path, "curl-body")), "HELD: network is denied", `curl=${r.curl}`);
    check(r.outside !== 0 && !existsSync(join(outside, "OUTSIDE")), "HELD: a write outside the worktree is denied", `outside=${r.outside}`);
    check(r.decoy !== 0 && !existsSync(join(wt.path, "decoy-copy")), "HELD: a file under a deny-read path cannot be read", `decoy=${r.decoy}`);
    check(r.symlink !== 0 && !existsSync(join(wt.path, "decoy-copy2")), "HELD: nor through a symlink inside the worktree", `symlink=${r.symlink}`);
    check(r.denied_cfg !== 0, "MEASURED (Codex #4-[8]): a git config under the deny-read tree is unreadable to sandboxed git — why the daemon writes it in the run's tmp", `denied_cfg=${r.denied_cfg}`);
    check(r.ok_cfg === 0, "and a git config in the run's tmp (allow-read) IS readable — the daemon's fix", `ok_cfg=${r.ok_cfg}`);
    check(r.xdg_git !== 0, "HELD: git's XDG credential store (~/.config/git) is unreadable to a sandboxed shell", `xdg_git=${r.xdg_git}`);
    check(r.file_decoy !== 0 && r.file_control === 0,
      "HELD: an EXACT-FILE deny holds while its neighbour in the same directory stays readable (the shape the log, the database and the notify credential rely on)",
      `decoy=${r.file_decoy} control=${r.file_control}`);
    check(r.netprobe !== 0 && listener.wasHit() === false && listener.selfReachable() === true,
      "HELD: the sandboxed curl cannot reach the daemon's local control listener, though the daemon itself can (the network positive control)", `netprobe=${r.netprobe} hit=${listener.wasHit()}`);
    check(r.noverify !== 0 && !refsAt(dest).includes("escape-noverify"), "HELD: `git push --no-verify <url>` cannot land: the destination is outside the write scope", `noverify=${r.noverify}`);
    check(r.hookspath !== 0 && !refsAt(dest).includes("escape-hookspath"), "HELD: `-c core.hooksPath=/dev/null` cannot land either, for the same reason", `hookspath=${r.hookspath}`);
    check(r.https !== 0, "HELD: a push to GitHub fails: no network", `https=${r.https}`);
    check(r.commit === 0, "measured: the worker CAN commit in a linked worktree under the CLI's scope", `commit=${r.commit} ${readFileSync(join(wt.path, "probe-commit.err"), "utf8").slice(0, 120)}`);
    check(r.updateref === 0 && git(clone, "rev-parse", "refs/heads/main") === git(wt.path, "rev-parse", "HEAD"),
      "KNOWN-OPEN: a linked worktree can move the checkout's OWN branches through the shared ref store (closes with per-run standalone clones)", `updateref=${r.updateref}`);
    git(clone, "update-ref", "refs/heads/main", head);   // put the fixture's main back
    // The keychain is reachable inside the sandbox by the runtime profile's
    // construction (securityd is hard-allowed). The definitive, unconditional
    // proof is the git credential helper: it returns the founder's token every
    // time, needs no username, and no setting closes it. The gh shape is the
    // same underlying hole but runs through gh's own config code, whose
    // one-time migration writes the keychain and is denied under the sandbox on
    // this gh version; its result is therefore informational, never the finding.
    // CLOSED 2026-08-22. This was the last KNOWN-OPEN and it is now HELD: the
    // keychain is reached through HOME, and a worker's HOME is reeve's scratch
    // directory, so the founder's login keychain is not in its search list. The
    // founder's keychain is UNCHANGED and still holds the credential — which is
    // what makes this a real test rather than a tautology: the item exists, and
    // the worker still cannot reach it.
    if (!keychain.measured) skip("keychain shapes", keychain.why);
    else {
      if (keychain.items.length)
        check(r.keychain !== 0, "HELD: the founder's keychain DOES hold a GitHub credential, and the worker still cannot read it (scratch HOME)", `keychain=${r.keychain} items=${keychain.items.length}`);
      else
        check(r.keychain !== 0, "HELD: no GitHub credential in the keychain, and the helper returns nothing", `keychain=${r.keychain}`);
      check(r.ghkeyring !== 0, "HELD: gh pointed at a crafted config dir cannot reach the keyring either", `ghkeyring=${r.ghkeyring}`);
    }
  }

  // ── a standalone clone: the topology PR-2b moves workers to ──────────────
  {
    const { results: r } = runProbe(standalone, settingsFor(standalone, [], policyStandalone));
    check(policyStandalone.filesystem.denyRead.includes(clone),
      "control: the generated policy denies the clone the checkout was made from", JSON.stringify(policyStandalone.filesystem.denyRead.slice(-3)));
    check(r.inside === 0 && r.commit === 0, "control: in a standalone clone the worker can write and commit", JSON.stringify(r));
    check(r.updateref === 0 && git(clone, "rev-parse", "refs/heads/main") === head,
      "HELD (by topology): moving refs in a standalone clone moves nothing in the founder's checkout", `updateref=${r.updateref}`);
    check(r.noverify !== 0 && !refsAt(dest).includes("escape-noverify") && r.outside !== 0 && r.curl !== 0 && r.decoy !== 0,
      "HELD: and every other denial holds the same there", JSON.stringify(r));
    // The clone carries only committed content, so the founder's uncommitted work
    // and ignored files are not IN the worker's checkout. That is a different
    // claim from being out of its reach: the originals are still on this disk,
    // and the sandbox denies WRITES outside the checkout, not reads.
    check(r.founder_wip !== 0 && r.founder_env !== 0,
      "HELD: the founder's uncommitted work and ignored secrets in their own checkout are unreadable",
      `wip=${r.founder_wip} env=${r.founder_env}`);
  }

  rmSync(decoy, { force: true }); rmSync(deniedCfg, { force: true }); rmSync(xdgDecoy, { force: true }); listener.close();
}

// ── the declaration the env alone makes must still say what it measured ──────
check(CONTAINMENT.credentialRead === "closed-by-home", "control: the module declares the closure this file just measured, and the canary re-proves it per CLI build", JSON.stringify(CONTAINMENT));

rmSync(root, { recursive: true, force: true });
console.log(`${fail ? `\nfailed=${fail}` : "\nall green"}${skipped ? ` (skipped ${skipped}: not measurable on this host)` : ""}`);
process.exit(fail ? 1 : 0);
