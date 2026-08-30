// The capability switches have exactly ONE reader, and its key set is asserted
// against the strings the OUTBOX actually emits -- not against a list retyped
// here, which would be a third inventory of the same five names and would agree
// with both right up until it did not.
//
// WHY THE FAILURE MODE MATTERS. `leaseEffect` refuses an effect unless its
// capability is exactly `true`. A typo in a key string therefore reads as
// "capability off": fail-closed, so nothing goes red, and the test keeps passing
// for a reason unrelated to what it claims to check.
//
// TWO CONTROLS RUN BEFORE ANY ASSERTION ABOUT THE SET, and neither is optional:
//
//   the derived set is NON-EMPTY. Deriving is not enough on its own -- an import
//   that silently yields nothing makes every assertion over it pass VACUOUSLY,
//   which replaces a typo-shaped bug with a nothing-shaped one. The count is the
//   control.
//
//   a SIXTH key would be noticed. Convergence that holds only until the next
//   switch is added is not convergence, and the person adding it gets no signal.
//
// Both were the peer lane's insistence, from a day of hitting this exact class.

import { CAPABILITY_KEYS, CAPABILITY_NAMES, capabilitiesFrom, capabilityOn }
  from "../src/build/capabilities.mjs";
import { FIELDS } from "../src/profile/schema.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// ── The set exists at all ───────────────────────────────────────────────────
{
  check(CAPABILITY_KEYS.length > 0,
    "control: the derived key set is NON-EMPTY -- every assertion below is vacuous otherwise",
    `${CAPABILITY_KEYS.length} key(s)`);
  check(CAPABILITY_KEYS.length === CAPABILITY_NAMES.length,
    "control: and the bare names match it one for one");
  check(Object.isFrozen(CAPABILITY_KEYS), "and the set cannot be edited by a caller");
}

// ── It agrees with the schema, and is DERIVED from it ───────────────────────
{
  const fromSchema = Object.keys(FIELDS).filter((k) => k.startsWith("builder.capabilities."));
  check(fromSchema.length > 0, "control: the schema really declares capability fields",
    `${fromSchema.length}`);
  check(JSON.stringify(CAPABILITY_KEYS) === JSON.stringify(fromSchema),
    "the key set IS the schema's capability fields, in order",
    `${JSON.stringify(CAPABILITY_KEYS)} vs ${JSON.stringify(fromSchema)}`);
}

// ── It agrees with what the OUTBOX emits ────────────────────────────────────
//
// Recovered from the outbox's SOURCE rather than from a list here. The strings
// it maps kinds to are the ones that must match; a test that retyped them would
// be the very inventory this module removes.
{
  const outbox = readFileSync(join(HERE, "..", "src", "build", "outbox.mjs"), "utf8");
  const emitted = [...new Set([...outbox.matchAll(/"(builder\.capabilities\.\w+)"/g)].map((m) => m[1]))];

  check(emitted.length > 0,
    "control: the outbox's capability strings are readable in its source at all",
    `${emitted.length} found`);
  const unknown = emitted.filter((k) => !CAPABILITY_KEYS.includes(k));
  check(unknown.length === 0,
    "every capability the outbox gates on is one the schema declares",
    unknown.length ? `the outbox names ${unknown.join(", ")}, which the schema does not` : "");
}

// ── A SIXTH key would be noticed ────────────────────────────────────────────
//
// The count is pinned deliberately. When a switch is added this fails, and the
// person adding it is told to cover it here rather than discovering months later
// that nothing gated it. Updating this number is the acknowledgement.
{
  check(CAPABILITY_KEYS.length === 5,
    "the schema declares exactly FIVE switches -- add one and update this, having covered it",
    `${CAPABILITY_KEYS.length}: ${CAPABILITY_NAMES.join(", ")}`);
}

