// R-14 and R-15 report the two facts the daemon's dispatch refusal rests on,
// from the same sources: the persisted canary result and the keychain probe.
// Absent is UNKNOWN, never OK; a held credential is BROKEN with the fix named.
import { checkCanary, checkKeychain, checkRemoteReach, founderCredential, runDoctor } from "../src/doctor.mjs";
import { instrumentHash } from "../src/canary.mjs";
import { sandboxFor } from "../src/sandbox.mjs";
import { policyHashOf } from "../src/canary.mjs";
import { writeCanaryState } from "../src/canary.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const root = mkdtempSync(join(tmpdir(), "reeve-doctor-cont-"));

// ── R-16: publication reach ──────────────────────────────────────────────────
//
// Publication is a `git push` from the founder's checkout, so it needs what that
// checkout's origin needs -- a credential helper, a URL rewrite, an ssh key.
// Nothing measured any of that, and on 2026-08-22 none of it worked.
//
// The credential half is the part that matters and the part that is easy to get
// wrong: on a PUBLIC repository an anonymous `ls-remote` succeeds while a push
// would not, so a check built on reachability alone reports OK for exactly the
// repository reeve watches.
{
  const seams = (reach, cred) => {
    const asked = [], askedFor = [];
    return {
      asked, askedFor,
      run: (cwd, args) => {
        asked.push(args[0] === "remote" && args.includes("--push") ? "remote --push" : args[0]);
        if (args[0] === "remote") {
          // git returns only the FIRST push url without `--all`. Modelling that
          // is what lets a stub which drops the flag be seen at all.
          const all = (args.includes("--push") ? reach.pushUrl : reach.url) ?? reach.url ?? "https://github.com/o/r.git";
          return { ok: true, out: args.includes("--all") ? all : String(all).split("\n")[0] };
        }
        if (args[0] === "ls-remote") {
          askedFor.push(args[1]);
          const byUrl = reach.lsRemoteFor?.[args[1]];
          if (byUrl) return byUrl;
          return (args[1] === "origin" ? reach.lsRemote : reach.lsRemotePush) ?? { ok: true, out: "abcdef1234567890  refs/heads/main" };
        }
        // `git config --get-urlmatch http.<key> <url>` — exits 1 when nothing matches.
        if (args[0] === "config") {
          asked.push(args[1]);
          const hit = reach.httpAuth?.[args[2]];
          return hit ? { ok: true, out: hit } : { ok: false, out: "", err: "" };
        }
        return { ok: false, out: "", err: "unexpected" };
      },
      credential: (cwd, url) => { asked.push("credential"); askedFor.push(url); return cred; },
    };
  };
  const pub = { identity: { checkout: "/co", defaultBranch: "main", visibility: "public" } };

  {
    const c = checkRemoteReach({ identity: {} }, seams({}, { ok: true }));
    check(c.id === "R-16" && c.level === "UNKNOWN", "no checkout in the profile: UNKNOWN", JSON.stringify(c.lines));
  }
  {
    const io = seams({ url: "" }, { ok: true });
    io.run = args => ({ ok: false, out: "", err: "fatal: No such remote 'origin'" });
    const c = checkRemoteReach(pub, io);
    check(c.level === "BROKEN" && /no origin/.test(c.lines[0]), "a checkout with no origin: BROKEN", c.lines.join(" | "));
  }
  {
    const c = checkRemoteReach(pub, seams({ lsRemote: { ok: false, out: "", err: "fatal: could not read Username for 'https://github.com'" } }, { ok: true }));
    check(c.level === "BROKEN" && /cannot reach it/.test(c.lines[1]) && /could not read Username/.test(c.lines[1]),
      "a remote reeve's git cannot reach: BROKEN, in git's own words", c.lines.join(" | "));
    check(/nothing else reports this/.test(c.lines.join(" ")),
      "  and it says why no other check would notice", c.lines.join(" | "));
  }
  {
    // The case a reachability-only check gets wrong.
    const io = seams({}, { ok: false, why: "fatal: could not read Username for 'https://github.com'" });
    const c = checkRemoteReach(pub, io);
    check(c.level === "BROKEN", "reachable but no credential: BROKEN, not OK", c.lines.join(" | "));
    check(/PUBLIC/.test(c.lines.join(" ")) && /proves nothing about a push/.test(c.lines.join(" ")),
      "  and it names the public-repository trap that makes the read misleading", c.lines.join(" | "));
    check(io.asked.includes("credential"), "  the credential was actually asked for", io.asked.join(","));
  }
  {
    const io = seams({}, { ok: true });
    const c = checkRemoteReach(pub, io);
    check(c.level === "OK", "control: reachable AND a credential available is OK", c.lines.join(" | "));
    check(!/password|token|ghp_|gho_/.test(c.lines.join(" ")),
      "  and no credential value appears anywhere in the report", c.lines.join(" | "));
  }
  {
    // ssh authenticates through the transport, so the reach already exercised it
    // and there is no https credential to ask for.
    const io = seams({ url: "git@github.com:o/r.git" }, { ok: false, why: "should not be asked" });
    const c = checkRemoteReach({ identity: { checkout: "/co", defaultBranch: "main" } }, io);
    check(c.level === "OK", "an ssh origin that answers is OK", c.lines.join(" | "));
    check(!io.asked.includes("credential"),
      "  and no https credential is asked for, which would be the wrong question", io.asked.join(","));
  }
}

