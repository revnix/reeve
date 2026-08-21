# Measured: the OS sandbox and settings validation under print mode

Date: 2026-08-22. Host: macOS (Darwin 25.6), founder account, CLI 2.1.237
(`claude --version`), `@anthropic-ai/sandbox-runtime` 0.0.73 from npm for the
model-free runs (`srt`, the same profile generator the CLI bundles; the CLI's
bundled copy is not separately versioned, so every conclusion that matters was
confirmed through the real CLI as well).

Every probe records exit codes and presence bits only. Credential probes were
pointed at a decoy file (`~/.reeve/reeve-probe-decoy.txt`, removed afterwards)
wherever a decoy is equivalent; the keychain probes return only the exit code
of `grep -q '^password='` over the helper's output, never the output.

## The fixture

```
~/reeve-measure/
  origin.git          bare; branches main, feature (one empty commit each)
  clone/              full clone of origin.git; the "founder's checkout"
  wts/feature         LINKED worktree of clone (gitdir: clone/.git/worktrees/feature)
  clone2/             STANDALONE clone of origin.git on feature
  dest.git            bare, outside every cwd: the escape destination
  outside/            a directory outside every cwd
```

`probe.sh` (copied into each cwd) runs, in order, and appends `name=exit` to
`./probe-results.txt`:

```
curl -sS -m 5 https://example.com -o /dev/null              → curl
touch <outside>/OUTSIDE-TOUCHED                             → touch_outside
touch ./INSIDE-TOUCHED                                      → touch_inside (control)
cat ~/.reeve/reeve-probe-decoy.txt                           → read_decoy_in_denied_dir
cat ~/.config/gh/hosts.yml                                  → read_gh_hosts
ls ~/.ssh                                                   → list_ssh
cat ~/.claude/.credentials.json                             → read_claude_creds (file absent on this host: 1 everywhere)
ls ~/Work                                                   → list_home_work (control: home is readable)
printf 'protocol=https\nhost=github.com\n\n' | git -c credential.helper=osxkeychain credential fill | grep -q '^password='
                                                            → keychain_token_present (0 = a token came back)
/opt/homebrew/bin/gh auth token                             → gh_abs_token
git commit --allow-empty -m probe                           → git_commit
git update-ref refs/heads/main HEAD                         → update_ref_main
git push --no-verify <dest.git> HEAD:refs/heads/escape-noverify → push_noverify_local
git push --no-verify https://github.com/revnix/reeve-does-not-exist HEAD:refs/heads/x → push_https
ln -sf ~/.reeve/reeve-probe-decoy.txt ./decoy-link.txt      → symlink_created
cat ./decoy-link.txt                                        → read_via_symlink
```

Unsandboxed control (plain shell, founder env, in a copy of clone2):
`curl=0 touch_outside=0 touch_inside=0 read_decoy_in_denied_dir=0 read_gh_hosts=0
list_ssh=0 read_claude_creds=1 list_home_work=0 keychain_token_present=0
gh_abs_token=0 git_commit=0 update_ref_main=0 push_noverify_local=0 push_https=128
symlink_created=0 read_via_symlink=0` — every shape the fixture is meant to
exhibit, it exhibits.

## Settings used for the sandboxed runs

`settings-a.json` (the CLI):

```json
{
  "sandbox": {
    "enabled": true, "failIfUnavailable": true, "allowUnsandboxedCommands": false, "autoAllowBashIfSandboxed": false,
    "filesystem": { "denyRead": ["~/.reeve", "~/.config/gh", "~/.ssh", "~/.claude/.credentials.json"] },
    "network": { "allowedDomains": [] }
  },
  "permissions": { "allow": ["Bash(sh ./probe.sh)"], "deny": ["Read(~/.reeve/**)", "Read(~/.config/gh/**)", "Read(~/.ssh/**)"] }
}
```

Every CLI run: `claude -p '<prompt>' --output-format stream-json --verbose
--safe-mode --strict-mcp-config --no-chrome --setting-sources "" --settings
<file> --allowedTools 'Bash(sh ./probe.sh)' --max-turns 4..6 --json-schema
<schema>`, stdin inherited from the shell, `GH_TOKEN`/`GITHUB_TOKEN` unset.

`srt` runs use the runtime's own schema (`network` + `filesystem` at top level,
every key present) with `allowWrite: [<cwd>]`, because `srt` adds nothing by
itself — with `allowWrite: []` even `./probe-results.txt` was "Operation not
permitted". The CLI adds cwd and more (below).

## Results

