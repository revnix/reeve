// Prove: a crash BETWEEN the external side effect and recording it locally
// is recovered without performing the side effect twice.
import { open, tx, enqueue, leaseOutbox, settleOutbox, recoverOutbox } from "../src/db/ops.mjs";
import { rmSync, existsSync, readFileSync, appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// A temp directory, NOT the repository root. This wrote `crash.db` and
// `external.log` beside the source: they are not gitignored, so a `git add -A`
// commits them, and until then every `git status` in this checkout reads dirty --
// which is the exact state reeve's own publication gate refuses. A test that
// leaves litter where the work happens is the shape it exists to catch.
const SCRATCH = mkdtempSync(join(tmpdir(), "reeve-crashdrain-"));
const P = join(SCRATCH, "crash.db"), EXT = join(SCRATCH, "external.log");
for (const s of ["","-wal","-shm"]) { try{rmSync(P+s)}catch{} }
try{rmSync(EXT)}catch{}
const db=open(P);
const IDEM="pr:create:fix/x:abc123";

// "external system": appending a line is the irreversible side effect.
const perform = (idem)=>{ appendFileSync(EXT, idem+"\n"); return {receipt:"pr-777"}; };
// reconciler: does the external system already have our marker?
const reconcile = (idem)=> existsSync(EXT) && readFileSync(EXT,"utf8").split("\n").includes(idem)
  ? {done:true, receipt:"pr-777"} : {done:false};

// phase 1: enqueue, lease, perform, then CRASH before settle
tx(db,()=>enqueue(db,{idemKey:IDEM,kind:"gh.pr.create",args:{branch:"fix/x"}}));
const job = leaseOutbox(db,{worker:"d1",leaseSeconds:-5});  // already-expired lease simulates the crash
perform(job.idem_key);                                       // side effect HAPPENED
// <-- process dies here; nothing recorded locally
console.log("after crash: outbox status =", db.prepare("SELECT status,attempts FROM outbox WHERE id=?").get(job.id));
console.log("external side effects performed:", readFileSync(EXT,"utf8").trim().split("\n").length);

// phase 2: a new drainer starts
console.log("recovered rows:", recoverOutbox(db).length);
const job2 = leaseOutbox(db,{worker:"d2",leaseSeconds:300});
// THE RULE: reconcile before performing, always.
const r = reconcile(job2.idem_key);
if (r.done) settleOutbox(db,{id:job2.id, leaseToken:job2.lease_token, ok:true, result:{...r, reconciled:true}});
else { const res = perform(job2.idem_key); settleOutbox(db,{id:job2.id, leaseToken:job2.lease_token, ok:true, result:res}); }
console.log("external side effects after recovery:", readFileSync(EXT,"utf8").trim().split("\n").length, "(must still be 1)");
const fin = db.prepare("SELECT status,attempts,result FROM outbox WHERE id=?").get(job.id);
console.log("final outbox row:", fin);
console.log(fin.status==="done" && readFileSync(EXT,"utf8").trim().split("\n").length===1
  ? "PASS  exactly-once external effect across a crash"
  : "FAIL");

db.close?.();
rmSync(SCRATCH, { recursive: true, force: true });
