// The landing page's «كل الفئات» grid — every category, shown whole.
//
// ⚠️ THIS SECTION USED TO FOLD. At 40 tiles in two columns it ran to ~5000px on
// a 390×844 phone, so it opened at six rows behind a «شوف كل الفئات (٤٠)»
// button. The owner's verdict on seeing it: *"the display all categories button
// is useless as the full categories are there."* The button is gone and the
// grid is whole at every width.
//
// The reasoning is worth keeping, because "the phone page is long" is a real
// observation that will invite this fix again: the SIZE of the library is the
// page's pitch. A visitor scrolling past forty covers learns something a
// number in a button never tells them, and the section sits at the bottom
// where scrolling past it is free. Length was never the cost it looked like.
//
// So what this test pins is the promise the heading makes: «كل الفئات» means
// all of them, on every screen, reachable by pointer and by keyboard, with
// nothing in front of them.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8563;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

const VIEWPORTS = [
  ["iPhone SE  320×568", 320, 568],
  ["iPhone 12  390×844", 390, 844],
  ["Galaxy S20 360×800", 360, 800],
  ["iPad      768×1024", 768, 1024],
  ["desktop   1440×900", 1440, 900],
];

let PAGE = null;
async function load(w, h) {
  if (!PAGE) {
    PAGE = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    PAGE.on("pageerror", e => errs.push(e.message));
    await PAGE.goto(`http://127.0.0.1:${PORT}/preview/index.html`, { waitUntil: "load", timeout: 30000 });
  } else {
    await PAGE.setViewportSize({ width: w, height: h });
    await PAGE.reload({ waitUntil: "load", timeout: 30000 });
  }
  await PAGE.waitForTimeout(900);
  return PAGE;
}

const read = page => page.evaluate(() => {
  const g = document.getElementById("allGrid");
  const cards = [...g.children];
  return {
    total: cards.length,
    // offsetParent is null for a display:none element — this reads what a
    // visitor can actually see, not what the class list claims.
    visible: cards.filter(c => c.offsetParent !== null).length,
    tabbable: cards.filter(c => c.tabIndex === 0).length,
    // The links have to go somewhere real: each tile deep-links into the game
    // with that category preselected.
    linked: cards.filter(c => (c.getAttribute("href") || "").length > 2).length,
    cols: getComputedStyle(g).gridTemplateColumns.split(" ").filter(Boolean).length,
    // ⚠️ The fold left two traces — a button and a `data-fold` attribute. Either
    // one coming back hides tiles, so both are checked by their effect AND by
    // their absence: `[data-fold]{display:none}` with no JS to set it would
    // pass an "everything is visible" test while lying dormant.
    folder: !!document.getElementById("allMore") || !!document.querySelector(".more"),
    folded: document.querySelectorAll("#allGrid [data-fold]").length,
    heading: (document.querySelector("#all h2") || {}).textContent || "",
    sectionH: Math.round(document.getElementById("all").getBoundingClientRect().height),
    pageH: Math.round(document.documentElement.scrollHeight),
    vh: window.innerHeight,
  };
});

try {
  for (const [name, w, h] of VIEWPORTS) {
    const page = await load(w, h);
    const m = await read(page);
    console.log(`      ${name}  ${m.cols} cols · ${m.visible}/${m.total} shown · section ${m.sectionH}px · page ${(m.pageH / m.vh).toFixed(1)} screens`);

    check(`${name}: every category is in the grid (${m.total})`, m.total === 40);
    check(`${name}: and every one of them is on screen (${m.visible}/${m.total})`,
      m.visible === m.total);
    check(`${name}: every tile is reachable by keyboard (${m.tabbable} tabbable)`,
      m.tabbable === m.total);
    check(`${name}: every tile links into the game (${m.linked})`, m.linked === m.total);
    check(`${name}: nothing stands in front of the grid`, m.folder === false);
    check(`${name}: no tile is folded away (${m.folded})`, m.folded === 0);
    check(`${name}: the heading still promises all of them`, m.heading.includes("كل الفئات"));
  }

  /* ── one honest look at the cost ───────────────────────────────
     Reported, not asserted. The section IS long on a phone and that is the
     accepted trade; a threshold here would only tempt the next reader to fold
     it again to make a number go green. What must not happen is the page
     becoming unnavigable, which is what the anchor nav is for. */
  const page = await load(390, 844);
  const nav = await page.evaluate(() => {
    const foot = document.querySelector(".foot-links");
    return {
      // «كل الفئات» is the last section before the footer, so the way back up
      // is the only thing between a reader at the bottom and a long scroll.
      toTop: !!document.querySelector('a[href="#top"]'),
      footLinks: foot ? foot.querySelectorAll("a").length : 0,
    };
  });
  check("a reader at the bottom of the grid can get back to the top", nav.toTop);
  check("and the footer offers its own way around the page", nav.footLinks >= 5);

  check("no page errors" + (errs.length ? ": " + errs[0] : ""), errs.length === 0);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
