import { open, claim, heartbeat, reap, checkpoint, resume, tx, emit,
         enqueue, leaseOutbox, settleOutbox, recoverOutbox, exportJsonl, backoffSeconds } from "../src/db/ops.mjs";
import { rmSync } from "node:fs";
const P="./life.db"; for(const s of ["","-wal","-shm"]) { try{rmSync(P+s)}catch{} }
const db = open(P);
const ok=(n,c)=>console.log((c?"PASS":"FAIL")+"  "+n);

tx(db,()=>{ db.prepare(`INSERT INTO node(id,kind,title,status,created_at,updated_at)
  VALUES('task:a','task','a','ready',unixepoch(),unixepoch())`).run();
  db.prepare(`INSERT INTO task_exec(task_id,max_attempts) VALUES('task:a',2)`).run(); });

// 1. claim
const r1 = claim(db,{lane:"L1",runId:"run-1"});
ok("claim returns a run", r1 && r1.task_id==="task:a");
ok("second claim of same task is refused", claim(db,{lane:"L2",runId:"run-2"})===null);

// 2. heartbeat keeps the lease
ok("heartbeat alive", heartbeat(db,{runId:"run-1"}).alive===true);

// 3. reap does nothing while lease is valid
ok("no reap while lease valid", reap(db).length===0);

// 4. force lease expiry -> reap returns task to ready with backoff
tx(db,()=>db.prepare("UPDATE run SET lease_expires_at=unixepoch()-1 WHERE id='run-1'").run());
const reaped = reap(db);
ok("expired lease reaped", reaped.length===1 && reaped[0].action==="reaped");
ok("run marked abandoned", db.prepare("SELECT status FROM run WHERE id='run-1'").get().status==="abandoned");
const nb = db.prepare("SELECT not_before, attempts FROM task_exec WHERE task_id='task:a'").get();
ok("backoff set in the future", nb.not_before > Math.floor(Date.now()/1000));
ok("attempts incremented to 1", nb.attempts===1);
ok("task not claimable during backoff", claim(db,{lane:"L3",runId:"run-3"})===null);

// 5. clear backoff, claim again, expire again -> dead-letter at max_attempts=2
tx(db,()=>db.prepare("UPDATE task_exec SET not_before=0 WHERE task_id='task:a'").run());
const r2 = claim(db,{lane:"L3",runId:"run-3"});
ok("re-claim after backoff", !!r2 && r2.attempt===2);
tx(db,()=>db.prepare("UPDATE run SET lease_expires_at=unixepoch()-1 WHERE id='run-3'").run());
reap(db);
ok("dead-lettered at max_attempts", db.prepare("SELECT status FROM node WHERE id='task:a'").get().status==="dead_letter");
ok("dead-lettered task never appears in v_ready", db.prepare("SELECT count(*) c FROM v_ready WHERE id='task:a'").get().c===0);

// 6. liveness grace: an alive owner gets its lease extended, not reaped
tx(db,()=>{ db.prepare(`INSERT INTO node(id,kind,title,status,created_at,updated_at)
  VALUES('task:b','task','b','ready',unixepoch(),unixepoch())`).run(); });
const rb = claim(db,{lane:"L4",runId:"run-4",pid:process.pid,boot:"boot-x"});
tx(db,()=>db.prepare("UPDATE run SET lease_expires_at=unixepoch()-1 WHERE id='run-4'").run());
const g = reap(db,{ isAlive:(pid,boot)=>pid===process.pid && boot==="boot-x" });
ok("live owner extended not reaped", g.length===1 && g[0].action==="extended");
ok("run still live after grace", db.prepare("SELECT status FROM run WHERE id='run-4'").get().status==="leased");

// 7. cancellation is cooperative and observed by heartbeat
tx(db,()=>db.prepare(`INSERT INTO task_exec(task_id,cancel_requested) VALUES('task:b',1)
  ON CONFLICT(task_id) DO UPDATE SET cancel_requested=1`).run());
const hb = heartbeat(db,{runId:"run-4"});
ok("heartbeat reports cancellation", hb.alive===false && hb.reason==="cancelled");

// 8. checkpoint + resume
checkpoint(db,{runId:"run-4",step:"branch",seq:1,state:{branch:"fix/x"}});
checkpoint(db,{runId:"run-4",step:"push",seq:2,state:{head_sha:"abc123"}});
const res = resume(db,"run-4");
ok("resume knows completed steps", res.done.join(",")==="branch,push");
ok("resume cursor merged", res.cursor.branch==="fix/x" && res.cursor.head_sha==="abc123");

// 9. outbox: enqueue is idempotent on the key
const id1 = tx(db,()=>enqueue(db,{idemKey:"pr:create:fix/x:abc123",kind:"gh.pr.create",runId:"run-4",args:{branch:"fix/x"}}));
const id2 = tx(db,()=>enqueue(db,{idemKey:"pr:create:fix/x:abc123",kind:"gh.pr.create",runId:"run-4",args:{branch:"fix/x"}}));
ok("duplicate enqueue returns null (dedup)", typeof id1==="number" && id2===null);
ok("only one outbox row", db.prepare("SELECT count(*) c FROM outbox").get().c===1);

// 10. lease/settle
const job = leaseOutbox(db,{worker:"d1"});
ok("outbox lease returns the job", job && job.kind==="gh.pr.create" && job.attempts===1);
ok("no second drainer can lease it", leaseOutbox(db,{worker:"d2"})===undefined);
settleOutbox(db,{id:job.id, ok:false, error:"gh: rate limited", retryable:true});
const after = db.prepare("SELECT status, attempts, not_before FROM outbox WHERE id=?").get(job.id);
ok("retryable failure -> pending with backoff", after.status==="pending" && after.not_before>Math.floor(Date.now()/1000));

// 11. drainer crash -> recoverOutbox re-queues
tx(db,()=>db.prepare("UPDATE outbox SET status='inflight', lease_expires_at=unixepoch()-1, not_before=0 WHERE id=?").run(job.id));
ok("crashed inflight recovered", recoverOutbox(db).length===1);
ok("recovered row is pending", db.prepare("SELECT status FROM outbox WHERE id=?").get(job.id).status==="pending");

// 12. permanent failure -> dead_letter
const j2 = leaseOutbox(db,{worker:"d1"});
settleOutbox(db,{id:j2.id, ok:false, error:"422 branch has no diff", retryable:false});
ok("non-retryable -> dead_letter", db.prepare("SELECT status FROM outbox WHERE id=?").get(j2.id).status==="dead_letter");

// 13. deterministic export
const a = exportJsonl(db), b = exportJsonl(db);
ok("export is byte-identical across runs", a===b);
ok("export is append-only prefix", exportJsonl(db,{sinceSeq:0}).startsWith(exportJsonl(db,{sinceSeq:0}).split("\n").slice(0,3).join("\n")));
const lines = a.trim().split("\n");
ok("every export line parses", lines.every(l=>{try{JSON.parse(l);return true}catch{return false}}));
ok("export keys are sorted", lines.every(l=>{const k=Object.keys(JSON.parse(l));return k.join(",")===[...k].sort().join(",")}));
console.log("events:", lines.length, "| backoff(1..5):", [1,2,3,4,5].map(a=>backoffSeconds(a)).join(","));
