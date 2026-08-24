// The worker's environment, built from an allowlist rather than inherited.
//
// Measured: `runWorker` spread `...process.env` into every worker, which handed
// it the founder's GH_TOKEN, the ssh agent socket, cloud credentials, and git
// overrides. None of the sandbox's string-pattern denies can stop a worker that
// holds a token, because `git -C . push https://<token>@host/...` matches no
// `git push` prefix and needs no helper. This module removes every credential
// VARIABLE and every git entry point that could re-introduce one.
//
// HOME is the boundary, and it is the thing that was wrong before.
//
// The first version gave every worker the founder's real HOME, because the CLI
// reads `~/.claude` to know it is logged in and a scratch home left workers
// unauthenticated. That handed the worker the founder's KEYCHAIN, which the OS
// sandbox cannot deny at all: the runtime's Seatbelt profile hard-allows
// securityd, and `git -c credential.helper=osxkeychain credential fill`
// returned the founder's GitHub token from inside the sandbox.
//
// Measured 2026-08-22 (docs/measured/2026-08-22-scratch-home-closes-the-keychain.md):
// the keychain is reached THROUGH HOME. With a scratch home the search list
// collapses to `/Library/Keychains/System.keychain`, and the founder's GitHub
// AND Claude items both answer errSecItemNotFound. The one thing that breaks is
// the CLI's own authentication, and `CLAUDE_CODE_OAUTH_TOKEN` (from
// `claude setup-token`) replaces it: one real worker under a scratch home with
// that token authenticated (`is_error:false`) and could reach neither item.
//
// So a worker gets a home of reeve's making, and the founder's credentials are
// unreachable by CONSTRUCTION rather than by deny rule. The deny list stays as
// the second layer, and the canary proves the property per CLI build rather
// than trusting this comment.
import { writeFileSync, mkdirSync, chmodSync, renameSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { resolveHome } from "./home.mjs";

/**
 * What this environment can and cannot promise, read by the daemon before any
 * dispatch. `credentialRead` says what mechanism closes the reach, and only a
 * measured one may set it: the canary probes the keychain, the gh keyring and
 * git's credential helper from inside a real worker, and reads the FILES that
 * worker left rather than anything it said. A comment cannot flip it.
 */
export const CONTAINMENT = Object.freeze({
  credentialRead: "closed-by-home-and-path",
  why: "workers run with a scratch HOME, so the founder's login keychain is not in their SEARCH LIST — which " +
       "on its own closes nothing: measured 2026-08-22, the keychain is still readable BY PATH from a scratch " +
       "home, as the same OS user, because it is unlocked with no timeout. ~/Library/Keychains is therefore " +
       "denied by path as well, and the canary probes both shapes. Authentication comes from " +
       "CLAUDE_CODE_OAUTH_TOKEN instead of ~/.claude. Proven per CLI build by the canary, not by this string.",
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
export function workerEnv({ gitConfigPath, tmpDir, bgWaitMs, maxRetries = 1, extra = {}, extraPath = [], home = null, oauthToken = null }) {
  if (!gitConfigPath) throw new Error("workerEnv: gitConfigPath is required; a worker must not find the founder's git config");
  // A worker's HOME is reeve's to give. Refusing the founder's own home here is
  // the whole containment property: with it, the keychain is one command away.
  if (!home) throw new Error("workerEnv: home is required; a worker with the founder's HOME can read their keychain");
  if (home === homedir()) throw new Error("workerEnv: home must not be the founder's own home directory");
  mkdirSync(home, { recursive: true });
  // Without a token a scratch home leaves the CLI unauthenticated ("Not logged
  // in"), so a missing one is a refusal rather than a worker that cannot work.
  if (!oauthToken) throw new Error("workerEnv: oauthToken is required; a worker with a scratch HOME has no ~/.claude to authenticate from");
  mkdirSync(tmpDir, { recursive: true });
  // The shims live beside reeve's own git config, never under the per-run
  // TMPDIR: the PATH must be the same for every run under one contract.
  const shims = writeShims(dirname(gitConfigPath));
  const env = {
    PATH: [shims, NODE_BIN, ...extraPath, ...SYSTEM_PATH].join(":"),
    HOME: home,
    CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
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

/**
 * Where a repository's workers live. Stable per repository rather than per run,
 * because the CLI keeps its sessions under HOME and `--resume` must be able to
 * find one. Deliberately NOT under reeve's state tree: that tree is deny-read,
 * and a worker must be able to read its own home.
 */
export function workerHomeFor(root, nwo) {
  // NESTED, not flattened. `nwo.replace("/", "-")` maps `foo-bar/baz` and
  // `foo/bar-baz` to the same directory, and this home holds the worker's own
  // session state and is not denied to it -- so two repositories sharing a
  // worktree root would share one, and either could read or disturb the other's.
  // The same collision was found in the canary's state path; it is the same
  // mistake, so it gets the same shape. (Codex #5-[8].)
  const [owner, ...rest] = String(nwo).split("/");
  return join(root, ".reeve-worker-home", owner, rest.join("/") || "_");
}

/**
 * The worker's authentication, from a file only the founder can read.
 *
 * A scratch HOME has no `~/.claude`, so this token is what lets a worker run at
 * all. It lives inside the deny-read state tree, so a worker cannot read the
 * file even though it holds the value in its own environment (which no other
 * sandboxed process can read: measured 2026-08-22).
 */
export function readOauthToken(path = join(resolveHome(), "claude-token")) {
  let raw;
  try { raw = readFileSync(path, "utf8"); }
  // `path` IS RETURNED, on every shape. The checker knows which file it
  // looked at and the reporter was reconstructing it -- and got it wrong the
  // moment this default started following the resolved home, telling operators
  // to write `~/.reeve/claude-token` after looking somewhere else entirely.
  catch (e) { return { ok: false, path, why: `${path} could not be read (${e.code ?? e.message}); create one with \`claude setup-token\`` }; }
  const token = raw.trim();
  if (!token) return { ok: false, path, why: `${path} is empty` };
  // Loose on purpose: the prefix is what today's tokens carry, and refusing an
  // unknown-but-plausible shape would strand a worker on a format change.
  if (token.includes("\n") || token.length < 20) return { ok: false, path, why: `${path} does not look like a token` };
  try {
    const mode = statSync(path).mode & 0o077;
    if (mode) return { ok: false, path, why: `${path} is readable by others (mode ${(statSync(path).mode & 0o777).toString(8)}); chmod 600 it` };
  } catch { /* the read already succeeded; a stat failure is not a refusal */ }
  return { ok: true, token, path, why: null };
}
