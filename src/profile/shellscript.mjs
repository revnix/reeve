// shellscript: whether a package script can ever pass, read the way the shell
// that runs it reads it.
//
// Setup detection reports a script broken when it can't pass: it runs a program
// that isn't there, or it always fails. That is decided here, and only when it is
// certain. A script this can't read with confidence, a loop say, or a program
// named by a variable, is never called broken: a wrong "broken" sends a fixer
// after a script that works.
//
// npm runs scripts with `sh`, which is dash on Debian and Ubuntu and bash on
// macOS, and the two disagree about which words are the shell's own: dash has no
// `source`, `[[`, `function` or `select`, and its `time` is a program. So those
// words are asked of that shell, once, rather than listed here.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";

// Words some shell treats as its own, keywords and builtins. Which of them the
// shell npm runs actually has is asked of it.
const CANDIDATES = [
  "!", "{", "}", "case", "do", "done", "elif", "else", "esac", "fi", "for", "if", "in", "then", "until", "while",
  "[[", "function", "select", "time", "coproc",
  ".", ":", "[", "alias", "bg", "break", "builtin", "cd", "command", "continue", "declare", "echo", "eval", "exec",
  "exit", "export", "false", "fg", "getopts", "hash", "jobs", "kill", "let", "local", "printf", "pwd", "read",
  "readonly", "return", "set", "shift", "source", "test", "times", "trap", "true", "type", "typeset", "ulimit",
  "umask", "unalias", "unset", "wait",
];

let asked;
/**
 * The shell npm runs scripts with, as `{ name, builtins, keywords }`: `sh`, as
 * npm finds it on the PATH, asked once which of the candidate words it treats
 * as its own. Null when it can't be asked; then no candidate word is judged.
 */
export function scriptShell() {
  if (asked !== undefined) return asked;
  const r = spawnSync("sh", ["-c",
    'printf "shell\\t%s\\n" "$(readlink -f "$(command -v sh)" 2>/dev/null || command -v sh)"; ' +
    'for w in "$@"; do printf "%s\\t" "$w"; command -V "$w" 2>&1 | head -n 1; done', "sh", ...CANDIDATES],
    { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 10_000 });
  if (r.status !== 0 || !r.stdout) return (asked = null);
  const builtins = new Set(), keywords = new Set();
  let name = "sh";
  for (const line of r.stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const word = line.slice(0, tab), said = line.slice(tab + 1);
    if (word === "shell") { name = basename(said) || "sh"; continue; }
    if (/ is a (special )?shell builtin$/.test(said)) builtins.add(word);
    else if (/ is a (shell keyword|reserved word)$/.test(said)) keywords.add(word);
  }
  return (asked = { name, builtins, keywords });
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
 * first quote, and whether it holds an expansion. Null for what isn't read: an
 * unbalanced quote, a here-document, or case syntax.
 */
export function tokenize(body) {
  const s = String(body), tokens = [];
  let i = 0;
  const word = () => {
    let text = "", bare = null, expansion = false;
    const quote = () => { if (bare === null) bare = text; };
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
            if (end > j + 1) expansion = true;
            text += s.slice(j, end); j = end; continue;
          }
          text += s[j++];
        }
        if (j >= s.length) return undefined;
        i = j + 1; continue;
      }
      if (c === "$" || c === "`") {
        const end = expansionEnd(s, i);
        if (end < 0) return undefined;
        if (end > i + 1) expansion = true;
        text += s.slice(i, end); i = end; continue;
      }
      text += c; i++;
    }
    return { t: "word", text, quoted: bare !== null, bare: bare ?? text, expansion };
  };
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (c === "#") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === "\n") { tokens.push({ t: "op", op: ";", newline: true }); i++; continue; }
    if (s.startsWith(";;", i) || s.startsWith(";&", i)) return null;
    const op = ["&&", "||", "|&", ";", "&", "|"].find((o) => s.startsWith(o, i));
    if (op) { tokens.push({ t: "op", op: op === "|&" ? "|" : op }); i += op.length; continue; }
    if (c === "(" || c === ")") { tokens.push({ t: c }); i++; continue; }
    const r = /^(\d*)(<<-?|<<<|<>|>>|>\||>&|<&|<|>)/.exec(s.slice(i));
    if (r) {
      if (r[2] === "<<" || r[2] === "<<-") return null;   // a here-document's body follows, unread
      i += r[0].length;
      while (s[i] === " " || s[i] === "\t") i++;
      const target = word();
      if (!target || (target.text === "" && !target.quoted)) return null;
      tokens.push({ t: "redir" });
      continue;
    }
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

