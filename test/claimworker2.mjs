import { open, claim, heartbeat, tx, emit } from "../src/db/ops.mjs";
const [,, path, lane, startAt] = process.argv;
const db = open(path);
const sleep=(ms)=>{ if(ms>0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms); };
sleep(Number(startAt) - Date.now());           // barrier: all lanes contend at once
let n=0, busy=0, raced=0, err=0, i=0;
const t0=Date.now();
for(;;){
  let row=null;
  try { row = claim(db, { lane, runId: `${lane}-${i++}` }); }
  catch(e){ if(/lock|BUSY/i.test(e.message)) { busy++; continue; } err++; console.error(lane,e.errcode,e.message.slice(0,60)); break; }
  if (row === null) {
    // either nothing ready, or we lost the unique-index race; distinguish
    const ready = db.prepare("SELECT count(*) c FROM v_ready").get().c;
    if (ready === 0) break;
    raced++; continue;
  }
  heartbeat(db, { runId: row.run_id });
  sleep(1);
  tx(db, () => {
    db.prepare("UPDATE run SET status='succeeded', ended_at=unixepoch() WHERE id=?").run(row.run_id);
    db.prepare("UPDATE node SET status='done', updated_at=unixepoch(), version=version+1 WHERE id=?").run(row.task_id);
    emit(db, { actor: lane, op:"run.succeed", subject: row.task_id, run_id: row.run_id });
  });
  n++;
  if (Date.now()-t0 > 25000) break;
}
console.log(JSON.stringify({lane,claimed:n,busy,racedLost:raced,err}));
