// One page per category, generated — `preview/c/<id>.html`.
//
//     node preview/cats.mjs            # writes preview/c/<id>.html for every category
//     node preview/cats.mjs --check    # exits 1 if any page is out of date
//
// WHY THESE EXIST
// ---------------
// Someone searching «أسئلة عن خريف ظفار» or «لعبة أسئلة عمانية» has nothing of
// ours to find: the whole site is one page, and one page ranks for one thing.
// These are forty, each about a single category, each carrying real questions
// from that category — which is the only organic acquisition channel this
// product has that does not cost money.
//
// ⚠️ NOTHING HERE IS HAND-WRITTEN, and that is what makes forty pages
// maintainable. The facts come from Firestore through `gamedata.mjs` (the same
// reader the screenshots and the hero clip use), and the one-line description
// and tag come from the `COPY` map in `preview/index.html` — parsed out of it
// rather than copied, so the site and these pages cannot say different things
// about the same category.
//
// ⚠️ THE SAMPLE QUESTIONS ARE REAL, AND THAT IS THE POINT. A page that only
// describes a category is a page with nothing on it; the questions are the
// content a reader came for and the reason the page is worth indexing. They are
// filtered the same way the taster's are — text-only (question media lives in
// the `/questions` subcollection, so a picture question would render here as a
// riddle with its subject missing) and never «الأقرب يفوز», whose tolerance
// marker is meaningless outside the game.
//
// ⚠️ ROBOTS IS COPIED FROM `preview/index.html`, NOT SET HERE. The site is
// noindex today, and forty indexable pages linking to a noindex home would be
// incoherent. Lifting it is one edit in index.html plus a re-run of this — and
// until it is lifted these pages do nothing for search, which is worth knowing
// before reading their absence as failure.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { catalogue } from "./gamedata.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(HERE, "c");
const SITE = "https://izzbah.com/preview";
const check = process.argv.includes("--check");

const page = readFileSync(join(HERE, "index.html"), "utf8");

/* The editorial half — tag and one-line description — lives in ONE place, the
   `COPY` map the landing page renders from. Parsed rather than duplicated. */
const copyBlock = /const COPY = (\{[\s\S]*?\n {2}\});/.exec(page);
if (!copyBlock) throw new Error("cats.mjs: could not find the COPY map in preview/index.html");
const COPY = JSON.parse(copyBlock[1].replace(/,(\s*\})/g, "$1"));

const robots = (/<meta name="robots" content="([^"]*)">/.exec(page) || [])[1] || "";
if (!robots) throw new Error("cats.mjs: no robots meta in preview/index.html to copy");

/* ⚠️ THE STORE CONSTANTS COME FROM THE SITE TOO. `preview/index.html` says
   there is "deliberately nowhere else to change" the routing into the game —
   and forty static pages each carrying their own play button is exactly the
   second place that promise dies. They are parsed out of it and inlined, so the
   day a store URL is filled in these forty follow without being touched.
   The button is a REAL link either way; the script only upgrades it, so a
   reader with no JavaScript still reaches the game. */
const storeBlock = /const STORE = \{([\s\S]*?)\};/.exec(page);
if (!storeBlock) throw new Error("cats.mjs: could not find the STORE constants in preview/index.html");
const STORE = {
  ios: (/ios:\s*"([^"]*)"/.exec(storeBlock[1]) || [])[1] || "",
  android: (/android:\s*"([^"]*)"/.exec(storeBlock[1]) || [])[1] || "",
};

const DATA = (() => {
  const s = readFileSync(join(HERE, "data.js"), "utf8");
  return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
})();

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ar = n => String(n).replace(/\d/g, d => "٠١٢٣٤٥٦٧٨٩"[d]);

/* The same `#g=` payload the in-game share button builds, so a reader lands on
   the picker with this category already chosen. */
const playLink = id => "../../#g=" + Buffer.from(JSON.stringify({ c: [id] }), "utf8")
  .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/* Up to three questions worth showing. Same filters as the taster: no picture
   questions (their subject is not in the parent doc), no nearest-wins markers,
   and short enough to read at a glance. */
/* WebP header read straight off the file — the alternative is hard-coding
   1080x1350, which is wrong for every wide cover and is what made the first
   version stretch them. */
function coverSize(f) {
  const b = readFileSync(f);
  if (b.toString("ascii", 12, 16) === "VP8X")
    return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  if (b.toString("ascii", 12, 16) === "VP8L") {
    const n = b.readUInt32LE(21);
    return { w: 1 + (n & 0x3fff), h: 1 + ((n >> 14) & 0x3fff) };
  }
  if (b.toString("ascii", 12, 15) === "VP8")
    return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  throw new Error("cats.mjs: cannot read the size of " + f);
}

