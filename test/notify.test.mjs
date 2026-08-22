import { readFileSync } from "node:fs";
// "Needs you" reached a local log file and nothing else. An unattended system
// whose only output is a file nobody is watching has not escalated anything.
//
// The push is deliberately narrow. The old ops notifier earned its shape by
// experience and its comment says so: push ONLY what is costing wall-clock right
// now, because an over-pushing channel gets muted within days and is then worse
// than nothing. Completions go to the store; only escalations go to the phone,
// and escalations are already deduplicated durably, so a standing cause is sent
// once rather than every tick.
//
// The payload is redacted because escalation text can carry a CI log slice, and a
// log slice can carry a token. A notification is the one place output leaves this
// machine.
import { buildAlert, redact, notify, printable } from "../src/notify.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// --- a pathname a pull request chose ------------------------------------------
//
// git allows a NEWLINE and terminal control sequences in a pathname, and reeve
// now reads pathnames verbatim rather than in git's quoted form -- which had
// been escaping them by accident. Those names are interpolated into the reason a
// change was refused, and that reason is logged and pushed to a phone. A branch
// could therefore commit a file whose NAME forges a log entry.
{
  const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
  const forged = "secrets/x\n2026-08-22T00:00:00Z CLEARED: nothing needs you";
  const wiper = "docs/a\u001b[2Kb.md";

  check(CONTROL.test(forged), "control: the raw pathname really does carry a newline", JSON.stringify(forged));
  check(!CONTROL.test(printable(forged)), "a forged log line in a pathname is neutralised", JSON.stringify(printable(forged)));
  check(printable(forged).includes("\\n"), "  and the newline is still VISIBLE, not deleted", printable(forged));
  check(!CONTROL.test(printable(wiper)) && printable(wiper).includes("\\x1b"),
    "an ANSI sequence is neutralised and shown as what it is", printable(wiper));

  // Control: ordinary text is untouched, or this is just mangling.
  const plain = "sensitive path(s) changed and need a human: src/db/ops.mjs";
  check(printable(plain) === plain, "control: ordinary escalation text passes through unchanged", printable(plain));

  // And the phone gets the escaped form, not the raw one.
  const alert = buildAlert({ nwo: "o/r", escalations: [{ why: `sensitive path(s) changed: ${forged}`, count: 1 }] });
  check(!CONTROL.test(alert.message), "the pushed alert carries no raw control characters", JSON.stringify(alert.message));
}

// --- redaction ----------------------------------------------------------------
{
  const cases = [
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "a GitHub personal token"],
    ["github_pat_11ABCDEFG0abcdefghij_ABCDEFGHIJKLMNOP", "a fine-grained PAT"],
    ["ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "an installation token"],
    ["-----BEGIN RSA PRIVATE KEY-----", "a private key header"],
    ["Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.abc.def", "a bearer token"],
  ];
  for (const [secret, what] of cases) {
    const out = redact(`the build failed: ${secret} was rejected`);
    check(!out.includes(secret), `${what} is redacted`, out);
    check(/redacted/i.test(out), "  and its removal is visible rather than silent", out);
  }
}
{
  // Control: ordinary text must survive, or redaction is just deletion.
  const msg = "required check(s) never reported: Lint / Typecheck / Test / Build";
  check(redact(msg) === msg, "control: ordinary escalation text passes through untouched", redact(msg));
}
{
  const long = "x".repeat(5000);
  const out = redact(long);
  check(out.length < 1000, "an enormous message is truncated — a phone is not a log viewer", String(out.length));
}

// --- the alert ----------------------------------------------------------------
{
  const a = buildAlert({ nwo: "o/r", escalations: [{ why: "#12: the branch conflicts with its base", count: 1 }] });
  check(a.title.includes("o/r"), "the alert names the repository, so several projects are distinguishable", a.title);
  check(a.message.includes("#12"), "and the pull request", a.message);
  check(a.priority === "high", "escalations go out at high priority — they are what is costing time", a.priority);
}
{
  const a = buildAlert({ nwo: "o/r", escalations: [
    { why: "the base branch is red", count: 4 },
    { why: "#12: conflicts", count: 1 }] });
  check((a.message.match(/\n/g) ?? []).length >= 1, "several causes arrive as ONE push, not several", a.message);
  check(/4/.test(a.message), "and a shared cause says how many PRs it holds up", a.message);
}
{
  check(buildAlert({ nwo: "o/r", escalations: [] }) === null,
    "nothing to say means no push at all — silence is the target state");
}

