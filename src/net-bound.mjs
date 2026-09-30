// @ts-check
// How long one call the daemon makes over the network may take (#282): a `gh`
// call, or a `git` call that reaches GitHub. Each is synchronous, so while it
// waits nothing else in the process runs, and one that never answers, on a
// connection lost while the host slept say, is a stopped daemon. Bounded, it's
// a read that failed, which each caller already takes as unreadable.

/** 60 seconds, or `REEVE_NET_TIMEOUT_MS` where that's a whole number of milliseconds. */
export function netTimeoutMs() {
  const n = Number(process.env.REEVE_NET_TIMEOUT_MS);
  return Number.isSafeInteger(n) && n > 0 ? n : 60_000;
}

/**
 * Why such a call failed, as its caller reports it: one stopped at its bound
 * says so, as its own output says nothing.
 * @param {unknown} e
 */
export function netFailure(e) {
  const err = /** @type {any} */ (e);
  if (err?.code === "ETIMEDOUT") return `it didn't answer within ${netTimeoutMs() / 1000} seconds, so it was stopped`;
  return String(err?.stderr || err?.message || err).trim();
}
