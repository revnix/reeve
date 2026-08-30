/**
 * Lint configuration. One local rule, and nothing else on by default.
 *
 * No recommended set: this repository has a suite that is the authority on
 * behaviour, and turning on a hundred stylistic rules at once would bury the one
 * rule that exists for a measured defect. Rules are added here when something has
 * actually gone wrong, the way this one was.
 */
import noUrlPathname from "./tools/eslint-rules/no-url-pathname.js";

export default [
  {
    // `bin/reeve` HAS NO EXTENSION and is the production CLI entry point. A previous
    // guard filtered by suffix and skipped it, which meant the single file where this
    // defect would matter most was the one file not being looked at. Flat config
    // matches globs rather than extensions, so it is named here directly.
    // `bin/*`, NOT the one command that exists today. Naming the current file
    // reintroduces the hole this rule replaced: the guard it supersedes walked every
    // tracked path under bin, so a second command added later would be configured by
    // nothing and skipped in silence by `eslint .`.
    // `bin/!(*.*)` MATCHES EXTENSIONLESS FILES; `bin/*` does not, and neither does
    // `bin/**`. Measured, because I got this wrong twice in one change: naming
    // `bin/reeve` worked but hard-coded the only command that exists today, and
    // widening it to `bin/*` silently removed the coverage entirely -- eslint reported
    // "File ignored because no matching configuration was supplied", which `eslint .`
    // prints as nothing at all. A file that is skipped and a file that is clean look
    // identical in that output, so test/lint-config-covers-bin.test.mjs now asserts a
    // config resolves for every tracked file under bin/.
    files: ["src/**/*.mjs", "scripts/**/*.mjs", "test/**/*.mjs", "tools/**/*.js",
            "bin/!(*.*)", "bin/*.mjs"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module" },
    plugins: { reeve: { rules: { "no-url-pathname": noUrlPathname } } },
    rules: { "reeve/no-url-pathname": "error" },
  },
];