const OK = { o: "ok" }, UNKNOWN = { o: "?" };
const failing = (why) => ({ o: "fail", why });
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// An assignment is a word whose name and `=` weren't quoted; its value is what
// follows the `=`.
const assignment = (w) => {
  if (!ASSIGNMENT.test(w.bare)) return null;
  const eq = w.text.indexOf("=");
  return { name: w.text.slice(0, eq), value: { text: w.text.slice(eq + 1), expansion: w.expansion } };
};

/**
 * The directories a literal PATH value names, resolved against the package, or
 * null when it holds an expansion and can't be known.
 */
function literalPath(value, dir) {
  if (value.expansion) return null;
  return value.text.split(":").map((d) => (d === "" ? dir : isAbsolute(d) ? d : resolve(dir, d)));
}

// A file there is taken to run, as setup detection always has: a missing
// execute bit would fail too, but that is a broken install, not a missing tool,
// and erring this way never calls a working script broken.
const runnable = (file) => { try { return statSync(file).isFile(); } catch { return false; } };

/**
 * Whether `name` runs as a program: true, false, or null when that can't be
 * told. With `path` undefined it is found as npm finds it: a dependency, the
 * package's own `node_modules/.bin`, a runner every setup has, or the PATH. With
 * a literal PATH given, only there.
 */
function found(name, path, pkg) {
  if (name.includes("/")) return runnable(resolve(pkg.dir, name));
  if (path === null) return null;
  if (path === undefined) {
    if (pkg.deps[name] || /^(node|tsc|pnpm|npm|yarn|turbo|nx)$/.test(name)) return true;
    return [join(pkg.dir, "node_modules", ".bin"), ...(process.env.PATH ?? "").split(delimiter)].some((d) => d && runnable(join(d, name)));
  }
  return path.some((d) => runnable(join(d, name)));
}

function program(words, path, ctx) {
  const [name, ...rest] = words;
  if (!name || name.expansion) return name ? UNKNOWN : OK;
  const wrapped = wrapper(name.text, rest, path, ctx);
  if (wrapped) return wrapped;
  const is = found(name.text, path, ctx.pkg);
  if (is !== false) return UNKNOWN;
  const shell = ctx.shell;
  if (CANDIDATES.includes(name.text) && shell)
    return failing(`uses '${name.text}', which ${shell.name}, the shell npm runs scripts with, doesn't have`);
  if (ASSIGNMENT.test(name.text))
    return failing(`runs '${name.text}' as a program: only env takes an assignment after its own name`);
  if (Array.isArray(path)) return failing(`runs '${name.text}' with a PATH it isn't found in`);
  return failing(`runs '${name.text}', which is neither a dependency nor installed`);
}

// Programs that run the command after them: env, nohup, and time where it is a
// program rather than the shell's own word. Each one's options are its own.
function wrapper(name, rest, path, ctx) {
  let i = 0, p = path;
  if (name === "env") {
    for (; i < rest.length && rest[i].text.startsWith("-") && rest[i].text !== "-"; i++) {
      const o = rest[i].text;
      if (o === "--") { i++; break; }
      if (/^-(S|-split-string)/.test(o)) return UNKNOWN;
      if (/^-[iv0]+$/.test(o) || o === "--ignore-environment") { if (o.includes("i")) p = ["/bin", "/usr/bin"]; continue; }
      if (o === "-u" || o === "-C" || o === "--unset" || o === "--chdir") { i++; continue; }
      if (/^--(unset|chdir)=/.test(o) || /^-[uC]./.test(o)) continue;
      return UNKNOWN;
    }
    if (rest[i]?.text === "-") { p = ["/bin", "/usr/bin"]; i++; }
    for (let a; i < rest.length && (a = assignment(rest[i])); i++) if (a.name === "PATH") p = literalPath(a.value, ctx.pkg.dir);
  } else if (name === "nohup") {
    if (rest[0]?.text === "--") i = 1;
  } else if (name === "time") {
    for (; i < rest.length && rest[i].text.startsWith("-"); i++) {
      const o = rest[i].text;
      if (o === "--") { i++; break; }
      if (o === "-f" || o === "-o") { i++; continue; }
      if (!/^(-[pvqa]+|--(portability|verbose|quiet|append|format=.*|output=.*))$/.test(o)) return UNKNOWN;
    }
  } else return null;
  if (i >= rest.length) return name === "env" ? OK : UNKNOWN;
  const inner = program(rest.slice(i), p, ctx);
  if (inner.o === "fail") return inner;
  return found(name, path, ctx.pkg) === false ? failing(`runs '${name}', which is neither a dependency nor installed`) : inner;
}