// ── R-16, the four ways it asked the wrong question ──────────────────────────
{
  const seams = (reach, cred) => {
    const asked = [], askedFor = [];
    return {
      asked, askedFor,
      run: (cwd, args) => {
        asked.push(args[0] === "remote" && args.includes("--push") ? "remote --push" : args[0]);
        if (args[0] === "remote") {
          // git returns only the FIRST push url without `--all`. Modelling that
          // is what lets a stub which drops the flag be seen at all.
          const all = (args.includes("--push") ? reach.pushUrl : reach.url) ?? reach.url ?? "https://github.com/o/r.git";
          return { ok: true, out: args.includes("--all") ? all : String(all).split("\n")[0] };
        }
        if (args[0] === "ls-remote") {
          askedFor.push(args[1]);
          const byUrl = reach.lsRemoteFor?.[args[1]];
          if (byUrl) return byUrl;
          return (args[1] === "origin" ? reach.lsRemote : reach.lsRemotePush) ?? { ok: true, out: "abcdef1234567890  refs/heads/main" };
        }
        // `git config --get-urlmatch http.<key> <url>` — exits 1 when nothing matches.
        if (args[0] === "config") {
          asked.push(args[1]);
          const hit = reach.httpAuth?.[args[2]];
          return hit ? { ok: true, out: hit } : { ok: false, out: "", err: "" };
        }
        return { ok: false, out: "", err: "unexpected" };
      },
      credential: (cwd, url) => { asked.push("credential"); askedFor.push(url); return cred; },
    };
  };
  const pub = { identity: { checkout: "/co", defaultBranch: "main", visibility: "public" } };

  {
    // `git push origin` uses remote.origin.pushurl when it is set, so the fetch
    // url is the wrong transport AND the wrong credential to ask about.
    // Measured 2026-08-23: get-url and get-url --push return different values.
    const io = seams({ url: "https://github.com/o/fetchside.git", pushUrl: "https://github.com/o/PUSHSIDE.git" }, { ok: true });
    const c = checkRemoteReach(pub, io);
    check(io.asked.includes("remote --push"), "the PUSH url is what gets probed", io.asked.join(","));
    check(io.askedFor.includes("https://github.com/o/PUSHSIDE.git"),
      "  and the credential is asked for that url, not the fetch one", io.askedFor.join(" "));
    check(c.lines.some(l => /PUSHSIDE/.test(l)), "  and the report names it", c.lines.join(" | "));
  }
  {
    // A separate push url is reached in its own right: `ls-remote origin` reads
    // through the FETCH url and says nothing about the other one.
    const io = seams({ url: "https://github.com/o/r.git", pushUrl: "https://github.com/o/p.git",
                       lsRemotePush: { ok: false, out: "", err: "fatal: repository not found" } }, { ok: true });
    const c = checkRemoteReach(pub, io);
    check(c.level === "BROKEN" && /push url https:\/\/github\.com\/o\/p\.git cannot be reached/.test(c.lines.join(" ")),
      "a push url that does not answer is BROKEN even when the fetch url does", c.lines.join(" | "));
  }
  {
    // `git remote get-url` EXPANDS insteadOf, so a rewrite to a credential-
    // bearing URL hands the credential back and it was printed verbatim.
    const io = seams({ url: "https://user:s3cr3t-token@example.com/o/r.git" }, { ok: true });
    const c = checkRemoteReach(pub, io);
    const all = c.lines.join(" | ");
    check(!/s3cr3t-token/.test(all) && !/user:/.test(all),
      "userinfo in an origin url never reaches the report", all);
    check(/\[redacted\]@example\.com/.test(all), "  and its removal is visible rather than silent", all);
  }
  {
    // credential.useHttpPath keeps separate credentials per repository on one
    // host, so protocol+host is not the question a push asks. Measured 2026-08-23
    // against a helper that records what git asked it: a host-only fill returns a
    // HOST-WIDE credential where the path-qualified one has none.
    const io = seams({ url: "https://example.com/o/two.git" }, { ok: true });
    checkRemoteReach(pub, io);
    check(io.askedFor.some(u => u === "https://example.com/o/two.git"),
      "the whole url is what the check hands to the credential machinery", io.askedFor.join(" "));

    // And what the credential machinery then ASKS git. The assertion above only
    // covers the caller: with the seam injected, `founderCredential` never runs,
    // so a version of it that threw the url away and asked by host would pass it.
    let sent = null;
    founderCredential("/co", "https://example.com/o/two.git",
                      { run: (cwd, args, opts) => { sent = { args, input: opts?.input }; return { ok: true, out: "password=x\n" }; } });
    check(sent?.args?.join(" ") === "credential fill", "  it runs `git credential fill`", JSON.stringify(sent?.args));
    check(sent?.input === "url=https://example.com/o/two.git\n\n",
      "  and asks it by url, not by protocol and host — the form that carries the path", JSON.stringify(sent?.input));
  }
  {
    // http:// was grouped with ssh and local, so a public http repository
    // reproduced the exact false green the https branch exists to prevent.
    const io = seams({ url: "http://example.com/o/r.git" }, { ok: false, why: "no helper answered" });
    const c = checkRemoteReach(pub, io);
    check(c.level === "BROKEN" && io.asked.includes("credential"),
      "a plain http origin takes the credential path too", `${c.level} ${io.asked.join(",")}`);
  }
  {
    // Control: no pushurl set, so git returns the fetch url for both and there
    // is exactly one url to reach and one credential to ask for.
    const io = seams({ url: "https://github.com/o/r.git", pushUrl: "https://github.com/o/r.git" }, { ok: true });
    const c = checkRemoteReach(pub, io);
    check(c.level === "OK", "control: one url for both is OK", c.lines.join(" | "));
    check(io.askedFor.filter(u => u && u.startsWith("http")).length === 1,
      "  and nothing is probed twice", io.askedFor.join(" "));
    check(!c.lines.some(l => /push url/.test(l)), "  and no second url is reported", c.lines.join(" | "));
  }
}

