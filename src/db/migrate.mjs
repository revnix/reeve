// Migrate the existing append-only JSONL ledger into the SQLite authority.
// Rule: the JSONL lines are REPLAYED as events (history preserved verbatim in
// event.payload) and the projection is rebuilt by applying them in file order.
// Nothing is dropped: unknown ops land in `event` with op='legacy.<op>'.
import { open, canonical } from "./ops.mjs";
import { readFileSync, rmSync } from "node:fs";

const [,, jsonlPath, dbPath, profile="nextly"] = process.argv;
for (const s of ["","-wal","-shm"]) { try{rmSync(dbPath+s)}catch{} }
const db = open(dbPath);
const raw = readFileSync(jsonlPath,"utf8").split("\n").filter(Boolean);

const STATUS = new Set(['open','ready','running','blocked','review','done','decided','refuted','cancelled','dead_letter']);
const KIND   = new Set(['goal','task','research','decision','finding','lesson','pr']);
const EDGE   = new Set(['DEPENDS_ON','BLOCKS','SUPERSEDES','REFUTES','IMPLEMENTS','CITES','DECIDED_BY']);
const ts = (s) => Math.floor(new Date(s||0).getTime()/1000) || 0;

// The schema, including fact, is created by open() from schema.sql.

const ins   = db.prepare(`INSERT INTO event(at,actor,op,subject,run_id,payload) VALUES(?,?,?,?,NULL,?)`);
const addN  = db.prepare(`INSERT INTO node(id,kind,title,body,status,territory,profile,created_at,updated_at)
                          VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
const setN  = db.prepare(`UPDATE node SET title=COALESCE(?,title), body=COALESCE(?,body),
                          territory=COALESCE(?,territory), updated_at=?, version=version+1 WHERE id=?`);
const stN   = db.prepare(`UPDATE node SET status=?, updated_at=?, version=version+1 WHERE id=?`);
const addE  = db.prepare(`INSERT INTO edge(src,dst,type,note,at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`);
const factN = db.prepare(`INSERT INTO fact(node_id,evidence,observed_at,source) VALUES(?,?,?,?)`);


const legacyOwner = new Map();
const report = { lines: raw.length, nodes:0, edges:0, facts:0, notes:0, claims:0,
                 statusChanges:0, coercedStatus:{}, unknownKind:{}, danglingEdge:[], skipped:0 };

db.exec("BEGIN IMMEDIATE");
for (const [i,line] of raw.entries()) {
  let ev; try { ev = JSON.parse(line); } catch { report.skipped++; continue; }
  const at = ts(ev.at), by = ev.by || "unknown";
  // 1. history verbatim, always
  ins.run(at, by, `legacy.${ev.op}`, ev.id ?? null, canonical(ev));
  // 2. projection
  switch (ev.op) {
    case "add": {
      const kind = KIND.has(ev.kind) ? ev.kind : (report.unknownKind[ev.kind]=(report.unknownKind[ev.kind]||0)+1, "finding");
      let status = ev.status || "open";
      if (!STATUS.has(status)) { report.coercedStatus[status]=(report.coercedStatus[status]||0)+1; status = "open"; }
      addN.run(ev.id, kind, ev.title ?? ev.id, ev.body ?? null, status, ev.territory ?? null, profile, at, at);
      report.nodes++; break;
    }
    case "set": setN.run(ev.title??null, ev.body??null, ev.territory??null, at, ev.id); break;
    case "status": {
      let s = ev.status;
      if (s === "claimed") s = "running";                    // legacy claim state -> run state
      if (s === "unverified") { s = "open"; report.coercedStatus.unverified=(report.coercedStatus.unverified||0)+1; }
      if (!STATUS.has(s)) { report.coercedStatus[ev.status]=(report.coercedStatus[ev.status]||0)+1; s="open"; }
      stN.run(s, at, ev.id); report.statusChanges++; break;
    }
    case "claim":   report.claims++; legacyOwner.set(ev.id, ev.lane); break;   // no lease existed; see below
    case "release": legacyOwner.delete(ev.id); break;
    case "edge": {
      if (!EDGE.has(ev.type)) { report.skipped++; break; }
      const have = db.prepare("SELECT 1 FROM node WHERE id=?");
      if (!have.get(ev.src) || !have.get(ev.dst)) { report.danglingEdge.push(`${ev.src}->${ev.dst}`); break; }
      addE.run(ev.src, ev.dst, ev.type, ev.note ?? null, at); report.edges++; break;
    }
    case "fact": { if (db.prepare("SELECT 1 FROM node WHERE id=?").get(ev.id)) { factN.run(ev.id, ev.evidence, at, by); report.facts++; } break; }
    case "note": report.notes++; break;
    default: report.skipped++;
  }
}
// legacy `claimed` nodes have no lease and no live process: return them to the queue,
// and record why, rather than inventing a lease that nobody holds.
const stranded = [...legacyOwner.entries()].filter(([id]) =>
  ['open','ready','running'].includes(db.prepare("SELECT status FROM node WHERE id=?").get(id)?.status));
for (const [id, lane] of stranded) {
  db.prepare(`UPDATE node SET status='ready', updated_at=unixepoch(), version=version+1 WHERE id=?`).run(id);
  ins.run(Math.floor(Date.now()/1000), "migration", "run.reap", id,
          canonical({ reason: "legacy claim carried no lease and no live process; requeued", lane }));
}
report.strandedClaimsRequeued = stranded.map(([id,lane])=>`${id}@${lane}`);
db.exec("COMMIT");

console.log(JSON.stringify(report,null,1));
console.log("db events:", db.prepare("SELECT count(*) c FROM event").get().c);
console.log("db nodes:", db.prepare("SELECT count(*) c FROM node").get().c,
            "edges:", db.prepare("SELECT count(*) c FROM edge").get().c,
            "facts:", db.prepare("SELECT count(*) c FROM fact").get().c);
console.log("statuses:", db.prepare("SELECT status,count(*) c FROM node GROUP BY status ORDER BY c DESC").all().map(r=>r.status+"="+r.c).join(" "));
console.log("kinds:", db.prepare("SELECT kind,count(*) c FROM node GROUP BY kind ORDER BY c DESC").all().map(r=>r.kind+"="+r.c).join(" "));
console.log("v_ready:", db.prepare("SELECT count(*) c FROM v_ready").get().c);
console.log("v_blocked:", db.prepare("SELECT count(*) c FROM v_blocked").get().c);
