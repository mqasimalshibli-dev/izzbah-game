// Duplicate scanner for the LIVE catalogue, including the kind the in-game
// scanner cannot see.
//
// «فحص المتكررات» in the app compares question TEXT. That catches a question
// pasted twice. It does not catch the case that actually reaches players:
//
//   خريف ظفار 100  ما المنتج المرتبط بظفار؟        → اللبان
//   حنكة عمانية 100 أي محافظة تشتهر بشجرة اللبان؟  → ظفار
//
// Different words, no shared phrasing, opposite direction — and the same single
// fact served twice. A family playing both categories gets it twice and feels
// the catalogue is thinner than it is.
//
// So this looks for three things:
//   EXACT     identical once normalised
//   NEAR      high token overlap
//   INVERTED  each question contains the OTHER's answer — the pair above
//
// Read-only. It reports; nothing here edits a question.
//   node tools/dupscan.mjs                 scan everything
//   node tools/dupscan.mjs --cat "حنكة"    limit one side to a category
//   node tools/dupscan.mjs --check file    check candidate rows (pipe format)
const BASE = "https://firestore.googleapis.com/v1/projects/izzbahgame/databases/(default)/documents/categories";

// Arabic normalisation. Without this «ظُفار» and «ظفار» are different strings
// and every comparison below quietly under-reports.
const AR_DIAC = /[ً-ْٰـ]/g;
const norm = (s) => String(s || "")
  .replace(AR_DIAC, "")
  .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
  .replace(/[^\p{L}\p{N}\s]/gu, " ")
  .replace(/\s+/g, " ").trim().toLowerCase();

// Words too common to carry meaning; leaving them in makes every question look
// like every other one.
const STOP = new Set("ما من هو هي في اي أي على الى إلى عن كم متى اين أين هل التي الذي كان كانت يكون بن بنت عام سنه سنة اسم ماذا لماذا كيف وما وهو التى ذلك هذه هذا يوجد تقع يقع".split(" ").map(norm));
const toks = (s) => norm(s).split(" ").filter(w => w.length > 2 && !STOP.has(w));
const jac = (a, b) => {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let hit = 0; A.forEach(x => { if (B.has(x)) hit++; });
  return hit / (A.size + B.size - hit);
};

async function load() {
  const val = v => v ? (v.stringValue ?? v.integerValue ?? v.doubleValue ?? v.booleanValue ?? null) : null;
  let token = "", cats = [];
  for (;;) {
    const r = await fetch(`${BASE}?pageSize=50${token ? `&pageToken=${token}` : ""}`);
    const j = await r.json();
    (j.documents || []).forEach(d => cats.push(d));
    if (!j.nextPageToken) break; token = j.nextPageToken;
  }
  const out = [];
  cats.forEach(d => {
    const name = val((d.fields || {}).name) || d.name.split("/").pop();
    (((d.fields || {}).questions || {}).arrayValue || {}).values?.forEach(q => {
      const f = (q.mapValue || {}).fields || {};
      const text = String(val(f.q) || "").replace(/\s+/g, " ").trim();
      const ans = String(val(f.a) || "").replace(/\s+/g, " ").trim();
      if (!text && !ans) return;
      out.push({ cat: name, p: Number(val(f.points) || 0), q: text, a: ans,
                 qt: toks(text), nq: norm(text), na: norm(ans) });
    });
  });
  return out;
}

/* An INVERTED pair: q1 asks toward a1, q2 asks toward a2, and each question
   already names the other's answer. Both answers must be substantial — a
   one-word answer like «مسقط» appears in dozens of questions legitimately, so
   requiring BOTH directions is what keeps this from crying wolf. */
function inverted(x, y) {
  if (!x.na || !y.na || x.na === y.na) return false;
  if (x.na.length < 3 || y.na.length < 3) return false;
  return x.nq.includes(y.na) && y.nq.includes(x.na);
}

const args = process.argv.slice(2);
const catFilter = args.includes("--cat") ? args[args.indexOf("--cat") + 1] : "";
const all = await load();
console.log(`scanned ${all.length} questions across ${new Set(all.map(r => r.cat)).size} categories`);
if (catFilter) console.log(`(one side limited to categories matching «${catFilter}»)`);

