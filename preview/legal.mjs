// Builds `preview/legal.html` FROM the game's own privacy policy and terms.
//
// Run it after any edit to the legal text in `index.html`:
//
//     node preview/legal.mjs            # writes preview/legal.html
//     node preview/legal.mjs --check    # exits 1 if the file is out of date
//
// ⚠️ NOTHING HERE IS HAND-WRITTEN, and that is the whole point. The site now
// publishes a privacy policy and terms of use at a real URL — which is what an
// app store asks for, and what the footer links used to only promise («تفتح
// داخل اللعبة من الإعدادات»). Two copies of a legal document that are edited
// separately WILL disagree, and the day they do, one of them is a false
// statement about what the product does with a player's data. So the game's
// copy is the only copy: this script lifts the three `.legal-doc` blocks out of
// `index.html` verbatim and wraps them in the landing page's chrome.
//
// ⚠️ THE GAME SHOWS ONE OF TWO PAYMENT PARAGRAPHS depending on the build —
// `.legal-web-only` for the web/PWA (we take the payment, we handle refunds)
// and `.legal-store-only` for a store build (the store takes it, the store
// refunds it). The site is the front door to BOTH, so it must show both, each
// under a heading saying which one applies. Dropping either would leave some
// real customer reading terms that do not describe their purchase.
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(HERE, "legal.html");
const check = process.argv.includes("--check");

const game = readFileSync(join(ROOT, "index.html"), "utf8");

/* ── lifting the blocks ────────────────────────────────────────────
   By `data-legal-doc`, not by position: the tabs are reordered easily and
   silently, and a policy served under the wrong heading is worse than none. */
function lift(key) {
  const open = new RegExp(`<div class="legal-doc[^"]*" data-legal-doc="${key}">`);
  const m = open.exec(game);
  if (!m) throw new Error(`legal.mjs: no <div data-legal-doc="${key}"> in index.html`);
  // Walk the divs so a nested one cannot end the block early.
  let i = m.index + m[0].length, depth = 1, out = "";
  const tag = /<\/?div\b[^>]*>/g;
  tag.lastIndex = i;
  let t;
  while ((t = tag.exec(game))) {
    depth += t[0].startsWith("</") ? -1 : 1;
    if (depth === 0) { out = game.slice(i, t.index); break; }
  }
  if (!out) throw new Error(`legal.mjs: <div data-legal-doc="${key}"> is never closed`);
  return out;
}

/* Comments in the source are notes to the next developer — one of them is a
   paragraph explaining why the store terms exist at all. They are not for
   readers of the policy. */
const strip = s => s.replace(/<!--[\s\S]*?-->/g, "");

/* The two build-specific paragraphs, labelled. ⚠️ The `<p>` is REPLACED whole
   rather than having a heading inserted before it, so a future third variant
   throws at the assertion below instead of appearing unlabelled. */
function labelBuilds(html) {
  const one = (cls, heading) => {
    const re = new RegExp(`<p class="${cls}">([\\s\\S]*?)</p>`);
    const m = re.exec(html);
    if (!m) throw new Error(`legal.mjs: no <p class="${cls}"> in the terms — has the game's payment copy moved?`);
    html = html.replace(re, `<h4>${heading}</h4>\n<p>${m[1]}</p>`);
  };
  one("legal-web-only", "إذا لعبت عبر الموقع");
  one("legal-store-only", "إذا اشتريت من داخل التطبيق عبر المتجر");
  /* `legal-store-extra` is store-build text that already carries its OWN <h5>,
     so it needs no inserted label — only the class stripped, because the site
     shows every build's terms. Kept as a separate class from the `-only` pair
     on purpose: those two are matched by FIRST occurrence, and a third
     paragraph sharing one of their names would silently be labelled as the
     refund paragraph while the real one kept its class and tripped the
     assertion somewhere far away. */
  const before = html;
  html = html.replace(/ class="legal-store-extra"/g, "");
  if (html === before)
    throw new Error("legal.mjs: no legal-store-extra block — have the App Store terms been dropped?");
  return html;
}

/* ── text that belongs to the SITE and not to the game ────────────────────
   ⚠️ This is the ONE exception to "the game's copy is the only copy", and it is
   an exception because it is not a copy of anything: izzbah.com runs its own
   Google Analytics property, the GAME does not, and a sentence about the
   website's measurement inside the game's privacy policy would be describing
   something the player is not using. So the game's document talks about the
   game, this page adds its own line, and neither duplicates the other.
   ⚠️ Anything added here is legal text with NO in-game counterpart, so it can
   never be checked against the game. Keep it to facts about THIS PAGE. */
const SITE_ANALYTICS = '<p>ويستخدم هذا الموقع (izzbah.com) خدمة Google Analytics لقياس زياراته بشكل مُجمَّع، مع إخفاء عنوان IP وتعطيل ميزات الإعلانات. لا تُستخدم هذه الإحصاءات لتحديد هويتك الشخصية.</p>';