const SAMPLES = 3;
function questionsFor(cat) {
  const ok = [];
  for (const q of cat.questions || []) {
    if (!q || !q.q || !q.a) continue;
    const text = String(q.q).trim(), answer = String(q.a).trim();
    if (!text || !answer) continue;
    if (q.image) continue;
    if (text.length > 90) continue;
    if (/\([-−][^()]*\+\)/.test(text)) continue;      // «الأقرب يفوز» tolerance
    if (/\n/.test(text)) continue;                    // multi-line clue lists
    ok.push({ q: text, a: answer, points: Number(q.points) || 0 });
  }
  /* ⚠️ SPREAD THEM, do not take the first three. Questions are stored roughly
     in tier order and authored in runs, so the first three of سيارات were all
     100-pointers reading «ما الشركة المصنعة لسيارة …؟» — three lines that look
     like one line repeated, which is thin for a reader and thinner for a page
     whose whole job is to be worth indexing. One per point tier, and never two
     that open with the same three words. */
  const opening = t => t.split(/\s+/).slice(0, 3).join(" ");
  const tiers = [...new Set(ok.map(q => q.points))].sort((a, b) => a - b);
  const out = [], seen = new Set();
  for (const tier of tiers) {
    const pick = ok.find(q => q.points === tier && !seen.has(opening(q.q)));
    if (!pick) continue;
    seen.add(opening(pick.q));
    out.push(pick);
    if (out.length >= SAMPLES) break;
  }
  // A category with only one tier still deserves its three, just not three
  // rewordings of the same one.
  for (const q of ok) {
    if (out.length >= SAMPLES) break;
    if (out.includes(q) || seen.has(opening(q.q))) continue;
    seen.add(opening(q.q));
    out.push(q);
  }
  return out.sort((a, b) => a.points - b.points);
}

function render(cat, meta, qs, siblings) {
  const [tag, desc] = COPY[cat.id] || ["فئة", "فئة من فئات عِزبة."];
  const title = `${cat.name} — أسئلة من لعبة عِزبة`;
  const blurb = `${desc} ${ar(meta.n)} سؤال جاهز في فئة «${cat.name}» داخل عِزبة — لعبة الأسئلة الجماعية.`;
  const cover = "../" + meta.big;
  // Real pixel dimensions, so the box is reserved correctly before it loads.
  const dim = coverSize(join(HERE, meta.big));
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(blurb)}">
<meta name="robots" content="${esc(robots)}">
<link rel="canonical" href="${SITE}/c/${esc(cat.id)}.html">
<link rel="icon" href="../../assets/brand/favicon.ico" sizes="any">
<meta name="theme-color" content="#16060a">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(blurb)}">
<meta property="og:url" content="${SITE}/c/${esc(cat.id)}.html">
<script type="application/ld+json">
${JSON.stringify({
  "@context": "https://schema.org", "@type": "CreativeWork",
  name: cat.name, inLanguage: "ar", description: desc,
  isPartOf: { "@type": "Game", name: "عِزبة", url: "https://izzbah.com/" },
  url: `${SITE}/c/${cat.id}.html`,
}, null, 1)}
</script>
<style>
/* The full faces, not the landing page's subsets — those are cut to the exact
   glyphs that page uses, and these carry question text nobody subsetted for.
   Same reasoning as legal.html, and the same fix. */
@font-face{font-family:'Cairo';font-style:normal;font-weight:400 900;font-display:swap;
  src:url('../../assets/fonts/Cairo-var-ar.woff2') format('woff2');
  unicode-range:U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0898-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC}
@font-face{font-family:'Cairo';font-style:normal;font-weight:400 900;font-display:swap;
  src:url('../../assets/fonts/Cairo-var-lat.woff2') format('woff2');
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'Aref Ruqaa';font-style:normal;font-weight:700;font-display:swap;
  src:url('../../assets/fonts/ArefRuqaa-700-ar.woff2') format('woff2');
  unicode-range:U+0600-06FF,U+0750-077F,U+FB50-FDFF,U+FE70-FEFC}