// How often each answer appears in the whole catalogue. An inversion built on
// two COMMON entities is coincidence — «إيطاليا فازت بأمم أوروبا» and «في أي
// قارة تقع إيطاليا» each name the other's answer and are about nothing alike.
// Two RARE answers pointing at each other is a genuinely repeated fact.
const ansFreq = new Map();
all.forEach(r => { if (r.na) ansFreq.set(r.na, (ansFreq.get(r.na) || 0) + 1); });
const rarity = (x, y) => Math.max(ansFreq.get(x.na) || 0, ansFreq.get(y.na) || 0);

// How many questions share each prompt. A prompt used by many questions is a
// MEDIA prompt — «من سجل هذا الهدف؟» for 24, «ما اسم هذا الموقع؟» for 178 —
// and there the clip or photo asks the question, not the words. Two different
// Neymar goals share an answer and are not duplicates.
// ⚠️ This scanner cannot check the media either: the parent doc is media-lite,
// so 0 of 31 «من الي سجل؟» questions carry a URL at this layer.
const promptCount = new Map();
all.forEach(r => { if (r.nq) promptCount.set(r.nq, (promptCount.get(r.nq) || 0) + 1); });
const mediaPrompt = (r) => (promptCount.get(r.nq) || 0) > 2;

const exact = [], sameAns = [], near = [], inv = [];
for (let i = 0; i < all.length; i++) {
  const x = all[i];
  if (catFilter && !x.cat.includes(catFilter)) continue;
  for (let j = 0; j < all.length; j++) {
    if (i === j) continue;
    const y = all[j];
    if (!catFilter && j < i) continue;          // full scan: each pair once
    // ⚠️ Identical TEXT is not a duplicate when the image is the question.
    // «وش اسم المطعم؟» is the prompt for dozens of photo questions in
    // كافيهات ومطاعم, and «ما اسم هذا الموقع؟» for مواقع في عمان — the picture
    // differentiates them and the parent doc's text-only copy does not carry
    // it. Comparing text alone reported 29,674 "duplicates", which is the same
    // as reporting none. A real duplicate matches on the ANSWER too.
    if (x.nq && x.nq === y.nq && x.na === y.na) {
      if (j > i) (mediaPrompt(x) ? sameAns : exact).push([x, y]);
      continue;
    }
    if (inverted(x, y)) { if (!catFilter ? j > i : true) inv.push([x, y]); continue; }
    const s = jac(x.qt, y.qt);
    // NEAR requires the same ANSWER. Similar wording with a different answer is
    // a different question by definition, and in this catalogue it is almost
    // always a photo series sharing one prompt. Allowing it reported 30,645
    // pairs, which is the same as reporting none.
    if (x.na && x.na === y.na && s >= 0.85 && (!catFilter ? j > i : true)) near.push([x, y, s]);
  }
}
const show = (label, list, fmt) => {
  console.log(`\n===== ${label}: ${list.length} =====`);
  list.slice(0, 40).forEach(p => console.log(fmt(p)));
  if (list.length > 40) console.log(`  … and ${list.length - 40} more`);
};
const line = (r) => `[${r.cat} ${r.p}] ${r.q} → ${r.a}`;
show("EXACT duplicates — the TEXT asks the question", exact, ([x, y]) => `  ${line(x)}\n  ${line(y)}\n`);
show("SAME ANSWER on a shared MEDIA prompt — check the clip, not a duplicate", sameAns,
  ([x, y]) => `  ${line(x)}\n  ${line(y)}\n`);
inv.sort((a, b) => rarity(a[0], a[1]) - rarity(b[0], b[1]));
const invReal = inv.filter(([x, y]) => rarity(x, y) <= 3);
show("INVERTED — likely REAL (both answers rare in the catalogue)", invReal,
  ([x, y]) => `  ${line(x)}\n  ${line(y)}\n`);
console.log(`\n(${inv.length - invReal.length} more inversions involve a common `
  + `entity and are almost certainly coincidence — run with --all-inv to see them)`);
if (process.argv.includes("--all-inv")) {
  show("INVERTED — probably coincidence", inv.filter(([x, y]) => rarity(x, y) > 3),
    ([x, y]) => `  ×${rarity(x, y)}\n  ${line(x)}\n  ${line(y)}\n`);
}
show("NEAR duplicates (same answer, ≥85% word overlap)", near, ([x, y, s]) => `  ${(s * 100).toFixed(0)}%\n  ${line(x)}\n  ${line(y)}\n`);
