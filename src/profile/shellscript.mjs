// shellscript: whether a package script can ever pass, read the way the shell
// that runs it reads it.
//
// Setup detection reports a script broken when it can't pass: it runs a program
// that isn't there, or it always fails. That is decided here, and only when it is
// certain. A script this can't read with confidence, a loop say, or a program
// named by a variable, is never called broken: a wrong "broken" sends a fixer
// after a script that works.
//
// The runner picks the shell: npm, pnpm and yarn 1 their `script-shell` setting,
// `sh` unless it is set, which is dash on Debian and Ubuntu and bash on macOS;
// bun the first of bash, sh and zsh it finds. Shells disagree about which words
// are their own: dash has no `source`, `[[`, `function` or `select`, its `time`
// is a program, and its `exec` takes no options. So those are asked of the
// shell, rather than listed here.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// Words some shell treats as its own, keywords and builtins: POSIX's, and
// bash's, zsh's and ksh's. Which of them the shell that runs a script actually
// has is asked of it, and a word in no list is asked before it is called a
// missing program.
const CANDIDATES = [
  "!", "{", "}", "case", "do", "done", "elif", "else", "esac", "fi", "for", "if", "in", "then", "until", "while",
  "[[", "]]", "function", "select", "time", "coproc", "repeat", "foreach", "end", "nocorrect",
  ".", ":", "[", "alias", "bg", "break", "builtin", "cd", "chdir", "command", "continue", "declare", "echo", "eval",
  "exec", "exit", "export", "false", "fg", "getopts", "hash", "jobs", "kill", "let", "local", "printf", "pwd", "read",
  "readonly", "return", "set", "shift", "source", "test", "times", "trap", "true", "type", "typeset", "ulimit",
  "umask", "unalias", "unset", "wait",
  "shopt", "enable", "mapfile", "readarray", "pushd", "popd", "dirs", "disown", "caller", "bind", "help", "history",
  "logout", "suspend", "compgen", "complete", "compopt", "fc", "print", "autoload", "emulate", "setopt", "unsetopt",
  "whence", "noglob", "zmodload", "functions", "integer", "float",
];

// Where a program is looked up without PATH: `command -p`'s standard path, and
// env's own after `env -i` or `env -u PATH`. Shells and C libraries differ, and
// dash's is the widest, so this is all of theirs: a program in any of them is
// never called missing.
const STANDARD_PATH = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];

const runnable = (file) => { try { return statSync(file).isFile(); } catch { return false; } };
const isDir = (dir) => { try { return statSync(dir).isDirectory(); } catch { return false; } };
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

// ── the shell npm runs scripts with ─────────────────────────────────────────

// A value in an npmrc file, as npm's ini parser reads it: quoted, or up to an
// unescaped `;` or `#`.
function iniValue(raw) {
  let v = raw.trim();
  if (v.length > 1 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) {
    if (v[0] === "'") v = v.slice(1, -1);
    try { v = JSON.parse(v); } catch { /* kept as written */ }
    return v;
  }
  let out = "", esc = false;
  for (const c of v) {
    if (esc) { out += "\\;#".includes(c) ? c : "\\" + c; esc = false; }
    else if (c === ";" || c === "#") break;
    else if (c === "\\") esc = true;
    else out += c;
  }
  return (esc ? out + "\\" : out).trim();
}

// An npmrc file's settings outside any [section], the last of a key winning;
// {} when there is no such file.
function npmrc(file) {
  const out = {};
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return out; }
  let section = false;
  for (const line of text.split(/[\r\n]+/)) {
    if (/^\s*([;#]|$)/.test(line)) continue;
    if (/^\[[^\]]*\]\s*$/.test(line)) { section = true; continue; }
    const m = /^([^=]+)(=(.*))?$/.exec(line);
    if (!m || section) continue;
    const value = m[2] === undefined ? true : iniValue(m[3]);
    out[iniValue(m[1])] = ["true", "false", "null"].includes(value) ? JSON.parse(value) : value;
  }
  return out;
}

// ${NAME} in an npm setting is the environment's NAME, and ${NAME?} empty when
// it is unset, as npm replaces them.
const envReplace = (value, env) => value.replace(/(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g, (orig, esc, name, opt) =>
  (esc.length % 2 ? orig.slice((esc.length + 1) / 2) : esc.slice(esc.length / 2) + (env[name] ?? (opt ? "" : `\${${name}}`))));

// A glob's alternatives, its braces expanded: `{a,b}/*` is `a/*` and `b/*`.
function braces(glob) {
  const m = /\{([^{}]*)\}/.exec(glob);
  if (!m || !m[1].includes(",")) return [glob];
  return m[1].split(",").flatMap((alt) => braces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length)));
}

// Whether workspace patterns list the folder `rel`, as npm's globs do; a later
// pattern overrides an earlier one, and `!` excludes. `*`, `**`, `?` and braces
// are read; null when a pattern holds more, a class or an extended glob, which
// leaves the answer unknown.
function listed(patterns, rel) {
  const path = rel.split(sep).join("/");
  let hit = false, unsure = false;
  for (const pattern of patterns) {
    if (typeof pattern !== "string") continue;
    const bangs = /^!*/.exec(pattern)[0].length;
    const globs = braces(pattern.slice(bangs).replace(/^\.?\/+/, "").replace(/\/+$/, ""));
    if (globs.some((g) => /[[\]{}()!+@]|\.\./.test(g))) { unsure = true; continue; }
    const matches = globs.some((g) => new RegExp(`^${g.split("/").map((seg) => (seg === "**" ? ".*"
      : seg.replace(/[.+^$|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))).join("/")}$`).test(path));
    if (matches) hit = bangs % 2 === 0;
  }
  return unsure ? null : hit;
}

// The folders whose .npmrc may be the project's: the package's own, or that of
// the workspace root that lists it, which npm uses instead. Both, when whether
// the root lists it can't be told.
function npmProjects(dir) {
  for (let p = dirname(dir); ; p = dirname(p)) {
    const pkg = readJson(join(p, "package.json"));
    const patterns = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
    const isListed = Array.isArray(patterns) ? listed(patterns, relative(p, dir)) : false;
    if (isListed === true) return [p];
    if (isListed === null) return [p, dir];
    if (p === dirname(p)) return [dir];
  }
}

// The first file on the PATH called `name`, followed to where it really is.
const onPath = (name, env) => {
  for (const d of (env.PATH ?? "").split(delimiter)) {
    if (d && runnable(join(d, name))) try { return realpathSync(join(d, name)); } catch { /* next */ }
  }
  return null;
};

/**
 * A setting of npm's for the package in `dir`, read as npm reads it, taking
 * `project` for the folder of the project's `.npmrc`. The first of these that
 * sets it wins: the environment's `npm_config_*`, the project's `.npmrc`, the
 * user's, the global one, then npm's own. Undefined where none does.
 */
function npmSetting(key, project, env) {
  const home = env.HOME || homedir();
  const setting = (key, ...layers) => {
    for (const layer of layers) {
      if (layer[key] !== undefined) return typeof layer[key] === "string" ? envReplace(layer[key].trim(), env) : layer[key];
    }
  };
  const file = (value, fallback) => (typeof value !== "string" || !value ? fallback
    : value.startsWith("~/") ? join(home, value.slice(2)) : resolve(value));

  const fromEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^npm_config_/i.test(key) && value !== "") fromEnv[key.slice(11).replace(/(?!^)_/g, "-").toLowerCase()] = value;
  }
  const cli = onPath("npm", env);
  const builtin = cli ? npmrc(join(dirname(dirname(cli)), "npmrc")) : {};
  const userFile = (...layers) => file(setting("userconfig", fromEnv, ...layers, builtin), join(home, ".npmrc"));
  const projectFile = join(project, ".npmrc");
  const own = projectFile === userFile() ? {} : npmrc(projectFile);
  const user = npmrc(userFile(own));
  const node = onPath("node", env) ?? process.execPath;
  const prefix = env.PREFIX || (env.DESTDIR ? join(env.DESTDIR, dirname(dirname(node))) : dirname(dirname(node)));
  const global = npmrc(file(setting("globalconfig", fromEnv, own, user, builtin),
    join(file(setting("prefix", fromEnv, own, user, builtin), prefix), "etc", "npmrc")));
  return setting(key, fromEnv, own, user, global, builtin);
}

