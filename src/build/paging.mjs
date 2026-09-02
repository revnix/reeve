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
  const usable = (ntfy && credential !== null) || cfg.desktop === true;
  if (!usable)
    return { profile: null, path,
             why: ntfy
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
 * How many causes one pass may try to deliver.
 *
 * A HEARTBEAT LOOP MUST NOT BLOCK ON A CHANNEL. Sending is synchronous and each
 * attempt can take up to `notify`'s own 8-second timeout, so an unbounded backlog
 * against a slow or unreachable channel stalls the loop for as long as the
 * backlog is deep -- past the 120-second singleton lease, at which point the
 * daemon can lose the authority it is holding while it waits to complete a page.
 * The alarm would then have cost the thing it was reporting on.
 *
 * Five, so the worst case is ~40 seconds against a dead channel and the tick and
 * lease renewal still fit inside the lease. Nothing is lost by stopping: an
 * undelivered cause keeps `announced_count` unchanged and is offered again on the
 * next pass, which is the same mechanism that makes a refused page come back.
 */
export const PAGES_PER_PASS = 5;

export function pageStandingCauses(db, { home, at = undefined, isAlive = isSameProcess,
                                         send = null, limit = PAGES_PER_PASS } = {}) {
  const { profile, why } = machineProfile(home);
  // A SENDER THAT REFUSES BY NAME, rather than skipping the pass. `announce`
  // leaves `announced_count` at 0 for a page its sender refused, so every cause
  // standing while no profile is configured is delivered by the first pass AFTER
  // one is -- rather than being lost to the silence in between. Skipping the pass
  // entirely would also skip the record that it could not be made.
  const sender = send ?? (alert => (profile ? notify({ profile, alert }) : { ok: false, why }));
  const escalations = new Map(
    db.prepare("SELECT why, count FROM escalation ORDER BY first_seen_at")
      .all().map(r => [r.why, r.count]));
  // OBSERVE: FALSE, because this pass observes nothing. It re-reads the rows
  // another writer recorded, so it has no evidence any cause is still true --
  // only that nobody has retired it. Recording that as a sighting would move
  // `last_seen_at` forward on every heartbeat, making a condition seen once read
  // as continuously present, and would append a row image per standing cause per
  // pass. The announcement bookkeeping still writes, because announcing IS what
  // this pass does.
  const result = announce(db, { escalations, at, isAlive, send: sender, profile,
                                examined: null, observe: false, limit,
                                homeArg: home === defaultHome() ? null : home });
  return { ...result, standing: escalations.size, deliverable: profile !== null, why };
}
