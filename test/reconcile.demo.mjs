import { reconcilePush, reconcilePrCreate, reconcilePrComment, reconcilePrMerge, MARKER } from "../src/db/reconcile.mjs";
const NWO="nextlyhq/nextly", REPO="/Users/mobeen/Work/Products/nextly-integrations/nextly";
const mainSha = (await import("node:child_process")).execFileSync("git",["-C",REPO,"rev-parse","origin/main"],{encoding:"utf8"}).trim();
console.log("push (main @ correct sha):", reconcilePush({repo:REPO, branch:"main", sha:mainSha}));
console.log("push (main @ wrong sha):  ", reconcilePush({repo:REPO, branch:"main", sha:"0".repeat(40)}));
console.log("push (absent branch):     ", reconcilePush({repo:REPO, branch:"no/such/branch-zz", sha:mainSha}));
console.log("pr.create (real branch):  ", reconcilePrCreate({nwo:NWO, branch:"fix/builder/undo-while-typing", idemKey:"x"}));
console.log("pr.create (absent branch):", reconcilePrCreate({nwo:NWO, branch:"no/such/branch-zz", idemKey:"x"}));
console.log("pr.merge (merged 1120):   ", reconcilePrMerge({nwo:NWO, pr:1120, headSha:"90140917f98b0ae7841c2a4162f85af7b22846dc"}));
console.log("pr.merge (wrong sha):     ", reconcilePrMerge({nwo:NWO, pr:1120, headSha:"deadbeef"}));
console.log("pr.comment (absent marker):", reconcilePrComment({nwo:NWO, pr:1120, idemKey:"never-posted-zz"}));
// positive control: use a marker string that DOES exist in a coderabbit comment
console.log("pr.comment positive control:",
  reconcilePrComment({nwo:NWO, pr:1120, idemKey:"" }) , "(marker string:", JSON.stringify(MARKER("")), ")");