/**
 * The shells npm may run the scripts of the package in `dir` with: its
 * `script-shell` setting, or `sh`. One, unless which `.npmrc` is the project's
 * can't be told, and `projects` adds folders whose `.npmrc` may be read too. A
 * relative path is the package's. In an `.npmrc`, npm takes `true` for the
 * program true, and `false` for no setting.
 */
export function npmScriptShells(dir, env = process.env, projects = []) {
  dir = resolve(dir);
  const shells = [...npmProjects(dir), ...projects].map((project) => {
    const setting = npmSetting("script-shell", project, env);
    const shell = setting === true ? "true" : setting;
    if (typeof shell !== "string" || !shell) return "sh";
    return shell.includes("/") && !isAbsolute(shell) ? resolve(dir, shell) : shell;
  });
  return [...new Set(shells)];
}

const readText = (file) => { try { return readFileSync(file, "utf8"); } catch { return ""; } };
// The nearest folder from `dir` up that holds `name`, or null.
const ancestorWith = (dir, name) => {
  for (let p = dir; ; p = dirname(p)) {
    try { statSync(join(p, name)); return p; } catch { /* up */ }
    if (p === dirname(p)) return null;
  }
};

/**
 * The shells a package's scripts may run under, as its runner picks one: npm,
 * pnpm and yarn 1 their `script-shell` setting or `sh`, and bun the first of
 * bash, sh and zsh on the PATH. Null for a runner whose shell the reader doesn't
 * model: yarn 2 and later run scripts in a shell of their own, and pnpm and bun
 * do too when told to. Then no script is judged.
 */
