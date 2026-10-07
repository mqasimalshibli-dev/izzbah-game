// Re-pair question pictures that have drifted onto the WRONG question, using an
// old restored backup as the source of truth for who owns which picture.
//
// Background (build .353): the media-lite publish path used to hand each
// question "the stored image of the same SLOT", so any publish that moved
// questions left every later picture one (or more) rows out. Docs are keyed
// q0..qN by POSITION, so the live pictures are all present — just on the wrong
// question. tools/restore-media.mjs cannot fix that: it only fills BLANKS, and
// these are not blank. tools/fix-games-shift.mjs fixes one category with a
// constant offset. This is the general tool, for an offset that VARIES.
//
//   cd ~/izzbah-game && git pull            # Cloud Shell is a SEPARATE clone
//   npm install @google-cloud/firestore
//   node tools/repair-media.mjs --source restore-old --only <categoryId>          # dry run
//   node tools/repair-media.mjs --source restore-old --only <categoryId> --apply
//   node tools/touch-categories.mjs --only <categoryId> --apply   # or devices never see it
//   node tools/repair-media.mjs --undo tools/repair-media-backup-<...>.json --apply
//
// How a question is identified: by WHAT IT SAYS (normalised q + a), never by
// its doc id. The nearest backup row wins among identical texts.
//
// What it will change, and nothing else — for each live question that has a
// backup twin, per field (image / answerImage):
//   • live is EMPTY and the backup has a picture  -> FILL it
//   • live differs from the backup, AND the live picture is one the backup
//     gives to a DIFFERENT question                -> it is displaced; PUT BACK
//   • live differs and matches no backup picture   -> someone replaced it since
//     the backup. LEFT ALONE and listed — an old photo must not beat a new one.
//   • the backup has no picture for that field     -> LEFT ALONE. Never blanks.
// Questions with no backup twin (added since) are never touched.
//
// Safety: dry run unless --apply; update() of the two image fields only; the
// overwritten values are written to a backup file BEFORE the first write, and
// --undo puts them back. Re-running after an apply reports nothing to do.
import { Firestore } from "@google-cloud/firestore";
import crypto from "crypto";
import { writeFileSync, readFileSync } from "fs";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const APPLY = argv.includes("--apply");
const PROJECT = arg("project", "izzbahgame");
const SOURCE_DB = arg("source", null);
const TARGET_DB = arg("target", "(default)");
const ONLY = arg("only", null);
const UNDO = arg("undo", null);
const BATCH = Number(arg("batch", 5));
const READERS = Number(arg("readers", 12));
const CONCURRENCY = Number(arg("concurrency", 6));

const opts = { projectId: PROJECT };
const norm = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const keyOf = d => JSON.stringify([norm(d.q), norm(d.a)]);
const hash = s => s ? crypto.createHash("sha1").update(String(s)).digest("hex") : "";
const numOf = id => { const m = /^q(\d+)$/.exec(id); return m ? +m[1] : 0; };
const FIELDS = ["image", "answerImage"];

async function pool(items, n, fn) {
  const it = items[Symbol.iterator]();
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => {
    for (;;) { const next = it.next(); if (next.done) return; await fn(next.value); }
  }));
}

async function readQuestions(db, catId) {
  const refs = await db.collection("categories").doc(catId).collection("questions").listDocuments();
  const slices = [];
  for (let i = 0; i < refs.length; i += BATCH) slices.push(refs.slice(i, i + BATCH));
  const out = [];
  await pool(slices, READERS, async sl => {
    const snaps = await db.getAll(...sl);
    snaps.forEach(d => { if (d.exists) out.push({ id: d.id, data: d.data() || {} }); });
  });
  return out.sort((a, b) => numOf(a.id) - numOf(b.id));
}

// ---- undo ----
if (UNDO) {
  const saved = JSON.parse(readFileSync(UNDO, "utf8"));
  const dst = new Firestore(Object.assign({ databaseId: saved.target || TARGET_DB }, opts));
  const entries = Object.entries(saved.docs);
  console.log(`undo ${UNDO}: ${entries.length} documents in ${saved.category}`);
  if (!APPLY) { console.log("--- DRY RUN: nothing written (add --apply) ---"); process.exit(0); }
  const col = dst.collection("categories").doc(saved.category).collection("questions");
  await pool(entries, CONCURRENCY, async ([id, v]) => { await col.doc(id).update(v); });
  console.log(`restored ${entries.length}. Now run touch-categories --only ${saved.category} --apply`);
  process.exit(0);
}

if (!SOURCE_DB) { console.error("Missing --source <restored-database-id>"); process.exit(2); }
if (!ONLY) { console.error("Missing --only <categoryId>  (one category per run, on purpose)"); process.exit(2); }
if (SOURCE_DB === TARGET_DB) { console.error("--source and --target are the same database. Refusing."); process.exit(2); }

