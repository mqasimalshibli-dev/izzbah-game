// tools/restore-media.mjs, executed end to end against a stubbed Firestore.
//
// This exists because that script shipped broken twice while a live recovery
// was waiting on it: once writing image:"" logic that was never exercised, and
// once with `kb is not defined` after a bad block replacement removed three
// helpers that were still in use. Both would have been caught by running it.
//
// The stub mirrors only the calls the script makes (listDocuments, getAll,
// update) and records every write, so what is pinned is the DECISION TABLE:
// which questions get written, and which fields.
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const dir = mkdtempSync(join(tmpdir(), "izzbah-restore-"));
mkdirSync(join(dir, "tools"), { recursive: true });
mkdirSync(join(dir, "node_modules/@google-cloud/firestore"), { recursive: true });
cpSync(join(ROOT, "tools/restore-media.mjs"), join(dir, "tools/restore-media.mjs"));
writeFileSync(join(dir, "node_modules/@google-cloud/firestore/package.json"),
  JSON.stringify({ name: "@google-cloud/firestore", version: "0.0.0-stub", type: "module",
                   main: "index.js", exports: { ".": "./index.js", "./package.json": "./package.json" } }));
writeFileSync(join(dir, "node_modules/@google-cloud/firestore/index.js"), `
const IMG = "data:image/webp;base64," + "A".repeat(2000);
const DB = {
  "backup": { culture: [
    { id:"q0", q:"س٠", a:"ج٠", image:IMG, answerImage:"" },
    { id:"q1", q:"س١", a:"ج١", image:IMG, answerImage:IMG },
    { id:"q2", q:"س٢", a:"ج٢", image:"",  answerImage:"" },
    { id:"q3", q:"س٣", a:"ج٣", image:IMG, answerImage:"" },
    { id:"q4", q:"س٤", a:"ج٤", image:IMG, answerImage:"" },
    { id:"q5", q:" س٥ ", a:"ج٥", image:IMG, answerImage:"" },
  ]},
  "(default)": { culture: [
    { id:"q0", q:"س٠", a:"ج٠", image:"",     answerImage:"" },
    { id:"q1", q:"س١", a:"ج١", image:"KEEP", answerImage:"" },
    { id:"q2", q:"س٢", a:"ج٢", image:"",     answerImage:"" },
    { id:"q3", q:"CHANGED", a:"ج٣", image:"", answerImage:"" },
    { id:"q5", q:"س٥",  a:"ج٥", image:"",    answerImage:"" },
  ]},
};
export const WRITES = [];
class Snap { constructor(id,d){this.id=id;this._d=d;this.exists=!!d;} data(){return this._d;} }
class Ref { constructor(db,cat,id){this._db=db;this._cat=cat;this.id=id;}
  update(p){ WRITES.push({cat:this._cat,id:this.id,patch:p}); return Promise.resolve(); } }
class QCol { constructor(db,cat){this._db=db;this._cat=cat;}
  doc(id){return new Ref(this._db,this._cat,id);}
  listDocuments(){return Promise.resolve((DB[this._db][this._cat]||[]).map(r=>new Ref(this._db,this._cat,r.id)));} }
class CatDoc { constructor(db,cat){this._db=db;this._cat=cat;} collection(){return new QCol(this._db,this._cat);} }
class Cats { constructor(db){this._db=db;} doc(id){return new CatDoc(this._db,id);}
  listDocuments(){return Promise.resolve(Object.keys(DB[this._db]).map(id=>({id})));} }
export class Firestore { constructor(o){this._db=o.databaseId;}
  collection(){return new Cats(this._db);}
  getAll(...refs){ return Promise.resolve(refs.map(r=>{
    const row=(DB[r._db][r._cat]||[]).find(x=>x.id===r.id);
    return new Snap(r.id,row?{points:100,q:row.q,a:row.a,image:row.image,answerImage:row.answerImage}:null);}));} }
process.on("exit",()=>{ console.log("WRITEJSON:"+JSON.stringify(
  WRITES.map(w=>({id:w.id,fields:Object.keys(w.patch).sort()})))); });
`);

const run = (...args) => spawnSync(process.execPath,
  [join(dir, "tools/restore-media.mjs"), "--source", "backup", "--only", "culture", ...args],
  { cwd: dir, encoding: "utf8" });

const dry = run();
check("dry run exits cleanly", dry.status === 0);
if (dry.status !== 0) console.log(dry.stderr.slice(0, 400));
check("dry run writes nothing", !/WRITEJSON:\[\{/.test(dry.stdout));
check("counts 3 to restore (q0, q1, q5)", /images to restore : 3/.test(dry.stdout));
check("reports the edited question as a mismatch", /text mismatch     : 1/.test(dry.stdout));
check("reports the deleted question as gone", /question gone     : 1/.test(dry.stdout));

const app = run("--apply");
check("apply exits cleanly", app.status === 0);
const m = app.stdout.match(/WRITEJSON:(\[.*\])/);
const writes = m ? JSON.parse(m[1]) : [];
const by = Object.fromEntries(writes.map(w => [w.id, w.fields.join("+")]));
check("q0 — blank image is filled", by.q0 === "image");
check("q1 — live image kept, only answerImage written", by.q1 === "answerImage");
check("q2 — nothing to restore, not written", !("q2" in by));
check("q3 — edited text, NOT written", !("q3" in by));
check("q4 — deleted question, not written", !("q4" in by));
check("q5 — whitespace-only text diff still matches", by.q5 === "image");
check("exactly 3 writes", writes.length === 3);

process.exit(checks.every(Boolean) ? 0 : 1);
