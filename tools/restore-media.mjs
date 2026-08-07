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

const src = new Firestore({ projectId: PROJECT, databaseId: SOURCE_DB });
const dst = new Firestore({ projectId: PROJECT, databaseId: TARGET_DB });

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

  const cats = await src.collection("categories").get();
  const totals = { filled: 0, already: 0, blank: 0, mismatch: 0, missing: 0, bytes: 0 };
  const report = [];

  for (const catDoc of cats.docs) {
    if (ONLY && catDoc.id !== ONLY) continue;
    const name = (catDoc.data() || {}).name || catDoc.id;

    const [srcQs, dstQs] = await Promise.all([
      src.collection("categories").doc(catDoc.id).collection("questions").get(),
      dst.collection("categories").doc(catDoc.id).collection("questions").get(),
    ]);
    if (srcQs.empty) continue;

    const live = new Map();
    dstQs.forEach(d => live.set(d.id, d.data() || {}));

    const todo = [];
    let already = 0, blank = 0, mismatch = 0, missing = 0;

    srcQs.forEach(d => {
      const b = d.data() || {};
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
      report.push({ id: catDoc.id, name, fill: todo.length, already, mismatch, missing, bytes });
      console.log(`${name}`);
      console.log(`   restore ${todo.length}   already-ok ${already}   no-image ${blank}`
        + `   text-mismatch ${mismatch}   gone ${missing}   ${kb(bytes)}`);
    }

    if (APPLY && todo.length) {
      let done = 0;
      await pool(todo, CONCURRENCY, async t => {
        // update(), never set(): only these two fields are touched.
        await dst.collection("categories").doc(catDoc.id)
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
  if (!APPLY) console.log("\nDry run. Re-run with --apply to write.");
  else console.log("\nDone. Re-run WITHOUT --apply to verify: it should report 0 to restore.");

  if (totals.mismatch) {
    console.log("\nA mismatch means the question text changed since the backup, so the");
    console.log("picture could not be matched safely. Those are left alone deliberately.");
  }
}

main().catch(e => { console.error("\nFAILED:", e && e.message ? e.message : e); process.exit(1); });
