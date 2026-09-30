// @ts-check
// gh or git, as a seeded case's recording answers it (#293):
//   node seeded-stand-in.mjs <gh | git> <argument>...
//
// A call is answered by the recorded answer for exactly its arguments. One the
// recording doesn't hold is written to SEEDED_MISSES and fails. The case is
// then unrunnable rather than judged: a read that went unanswered would
// otherwise pass for GitHub failing, which a bad case may meet with UNKNOWN, and
// a bad case would be confirmed by a gap in its recording.
import { appendFileSync, readFileSync } from "node:fs";

const [tool, ...args] = process.argv.slice(2);
/** @type {{ call: string[], status: number, stdout: string, stderr?: string }[]} */
const answers = JSON.parse(readFileSync(String(process.env.SEEDED_ANSWERS), "utf8"));
const call = [tool, ...args];
const a = answers.find((x) => x.call.length === call.length && x.call.every((v, i) => v === call[i]));
if (!a) {
  appendFileSync(String(process.env.SEEDED_MISSES), JSON.stringify(call) + "\n");
  process.stderr.write(`${tool}: the seeded case's recording holds no answer to this call\n`);
  process.exit(1);
}
// Exit only once both are written: a pipe takes a large answer in pieces, and
// exiting first cuts it short.
process.stderr.write(a.stderr ?? "", () => process.stdout.write(a.stdout, () => process.exit(a.status)));
