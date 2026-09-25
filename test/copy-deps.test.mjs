// Copying a dependency tree into a run checkout (#155).
//
// `cp -R from to` copies INTO a directory that already exists, one level too
// deep, and still succeeds. A copy-on-write copy that fails partway, as it does
// when the source can clone but the destination is on another volume, has
// already made `to`; the plain retry then nested the tree under it and reported
// success, and the worker had no dependencies where it looked. These tests fail
// the first attempt partway with an injected `cp`, then check where the tree
// lands, and that a failed or refused copy leaves nothing behind or untouched.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyDeps } from "../src/checkout.mjs";
import { platformFor } from "../src/platform.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const root = mkdtempSync(join(tmpdir(), "reeve-copy-deps-"));
const host = platformFor("linux");
const from = join(root, "src", "node_modules");
mkdirSync(join(from, "left-pad"), { recursive: true });
writeFileSync(join(from, "left-pad", "index.js"), "module.exports = 1\n");

// A `cp` whose copy-on-write attempts fail after making part of the tree, as a
// clone across volumes does. Plain copies are real unless `plainFails`.
const failingClone = ({ plainFails = false } = {}) => {
  const calls = [];
  const exec = (cmd, args, opts) => {
    const to = args.at(-1), cow = args.includes("--reflink=always");
    calls.push(cow ? "cow" : "plain");
    if (cow || plainFails) {
      mkdirSync(join(to, "left-pad"), { recursive: true });
      writeFileSync(join(to, "left-pad", "partial"), "");
      throw Object.assign(new Error("cp failed"), { stderr: "cp: failed to clone: Invalid cross-device link" });
    }
    return execFileSync(cmd, args, opts);
  };
  return { exec, calls };
};

try {
  // ── control: an ordinary copy lands where it belongs ────────────────────────
  {
    const to = join(root, "plain", "nm");
    mkdirSync(join(root, "plain"));
    const r = copyDeps(from, to, { cow: false, host });
    check(r.ok && existsSync(join(to, "left-pad", "index.js")), "control: an ordinary copy lands where it belongs", JSON.stringify(r));
  }

  // ── a failed copy-on-write copy is retried from a clean destination ─────────
  {
    const to = join(root, "retry", "nm");
    mkdirSync(join(root, "retry"));
    const { exec, calls } = failingClone();
    const r = copyDeps(from, to, { cow: true, host, exec });
    check(calls.join(",") === "cow,plain", "control: the copy-on-write attempt failed and a plain copy followed", calls.join(","));
    check(r.ok && r.cow === false && existsSync(join(to, "left-pad", "index.js"))
      && !existsSync(join(to, "node_modules")) && !existsSync(join(to, "left-pad", "partial")),
    "a failed copy-on-write copy is retried from a clean destination, not nested inside what it left",
    JSON.stringify({ r, nested: existsSync(join(to, "node_modules")), partial: existsSync(join(to, "left-pad", "partial")) }));
  }

  // ── a destination already in the checkout is refused and left as it was ─────
  {
    const to = join(root, "committed", "nm");
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, "keep.txt"), "committed by the repository\n");
    let called = 0;
    const r = copyDeps(from, to, { cow: false, host, exec: (...a) => { called++; return execFileSync(...a); } });
    check(!r.ok && /already in the checkout/.test(r.why ?? "") && called === 0 && !existsSync(join(to, "node_modules"))
      && readFileSync(join(to, "keep.txt"), "utf8") === "committed by the repository\n",
    "a destination already in the checkout is refused, not copied into one level deep", JSON.stringify({ r, called }));
  }

  // ── a dangling symlink there is refused too, and not removed ────────────────
  {
    const to = join(root, "dangling", "nm");
    mkdirSync(join(root, "dangling"));
    symlinkSync(join(root, "no-such-target"), to);
    const { exec } = failingClone({ plainFails: true });
    const r = copyDeps(from, to, { cow: true, host, exec });
    let link = false; try { link = lstatSync(to).isSymbolicLink(); } catch { /* removed */ }
    check(!r.ok && /already in the checkout/.test(r.why ?? "") && link && !existsSync(join(root, "no-such-target")),
      "a dangling symlink at the destination is refused, and neither followed nor removed", JSON.stringify(r));
  }

  // ── a copy that fails for good leaves nothing behind ────────────────────────
  {
    const to = join(root, "gone", "nm");
    mkdirSync(join(root, "gone"));
    const both = failingClone({ plainFails: true });
    const r = copyDeps(from, to, { cow: true, host, exec: both.exec });
    check(!r.ok && /cross-device/.test(r.why ?? "") && !existsSync(to),
      "a copy that fails for good leaves no partial tree behind", JSON.stringify({ r, left: existsSync(to) }));
    const plain = failingClone({ plainFails: true });
    const p = copyDeps(from, to, { cow: false, host, exec: plain.exec });
    check(!p.ok && !existsSync(to), "control: nor does a plain copy that fails", JSON.stringify(p));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
