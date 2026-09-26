// The shell reader proves failures, and never leans on a builtin's success
// (#236): #235's review, and what comparing the reader with real dash and bash
// found beside it.
//
// Each script's exit status in dash 0.5.12 and bash 5.3 is in the comment by
// it. A working script must never read as broken; a failure the reader can't
// be sure of is left unjudged.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { scriptShell } from "../src/profile/shellscript.mjs";
import { bashShell, broken, dashShell, detectTest, eitherShell } from "./fixtures/detect.mjs";

const show = (r) => JSON.stringify(r);
const SHELLS = [dashShell, bashShell, eitherShell];
const LOCAL_TIME = { "node_modules/.bin/time": "#!/bin/sh\nexit 0\n" };

test("! turns a failure into a success, and never a success into a failure", () => {
  // Each passes in bash, and the last four in dash too: a builtin can fail
  // where the reader takes it to succeed.
  for (const s of ["! true", "set -o pipefail; ! true | true", "! export -p -z", "set -o pipefail; ! exit 0 2 | true",
                   "readonly x; ! export x=1", "! export 1abc", "readonly x; ! true | command export x=1"]) {
    for (const sh of SHELLS) {
      const r = detectTest(s, {}, { shell: sh });
      assert.equal(r.state, "present", `${sh.name}: ${s}: ${show(r)}`);
    }
  }
  // dash 127, bash 127: what follows is still judged.
  assert.ok(broken(detectTest("! true; no-such-runner", {}, { shell: bashShell }), "'no-such-runner'"));
});

test("among builtins only true and : surely succeed, so an exit behind || or && may still run", () => {
  // Each passes in bash: the builtin fails, and the exit behind it runs.
  for (const s of ["readonly x; export x=1 || exit 0; false", "export 1abc || exit 0; false", "export -f x || exit 0; false",
                   "readonly x; unset x || exit 0; false", "pwd -Z || exit 0; false", "echo hi >&- || exit 0; false",
                   "trap x NOSIG || exit 0; false", "readonly x; export x=1 && exit 1; true"]) {
    for (const sh of SHELLS) {
      const r = detectTest(s, {}, { shell: sh });
      assert.equal(r.state, "present", `${sh.name}: ${s}: ${show(r)}`);
    }
  }
  // dash 1, bash 1: true and : can't fail, so the exit is skipped.
  for (const s of ["true || exit 0; false", ": || exit 0; false"]) assert.ok(broken(detectTest(s, {}, { shell: bashShell }), "'false'"), s);
  // dash 127, bash 127: a script as package.json has it reads as before.
  for (const s of ["export NODE_ENV=test && no-such-runner", "export NODE_ENV=test; no-such-runner", "set -e; export NODE_ENV=test; no-such-runner"]) {
    const r = detectTest(s, {}, { shell: bashShell });
    assert.ok(broken(r, "'no-such-runner'"), `${s}: ${show(r)}`);
  }
});

test("where only some shells have time as a keyword, its two readings each run on a state of their own", () => {
  // dash 0, bash 127: bash's time runs the export, and dash's runs a program
  // called export, which leaves PATH as it was.
  const path = detectTest("time export PATH=/nowhere; sh -c true", {}, { shell: eitherShell });
  assert.equal(path.state, "present", show(path));
  // dash 0, bash 1: set -e holds in bash alone.
  const errexit = detectTest("time set -e; false; true", {}, { shell: eitherShell });
  assert.equal(errexit.state, "present", show(errexit));
  // Each shell alone reads as before.
  assert.ok(broken(detectTest("time export PATH=/nowhere; sh -c true", {}, { shell: bashShell }), "'sh'"));
  assert.equal(detectTest("time export PATH=/nowhere; sh -c true", {}, { shell: dashShell }).state, "present");
});

test("where only some shells have time as a keyword, whether it ends the script is read both ways", () => {
  // dash 0, bash 3: bash's time runs the exit, and dash's runs a program.
  for (const s of ["time exit 3; true", "time -p exit 3; true"]) {
    const r = detectTest(s, {}, { shell: eitherShell });
    assert.equal(r.state, "present", `${s}: ${show(r)}`);
  }
  assert.ok(broken(detectTest("time exit 3; true", {}, { shell: bashShell }), "exits 3"));
});

test("time before a compound times it, so the words after aren't read as commands of their own", () => {
  // dash 2, bash 0: in bash the braces group; in dash `}` closes nothing.
  for (const sh of [bashShell, eitherShell]) {
    const r = detectTest("time { true; }", {}, { shell: sh });
    assert.equal(r.state, "present", `${sh.name}: ${show(r)}`);
  }
  assert.ok(broken(detectTest("time { true; }", {}, { shell: dashShell }), "syntax error"));
});

const pathOf = (name) => spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
const realBash = pathOf("bash");
test("under real bash, time before if, while or a group times the whole compound", { skip: !realBash && "needs bash" }, () => {
  const shell = scriptShell(realBash);
  // bash 0, 0 and 0.
  for (const s of ["time if true; then true; fi", "time while false; do :; done", "time -p { true; }"]) {
    const r = detectTest(s, {}, { shell });
    assert.equal(r.state, "present", `${s}: ${show(r)}`);
  }
});