// ── R-16, round two ──────────────────────────────────────────────────────────
{
  const seams = (reach, cred) => {
    const asked = [], askedFor = [];
    return {
      asked, askedFor,
      run: (cwd, args) => {
        asked.push(args[0] === "remote" && args.includes("--push") ? "remote --push" : args[0]);
        if (args[0] === "remote") {
          // git returns only the FIRST push url without `--all`. Modelling that
          // is what lets a stub which drops the flag be seen at all.
          const all = (args.includes("--push") ? reach.pushUrl : reach.url) ?? reach.url ?? "https://github.com/o/r.git";
          return { ok: true, out: args.includes("--all") ? all : String(all).split("\n")[0] };
        }
        if (args[0] === "ls-remote") {
          askedFor.push(args[1]);
          const byUrl = reach.lsRemoteFor?.[args[1]];
          if (byUrl) return byUrl;
          return (args[1] === "origin" ? reach.lsRemote : reach.lsRemotePush) ?? { ok: true, out: "abcdef1234567890  refs/heads/main" };
        }
        if (args[0] === "config") {
          asked.push(args[1]);
          const hit = reach.httpAuth?.[args[2]];
          return hit ? { ok: true, out: hit } : { ok: false, out: "", err: "" };
        }
        return { ok: false, out: "", err: "unexpected" };
      },
      credential: (cwd, url) => { asked.push("credential"); askedFor.push(url); return cred; },
    };
  };
  const pub = { identity: { checkout: "/co", defaultBranch: "main", visibility: "public" } };

  {
    // `git push origin` affects EVERY configured pushurl, and `get-url --push`
    // returns only the first — measured 2026-08-23, two pushurls give one value
    // without `--all` and both with it. Checking the first alone reports OK for
    // a remote whose second destination cannot be reached.
    const io = seams({
      url: "https://github.com/o/r.git",
      pushUrl: "https://github.com/o/one.git\nhttps://github.com/o/two.git",
      lsRemoteFor: { "https://github.com/o/two.git": { ok: false, out: "", err: "fatal: repository not found" } },
    }, { ok: true });
    const c = checkRemoteReach(pub, io);
    check(io.askedFor.includes("https://github.com/o/one.git") && io.askedFor.includes("https://github.com/o/two.git"),
      "every configured push url is probed, not just the first", io.askedFor.join(" "));
    check(c.level === "BROKEN" && /two\.git cannot be reached/.test(c.lines.join(" ")),
      "  and a later push destination that cannot be reached is BROKEN", c.lines.join(" | "));
  }
  {
    // A credential helper is not the only way http authenticates.
    // `http.<url>.extraHeader` is used by ls-remote and by the real push while
    // `credential fill` knows nothing about it, so a silent helper is not proof
    // that publication is broken.
    const io = seams({ url: "https://enterprise.example/o/r.git",
                       httpAuth: { "http.extraHeader": "Authorization: Bearer SECRET-HEADER-VALUE" } },
                     { ok: false, why: "no helper answered" });
    const c = checkRemoteReach(pub, io);
    check(c.level === "DEGRADED", "http auth configured outside a helper is DEGRADED, not BROKEN", c.lines.join(" | "));
    check(/http\.extraHeader/.test(c.lines.join(" ")) && /cannot verify/.test(c.lines.join(" ")),
      "  and it names the mechanism and says it is unverified", c.lines.join(" | "));
    check(!/SECRET-HEADER-VALUE/.test(c.lines.join(" ")),
      "  and the header's VALUE never reaches the report", c.lines.join(" | "));
    check(io.asked.includes("--get-urlmatch"), "  resolved with git's own per-url matching", io.asked.join(","));
  }
  {
    // Control: no alternative configured, so a silent helper is still BROKEN.
    const io = seams({ url: "https://enterprise.example/o/r.git" }, { ok: false, why: "no helper answered" });
    const c = checkRemoteReach(pub, io);
    check(c.level === "BROKEN", "control: a silent helper with nothing else configured is still BROKEN", c.lines.join(" | "));
  }
}