const src = new Firestore(Object.assign({ databaseId: SOURCE_DB }, opts));
const dst = new Firestore(Object.assign({ databaseId: TARGET_DB }, opts));

async function main() {
  console.log(`project ${PROJECT}\nsource  ${SOURCE_DB}   (restored backup, read-only here)\ntarget  ${TARGET_DB}\ncategory ${ONLY}`);
  console.log(APPLY ? "\n*** APPLY — this will write ***\n" : "\n--- DRY RUN — nothing will be written (add --apply) ---\n");

  const bk = await readQuestions(src, ONLY);
  if (!bk.length) { console.error("No question docs for that category in the backup. Wrong id or wrong backup?"); process.exit(1); }
  const lv = await readQuestions(dst, ONLY);
  console.log(`backup ${bk.length} questions   live ${lv.length} questions\n`);

  // Backup rows by identity, and every picture the backup assigns, with its owner.
  const byKey = new Map();
  bk.forEach(b => { const k = keyOf(b.data); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(b); });
  const ownerOf = new Map();           // picture hash -> set of backup ids that own it
  bk.forEach(b => FIELDS.forEach(f => {
    const h = hash(b.data[f]); if (!h) return;
    if (!ownerOf.has(h)) ownerOf.set(h, new Set());
    ownerOf.get(h).add(b.id);
  }));

  const used = new Set();
  const changes = [];     // { id, q, a, patch, prev, kinds }
  const replaced = [];    // live picture that is nobody's in the backup
  let same = 0, fresh = 0, noPic = 0;

  lv.forEach(L => {
    const cands = (byKey.get(keyOf(L.data)) || []).filter(b => !used.has(b.id));
    if (!cands.length) { fresh++; return; }
    let B = cands[0];
    cands.forEach(c => { if (Math.abs(numOf(c.id) - numOf(L.id)) < Math.abs(numOf(B.id) - numOf(L.id))) B = c; });
    used.add(B.id);

    const patch = {}, prev = {}, kinds = [];
    FIELDS.forEach(f => {
      const b = B.data[f] || "", l = L.data[f] || "";
      if (!b) { noPic++; return; }                 // never blank
      if (l === b) { same++; return; }
      if (!l) { patch[f] = b; prev[f] = l; kinds.push(f + ":fill"); return; }
      const owners = ownerOf.get(hash(l));
      if (owners && !owners.has(B.id)) { patch[f] = b; prev[f] = l; kinds.push(f + ":displaced"); return; }
      replaced.push({ id: L.id, f, q: norm(L.data.q), a: norm(L.data.a) });
    });
    if (Object.keys(patch).length) changes.push({ id: L.id, q: norm(L.data.q), a: norm(L.data.a), patch, prev, kinds });
  });

  changes.forEach(c => console.log(`${c.id.padEnd(6)} ${(c.a || c.q).slice(0, 38).padEnd(38)} ${c.kinds.join(", ")}`));
  if (replaced.length) {
    console.log("\nLeft alone — the live picture is not in the backup at all (replaced since?):");
    replaced.forEach(r => console.log(`  ${r.id.padEnd(6)} ${r.f.padEnd(11)} ${(r.a || r.q).slice(0, 40)}`));
  }
  console.log("\n─────────────────────────────────────────────");
  console.log(`to repair        : ${changes.length} questions`
    + ` (${changes.filter(c => c.kinds.some(k => k.endsWith("displaced"))).length} displaced, `
    + `${changes.filter(c => c.kinds.every(k => k.endsWith("fill"))).length} fill-only)`);
  console.log(`already correct  : ${same} pictures`);
  console.log(`left alone       : ${replaced.length} changed since backup, ${fresh} questions newer than backup`);

  if (!changes.length) { console.log("\nNothing to do."); return; }
  if (!APPLY) { console.log("\nDry run. Re-run with --apply to write."); return; }

  const file = `tools/repair-media-backup-${ONLY}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const docs = {};
  changes.forEach(c => { docs[c.id] = {}; FIELDS.forEach(f => { if (f in c.patch) docs[c.id][f] = c.prev[f]; }); });
  writeFileSync(file, JSON.stringify({ category: ONLY, target: TARGET_DB, docs }));
  console.log(`\nbackup of the values about to be overwritten: ${file}`);

  const col = dst.collection("categories").doc(ONLY).collection("questions");
  let done = 0;
  await pool(changes, CONCURRENCY, async c => { await col.doc(c.id).update(c.patch); if (++done % 25 === 0) console.log(`  …${done}/${changes.length}`); });
  console.log(`✓ wrote ${done}\n\nNext: node tools/touch-categories.mjs --only ${ONLY} --apply`);
  console.log("Then re-run this script WITHOUT --apply to verify: it should say Nothing to do.");
}
main().catch(e => { console.error("\nFAILED:", e && e.message ? e.message : e); process.exit(1); });
