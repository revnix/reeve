// The worker used to inherit `...process.env`: the founder's GH_TOKEN, the ssh
// agent socket, cloud credentials, proxies, and git overrides all rode along,
// and a `git -C . push https://<token>@...` needs none of the sandbox's deny
// patterns to succeed. The environment is now built from an allowlist, and the
// test asserts the ABSENCE of each ambient credential with a positive control
// (it plants them first), because an absence search that cannot see is not one.
import { workerEnv, writeGitConfig, workerHomeFor, CONTAINMENT } from "../src/workerenv.mjs";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// A worker never gets the founder's HOME (that is where the keychain lives) and
// authenticates from a token instead of ~/.claude.
const WORKER_HOME = mkdtempSync(join(tmpdir(), "reeve-worker-home-"));
const FAKE_TOKEN = "sk-ant-oat01-test-token-not-a-real-credential-000000000000";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const dir = mkdtempSync(join(tmpdir(), "reeve-env-"));

// Positive control: plant every credential the allowlist must drop.
const planted = { GH_TOKEN: "x", GITHUB_TOKEN: "x", SSH_AUTH_SOCK: "/tmp/agent", AWS_SECRET_ACCESS_KEY: "x",
                  GOOGLE_APPLICATION_CREDENTIALS: "x", AZURE_CLIENT_SECRET: "x", HTTPS_PROXY: "x", http_proxy: "x",
                  GIT_SSH_COMMAND: "x", GIT_ASKPASS: "x", GIT_CONFIG_COUNT: "1", REEVE_APP_KEY: "/k.pem",
                  ANTHROPIC_API_KEY: "x" };
for (const [k, v] of Object.entries(planted)) process.env[k] = v;

const gitConfigPath = writeGitConfig(dir);
const env = workerEnv({ home: WORKER_HOME, oauthToken: FAKE_TOKEN, gitConfigPath, tmpDir: join(dir, "tmp"), bgWaitMs: 1200000 });