export function runnerShells(dir, packageManager, env = process.env) {
  dir = resolve(dir);
  const home = env.HOME || homedir();
  switch (packageManager ?? "npm") {
    case "npm":
      return npmScriptShells(dir, env);
    case "pnpm": {
      // pnpm reads npm's config files, its workspace root's among them, and
      // pnpm-workspace.yaml; its shell emulator is a shell of its own.
      const root = ancestorWith(dir, "pnpm-workspace.yaml");
      const yaml = root ? readText(join(root, "pnpm-workspace.yaml")) : "";
      if (/^\s*shellEmulator:\s*true\b/m.test(yaml)) return null;
      if ([dir, ...(root ? [root] : [])].some((project) => npmSetting("shell-emulator", project, env) === true)) return null;
      const fromYaml = /^\s*scriptShell:\s*["']?([^"'\s#]+)/m.exec(yaml)?.[1];
      return [...new Set([...npmScriptShells(dir, env, root ? [root] : []), ...(fromYaml ? [fromYaml] : [])])];
    }
    case "yarn": {
      // yarn 2 and later: .yarnrc.yml, a packageManager of yarn@2 or later, or
      // a lockfile of theirs.
      const pkg = readJson(join(dir, "package.json"));
      if (ancestorWith(dir, ".yarnrc.yml") || /^yarn@([2-9]|\d{2,})/.test(String(pkg?.packageManager ?? ""))
          || /^__metadata:/m.test(readText(join(dir, "yarn.lock")))) return null;
      // yarn 1: `sh`, or `script-shell` from a .yarnrc or npm's files.
      const rc = [join(dir, ".yarnrc"), join(home, ".yarnrc")]
        .map((file) => /^\s*"?script-shell"?\s+"?([^"\s]+)"?/m.exec(readText(file))?.[1]).filter(Boolean);
      return [...new Set([...npmScriptShells(dir, env), ...rc])];
    }
    case "bun": {
      // bun's own shell when bunfig.toml says so, and otherwise the first of
      // bash, sh and zsh on the PATH.
      const config = [join(dir, "bunfig.toml"), join(env.XDG_CONFIG_HOME || join(home, ".config"), ".bunfig.toml"), join(home, ".bunfig.toml")]
        .map(readText).join("\n");
      if (/^\s*shell\s*=\s*["']bun["']/m.test(config)) return null;
      const shell = ["bash", "sh", "zsh"].map((name) => onPath(name, env)).find(Boolean);
      return shell ? [shell] : null;
    }
    default:
      return null;
  }
}

// Operators bash has and dash doesn't: `|&` and `<<<`, which dash reads as a
// syntax error, as it does `>&` before a file's name; and `&>` and `&>>`, which
// it reads as `&` and then a redirection.
const SYNTAX = ["|&", "<<<", "&>", "&>>", ">&"];

const asked = new Map();
/**
 * A shell, as `{ name, paths, builtins, keywords, execOptions, execEndsOptions,
 * appendAssign, pipefail, badOptionEnds, syntax, unsetLastOptionWins,
 * pTakesOperands, readonlyAssignEnds }`, asked once: which of the candidate
 * words it treats as its own, whether its `exec` takes options, and `--`,
 * whether `NAME+=value` assigns, whether it has `set -o pipefail`, whether a
 * `set` option it doesn't have ends it, which of bash's operators it has, in
 * `syntax`, whether `unset` takes the last of `-f` and `-v` where both are
 * given, whether `readonly -p` and `export -p` take their operands, and whether
 * assigning a read-only variable ends it. Null when it can't be asked, or
 * answers as no shell does; then no script is judged.
 */
export function scriptShell(path = "sh") {
  if (asked.has(path)) return asked.get(path);
  const r = spawnSync(path, ["-c",
    'printf "shell\\t%s\\n" "$(readlink -f "$(command -v "$1")" 2>/dev/null || printf %s "$1")"; shift; ' +
    'if (exec -a probe true) >/dev/null 2>&1; then printf "exec-options\\tyes\\n"; fi; ' +
    'if (exec -- true) >/dev/null 2>&1; then printf "exec-ends-options\\tyes\\n"; fi; ' +
    'if (x=a; x+=b; test "$x" = ab) >/dev/null 2>&1; then printf "append-assign\\tyes\\n"; fi; ' +
    'if (set -o pipefail) >/dev/null 2>&1; then printf "pipefail\\tyes\\n"; fi; ' +
    'if ! (set -o reeve-no-such-option; exit 0) >/dev/null 2>&1; then printf "bad-option-ends\\tyes\\n"; fi; ' +
    'if (x=1; unset -fv x; test -z "${x+set}") >/dev/null 2>&1 && (x=1; unset -vf x; test -n "${x+set}") >/dev/null 2>&1; ' +
    'then printf "unset-last-option-wins\\tyes\\n"; fi; ' +
    'if (readonly -p x=1 >/dev/null; test "${x-}" = 1) >/dev/null 2>&1; then printf "p-takes-operands\\tyes\\n"; fi; ' +
    'if ! (readonly x=1; x=2; exit 0) >/dev/null 2>&1; then printf "readonly-assign-ends\\tyes\\n"; fi; ' +
    // Each operator in a shell of its own, since a syntax error ends the shell
    // it's read in. dash reads `&>` as `&` and a redirection, which leaves the
    // command's output where it was.
    'if (eval "true |& true") >/dev/null 2>&1; then printf "syntax\\t|&\\n"; fi; ' +
    'if (eval ": <<< x") >/dev/null 2>&1; then printf "syntax\\t<<<\\n"; fi; ' +
    'if (x=$(echo x &>/dev/null); test -z "$x") >/dev/null 2>&1; then printf "syntax\\t&>\\n"; fi; ' +
    'if (x=$(echo x &>>/dev/null); test -z "$x") >/dev/null 2>&1; then printf "syntax\\t&>>\\n"; fi; ' +
    'if (eval ": >& /dev/null") >/dev/null 2>&1; then printf "syntax\\t>&\\n"; fi; ' +
    'for w in "$@"; do printf "%s\\t" "$w"; command -V "$w" 2>&1 | head -n 1; done', "sh", path, ...CANDIDATES],
    { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 10_000 });
  let shell = null, answered = false;
  if (r.status === 0 && r.stdout) {
    shell = { name: basename(path), paths: [path], builtins: new Set(), keywords: new Set(),
              execOptions: false, execEndsOptions: false, appendAssign: false, pipefail: false, badOptionEnds: false,
              syntax: Object.fromEntries(SYNTAX.map((op) => [op, false])), unsetLastOptionWins: false, pTakesOperands: false,
              readonlyAssignEnds: false };
    for (const line of r.stdout.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const word = line.slice(0, tab), said = line.slice(tab + 1);
      if (word === "shell") { shell.name = basename(said) || shell.name; answered = true; }
      else if (word === "exec-options") shell.execOptions = true;
      else if (word === "exec-ends-options") shell.execEndsOptions = true;
      else if (word === "append-assign") shell.appendAssign = true;
      else if (word === "pipefail") shell.pipefail = true;
      else if (word === "bad-option-ends") shell.badOptionEnds = true;
      else if (word === "syntax" && SYNTAX.includes(said)) shell.syntax[said] = true;
      else if (word === "unset-last-option-wins") shell.unsetLastOptionWins = true;
      else if (word === "p-takes-operands") shell.pTakesOperands = true;
      else if (word === "readonly-assign-ends") shell.readonlyAssignEnds = true;
      else if (/ is a (special )?shell builtin$/.test(said)) shell.builtins.add(word);
      else if (/ is a (shell keyword|reserved word)$/.test(said)) shell.keywords.add(word);
    }
  }
  // A "shell" that ran without answering isn't one: npm's script-shell can be
  // `true`, or `echo`, which pass whatever the script says.
  if (!answered) shell = null;
  asked.set(path, shell);
  return shell;
}

// Whether shells that may run a script all have something: true, false, or
// "maybe" when some do and some don't.
const allHave = (values) => (values.every((v) => v === true) ? true : values.every((v) => v === false) ? false : "maybe");

/**
 * The shell a script runs under when it may be any of several, as one: a word
 * is its own when any of them has it, exec takes options when any exec does,
 * and `NAME+=value` assigns when any shell assigns it. So no word is called
 * missing that one of them has. pipefail, how a bad option ends, bash's
 * operators, how unset and -p read their options, and whether a read-only
 * assignment ends the shell are "maybe" where they differ. Null when any can't
 * be asked.
 */
export function scriptShells(paths) {
  const shells = (paths ?? []).map((path) => scriptShell(path));
  if (!shells.length || shells.includes(null)) return null;
  if (shells.length === 1) return shells[0];
  return { name: [...new Set(shells.map((s) => s.name))].join(" or "), paths: shells.flatMap((s) => s.paths),
           builtins: new Set(shells.flatMap((s) => [...s.builtins])), keywords: new Set(shells.flatMap((s) => [...s.keywords])),
           execOptions: shells.some((s) => s.execOptions), execEndsOptions: shells.some((s) => s.execEndsOptions),
           appendAssign: shells.some((s) => s.appendAssign), pipefail: allHave(shells.map((s) => s.pipefail)),
           badOptionEnds: allHave(shells.map((s) => s.badOptionEnds)),
           syntax: Object.fromEntries(SYNTAX.map((op) => [op, allHave(shells.map((s) => s.syntax[op]))])),
           unsetLastOptionWins: allHave(shells.map((s) => s.unsetLastOptionWins)),
           pTakesOperands: allHave(shells.map((s) => s.pTakesOperands)),
           readonlyAssignEnds: allHave(shells.map((s) => s.readonlyAssignEnds)) };
}

const told = new Map();
/**
 * What a shell calls a word it gave no answer about: "builtin", "keyword",
 * "unknown" when it couldn't say, or null for neither. Asked of every shell the
 * script may run under, and remembered. Builtins come from versions and modules
 * that no list keeps up with.
 */
function ownWord(shell, word) {
  const key = `${(shell?.paths ?? []).join("\u0000")}\u0000${word}`;
  if (told.has(key)) return told.get(key);
  let kind = null;
  for (const path of shell?.paths ?? []) {
    const r = spawnSync(path, ["-c", 'command -V "$1" 2>&1 | head -n 1', "sh", word],
      { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 10_000 });
    if (r.status === null) { kind ??= "unknown"; continue; }
    if (/ is a (special )?shell builtin/.test(r.stdout)) { kind = "builtin"; break; }
    if (/ is a (shell keyword|reserved word)/.test(r.stdout)) kind = "keyword";
  }
  told.set(key, kind);
  return kind;
}

// ── reading ─────────────────────────────────────────────────────────────────

// The end of an expansion starting at `i` ($name, ${...}, $(...), $((...)) or a
// backquoted command), or -1 when it doesn't end.
function expansionEnd(s, i) {
  if (s[i] === "`") {
    for (let j = i + 1; j < s.length; j++) { if (s[j] === "\\") { j++; continue; } if (s[j] === "`") return j + 1; }
    return -1;
  }
  const open = s[i + 1];
  if (open === "(" || open === "{") {
    const close = open === "(" ? ")" : "}";
    let depth = 0;
    for (let j = i + 1; j < s.length; j++) {
      const c = s[j];
      if (c === "\\") { j++; continue; }
      if (c === "'") { const end = s.indexOf("'", j + 1); if (end < 0) return -1; j = end; continue; }
      if (c === '"') {
        let k = j + 1;
        for (; k < s.length && s[k] !== '"'; k++) if (s[k] === "\\") k++;
        if (k >= s.length) return -1;
        j = k; continue;
      }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return j + 1;
    }
    return -1;
  }
  const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9#?*@!$-])?/.exec(s.slice(i));
  return i + m[0].length;
}

/**
 * The script's tokens: words, operators and redirections, split as the shell
 * splits them. A word carries whether any of it was quoted, the part before its
 * first quote, whether it holds an expansion, a command substitution among
 * them, and whether it holds an unquoted pathname pattern. A redirection says
 * whether it writes a file, and whether it may fail. An operator only bash and
 * its kin have carries `syntax`, and `otherwise`, the tokens a shell without it
 * reads. Null for what isn't read: an unbalanced quote, a here-document, or
 * case syntax.
 */
export function tokenize(body) {
  const s = String(body), tokens = [];
  let i = 0;
  const word = () => {
    let text = "", bare = null, expansion = false, subst = false, glob = false;
    const quote = () => { if (bare === null) bare = text; };
    const expand = (from, end) => {
      if (end > from + 1) expansion = true;
      if (/\$\(|`/.test(s.slice(from, end))) subst = true;
      text += s.slice(from, end);
    };
    while (i < s.length) {
      const c = s[i];
      if (c === " " || c === "\t" || c === "\n" || ";&|()<>".includes(c)) break;
      if (c === "\\") {
        if (i + 1 >= s.length) return undefined;
        if (s[i + 1] === "\n") { i += 2; continue; }   // a line continuation
        quote(); text += s[i + 1]; i += 2; continue;
      }
      if (c === "'") {
        const end = s.indexOf("'", i + 1);
        if (end < 0) return undefined;
        quote(); text += s.slice(i + 1, end); i = end + 1; continue;
      }
      if (c === '"') {
        quote();
        let j = i + 1;
        while (j < s.length && s[j] !== '"') {
          if (s[j] === "\\" && '"\\$`\n'.includes(s[j + 1] ?? "")) { if (s[j + 1] !== "\n") text += s[j + 1]; j += 2; continue; }
          if (s[j] === "$" || s[j] === "`") {
            const end = expansionEnd(s, j);
            if (end < 0) return undefined;
            expand(j, end); j = end; continue;
          }
          text += s[j++];
        }
        if (j >= s.length) return undefined;
        i = j + 1; continue;
      }
      if (c === "$" || c === "`") {
        const end = expansionEnd(s, i);
        if (end < 0) return undefined;
        expand(i, end); i = end; continue;
      }
      // An unquoted pattern, replaced by the files it matches before it runs.
      if (c === "*" || c === "?" || (c === "[" && /^\[[^\s\]]*\]/.test(s.slice(i)))) glob = true;
      // An unquoted tilde leading the word, or a value after `=` or `:`, is a
      // home folder: expanded before the word is used.
      if (c === "~" && bare === null && (text === "" || /[=:]$/.test(text))) expansion = true;
      text += c; i++;
    }
    return { t: "word", text, quoted: bare !== null, bare: bare ?? text, expansion, subst, glob };
  };
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t") { i++; continue; }
    // A line continuation between words joins the lines, and is no word.
    if (c === "\\" && s[i + 1] === "\n") { i += 2; continue; }
    if (c === "#") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === "\n") {
      // After `&&`, `||` or `|` a newline only continues the line.
      if (!["&&", "||", "|"].includes(tokens.at(-1)?.op)) tokens.push({ t: "op", op: ";", newline: true });
      i++; continue;
    }
    if (s.startsWith(";;", i) || s.startsWith(";&", i)) return null;
    // A redirection, after a descriptor's number or not; bash's `&>` and `&>>`
    // take none.
    const r = /^(\d*)(<<<|<<-?|<>|>>|>\||>&|<&|<|>)/.exec(s.slice(i)) ?? /^()(&>>?)/.exec(s.slice(i));
    if (r) {
      if (r[2] === "<<" || r[2] === "<<-") return null;   // a here-document's body follows, unread
      i += r[0].length;
      while (s[i] === " " || s[i] === "\t") i++;
      const target = word();
      if (!target || (target.text === "" && !target.quoted)) return null;
      // `>&2` and `>&-` only point at a descriptor; the rest write a file.
      const writes = [">", ">>", ">|", "<>", "&>", "&>>"].includes(r[2]) || (r[2] === ">&" && !/^(\d+|-)$/.test(target.text));
      // A redirection can fail, and then its command doesn't run: a file that
      // isn't there, a folder that can't be written, a descriptor that isn't
      // open. The null device, a here-string and the standard descriptors can't.
      const mayFail = !(r[2] === "<<<" || (target.text === "/dev/null" && !target.expansion)
        || ((r[2] === ">&" || r[2] === "<&") && /^[012-]$/.test(target.text)));
      const token = { t: "redir", writes, subst: target.subst, expansion: target.expansion, mayFail };
      // dash reads bash's `&>` as `&` and then a redirection, and its `<<<`, and
      // `>&` before a file, as syntax errors.
      if (r[2] === "&>" || r[2] === "&>>") tokens.push({ ...token, syntax: r[2], otherwise: [{ t: "op", op: "&" }, token] });
      else if (r[2] === "<<<") tokens.push({ ...token, syntax: r[2], otherwise: [{ t: "error", what: "'<<<'" }] });
      else if (r[2] === ">&" && writes && !target.expansion) tokens.push({ ...token, syntax: r[2], otherwise: [{ t: "error", what: "'>&' before a file" }] });
      else tokens.push(token);
      continue;
    }
    const op = ["&&", "||", "|&", ";", "&", "|"].find((o) => s.startsWith(o, i));
    if (op) {
      // bash's `|&` pipes both outputs; dash reads it as a syntax error.
      tokens.push(op === "|&" ? { t: "op", op: "|", syntax: op, otherwise: [{ t: "error", what: "'|&'" }] } : { t: "op", op });
      i += op.length; continue;
    }
    if (c === "(" || c === ")") { tokens.push({ t: c }); i++; continue; }
    const w = word();
    if (!w) return null;
    tokens.push(w);
  }
  return tokens;
}

