// What an effect handler is allowed to REACH, enforced by walking its imports.
//
// `effects.mjs` claims, in its own docblock, that nothing in it reaches for a
// credential on its own — the drainer authenticates once and passes the caller in.
// That is a capability boundary, and today it holds by construction: the file
// imports nothing at all. Which is exactly the condition under which someone adds
// `import { authenticate } from "../github/app.mjs"` for convenience, the claim
// silently stops being true, and every existing test still passes because they
// inject a fake `api` and never notice the module could have made its own.
//
// So the property is checked rather than asserted in prose. The walk is
// TRANSITIVE: a boundary that only inspects direct imports is defeated by one
// level of indirection, which is the ordinary way it gets defeated.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

/**
 * Every specifier a file pulls in, by any of the four routes.
 *
 * `export ... from` and a dynamic `import()` are imports as surely as a static one
 * is, and `require` reaches CommonJS. A walk that reads only `import ... from` is
 * a boundary with three doors left open.
 */
const specifiersIn = text => {
  const out = [];
  for (const re of [
    /^\s*import\s[\s\S]*?from\s*["']([^"']+)["']/gm,   // import x from "y"
    /^\s*import\s*["']([^"']+)["']/gm,                 // import "y" (side effect)
    /^\s*export\s[\s\S]*?from\s*["']([^"']+)["']/gm,   // export ... from "y"
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,          // await import("y")
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,         // require("y")
  ]) for (const m of text.matchAll(re)) out.push(m[1]);
  return out;
};

/** Everything `entry` can reach, transitively, as a set of specifiers. */
const reachableFrom = entry => {
  const seen = new Set(), reached = new Set();
  const walk = file => {
    const abs = resolve(file);
    if (seen.has(abs) || !existsSync(abs)) return;
    seen.add(abs);
    for (const spec of specifiersIn(readFileSync(abs, "utf8"))) {
      reached.add(spec);
      if (spec.startsWith(".")) walk(join(dirname(abs), spec));
    }
  };
  walk(entry);
  return { reached, files: seen };
};

// --- the walker can see what it is looking for --------------------------------
{
  // Controls first, and against a REAL file rather than a string, because a
  // matcher that finds nothing and a boundary that is clean read identically.
  const { reached, files } = reachableFrom(join(src, "outbox", "drain.mjs"));
  check(reached.has("../db/ops.mjs"), "control: the walk sees a direct import", [...reached].join(", "));
  check(reached.has("node:sqlite") || reached.has("node:fs"),
    "control: and follows it TRANSITIVELY into what that file imports", [...reached].join(", "));
  check(files.size >= 3, "control: so it visited more than the entry file", `${files.size} file(s)`);

  for (const [route, text, want] of [
    ["export ... from", 'export { a } from "./x.mjs";', "./x.mjs"],
    ["dynamic import", 'const m = await import("./y.mjs");', "./y.mjs"],
    ["require", 'const z = require("./z.mjs");', "./z.mjs"],
    ["side-effect import", 'import "./w.mjs";', "./w.mjs"],
  ]) check(specifiersIn(text).includes(want), `control: the matcher sees a ${route}`, specifiersIn(text).join(","));
}

// --- the boundary itself ------------------------------------------------------
{
  const { reached } = reachableFrom(join(src, "outbox", "effects.mjs"));

  // A credential, by any route. `github/app.mjs` is what loads the App key and
  // mints tokens; the node modules are what would let a handler go around it.
  // An ALLOWLIST, not a denylist, and that change is the whole point.
  //
  // The denylist was wrong in principle and demonstrably wrong in practice: it
  // named `net`, `http`, `https`, `dns` and missed `node:http2` and `node:dgram`,
  // both of which reach the network perfectly well. Enumerating the ways out is a
  // race against the platform's module list that the platform wins -- every new
  // capability node ships is a hole until someone remembers to add it here.
  //
  // Naming what a handler MAY reach inverts that. The list is currently empty,
  // which is the honest answer: these handlers take everything they need as
  // arguments. Anything a future handler genuinely needs gets added here
  // deliberately, by someone who has to justify it in a diff.
  const ALLOWED = [];
  const forbidden = [...reached].filter(s => !ALLOWED.includes(s));
  check(forbidden.length === 0,
    "an effect handler reaches nothing that is not explicitly permitted",
    `reaches ${forbidden.join(", ")}`);
  // Control: the allowlist is doing work rather than being vacuously satisfied by
  // a walk that finds nothing. If `reached` were empty for a broken reason, this
  // would still pass -- so the walk itself is exercised against a file that does
  // import things, above.

  // GLOBALS, which need no import at all and which the walk therefore cannot see.
  // `fetch` is the one that matters: a handler calling it directly makes its own
  // network call while the import graph stays perfectly clean. Scanned over the
  // files the walk actually reached, so it covers a helper module too.
  const { files } = reachableFrom(join(src, "outbox", "effects.mjs"));
  const AMBIENT = [
    [/\bfetch\s*\(/, "fetch"],
    [/\bnew\s+WebSocket\b/, "WebSocket"],
    [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
    [/\bnew\s+Function\s*\(/, "new Function"],
    [/\bprocess\.binding\s*\(/, "process.binding"],
    [/\bcreateRequire\s*\(/, "createRequire"],
  ];
  const ambient = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    // Comments discuss these by name -- this file's own docblock does -- so only
    // CODE is scanned. Crude but honest: a line whose first non-space characters
    // start a comment is skipped.
    const code = text.split("\n").filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    for (const [re, name] of AMBIENT) if (re.test(code)) ambient.push(`${relative(src, f)}: ${name}`);
  }
  check(ambient.length === 0,
    "and reaches no ambient capability either, which needs no import to use",
    ambient.join(", "));

  // Control: the scanner finds these when they ARE present. Without it a clean
  // result and a broken matcher are the same reading.
  for (const [re, name] of AMBIENT)
    check(re.test({ fetch: "await fetch(url)", WebSocket: "new WebSocket(u)", XMLHttpRequest: "new XMLHttpRequest()",
                    "new Function": "new Function(s)", "process.binding": "process.binding('x')",
                    createRequire: "createRequire(import.meta.url)" }[name]),
      `control: the scanner recognises ${name}`, "");

  // And the positive half: the claim is that it takes its caller as an argument.
  // Without this, a handler that simply stopped working would also pass above.
  const text = readFileSync(join(src, "outbox", "effects.mjs"), "utf8");
  check(/\{\s*api\b/.test(text), "because the caller is handed to it, not fetched by it",
    "no `api` parameter found");
}

// --- and the drainer holds the weaker version of the same line ----------------
{
  // The drainer legitimately touches the database — that is its job — but it
  // still must not authenticate. Whoever holds the credential passes it in, so
  // there is one place a token is minted and one place to audit.
  const { reached } = reachableFrom(join(src, "outbox", "drain.mjs"));
  const auth = [...reached].filter(s => /github\/app\.mjs$/.test(s));
  check(auth.length === 0, "the drainer does not authenticate either; it is handed the caller",
    `reaches ${auth.join(", ")}`);
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