// ── R-14 ─────────────────────────────────────────────────────────────────────
{
  const c = checkCanary("o/r", { stateDir: null });
  check(c.id === "R-14" && c.level === "UNKNOWN", "no state dir: UNKNOWN", JSON.stringify(c));
}
{
  const c = checkCanary("o/r", { stateDir: root });
  check(c.level === "UNKNOWN" && /no canary has been recorded/.test(c.lines[0]), "no recorded canary: UNKNOWN, and it says dispatch is refused meanwhile", c.lines.join(" | "));
}
{
  const rec = { id: "abc123", cliVersion: "2.1.237", bin: "/bin/claude", binaryId: "/bin/claude@1", policyHash: "pol1", instrument: "inst1", ok: true, why: null, at: 1_000_000 };
  writeCanaryState(root, "o/r", rec);
  const c = checkCanary("o/r", { stateDir: root, now: () => 1_000_000 + 5 * 60_000, identity: () => "/bin/claude@1", currentPolicyHash: "pol1", currentInstrument: "inst1" });
  check(c.level === "OK" && /abc123 passed 5 min ago under 2\.1\.237/.test(c.lines[0]), "a passing canary under the SAME binary and policy is OK with id, age and CLI", c.lines.join(" | "));
  // The DEFAULT expectation, with nothing injected. `measuredContainment` always
  // builds a netListener, so a record it writes carries the hasNet instrument —
  // and doctor defaulting to the other variant reported every freshly recorded
  // pass as a changed script, which is permanently DEGRADED on a healthy host.
  // `instrumentHash({ hasNet: true })` explicitly, NOT `currentInstrument()`:
  // the record has to carry what production writes, so that a default which
  // drifts from it is visible. Written with the same function doctor defaults
  // to, both sides move together and the assertion proves nothing.
  writeCanaryState(root, "o/r", { ...rec, instrument: instrumentHash({ hasNet: true }) });
  const live = checkCanary("o/r", { stateDir: root, now: () => 1_000_000, identity: () => "/bin/claude@1", currentPolicyHash: "pol1" });
  check(live.level === "OK",
    "a record carrying the instrument production writes is OK against doctor's DEFAULT", live.lines.join(" | "));
  writeCanaryState(root, "o/r", rec);
  const swapped = checkCanary("o/r", { stateDir: root, now: () => 1_000_000, identity: () => "/bin/claude@2", currentPolicyHash: "pol1", currentInstrument: "inst1" });
  check(swapped.level === "DEGRADED" && /DIFFERENT build/.test(swapped.lines[0]), "a passing canary under a REPLACED binary is DEGRADED, not OK", swapped.lines.join(" | "));
  // The binary can be unchanged while the policy the daemon generates has moved.
  const repol = checkCanary("o/r", { stateDir: root, now: () => 1_000_000, identity: () => "/bin/claude@1", currentPolicyHash: "pol2", currentInstrument: "inst1" });
  check(repol.level === "DEGRADED" && /DIFFERENT sandbox policy/.test(repol.lines[0]), "an unchanged binary under a CHANGED policy is DEGRADED, not OK", repol.lines.join(" | "));
  // Unreconstructible policy: the comparison is left unmade rather than assumed.
  const unk = checkCanary("o/r", { stateDir: root, now: () => 1_000_000, identity: () => "/bin/claude@1", currentPolicyHash: null, currentInstrument: "inst1" });
  check(unk.level === "OK", "a policy that cannot be recomputed does not manufacture a failure", unk.level);
  writeCanaryState(root, "o/r", { ...rec, policyHash: undefined });
  const nopol = checkCanary("o/r", { stateDir: root, now: () => 1_000_000, identity: () => "/bin/claude@1", currentInstrument: "inst1" });
  check(nopol.level === "UNKNOWN" && /names no sandbox policy/.test(nopol.lines[0]), "a record with no policy to compare is UNKNOWN, never OK", nopol.lines.join(" | "));
  // The INSTRUMENT is the third thing a record can be historical about. A canary
  // script strengthened with a new probe leaves the binary and the policy
  // identical while describing a weaker measurement, and doctor reads the
  // PERSISTED record — which the daemon's in-memory cache does not speak for.
  writeCanaryState(root, "o/r", { ...rec, instrument: "inst0" });
  const reinst = checkCanary("o/r", { stateDir: root, now: () => 1_000_000, identity: () => "/bin/claude@1", currentPolicyHash: "pol1", currentInstrument: "inst1" });
  check(reinst.level === "DEGRADED" && /DIFFERENT canary script/.test(reinst.lines[0]),
    "an unchanged binary and policy under a CHANGED canary script is DEGRADED, not OK", reinst.lines.join(" | "));
  // And a record written before the instrument was persisted at all: it cannot
  // be compared, so it is UNKNOWN rather than inherited as a pass.
  writeCanaryState(root, "o/r", { ...rec, instrument: undefined });
  const noinst = checkCanary("o/r", { stateDir: root, now: () => 1_000_000, identity: () => "/bin/claude@1", currentPolicyHash: "pol1", currentInstrument: "inst1" });
  check(noinst.level === "UNKNOWN" && /names no instrument/.test(noinst.lines[0]),
    "a record from before the instrument was recorded is UNKNOWN, never OK", noinst.lines.join(" | "));
  writeCanaryState(root, "o/r", rec);
  writeCanaryState(root, "o/r", { id: "old", cliVersion: "2.1.237", ok: true, at: 1_000_000 });
  const hist = checkCanary("o/r", { stateDir: root, now: () => 1_000_000 });
  check(hist.level === "UNKNOWN" && /names no CLI binary/.test(hist.lines[0]), "a record with no binary to compare is UNKNOWN, never OK", hist.lines.join(" | "));
}
{
  writeCanaryState(root, "o/r", { id: "abc123", cliVersion: "2.1.237", ok: false, why: "wrote outside the worktree", at: 1_000_000 });
  const c = checkCanary("o/r", { stateDir: root, now: () => 1_000_000 + 30_000 });
  check(c.level === "BROKEN" && /FAILED under a minute ago/.test(c.lines[0]) && /wrote outside/.test(c.lines[0]), "a failed canary is BROKEN with its reason", c.lines.join(" | "));
}
{
  const c = checkCanary("o/r", { stateDir: root, read: () => ({ ok: "yes", id: "x" }) });
  check(c.level === "BROKEN", "a state whose ok is not exactly true is not a pass", JSON.stringify(c));
}

