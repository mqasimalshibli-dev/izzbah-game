// Copy question images out of a RESTORED Firestore backup back into the live
// database, for the categories whose pictures were blanked on 5-6 August 2026.
//
// Why a script and not the console: restoring a Firestore backup creates a NEW
// database — it cannot overwrite (default), which is exactly what we want,
// because the live database has legitimate changes made after the 5th (the
// «تطبيقات» category, distractor edits) that the backup does not. So the backup
// is mounted alongside, and ONLY the missing images are copied across.
//
// Run it in Cloud Shell, where Application Default Credentials already have
// access to both databases. Nothing here needs a service-account key file, and
// the restored database never has to be made publicly readable — which matters,
// because it also contains users/{uid} with emails and saved games.
//
//   cd ~/izzbah-game && git pull            # Cloud Shell is a SEPARATE clone
//   npm install @google-cloud/firestore
//   node tools/restore-media.mjs --source restore-aug5              # dry run
//   node tools/restore-media.mjs --source restore-aug5 --apply      # write
//
// Safety rules, in order of importance:
//   1. Never overwrite an image that is already present in the live database.
//      This only ever FILLS BLANKS.
//   2. Never write to a question whose text or answer differs from the backup.
//      Questions can be edited or reordered, and doc ids are positional ("q7"),
//      so matching on id alone could put a photo on the wrong question.
//   3. Dry run unless --apply is passed.
//   4. update(), not set() — it touches the two image fields and cannot
//      clobber q / a / points / idx.
import { Firestore } from "@google-cloud/firestore";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const APPLY = argv.includes("--apply");
const PROJECT = arg("project", "izzbahgame");
const SOURCE_DB = arg("source", null);
const TARGET_DB = arg("target", "(default)");
const ONLY = arg("only", null);            // optional: one category id
const CONCURRENCY = Number(arg("concurrency", 6));

if (!SOURCE_DB) {
  console.error("Missing --source <restored-database-id>   (e.g. --source restore-aug5)");
  process.exit(2);
}
if (SOURCE_DB === TARGET_DB) {
  console.error("--source and --target are the same database. Refusing.");
  process.exit(2);
}

// A freshly restored database is slow to serve its first large reads: pulling
// all 40 category parent docs in one RPC (each carries a cover image plus its
// inline question array) died with DEADLINE_EXCEEDED after the default 300s.
// So: a longer deadline, and every read below is kept small and paged.
// Transport: gRPC, measured. tools/probe-firestore.js reads one document from
// each database over both, and on a freshly restored database REST took 15.9s
// against gRPC's 2.1s. An earlier guess that a stalled gRPC stream was behind
// the DEADLINE_EXCEEDED was simply wrong — both transports work. Reads are
// just SLOW on a restored database, which is why every read below is paged:
// at a couple of seconds a document, one 198-doc get() exceeds the 300s
// deadline, and that is exactly what the first run hit. --rest to compare.
const opts = { projectId: PROJECT, preferRest: argv.includes("--rest") };

const src = new Firestore(Object.assign({ databaseId: SOURCE_DB }, opts));
const dst = new Firestore(Object.assign({ databaseId: TARGET_DB }, opts));

// The eight categories blanked on 5-6 August 2026, measured from the live
// database (no images left AND question docs rewritten inside the incident
// window). Restricting to these cuts the work by ~80% versus walking all 40 —
// and the whole job is bounded by how much base64 has to come down the wire.
// --all walks every category instead; --only <id> does exactly one.
const AFFECTED = [
  "culture",                  // ثقافة عامة
  "history",                  // تاريخ
  "pub-1783170059396-601",    // مواقع في عمان
  "pub-1783170356019-2501",   // براندات
  "pub-1783189666048-7547",   // مصارعة حره
  "pub-1783453062866-1028",   // حنكة عمانية
  "pub-1783510423551-6465",   // العاب
  "pub-1784240484235-8039",   // معنـى الايموجي
];

// Read a questions subcollection in PAGES. One .get() on 198 docs of base64 is
// ~10 MB in a single RPC, which is what times out; 20 at a time is not.
async function readQuestions(db, catId, pageSize = 20, tick = null) {
  const col = db.collection("categories").doc(catId).collection("questions");
  const out = [];
  let last = null;
  for (;;) {
    let q = col.orderBy("__name__").limit(pageSize);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    snap.docs.forEach(d => out.push({ id: d.id, data: d.data() || {} }));
    if (tick) tick(out.length);
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < pageSize) break;
  }
  return out;
}

const norm = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const kb = n => (n / 1024).toFixed(0) + " KB";

// Run `jobs` with a small parallel pool. Images are up to ~1 MiB each, so this
// is deliberately modest — the point is to finish reliably, not fast.
async function pool(items, n, fn) {
  const it = items[Symbol.iterator]();
  const workers = Array.from({ length: Math.max(1, n) }, async () => {
    for (;;) {
      const next = it.next();
      if (next.done) return;
      await fn(next.value);
    }
  });
  await Promise.all(workers);
}

