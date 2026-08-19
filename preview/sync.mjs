// Regenerates preview/data.js from the live game.
//
//   node preview/sync.mjs
//
// The landing page must never drift from the game. Everything factual on it —
// which categories exist, what they're called, how many questions each really
// has, the totals in the counters — comes from this file, and this file comes
// from Firestore. Rename a category in the admin panel, publish a new one, add
// questions: re-run this and the page follows.
//
// What stays hand-written in index.html is editorial only: each category's
// one-line description and its tag. Those are keyed by id, so a new category
// still appears (with a neutral fallback) until someone writes copy for it.
//
// Reads are public — firestore.rules has `allow read: if true` on /categories,
// which it must, because every player's browser reads the same data.
//
// Covers are NOT fetched here. They're base64 blobs inside the category docs
// (200-400 KB each, ~12 MB for all 39) and they change rarely, so resizing
// them is a separate deliberate step — see COVERS.md.

const KEY = "AIzaSyDRcH7DlI-CDRTKh0_a5svL9UutNRmIH2I"; // public web key, same one the game ships
const ROOT = "https://firestore.googleapis.com/v1/projects/izzbahgame/databases/(default)/documents";

// Categories with no cloud cover fall back to a bundled asset, exactly as the
// game does (see publishedCoverFallbacks in index.html).
const BUNDLED = {
  foreignMoviesOnly: "../assets/img/cat-foreignMoviesOnly.webp",
  khareef:           "../assets/img/cat-khareef.webp",
  omaniFootball:     "../assets/img/cat-omaniFootball.webp",
  whoAmI:            "../assets/img/cat-whoAmI.webp",
};
// Omani-only categories — the library's real differentiator, flagged on the grid.
const OMANI = new Set(["khareef","omaniFootball","cafesRestaurants",
  "pub-1783170059396-601","pub-1783189569201-313","pub-1783425758108-102",
  "pub-1783453062866-1028","pub-1784798503561-5271","pub-1783170084646-5700"]);
const NEW = new Set(["sayAnother","arabicTerms"]);

const get = async (url) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return await r.json();
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise(r => setTimeout(r, 2 ** attempt * 1000));
    }
  }
};

// The category docs carry their cover inline, so ask only for the small fields
// or a single page balloons past the API's response limit.
async function categories() {
  const out = [];
  let token = null;
  do {
    const q = new URLSearchParams({ key: KEY, pageSize: "60" });
    ["name", "order"].forEach(f => q.append("mask.fieldPaths", f));
    if (token) q.set("pageToken", token);
    const d = await get(`${ROOT}/categories?${q}`);
    (d.documents || []).forEach(doc => {
      const f = doc.fields || {};
      const o = f.order || {};
      out.push({
        id: doc.name.split("/").pop(),
        name: (f.name && f.name.stringValue) || "",
        order: Number(o.integerValue ?? o.doubleValue ?? 0),
      });
    });
    token = d.nextPageToken;
  } while (token);
  return out;
}

// Counted from the questions subcollection rather than the doc's text-only
// copy, because that copy is capped and would under-report a large category.
async function countQuestions(id) {
  let n = 0, token = null;
  do {
    const q = new URLSearchParams({ key: KEY, pageSize: "300" });
    q.append("mask.fieldPaths", "idx");
    if (token) q.set("pageToken", token);
    const d = await get(`${ROOT}/categories/${encodeURIComponent(id)}/questions?${q}`);
    n += (d.documents || []).length;
    token = d.nextPageToken;
  } while (token);
  return n;
}

const cats = await categories();
if (!cats.length) { console.error("No categories came back — refusing to write an empty data.js."); process.exit(1); }

for (const c of cats) {
  c.n = await countQuestions(c.id);
  c.cover = BUNDLED[c.id] || `cat/${c.id}-t.webp`;
  c.big   = BUNDLED[c.id] || `cat/${c.id}-l.webp`;
  if (OMANI.has(c.id)) c.om = 1;
  if (NEW.has(c.id)) c.nu = 1;
  process.stderr.write(`  ${c.name.padEnd(26)} ${c.n}\n`);
}

// Omani first — they're the reason to choose عِزبة over any other trivia app —
// then the rest by name, so the order is stable between runs.
cats.sort((a, b) => (a.om ? 0 : 1) - (b.om ? 0 : 1) || a.name.localeCompare(b.name, "ar"));

/* ── a few real questions, for the "try one" taster ──────────────────────
   ⚠️ Pulled from the live catalogue, never hand-typed. A taster that drifts
   from the game is worse than none: it promises content that is not there.
   Rules for what qualifies, and each one is load-bearing:
     * four real choices — the answer plus three authored distractors, so the
       taster plays exactly like the game's «أربعة خيارات» helper;
     * text only. Question media lives in the /questions subcollection and
       these come from the parent doc, so anything picture-based would show up
       here as a question with its subject missing;
     * one per category, and never from a category whose question IS an image
       or a QR — the same categories the screenshot capture avoids. */
