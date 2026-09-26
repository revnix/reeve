// The shell reader: #225's fourth review (#234), and `time` where only some of
// the shells that may run a script have it as a keyword (#228).
//
// Each script's exit status in dash 0.5.12 and bash 5.3 is in the comment by
// it. A broken script must never read as present when the reader could know,
// and a working one must never read as broken.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { scriptShells } from "../src/profile/shellscript.mjs";
import { bashShell, broken, dashShell, detectTest, eitherShell } from "./fixtures/detect.mjs";

const show = (r) => JSON.stringify(r);

test("an assignment-shaped argument isn't an assignment: only a leading one, or export's and readonly's operands, can fail", () => {
  // dash 1, bash 1: `true` ignores its arguments and succeeds.
  for (const sh of [dashShell, bashShell]) {
    const r = detectTest("set -o pipefail; ! true X=1 | true", {}, { shell: sh });
    assert.ok(broken(r, "always fails"), `${sh.name}: ${show(r)}`);
  }
  // Still unsure where an assignment may fail: before the command, or through export.
  // Each passes in bash: the assignment fails in its subshell.
  for (const s of ["readonly x; set -o pipefail; ! x=1 true | true", "readonly x; set -o pipefail; ! export x=1 | true", "readonly x; ! true | export x=1"]) {
    const r = detectTest(s, {}, { shell: bashShell });
    assert.equal(r.state, "present", `${s}: ${show(r)}`);
  }
});

test("under pipefail, exit before the last command writes nothing, so it surely succeeds as its status says", () => {
  // dash 1, bash 1.
  for (const sh of [dashShell, bashShell]) {
    const r = detectTest("set -o pipefail; ! exit 0 | true", {}, { shell: sh });
    assert.ok(broken(r, "always fails"), `${sh.name}: ${show(r)}`);
  }
});

test("where either shell may run the script, export -p to a writable PATH succeeds in both, and a read-only PATH keeps its value", () => {
  // dash 1, bash 1: dash lists, bash assigns, and both succeed.
  const bang = detectTest("! export -p PATH=/nowhere", {}, { shell: eitherShell });
  assert.ok(broken(bang, "always fails"), show(bang));
  // dash 127, bash 127: neither changes a read-only PATH.
  const kept = detectTest("readonly PATH; export -p PATH=/nowhere; no-such-runner", {}, { shell: eitherShell });
  assert.ok(broken(kept, "'no-such-runner'"), show(kept));
  // Still unsure where the shells differ: bash may assign a writable PATH, dash won't.
  const either = detectTest("export -p PATH=/nowhere; sh -c true", {}, { shell: eitherShell });
  assert.equal(either.state, "present", show(either));
});

test("where either shell may run the script, unset -fv of a read-only PATH fails in both", () => {
  // dash 2, bash 127: bash refuses both options, dash fails to unset a read-only PATH.
  const r = detectTest("readonly PATH; unset -fv PATH; no-such-runner", {}, { shell: eitherShell });
  assert.equal(r.state, "broken", show(r));
});

test("time where only some of the shells have it as a keyword is read both ways", () => {
  // dash 0 (the local time runs), bash 127 (the keyword times the missing program).
  const local = { "node_modules/.bin/time": "#!/bin/sh\nexit 0\n" };
  const either = detectTest("time no-such-runner", {}, { shell: eitherShell, files: local });
  assert.equal(either.state, "present", show(either));
  // Where both readings fail, it fails: no local time, and the system's runs the missing program too.
  const both = detectTest("time no-such-runner", {}, { shell: eitherShell });
  assert.ok(broken(both, "'no-such-runner'"), show(both));
  // Each shell alone is read as before.
  assert.ok(broken(detectTest("time no-such-runner", {}, { shell: bashShell, files: local }), "'no-such-runner'"));
  assert.equal(detectTest("time no-such-runner", {}, { shell: dashShell, files: local }).state, "present");
});

const pathOf = (name) => spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
const [dashPath, bashPath] = [pathOf("dash"), pathOf("bash")];
test("shells merged for a script say which keywords every one of them has", { skip: !(dashPath && bashPath) && "needs dash and bash" }, () => {
  const merged = scriptShells([dashPath, bashPath]);
  assert.ok(merged.keywords.has("time") && merged.allKeywords?.has("if") === true && !merged.allKeywords.has("time"),
    show({ keywords: [...merged.keywords], allKeywords: merged.allKeywords && [...merged.allKeywords] }));
});
