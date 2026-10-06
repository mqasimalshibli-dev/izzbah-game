// Image-duplicate scanner for the LIVE catalogue.
//
// Owner report, 2026-10-06: "some categories have the pictures mixed again...
// for example, places in oman." Checked «مواقع في عمان» by hand first — no
// blank images (so this is NOT the Aug 2026 wipe/blanking bug from CLAUDE.md's
// top warning: counts match, no id/idx mismatch) but FOUR pairs of questions
// share byte-IDENTICAL image bytes, e.g. وادي دربات (a valley) and مسجد سعال
// (a mosque) — two unrelated places with the exact same photo. That is
// consistent with a bad/ambiguous match during the Wikipedia image-fetch
// pass (see findAnswerImageUrl in index.html), not a publish/reorder bug.
//
// Read-only, like tools/dupscan.mjs. Reports; nothing here edits a question
// or writes anything.
//
//   node tools/imgdupscan.mjs                 scan every category
//   node tools/imgdupscan.mjs --cat "عمان"    limit to categories matching this
//
// A hash match is a STRONG signal (identical bytes don't happen by accident
// between two different real photos) but is not proof of which side is wrong
// — only a human (or the image-reviewer agent) can say that. This only finds
// exact-byte duplicates; a uniquely-wrong-but-not-duplicated photo needs
// vision review instead (see CLAUDE.md's `review-images` workflow).
import crypto from "crypto";

// Same Arabic normalisation as tools/dupscan.mjs — without it "تايتانيك" and
// "تيتانيك" (two spellings of the same word) look like two different
// answers and a correctly-shared image gets flagged as a bug.
const AR_DIAC = /[ً-ْٰـ]/g;
const norm = (s) => String(s || "")
  .replace(AR_DIAC, "")
  .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
  .replace(/[^\p{L}\p{N}\s]/gu, " ")
  .replace(/\s+/g, " ").trim().toLowerCase();

const BASE = "https://firestore.googleapis.com/v1/projects/izzbahgame/databases/(default)/documents/categories";
const CONCURRENCY = 6;

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const catFilter = argVal("cat");

function val(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  return null;
}
const hash = (s) => s ? crypto.createHash("sha1").update(s).digest("hex").slice(0, 10) : "";

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

async function listCategories() {
  let token = "", cats = [];
  for (;;) {
    const r = await fetch(`${BASE}?pageSize=50${token ? `&pageToken=${token}` : ""}`);
    const j = await r.json();
    (j.documents || []).forEach(d => cats.push(d));
    if (!j.nextPageToken) break;
    token = j.nextPageToken;
  }
  return cats.map(d => ({ id: d.name.split("/").pop(), name: val((d.fields || {}).name) || "" }));
}

async function listQuestions(catId) {
  let token = "", docs = [];
  for (;;) {
    const r = await fetch(`${BASE}/${catId}/questions?pageSize=300${token ? `&pageToken=${token}` : ""}`);
    const j = await r.json();
    (j.documents || []).forEach(d => docs.push(d));
    if (!j.nextPageToken) break;
    token = j.nextPageToken;
  }
  return docs.map(d => {
    const f = d.fields || {};
    return { id: d.name.split("/").pop(), q: val(f.q) || "", a: val(f.a) || "", image: val(f.image) || "", answerImage: val(f.answerImage) || "" };
  });
}

async function main() {
  const t0 = Date.now();
  let cats = await listCategories();
  if (catFilter) cats = cats.filter(c => c.name.includes(catFilter) || c.id.includes(catFilter));
  console.log(`Scanning ${cats.length} categories for byte-identical images across DIFFERENT questions…\n`);

  let totalFlags = 0;
  let totalQuestions = 0;
  const findings = [];

  await pool(cats, CONCURRENCY, async (cat) => {
    const qs = await listQuestions(cat.id);
    totalQuestions += qs.length;
    // One pool per category: group by hash, across BOTH image and
    // answerImage, but never flag a question's own image==answerImage (the
    // deliberate "one photo for a name-this-place question" design).
    const byHash = new Map();
    qs.forEach(q => {
      [["image", q.image], ["answerImage", q.answerImage]].forEach(([field, src]) => {
        const h = hash(src);
        if (!h) return;
        if (!byHash.has(h)) byHash.set(h, []);
        byHash.get(h).push({ qid: q.id, field, a: q.a, q: q.q });
      });
    });
    byHash.forEach((list) => {
      const distinctQ = new Set(list.map(x => x.qid));
      if (distinctQ.size < 2) return; // same question's own image+answerImage sharing a hash — expected
      // The SAME real-world answer (e.g. two different questions both about
      // "Nike") legitimately shares its fetched image — that is reuse, not a
      // mismatch. Only flag when the image is shared across DIFFERENT
      // (normalised) answers, which means at least one of them has the WRONG
      // picture.
      const distinctAnswers = new Set(list.map(x => norm(x.a)));
      if (distinctAnswers.size < 2) return;
      totalFlags++;
      findings.push({ cat: cat.name || cat.id, catId: cat.id, pairs: list });
    });
  });

  findings.sort((a, b) => a.cat.localeCompare(b.cat, "ar"));
  findings.forEach(f => {
    console.log(`--- ${f.cat} (${f.catId}) ---`);
    const seen = new Set();
    f.pairs.forEach(p => {
      const key = p.qid + ":" + p.field;
      if (seen.has(key)) return;
      seen.add(key);
      console.log(`  ${p.qid} [${p.field}]  answer: ${p.a || "(no answer)"}`);
    });
    console.log("");
  });

  console.log(`Scanned ${totalQuestions} questions across ${cats.length} categories in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log(`${totalFlags} duplicate-image group(s) found${totalFlags ? " — listed above" : ""}.`);
}
main().catch(e => { console.error("ERROR", e); process.exit(1); });
