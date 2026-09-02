// paging -- the pass that carries a standing escalation to a human.
//
// Everything else here RECORDS escalations and nothing delivered them.
// `applyTransition` writes a row with `announced_count = 0` -- raised, not yet
// announced -- and `announce` knows how to deliver one, but no production path
// ever called it. So causes accumulated in the hub, correctly, and nobody was
// ever told: the machinery was complete and unwired, which reads from outside
// exactly like a system with nothing to report.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { announce } from "./announce.mjs";
import { notify } from "../notify.mjs";
import { isSameProcess } from "../supervisor.mjs";
import { homedir } from "node:os";

/** What a bare `reeve` command resolves when nothing names a home. */
const defaultHome = () => join(homedir(), ".reeve");

/**
 * The machine's own notify profile.
 *
 * A BUILDER ALARM BELONGS TO THE MACHINE, not to any repository. The identities
 * that page -- `builder:backup:failed` among them -- name no project by design,
 * and every notify profile that exists today belongs to a project. Routing a
 * machine-scoped cause through one would send it to a channel that vanishes the
 * day that project is deregistered, and deliver it under a repository name that
 * has nothing to do with the fault.
 *
 * Beside the hub rather than inside a project, because that is the scope it
 * describes: `~/.reeve/state/hub.db` is the machine's store, so
 * `~/.reeve/profile.json` is the machine's profile.
 */
export const machineProfilePath = (home) => join(home, "profile.json");

/**
 * The credential a configured ntfy channel needs, or null.
 *
 * SAME READ `notify` MAKES, so the doctor and the sender cannot disagree: an
 * empty file is as unusable as a missing one, which is why this trims before
 * deciding rather than testing existence.
 */
const readCredentialAt = (file) => {
  try {
    const v = readFileSync(file, "utf8").trim();
    return v === "" ? null : v;
  } catch { return null; }
};

/**
 * That profile, or the reason there is none -- never one standing for the other.
 *
 * A SENTENCE, NOT A NULL. "No profile is configured", "the file is unreadable"
 * and "it carries no notify block" are three different situations with three
 * different fixes, and an operator whose alarms are going nowhere is owed which
 * one it is. They collapse to `profile: null` for the caller and stay apart in
 * `why`.
 */
export function machineProfile(home) {
  const path = machineProfilePath(home);
  if (!existsSync(path))
    return { profile: null, path,
             why: `no machine notify profile at ${path}, so a builder alarm has nowhere to go` };
  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) {
    return { profile: null, path, why: `${path} is not readable JSON: ${e.message}` };
  }
  if (!raw?.notify || typeof raw.notify !== "object")
    return { profile: null, path, why: `${path} carries no \`notify\` block, so no channel is configured` };
  // A BLOCK IS NOT A CHANNEL. `{ "notify": {} }` parses, is an object, and
  // configures nothing -- `notify` then produces no channels at all and declines
  // every page. Treating the block's presence as deliverability made the doctor
  // report a machine that can reach nobody as healthy, which is the exact
  // assurance H-14 exists to withhold.
  //
  // The condition mirrors `notify`'s own: it builds an ntfy channel when the
  // provider says so, and a desktop channel when `desktop` is true. Asking the
  // same question here rather than a looser one keeps the doctor's answer and the
  // sender's behaviour from disagreeing.
  const cfg = raw.notify;
  const ntfy = cfg.provider === "ntfy" && !!cfg.url && !!cfg.topic;
  // THE CREDENTIAL IS PART OF THE CHANNEL, not a detail beside it. `notify`
  // refuses to publish to an unauthenticated topic deterministically, so an ntfy
  // channel whose credential file is unset, empty or unreadable declines EVERY
  // send -- and calling that machine able to page is the same false assurance an
  // empty block gave, one field deeper.
  //
  // READ, not merely named. A path that points nowhere is the ordinary way this
  // breaks, and `notify` discovers it at send time whatever the config says; a
  // doctor that only checked the key would disagree with the sender exactly when
  // an operator was relying on it.
  const credential = ntfy && cfg.credentialFile ? readCredentialAt(cfg.credentialFile) : null;
  // A DESKTOP CHANNEL ONLY EXISTS WHERE IT CAN RUN. `postViaOsascript` executes
  // `osascript`, which is macOS-only, so `{ "desktop": true }` on Linux or
  // Windows is a valid-looking configuration whose every send fails with ENOENT
  // -- and reeve is required to run on all three. Reporting those machines as
  // able to page is the same false assurance an empty block gave, in the one
  // place a config file cannot reveal it.
  const desktop = cfg.desktop === true && process.platform === "darwin";
  const usable = (ntfy && credential !== null) || desktop;
  if (!usable)
    return { profile: null, path,
             why: cfg.desktop === true && !desktop
               ? `${path} configures only a desktop channel, which runs \`osascript\` and exists ` +
                 `on macOS alone -- this machine is ${process.platform}`
               : ntfy
               ? `${path} names an ntfy channel whose credential is unreadable at ` +
                 `${cfg.credentialFile ?? "(unset)"}, and notify refuses to publish to an ` +
                 `unauthenticated topic`
               : `${path} configures no usable channel: \`notify\` needs provider "ntfy" with url, ` +
                 `topic and a readable credentialFile, or desktop true` };
  return { profile: raw, path, why: null };
}