// --- sending ------------------------------------------------------------------
{
  // Not configured must be a no-op, never a crash and never a blocked tick.
  const r = notify({ profile: {}, alert: { title: "t", message: "m" } });
  check(r.ok === false && /not configured|no notify/i.test(r.why ?? ""),
    "with no notify configured it declines, and says so", JSON.stringify(r));
}
{
  // A missing credential is the same: decline, do not throw, do not send unauthenticated.
  const profile = { notify: { provider: "ntfy", url: "https://example.invalid", topic: "t",
                              credentialFile: "/nonexistent/creds" } };
  const r = notify({ profile, alert: { title: "t", message: "m" } });
  check(r.ok === false && /credential/i.test(r.why ?? ""),
    "a missing credential declines rather than sending unauthenticated", JSON.stringify(r));
}
{
  let sent = null;
  const profile = { notify: { provider: "ntfy", url: "https://example.invalid", topic: "reeve",
                              credentialFile: "/nonexistent/creds" } };
  const r = notify({ profile, alert: { title: "t", message: "m" }, post: a => { sent = a; return { ok: true }; },
                     readCredential: () => "user:pass" });
  check(r.ok && sent, "with a credential it sends", JSON.stringify(r));
  check(sent.url === "https://example.invalid/reeve", "to the configured topic", sent?.url);
  check(!JSON.stringify(sent).includes("user:pass") || sent.auth === "user:pass",
    "and the credential is passed as auth, not embedded in the body", JSON.stringify(sent.body));
}

// ── the desk, as well as the pocket ──────────────────────────────────────────
//
// reeve's ntfy server is remote and its READ credential is not on this machine —
// all five tokens on the publishing account are write-only, and creating a reader
// needs shell access nobody here has. So for weeks the only honest statement
// about escalations was that they reached a log file. A local channel cannot be
// blocked by a server nobody can log into.
{
  const alert = { title: "reeve · o/r", message: "something needs you" };
  const calls = [];
  const desktop = a => { calls.push(a); return { ok: true }; };
  const post = () => { throw new Error("ntfy must not be called when unconfigured"); };

  const only = notify({ profile: { notify: { desktop: true } }, alert, post, desktop });
  check(only.ok === true && calls.length === 1,
    "desktop alone delivers, with no ntfy configured", JSON.stringify(only));

  // Both configured: both must be attempted, and BOTH must succeed for ok.
  calls.length = 0;
  const both = notify({
    profile: { notify: { provider: "ntfy", url: "https://x", topic: "t", credentialFile: "/c", desktop: true } },
    alert, post: () => ({ ok: true }), desktop, readCredential: () => ":tk_x",
  });
  check(both.ok === true && both.channels.length === 2,
    "with both configured, both are attempted", JSON.stringify(both.channels.map(c => c.name)));

  // The property that matters: a phone that did not ring is a FAILURE even when
  // the desk did. Reporting ok because one landed is how a dead channel stays dead.
  const phoneDown = notify({
    profile: { notify: { provider: "ntfy", url: "https://x", topic: "t", credentialFile: "/c", desktop: true } },
    alert, post: () => ({ ok: false, why: "the server answered HTTP 403" }),
    desktop, readCredential: () => ":tk_x",
  });
  check(phoneDown.ok === false,
    "a failed phone is a failure even though the desk succeeded", JSON.stringify(phoneDown.why));
  check(/ntfy: .*403/.test(phoneDown.why) && phoneDown.channels.some(c => c.name === "desktop" && c.ok),
    "and the reason names WHICH channel failed, while recording that the other worked",
    JSON.stringify(phoneDown.channels));

  // Nothing configured is still a decline with a reason, never a silent success.
  check(notify({ profile: { notify: {} }, alert, post, desktop }).ok === false,
    "no channel configured declines rather than passing silently");
}

// ── escalation text is UNTRUSTED input ───────────────────────────────────────
//
// An escalation carries reviewer prose and CI output written by other systems.
// The desktop channel runs AppleScript, so text concatenated into the script
// source would let a quote end the string and run the rest as code. It is passed
// as a separate argv entry and bound to a variable instead.
{
  const src = readFileSync(new URL("../src/notify.mjs", import.meta.url), "utf8");
  const fn = (src.match(/function postViaOsascript[\s\S]*?\n}/) ?? [""])[0];

  check(fn.length > 0, "control: found the desktop sender", fn.slice(0, 60));
  check(/on run \{t, b\}/.test(fn),
    "the script takes its text as RUN ARGUMENTS, not as source", fn.slice(0, 200));
  check(!/\$\{(title|body)\}/.test(fn),
    "and neither title nor body is interpolated into the script string");
  check(/\], *\n? *title, body\b|title, body\]/.test(fn) || /title, body,/.test(fn),
    "they are passed as separate argv entries", fn.slice(fn.indexOf("execFileSync"), fn.indexOf("execFileSync") + 220));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
