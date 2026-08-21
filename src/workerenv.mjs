// The worker's environment, built from an allowlist rather than inherited.
//
// Measured: `runWorker` spread `...process.env` into every worker, which handed
// it the founder's GH_TOKEN, the ssh agent socket, cloud credentials, and git
// overrides. None of the sandbox's string-pattern denies can stop a worker that
// holds a token, because `git -C . push https://<token>@host/...` matches no
// `git push` prefix and needs no helper. Containment is by AUTHORITY: the
// worker simply has no credential, and git is told to look for none.
//
// HOME stays real on purpose. The CLI reads ~/.claude and ~/.claude.json for the
// founder's subscription authentication; a per-run home would leave every
// worker unauthenticated. Everything else isolates around that one fact.
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Node and pnpm pinned by absolute path: `node` on PATH is v22 here and must
// never reach a worker, and a worker that cannot find pnpm cannot run the gates.
const NODE_BIN = join(homedir(), ".nvm", "versions", "node", "v24.17.0", "bin");
const SYSTEM_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

// Names that must never reach a worker, however they arrive. Matched exactly,
// by prefix, or by suffix; a phase's `extra` cannot reintroduce them.
const STRIP_EXACT = new Set(["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "GIT_SSH_COMMAND", "GIT_ASKPASS",
                             "GIT_CONFIG_COUNT", "REEVE_APP_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
const STRIP_PREFIX = ["AWS_", "GOOGLE_", "GCLOUD_", "AZURE_", "GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"];
const STRIP_SUFFIX = ["_PROXY", "_proxy"];

function stripped(name) {
  return STRIP_EXACT.has(name) || STRIP_PREFIX.some(p => name.startsWith(p)) || STRIP_SUFFIX.some(s => name.endsWith(s));
}

/**
 * Write the credential-less global git config a worker runs under, and return
 * its path. An EMPTY `credential.helper` disables every helper git would
 * otherwise consult (the founder's osxkeychain included, which lives in the
 * system config this environment also refuses to read). No URL rewrites: an
 * `insteadOf` could route a push somewhere a bogus pushurl does not cover.
 */
export function writeGitConfig(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "gitconfig");
  writeFileSync(path, "[credential]\n\thelper = \n[core]\n\taskPass = \n");
  return path;
}

/**
 * The complete environment for one worker. Callers pass it to `runWorker` as
 * `env` and it is used verbatim: nothing from this process is merged in.
 */
export function workerEnv({ gitConfigPath, tmpDir, bgWaitMs, maxRetries = 1, extra = {} }) {
  if (!gitConfigPath) throw new Error("workerEnv: gitConfigPath is required; a worker must not find the founder's git config");
  mkdirSync(tmpDir, { recursive: true });
  const env = {
    PATH: [NODE_BIN, ...SYSTEM_PATH].join(":"),
    HOME: homedir(),
    TMPDIR: tmpDir,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: "dumb",
    // Without this a 429 hangs indefinitely: the CLI retries internally with
    // no output, which reads as a stuck worker rather than a rate limit.
    CLAUDE_CODE_MAX_RETRIES: String(maxRetries),
    // Print mode waits for background subagents up to this ceiling before exit.
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(bgWaitMs),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitConfigPath,
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const [k, v] of Object.entries(extra)) {
    if (stripped(k)) continue;   // a phase may add variables, never credentials
    env[k] = String(v);
  }
  return env;
}