// ── running, as far as can be told ──────────────────────────────────────────
//
// An outcome is `ok` (certainly succeeds), `fail` (certainly fails, with `why`)
// or `?`. `stop` says whether the script ends there: true, false or "maybe".
// `mutates` says it may have changed files, or what a later lookup reads, after
// which a program found missing may be there after all: `npm ci && jest`
// installs jest before it runs.

const OK = { o: "ok" }, UNKNOWN = { o: "?" };
const failing = (why) => ({ o: "fail", why });
const statusOf = (r) => ({ o: r.o, why: r.why });
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const APPEND = /^[A-Za-z_][A-Za-z0-9_]*\+=/;

// An assignment is a word whose name and `=` weren't quoted; its value is what
// follows the `=`. In a shell that has it, `NAME+=value` is one too, whose value
// is whatever NAME held, and more.
const assignment = (w, shell) => {
  if (ASSIGNMENT.test(w.bare)) {
    const eq = w.text.indexOf("=");
    return { name: w.text.slice(0, eq), value: { text: w.text.slice(eq + 1), expansion: w.expansion } };
  }
  if (shell?.appendAssign && APPEND.test(w.bare)) return { name: w.text.slice(0, w.text.indexOf("+=")), value: null };
  return null;
};

// The folders a literal PATH value names, as written, or null when it holds an
// expansion, or adds to what PATH held, and can't be known. A relative one, the
// empty one included, is found from wherever the script is when it looks a
// program up.
const literalPath = (value) => (!value || value.expansion ? null : value.text.split(":"));

// Whether a package.json in `dir` depends on `name`.
const declares = (dir, name) => {
  const pkg = readJson(join(dir, "package.json"));
  return [pkg?.dependencies, pkg?.devDependencies].some((deps) => deps !== null && typeof deps === "object" && Object.hasOwn(deps, name));
};

/**
 * Whether `name` runs as a program: true, false, or null when that can't be
 * told. A name with a slash is a file, from the script's folder. Otherwise, with
 * `path` undefined it is found as npm finds it: a runner every setup has, a
 * dependency of the package or of a folder above it such as a workspace root,
 * any `node_modules/.bin` from the package up, or the PATH. With a literal PATH
 * given, only there. A file found is taken to run, as setup detection always
 * has: a missing execute bit is a broken install, not a missing tool.
 */
function found(name, path, pkg, cwd) {
  if (name.includes("/")) return isAbsolute(name) ? runnable(name) : cwd === null ? null : runnable(resolve(cwd, name));
  if (path === null) return null;
  if (path === undefined) {
    if (pkg.deps[name] || /^(node|tsc|pnpm|npm|yarn|turbo|nx)$/.test(name)) return true;
    for (let d = pkg.dir; ; d = dirname(d)) {
      if (runnable(join(d, "node_modules", ".bin", name)) || (d !== pkg.dir && declares(d, name))) return true;
      if (d === dirname(d)) break;
    }
    path = (process.env.PATH ?? "").split(delimiter);
  }
  let unsure = false;
  for (const d of path) {
    if (!isAbsolute(d) && cwd === null) { unsure = true; continue; }
    if (runnable(join(isAbsolute(d) ? d : resolve(cwd, d), name))) return true;
  }
  return unsure ? null : false;
}