function addSiteOnly(html) {
  // Anchored to the game's analytics paragraph so the two sit together and read
  // as one section, rather than the site's line arriving out of context.
  const re = /(<p>نستخدم Google Analytics for Firebase[\s\S]*?<\/p>)/;
  if (!re.test(html))
    throw new Error("legal.mjs: the game's analytics paragraph moved — the site's own line has nowhere to attach");
  return html.replace(re, `$1\n${SITE_ANALYTICS}`);
}

const DOCS = [
  ["privacy", "سياسة الخصوصية"],
  ["terms", "شروط الاستخدام"],
  ["notices", "إشعارات وحقوق"],
];

const bodies = DOCS.map(([key]) => {
  let html = strip(lift(key));
  if (key === "terms") html = labelBuilds(html);
  if (key === "privacy") html = addSiteOnly(html);
  // The game's own `<h4>` is the document title and the page prints its own,
  // so the duplicate goes. Everything else is kept exactly as authored.
  html = html.replace(/<h4>[\s\S]*?<\/h4>\s*/, "");
  /* ⚠️ The game's documents use <h5> for their section headings, under an <h4>
     title this page drops in favour of its own <h2>. Left alone that is h2 → h5
     — two levels skipped — which is the one structural complaint an audit of
     this page raises, and it is what a screen reader navigates by. Remapped to
     <h3>, one level under the document's own heading. */
  html = html.replace(/<(\/?)h5>/g, "<$1h3>");
  // ⚠️ Guard against lifting an empty or half-matched block. A silently blank
  // policy page is the failure this whole script exists to make impossible.
  if (html.replace(/<[^>]+>/g, "").trim().length < 400)
    throw new Error(`legal.mjs: the "${key}" document came out suspiciously short — check the markup in index.html`);
  if (/legal-[a-z-]+-(only|extra)/.test(html))
    throw new Error(`legal.mjs: a build-specific paragraph was left unlabelled in "${key}"`);
  // Re-indent to this page's depth. The lifted markup carries the game's own
  // indentation, and the two inserted `<h6>`s carry none, so without this the
  // generated file is visibly ragged — which invites someone to tidy it by hand
  // and lose the next regeneration.
  return html.split("\n").map(l => l.trim()).filter(Boolean).map(l => "    " + l).join("\n");
});

const page = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>الشروط والسياسات — عِزبة</title>
<meta name="description" content="سياسة الخصوصية وشروط الاستخدام والإشعارات والحقوق للعبة عِزبة.">
<link rel="icon" href="../assets/brand/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="../assets/brand/png/app-icon/maskable-180.png">
<!-- Matches the landing page: the whole of /preview/ is still a draft.
     ⚠️ An app store listing needs a publicly REACHABLE privacy-policy URL, so
     this meta has to come off with the rest of the draft's when the site goes
     live — a noindex page is reachable, but leaving it noindex once this is the
     real policy URL is an easy thing to forget. -->
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#16060a">
<meta property="og:type" content="website">
<meta property="og:site_name" content="عِزبة">
<meta property="og:locale" content="ar_AR">
<meta property="og:title" content="الشروط والسياسات — عِزبة">
<meta property="og:description" content="سياسة الخصوصية وشروط الاستخدام والإشعارات والحقوق للعبة عِزبة.">
<meta property="og:url" content="https://izzbah.com/preview/legal.html">
<style>
/* ⚠️ The FULL faces from the game (assets/fonts/), not the landing page's
   subsets in preview/fonts/. Those are cut down to the 59 Arabic codepoints
   that page happens to use, and the legal text needs four more (ٌ ٍ َ and ←) —
   which would render as .notdef boxes in the middle of a privacy policy. This
   page is not on anyone's boot path, so the extra ~30 KB is free, and a
   document assembled from someone else's text must never depend on a subset
   that was measured from different words. */
@font-face{font-family:'Cairo';font-style:normal;font-weight:400 900;font-display:swap;
  src:url('../assets/fonts/Cairo-var-ar.woff2') format('woff2');
  unicode-range:U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0898-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC}
@font-face{font-family:'Cairo';font-style:normal;font-weight:400 900;font-display:swap;
  src:url('../assets/fonts/Cairo-var-lat.woff2') format('woff2');
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'Aref Ruqaa';font-style:normal;font-weight:700;font-display:swap;
  src:url('../assets/fonts/ArefRuqaa-700-ar.woff2') format('woff2');
  unicode-range:U+0600-06FF,U+0750-077F,U+FB50-FDFF,U+FE70-FEFC}

:root{
  --ink:#16060a; --ink-2:#1e0a0f; --maroon-lo:#2c0a0f;
  --gold:#e7c373; --gold-hi:#f6d27a;
  --cream:#f7ecd6; --muted:#c6a98c;
  --rule:rgba(231,195,115,.16);
  --body:'Cairo',system-ui,'Segoe UI',Tahoma,sans-serif;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth; scroll-padding-top:88px}
