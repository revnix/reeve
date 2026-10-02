// Renders each Markdown text a fixture file holds as GitHub renders a body
// (#167): `node scripts/render-markdown.mjs <file>.json` asks GitHub's
// Markdown API for every key of the file and writes the HTML as its value, so
// a test reads what GitHub would show without reaching GitHub itself. Run by
// hand, with gh signed in; the tests only read the file.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [file] = process.argv.slice(2);
if (!file?.endsWith(".json")) {
  console.error("usage: node scripts/render-markdown.mjs <file>.json");
  process.exit(2);
}
const texts = Object.keys(JSON.parse(readFileSync(file, "utf8")));
/** @type {Record<string, string>} */ const rendered = {};
// In a repository's context, as a body on GitHub is rendered.
for (const text of texts) rendered[text] = execFileSync("gh", ["api", "markdown", "-f", `text=${text}`, "-f", "mode=gfm", "-f", "context=revnix/reeve"], { encoding: "utf8" });
writeFileSync(file, `${JSON.stringify(rendered, null, 1)}\n`);
console.log(`${texts.length} rendered into ${file}`);
