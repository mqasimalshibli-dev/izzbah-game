// One-off repair for "معنى الايموجي" (pub-1784240484235-8039).
//
// An extra "تونس" rebus picture got INSERTED at q23 at some point after this
// category was last correct. That single insertion pushed every image from
// q24 through q105 forward by exactly one slot — confirmed by visually
// decoding all 106 stored rebuses against their own `a` field, not guessed
// from text. q0-q22 are untouched and correct. The chain is unbroken across
// all 82 affected questions (no scatter, no rotation) — verified live,
// 2026-08-30.
//
//   node tools/fix-emoji-shift.mjs             # dry run
//   node tools/fix-emoji-shift.mjs --apply     # write
//
// The fix: for each N from 24 to 105, move qN's image/answerImage BACK into
// q(N-1) — i.e. q23 receives q24's picture, q24 receives q25's, ... q104
// receives q105's. q105 itself is left with NO source to pull from (its own
// rightful rebus was pushed off the end of the array and is gone from live
// data) and is explicitly CLEARED rather than left holding stale content.
//
// Safety:
//   - Scoped to exactly ONE hardcoded category id — not a flag, so this
//     script cannot be pointed at anything else by accident.
//   - EXPECTED below is the answer recorded at each index during the audit.
//     Before writing, every target doc's CURRENT `a` is checked against it;
//     anything that has moved on since (an admin's own manual fix, another
//     edit) is SKIPPED and reported, never blindly overwritten. This is the
//     same "prove it's still the same question" rule restore-media.mjs uses
//     against doc-id positional matching, applied here against re-drift.
//   - update(), never set() — touches only image/answerImage, so q/a/points/
//     idx cannot be clobbered even by a bug in this script.
//   - This is a raw per-document Admin SDK patch, not a cloudPublish() —
//     it never routes through the lite/hydrate boundary the .268 wipe-guard
//     exists for, and every image written here is real data sourced from
//     another live document (never blank-because-untrusted), so that whole
//     bug class does not apply to this write path.
//   - No meta/index rebuild or catalogue rev bump needed: question images are
//     never cached in the boot-time index (.309) or the parent category doc
//     — they are read fresh from the /questions subcollection every game
//     (.209 lazy media) — so this fix is invisible to the catalogue cache.
import { Firestore } from "@google-cloud/firestore";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const CATEGORY = "pub-1784240484235-8039"; // معنى الايموجي — the ONLY category this script touches
const db = new Firestore({ projectId: "izzbahgame" });

// ⚠️ SENTINEL, checked before anything else runs. This script is NOT
// idempotent to re-run after a successful apply: it reads whatever image
// currently sits at index N and moves it into N-1, so running it again after
// the fix is already in would shift everything a SECOND time and re-corrupt
// the category it just repaired — including in dry-run mode, since the
// staleness check only compares the answer TEXT (which this script never
// touches), so a second dry run shows the exact same "82 writes planned"
// regardless of whether the fix already landed. That looked like "still
// needs it" and nearly caused a re-run right after the real fix succeeded.
// The sentinel is the actual guard; the comment is why it exists.
const SENTINEL = join(dirname(fileURLToPath(import.meta.url)), ".fix-emoji-shift.applied");
if (existsSync(SENTINEL) && !FORCE) {
  console.error(`Already applied — see ${SENTINEL}:\n`);
  console.error(readFileSync(SENTINEL, "utf8"));
  console.error("Refusing to run again (dry run included — it would show the same plan and invite a re-apply that re-breaks the fix).");
  console.error("If you genuinely need to run this again, pass --force.");
  process.exit(1);
}

// The answer CURRENTLY stored at each index, as audited. Keys 23-105.
const EXPECTED = {
  23: "كلب", 24: "منجد", 25: "دبي", 26: "سوريا", 27: "كمثري", 28: "كشري",
  29: "مسعود", 30: "ديما", 31: "السنغال", 32: "حصان", 33: "مبرمج", 34: "الدمام",
  35: "اليابان", 36: "كرز", 37: "جريش", 38: "باهر", 39: "ريناد", 40: "فيتنام",
  41: "تمساح", 42: "آسر", 43: "الجزائر", 44: "سرعوف", 45: "تاجر", 46: "بيروت",
  47: "بطيخ", 48: "بطريق", 49: "بيتزا", 50: "النمسا", 51: "إبراهيم", 52: "فرنسا",
  53: "جدة", 54: "بحار", 55: "برتقال", 56: "إنستغرام", 57: "كاندي كراش", 58: "سمكة",
  59: "مكرونة", 60: "سكينة", 61: "آدم", 62: "سلمى", 63: "محامي", 64: "فاروق",
  65: "ياسمين", 66: "عصفور", 67: "بابل", 68: "كوبا", 69: "مانجو", 70: "سمير",
  71: "فاتن", 72: "مالطا", 73: "جربوع", 74: "صيدلي", 75: "بورسعيد", 76: "الكاميرون",
  77: "بطاطس", 78: "البحرين", 79: "زيتون", 80: "زاهر", 81: "منار", 82: "غراب",
  83: "زرافة", 84: "صحفي", 85: "مسقط", 86: "الصومال", 87: "كباب", 88: "لقلق",
  89: "الفلبين", 90: "قطر", 91: "جزر القمر", 92: "الأرجنتين", 93: "زامبيا",
  94: "موزمبيق", 95: "عُمان", 96: "إيران", 97: "تونس", 98: "باكستان", 99: "جيبوتي",
  100: "مالي", 101: "اليونان", 102: "قبرص", 103: "التشيك", 104: "آيسلندا", 105: "ايسلندا",
};

