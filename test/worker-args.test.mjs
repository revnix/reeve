// The argv is the deterministic half of the worker boundary, and `settings` was
// an optional parameter that defaulted to null: a resume that forgot it
// relaunched a worker with no denylist at all, the exact optional-safety-
// parameter class that bit four times in one day. It is now required, and the
// isolation flags are always present rather than inherited.
import { workerArgs } from "../src/supervisor.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const has = (a, flag) => a.includes(flag);
const valueOf = (a, flag) => a[a.indexOf(flag) + 1];

{
  let threw = null;
  try { workerArgs({ prompt: "hi" }); } catch (e) { threw = e; }
  check(threw && /settings is required/.test(threw.message),
    "no settings is a hard failure, never a default", String(threw?.message));
  threw = null;
  try { workerArgs({ prompt: "hi", settings: "" }); } catch (e) { threw = e; }
  check(!!threw, "an empty settings path is refused too");
}
{
  const a = workerArgs({ prompt: "hi", settings: "/tmp/s.json" });
  check(has(a, "--safe-mode") && has(a, "--strict-mcp-config") && has(a, "--no-chrome"),
    "the isolation flags are always present", a.join(" "));
  check(valueOf(a, "--settings") === "/tmp/s.json", "and the settings path is passed", a.join(" "));
  check(has(a, "-p") && has(a, "--verbose") && valueOf(a, "--output-format") === "stream-json",
    "control: the proven print-mode flags survive", a.join(" "));
}
{
  const a = workerArgs({ prompt: "hi", settings: "/tmp/s.json", effort: "high", maxBudgetUsd: 2.5,
                         jsonSchema: '{"type":"object"}', agents: '{"x":{}}', disallowedTools: "WebSearch",
                         mcpConfig: "/tmp/mcp.json" });
  check(valueOf(a, "--effort") === "high", "effort is passed", a.join(" "));
  check(valueOf(a, "--max-budget-usd") === "2.5", "max budget is passed as a string", a.join(" "));
  check(valueOf(a, "--json-schema") === '{"type":"object"}', "json schema is passed", a.join(" "));
  check(valueOf(a, "--agents") === '{"x":{}}', "agents are passed", a.join(" "));
  check(valueOf(a, "--disallowedTools") === "WebSearch", "disallowed tools are passed", a.join(" "));
  check(valueOf(a, "--mcp-config") === "/tmp/mcp.json", "an explicit mcp config is passed", a.join(" "));
}
{
  const a = workerArgs({ prompt: "hi", settings: "/tmp/s.json" });
  check(!has(a, "--effort") && !has(a, "--max-budget-usd") && !has(a, "--json-schema") && !has(a, "--agents"),
    "absent optional flags are absent, not passed as 'undefined'", a.join(" "));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
