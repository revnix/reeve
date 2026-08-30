// The rule that replaced a regular expression over source text, and then replaced its
// own first attempt.
//
// Every case here is one a review round found, and they are kept together because the
// point is not that the rule works. It is that two whole families of defect stopped
// being reachable.
//
// THE FIRST FAMILY was the text search: it could not tell code from prose. It missed a
// call inside the arguments, a wrapped member access and optional chaining; it fired
// on `pathnamePrefix`; its scope decisions swept in captured data or skipped the
// extensionless CLI. Eight rounds. A parser is not asked any of those questions.
//
// THE SECOND FAMILY was my own first rule, which tried to decide which URLs were FILE
// urls so http reads could stay legal. That question has no reliable answer, and
// review found six ways the approximation was wrong before the design changed. The
// rule now bans the read outright, so those six are not fixed -- they are unaskable.
// Their cases remain below, as `invalid`, because each must still be reported.
import { RuleTester } from "eslint";
import rule from "../tools/eslint-rules/no-url-pathname.js";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const tester = new RuleTester({ languageOptions: { ecmaVersion: 2024, sourceType: "module" } });
const err = [{ messageId: "pathname" }];
const run = (name, cases) => {
  try { tester.run("no-url-pathname", rule, cases); check(true, name); }
  catch (e) { check(false, name, String(e.message).split("\n").slice(0, 3).join(" | ")); }
};

// ── what the text search could not see ─────────────────────────────────────────
run("a direct read is reported",
  { valid: [], invalid: [{ code: 'const p = new URL("../x", import.meta.url).pathname;', errors: err }] });
run("a CALL inside the arguments, which a pattern stopping at the first bracket could not see",
  { valid: [], invalid: [{ code: 'const p = new URL(f(), import.meta.url).pathname;', errors: err }] });
run("the member access WRAPPED onto the next line",
  { valid: [], invalid: [{ code: 'const p = new URL("../x", import.meta.url)\n  .pathname;', errors: err }] });
run("the ARGUMENTS wrapped, which is a different wrap",
  { valid: [], invalid: [{ code: 'const p = new URL(\n  "../x",\n  import.meta.url\n).pathname;', errors: err }] });
run("OPTIONAL CHAINING, which returns the same path whenever the receiver exists",
  { valid: [], invalid: [{ code: 'const u = new URL(x, import.meta.url); const p = u?.pathname;', errors: err }] });
run("the URL held in a VARIABLE first",
  { valid: [], invalid: [{ code: 'const u = new URL("../x", import.meta.url);\nconst p = u.pathname;', errors: err }] });

// ── what my own first rule could not classify ──────────────────────────────────
run("a base held in a VARIABLE, which name-matching could not resolve",
  { valid: [], invalid: [{ code: 'const b = new URL(".", import.meta.url);\nconst p = new URL("x", b).pathname;', errors: err }] });
run("an ALIASED import of the URL constructor",
  { valid: [], invalid: [{ code: 'import { URL as NodeURL } from "node:url";\nconst p = new NodeURL("x", import.meta.url).pathname;', errors: err }] });
run("a NAMESPACE import, whose callee is a member expression",
  { valid: [], invalid: [{ code: 'import * as nodeUrl from "node:url";\nconst p = nodeUrl.pathToFileURL(x).pathname;', errors: err }] });
run("an UPPERCASE scheme, because URL schemes are case-insensitive",
  { valid: [], invalid: [{ code: 'const p = new URL("FILE:///tmp/a").pathname;', errors: err }] });
run("a TEMPLATE with no substitutions, as static as a quoted string",
  { valid: [], invalid: [{ code: 'const p = new URL(`file:///tmp/x`).pathname;', errors: err }] });
run("an absolute first argument that overrides the base's scheme",
  { valid: [], invalid: [{ code: 'const p = new URL("x", "file:///tmp/").pathname;', errors: err }] });
run("and a read off something whose origin is unknown, which the narrow rule let through",
  { valid: [], invalid: [{ code: 'export function f(u) { return u.pathname; }', errors: err }] });

// ── what is still not this property ────────────────────────────────────────────
//
// The ban is broad, not indiscriminate. These stay valid because they are not a read
// of this property at all, and a rule that flagged them would be reporting code
// nobody wrote.
run("PROSE is not code",
  { valid: ['// fileURLToPath, NOT .pathname, because a space arrives percent-encoded\nconst x = 1;'], invalid: [] });
run("a STRING containing the text is not a read",
  { valid: ['const s = "call .pathname here"; const t = `${s}.pathname`;'], invalid: [] });
run("an identifier merely BEGINNING with the word is a different property",
  { valid: ['const p = route.pathnamePrefix;', 'const q = url.pathnameEncoded;'], invalid: [] });
run("a COMPUTED access is not this property, and treating it as one would report a read nobody wrote",
  { valid: ['const k = "pathname"; const p = new URL(x, import.meta.url)[k];'], invalid: [] });
run("declaring the name is not reading it",
  { valid: ['const o = { pathname: 1 };', 'class C { pathname = 1; }'], invalid: [] });

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