test("bash takes time for its own only as the first word of a pipeline: after a |, an assignment or a redirection it runs the program", () => {
  // bash 0, with a local time that exits 0: npm's PATH finds it first.
  for (const s of ["true | time no-such-runner", "X=1 time no-such-runner", ">/dev/null time no-such-runner"]) {
    for (const sh of [bashShell, eitherShell]) {
      const r = detectTest(s, {}, { shell: sh, files: LOCAL_TIME });
      assert.equal(r.state, "present", `${sh.name}: ${s}: ${show(r)}`);
    }
  }
  // bash 127: first in its pipeline, the keyword times the missing program.
  assert.ok(broken(detectTest("time no-such-runner", {}, { shell: bashShell, files: LOCAL_TIME }), "'no-such-runner'"));
});

test("exit's status counts only when it is a number both shells read alike", () => {
  // dash 2, bash 0: dash refuses the number and exits, bash goes on.
  for (const s of ["exit 0x1; true", "exit 1e0; true"]) {
    for (const sh of [bashShell, eitherShell]) {
      const r = detectTest(s, {}, { shell: sh });
      assert.equal(r.state, "present", `${sh.name}: ${s}: ${show(r)}`);
    }
  }
  // dash 0, bash 1: dash refuses a number past an int's and exits 2 in its
  // subshell, where bash exits 0.
  for (const sh of [dashShell, eitherShell]) {
    const r = detectTest("set -o pipefail; exit 4294967296 | true || exit 0; false", {}, { shell: sh });
    assert.equal(r.state, "present", `${sh.name}: ${show(r)}`);
  }
  // dash 3, bash 3; dash 0, bash 0.
  assert.ok(broken(detectTest("exit 3; true", {}, { shell: eitherShell }), "exits 3"));
  assert.equal(detectTest("exit 256; no-such-runner", {}, { shell: eitherShell }).state, "present");
});

test("given more than one argument, exit's status is unsure where the first is 0: bash 5.3 exits 1", () => {
  // dash 1, bash 0: bash's exit fails in its subshell, so the exit behind || runs.
  for (const sh of [bashShell, eitherShell]) {
    const r = detectTest("set -o pipefail; exit 0 2 | true || exit 0; false", {}, { shell: sh });
    assert.equal(r.state, "present", `${sh.name}: ${show(r)}`);
  }
  // dash 3, bash 1: it fails either way.
  assert.ok(broken(detectTest("exit 3 2; true", {}, { shell: eitherShell }), "exits 3"));
});

test("a command that can't fail surely succeeds, so an exit behind || is skipped", () => {
  // dash 1, bash 1 each: a redirection to the null device or a standard
  // descriptor can't fail, a command before the last that writes nothing can't
  // be stopped by the pipe, and outside a pipeline a here-string whose
  // expansion fails ends the script.
  for (const s of ["true 2>/dev/null || exit 0; false", "true 2>&1 || exit 0; false", "set -o pipefail; true | true || exit 0; false",
                   "set -o pipefail; : | true || exit 0; false", "set -o pipefail; exit 0 | true || exit 0; false",
                   "true <<< \"$HOME\" || exit 0; false"]) {
    const r = detectTest(s, {}, { shell: bashShell });
    assert.ok(broken(r, "'false'"), `${s}: ${show(r)}`);
  }
});

test("in a pipeline, a command whose expansion may fail, in a word or a here-string, never surely succeeds", () => {
  // dash 0, bash 0: $((1/0)) fails its command in its subshell, and the exit behind || runs.
  for (const s of ["set -o pipefail; true $((1/0)) | true || exit 0; false", "true | true $((1/0)) || exit 0; false"]) {
    for (const sh of [dashShell, bashShell]) {
      const r = detectTest(s, {}, { shell: sh });
      assert.equal(r.state, "present", `${sh.name}: ${s}: ${show(r)}`);
    }
  }
  // bash 0 each: a here-string's expansion fails its command the same way.
  for (const s of ["set -o pipefail; true <<< $((1/0)) | true || exit 0; false", "true | true <<< $((1/0)) || exit 0; false"]) {
    const r = detectTest(s, {}, { shell: bashShell });
    assert.equal(r.state, "present", `${s}: ${show(r)}`);
  }
});

test("a pipefail that may or may not have been set leaves a pipeline's status unsure", () => {
  // dash 1, bash 1 with no file x; with one, pipefail is set, the pipeline
  // fails, and the exit behind || runs: 0.
  const r = detectTest("test -f x && set -o pipefail; false | true || exit 0; false", {}, { shell: bashShell });
  assert.equal(r.state, "present", show(r));
});

test("in a pipeline, an assignment before a command or alone can fail, and an argument shaped like one can't", () => {
  // dash 1, bash 1: `X=1` is an argument to true.
  assert.ok(broken(detectTest("set -o pipefail; true X=1 | true || exit 0; false", {}, { shell: bashShell }), "'false'"));
  // dash 0, bash 0: the assignment fails in its subshell, and the exit behind || runs.
  assert.equal(detectTest("readonly x; true | x=1 || exit 0; false", {}, { shell: bashShell }).state, "present");
  // dash 0: the assignment before true fails in its subshell.
  assert.equal(detectTest("readonly x; set -o pipefail; x=1 true | true || exit 0; false", {}, { shell: dashShell }).state, "present");
});