/**
 * One pass: every standing cause, offered to whoever the machine pages.
 *
 * THE COUNT IS THE CHANGE SIGNAL, not the presence -- `announce` announces a
 * cause on arrival and when its count changes, never per tick. That property was
 * paid for in production: the first launchd run announced the same two conditions
 * on all five of its ticks, which at a 2.5-minute cadence is hundreds of pushes
 * overnight for nothing that changed, and that is how an unattended system trains
 * its owner to ignore it.
 *
 * NOTHING RETIRES HERE, and that is a decision rather than an omission.
 * `examined` names the subjects a pass actually looked at, and this pass looks at
 * none: the builder tick refreshes gate state and evaluates no task, so it cannot
 * vouch that any cause is resolved. Retiring on that silence would announce
 * "resolved" for something nobody examined, and then re-announce it on the next
 * pass that did look -- two pushes for one unchanged condition, which is the same
 * way a channel earns being muted.
 */
/**
 * How long one pass may spend delivering, in milliseconds.
 *
 * A HEARTBEAT LOOP MUST NOT BLOCK ON A CHANNEL. Sending is synchronous, so an
 * unbounded backlog against a slow or unreachable channel stalls the loop for as
 * long as the backlog is deep -- past the 120-second singleton lease, at which
 * point the daemon can lose the authority it is holding while it waits to finish
 * a page. The alarm would have cost the thing it was reporting on.
 *
 * A DEADLINE RATHER THAN A COUNT, because a count does not bound the work. One
 * `notify` call sends on EVERY configured channel in turn, so a machine with both
 * ntfy and desktop configured spends up to two 8-second timeouts on a single
 * page: a cap of five pages is 80 seconds, not the 40 it was chosen for, and a
 * third channel would move the number again. The deadline holds whatever the
 * channels are.
 *
 * 30 seconds, checked BEFORE each send, so the worst case is 30 plus one send
 * already in flight -- about 46 with two channels. With the loop's own 30-second
 * sleep that leaves roughly 44 seconds of the lease for the tick and everything
 * else, and it does not move when a channel is added.
 *
 * Nothing is lost by stopping: an undelivered cause keeps `announced_count`
 * unchanged and is offered again next pass, the same mechanism that makes a
 * refused page come back.
 */
export const PAGING_BUDGET_MS = 30_000;

/**
 * Where in the standing set this pass begins.
 *
 * FAIRNESS, because a bounded queue read in a fixed order starves its tail. Five
 * owed causes whose sender permanently rejects them consume the whole budget on
 * every pass, so a sixth that WOULD deliver is never attempted -- it stays owed
 * for ever while the log reports work being done. Ordering by `first_seen_at`
 * makes that deterministic rather than unlikely.
 *
 * The caller advances this per pass, so the offset is the loop's state rather
 * than hidden module state, and a test can drive it directly. A restart resetting
 * it to zero is harmless: rotation only has to be eventually fair, not stable.
 */
export const rotated = (rows, by) => {
  if (rows.length === 0) return rows;
  const k = ((by % rows.length) + rows.length) % rows.length;
  return k === 0 ? rows : [...rows.slice(k), ...rows.slice(0, k)];
};

export function pageStandingCauses(db, { home, at = undefined, isAlive = isSameProcess,
                                         send = null, budgetMs = PAGING_BUDGET_MS,
                                         rotate = 0, now = undefined } = {}) {
  const { profile, why } = machineProfile(home);
  // A SENDER THAT REFUSES BY NAME, rather than skipping the pass. `announce`
  // leaves `announced_count` at 0 for a page its sender refused, so every cause
  // standing while no profile is configured is delivered by the first pass AFTER
  // one is -- rather than being lost to the silence in between. Skipping the pass
  // entirely would also skip the record that it could not be made.
  const sender = send ?? (alert => (profile ? notify({ profile, alert }) : { ok: false, why }));
  // THE WHOLE STANDING SET, in a rotated order. Totality is what keeps a cause
  // from silently becoming a clearing candidate; the rotation is what keeps the
  // tail from starving once the budget bounds how many are attempted. Both
  // matter, and neither substitutes for the other.
  const rows = db.prepare("SELECT why, count FROM escalation ORDER BY first_seen_at, why").all();
  const escalations = new Map(rotated(rows, rotate).map(r => [r.why, r.count]));
  // OBSERVE: FALSE, because this pass observes nothing. It re-reads the rows
  // another writer recorded, so it has no evidence any cause is still true --
  // only that nobody has retired it. Recording that as a sighting would move
  // `last_seen_at` forward on every heartbeat, making a condition seen once read
  // as continuously present, and would append a row image per standing cause per
  // pass. The announcement bookkeeping still writes, because announcing IS what
  // this pass does.
  const result = announce(db, { escalations, at, isAlive, send: sender, profile,
                                examined: null, observe: false, budgetMs,
                                ...(now ? { now } : {}),
                                homeArg: home === defaultHome() ? null : home });
  return { ...result, standing: escalations.size, deliverable: profile !== null, why };
}