/**
 * Which program by the name `name` runs: "system", the machine's own, in a
 * folder the PATH npm runs with names in full, or in a standard folder of a
 * PATH given; "local", one the package or a folder above it brings, which npm
 * puts first on its PATH, or one in any other folder; "missing"; or null when
 * that can't be told.
 */
function locate(name, path, pkg, cwd) {
  if (path === null) return null;
  let system = (d) => STANDARD_PATH.includes(d);
  if (path === undefined) {
    if (pkg.deps[name]) return "local";
    for (let d = pkg.dir; ; d = dirname(d)) {
      if (runnable(join(d, "node_modules", ".bin", name)) || (d !== pkg.dir && declares(d, name))) return "local";
      if (d === dirname(d)) break;
    }
    path = (process.env.PATH ?? "").split(delimiter);
    system = (d) => isAbsolute(d);
  }
  for (const d of path) {
    if (!isAbsolute(d) && cwd === null) return null;
    if (runnable(join(isAbsolute(d) ? d : resolve(cwd, d), name))) return system(d) ? "system" : "local";
  }
  return "missing";
}

/**
 * A program's words, run as a program. `named` says they follow `command`,
 * `exec` or a wrapper, where a reserved word is only a name.
 */
function program(words, path, state, ctx, named = false) {
  const [name, ...rest] = words;
  if (!name) return OK;
  if (name.expansion || name.glob) return { o: "?", mutates: true };
  const wrapped = wrapper(name.text, rest, path, state, ctx);
  if (wrapped) return wrapped;
  const is = found(name.text, path, ctx.pkg, state.cwd);
  if (is !== false) return { o: "?", mutates: true };
  // Something that ran before may have made it: an install, a build, a file
  // written. Missing now isn't proof then.
  if (state.mutated) return UNKNOWN;
  const shell = ctx.shell;
  // A word the shell's lists don't hold is asked of the shell itself before it
  // is called missing: builtins come from versions and modules no list keeps up
  // with. One the reader doesn't model is unknown, and so is a keyword, which
  // may open a compound: nothing after it is read.
  const own = shell && !shell.builtins.has(name.text) && !shell.keywords.has(name.text) ? ownWord(shell, name.text) : null;
  if (own === "builtin" || own === "unknown") return { o: "?", mutates: true };
  if (own === "keyword" && !name.quoted && !named) return { o: "?", opaque: true };
  if (CANDIDATES.includes(name.text) && shell) {
    return failing(shell.keywords.has(name.text) || shell.builtins.has(name.text) || own === "keyword"
      ? `runs '${name.text}' as a program, and none is installed: the shell's own '${name.text}' isn't what runs there`
      : `uses '${name.text}', which ${shell.name}, the shell that runs the script, doesn't have`);
  }
  if (ASSIGNMENT.test(name.text))
    return failing(`runs '${name.text}' as a program: only env takes an assignment after its own name`);
  if (Array.isArray(path)) return failing(`runs '${name.text}' with a PATH it isn't found in`);
  return failing(`runs '${name.text}', which is neither a dependency nor installed`);
}

// Programs that run the command after them: env, nohup, and time where it is a
// program rather than the shell's own word. Each one's options are its own, and
// known only for the system's: a local program by the name, which npm's PATH
// finds first, runs instead and does whatever it does.
function wrapper(name, rest, path, state, ctx) {
  let i = 0, p = path, cwd = state.cwd;
  if (["env", "nohup", "time"].includes(name) && !["system", "missing"].includes(locate(name, path, ctx.pkg, state.cwd)))
    return { o: "?", mutates: true };
  if (name === "env") {
    for (; i < rest.length; i++) {
      const w = rest[i], o = w.text;
      if (!o.startsWith("-") || o === "-") break;
      if (o === "--") { i++; break; }
      if (w.expansion || w.glob || /^-(S|-split-string)/.test(o)) return { o: "?", mutates: true };
      let m;
      if (/^-[iv0]+$/.test(o) || o === "--ignore-environment") {
        // With the environment emptied, env's own exec looks in the standard path.
        if (o.includes("i")) p = STANDARD_PATH;
      } else if ((m = /^(?:-u|--unset)(?:=?(.+))?$/.exec(o))) {
        if ((m[1] ?? rest[++i]?.text) === "PATH") p = STANDARD_PATH;
      } else if ((m = /^(?:-C|--chdir)(?:=?(.+))?$/.exec(o))) {
        // The folder the command runs in, which a relative name is found from.
        const to = m[1] !== undefined ? { text: m[1], expansion: false } : rest[++i];
        cwd = !to || to.expansion || to.glob || cwd === null ? null : resolve(cwd, to.text);
      } else {
        return { o: "?", mutates: true };
      }
    }
    if (rest[i]?.text === "-") { p = STANDARD_PATH; i++; }
    // env takes every word with an `=` in it for an assignment, quoted or not,
    // up to the first that has none.
    for (; i < rest.length && rest[i].text.indexOf("=") > 0; i++) {
      if (rest[i].text.startsWith("PATH=")) p = literalPath({ text: rest[i].text.slice(5), expansion: rest[i].expansion });
    }
  } else if (name === "nohup") {
    if (rest[0]?.text === "--") i = 1;
  } else if (name === "time") {
    for (; i < rest.length && rest[i].text.startsWith("-"); i++) {
      const o = rest[i].text;
      if (o === "--") { i++; break; }
      if (o === "-f" || o === "-o") { i++; continue; }
      if (!/^(-[pvqa]+|--(portability|verbose|quiet|append|format=.*|output=.*))$/.test(o)) return { o: "?", mutates: true };
    }
  } else return null;
  if (i >= rest.length) return name === "env" ? OK : UNKNOWN;
  const inner = program(rest.slice(i), p, cwd === state.cwd ? state : { ...state, cwd }, ctx, true);
  if (inner.o === "fail") return inner;
  return found(name, path, ctx.pkg, state.cwd) === false && !state.mutated
    ? failing(`runs '${name}', which is neither a dependency nor installed`) : { ...inner, mutates: true };
}

// Builtins that change nothing a later command finds, except what `builtin`
// follows itself: PATH, the folder, set -e, traps. `command` and `exec` change
// what the command they run changes. Any other builtin may change anything.
const PURE = new Set(["true", ":", "false", "exit", "set", "export", "readonly", "unset", "cd", "trap", "alias",
  "unalias", "echo", "printf", "pwd", "umask", "test", "[", "shift", "type", "wait", "jobs", "times", "command", "exec"]);

// set's options by letter, as bash and dash name them.
const SET_LETTERS = { a: "allexport", b: "notify", B: "braceexpand", C: "noclobber", e: "errexit", E: "errtrace", f: "noglob",
  h: "hashall", H: "histexpand", I: "ignoreeof", k: "keyword", m: "monitor", n: "noexec", p: "privileged", P: "physical",
  t: "onecmd", T: "functrace", u: "nounset", v: "verbose", V: "vi", x: "xtrace" };
// Options that change nothing the reader judges: what is printed or exported,
// how patterns match, and errors, such as an unset variable's, that only make
// a script fail more.
const UNJUDGED_OPTIONS = new Set(["allexport", "notify", "braceexpand", "noclobber", "errtrace", "noglob", "hashall", "ignoreeof",
  "monitor", "privileged", "functrace", "nounset", "verbose", "vi", "emacs", "xtrace", "history", "interactive-comments", "nolog"]);

/**
 * One of set's options, turned on or off: errexit and pipefail are followed,
 * and one that changes nothing judged is passed over. In a shell without
 * pipefail, setting it is an error, which may end the shell. Any other option
 * may change what runs, noexec say, which runs nothing more: nothing after it
 * is read. The outcome that ends the command, or null.
 */
