// tools/fix-games-shift.mjs, executed end to end against a stubbed Firestore.
//
// The script moves ~105 pictures between live documents, so what is pinned is
// the decision table, not Firestore: nothing is written on a dry run; a doc
// that is not in the audited state stops EVERYTHING (all-or-nothing); an apply
// moves row N+1's pictures onto row N and clears the last row; it writes a
// backup first; a second run refuses; and --undo puts the originals back.
//
// The committed EXPECTED table is audited against live data by hand and cannot
// be checked offline, so the temp copy of the script gets a table rebuilt from
// the stub's own data — that tests the LOGIC. A separate static check pins the
// shape of the real table (106 rows, q42–q147, well-formed fingerprints).
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  " + extra : ""}`); };
const fp = s => s ? crypto.createHash("sha1").update(s).digest("hex").slice(0, 10) : "";

const real = readFileSync(join(ROOT, "tools/fix-games-shift.mjs"), "utf8");

// ---- static: the real table is well formed ----
{
  const m = real.match(/const EXPECTED = \{([\s\S]*?)\n\};/);
  const rows = [...m[1].matchAll(/^\s*(\d+): \[("(?:[^"\\]|\\.)*"), "([0-9a-f]{10}|)", "([0-9a-f]{10}|)"\],?$/gm)];
  const keys = rows.map(r => +r[1]);
  check("the audited table covers q42–q147, once each",
    rows.length === 106 && keys[0] === 42 && keys[105] === 147 && new Set(keys).size === 106, String(rows.length));
  check("every row carries an answer", rows.every(r => JSON.parse(r[2]).length > 0));
  check("the script is scoped to one hardcoded category, not a flag",
    /const CATEGORY = "pub-1783510423551-6465"/.test(real) && !/--cat\b/.test(real));
  check("it writes documents with update(), never set()", /\.doc\([^)]*\)\.update\(/.test(real) && !/\.doc\([^)]*\)\.set\(/.test(real));
}

// ---- dynamic: a stubbed Firestore that persists across runs ----
const dir = mkdtempSync(join(tmpdir(), "izzbah-games-"));
mkdirSync(join(dir, "tools"), { recursive: true });
mkdirSync(join(dir, "node_modules/@google-cloud/firestore"), { recursive: true });
const STATE = join(dir, "state.json");
const docs = {};
for (let i = 40; i <= 148; i++) docs["q" + i] = { q: "س" + i, a: "ج" + i, points: 100, idx: i, image: `IMG${i}`, answerImage: i % 3 === 0 ? "" : `ANS${i}` };
writeFileSync(STATE, JSON.stringify(docs));

// rebuild EXPECTED from the stub's own data
const table = [];
for (let i = 42; i <= 147; i++) table.push(`  ${i}: [${JSON.stringify("ج" + i)}, "${fp(docs["q" + i].image)}", "${fp(docs["q" + i].answerImage)}"],`);
writeFileSync(join(dir, "tools/fix-games-shift.mjs"),
  real.replace(/const EXPECTED = \{[\s\S]*?\n\};/, `const EXPECTED = {\n${table.join("\n")}\n};`));

writeFileSync(join(dir, "node_modules/@google-cloud/firestore/package.json"),
  JSON.stringify({ name: "@google-cloud/firestore", version: "0.0.0-stub", type: "module", main: "index.js",
                   exports: { ".": "./index.js", "./package.json": "./package.json" } }));
writeFileSync(join(dir, "node_modules/@google-cloud/firestore/index.js"), `
import { readFileSync, writeFileSync } from "fs";
const STATE = ${JSON.stringify(STATE)};
const load = () => JSON.parse(readFileSync(STATE, "utf8"));
class Snap { constructor(id, d) { this.id = id; this._d = d; this.exists = !!d; } data() { return this._d; } }
class Ref { constructor(id) { this.id = id; }
  get() { return Promise.resolve(new Snap(this.id, load()[this.id] || null)); }
  update(p) { const s = load(); Object.assign(s[this.id], p); writeFileSync(STATE, JSON.stringify(s)); return Promise.resolve(); } }
class Col { doc(id) { return new Ref(id); } }
class Cat { collection() { return new Col(); } }
class Cats { doc() { return new Cat(); } }
export class Firestore { constructor() {} collection() { return new Cats(); } }
`);

const run = (...args) => spawnSync(process.execPath, [join(dir, "tools/fix-games-shift.mjs"), ...args], { cwd: dir, encoding: "utf8" });
const read = () => JSON.parse(readFileSync(STATE, "utf8"));
const before = JSON.parse(JSON.stringify(read()));

const dry = run();
check("dry run exits cleanly", dry.status === 0, dry.status !== 0 ? dry.stdout.slice(-300) + dry.stderr.slice(0, 300) : "");
check("dry run writes nothing", JSON.stringify(read()) === JSON.stringify(before));
check("the plan says q42 takes q43's picture", /q42\s+ج42\s+<- q43/.test(dry.stdout));
check("…and q147 is cleared", /q147[^\n]*cleared/.test(dry.stdout));

// a doc that is not in the audited state stops EVERYTHING
{
  const s = read(); s.q90.image = "SOMEONE-ELSE-FIXED-THIS"; writeFileSync(STATE, JSON.stringify(s));
  const r = run("--apply");
  check("one drifted row → refuses, exit 1", r.status === 1 && /REFUSING/.test(r.stdout));
  check("…and writes NOTHING, not even the rows that were fine", read().q42.image === "IMG42" && read().q146.image === "IMG146");
  check("…and names the row", /q90/.test(r.stdout));
  s.q90.image = "IMG90"; writeFileSync(STATE, JSON.stringify(s));
}

const app = run("--apply");
check("apply exits cleanly", app.status === 0, app.status !== 0 ? app.stdout.slice(-300) + app.stderr.slice(0, 300) : "");
const after = read();
check("q42 now holds q43's pictures", after.q42.image === "IMG43" && after.q42.answerImage === before.q43.answerImage);
check("a row with an EMPTY answerImage upstream gets an empty one (empties move too)", after.q44.answerImage === "" ? before.q45.answerImage === "" : after.q44.answerImage === before.q45.answerImage);
check("q146 now holds q147's pictures", after.q146.image === "IMG147");
check("q147 is cleared, not left holding a stale picture", after.q147.image === "" && after.q147.answerImage === "");
check("q41 (before the shifted range) is untouched", after.q41.image === "IMG41");
check("q148 (beyond the range) is untouched", after.q148.image === "IMG148");
check("question text and points are never changed",
  Object.keys(after).every(id => after[id].q === before[id].q && after[id].a === before[id].a && after[id].points === before[id].points));
const backups = readdirSync(join(dir, "tools")).filter(f => /^games-shift-backup-.*\.json$/.test(f));
check("a backup file was written first", backups.length === 1);

const again = run("--apply");
check("a second run refuses — it is not safe to apply twice", again.status === 1 && /REFUSING/.test(again.stdout));
check("…and changes nothing", JSON.stringify(read()) === JSON.stringify(after));

const undo = run("--undo", join("tools", backups[0]), "--apply");
check("--undo exits cleanly", undo.status === 0);
const restored = read();
check("--undo puts every original picture back", Object.keys(before).every(id => restored[id].image === before[id].image && restored[id].answerImage === before[id].answerImage));
check("--undo without --apply is a dry run", (() => {
  const s = read(); s.q50.image = "TOUCHED"; writeFileSync(STATE, JSON.stringify(s));
  run("--undo", join("tools", backups[0]));
  return read().q50.image === "TOUCHED";
})());

process.exit(checks.every(Boolean) ? 0 : 1);
