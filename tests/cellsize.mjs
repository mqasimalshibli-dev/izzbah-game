// The point number inside a board cell must be BIG and must still fit.
//
// It shipped at 15px in a 40×56 cell — the glyphs used only 55% of the width
// and about a quarter of the height, which is why the owner reported the board
// as hard to read. The fix is purely typographic: the cell box, the grid, the
// gaps and the colours are untouched, only the number grew.
//
// Two properties are asserted together, because either one alone is a trap:
//   1. the number is LARGE (a floor, so it can never drift back down), and
//   2. it does NOT overflow its cell horizontally or vertically.
// Checking only (2) would pass at 8px; checking only (1) would pass with the
// text clipped. Both are measured on the REAL rendered board, not on the
// stylesheet, at every width the game ships on — including a desktop width,
// where a viewport-relative ceiling could otherwise push the glyphs past the
// cell edge.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8477;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

// Every viewport the board is played on. The last two are the ones where a
// vw-based ceiling can overshoot a cell that did NOT grow with the viewport.
const VIEWPORTS = [
  { w: 320, h: 700, n: "tiny phone", min: 20 },
  { w: 360, h: 780, n: "small phone", min: 21 },
  { w: 390, h: 844, n: "iPhone 14", min: 21 },
  { w: 430, h: 932, n: "Pro Max", min: 21 },
  { w: 768, h: 1024, n: "iPad portrait", min: 21 },
  { w: 844, h: 390, n: "phone landscape", min: 18 },
  { w: 1180, h: 820, n: "iPad landscape", min: 21 },
  { w: 1440, h: 900, n: "desktop", min: 21 },
];

try {
  for (const v of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: v.w, height: v.h } });
    await page.route("**/firebasejs/**", r => r.abort());
    page.on("pageerror", e => errs.push(e.message));
    await page.addInitScript(() => {
      try {
        localStorage.setItem("izzbah-legal-consent-v1", "1");
        localStorage.setItem("izzbah-coach-v1", JSON.stringify({ __all: 1 }));
      } catch (e) {}
    });
    await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1000);

    const m = await page.evaluate(() => {
      window.IZZBAH.applyAuth(true, "adm");
      window.IZZBAH.applyAdmin(true);
      // Six categories × five tiers — the busiest realistic board, i.e. the
      // narrowest a cell ever gets.
      const cats = Array.from({ length: 6 }, (_, i) => ({
        id: "pub-" + i, name: "فئة " + i, image: "", order: i,
        questions: [100, 200, 300, 400, 500].map(pt => ({ points: pt, q: "س", a: "ج", image: "", answerImage: "" })),
      }));
      window.IZZBAH.applyPublished(cats);
      state.selected = new Set(cats.map(c => c.id));
      state.currentGameName = ""; state.editingSavedGameId = null; state.teamCount = 2;
      startGame();

      const cells = [...document.querySelectorAll("#board .cell")];
      if (!cells.length) return { missing: true };
      // Measure the REAL laid-out text, not a canvas estimate: a grid item does
      // not report overflow through scrollWidth when its label is centred and
      // clipped, and canvas measureText silently answers with a fallback face if
      // Cairo has not settled yet — which reads as a 20% overflow that is not
      // there. A Range over the text node is what the browser actually painted.
      const cs = getComputedStyle(cells[0]);
      let worstW = 0, worstH = 0, size = parseFloat(cs.fontSize);
      const rng = document.createRange();
      cells.forEach(c => {
        const s = getComputedStyle(c);
        const r = c.getBoundingClientRect();
        const innerW = r.width - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth)
          - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
        const innerH = r.height - parseFloat(s.borderTopWidth) - parseFloat(s.borderBottomWidth)
          - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom);
        const node = c.firstChild;
        if (!node || node.nodeType !== 3) return;
        rng.selectNodeContents(c);
        const ink = rng.getBoundingClientRect();
        worstW = Math.max(worstW, ink.width / innerW);
        // Height is deliberately measured from the FONT SIZE, not from the range
        // box. Cairo reports ascent+descent of roughly 1.9em, so a range around
        // three digits — which have neither ascender nor descender — claims to be
        // half again taller than anything that gets painted. Trusting that number
        // is the same mistake that once drove the question-text fitter down to
        // its 15px floor on every question.
        worstH = Math.max(worstH, parseFloat(s.fontSize) / innerH);
      });
      return {
        size,
        cellW: +cells[0].getBoundingClientRect().width.toFixed(1),
        cellH: +cells[0].getBoundingClientRect().height.toFixed(1),
        widthUse: +(worstW * 100).toFixed(0),
        heightUse: +(worstH * 100).toFixed(0),
        count: cells.length,
      };
    });

    check(`${v.n}: board renders cells`, !m.missing && m.count === 30);
    check(`${v.n}: the number is large (${m.size}px ≥ ${v.min}px) in a ${m.cellW}×${m.cellH} cell`,
      m.size >= v.min);
    check(`${v.n}: it still fits across the cell (${m.widthUse}% of the inner width)`,
      m.widthUse <= 94);
    check(`${v.n}: …and within its height (${m.heightUse}%)`, m.heightUse <= 94);
    await page.close();
  }

  check("no uncaught JS errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 4));
} catch (e) {
  check("harness completed", false);
  console.log("  harness error:", e.message);
} finally {
  await browser.close();
  server.kill();
}
process.exit(checks.every(Boolean) ? 0 : 1);