// A builtin of the shell, run in `state`.
function builtin(name, args, path, state, ctx) {
  const text = args.map((a) => a.text);
  switch (name) {
    case "true": case ":": return OK;
    case "false": return failing("always fails: 'false' never succeeds");
    case "exit": {
      if (!args.length) return { ...state.status, stop: true };   // with the last status
      if (args[0].expansion) return { o: "?", stop: true };
      const n = Number(text[0]);
      if (!Number.isInteger(n)) return { o: "?", stop: true };
      return n % 256 === 0 ? { o: "ok", stop: true } : { ...failing(`always fails: it exits ${n}`), stop: true };
    }
    case "set":
      for (let k = 0; k < text.length; k++) {
        const o = text[k];
        if (/^-[a-zA-Z]*e/.test(o) || (o === "-o" && text[k + 1] === "errexit")) state.errexit = true;
        if (/^\+[a-zA-Z]*e/.test(o) || (o === "+o" && text[k + 1] === "errexit")) state.errexit = false;
      }
      return OK;
    case "export": case "readonly":
      for (const w of args) { const a = assignment(w); if (a?.name === "PATH") state.path = literalPath(a.value, ctx.pkg.dir); }
      return OK;
    case "echo": case "printf": case "unset": case "alias": case "unalias": case "umask": case "trap": case "pwd":
      return OK;
    case "command": {
      let k = 0;
      for (; k < args.length && args[k].text.startsWith("-"); k++) {
        if (args[k].text === "--") { k++; break; }
        if (/[vV]/.test(args[k].text)) return UNKNOWN;   // only looks a program up
        if (!/^-p+$/.test(args[k].text)) return UNKNOWN;
      }
      return args.length > k ? command(args.slice(k), path, state, ctx) : OK;
    }
    case "exec": {
      let k = 0;
      for (; k < args.length && args[k].text.startsWith("-"); k++) {
        if (args[k].text === "--") { k++; break; }
        if (args[k].text === "-a") k++;
        else if (!/^-[cl]+$/.test(args[k].text)) return UNKNOWN;
      }
      if (args.length <= k) return OK;
      // The program replaces the shell, which ends with it.
      return { ...program(args.slice(k), path, ctx), stop: true };
    }
    default: return UNKNOWN;
  }
}

/**
 * One command's words, after its leading assignments: a keyword, a builtin, a
 * wrapper or a program. After `command`, `exec` or a wrapper, a word shaped like
 * an assignment is a program's name.
 */
function command(words, path, state, ctx) {
  const [name, ...args] = words;
  if (name.expansion) return UNKNOWN;
  const shell = ctx.shell;
  if (!shell && CANDIDATES.includes(name.text)) return UNKNOWN;
  if (!name.quoted && shell?.keywords.has(name.text)) {
    if (name.text !== "time") return { o: "?", opaque: true };
    // The shell's own `time` times the command after it, assignments and all.
    let k = 0;
    while (args[k]?.text === "-p") k++;
    return args.length > k ? simple(args.slice(k), state, ctx) : OK;
  }
  if (shell?.builtins.has(name.text)) return builtin(name.text, args, path, state, ctx);
  return program(words, path, ctx);
}

/** One simple command in `state`: its leading assignments, then its command. */
function simple(words, state, ctx) {
  if (!words.length) return OK;
  if (!words[0].quoted && words[0].text === "!" && ctx.shell?.keywords.has("!")) {
    const r = simple(words.slice(1), state, ctx);
    return { ...r, o: r.o === "ok" ? "fail" : r.o === "fail" ? "ok" : "?", why: r.o === "ok" ? "always fails: '!' inverts a command that succeeds" : null };
  }
  let k = 0, path = state.path;
  for (let a; k < words.length && (a = assignment(words[k])); k++) if (a.name === "PATH") path = literalPath(a.value, ctx.pkg.dir);
  if (k === words.length) {
    // Assignments alone last for the rest of the script.
    if (path !== state.path) state.path = path;
    return words.some((w) => w.expansion) ? UNKNOWN : OK;
  }
  return command(words.slice(k), path, state, ctx);
}

// Keywords that continue or close a compound. Before any compound is open, one
// is a syntax error, and the shell exits 2 without running its line.
const CLOSERS = new Set(["then", "else", "elif", "fi", "do", "done", "esac", "}", "in"]);

/**
 * The script split into commands, each with the operator after it. The rest is
 * opaque from the first compound; a keyword that closes nothing ends the list
 * as a syntax error, replacing the commands of its own line, which don't run.
 */