// ── R-15 ─────────────────────────────────────────────────────────────────────
//
// The keychain stopped being the gate when workers gained a scratch HOME: the
// search list lives in the home directory, so a worker has no login keychain to
// ask, whatever the founder's holds. R-15 therefore REPORTS the keychain and
// gates on the two things that still decide -- the isolation the profile
// declares, and whether the worker has a credential of its own to run with.
//
// `token` is injected in every case. The real reader looks at
// ~/.reeve/claude-token, so a default would make these assertions pass or fail
// on whether this particular machine happens to have one.
const HAS_TOKEN = () => ({ ok: true, token: "sk-ant-oat01-test", why: null });
const EMPTY_KC = () => ({ measured: true, items: [], why: null });
const HELD_KC = () => ({ measured: true, items: ["generic password gh:github.com (gh keyring)"], why: "holds" });
{
  const c = checkKeychain({ probe: EMPTY_KC, isolation: "scratch-home", topologyReady: () => true, token: HAS_TOKEN });
  check(c.id === "R-15" && c.level === "OK", "a declared scratch HOME, a ready topology and a worker token is OK", JSON.stringify(c));
  check(/cannot read it/.test(c.lines.join(" ")) && /scratch directory/.test(c.lines.join(" ")),
    "and it says WHY the worker cannot reach the keychain, rather than that the keychain is empty", c.lines.join(" | "));
}
{
  // The behaviour that changed. A credential in the founder's keychain no longer
  // refuses dispatch, because the worker cannot reach it -- and saying otherwise
  // sent a reader off to delete a credential that was never the problem.
  const c = checkKeychain({ probe: HELD_KC, isolation: "scratch-home", topologyReady: () => true, token: HAS_TOKEN });
  check(c.level === "OK", "a keychain that HOLDS a GitHub credential is still OK, because a worker cannot reach it", JSON.stringify(c));
  check(/gh keyring/.test(c.lines[0]), "and what it holds is reported rather than hidden", c.lines.join(" | "));
  check(!/REFUSED/.test(c.lines.join(" ")) && !/--insecure-storage/.test(c.lines.join(" ")),
    "and it no longer claims dispatch is refused, nor tells anyone to delete it", c.lines.join(" | "));
}
{
  const c = checkKeychain({ probe: EMPTY_KC, isolation: "none", token: HAS_TOKEN });
  check(c.level === "DEGRADED" && /worker\.isolation is 'none'/.test(c.lines.join(" ")) && /scratch-home/.test(c.lines.join(" ")),
    "no declared isolation is DEGRADED, and names the setting that closes it", c.lines.join(" | "));
  check(/observation and review are unaffected/.test(c.lines.join(" ")), "and it says the guardian's other work is unaffected", c.lines.join(" | "));
}
{
  const c = checkKeychain({ probe: EMPTY_KC, isolation: "scratch-home", topologyReady: () => false, token: HAS_TOKEN });
  check(c.level === "DEGRADED", "the isolation LABEL without a ready topology is DEGRADED, not OK", JSON.stringify(c.level));
}
{
  // dedicated-user is stronger AND unbuilt. Reading it as OK would grant a
  // health nothing implements; the daemon refuses it by name for the same reason.
  const c = checkKeychain({ probe: EMPTY_KC, isolation: "dedicated-user", topologyReady: () => true, token: HAS_TOKEN });
  check(c.level === "DEGRADED", "an isolation reeve has not built does not read as OK", JSON.stringify(c.level));
}
{
  // A scratch HOME takes ~/.claude away too, so the token is not optional: with
  // none, every dispatch fails while preparing the worker and backs off.
  const c = checkKeychain({ probe: EMPTY_KC, isolation: "scratch-home", topologyReady: () => true,
                            token: () => ({ ok: false, why: "/Users/x/.reeve/claude-token could not be read (ENOENT); create one with `claude setup-token`" }) });
  check(c.level === "DEGRADED" && /setup-token/.test(c.lines.join(" ")),
    "an isolated worker with no credential of its own is DEGRADED, and says how to make one", c.lines.join(" | "));
  check(!/keychain holds/.test(c.lines.join(" ")), "and does not blame the keychain for it", c.lines.join(" | "));
}
{
  const c = checkKeychain({ probe: () => ({ measured: false, items: [], why: "security exited 1" }),
                            isolation: "scratch-home", topologyReady: () => true, token: HAS_TOKEN });
  check(c.level === "OK" && /unmeasured/.test(c.lines[0]),
    "an unmeasured keychain is reported and no longer gates, because the reach is closed either way", c.lines.join(" | "));
}