// ── The map is the shape leaseEffect expects ────────────────────────────────
{
  const all = capabilitiesFrom({ builder: { capabilities: Object.fromEntries(
    CAPABILITY_NAMES.map((n) => [n, true])) } });
  check(CAPABILITY_KEYS.every((k) => all[k] === true), "a profile with every switch on maps them all to true");
  check(Object.keys(all).length === CAPABILITY_KEYS.length,
    "control: and a profile declaring every switch produces every key, so absence below is about the PROFILE",
    `${Object.keys(all).length} of ${CAPABILITY_KEYS.length}`);

  // ── ABSENCE IS PRESERVED, and this is the assertion that was wrong ─────────
  //
  // The first version of this file asserted that a bare profile carries EVERY
  // key AND that every one of them is `false`. Those two together pin the
  // collapse rather than the distinction: `leaseEffect` reads
  // `capabilities[cap] === undefined` to choose between "is not set; every
  // builder capability defaults to off" and "is off", so filling absent keys
  // with `false` makes an operator read a decision that was never made.
  //
  // Asserted through leaseEffect's OWN predicate, not a restatement of it.
  const K = "builder.capabilities.publishPr";
  const bare = capabilitiesFrom({});
  const declaredOff = capabilitiesFrom({ builder: { capabilities: { publishPr: false } } });
  const declaredOn = capabilitiesFrom({ builder: { capabilities: { publishPr: true } } });

  check(bare[K] === undefined, "a capability the profile OMITS is absent from the map, not false",
    JSON.stringify(bare));
  check(declaredOff[K] === false, "one the profile DECLARES false is present as false",
    JSON.stringify(declaredOff));
  check((bare[K] === undefined) !== (declaredOff[K] === undefined),
    "so leaseEffect's `=== undefined` test tells them apart -- the only signal an operator has " +
    "to distinguish 'never enabled' from 'turned off'");

  // AND BOTH STILL REFUSE. The distinction is about the DIAGNOSTIC, not the
  // decision: `leaseEffect` gates on `!== true`, and absent and false are both
  // correctly "not enabled". A fix that preserved absence by making it pass
  // would be far worse than the bug it replaced.
  check(bare[K] !== true && declaredOff[K] !== true,
    "control: and both are still refused, because the gate is `!== true`");
  check(declaredOn[K] === true, "control: while a declared-true capability is enabled");

  // Both diagnostics really are in the outbox, recovered from its source rather
  // than retyped -- without this the assertion above is about a distinction that
  // might no longer exist downstream.
  const outboxSrc = readFileSync(join(HERE, "..", "src", "build", "outbox.mjs"), "utf8");
  check(/is not set; every builder capability defaults to off/.test(outboxSrc)
        && /\$\{cap\} is off/.test(outboxSrc),
    "control: the outbox really writes two different diagnostics, so the distinction has a consumer");

  // NOT COERCED. The schema refuses a truthy string; a profile that arrived with
  // one anyway must not have it silently become enabled. It is DECLARED, so it
  // appears -- as false.
  const truthy = capabilitiesFrom({ builder: { capabilities: { observe: "yes" } } });
  check(truthy["builder.capabilities.observe"] === false,
    "a truthy STRING is not coerced to on -- it is refused, which is what the validator does too");
}

// ── An unknown name is an error, not a false ────────────────────────────────
{
  check(capabilityOn({ builder: { capabilities: { observe: true } } }, "observe") === true,
    "capabilityOn reads a switch by its bare name");
  check(capabilityOn({ builder: { capabilities: { observe: true } } },
                     "builder.capabilities.observe") === true,
    "and by its full key");
  check(capabilityOn({}, "observe") === false, "and answers false for a switch that is off");

  let threw = null;
  try { capabilityOn({}, "obsrve"); } catch (e) { threw = e; }
  check(threw !== null,
    "a name the schema does not declare THROWS -- answering false would be indistinguishable " +
    "from a switch that is off, so a typo would fail closed and silently for ever");
  check(/obsrve/.test(threw?.message ?? "") && /observe/.test(threw?.message ?? ""),
    "and the error names both what was asked and what exists", threw?.message);
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exitCode = fail ? 1 : 0;