| shape | CLI, linked worktree | srt, linked worktree | srt, standalone clone | reading |
|---|---|---|---|---|
| curl | 56 | 56 | 56 | network denied (proxy refuses) |
| touch_outside | 1 | 1 | 1 | writes outside cwd denied |
| touch_inside | 0 | 0 | 0 | control |
| read_decoy_in_denied_dir | 1 | 1 | 1 | `denyRead` enforced |
| read_gh_hosts | 1 | 1 | 1 | `denyRead` enforced |
| list_ssh | 1 | 1 | 1 | `denyRead` enforced |
| list_home_work | 0 | 0 | 0 | home otherwise readable |
| **keychain_token_present** | **0** | **0** | **0** | **the founder's GitHub token came back inside the sandbox** |
| gh_abs_token | 1 | 1 | 1 | gh failed only because `~/.config/gh` was unreadable (see below) |
| git_commit | **0** | 128 | 0 | the CLI allows the linked worktree's COMMON git dir; bare srt does not |
| update_ref_main | **0** | 128 | 0 | under the CLI, the worker moved the FOUNDER's `refs/heads/main` (verified: clone's main = the probe commit) |
| push_noverify_local | 1 | 1 | 1 | dest.git is outside cwd: "unable to create temporary object directory" |
| push_https | 128 | 128 | 128 | network denied |
| read_via_symlink | 1 | 1 | 1 | Seatbelt resolves the link; the deny holds |
| Read tool, absolute path in a denied dir | denied: "File is in a directory that is denied by your permission settings." | — | — | the `Read(...)` deny rule applies under `-p` |
| Read tool, symlink inside cwd → denied dir | denied: "Permission to read .../decoy-link.txt has been denied." | — | — | the CLI resolves the link before matching |

A first CLI run with the fixture under `/private/tmp/claude-501/...` (this
session's scratchpad) showed `touch_outside=0`, `push_noverify_local=0` and
`update_ref_main=0`: the CLI's write scope includes its own temp area, and a
fixture placed there cannot measure the outside-write shapes. Reported here so
nobody repeats it; all rows above are from the `$HOME` fixture.

### The keychain, in detail

`gh` stores this host's token in the keychain (`gh auth status`: "(keyring)";
items: `genp svce=gh:github.com` and `inet srvr=github.com`). `hosts.yml` holds
no token. Under `srt` in the standalone clone:

```
GH_CONFIG_DIR=./ghcfg /opt/homebrew/bin/gh auth token     → 0   (ghcfg/hosts.yml crafted inside cwd: "github.com: user: mobeenabdullah")
git -c credential.helper=osxkeychain credential fill     → password present
```

So `denyRead` on `~/.config/gh` closes nothing for `gh`: pointed at a config
dir the worker can write, it reads the keyring item and prints the token. The
runtime's Seatbelt profile hard-allows `mach-lookup` of
`com.apple.securityd.xpc` and `com.apple.SecurityServer`
(`macos-sandbox-utils.js`, `generateSandboxProfile`); no setting removes them,
and file rules cannot reach an item that securityd reads on the process's
behalf. **Any keychain item whose ACL trusts a CLI binary the worker can
execute is readable inside the sandbox.** On macOS under the founder's own
account this closes only by (a) a dedicated worker user with its own, empty
keychain, or (b) no GitHub credential in the keychain at all (gh logged in with
`--insecure-storage`, the `inet github.com` item removed), after which the
file-level `denyRead` is the layer that holds.

## Invalid settings under print mode

`bad.json`: `{ "permissions": { "deny": ["Bash(ls:*)"] }, "sandbox": { "enabled": "yes" } }`
(wrong type). Prompt: "Run exactly: ls . ; report the exit code and whether it
was denied." `--allowedTools 'Bash(ls:*)'`.

| settings | CLI exit | stderr | the deny rule | structured output |
|---|---|---|---|---|
| bad.json | 0 | (nothing; only the stdin-idle warning) | NOT applied: `ls .` ran and listed cwd | `{"lsExit":0,"denied":false}` |
| good-deny.json (`"enabled": true`, same deny) | 0 | — | applied: "Permission to use Bash with command ls . has been denied." | `{"lsExit":-1,"denied":true}` |

A first attempt used `ls /`, which is refused by the working-directory rule
regardless of any settings ("Claude Code may only list files in the allowed
working directories") and so measured nothing; the rows above use `ls .`.

**Conclusion:** a settings file that fails validation is ignored in its
entirety, silently, with exit 0. A supplied path proves nothing; pre-spawn
validation is load-bearing.

## Conclusions

1. `sandbox.*` applies under `-p`: network, outside writes, `denyRead` (also
   through symlinks) and the `Read(...)` deny rules all hold. Key names as
   documented: `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`,
   `autoAllowBashIfSandboxed`, `filesystem.{allowWrite,denyWrite,allowRead,denyRead}`,
   `network.allowedDomains`.
2. An invalid settings file is silently dropped whole. Validate before spawn.
3. In a **linked worktree**, the CLI's write scope includes the shared git dir,
   so a worker can commit AND move any branch of the checkout it was linked
   from; with the runtime's bare scope it can do neither (no commits at all).
   Neither is acceptable: workers need a git dir of their own. A **per-run
   standalone clone** gives the worker a private ref store and leaves the
   founder's checkout unwritable by construction (outside cwd).
4. The **keychain is open inside the sandbox by the profile's construction.**
   The founder's GitHub token is readable by two shapes a worker can run.
   Closure is a host property (worker user, or no GitHub credential in the
   keychain), to be measured at daemon start, not assumed.
5. The CLI's stdin idle warning ("no stdin data received in 3s") appeared in
   every shell run; `runWorker` ends stdin after the gate line, so the daemon's
   workers are not affected.