function commands(tokens, ctx) {
  const list = [];
  let words = [], lineStart = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t === "word") {
      if (!words.length && !t.quoted && ctx.shell?.keywords.has(t.text) && CLOSERS.has(t.text)) {
        list.splice(lineStart);
        list.push({ syntaxError: t.text, op: null });
        return list;
      }
      // A keyword opening a compound, or a subshell, spans what follows: from
      // there, nothing more is read.
      if (!words.length && !t.quoted && (t.text === "{" || ctx.shell?.keywords.has(t.text)) && t.text !== "!" && t.text !== "time") {
        list.push({ opaque: true, op: null });
        return list;
      }
      words.push(t);
    } else if (t.t === "(" || t.t === ")") {
      list.push({ opaque: true, op: null });
      return list;
    } else if (t.t === "op") {
      list.push({ words, op: t.op });
      words = [];
      if (t.newline) lineStart = list.length;
    }
  }
  if (words.length || !list.length || list.at(-1).op) list.push({ words, op: null });
  return list;
}

const either = (a, b) => (a.o === b.o ? (a.o === "fail" ? a : b) : UNKNOWN);

/** Run one command, or a pipeline of them, from `i`. Returns the outcome and where the next begins. */
function pipeline(list, i, state, ctx) {
  let j = i;
  while (list[j].op === "|") j++;
  if (list[j].syntaxError)
    return { r: { ...failing(`has a syntax error: '${list[j].syntaxError}' closes nothing, so the shell exits 2`), stop: true }, next: j + 1 };
  if (list[j].opaque) return { r: UNKNOWN, next: j + 1, opaque: true };
  if (j === i) {
    const r = simple(list[i].words, state, ctx);
    return { r, next: i + 1, opaque: Boolean(r.opaque) };
  }
  // Each command of a pipeline runs apart; the last one decides.
  for (let k = i; k < j; k++) if (list[k].opaque) return { r: UNKNOWN, next: list.length, opaque: true };
  const r = simple(list[j].words, { ...state }, ctx);
  return { r: { o: r.o, why: r.why }, next: j + 1, opaque: Boolean(r.opaque) };
}

/**
 * Whether the script certainly fails, as `{ broken, why }`. It runs the script's
 * commands in order as the shell would: `&&` and `||` skip what they skip, `;`
 * and newlines go on, `set -e` stops at a failure, `exit` stops, and a pipeline
 * ends with its last command. Anything unsure stays unsure.
 */
export function scriptOutcome(body, pkg, shell = scriptShell()) {
  const tokens = tokenize(body);
  if (!tokens) return { broken: false, why: null };
  const ctx = { pkg, shell };
  const list = commands(tokens, ctx);
  const state = { errexit: false, path: undefined, status: OK };
  const maybe = [];   // outcomes the script may already have stopped with
  let last = OK, i = 0;
  while (i < list.length) {
    // One and-or list.
    let { r: acc, next, opaque } = pipeline(list, i, state, ctx);
    let fromLast = true, stop = acc.stop ?? false;
    i = next;
    while (!opaque && stop !== true && (list[i - 1]?.op === "&&" || list[i - 1]?.op === "||") && i < list.length) {
      const op = list[i - 1].op;
      const runs = op === "&&" ? acc.o === "ok" : acc.o === "fail";
      const skips = op === "&&" ? acc.o === "fail" : acc.o === "ok";
      if (skips) { const p = pipeline(list, i, { ...state }, ctx); i = p.next; opaque = p.opaque; fromLast = false; continue; }
      if (runs) {
        const p = pipeline(list, i, state, ctx);
        i = p.next; opaque = p.opaque; acc = p.r; stop = p.r.stop ?? false; fromLast = true;
        continue;
      }
      // Unsure whether it runs. A PATH it may have changed is unknown after it.
      const maybeState = { ...state };
      const p = pipeline(list, i, maybeState, ctx);
      i = p.next; opaque = p.opaque;
      if (maybeState.path !== state.path) state.path = null;
      acc = op === "&&" ? (p.r.o === "fail" ? p.r : UNKNOWN) : (p.r.o === "ok" ? OK : UNKNOWN);
      if (p.r.stop) stop = "maybe";
      fromLast = "?";
    }
    const sep = list[i - 1]?.op;
    // What follows a compound isn't read, and may decide how the script ends.
    if (opaque) { last = UNKNOWN; break; }
    if (stop === true) { last = acc; break; }
    if (stop === "maybe") maybe.push(acc);
    if (sep === "&") { state.status = OK; last = OK; continue; }
    if (state.errexit && acc.o === "fail" && fromLast === true) { maybe.push(acc); last = acc; break; }
    if (state.errexit && acc.o !== "ok" && fromLast !== false) maybe.push(failing(acc.why ?? "may stop at a failure under set -e"));
    state.status = acc;
    last = acc;
  }
  const final = maybe.reduce(either, last);
  return final.o === "fail" ? { broken: true, why: final.why } : { broken: false, why: null };
}
