// The landing page's «كل الفئات» grid, and the fold that keeps it off the floor.
//
// The section lists every category the game has. At 40 of them in two columns
// it ran to 5065px on a 390×844 phone — SIX screens of the twenty the page was
// tall, sitting between the pitch and the footer. It now opens with six ROWS
// and a button for the rest: 1827px, and the whole page drops 20.4 → 16.6
// screens.
//
// ⚠️ Six ROWS, not twelve TILES. The grid is `auto-fill`, so the column count
// is a function of the viewport, the wrap's max-width and even the font — six
// rows is 12 tiles on a phone and the entire library on a laptop. A fixed tile
// count would leave a ragged half-row on desktop and would silently stop
// matching the layout the day the tile size changes.
//
// ⚠️ The fold is gated to grids of three columns or fewer. Above that the
// section is ~2.4 screens and reads fine whole; folding there would put a
// button in front of ten tiles for nothing, and the SIZE of the library is the
// page's pitch — hiding it works against the copy right above it.
//
// What this test pins is the promise, not the pixels: nothing is unreachable,
// the count in the button is the true total, and expanding really does show
// every category. The heading says «كل الفئات» and that has to stay true.
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
  ["iPhone SE  320×568", 320, 568, true],
  ["iPhone 12  390×844", 390, 844, true],
  ["Galaxy S20 360×800", 360, 800, true],
  ["iPad      768×1024", 768, 1024, false],
  ["desktop   1440×900", 1440, 900, false],
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
  const g = document.getElementById("allGrid"), m = document.getElementById("allMore");
  const cards = [...g.children];
  return {
    total: cards.length,
    // offsetParent is null for a display:none element — this reads what a
    // visitor can actually see, not what the class list claims.
    visible: cards.filter(c => c.offsetParent !== null).length,
    tabbable: cards.filter(c => c.tabIndex === 0).length,
    cols: getComputedStyle(g).gridTemplateColumns.split(" ").filter(Boolean).length,
    btnHidden: m.hidden,
    btnText: m.textContent,
    btnBox: (() => { const r = m.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
    expanded: m.getAttribute("aria-expanded"),
    controls: m.getAttribute("aria-controls"),
    sectionH: Math.round(document.getElementById("all").getBoundingClientRect().height),
    pageH: Math.round(document.documentElement.scrollHeight),
    vh: window.innerHeight,
  };
});

try {
  for (const [name, w, h, phone] of VIEWPORTS) {
    const page = await load(w, h);
    const m = await read(page);
    console.log(`      ${name}  ${m.cols} cols · ${m.visible}/${m.total} shown · section ${m.sectionH}px · page ${(m.pageH / m.vh).toFixed(1)} screens`);

    check(`${name}: every category is in the grid (${m.total})`, m.total === 40);

    if (phone) {
      check(`${name}: opens folded to six rows (${m.visible} of ${m.total})`,
        m.visible === m.cols * 6 && m.visible < m.total);
      check(`${name}: the button is offered`, m.btnHidden === false);
      // A folded tile is display:none, so it is out of the tab order for free —
      // but only while it stays display:none. Assert it, because a later
      // `display:` on `.gcard` would revive 28 invisible links.
      check(`${name}: folded tiles are out of the tab order (${m.tabbable} tabbable)`,
        m.tabbable === m.visible);
      // The point of the exercise — asserted as the fold's own effect rather
      // than as a count of screens. ⚠️ Screens is the wrong unit here: an SE is
      // 568px tall, so it scores WORSE per screen than an iPhone 12 while
      // having the shorter section in pixels. Compare folded against expanded
      // and the viewport drops out.
      // The button must be honest about how many are behind it — it is the only
      // place the reader learns the library did not stop at twelve.
      check(`${name}: the button names the true total (${m.btnText.trim()})`,
        m.btnText.includes("٤٠"));
      check(`${name}: the button is a real tap target (${m.btnBox.w}×${m.btnBox.h})`,
        m.btnBox.h >= 44 && m.btnBox.w >= 44);
      check(`${name}: it says what it controls`, m.controls === "allGrid" && m.expanded === "false");

      await page.click("#allMore");
      await page.waitForTimeout(250);
      const after = await read(page);
      const cut = 1 - m.sectionH / after.sectionH;
      console.log(`        folded ${m.sectionH}px vs expanded ${after.sectionH}px — ${(cut * 100).toFixed(0)}% shorter`);
      check(`${name}: folding cuts the section by at least half (${(cut * 100).toFixed(0)}%)`,
        cut >= 0.5);
      check(`${name}: expanding reveals all ${after.total}`,
        after.visible === after.total && after.tabbable === after.total);
      check(`${name}: the spent button gets out of the way`,
        after.btnHidden === true && after.expanded === "true");
      // Nothing may be left unreachable — «كل الفئات» has to mean it.
      const reachable = await page.evaluate(() =>
        [...document.getElementById("allGrid").children].every(c => c.offsetParent !== null && c.tabIndex === 0));
      check(`${name}: no category is left unreachable`, reachable);
    } else {
      // Desktop: the whole library, no button, exactly as before the fold existed.
      check(`${name}: the full grid is shown whole above three columns`, m.visible === m.total);
      check(`${name}: no button in front of a section that reads fine`, m.btnHidden === true);
    }
  }

  check("no page errors" + (errs.length ? ": " + errs[0] : ""), errs.length === 0);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