:root{--ink:#16060a;--gold:#e7c373;--gold-hi:#f6d27a;--cream:#f7ecd6;--muted:#c6a98c;
  --rule:rgba(231,195,115,.16);--body:'Cairo',system-ui,'Segoe UI',Tahoma,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--ink);color:var(--cream);font:400 16px/1.8 var(--body);
  -webkit-font-smoothing:antialiased;
  background-image:radial-gradient(120% 70% at 50% -10%,#3a0f18 0%,var(--ink) 62%)}
.wrap{width:min(860px,92vw);margin-inline:auto}
header{position:sticky;top:0;z-index:5;backdrop-filter:blur(14px);
  background:rgba(22,6,10,.86);border-bottom:1px solid var(--rule)}
header .wrap{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:64px}
.brand{display:inline-flex;align-items:center;gap:10px;text-decoration:none;color:var(--gold);
  font:700 21px/1 'Aref Ruqaa',var(--body)}
.brand img{width:30px;height:30px;border-radius:8px}
.back{display:inline-flex;align-items:center;min-height:44px;padding-inline:6px;color:var(--muted);
  text-decoration:none;font:700 14px var(--body)}
.back:hover{color:var(--gold)}
.top{display:grid;grid-template-columns:minmax(0,240px) minmax(0,1fr);gap:26px;align-items:start;
  padding:40px 0 8px}
@media(max-width:640px){.top{grid-template-columns:minmax(0,1fr)}}
/* height:auto, and NO forced aspect ratio. Two reasons, both learned the hard
   way. The img carries width/height attributes so its box is reserved before it
   loads, and the height attribute is a presentational hint that BEATS the
   aspect-ratio property — the first version of this page rendered every cover
   1350px tall down the side of the screen. And the shape is the file own on
   purpose: covers.py builds 1080x1350 for the ones the frame crops, and the
   source own aspect for the wide ones the site shows whole, so pinning 4/5 here
   would hard-crop precisely the covers that were built not to be cropped. */
.art{width:100%;height:auto;border-radius:20px;border:1px solid var(--rule);display:block;
  background:rgba(255,255,255,.03)}
.eyebrow{font:800 12.5px var(--body);color:var(--gold);letter-spacing:.08em}
h1{font:900 clamp(28px,5vw,42px)/1.2 var(--body);margin:8px 0 10px}
.lede{color:var(--muted);font-size:clamp(15px,2vw,17.5px);margin:0 0 18px}
.facts{display:flex;flex-wrap:wrap;gap:9px;margin-bottom:20px}
.fact{font:800 13px var(--body);padding:7px 14px;border-radius:999px;border:1px solid var(--rule);
  background:rgba(255,255,255,.04);color:var(--cream)}
.fact b{color:var(--gold)}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:12px 26px;
  border-radius:999px;background:linear-gradient(180deg,var(--gold-hi),var(--gold));color:#2a1206;
  font:800 16px var(--body);text-decoration:none;border:0}
.btn:hover{filter:brightness(1.06)}
h2{font:900 clamp(20px,3vw,26px)/1.3 var(--body);margin:36px 0 4px;color:var(--gold-hi)}
.qs{display:grid;gap:12px;margin:16px 0 0;padding:0;list-style:none}
.q{border:1px solid var(--rule);border-radius:16px;padding:16px 18px;background:rgba(255,255,255,.035)}
.q .pts{font:800 12px var(--body);color:var(--gold);display:block;margin-bottom:5px}
.q p{margin:0;font:700 16.5px/1.6 var(--body)}
.q .a{margin-top:8px;color:var(--muted);font-weight:600;font-size:14.5px}
.q .a b{color:var(--cream)}
.more{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 0;padding:0;list-style:none}
.more a{display:inline-flex;align-items:center;min-height:38px;padding:6px 13px;border-radius:999px;
  border:1px solid var(--rule);color:var(--muted);text-decoration:none;font:700 13px var(--body)}
.more a:hover{color:var(--gold);border-color:var(--gold)}
footer{border-top:1px solid var(--rule);margin-top:44px;padding:26px 0 44px;color:var(--muted);
  font-size:13.5px}
footer a{color:var(--muted);text-decoration:none}
footer a:hover{color:var(--gold)}
.foot-row{display:flex;flex-wrap:wrap;gap:20px;font-weight:700;margin-bottom:12px}
.foot-row a{display:inline-flex;align-items:center;min-height:44px;margin-block:-11px}
</style>
</head>
<body>

<header>
  <div class="wrap">
    <a class="brand" href="../"><img src="../../assets/brand/png/app-icon/icon-192.png" alt=""> عِزبة</a>
    <a class="back" href="../#all">كل الفئات</a>
  </div>
</header>

