// The worker's environment, built from an allowlist rather than inherited.
//
// Measured: `runWorker` spread `...process.env` into every worker, which handed
// it the founder's GH_TOKEN, the ssh agent socket, cloud credentials, and git
// overrides. None of the sandbox's string-pattern denies can stop a worker that
// holds a token, because `git -C . push https://<token>@host/...` matches no
// `git push` prefix and needs no helper. This module removes every credential
// VARIABLE and every git entry point that could re-introduce one.
//
// What it does not do, stated plainly because the first version claimed
// otherwise: it does not make the founder's credentials unreachable. HOME
// stays real (the CLI reads ~/.claude and ~/.claude.json for subscription
// authentication, and a per-run home would leave every worker unauthenticated),
// so the keychain, ~/.config/gh, and ~/.ssh are on disk in front of a process
// running as the founder. Measured under exactly this environment:
// `git -c credential.helper=osxkeychain credential fill` and `gh auth token`
// both returned the founder's token. Closing that needs the OS sandbox to deny
// those reads, or a separate worker user; until one of them is proven, the
// daemon reads CONTAINMENT below and refuses to dispatch a worker at all.
import { writeFileSync, mkdirSync, chmodSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/**
 * What this environment can and cannot promise, read by the daemon before any
 * dispatch. `credentialRead` flips to "closed" only when a measured mechanism
 * (the OS sandbox canary denying keychain and gh-config reads, or a dedicated
 * worker user) proves it; a comment cannot flip it.
 */
export const CONTAINMENT = Object.freeze({
  credentialRead: "open",
  why: "the worker runs as the founder with a real HOME; the keychain, ~/.config/gh and ~/.ssh are readable, " +
       "and `git -c credential.helper=...` or `gh auth token` returns the founder's token",
});

// The worker's node is the daemon's own: `node` on the system PATH is v22 here
// and must never reach a worker, and a pinned version directory would vanish
// on the first patch upgrade and fall through to exactly that. Other tools
// (pnpm, the CLI) are appended by the caller from where they resolve.
const NODE_BIN = dirname(process.execPath);
const SYSTEM_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

// Names that must never reach a worker, however they arrive. Matched exactly,
// by prefix, or by suffix; a phase's `extra` cannot reintroduce them. The git
// entries are every documented way to point git at another config, another
// repository, or a credential source.
const STRIP_EXACT = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK", "SSH_AGENT_PID",
                             "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",
                             "GIT_CONFIG_SYSTEM", "GIT_EXEC_PATH", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
                             "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES",
                             "XDG_CONFIG_HOME", "NODE_OPTIONS", "REEVE_APP_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
const STRIP_PREFIX = ["AWS_", "GOOGLE_", "GCLOUD_", "AZURE_", "GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_", "GIT_CREDENTIAL_"];
const STRIP_SUFFIX = ["_PROXY", "_proxy"];

function stripped(name) {
  return STRIP_EXACT.has(name) || STRIP_PREFIX.some(p => name.startsWith(p)) || STRIP_SUFFIX.some(s => name.endsWith(s));
}

// Commands the worker has no business running, refused by a shim that leads
// the PATH. A layer, not a boundary: an absolute path walks around it, which is
// why CONTAINMENT above stays "open" regardless of these.
const SHIMMED = ["gh", "ssh", "ssh-add", "scp", "sftp", "security"];
const SHIM = name => `#!/bin/sh\necho '${name}: refused; a reeve worker holds no credentials and publishes nothing' >&2\nexit 1\n`;

/** Write the refusing shims once and return their directory. */
export function writeShims(dir) {
  const shims = join(dir, "shims");
  mkdirSync(shims, { recursive: true });
  for (const name of SHIMMED) {
    const path = join(shims, name);
    // Replaced atomically: every daemon on the host rewrites these while
    // another daemon's worker may be resolving them, and a truncated shim
    // would run as an empty, succeeding script instead of refusing.
    const tmp = join(shims, `.${name}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, SHIM(name));
    chmodSync(tmp, 0o755);
    renameSync(tmp, path);
  }
  return shims;
}

/**
 * Write the credential-less global git config a worker runs under, and return
 * its path. An EMPTY `credential.helper` resets the helper list git would
 * otherwise consult (the founder's ~/.gitconfig and the system config are both
 * out of reach through GIT_CONFIG_GLOBAL and GIT_CONFIG_NOSYSTEM). It is a
 * default, not a lock: a `-c credential.helper=...` on the command line appends
 * after it, which is one of the shapes CONTAINMENT records as open.
 */
export const WORKER_GIT_IDENTITY = Object.freeze({
  name: "merge-policy[bot]",
  // The App's own bot user (id 319037914 on GitHub), so a worker's commit is
  // attributed, names nothing private, and never borrows the founder's name.
  email: "319037914+merge-policy[bot]@users.noreply.github.com",
});

export function writeGitConfig(dir, identity = WORKER_GIT_IDENTITY) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "gitconfig");
  const content = `[credential]\n\thelper = \n[core]\n\taskPass = \n[user]\n\tname = ${identity.name}\n\temail = ${identity.email}\n`;
  // Replaced atomically: every daemon on this host rewrites the same file at
  // each dispatch while another daemon's worker may be reading it, and a
  // truncate-then-write would hand that worker an empty config.
  const tmp = join(dir, `.gitconfig.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, content);
  renameSync(tmp, path);
  return path;
}

/**
 * The complete environment for one worker. Callers pass it to `runWorker` as
 * `env` and it is used verbatim: nothing from this process is merged in. The
 * base variables are RESERVED: `extra` may add names, never replace these.
 */
export function workerEnv({ gitConfigPath, tmpDir, bgWaitMs, maxRetries = 1, extra = {}, extraPath = [] }) {
  if (!gitConfigPath) throw new Error("workerEnv: gitConfigPath is required; a worker must not find the founder's git config");
  mkdirSync(tmpDir, { recursive: true });
  // The shims live beside reeve's own git config, never under the per-run
  // TMPDIR: the PATH must be the same for every run under one contract.
  const shims = writeShims(dirname(gitConfigPath));
  const env = {
    PATH: [shims, NODE_BIN, ...extraPath, ...SYSTEM_PATH].join(":"),
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
    // The identity in the environment outranks every config level, so a
    // clone's own user.name cannot re-attribute a worker's commit to the
    // founder (measured: a repository-local identity beat the global one).
    GIT_AUTHOR_NAME: WORKER_GIT_IDENTITY.name, GIT_AUTHOR_EMAIL: WORKER_GIT_IDENTITY.email,
    GIT_COMMITTER_NAME: WORKER_GIT_IDENTITY.name, GIT_COMMITTER_EMAIL: WORKER_GIT_IDENTITY.email,
  };
  const reserved = new Set(Object.keys(env));
  for (const [k, v] of Object.entries(extra)) {
    if (stripped(k) || reserved.has(k)) continue;   // a phase may add variables, never credentials or the base
    env[k] = String(v);
  }
  return env;
}
