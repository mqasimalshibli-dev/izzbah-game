// One generated page per category — `preview/c/<id>.html`.
//
// The site was one page, and one page ranks for one thing. Someone searching
// «أسئلة عن خريف ظفار» had nothing of ours to find. These are forty, each about
// a single category and each carrying real questions from it — the only organic
// acquisition channel this product has that does not cost money.
//
// ⚠️ THEY ARE GENERATED, SO THIS TESTS THE GENERATOR'S PROMISES, not a fixture.
// `preview/cats.mjs --check` rebuilds and compares, so a category renamed or
// published in the admin panel fails here rather than leaving a page that
// describes something that no longer exists.
//
// ⚠️ THE SITE IS NOINDEX TODAY. Forty indexable pages linking to a noindex home
// would be incoherent, so the generator COPIES the robots value out of
// `preview/index.html`. That means these pages do nothing for search until that
// one meta is lifted — worth knowing before reading their absence from Google
// as a failure. What is asserted here is that the two always agree.
import { chromium } from "playwright-core";
import { spawn, execFileSync } from "child_process";
import { readFileSync, readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "preview", "c");
const PORT = 8785;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`); };

const site = readFileSync(join(ROOT, "preview", "index.html"), "utf8");
const DATA = (() => {
  const s = readFileSync(join(ROOT, "preview", "data.js"), "utf8");
  return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
})();
const playable = DATA.cats.filter(c => c.n > 0);

check("the pages exist", existsSync(DIR));
const files = existsSync(DIR) ? readdirSync(DIR).filter(f => f.endsWith(".html")) : [];
check(`one per playable category (${files.length})`, files.length === playable.length,
  `${files.length} pages, ${playable.length} categories`);
check("and every category has one",
  playable.every(c => files.includes(c.id + ".html")),
  (playable.find(c => !files.includes(c.id + ".html")) || {}).name || "");

/* ── in step with the data ────────────────────────────────────────
   The generator's own --check. A category renamed, emptied or published in the
   admin panel makes the committed pages stale, and a stale page is a page that
   describes a category that no longer exists that way. */
let inStep = true, why = "";
try { execFileSync("node", [join(ROOT, "preview", "cats.mjs"), "--check"], { cwd: ROOT }); }
catch (e) { inStep = false; why = (e.stdout || e.stderr || "").toString().trim().split("\n")[0]; }
check("preview/c/ is in step with the catalogue", inStep, why);

/* ── robots agrees with the site ─────────────────────────────── */
const siteRobots = (/<meta name="robots" content="([^"]*)">/.exec(site) || [])[1];
const pageRobots = [...new Set(files.map(f =>
  (/<meta name="robots" content="([^"]*)">/.exec(readFileSync(join(DIR, f), "utf8")) || [])[1]))];
check("every page carries the same robots value as the site",
  pageRobots.length === 1 && pageRobots[0] === siteRobots, `site "${siteRobots}", pages "${pageRobots}"`);

/* ── the content that makes them worth having ────────────────── */
const pages = files.map(f => ({ id: f.slice(0, -5), html: readFileSync(join(DIR, f), "utf8") }));
const textOf = h => h.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ").trim();

check("each has its own title, and no two are the same",
  new Set(pages.map(p => (/<title>([^<]*)<\/title>/.exec(p.html) || [])[1])).size === pages.length);
check("each has its own meta description",
  new Set(pages.map(p => (/<meta name="description" content="([^"]*)"/.exec(p.html) || [])[1])).size === pages.length);
check("each declares a canonical URL",
  pages.every(p => p.html.includes(`<link rel="canonical" href="https://izzbah.com/preview/c/${p.id}.html">`)));
check("each is Arabic and right-to-left",
  pages.every(p => p.html.includes('lang="ar"') && p.html.includes('dir="rtl"')));
check("each carries structured data", pages.every(p => p.html.includes("application/ld+json")));

/* ⚠️ The sample questions ARE the page. Without them it is a description and a
   button, which is not something to put forty of on the internet. */
const withQs = pages.filter(p => (p.html.match(/class="q"/g) || []).length > 0);
check(`most pages carry real questions (${withQs.length}/${pages.length})`,
  withQs.length >= pages.length * 0.7,
  `${pages.length - withQs.length} without — categories whose questions are all pictures`);

/* ⚠️ Spread across point tiers, not the first three in the document. Questions
   are authored in runs, so the first three of سيارات were all 100-pointers
   reading «ما الشركة المصنعة لسيارة …؟» — three lines that look like one line
   repeated, which is thin for a reader and thinner for a page whose entire job
   is to be worth indexing. */
const carsQ = [...readFileSync(join(DIR, "cars.html"), "utf8")
  .matchAll(/<span class="pts">([^<]*)<\/span>\s*<p>([^<]*)<\/p>/g)].map(m => [m[1], m[2]]);
check("the samples are spread across point tiers",
  new Set(carsQ.map(q => q[0])).size === carsQ.length, carsQ.map(q => q[0]).join(" · "));
check("and no two open with the same words",
  new Set(carsQ.map(q => q[1].split(/\s+/).slice(0, 3).join(" "))).size === carsQ.length,
  carsQ.map(q => q[1].slice(0, 24)).join(" | "));

/* Nothing hand-written: the description on the page must be the one the site
   shows for the same category. */
const copy = JSON.parse((/const COPY = (\{[\s\S]*?\n {2}\});/.exec(site))[1].replace(/,(\s*\})/g, "$1"));
check("the description matches the site's, word for word",
  pages.every(p => !copy[p.id] || textOf(p.html).includes(copy[p.id][1])),
  (pages.find(p => copy[p.id] && !textOf(p.html).includes(copy[p.id][1])) || {}).id || "");

/* ── in the browser ──────────────────────────────────────────── */
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [], http = [];

try {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1000 } });
  const page = await ctx.newPage();
  page.on("pageerror", e => errs.push(e.message));
  page.on("response", r => { if (r.status() >= 400) http.push(r.status() + " " + r.url().split("/").pop()); });

  /* The reading path: the site has to LINK to these, or they are forty files
     nobody and nothing can reach. A sitemap alone serves a crawler poorly and a
     reader not at all. */
  await page.goto(`http://127.0.0.1:${PORT}/preview/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(900);
  /* ⚠️ THE TILES ARE THE WAY IN. They used to deep-link straight into the
     picker with the category chosen; the owner's change is that someone
     browsing the library wants to see what is IN a category first. A separate
     text index of forty pills was built for that and then removed — once the
     tiles lead here it was forty links to the same forty places. */
  const tiles = await page.evaluate(() => [...document.querySelectorAll(".gcard")]
    .map(a => a.getAttribute("href")));
  check("every tile opens its category's page", tiles.length === playable.length
    && tiles.every(h => /^c\/[A-Za-z0-9-]+\.html$/.test(h)), tiles[0]);
  check("and each tile points at a page that exists",
    tiles.every(h => files.includes(h.slice(2))),
    tiles.find(h => !files.includes(h.slice(2))) || "");
  // The pill row is gone; a stray one would be forty duplicate links.
  const strays = await page.evaluate(() => document.querySelectorAll("#catIndex").length);
  check("no leftover duplicate index of the same links", strays === 0);

  // …and one page, rendered.
  for (const [id, w, h] of [["cars", 1000, 1000], ["khareef", 390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`http://127.0.0.1:${PORT}/preview/c/${id}.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(700);
    const m = await page.evaluate(() => {
      const art = document.querySelector(".art");
      const r = art.getBoundingClientRect();
      return {
        h1: document.querySelector("h1").textContent.trim(),
        play: document.querySelector(".btn").getAttribute("href"),
        artW: Math.round(r.width), artH: Math.round(r.height),
        natural: art.naturalWidth + "x" + art.naturalHeight,
        sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        onward: document.querySelectorAll(".more a").length,
        scripts: document.querySelectorAll("script:not([type='application/ld+json'])").length,
      };
    });
    check(`${id} @${w}: it renders its own category`, m.h1.length > 1, m.h1);
    /* ⚠️ The cover must keep its own shape. The <img> carries width/height
       attributes and that height is a presentational hint that BEATS
       `aspect-ratio` — the first build rendered every cover 1350px tall down
       the side of the page. And `covers.py` builds wide covers at their own
       aspect on purpose, so pinning 4/5 would hard-crop exactly those. */
    const [nw, nh] = m.natural.split("x").map(Number);
    check(`${id} @${w}: the cover keeps its own proportions`,
      Math.abs((m.artW / m.artH) - (nw / nh)) < 0.05,
      `${m.artW}x${m.artH} from ${m.natural}`);
    check(`${id} @${w}: it opens the game with this category picked`,
      m.play.startsWith("../../#g="), m.play.slice(0, 24));
    check(`${id} @${w}: no sideways scroll`, !m.sideways);
    check(`${id} @${w}: it links onward to other categories`, m.onward >= 4, `${m.onward} links`);
    /* ⚠️ The content must not need JavaScript — a crawler that does not run it
       still has to see the questions. The one script these carry only UPGRADES
       the play button to a store link when a store exists; the button is a real
       href in the markup either way. So this checks the CONTENT renders with
       scripting off, rather than counting script tags. */
    check(`${id} @${w}: the play button is a real link, not script-built`,
      /<a class="btn" id="play" href="\.\.\/\.\.\/#g=/.test(
        readFileSync(join(DIR, id + ".html"), "utf8")));
  }

  /* …and prove it: the same page with JavaScript switched off entirely. */
  const noJs = await browser.newContext({ viewport: { width: 1000, height: 1000 }, javaScriptEnabled: false });
  const np = await noJs.newPage();
  await np.goto(`http://127.0.0.1:${PORT}/preview/c/cars.html`, { waitUntil: "load", timeout: 30000 });
  const bare = await np.evaluate ? null : null;
  const seen = await np.textContent("body");
  const qCount = (await np.$$(".q")).length;
  const playHref = await np.getAttribute("#play", "href");
  await noJs.close();
  check("with scripting off the questions are still there", qCount === 3, `${qCount} questions`);
  check("…and the play button still works", (playHref || "").startsWith("../../#g="), playHref);
  check("…and the category is still named", (seen || "").includes("سيارات"));
  void bare;

  check("no missing files" + (http.length ? ": " + http[0] : ""), http.length === 0);
  check("no page errors" + (errs.length ? ": " + errs[0] : ""), errs.length === 0);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
