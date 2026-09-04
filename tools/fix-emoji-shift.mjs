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

const APPLY = process.argv.includes("--apply");
const CATEGORY = "pub-1784240484235-8039"; // معنى الايموجي — the ONLY category this script touches
const db = new Firestore({ projectId: "izzbahgame" });

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

// A single getAll() across 106 image-carrying docs gives no feedback while in
// flight (each ~30-40KB of base64, so a few MB in one RPC) — batch it with
// visible progress, same pattern as tools/restore-media.mjs, so a genuinely
// slow run and a hung one don't look identical on screen.
//
// ⚠️ Also TIMED and RETRIED per batch. A live run stalled at the exact same
// point (right after the first batch) across three separate fresh process
// starts — too consistent to be ordinary jitter. Rather than hang silently
// again, each batch gets a hard deadline; on timeout it's logged and retried
// (a fresh RPC, not waiting on the stuck one) up to 4 times before the whole
// run fails loudly naming which batch never came back.
const BATCH = 10;
const BATCH_TIMEOUT_MS = 20000;
const BATCH_RETRIES = 4;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { code: "TIMEOUT" })), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function readAll(col, refs) {
  const out = [];
  for (let i = 0; i < refs.length; i += BATCH) {
    const slice = refs.slice(i, i + BATCH);
    const label = `batch ${i}-${Math.min(i + BATCH, refs.length) - 1}`;
    let snaps = null;
    for (let attempt = 1; attempt <= BATCH_RETRIES; attempt++) {
      const t0 = Date.now();
      try {
        snaps = await withTimeout(db.getAll(...slice), BATCH_TIMEOUT_MS, label);
        const ms = Date.now() - t0;
        if (attempt > 1) process.stdout.write(`  ${label}: recovered on attempt ${attempt} (${ms}ms)\n`);
        break;
      } catch (e) {
        process.stdout.write(`  ! ${label} attempt ${attempt}/${BATCH_RETRIES} failed after ${Date.now() - t0}ms: ${e.message}\n`);
        if (attempt === BATCH_RETRIES) throw new Error(`${label} failed after ${BATCH_RETRIES} attempts — giving up rather than hanging forever`);
      }
    }
    snaps.forEach(d => { if (d.exists) out.push(d); });
    process.stdout.write(`  ${Math.min(i + BATCH, refs.length)}/${refs.length}\n`);
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
    console.log("Re-run WITHOUT --apply to verify: every line above should report the shift already done (target answers will simply not need EXPECTED anymore — spot check a few in the admin editor).");
  } else {
    console.log("\nDry run. Compare the list above against tools/fix-emoji-shift.mjs's own EXPECTED table and the mapping file, then re-run with --apply.");
  }
}

main().catch(e => { console.error("\nFAILED:", e && e.message ? e.message : e); process.exit(1); });