function setOption(name, on, state, shell) {
  if (name === "errexit") state.errexit = on;
  else if (name === "pipefail") {
    if (shell?.pipefail === true) state.pipefail = on;
    else if (shell?.pipefail === false)
      return { ...failing(`uses 'set -o pipefail', which ${shell.name}, the shell that runs the script, doesn't have`), stop: shell.badOptionEnds ?? "maybe" };
    else return { o: "?", opaque: true };
  } else if (!UNJUDGED_OPTIONS.has(name)) return { o: "?", opaque: true };
  return null;
}

/**
 * PATH assigned in `state`. While it is read-only the assignment fails, and PATH
 * keeps its value: dash ends there, and bash goes on. The outcome of a failed
 * assignment, or null.
 */
function assignPath(state, path, what = "assigns PATH") {
  if (state.pathReadonly === true) return { ...failing(`${what} after making it read-only, which fails`), stop: "maybe" };
  if (state.pathReadonly === "maybe") { state.path = null; return { o: "?", stop: "maybe" }; }
  state.path = path;
  return null;
}

// A builtin of the shell, run in `state`.
function builtin(name, args, path, state, ctx) {
  const text = args.map((a) => a.text);
  switch (name) {
    case "true": case ":": return OK;
    case "false": return failing("always fails: 'false' never succeeds");
    case "exit": {
      if (!args.length) return { ...state.status, stop: true };   // with the status just before
      if (args[0].expansion) return { o: "?", stop: true };
      const n = Number(text[0]);
      if (!Number.isInteger(n)) return { o: "?", stop: true };
      return n % 256 === 0 ? { o: "ok", stop: true } : { ...failing(`always fails: it exits ${n}`), stop: true };
    }
    case "set":
      // Options, until `--`, `-` or the first word that isn't one: the rest are
      // positional parameters, which change nothing here. `o` takes the next
      // word as an option's name, and alone lists them. An option an expansion
      // gives may be any.
      for (let k = 0; k < args.length; k++) {
        if (args[k].expansion || args[k].glob) return { o: "?", opaque: true };
        const m = /^([-+])([a-zA-Z]+)$/.exec(text[k]);
        if (!m) break;
        for (const letter of m[2]) {
          if (letter === "o" && ++k >= args.length) return OK;
          if (letter === "o" && (args[k].expansion || args[k].glob)) return { o: "?", opaque: true };
          const r = setOption(letter === "o" ? text[k] : SET_LETTERS[letter] ?? letter, m[1] === "-", state, ctx.shell);
          if (r) return r;
        }
      }
      return OK;
    case "export": case "readonly": {
      // -f names functions, which PATH isn't. -p lists: dash then takes no
      // operand at all, and bash takes them as it would without it. A read-only
      // PATH keeps its value.
      let k = 0, r = OK, listing = false;
      for (; k < args.length && /^-[a-zA-Z]+$/.test(text[k]); k++) {
        if (text[k].includes("f")) return OK;
        if (text[k].includes("p")) listing = true;
      }
      if (text[k] === "--") k++;
      if (listing && ctx.shell?.pTakesOperands === false) return OK;
      if (listing && ctx.shell?.pTakesOperands !== true) {
        // Whether PATH took a value, or was made read-only, depends on the
        // shell. A bare name gives it no value in either.
        const operands = args.slice(k);
        if (operands.some((w) => assignment(w, ctx.shell)?.name === "PATH" || w.expansion)) state.path = null;
        if (name === "readonly" && state.pathReadonly === false
            && operands.some((w) => (assignment(w, ctx.shell)?.name ?? w.text) === "PATH" || w.expansion)) state.pathReadonly = "maybe";
        return UNKNOWN;
      }
      for (const w of args.slice(k)) {
        const a = assignment(w, ctx.shell);
        if (a?.name === "PATH") r = assignPath(state, literalPath(a.value)) ?? r;
        if (name === "readonly" && (a?.name ?? w.text) === "PATH") state.pathReadonly = true;
      }
      return r;
    }
    case "unset": {
      // With PATH unset, dash and bash look programs up in the current folder
      // only. -f unsets functions, which PATH isn't, and -v variables. Given
      // both, dash takes the last, and bash refuses the command and unsets
      // neither. A name an expansion gives may be PATH.
      let k = 0, fn = false, vars = false, last = null;
      for (; k < args.length && /^-[a-zA-Z]+$/.test(text[k]); k++) {
        for (const c of text[k].slice(1)) if (c === "f" || c === "v") { last = c; if (c === "f") fn = true; else vars = true; }
      }
      if (text[k] === "--") k++;
      const lastWins = fn && vars ? ctx.shell?.unsetLastOptionWins : null;
      if (lastWins === false) return UNKNOWN;
      // Given both, in a shell that may take the last or refuse the command: it
      // may fail, and with -f last it unsets no variable in either.
      const unsure = fn && vars && lastWins !== true;
      const outcome = unsure ? UNKNOWN : OK;
      if (fn && (!vars || last === "f")) return outcome;
      for (const w of args.slice(k)) {
        if (w.expansion || w.glob || (unsure && w.text === "PATH")) {
          if (state.pathReadonly !== false) return { o: "?", stop: "maybe" };
          state.path = null;
        } else if (w.text === "PATH") {
          const r = assignPath(state, [""], "unsets PATH");
          if (r) return r;
        }
      }
      return outcome;
    }
    case "cd": {
      let k = 0;
      while (/^-[LPe@]+$/.test(text[k] ?? "")) k++;
      if (text[k] === "--") k++;
      const to = args[k];
      // Only a folder that is there, named as written, is known to be where the
      // script goes: CDPATH can send a bare name elsewhere.
      const target = !to || to.expansion || to.glob || to.text === "-" || (process.env.CDPATH && !/^\.{0,2}\//.test(to.text)) ? null
        : isAbsolute(to.text) ? to.text : state.cwd === null ? null : resolve(state.cwd, to.text);
      state.cwd = target !== null && isDir(target) ? target : null;
      return UNKNOWN;
    }
    case "trap":
      // A trap can end the script with a status of its own.
      if (args.length) state.trapped = true;
      return OK;
    case "alias":
      // An alias defined here can change what any later word runs.
      return args.some((a) => a.text.includes("=")) ? { o: "?", opaque: true } : args.length ? UNKNOWN : OK;
    case "echo": case "pwd":
      return OK;
    case "printf":
      // bash's `printf -v` sets a variable, which may be PATH.
      return /^-v/.test(text[0] ?? "") ? { o: "?", mutates: true } : UNKNOWN;
    case "command": {
      let k = 0, p = path;
      for (; k < args.length && args[k].text.startsWith("-"); k++) {
        if (args[k].text === "--") { k++; break; }
        if (/[vV]/.test(args[k].text)) return UNKNOWN;   // only looks a program up
        if (!/^-p+$/.test(args[k].text)) return UNKNOWN;
        p = STANDARD_PATH;   // the standard path, whatever PATH says
      }
      // What follows names a command, never a reserved word: `command if` runs
      // a program called if.
      return args.length > k ? command(args.slice(k), p, state, ctx, true) : OK;
    }
    case "exec": {
      let k = 0;
      // Only a shell whose exec takes options reads them: dash's takes none,
      // and runs a program called -a, or one called --.
      if (ctx.shell?.execOptions) {
        for (; k < args.length && args[k].text.startsWith("-"); k++) {
          if (args[k].text === "--") { k++; break; }
          if (args[k].text === "-a") k++;
          else if (!/^-[cl]+$/.test(args[k].text)) return { o: "?", mutates: true };
        }
      } else if (ctx.shell?.execEndsOptions && text[0] === "--") k = 1;
      if (args.length <= k) return OK;
      // The program replaces the shell, which ends with it.
      return { ...program(args.slice(k), path, state, ctx, true), stop: true };
    }
    default: return UNKNOWN;
  }
}

/**
 * One command's words, after its leading assignments: a keyword, a builtin, a
 * wrapper or a program. After `command`, `exec` or a wrapper, a word shaped like
 * an assignment is a program's name, and so is a reserved word: `named` says
 * the words follow `command`.
 */
function command(words, path, state, ctx, named = false) {
  const [name, ...args] = words;
  if (name.expansion || name.glob) return { o: "?", mutates: true };
  const shell = ctx.shell;
  if (!shell && CANDIDATES.includes(name.text)) return { o: "?", mutates: true };
  if (named && !shell?.builtins.has(name.text)) return program(words, path, state, ctx, true);
  if (!name.quoted && shell?.keywords.has(name.text)) {
    if (name.text !== "time") return { o: "?", opaque: true };
    // The shell's own `time` times the command after it, assignments and all.
    let k = 0;
    while (args[k]?.text === "-p") k++;
    if (args[k]?.text === "--") k++;
    return args.length > k ? simple(args.slice(k), state, ctx) : OK;
  }
  if (shell?.builtins.has(name.text)) {
    const r = builtin(name.text, args, path, state, ctx);
    return PURE.has(name.text) ? r : { ...r, mutates: true };
  }
  return program(words, path, state, ctx);
}

/** One simple command in `state`: its leading assignments, then its command. */
function simple(words, state, ctx) {
  if (!words.length) return OK;
  let k = 0, path = state.path;
  for (let a; k < words.length && (a = assignment(words[k], ctx.shell)); k++) if (a.name === "PATH") path = literalPath(a.value);
  const assigned = words.slice(0, k).some((w) => assignment(w, ctx.shell)?.name === "PATH");
  if (k === words.length) {
    // Assignments alone last for the rest of the script, and end with the
    // status of a command substitution among them.
    // Alone, a failed assignment to a read-only variable ends dash and bash.
    if (assigned) {
      const r = assignPath(state, path);
      if (r) return r.o === "fail" ? { ...r, stop: ctx.shell?.readonlyAssignEnds ?? "maybe" } : r;
    }
    return words.some((w) => w.expansion) ? UNKNOWN : OK;
  }
  // Before a command, an assignment to a read-only PATH fails: dash ends
  // there, and bash runs the command with PATH as it was.
  if (assigned && state.pathReadonly !== false) {
    const r = command(words.slice(k), state.pathReadonly === true ? state.path : null, state, ctx);
    return { ...(r.o === "fail" ? r : UNKNOWN), mutates: r.mutates, stop: "maybe" };
  }
  return command(words.slice(k), path, state, ctx);
}

// Keywords that continue or close a compound. Before any compound is open, one
// is a syntax error, and the shell exits 2 without running its line.
const CLOSERS = new Set(["then", "else", "elif", "fi", "do", "done", "esac", "}", "in"]);
const JOINS = new Set(["&&", "||", "|"]);

/**
 * The script split into commands, each with the operator after it, whether a
 * redirection of it writes a file or may fail, and whether it holds an
 * expansion, a command substitution among them, in a word or a redirection.
 * The rest is opaque from the first compound. A syntax error ends the list,
 * replacing the commands of its own line, which don't run: a keyword that
 * closes nothing, `&&`, `||` or `|` without a command on both sides, or an
 * operator of bash's the shell doesn't have.
 */
function commands(tokens, ctx) {
  const list = [];
  let cmd = { words: [], redirs: 0, writes: false, subst: false, expansion: false, mayFail: false }, lineStart = 0;
  const syntaxError = (why) => { list.splice(lineStart); list.push({ syntaxError: why, op: null }); return list; };
  // An operator of bash's is read as the shell that runs the script reads it.
  // Where the shells that may run it differ, its line may not run at all, so
  // nothing is read from that line on.
  const reading = (t) => {
    if (!t.syntax) return [t];
    const has = ctx.shell?.syntax?.[t.syntax];
    return has === true ? [t] : has === false ? t.otherwise : [{ t: "unsure" }];
  };
  for (const t of tokens.flatMap(reading)) {
    if (t.t === "error") return syntaxError(`${ctx.shell.name} has no ${t.what}`);
    if (t.t === "unsure") {
      list.splice(lineStart);
      list.push({ opaque: true, op: null });
      return list;
    }
    if (t.t === "word") {
      const { words } = cmd;
      // A reserved word counts first in a command, or after the `!` that
      // inverts its pipeline.
      const leading = words.length === 0 || (words.length === 1 && !words[0].quoted && words[0].text === "!");
      if (leading && !t.quoted && ctx.shell?.keywords.has(t.text) && CLOSERS.has(t.text))
        return syntaxError(`'${t.text}' closes nothing`);
      // A keyword opening a compound, or a subshell, spans what follows: from
      // there, nothing more is read.
      if (leading && !t.quoted && (t.text === "{" || ctx.shell?.keywords.has(t.text)) && t.text !== "!" && t.text !== "time") {
        list.push({ opaque: true, op: null });
        return list;
      }
      words.push(t);
      cmd.subst ||= t.subst;
      cmd.expansion ||= t.expansion;
    } else if (t.t === "redir") {
      cmd.redirs++;
      cmd.writes ||= t.writes;
      cmd.subst ||= t.subst;
      cmd.expansion ||= t.expansion;
      cmd.mayFail ||= t.mayFail;
    } else if (t.t === "(" || t.t === ")") {
      list.push({ opaque: true, op: null });
      return list;
    } else if (t.t === "op") {
      // An empty command: before `;` or `&` the shell passes over it, and
      // before or after an operator that joins two it is a syntax error.
      if (!cmd.words.length && !cmd.redirs) {
        if (JOINS.has(t.op) || JOINS.has(list.at(-1)?.op)) return syntaxError(`'${t.op}' has no command on one side`);
        if (t.newline) lineStart = list.length;
        continue;
      }
      list.push({ ...cmd, op: t.op });
      cmd = { words: [], redirs: 0, writes: false, subst: false, expansion: false, mayFail: false };
      if (t.newline) lineStart = list.length;
    }
  }
  if (cmd.words.length || cmd.redirs) list.push({ ...cmd, op: null });
  else if (JOINS.has(list.at(-1)?.op)) return syntaxError(`'${list.at(-1).op}' has no command after it`);
  return list;
}

const either = (a, b) => (a.o === b.o ? (a.o === "fail" ? a : b) : UNKNOWN);
const inverted = (r) => {
  const o = r.o === "ok" ? "fail" : r.o === "fail" ? "ok" : "?";
  return { ...r, o, why: o === "fail" ? "always fails: '!' inverts a pipeline that succeeds" : null, negated: true };
};

// A command that writes nothing, which the next closing the pipe can't stop:
// `true` or `:`, the shell's or the program, or assignments alone.
const writesNothing = (cmd, shell) => {
  const word = cmd.words.find((w) => !assignment(w, shell));
  return !word || (!word.expansion && (word.text === "true" || word.text === ":"));
};

// A command whose redirection may fail: then it doesn't run, and fails. So it
// never surely succeeds, and an exit or exec with one may not end the shell:
// bash goes on, where dash ends.
const redirected = (cmd, r) => (cmd.mayFail ? { ...r, o: r.o === "ok" ? "?" : r.o, stop: r.stop === true ? "maybe" : r.stop } : r);

/**
 * Run one pipeline from `i`: one command, or several joined by `|`, each run
 * apart with the last deciding, or under pipefail any that fails, the whole
 * inverted by a leading `!`. Returns the outcome and where the next begins.
 */
function pipeline(list, i, state, ctx) {
  const first = list[i];
  const bang = first.words?.[0];
  if (bang && !bang.quoted && bang.text === "!" && ctx.shell?.keywords.has("!")) {
    const rest = [...list];
    rest[i] = { ...first, words: first.words.slice(1) };
    const p = pipeline(rest, i, state, ctx);
    // An exit, or an exec, ends the shell before `!` inverts anything.
    return p.r.stop === true ? p : { ...p, r: inverted(p.r) };
  }
  let j = i;
  while (list[j].op === "|") j++;
  if (list[j].syntaxError)
    return { r: { ...failing(`has a syntax error: ${list[j].syntaxError}, so the shell exits 2`), stop: true }, next: j + 1 };
  if (list[j].opaque) return { r: UNKNOWN, next: j + 1, opaque: true };
  if (j === i) {
    // A command substitution runs first, and may change what its command finds.
    if (first.subst) state.mutated = true;
    const r = redirected(first, simple(first.words, state, ctx));
    const mutates = r.mutates || first.writes || first.subst;
    return { r: mutates ? { ...r, mutates: true } : r, next: i + 1, opaque: Boolean(r.opaque) };
  }
  for (let k = i; k < j; k++) if (list[k].opaque) return { r: UNKNOWN, next: list.length, opaque: true };
  // The commands of a pipeline run apart and at once: none changes the shell's
  // own state or makes another's program in time to count, and the last one's
  // status is the pipeline's.
  const run = (k) => redirected(list[k], simple(list[k].words, { ...state, mutated: state.mutated || list[k].subst }, ctx));
  // Each runs in a subshell of its own, where an expansion that fails, $((1/0))
  // or ${x:?}, fails that command rather than ending the script. So one with an
  // expansion, in a word or in a redirection such as a here-string, never
  // surely succeeds.
  const sure = (k, e) => (e.o === "ok" && list[k].expansion ? UNKNOWN : e);
  const r = sure(j, run(j));
  // Under pipefail it fails when any of them fails. One before the last that
  // writes may be stopped by the next closing the pipe, so it never surely
  // succeeds.
  let status = r;
  if (state.pipefail !== false) {
    const each = [...list.slice(i, j).map((_, n) => { const e = sure(i + n, run(i + n)); return e.o === "ok" && !writesNothing(list[i + n], ctx.shell) ? UNKNOWN : e; }), r];
    const withIt = each.findLast((e) => e.o === "fail") ?? (each.every((e) => e.o === "ok") ? OK : UNKNOWN);
    status = state.pipefail === true ? withIt : either(withIt, r);
  }
  return { r: { o: status.o, why: status.why, mutates: true }, next: j + 1, opaque: Boolean(r.opaque) };
}

/**
 * Run one and-or list from `i`: pipelines joined by `&&` and `||`, each skipped
 * or run by the one before. Returns its outcome, where the next list begins,
 * whether what follows is unread, whether it stops the script, and whether its
 * outcome is its last pipeline's.
 */
function andOr(list, i, state, ctx) {
  const ran = (r) => { if (r.mutates) state.mutated = true; };
  let { r: acc, next, opaque } = pipeline(list, i, state, ctx);
  let fromLast = true, stop = acc.stop ?? false;
  ran(acc);
  i = next;
  while (!opaque && stop !== true && (list[i - 1]?.op === "&&" || list[i - 1]?.op === "||") && i < list.length) {
    const op = list[i - 1].op;
    const runs = op === "&&" ? acc.o === "ok" : acc.o === "fail";
    const skips = op === "&&" ? acc.o === "fail" : acc.o === "ok";
    if (skips) { const p = pipeline(list, i, { ...state }, ctx); i = p.next; opaque = p.opaque; fromLast = false; continue; }
    // `$?` is the left side's status by now, for a bare `exit`.
    state.status = statusOf(acc);
    if (runs) {
      const p = pipeline(list, i, state, ctx);
      i = p.next; opaque = p.opaque; acc = p.r; stop = p.r.stop ?? false; fromLast = true;
      ran(p.r);
      continue;
    }
    // Unsure whether it runs. What it may have changed is unknown after it.
    const maybeState = { ...state };
    const p = pipeline(list, i, maybeState, ctx);
    i = p.next; opaque = p.opaque;
    if (maybeState.path !== state.path) state.path = null;
    if (maybeState.cwd !== state.cwd) state.cwd = null;
    if (maybeState.errexit !== state.errexit) state.errexit = "maybe";
    if (maybeState.pipefail !== state.pipefail) state.pipefail = "maybe";
    if (maybeState.pathReadonly !== state.pathReadonly) state.pathReadonly = "maybe";
    if (maybeState.trapped) state.trapped = true;
    ran(p.r);
    acc = op === "&&" ? (p.r.o === "fail" ? p.r : UNKNOWN) : (p.r.o === "ok" ? OK : UNKNOWN);
    if (p.r.stop) stop = "maybe";
    fromLast = "?";
  }
  return { acc, next: i, opaque, stop, fromLast };
}

// The index of the last command of the and-or list starting at `i`, whose
// operator ends the list: `;`, a newline, `&`, or nothing.
function listEnd(list, i) {
  let j = i;
  while (j < list.length - 1 && ["|", "&&", "||"].includes(list[j].op)) j++;
  return j;
}

/**
 * Whether the script certainly fails, as `{ broken, why }`. It runs the script's
 * commands in order as the shell would: `&&` and `||` skip what they skip, `;`
 * and newlines go on, `&` runs a list apart, `set -e` stops at a failure,
 * `exit` stops, a pipeline ends with its last command, or under pipefail with
 * any that fails, and `!` inverts one. Anything unsure stays unsure.
 */
export function scriptOutcome(body, pkg, shell = scriptShells(runnerShells(pkg.dir, "npm"))) {
  const tokens = tokenize(body);
  if (!tokens) return { broken: false, why: null };
  const ctx = { pkg, shell };
  const list = commands(tokens, ctx);
  // errexit, pipefail and whether PATH is read-only are true, false or "maybe".
  const state = { errexit: false, pipefail: false, path: undefined, pathReadonly: false, cwd: pkg.dir, status: OK, mutated: false,
                  trapped: false };
  const maybe = [];   // outcomes the script may already have stopped with
  let last = OK, i = 0;
  while (i < list.length) {
    // A list ended by `&` runs in the background, in a copy of the shell: its
    // exit ends only itself, a failure there stops nothing, and `$?` after it is
    // 0. What it changes on disk may be changed at any moment after.
    if (list[listEnd(list, i)].op === "&") {
      const apart = { ...state };
      const r = andOr(list, i, apart, ctx);
      i = r.next;
      if (r.opaque) { last = UNKNOWN; break; }
      if (apart.mutated) state.mutated = true;
      state.status = OK; last = OK;
      continue;
    }
    const { acc, next, opaque, stop, fromLast } = andOr(list, i, state, ctx);
    i = next;
    // What follows a compound isn't read, and may decide how the script ends.
    if (opaque) { last = UNKNOWN; break; }
    if (stop === true) { last = acc; break; }
    if (stop === "maybe") maybe.push(acc);
    // set -e stops at a failure of an and-or list's last command, and never at
    // a pipeline `!` inverts.
    const errexit = fromLast === false || acc.negated ? false : state.errexit;
    if (errexit === true && acc.o === "fail" && fromLast === true) { maybe.push(acc); last = acc; break; }
    if (errexit && acc.o !== "ok") maybe.push(failing(acc.why ?? "may stop at a failure under set -e"));
    state.status = statusOf(acc);
    last = acc;
  }
  // A trap can end the script with a status of its own.
  if (state.trapped) return { broken: false, why: null };
  const final = maybe.reduce(either, last);
  return final.o === "fail" ? { broken: true, why: final.why } : { broken: false, why: null };
}