const SAMPLE_SKIP = new Set([
  "charades", "charadesArabic", "charadesMovies", "charadesSeries",   // word guess → QR
  "pub-1783189569201-313", "pub-1783425758108-102",                   // word guess, reactions
  "pub-1783170084646-5700", "pub-1784043823835-6035",                 // photo/video prompts
  "emojis", "pub-1784240484235-8039", "sayAnother",                   // the prompt is the media
]);
/* One taster is shown per DAY, so this list is also the length of the cycle
   before a returning visitor sees a repeat. Ordered so consecutive days are
   from different corners of the catalogue — an Omani one, then general, then
   pop culture — rather than three history questions in a row. Categories whose
   question is a picture or a QR are skipped by the filter below, so listing one
   costs nothing but buys nothing either. */
const SAMPLE_WANT = [
  "pub-1783453062866-1028", "history", "pub-1784486305049-7855", "geo",
  "pub-1785323313470-2876", "science", "khareef", "culture",
  "pub-1784571861226-6942", "cars", "omaniFootball", "seerah",
  "footballMix", "whoAmI", "foreignSeries", "pub-1783510423551-6465",
];
const samples = [];
for (const id of SAMPLE_WANT) {
  if (SAMPLE_SKIP.has(id)) continue;
  const cat = cats.find(c => c.id === id);
  if (!cat) continue;
  /* ⚠️ Fetched one at a time, with a mask. `categories()` above masks the
     whole listing down to name+order on purpose — the questions array carries
     every category's full text and the listing would balloon. */
  const q = new URLSearchParams({ key: KEY });
  q.append("mask.fieldPaths", "questions");
  let doc;
  // ⚠️ Say so. A silent `continue` here quietly shortens the daily rotation and
  // looks identical to a category that simply had no usable question.
  try { doc = await get(`${ROOT}/categories/${encodeURIComponent(id)}?${q}`); }
  catch (e) { process.stderr.write(`  taster: ${id} doc failed — ${e.message}\n`); continue; }
  /* ⚠️ Which questions have a PICTURE cannot be read from the parent doc.
     Question media lives in the `/questions` subcollection — the parent's copy
     is text-only by design (the media-lite boot path) — so `f.image` here is
     empty even for a question whose whole subject is a photograph. Without
     this, «ما اسم هذه الشخصية؟» qualified as a fine text question and would
     have been served to a visitor with nothing to look at. */
  const withMedia = new Set();
  try {
    const mq = new URLSearchParams({ key: KEY, pageSize: "300" });
    // ⚠️ `image` only, NOT `answerImage`. The taster shows the question and its
    // four choices and never reveals the answer's picture, so a question with an
    // answer photo reads perfectly as text. Excluding those took the rotation
    // from fifteen days to seven and dropped تاريخ, علوم and سيارات entirely.
    ["idx", "image"].forEach(f => mq.append("mask.fieldPaths", f));
    let tok = null;
    do {
      if (tok) mq.set("pageToken", tok);
      const md = await get(`${ROOT}/categories/${encodeURIComponent(id)}/questions?${mq}`);
      for (const d of (md.documents || [])) {
        const f = d.fields || {};
        if ((f.image || {}).stringValue)
          withMedia.add(Number((f.idx || {}).integerValue ?? -1));
      }
      tok = md.nextPageToken;
    } while (tok);
  } catch (e) {
    // Falling through means media cannot be detected for this category, and a
    // picture question would be served as a bare sentence — skip it instead.
    process.stderr.write(`  taster: ${id} media read failed — ${e.message}\n`);
    continue;
  }

  const list = (((doc.fields || {}).questions || {}).arrayValue || {}).values || [];
  for (let n = 0; n < list.length; n++) {
    const v = list[n];
    if (withMedia.has(n)) continue;
    const f = (v.mapValue || {}).fields || {};
    const text = (f.q || {}).stringValue || "", answer = (f.a || {}).stringValue || "";
    const wrong = (((f.distractors || {}).arrayValue || {}).values || [])
      .map(x => x.stringValue).filter(Boolean);
    if (!text || !answer || wrong.length < 3) continue;
    if ((f.image || {}).stringValue) continue;
    if (text.length > 90) continue;                    // has to fit a card
    samples.push({ cat: cat.name, q: text, a: answer,
                   choices: [answer, ...wrong.slice(0, 3)],
                   points: Number((f.points || {}).integerValue || 0) });
    break;                                             // one per category
  }
  if (!samples.some(x => x.cat === cat.name))
    process.stderr.write(`  taster: ${cat.name} had no text-only question with 3 distractors\n`);
}
process.stderr.write(`\n  ${samples.length} taster questions\n`);

const totals = {
  categories: cats.length,
  questions: cats.reduce((s, c) => s + c.n, 0),
  omani: cats.filter(c => c.om).length,
};

const { writeFileSync } = await import("fs");
const { fileURLToPath } = await import("url");
const { dirname, join } = await import("path");
const here = dirname(fileURLToPath(import.meta.url));

writeFileSync(join(here, "data.js"),
  "/* GENERATED by preview/sync.mjs — do not edit by hand.\n"
  + `   ${totals.categories} categories · ${totals.questions} questions, straight from Firestore. */\n`
  + "window.IZZBAH_DATA = " + JSON.stringify({ totals, cats, samples }, null, 1) + ";\n", "utf8");

console.log(`\nwrote preview/data.js — ${totals.categories} categories, ${totals.questions} questions, ${totals.omani} Omani`);
const thin = cats.filter(c => c.n < 25);
if (thin.length) console.log("thin (under 25 questions):", thin.map(c => `${c.name} ${c.n}`).join(", "));
