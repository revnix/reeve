// The authority baseline: the live ruleset, branch protection, and profile facts
// as they stood when the builder programme froze authority, compared against
// every later reading.
//
// Drift here is never a bug report, it is an authority change: a required check
// appearing, a bypass actor widening, a capability switch flipping. Each is
// something a person decided or something nobody decided, and doctor must name
// it either way. An unreadable live state is drift, never agreement: not being
// able to look is not the same as having looked and found nothing.

const sortedEq = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

/** Compare a live reading against the checked fixture. Returns {drifted, lines}. */
export function diffBaseline(live, fixture) {
  if (!live || typeof live !== "object") return { drifted: true, lines: ["could not read the live state; drift is assumed, not excluded"] };
  const lines = [];
  for (const [key, label] of [["rulesetRequiredChecks", "required checks (ruleset)"],
                              ["branchProtectionRequiredChecks", "required checks (branch protection)"],
                              ["rulesetBypassActors", "bypass actors"]]) {
    if (!sortedEq(live[key], fixture[key]))
      lines.push(`${label} differ: live ${JSON.stringify(live[key] ?? null)} vs baseline ${JSON.stringify(fixture[key] ?? null)}`);
  }
  if (live.requiredApprovals !== fixture.requiredApprovals)
    lines.push(`required approvals: live ${live.requiredApprovals} vs baseline ${fixture.requiredApprovals}`);
  if (live.codeOwnerReview !== fixture.codeOwnerReview)
    lines.push(`code-owner review: live ${live.codeOwnerReview} vs baseline ${fixture.codeOwnerReview}`);
  for (const k of ["authorityPolicy", "mergeEnforcement"]) {
    if (live.profile?.[k] !== fixture.profile?.[k])
      lines.push(`profile.${k}: live ${live.profile?.[k]} vs baseline ${fixture.profile?.[k]}`);
  }
  const caps = new Set([...Object.keys(live.profile?.capabilities ?? {}), ...Object.keys(fixture.profile?.capabilities ?? {})]);
  for (const c of caps) {
    if (live.profile?.capabilities?.[c] !== fixture.profile?.capabilities?.[c])
      lines.push(`capability ${c}: live ${live.profile?.capabilities?.[c]} vs baseline ${fixture.profile?.capabilities?.[c]}`);
  }
  return { drifted: lines.length > 0, lines };
}
