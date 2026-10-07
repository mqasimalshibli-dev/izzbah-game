// tools/repair-media.mjs, executed end to end against a stubbed Firestore.
//
// The tool overwrites LIVE pictures, so what is pinned is the decision table:
// a displaced picture is put back, a blank is filled, a picture someone has
// replaced since the backup is left alone, a question newer than the backup is
// never touched, a backup with no picture never blanks a live one, and the
// overwritten values are saved first and restorable. State persists in a JSON
// file so a second run proves the tool is idempotent.
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  " + extra : ""}`); };

const dir = mkdtempSync(join(tmpdir(), "izzbah-repair-"));
mkdirSync(join(dir, "tools"), { recursive: true });
mkdirSync(join(dir, "node_modules/@google-cloud/firestore"), { recursive: true });
cpSync(join(ROOT, "tools/repair-media.mjs"), join(dir, "tools/repair-media.mjs"));
const STATE = join(dir, "state.json");

const row = (id, q, a, image, answerImage = "") => ({ id, q, a, image, answerImage });
writeFileSync(STATE, JSON.stringify({
  backup: { places: [
    row("q0", "ما هذا؟", "وادي", "I0"),
    row("q1", "ما هذا؟", "قلعة", "I1", "A1"),
    row("q2", "ما هذا؟", "مسجد", "I2"),
    row("q3", "ما هذا؟", "شاطئ", "I3"),
    row("q4", "ما هذا؟", "جبل", "I4"),
    row("q5", "ما هذا؟", "سوق", "I5"),
    row("q7", "ما هذا؟", "ميناء", ""),
  ]},
  live: { places: [
    row("q0", "ما هذا؟", "وادي", "I0"),            // already right
    row("q1", "ما هذا؟", "قلعة", "I2", "A1"),      // image displaced (belongs to مسجد)
    row("q2", "ما هذا؟", "مسجد", "I3"),            // displaced
    row("q3", "ما هذا؟", "شاطئ", "I4"),            // displaced
    row("q4", "ما هذا؟", "جبل", ""),               // blank -> fill
    row("q5", "ما هذا؟", "سوق", "NEWPIC"),         // replaced since backup -> leave
    row("q6", "ما هذا؟", "جديد", "X"),             // newer than the backup -> leave
    row("q7", "ما هذا؟", "ميناء", "LIVEKEEP"),     // backup has no picture -> never blank
  ]},
}));
writeFileSync(join(dir, "node_modules/@google-cloud/firestore/package.json"),
  JSON.stringify({ name: "@google-cloud/firestore", version: "0.0.0-stub", type: "module", main: "index.js",
                   exports: { ".": "./index.js", "./package.json": "./package.json" } }));
writeFileSync(join(dir, "node_modules/@google-cloud/firestore/index.js"), `
import { readFileSync, writeFileSync } from "fs";
const STATE = ${JSON.stringify(STATE)};
const load = () => JSON.parse(readFileSync(STATE, "utf8"));
const dbName = id => id === "(default)" ? "live" : "backup";
class Snap { constructor(id, d) { this.id = id; this._d = d; this.exists = !!d; } data() { return this._d; } }
class Ref { constructor(db, cat, id) { this._db = db; this._cat = cat; this.id = id; }
  update(p) { const s = load(); const r = s[this._db][this._cat].find(x => x.id === this.id); Object.assign(r, p); writeFileSync(STATE, JSON.stringify(s)); return Promise.resolve(); } }
class QCol { constructor(db, cat) { this._db = db; this._cat = cat; }
  doc(id) { return new Ref(this._db, this._cat, id); }
  listDocuments() { return Promise.resolve((load()[this._db][this._cat] || []).map(r => new Ref(this._db, this._cat, r.id))); } }
class CatDoc { constructor(db, cat) { this._db = db; this._cat = cat; } collection() { return new QCol(this._db, this._cat); } }
class Cats { constructor(db) { this._db = db; } doc(id) { return new CatDoc(this._db, id); } }
export class Firestore { constructor(o) { this._db = dbName(o.databaseId); }
  collection() { return new Cats(this._db); }
  getAll(...refs) { return Promise.resolve(refs.map(r => {
    const row = (load()[r._db][r._cat] || []).find(x => x.id === r.id);
    return new Snap(r.id, row ? { q: row.q, a: row.a, image: row.image, answerImage: row.answerImage } : null);
  })); } }
`);

const run = (...a) => spawnSync(process.execPath, [join(dir, "tools/repair-media.mjs"), ...a], { cwd: dir, encoding: "utf8" });
const live = () => Object.fromEntries(JSON.parse(readFileSync(STATE, "utf8")).live.places.map(r => [r.id, r]));
const before = JSON.stringify(live());

const bad = run("--source", "restore-old");
check("refuses without --only (one category per run)", bad.status === 2);
const same = run("--source", "(default)", "--only", "places");
check("refuses when source and target are the same database", same.status === 2);

const dry = run("--source", "restore-old", "--only", "places");
check("dry run exits cleanly", dry.status === 0, dry.status ? dry.stderr.slice(0, 300) + dry.stdout.slice(-300) : "");
check("dry run writes nothing", JSON.stringify(live()) === before);
check("dry run plans 4 repairs", /to repair\s+: 4 questions/.test(dry.stdout), (dry.stdout.match(/to repair.*/) || [""])[0]);
check("…and names the replaced-since-backup picture", /q5\s+image/.test(dry.stdout));

const app = run("--source", "restore-old", "--only", "places", "--apply");
check("apply exits cleanly", app.status === 0, app.status ? app.stderr.slice(0, 300) : "");
const L = live();
check("a displaced picture goes back to its own question", L.q1.image === "I1" && L.q2.image === "I2" && L.q3.image === "I3");
check("a blank is filled from the backup", L.q4.image === "I4");
check("an already-correct picture is untouched", L.q0.image === "I0" && L.q1.answerImage === "A1");
check("a picture replaced since the backup is NOT overwritten", L.q5.image === "NEWPIC");
check("a question newer than the backup is NOT touched", L.q6.image === "X");
check("a backup with no picture NEVER blanks a live one", L.q7.image === "LIVEKEEP");
check("question text is never changed", Object.values(L).every(r => r.q === "ما هذا؟"));

const files = readdirSync(join(dir, "tools")).filter(f => /^repair-media-backup-places-.*\.json$/.test(f));
check("the overwritten values were saved first", files.length === 1);
const saved = JSON.parse(readFileSync(join(dir, "tools", files[0]), "utf8"));
check("…with the old live values", saved.docs.q1.image === "I2" && saved.docs.q4.image === "");

const again = run("--source", "restore-old", "--only", "places");
check("a second run has nothing to do (idempotent)", /Nothing to do/.test(again.stdout));

const undoDry = run("--undo", join("tools", files[0]));
check("--undo without --apply writes nothing", live().q1.image === "I1" && undoDry.status === 0);
const undo = run("--undo", join("tools", files[0]), "--apply");
check("--undo puts the old values back", undo.status === 0 && live().q1.image === "I2" && live().q4.image === "");

process.exit(checks.every(Boolean) ? 0 : 1);