{
  const leaked = Object.keys(planted).filter(k => k in env);
  check(leaked.length === 0, "no planted credential reaches the worker", leaked.join(","));
  check(Object.keys(planted).every(k => process.env[k] !== undefined),
    "control: the credentials were actually planted in this process", "");
}
{
  // The property this module now exists for: a worker's HOME is reeve's, never
  // the founder's, because the keychain is reached through HOME and the OS
  // sandbox cannot deny it. Measured 2026-08-22.
  check(env.HOME === WORKER_HOME && env.HOME !== homedir(), "HOME is a scratch home, NOT the founder's: that is what puts the keychain out of reach", env.HOME);
  const { dirname: dn } = await import("node:path");
  check(typeof env.PATH === "string" && env.PATH.split(":")[1] === dn(process.execPath),
    "PATH carries the running daemon's own node bin, right after the shims", env.PATH);
  check(env.TMPDIR === join(dir, "tmp"), "TMPDIR is per run", env.TMPDIR);
  check(env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS === "1200000", "the background-wait ceiling is passed", env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS);
  check(env.CLAUDE_CODE_MAX_RETRIES === "1", "the 429 retry bound is passed", env.CLAUDE_CODE_MAX_RETRIES);
}
{
  check(env.GIT_CONFIG_NOSYSTEM === "1", "the system git config is never read", env.GIT_CONFIG_NOSYSTEM);
  check(env.GIT_CONFIG_GLOBAL === gitConfigPath, "the global git config is reeve's own file", env.GIT_CONFIG_GLOBAL);
  check(env.GIT_TERMINAL_PROMPT === "0", "git never prompts", env.GIT_TERMINAL_PROMPT);
  const cfg = readFileSync(gitConfigPath, "utf8");
  check(/\[credential\]\s*\n\s*helper\s*=\s*$/m.test(cfg), "the config disables every credential helper", cfg);
  check(!/url\s*=/.test(cfg) && !/insteadOf/.test(cfg), "and carries no URL rewrite", cfg);
}
{
  const e2 = workerEnv({ home: WORKER_HOME, oauthToken: FAKE_TOKEN, gitConfigPath, tmpDir: dir, bgWaitMs: 1, extra: { FOO: "bar" } });
  check(e2.FOO === "bar", "a phase may add named variables", "");
  const e3 = workerEnv({ home: WORKER_HOME, oauthToken: FAKE_TOKEN, gitConfigPath, tmpDir: dir, bgWaitMs: 1, extra: { GH_TOKEN: "sneak" } });
  check(!("GH_TOKEN" in e3), "but a stripped name cannot be smuggled back through extra", JSON.stringify(e3.GH_TOKEN));
  // The strip rules are only reachable through `extra` (the base never copies
  // process.env), so each rule shape is exercised here, not just an exact name.
  const e4 = workerEnv({ home: WORKER_HOME, oauthToken: FAKE_TOKEN, gitConfigPath, tmpDir: dir, bgWaitMs: 1,
                         extra: { AWS_ACCESS_KEY_ID: "p", ALL_PROXY: "s", no_proxy: "s2", GIT_CREDENTIAL_X: "g", NODE_OPTIONS: "--require evil" } });
  check(!("AWS_ACCESS_KEY_ID" in e4) && !("ALL_PROXY" in e4) && !("no_proxy" in e4) && !("GIT_CREDENTIAL_X" in e4) && !("NODE_OPTIONS" in e4),
    "prefix, suffix, and the node preload variable are stripped through extra too", JSON.stringify(Object.keys(e4)));
  const e4b = workerEnv({ home: WORKER_HOME, oauthToken: FAKE_TOKEN, gitConfigPath, tmpDir: dir, bgWaitMs: 1, extra: { GITHUB_ENTERPRISE_TOKEN: "t" } });
  check(!("GITHUB_ENTERPRISE_TOKEN" in e4b), "gh's second enterprise-token alias is stripped too", JSON.stringify(Object.keys(e4b)));
  // The base is RESERVED: a phase cannot point git back at the founder's
  // config, swap HOME or PATH, or loosen the retry bound through `extra`.
  const e5 = workerEnv({ home: WORKER_HOME, oauthToken: FAKE_TOKEN, gitConfigPath, tmpDir: dir, bgWaitMs: 1,
                         extra: { GIT_CONFIG_GLOBAL: "/Users/x/.gitconfig", GIT_CONFIG_NOSYSTEM: "0", PATH: "/evil", HOME: "/tmp/h", CLAUDE_CODE_MAX_RETRIES: "99" } });
  check(e5.GIT_CONFIG_GLOBAL === gitConfigPath && e5.GIT_CONFIG_NOSYSTEM === "1" && e5.PATH === env.PATH && e5.HOME === WORKER_HOME && e5.CLAUDE_CODE_MAX_RETRIES === "1",
    "base variables are reserved and cannot be overridden through extra (HOME included: a phase must not point a worker back at the founder's keychain)", JSON.stringify({ g: e5.GIT_CONFIG_GLOBAL, p: e5.PATH, h: e5.HOME }));
  // Git's other config and credential entry points are stripped by name.
  const e6 = workerEnv({ home: WORKER_HOME, oauthToken: FAKE_TOKEN, gitConfigPath, tmpDir: dir, bgWaitMs: 1,
                         extra: { GIT_CONFIG_PARAMETERS: "'credential.helper=osxkeychain'", GIT_CONFIG_SYSTEM: "/x", GIT_EXEC_PATH: "/x", GIT_DIR: "/x", GIT_WORK_TREE: "/x", GIT_SSH: "/x", XDG_CONFIG_HOME: "/x" } });
  check(["GIT_CONFIG_PARAMETERS", "GIT_CONFIG_SYSTEM", "GIT_EXEC_PATH", "GIT_DIR", "GIT_WORK_TREE", "GIT_SSH", "XDG_CONFIG_HOME"].every(k => !(k in e6)),
    "every git config, credential, and location override is stripped", JSON.stringify(Object.keys(e6)));
}
{
  // The PATH begins with a reeve-owned shim directory whose `gh`, `ssh`, and
  // `security` refuse: not a boundary (an absolute path walks around it), but
  // the layer that stops the obvious command before the real boundary lands.
  const { execFileSync } = await import("node:child_process");
  const shimDir = env.PATH.split(":")[0];
  check(/reeve/.test(shimDir) && existsSync(join(shimDir, "gh")) && existsSync(join(shimDir, "ssh")) && existsSync(join(shimDir, "security")),
    "a reeve-owned shim directory leads the PATH with refusing gh, ssh, and security", shimDir);
  let code = 0, err = "";
  try { execFileSync("gh", ["auth", "token"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { code = e.status; err = String(e.stderr); }
  check(code !== 0 && /refused/.test(err), "a bare `gh` under the worker env is the shim, and it refuses", `code=${code} ${err.slice(0, 80)}`);
  const e7 = workerEnv({ home: WORKER_HOME, oauthToken: FAKE_TOKEN, gitConfigPath, tmpDir: dir, bgWaitMs: 1, extraPath: ["/opt/tools/bin"] });
  check(e7.PATH.split(":").includes("/opt/tools/bin") && e7.PATH.split(":").indexOf("/opt/tools/bin") > e7.PATH.split(":").findIndex(p => /v24\.17\.0/.test(p)),
    "a caller may append tool directories, after the pinned node bin", e7.PATH);
}
{
  // What this module claims, and why it may. The keychain is reached through
  // HOME (measured 2026-08-22), so a scratch home takes it out of reach; the
  // string is a summary, and the CANARY is what proves it per CLI build.
  check(CONTAINMENT.credentialRead === "closed-by-home-and-path" && /scratch HOME/.test(CONTAINMENT.why),
    "the module declares the credential read closed BY THE HOME, with the reason", JSON.stringify(CONTAINMENT));
  // The two refusals that make the claim true rather than decorative.
  let threwHome = false, threwToken = false;
  try { workerEnv({ home: homedir(), oauthToken: FAKE_TOKEN, gitConfigPath, tmpDir: dir, bgWaitMs: 1 }); } catch { threwHome = true; }
  try { workerEnv({ home: WORKER_HOME, gitConfigPath, tmpDir: dir, bgWaitMs: 1 }); } catch { threwToken = true; }
  check(threwHome, "the founder's own home is REFUSED as a worker home");
  check(threwToken, "and a worker without a token is refused rather than left unauthenticated");
}


{
  // A worker must be able to commit (its prompt requires it) without the
  // founder's identity: the reeve-owned config carries the App's bot identity,
  // which is attributed on GitHub and names nothing private.
  const { execFileSync: ex } = await import("node:child_process");
  const repo = join(dir, "idrepo"); ex("git", ["init", "-q", repo], { env });
  writeFileSync(join(repo, "f"), "x");
  ex("git", ["-C", repo, "add", "f"], { env });
  let out = "", code = 0;
  try { ex("git", ["-C", repo, "commit", "-q", "-m", "worker commit"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); out = ex("git", ["-C", repo, "log", "-1", "--format=%an <%ae>"], { env, encoding: "utf8" }).trim(); }
  catch (e2) { code = e2.status; out = String(e2.stderr); }
  check(code === 0 && out === "merge-policy[bot] <319037914+merge-policy[bot]@users.noreply.github.com>", "a worker commit carries the App's bot identity", out.slice(0, 160));
  // A repository-local identity outranks the global config; the environment
  // outranks both. The worker's commits must be the bot's whatever the clone says.
  ex("git", ["-C", repo, "config", "user.name", "Founder Person"], { env });
  ex("git", ["-C", repo, "config", "user.email", "founder@example.com"], { env });
  writeFileSync(join(repo, "g"), "y"); ex("git", ["-C", repo, "add", "g"], { env });
  ex("git", ["-C", repo, "commit", "-q", "-m", "second"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const out2 = ex("git", ["-C", repo, "log", "-1", "--format=%an <%ae> %cn"], { env, encoding: "utf8" }).trim();
  check(out2 === "merge-policy[bot] <319037914+merge-policy[bot]@users.noreply.github.com> merge-policy[bot]", "a repository-local identity cannot re-attribute a worker commit", out2);
}



for (const k of Object.keys(planted)) delete process.env[k];
rmSync(dir, { recursive: true, force: true });
// ── a worker's home must be its OWN, across repositories ─────────────────────
//
// `nwo.replace("/", "-")` maps `foo-bar/baz` and `foo/bar-baz` to one directory.
// This home holds the worker's session state and is not denied to it, so two
// repositories sharing a worktree root would share one. The same collision was
// found in the canary's state path; this is the same mistake in a second place.
{
  const a = workerHomeFor("/root", "foo-bar/baz");
  const b = workerHomeFor("/root", "foo/bar-baz");
  check(a !== b, "two repositories whose flattened names collide get different homes", `${a} ${b}`);
  check(workerHomeFor("/root", "o/r").startsWith("/root/"), "and a home still lives under the given root", workerHomeFor("/root", "o/r"));
  check(workerHomeFor("/root", "o/r") === workerHomeFor("/root", "o/r"), "the same repository always gets the same one", "");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