// ── in the driver ────────────────────────────────────────────────────────────
{
  const r = runDoctor({ nwo: "o/r", profile: {}, stateDir: root, keychainIo: { probe: EMPTY_KC, token: HAS_TOKEN },
                        baselineIo: { fixturePath: join(root, "none.json") } });
  const ids = r.checks.map(c => c.id);
  check(ids.includes("R-14") && ids.includes("R-15"), "both checks run in the driver", ids.join(","));
  check(r.verdict === "BROKEN" && r.checks.find(c => c.id === "R-14").level === "BROKEN", "and a failed canary makes the verdict BROKEN", r.verdict);
}

// ── the recomputed policy must follow the PROFILE, not the record ────────────
//
// The record supplies only the state roots the daemon knew (a --log or --db this
// command cannot see); everything else is generated from the profile as it is
// now, or a changed quarantine path would leave the hash equal to the old one
// and doctor would keep reporting OK while the daemon re-measures.
{
  const roots = ["/s/reeve.log", "/s/runs"];
  const base = { units: [], risk: {} };
  const withQ = { units: [], risk: { quarantinePaths: ["secrets/**"] } };
  const hash = prof => policyHashOf(sandboxFor({ profile: prof, action: "FIX_CI", worktree: "/wt/canary", tmpDir: "<tmp>", stateRoots: roots }).settings.sandbox, "/wt/canary");
  check(hash(base) !== hash(withQ), "adding a quarantine path changes the recomputed policy hash", `${hash(base)} vs ${hash(withQ)}`);
  const withCred = { units: [], notify: { credentialFile: "/etc/reeve/tok" } };
  check(hash(base) !== hash(withCred), "and so does declaring a notification credential", `${hash(base)} vs ${hash(withCred)}`);
  check(hash(base) === hash({ units: [], risk: {} }), "control: an unchanged profile hashes the same", "");
}

rmSync(root, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
