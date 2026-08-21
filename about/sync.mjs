// Regenerates about/data.js from the live game.
//
//   node about/sync.mjs
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
        /* ⚠️ `createTime`/`updateTime` are Firestore DOCUMENT METADATA, not
           fields — they come back whatever the field mask says, so the
           freshness line below costs no extra read and cannot be starved by
           someone tightening the mask. They are dropped from the emitted
           entry once the two dates have been derived. */
        created: doc.createTime || "",
        updated: doc.updateTime || "",
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
/* The taster shows FOUR at a time and the set turns over every fortnight, so
   this list is read four at a time and its LENGTH is how long before a set
   comes round again. Order matters twice over: the first four are the set a
   visitor meets today, and consecutive entries should come from different
   corners of the catalogue so no set is three history questions in a row.
   ⚠️ The opening four are «سيارات، كرة عمانية، تاريخ، جغرافيا» by the owner's
   choice — he asked for the first slot to be a CAR question and the third a
   HISTORY one after seeing what was there before. Reordering this list moves
   what people see on the front page; it is not a neutral tidy-up.
   Categories whose question is a picture or a QR are dropped by the filters
   below, so listing one costs nothing but buys nothing either — `khareef` and
   `pub-1784571861226-6942` are both in that state today and are kept only so
   the list does not shrink the day they gain a text question. */
const SAMPLE_WANT = [
  "cars", "omaniFootball", "history", "geo",
  "pub-1785323313470-2876", "science", "culture", "seerah",
  "footballMix", "whoAmI", "foreignSeries", "pub-1783510423551-6465",
  "foreignMoviesOnly", "pub-1783170059396-601", "cafesRestaurants", "arabicTerms",
  "pub-1784798503561-5271", "pub-1783170306877-1440", "pub-1783189666048-7547",
  "pub-1783189684453-7350", "khareef", "pub-1784571861226-6942",
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
    /* ⚠️ NEAREST-WINS QUESTIONS ARE NOT MULTIPLE CHOICE. «الأقرب يفوز» marks
       its tolerance in the question text — «متى بدأ حكم السيد سعيد بن
       تيمور؟(-سنتين+)» — and the game plays those by asking each team for a
       number and scoring the closest guess. Rendered as four buttons the marker
       is meaningless punctuation and the distractors are nonsense: that one
       shipped on the front page offering 1932, 1972, 1624 and 2008. The
       parenthetical is the tell, so it is the filter. */
    if (/\([-−][^()]*\+\)/.test(text)) continue;
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

/* ── «آخر تحديث» ──────────────────────────────────────────────────────
   A visitor deciding whether to install a game wants to know it is alive. The
   site had no signal at all for that — no dates, no changelog — so a catalogue
   published last week and one abandoned in 2024 read identically.
   ⚠️ Formatted HERE, not in the page. `Intl.DateTimeFormat('ar', …)` output is
   engine-dependent (month names and digit shapes both), which makes it a poor
   thing to assert on and a poor thing to ship. The month list is written out,
   matching the game's own legal pages («آخر تحديث: يوليو ٢٠٢٦»).
   ⚠️ `updateTime` moves on ANY publish, including a single question edit —
   which is exactly what "last updated" should mean. `createTime` is when the
   category doc first appeared, so it is the honest answer to "what is new". */
const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
                   "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const arDigits = s => String(s).replace(/\d/g, d => "٠١٢٣٤٥٦٧٨٩"[d]);
const arDate = iso => {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return `${arDigits(d.getUTCDate())} ${AR_MONTHS[d.getUTCMonth()]} ${arDigits(d.getUTCFullYear())}`;
};
const latest = key => cats.map(c => c[key]).filter(Boolean).sort().pop() || "";
const newestCat = cats.filter(c => c.created).sort((a, b) => (a.created < b.created ? 1 : -1))[0];
const fresh = {
  updatedISO: latest("updated"),
  updated: arDate(latest("updated")),
  newest: newestCat ? newestCat.name : "",
  newestISO: newestCat ? newestCat.created : "",
};
// The two timestamps have done their job; they are not part of the page's data.
cats.forEach(c => { delete c.created; delete c.updated; });

const { writeFileSync } = await import("fs");
const { fileURLToPath } = await import("url");
const { dirname, join } = await import("path");
const here = dirname(fileURLToPath(import.meta.url));

writeFileSync(join(here, "data.js"),
  "/* GENERATED by about/sync.mjs — do not edit by hand.\n"
  + `   ${totals.categories} categories · ${totals.questions} questions, straight from Firestore. */\n`
  + "window.IZZBAH_DATA = " + JSON.stringify({ totals, fresh, cats, samples }, null, 1) + ";\n", "utf8");

console.log(`\nwrote about/data.js — ${totals.categories} categories, ${totals.questions} questions, ${totals.omani} Omani`);
console.log(`  last updated ${fresh.updated || "?"} · newest category «${fresh.newest || "?"}»`);
const thin = cats.filter(c => c.n < 25);
if (thin.length) console.log("thin (under 25 questions):", thin.map(c => `${c.name} ${c.n}`).join(", "));
