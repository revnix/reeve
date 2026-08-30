/**
 * Do not read `.pathname`. Decode a file URL with `fileURLToPath`, or pass the URL
 * object to `fs`, which accepts one.
 *
 * `new URL(x, import.meta.url).pathname` returns the URL's path COMPONENT, still
 * percent-encoded. Measured on a directory named `dir with space/sub#hash`:
 *
 *   .pathname                  /…/dir%20with%20space/sub%23hash/x.mjs   exists: false
 *   fileURLToPath(new URL(…))  /…/dir with space/sub#hash/x.mjs         exists: true
 *
 * The failure IMPERSONATES A DIFFERENT ONE, which is why it earns a rule. The encoded
 * path does not exist, so `existsSync` answers false and a guarded block silently
 * skips, or a spawn fails ENOENT and reads as a missing binary. Nothing anywhere
 * reports that a decode was skipped.
 *
 * WHY THIS IS FIFTEEN LINES AND NOT NINETY. The first version asked which URLs were
 * FILE urls, so it could leave http reads alone. That question has no reliable answer:
 * `new URL(a, b)` with runtime values cannot be classified, and review found six
 * distinct ways the approximation was wrong -- an absolute first argument overriding
 * the base's scheme, a namespace import, a local binding shadowing the global, and
 * more. They were not careless; they were the problem being undecidable.
 *
 * So the rule stops asking. It bans the read. All six become impossible rather than
 * fixed, because the question that produced them is no longer asked.
 *
 * MEASURED BEFORE CHOOSING THIS: 185 files, zero `.pathname` reads in the codebase.
 * The narrow version was protecting a case that occurs zero times, at the cost of a
 * rule that could not be finished.
 *
 * WHAT IT COSTS. Reading `.pathname` off an http URL is correct, and this forbids it.
 * That is deliberate: this repository does not permit disable comments, so the cost
 * is a conversation rather than a silent workaround, and a first legitimate use is
 * worth deciding out loud. No allow-list, because an allow-list is a second inventory
 * of the source and one of those went stale on the default branch this week.
 */
export default {
  meta: {
    type: "problem",
    docs: { description: "do not read .pathname; decode a file URL with fileURLToPath" },
    schema: [],
    messages: {
      pathname:
        "Do not read `.pathname`: on a file URL it leaves the path percent-encoded, so it " +
        "may not exist on disk. Pass the URL object to fs, which accepts one, or decode it " +
        "with fileURLToPath(). If you need an http URL's path, raise it rather than working around this.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        // Non-computed only: `o[k]` where k is a variable is not this property, and
        // treating it as one would report a read nobody wrote.
        if (node.computed || node.property?.name !== "pathname") return;
        context.report({ node: node.property, messageId: "pathname" });
      },
    };
  },
};