const norm = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

// ⚠️ db.getAll() — Firestore's BATCH read, a streaming RPC under the hood —
// hung and hard-timed-out 100% of the time in the environment this was first
// run from, on every single attempt, while a single plain doc.get() (a unary
// RPC) came back in ~4s. Confirmed live by isolating the two: getAll() failed
// 4/4 tries at a 20s deadline, back to back, while .get() worked every time.
// So reads here are done as individual .get() calls with modest concurrency,
// never getAll() — this is the one thing proven to actually work on whatever
// network path this runs over.
const BATCH = 10;          // concurrent .get() calls in flight at once
const DOC_TIMEOUT_MS = 15000;
const DOC_RETRIES = 4;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { code: "TIMEOUT" })), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function getOne(ref) {
  for (let attempt = 1; attempt <= DOC_RETRIES; attempt++) {
    const t0 = Date.now();
    try {
      return await withTimeout(ref.get(), DOC_TIMEOUT_MS, ref.id);
    } catch (e) {
      process.stdout.write(`  ! ${ref.id} attempt ${attempt}/${DOC_RETRIES} failed after ${Date.now() - t0}ms: ${e.message}\n`);
      if (attempt === DOC_RETRIES) throw new Error(`${ref.id} failed after ${DOC_RETRIES} attempts — giving up rather than hanging forever`);
    }
  }
}

async function readAll(col, refs) {
  const out = [];
  let done = 0;
  for (let i = 0; i < refs.length; i += BATCH) {
    const slice = refs.slice(i, i + BATCH);
    const snaps = await Promise.all(slice.map(getOne));
    snaps.forEach(d => { if (d.exists) out.push(d); });
    done += slice.length;
    process.stdout.write(`  ${done}/${refs.length}\n`);
  }
  return out;
}

async function main() {
  console.log(APPLY ? "*** APPLY — this will write ***" : "--- DRY RUN (pass --apply to write) ---");
  console.log(`category ${CATEGORY}\n`);

  const col = db.collection("categories").doc(CATEGORY).collection("questions");
  console.log("listing question docs…");
  const refs = await col.listDocuments();
  console.log(`${refs.length} docs found, reading…`);
  const snaps = await readAll(col, refs);
  const byId = new Map();
  snaps.forEach(d => byId.set(d.id, d.data() || {}));
  console.log(`${byId.size} question docs read\n`);

  const plan = [];
  let staleSkipped = 0, missing = 0;

  for (let n = 24; n <= 105; n++) {
    const targetId = "q" + (n - 1);
    const sourceId = "q" + n;
    const target = byId.get(targetId);
    const source = byId.get(sourceId);
    if (!target || !source) {
      console.log(`  ! ${targetId} or ${sourceId} missing entirely — skipped`);
      missing++;
      continue;
    }
    const expected = EXPECTED[n - 1];
    if (expected !== undefined && norm(target.a) !== expected) {
      console.log(`  ! ${targetId} answer is "${target.a}", expected "${expected}" — SKIPPED (changed since audit?)`);
      staleSkipped++;
      continue;
    }
    plan.push({
      id: targetId,
      newImage: source.image || "",
      newAnswerImage: source.answerImage || "",
      from: sourceId,
    });
  }

  // q105 has no q106 to pull from — its rightful picture is gone from live
  // data. Clear it explicitly rather than leaving it holding q104's old
  // picture (which q104 is about to receive correctly from q105 above).
  const last = byId.get("q105");
  if (last && (last.image || last.answerImage)) {
    const expected = EXPECTED[105];
    if (expected !== undefined && norm(last.a) !== expected) {
      console.log(`  ! q105 answer is "${last.a}", expected "${expected}" — SKIPPED (changed since audit?)`);
      staleSkipped++;
    } else {
      plan.push({ id: "q105", newImage: "", newAnswerImage: "", from: "(cleared — its rightful picture is gone; needs a new one authored)" });
    }
  }

  plan.forEach(p => console.log(`  ${p.id.padEnd(6)} <- ${p.from}`));
  console.log(`\n${plan.length} writes planned`
    + (staleSkipped ? `, ${staleSkipped} skipped as stale` : "")
    + (missing ? `, ${missing} skipped as missing docs` : ""));

  if (APPLY) {
    for (const p of plan) {
      await col.doc(p.id).update({ image: p.newImage, answerImage: p.newAnswerImage });
    }
    console.log(`\n✓ wrote ${plan.length} documents`);
    writeFileSync(SENTINEL, `Applied ${new Date().toISOString()} — wrote ${plan.length} documents.\n`
      + `Do NOT run this script again on this category — it is not safe to re-run after a\n`
      + `successful apply (see the comment at the top of the file). Delete this file only\n`
      + `if you specifically need to re-apply with --force, and know why.\n`);
    console.log(`Wrote ${SENTINEL} — this script will now refuse to run again without --force.`);
    console.log("Verify by looking in the admin editor, NOT by re-running this script — a second run (dry or apply) would show the same plan and re-shift everything if applied again.");
  } else {
    console.log("\nDry run. Compare the list above against tools/fix-emoji-shift.mjs's own EXPECTED table and the mapping file, then re-run with --apply.");
  }
}

main().catch(e => { console.error("\nFAILED:", e && e.message ? e.message : e); process.exit(1); });
