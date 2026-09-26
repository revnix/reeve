// The type check and lint accept only what Node runs (#230): TypeScript that
// Node can strip, no browser types, and the globals an ES module has. And an
// import goes above the code that reads it, which lint holds to.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./fixtures/temp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name) => join(ROOT, "node_modules", ".bin", name);
// tsc and eslint turn on Node's compile cache, which writes into the temp
// directory, so both run with it off, in a temp directory of their own, as in
// typecheck.test.mjs.
const childTmp = tempDir("reeve-node-only-");
const env = { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1", TMPDIR: childTmp, TEMP: childTmp, TMP: childTmp };

// What tsc says of `files`, checked as the repository's own are: a project of
// their own that extends its tsconfig.json.
const typecheck = (files) => {
  const dir = tempDir("reeve-ts-");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ extends: join(ROOT, "tsconfig.json"),
    compilerOptions: { typeRoots: [join(ROOT, "node_modules", "@types")] }, include: Object.keys(files) }));
  const r = spawnSync(bin("tsc"), ["-p", dir], { encoding: "utf8", timeout: 120_000, env });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(0, 600) };
};

// Each lint finding in `text`, as a module under src/, by rule and line.
const lint = (text) => {
  const r = spawnSync(bin("eslint"), ["--stdin", "--stdin-filename", join(ROOT, "src", "lint-fixture.mjs"), "--format", "json"],
    { cwd: ROOT, input: text, encoding: "utf8", timeout: 120_000, env });
  let messages = [];
  try { messages = JSON.parse(r.stdout)[0]?.messages ?? []; } catch { /* reported below */ }
  return { found: messages.map((m) => `${m.ruleId}@${m.line}`).sort(), stderr: (r.stderr ?? "").slice(0, 300) };
};

test("the type check refuses TypeScript Node can't strip: an enum, or a namespace with code in it", () => {
  for (const [file, text] of [["enum.ts", "export enum Color { Red }\n"], ["namespace.ts", "export namespace N { export const x = 1; }\n"]]) {
    const r = typecheck({ [file]: text });
    assert.ok(r.status !== 0 && r.out.includes("TS1294"), `${file}: ${JSON.stringify(r)}`);
  }
  // Types alone are stripped, and pass.
  const plain = typecheck({ "plain.ts": "export interface P { x: number }\nexport const p: P = { x: 1 };\n" });
  assert.equal(plain.status, 0, JSON.stringify(plain));
});

test("the type check has no browser types: document is no global, and Node's own are", () => {
  const dom = typecheck({ "dom.ts": "export const title = document.title;\n" });
  assert.ok(dom.status !== 0 && dom.out.includes("'document'"), JSON.stringify(dom));
  const node = typecheck({ "node.ts": "export const u = new URL(\"https://example.com\");\nconst t = setTimeout(() => {}, 0);\nclearTimeout(t);\n" });
  assert.equal(node.status, 0, JSON.stringify(node));
});

test("lint flags CommonJS's names in an ES module, where each throws, and not Node's own globals", () => {
  const r = lint("const fs = require(\"node:fs\");\nmodule.exports = fs;\nconsole.log(__dirname, __filename, exports);\nprocess.exitCode = 0;\n");
  assert.deepEqual(r.found, ["no-undef@1", "no-undef@2", "no-undef@3", "no-undef@3", "no-undef@3"], JSON.stringify(r));
});

test("lint flags an import read above its declaration: imports go first", () => {
  const r = lint("export const early = readFileSync;\nimport { readFileSync } from \"node:fs\";\n");
  assert.deepEqual(r.found, ["no-use-before-define@1"], JSON.stringify(r));
});

test("the type checker and the linter leave nothing in the temp directory", () => {
  assert.deepEqual(readdirSync(childTmp), []);
});
