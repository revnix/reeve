// notify — the only thing reeve says out loud.
//
// "Needs you" reached a local log file and nothing else, which for an unattended
// system means it had not escalated anything at all.
//
// The shape is inherited from the ops notifier it replaces, whose comment earned
// its own rule: push ONLY what is costing wall-clock right now, because an
// over-pushing channel gets muted within days and is then worse than nothing.
// Completions go to the store; only escalations reach a phone. Escalations are
// already deduplicated durably, so a standing cause is sent when it arrives and
// when it changes, never on every tick.
//
// Everything here fails SOFT — a notifier that can take the loop down has made
// the system less reliable, not more — but never SILENTLY: every decline is
// returned with a reason so the caller can log it. A push channel nobody knows is
// broken is the same as no push channel.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Patterns for things that must never leave this machine.
 *
 * Escalation text can carry a slice of a CI log, and a CI log can carry a token
 * that was echoed by a failing command. A notification is the one place output
 * crosses the boundary, so it is the one place this has to be checked.
 */
const SECRETS = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted token]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted token]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "[redacted key]"],
  [/\b(?:Bearer|token)\s+[A-Za-z0-9._\-]{16,}/gi, "[redacted credential]"],
  [/\b[A-Za-z0-9._%+-]+:[^@\s/]{6,}@/g, "[redacted userinfo]@"],
];

const LIMIT = 700;

/**
 * Text a pull request wrote, made safe to put in front of a human.
 *
 * A pathname may hold a NEWLINE or a terminal control sequence -- git allows it,
 * and reeve now reads pathnames verbatim rather than in git's quoted form, which
 * had been escaping them by accident. Those names are interpolated into the
 * reason a change was refused, and that reason is written to the operational log
 * and pushed to a phone. So a branch could commit a file whose NAME holds a
 * newline followed by a plausible timestamp and "CLEARED: nothing needs you",
 * forging a log entry -- or carry an ANSI sequence that rewrites what a human
 * sees when they tail the log. The raw name is what the risk globs match on;
 * this is only for display. (Codex #10-[4].)
 *
 * C0, DEL and C1 are all neutralised: a JS string holding U+0080-U+009F encodes
 * to bytes a terminal may still read as an escape introducer.
 */
const NAMED = { "\n": "\\n", "\r": "\\r", "\t": "\\t", "\0": "\\0" };
export const printable = text =>
  String(text ?? "").replace(/[\u0000-\u001F\u007F-\u009F]/g,
    c => NAMED[c] ?? `\\x${c.codePointAt(0).toString(16).padStart(2, "0")}`);

/** Strip anything secret, and cap the length. A phone is not a log viewer. */
export function redact(text) {
  let s = String(text ?? "");
  for (const [re, with_] of SECRETS) s = s.replace(re, with_);
  return s.length > LIMIT ? s.slice(0, LIMIT) + " […truncated]" : s;
}

/**
 * One push for everything that arrived this tick, or null when there is nothing
 * to say. Silence is the target state, so no escalations means no notification —
 * not an empty one.
 */
export function buildAlert({ nwo, escalations }) {
  const list = (escalations ?? []).filter(e => e && e.why);
  if (!list.length) return null;
  const lines = list.map(e => redact(printable(e.count > 1 ? `${e.why} (${e.count} PRs)` : e.why)));
  return {
    title: `reeve · ${nwo}`,
    message: lines.join("\n"),
    priority: "high",
    tags: "warning",
  };
}

/**
 * The desk, as well as the pocket.
 *
 * The phone channel is the one that matters when nobody is here; this one matters
 * when somebody is. They are independent on purpose -- reeve's ntfy server is
 * remote and its read credential is not on this machine, so for weeks the only
 * honest statement about escalations was that they reached a log file. A local
 * channel cannot be blocked by a server nobody can log into.
 *
 * osascript rather than a dependency, because reeve has none and a notifier is
 * the wrong place to acquire the first one. Text is passed as a SEPARATE argv
 * entry and interpolated by AppleScript variable, never concatenated into the
 * script source: an escalation carries reviewer text and CI output written by
 * other systems, and a quote in it would otherwise end the string and run the
 * rest as code.
 */
function postViaOsascript({ title, body }) {
  try {
    execFileSync("osascript",
      ["-e", 'on run {t, b}\ndisplay notification b with title t sound name "Submarine"\nend run',
       title, body],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 8000 });
    return { ok: true };
  } catch (e) { return { ok: false, why: String(e.message).split("\n")[0] }; }
}

function postViaCurl({ url, auth, title, priority, tags, body }) {
  try {
    const args = ["-s", "-m", "8", "-o", "/dev/null", "-w", "%{http_code}",
                  "-u", auth,
                  "-H", `Title: ${title}`, "-H", `Priority: ${priority}`, "-H", `Tags: ${tags}`,
                  "-d", body, url];
    const code = execFileSync("curl", args, { encoding: "utf8" }).trim();
    return code.startsWith("2") ? { ok: true } : { ok: false, why: `the server answered HTTP ${code}` };
  } catch (e) { return { ok: false, why: String(e.message).split("\n")[0] }; }
}

/**
 * Send one alert.
 *
 * `post` and `readCredential` are injectable so this is testable without a
 * network or a real secret. Declines when unconfigured or uncredentialed, and
 * never sends unauthenticated: an open topic is a public one.
 */
export function notify({ profile, alert, post = postViaCurl, desktop = postViaOsascript, readCredential = null }) {
  if (!alert) return { ok: false, why: "nothing to send" };
  const cfg = profile?.notify ?? {};
  const channels = [];

  if (cfg.provider === "ntfy") {
    const read = readCredential ?? (p => {
      try { return readFileSync(p, "utf8").trim(); } catch { return null; }
    });
    const auth = cfg.credentialFile ? read(cfg.credentialFile) : null;
    if (!cfg.url || !cfg.topic) {
      channels.push({ name: "ntfy", ok: false, why: "notify.url and notify.topic are both required" });
    } else if (!auth) {
      channels.push({ name: "ntfy", ok: false,
                      why: `no credential at ${cfg.credentialFile ?? "(unset)"} — refusing to publish to an unauthenticated topic` });
    } else {
      const r = post({
        url: `${cfg.url.replace(/\/$/, "")}/${cfg.topic}`, auth,
        title: alert.title, priority: alert.priority ?? "default",
        tags: alert.tags ?? "warning", body: alert.message,
      });
      channels.push({ name: "ntfy", ...r });
    }
  }

  if (cfg.desktop === true) {
    channels.push({ name: "desktop", ...desktop({ title: alert.title, body: alert.message }) });
  }

  if (!channels.length) return { ok: false, why: "no notify channel configured", channels };

  // Every CONFIGURED channel must have worked. A phone that did not ring is a
  // failure even when the desk did, because the two exist for different moments
  // -- reporting ok because one of them landed is how a dead channel stays dead.
  const failed = channels.filter(c => !c.ok);
  return failed.length
    ? { ok: false, why: failed.map(c => `${c.name}: ${c.why}`).join("; "), channels }
    : { ok: true, channels };
}
