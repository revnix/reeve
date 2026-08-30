// capabilities -- the one reader of the builder's capability switches.
//
// WHY THIS FILE EXISTS. The five switches are declared once in
// `src/profile/schema.mjs` and read in several places, and every reader that
// spells the key strings out for itself is a SECOND INVENTORY of the same five
// names. `test/hub-outbox.test.mjs` built its map by writing all five by hand;
// so would every future call site.
//
// The failure mode is the nasty one. `leaseEffect` refuses an effect unless its
// capability is exactly `true`, so a typo in a key string reads as "capability
// off" -- which is FAIL-CLOSED, and therefore invisible. Nothing goes red. The
// test still passes, and it passes for a reason that has nothing to do with what
// it claims to check.
//
// So the key set is DERIVED from `FIELDS` rather than listed. A sixth switch
// added to the schema appears here without anyone remembering to add it, and a
// key renamed there stops existing here rather than silently reading as off.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not decide WHICH capability an
// effect needs -- that is `capabilityFor` in `src/build/outbox.mjs`, which reads
// a row's kind and arguments, and it stays private there. This module answers
// "what are the switches, and what is this profile's setting for them", and
// nothing about what any particular effect requires.

import { FIELDS } from "../profile/schema.mjs";

/** The prefix that makes a field one of the capability switches. */
const PREFIX = "builder.capabilities.";

/**
 * Every capability key the profile schema declares, in declaration order.
 *
 * DERIVED, not listed. A list here would be the second inventory this module
 * exists to remove, and it would agree with the schema right up until it did
 * not.
 */
export const CAPABILITY_KEYS = Object.freeze(
  Object.keys(FIELDS).filter((k) => k.startsWith(PREFIX)));

/** The bare switch name, without the prefix: `observe`, `publishPr`, ... */
export const CAPABILITY_NAMES = Object.freeze(
  CAPABILITY_KEYS.map((k) => k.slice(PREFIX.length)));

/**
 * This profile's setting for every switch, as the map `leaseEffect` expects.
 *
 * EVERY key is present, including the ones the profile does not mention, and
 * absent means `false`. That is not a convenience: `leaseEffect` distinguishes
 * an absent capability ("is not set; every builder capability defaults to off")
 * from an explicitly false one, and a map missing keys would report the wrong
 * one of those in the row's `last_error` -- which is the only thing an operator
 * has to tell "the founder never enabled this" from "the founder turned it off".
 *
 * A non-boolean is NOT coerced. The schema refuses a truthy string at
 * validation; a profile that reached here with one anyway must not have it
 * silently become `true`.
 */
export function capabilitiesFrom(profile) {
  const set = profile?.builder?.capabilities ?? {};
  const out = {};
  for (const key of CAPABILITY_KEYS) out[key] = set[key.slice(PREFIX.length)] === true;
  return Object.freeze(out);
}

/**
 * One switch, by its bare name or its full key.
 *
 * THROWS on a name the schema does not declare, and that is the whole point.
 * Answering `false` for an unknown name is indistinguishable from answering
 * `false` for a switch that is off, so a typo in a call site would read as
 * "capability off" and fail closed -- silently, and for ever.
 */
export function capabilityOn(profile, name) {
  const key = name?.startsWith?.(PREFIX) ? name : `${PREFIX}${name}`;
  if (!CAPABILITY_KEYS.includes(key))
    throw new Error(`no such builder capability: ${name} ` +
      `(the schema declares ${CAPABILITY_NAMES.join(", ")})`);
  return capabilitiesFrom(profile)[key] === true;
}
