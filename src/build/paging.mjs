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
export function pageStandingCauses(db, { home, at = undefined, isAlive = isSameProcess,
                                         send = null } = {}) {
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
                                examined: null, observe: false });
  return { ...result, standing: escalations.size, deliverable: profile !== null, why };
}
