import { open, tx, emit } from "../src/db/ops.mjs";
import { rmSync } from "node:fs";
const p = process.argv[2], n = Number(process.argv[3] || 200);
for (const s of ["","-wal","-shm"]) { try{rmSync(p+s)}catch{} }
const db = open(p);
tx(db, () => {
  const ins = db.prepare(`INSERT INTO node(id,kind,title,status,territory,priority,created_at,updated_at)
                          VALUES(?,'task',?,'ready',?,?,unixepoch(),unixepoch())`);
  for (let i=0;i<n;i++) ins.run(`task:t${i}`, `task ${i}`, i%2 ? "packages/nextly/**" : "apps/admin/**", i%5);
  emit(db, { actor:"founder", op:"seed", payload:{ n } });
});
console.log("ready:", db.prepare("SELECT count(*) c FROM v_ready").get().c);
