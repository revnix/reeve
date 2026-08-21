// The worker used to inherit `...process.env`: the founder's GH_TOKEN, the ssh
// agent socket, cloud credentials, proxies, and git overrides all rode along,
// and a `git -C . push https://<token>@...` needs none of the sandbox's deny
// patterns to succeed. The environment is now built from an allowlist, and the
// test asserts the ABSENCE of each ambient credential with a positive control
// (it plants them first), because an absence search that cannot see is not one.
import { workerEnv, writeGitConfig } from "../src/workerenv.mjs";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

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
const env = workerEnv({ gitConfigPath, tmpDir: join(dir, "tmp"), bgWaitMs: 1200000 });

{
  const leaked = Object.keys(planted).filter(k => k in env);
  check(leaked.length === 0, "no planted credential reaches the worker", leaked.join(","));
  check(Object.keys(planted).every(k => process.env[k] !== undefined),
    "control: the credentials were actually planted in this process", "");
}
{
  check(env.HOME === homedir(), "HOME is the real home: the CLI reads ~/.claude for subscription auth", env.HOME);
  check(typeof env.PATH === "string" && /v24\.17\.0\/bin/.test(env.PATH),
    "PATH is pinned to the v24 node bin", env.PATH);
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
  const e2 = workerEnv({ gitConfigPath, tmpDir: dir, bgWaitMs: 1, extra: { FOO: "bar" } });
  check(e2.FOO === "bar", "a phase may add named variables", "");
  const e3 = workerEnv({ gitConfigPath, tmpDir: dir, bgWaitMs: 1, extra: { GH_TOKEN: "sneak" } });
  check(!("GH_TOKEN" in e3), "but a stripped name cannot be smuggled back through extra", JSON.stringify(e3.GH_TOKEN));
}

for (const k of Object.keys(planted)) delete process.env[k];
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