<main class="wrap">
  <div class="top">
    <img class="art" src="${esc(cover)}" alt="${esc(cat.name)}" width="${dim.w}" height="${dim.h}" decoding="async">
    <div>
      <div class="eyebrow">${esc(tag)}</div>
      <h1>${esc(cat.name)}</h1>
      <p class="lede">${esc(desc)}</p>
      <div class="facts">
        <span class="fact"><b>${ar(meta.n)}</b> سؤال</span>
        ${meta.om ? '<span class="fact">عُماني ١٠٠٪</span>' : ""}
        <span class="fact">من ١٠٠ إلى ٥٠٠ نقطة</span>
      </div>
      <a class="btn" id="play" href="${esc(playLink(cat.id))}">العب هذي الفئة — مجاناً</a>
    </div>
  </div>

${qs.length ? `  <h2>أسئلة من الفئة</h2>
  <ul class="qs">
${qs.map(q => `    <li class="q">
      ${q.points ? `<span class="pts">${ar(q.points)} نقطة</span>` : ""}
      <p>${esc(q.q)}</p>
      <div class="a">الإجابة: <b>${esc(q.a)}</b></div>
    </li>`).join("\n")}
  </ul>` : ""}

  <h2>فئات ثانية</h2>
  <ul class="more">
${siblings.map(s => `    <li><a href="${esc(s.id)}.html">${esc(s.name)}</a></li>`).join("\n")}
    <li><a href="../#all">كل الفئات</a></li>
  </ul>
</main>

<footer class="wrap">
  <div class="foot-row">
    <a href="../">الموقع</a>
    <a href="../../">اللعبة</a>
    <a href="../legal.html#privacy">سياسة الخصوصية</a>
  </div>
  <div>© ٢٠٢٦ عِزبة — جميع الحقوق محفوظة.</div>
</footer>

<script>
/* The same routing rule as the site, from the same constants — see cats.mjs.
   iPadOS reports itself as a Mac, hence the touch probe; a desktop is never
   sent to a phone store. Wrapped, because a broken upgrade must leave the
   plain link that is already in the markup. */
(function () {
  try {
    var S = ${JSON.stringify(STORE)};
    var ua = navigator.userAgent || "";
    var p = /android/i.test(ua) ? "android"
          : /iphone|ipad|ipod/i.test(ua) ? "ios"
          : (/Mac/.test(navigator.platform || "") && navigator.maxTouchPoints > 1) ? "ios" : "other";
    var url = S[p] || "";
    if (!url) return;
    var a = document.getElementById("play");
    if (!a) return;
    a.href = url; a.target = "_blank"; a.rel = "noopener";
  } catch (e) {}
})();
</script>
</body>
</html>
`;
}

/* ── build ────────────────────────────────────────────────────── */
const cats = await catalogue();
const byId = Object.fromEntries(DATA.cats.map(c => [c.id, c]));
const usable = cats.filter(c => byId[c.id] && byId[c.id].n > 0)
  .sort((a, b) => (byId[a.id].order || 0) - (byId[b.id].order || 0));
if (usable.length < 20) throw new Error(`only ${usable.length} categories to write — refusing`);

mkdirSync(OUT, { recursive: true });
const written = new Map();
for (let i = 0; i < usable.length; i++) {
  const cat = usable[i];
  // Six neighbours, wrapping — every page links onward, so a crawler (and a
  // reader) can walk the whole set from any one of them.
  const siblings = Array.from({ length: 6 }, (_, k) => usable[(i + k + 1) % usable.length])
    .filter(s => s.id !== cat.id)
    .map(s => ({ id: s.id, name: s.name }));
  written.set(cat.id, render(cat, byId[cat.id], questionsFor(cat), siblings));
}

let stale = [];
for (const [id, html] of written) {
  const f = join(OUT, id + ".html");
  const now = existsSync(f) ? readFileSync(f, "utf8") : "";
  if (now !== html) stale.push(id);
  if (!check) writeFileSync(f, html);
}
// Anything left behind from a category that has since been deleted or emptied.
const orphans = existsSync(OUT)
  ? readdirSync(OUT).filter(f => f.endsWith(".html") && !written.has(f.slice(0, -5))) : [];
if (!check) orphans.forEach(f => rmSync(join(OUT, f)));

if (check) {
  if (stale.length || orphans.length) {
    console.error(`preview/c/ is out of date — ${stale.length} page(s) differ`
      + (orphans.length ? `, ${orphans.length} orphaned` : "") + "\nRun:  node preview/cats.mjs");
    process.exit(1);
  }
  console.log(`preview/c/ is in step — ${written.size} pages`);
} else {
  const withQs = [...written.values()].filter(h => h.includes("أسئلة من الفئة")).length;
  console.log(`wrote ${written.size} category pages to preview/c/`
    + ` (${withQs} carry sample questions${orphans.length ? `, ${orphans.length} orphan removed` : ""})`);
  console.log(`robots: "${robots}" — copied from preview/index.html`);
}