async function main() {
  console.log(`project ${PROJECT}`);
  console.log(`source  ${SOURCE_DB}   (restored backup, read-only here)`);
  console.log(`target  ${TARGET_DB}   (live)`);
  console.log(APPLY ? "\n*** APPLY — this will write ***\n" : "\n--- DRY RUN — nothing will be written (add --apply) ---\n");

  // listDocuments() returns references only — no document bodies — so the
  // category list costs nothing even on a cold database.
  const ALL = argv.includes("--all");
  let ids;
  if (ONLY) ids = [ONLY];
  else if (ALL) ids = (await src.collection("categories").listDocuments()).map(r => r.id);
  else ids = AFFECTED.slice();
  console.log(`scanning ${ids.length} categor${ids.length === 1 ? "y" : "ies"}`
    + (ALL || ONLY ? "" : " (the 8 affected; pass --all for every category)") + "\n");
  const totals = { filled: 0, already: 0, blank: 0, mismatch: 0, missing: 0, bytes: 0 };
  const report = [];

  // Progress is printed for EVERY category, not only the ones needing work.
  // Reading both databases moves a few hundred MB of base64, and a run that
  // prints nothing for minutes is indistinguishable from a hung one.
  let scanned = 0;
  const t0 = Date.now();
  for (const catId of ids) {
    process.stdout.write(`[${String(++scanned).padStart(2)}/${ids.length}] ${catId} … `);

    // A restored database serves reads slowly, so show every page landing —
    // otherwise a category that legitimately takes minutes looks hung, which
    // is how three separate runs got killed early.
    const dot = () => process.stdout.write(".");
    const srcQs = await readQuestions(src, catId, 20, dot);
    if (!srcQs.length) { console.log(" no question docs in backup — skipped"); continue; }
    const dstQs = await readQuestions(dst, catId, 20, dot);
    process.stdout.write(` ${srcQs.length} read — `);

    const live = new Map();
    dstQs.forEach(d => live.set(d.id, d.data));

    const todo = [];
    let already = 0, blank = 0, mismatch = 0, missing = 0;

    srcQs.forEach(d => {
      const b = d.data;
      if (!b.image && !b.answerImage) { blank++; return; }   // nothing to restore
      const cur = live.get(d.id);
      if (!cur) { missing++; return; }                        // question no longer exists
      // Rule 2: the doc id is positional, so prove it is the same question.
      if (norm(cur.q) !== norm(b.q) || norm(cur.a) !== norm(b.a)) { mismatch++; return; }
      // Rule 1: only fill blanks, per field.
      const patch = {};
      if (b.image && !cur.image) patch.image = b.image;
      if (b.answerImage && !cur.answerImage) patch.answerImage = b.answerImage;
      if (!Object.keys(patch).length) { already++; return; }
      todo.push({ id: d.id, patch, bytes: (patch.image || "").length + (patch.answerImage || "").length });
    });

    const bytes = todo.reduce((a, t) => a + t.bytes, 0);
    if (todo.length || mismatch || missing) {
      report.push({ id: catId, fill: todo.length, already, mismatch, missing, bytes });
      console.log(`RESTORE ${todo.length}   already-ok ${already}   no-image ${blank}`
        + `   text-mismatch ${mismatch}   gone ${missing}   ${kb(bytes)}`);
    } else {
      console.log(`ok (${already} already have pictures, ${blank} never had one)`);
    }

    if (APPLY && todo.length) {
      let done = 0;
      await pool(todo, CONCURRENCY, async t => {
        // update(), never set(): only these two fields are touched.
        await dst.collection("categories").doc(catId)
          .collection("questions").doc(t.id).update(t.patch);
        if (++done % 25 === 0) process.stdout.write(`   …${done}/${todo.length}\n`);
      });
      console.log(`   ✓ wrote ${done}`);
    }

    totals.filled += todo.length; totals.already += already; totals.blank += blank;
    totals.mismatch += mismatch; totals.missing += missing; totals.bytes += bytes;
  }

  console.log("\n─────────────────────────────────────────────");
  console.log(`images to restore : ${totals.filled}   (${kb(totals.bytes)})`);
  console.log(`already present   : ${totals.already}`);
  console.log(`text mismatch     : ${totals.mismatch}   <- skipped on purpose, review these`);
  console.log(`question gone     : ${totals.missing}`);
  console.log(`elapsed           : ${Math.round((Date.now()-t0)/1000)}s`);
  if (!APPLY) console.log("\nDry run. Re-run with --apply to write.");
  else console.log("\nDone. Re-run WITHOUT --apply to verify: it should report 0 to restore.");

  if (totals.mismatch) {
    console.log("\nA mismatch means the question text changed since the backup, so the");
    console.log("picture could not be matched safely. Those are left alone deliberately.");
  }
}

main().catch(e => { console.error("\nFAILED:", e && e.message ? e.message : e); process.exit(1); });