body{margin:0; background:var(--ink); color:var(--cream); font:400 16px/1.85 var(--body);
  -webkit-font-smoothing:antialiased;
  background-image:radial-gradient(120% 70% at 50% -10%, #3a0f18 0%, var(--ink) 62%)}
.wrap{width:min(760px,92vw); margin-inline:auto}

header{position:sticky; top:0; z-index:10; backdrop-filter:blur(14px);
  background:rgba(22,6,10,.86); border-bottom:1px solid var(--rule)}
header .wrap{display:flex; align-items:center; justify-content:space-between; gap:14px; min-height:64px}
.brand{display:inline-flex; align-items:center; gap:10px; text-decoration:none; color:var(--gold);
  font:700 21px/1 'Aref Ruqaa',var(--body)}
.brand img{width:30px; height:30px; border-radius:8px}
.back{display:inline-flex; align-items:center; min-height:44px; padding-inline:6px;
  color:var(--muted); text-decoration:none; font:700 14px var(--body); transition:color .2s}
.back:hover,.back:focus-visible{color:var(--gold)}

h1{font:900 clamp(27px,4.6vw,40px)/1.25 var(--body); margin:44px 0 6px}
.updated{color:var(--muted); font-size:14px; margin:0 0 26px}

/* The three documents are one page with anchors rather than three files: they
   are read together, they cross-reference each other, and a single URL is one
   less thing to keep alive in a store listing. */
nav.docs{display:flex; flex-wrap:wrap; gap:10px; margin:0 0 40px}
nav.docs a{display:inline-flex; align-items:center; min-height:44px; padding:8px 17px;
  border:1px solid var(--rule); border-radius:999px; background:rgba(255,255,255,.04);
  color:var(--cream); text-decoration:none; font:800 14px var(--body);
  transition:border-color .2s,color .2s,background .2s}
nav.docs a:hover,nav.docs a:focus-visible{border-color:var(--gold); color:var(--gold); background:rgba(231,195,115,.07)}

section{padding-block:14px 40px; border-top:1px solid var(--rule); margin-top:34px}
section:first-of-type{border-top:0; margin-top:0}
h2{font:900 clamp(22px,3.2vw,30px)/1.3 var(--body); margin:26px 0 4px; color:var(--gold-hi)}
h5{font:800 17px/1.5 var(--body); margin:30px 0 6px; color:var(--cream)}
/* The sub-heading this build adds around the two payment paragraphs — an <h4>,
   one level under the lifted document's own headings, so the outline a screen
   reader walks has no gaps. */
h4{font:800 14.5px/1.5 var(--body); margin:20px 0 4px; color:var(--gold); letter-spacing:.01em}
p{margin:0 0 14px; color:var(--cream); opacity:.92}
.legal-updated{color:var(--muted); font-size:13.5px; opacity:1; margin-bottom:20px}
ul{margin:0 0 16px; padding-inline-start:22px}
li{margin-bottom:8px; opacity:.92}
a{color:var(--gold)}
b{color:var(--gold-hi); font-weight:800}

footer{border-top:1px solid var(--rule); padding:30px 0 46px; color:var(--muted); font-size:13.5px}
footer a{color:var(--muted); text-decoration:none}
footer a:hover{color:var(--gold)}
.foot-row{display:flex; flex-wrap:wrap; gap:20px; margin-bottom:14px; font-weight:700}
.foot-row a{display:inline-flex; align-items:center; min-height:44px; margin-block:-11px}

@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style>
</head>
<body>

<header>
  <div class="wrap">
    <a class="brand" href="./"><img src="../assets/brand/png/app-icon/icon-192.png" alt=""> عِزبة</a>
    <a class="back" href="./">رجوع للموقع</a>
  </div>
</header>

<main class="wrap">
  <h1>الشروط والسياسات</h1>
  <p class="updated">تنطبق هذه المستندات على لعبة «عِزبة» على الويب وداخل التطبيق، وهي النسخة نفسها المعروضة داخل اللعبة.</p>

  <nav class="docs" aria-label="المستندات">
${DOCS.map(([id, title]) => `    <a href="#${id}">${title}</a>`).join("\n")}
  </nav>

${DOCS.map(([id, title], k) => `  <section id="${id}" aria-labelledby="${id}-h">
    <h2 id="${id}-h">${title}</h2>
${bodies[k]}
  </section>`).join("\n\n")}
</main>

<footer class="wrap">
  <div class="foot-row">
    <a href="./">الموقع</a>
    <a href="../">اللعبة</a>
    <a href="mailto:izzbahgame@gmail.com">izzbahgame@gmail.com</a>
  </div>
  <div>© ٢٠٢٦ عِزبة — جميع الحقوق محفوظة.</div>
</footer>

</body>
</html>
`;

if (check) {
  let current = "";
  try { current = readFileSync(OUT, "utf8"); } catch { /* not built yet */ }
  if (current !== page) {
    console.error("preview/legal.html is out of date with the legal text in index.html.\n"
      + "Run:  node preview/legal.mjs");
    process.exit(1);
  }
  console.log("preview/legal.html matches the game's legal text.");
} else {
  writeFileSync(OUT, page);
  const words = bodies.join(" ").replace(/<[^>]+>/g, " ").trim().split(/\s+/).length;
  console.log(`wrote preview/legal.html — ${DOCS.length} documents, ${words} words, ${(page.length / 1024).toFixed(1)} KB`);
}
