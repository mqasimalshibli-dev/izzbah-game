// A saved game's category names must be READABLE in «ألعابك».
//
// The name pill on each category tile was a single `white-space: nowrap` line
// with `text-overflow: ellipsis`, and the tile is half a phone wide — so
// ordinary names in the live catalogue were cut mid-word: «رياكشنات عمانية»
// rendered as «رياكشنات ع…», «منوعات كرة قدم» as «منوعات كرة …». Someone
// choosing which saved game to replay could not tell what was in it.
//
// The pill now wraps to a second line. This test drives the real screen with
// the LONGEST names actually published (taken from the live catalogue) and
// asserts that every pill shows its whole name — measured from the DOM, not
// from the stylesheet, because `text-overflow` leaves textContent intact and a
// naive check would pass while the player sees an ellipsis.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8481;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

// Real names, longest first — «معنى الايموجي (English)» is the longest in the
// catalogue today, the rest are typical.
const NAMES = [
  "معنى الايموجي (English)",
  "وش الكلمة مسلسلات",
  "رياكشنات عمانية",
  "منوعات كرة قدم",
  "السيرة النبوية",
  "كافيهات ومطاعم",
];

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

const VIEWPORTS = [
  { w: 320, h: 700, n: "tiny phone" },
  { w: 390, h: 844, n: "iPhone 14" },
  { w: 427, h: 820, n: "the owner's screenshot" },
  { w: 768, h: 1024, n: "iPad portrait" },
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
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1000);

    const m = await page.evaluate(async (NAMES) => {
      window.IZZBAH.applyAuth(true, "adm");
      window.IZZBAH.applyAdmin(true);
      const cats = NAMES.map((name, i) => ({
        id: "pub-n" + i, name, image: "", order: i,
        questions: [100, 200].map(pt => ({ points: pt, q: "س", a: "ج", image: "", answerImage: "" })),
      }));
      window.IZZBAH.applyPublished(cats);
      state.savedGames = [{
        id: "g-names", title: "لعبة ٤", charged: true,
        createdAt: new Date().toISOString(),
        categoryIds: cats.map(c => c.id), frozen: {},
      }];
      // The screen has to be SHOWN, not merely rendered — a hidden section
      // measures zero on every box, which would make every assertion below pass
      // without looking at anything.
      openGameLibrary("your");
      await new Promise(r => setTimeout(r, 450));

      const pills = [...document.querySelectorAll("#gameLibrary .saved-game-category span")];
      if (!pills.length) return { missing: true };
      const rng = document.createRange();
      return {
        count: pills.length,
        rows: pills.map(el => {
          const s = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          rng.selectNodeContents(el);
          const ink = rng.getBoundingClientRect();
          const inner = box.width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)
            - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth);
          return {
            text: el.textContent,
            // clipped horizontally (the old ellipsis case) or vertically (more
            // lines than the clamp allows)
            clippedX: el.scrollWidth > el.clientWidth + 1,
            clippedY: el.scrollHeight > el.clientHeight + 1,
            wraps: s.whiteSpace !== "nowrap",
            // Distinct line positions. Neither obvious alternative works here:
            // the range's HEIGHT overcounts (Cairo's per-line metric box is
            // ~1.9em for text with no ascenders or descenders), and the NUMBER
            // of client rects overcounts too — a name like
            // «معنى الايموجي (English)» is two bidi runs, so one line reports
            // two rects.
            lines: new Set([...rng.getClientRects()].map(r => Math.round(r.top))).size,
            fontPx: parseFloat(s.fontSize),
            fits: ink.width <= inner + 1,
            // the pill must not swallow the tile it sits on
            pillH: Math.round(box.height),
            tileH: Math.round(el.closest(".saved-game-category").getBoundingClientRect().height),
          };
        }),
      };
    }, NAMES);

    check(`${v.n}: the saved game lists all its categories`, !m.missing && m.count === NAMES.length);
    if (m.missing) { await page.close(); continue; }
    // Guard against a vacuous pass: a hidden screen reports zero for every box,
    // and every "it fits" assertion below would then be true of nothing.
    check(`${v.n}: the pills are actually laid out (not a hidden screen)`,
      m.rows.every(r => r.pillH > 0 && r.tileH > 0 && r.lines >= 1));

    const clipped = m.rows.filter(r => r.clippedX || r.clippedY);
    check(`${v.n}: no category name is cut off (${clipped.length} clipped)`, clipped.length === 0);
    if (clipped.length) console.log("   clipped:", clipped.map(r => r.text).join(" | "));

    check(`${v.n}: the pill wraps rather than ellipsing`, m.rows.every(r => r.wraps));
    // Ordinary names keep the full 14px; only an outlier longer than 16
    // characters takes the smaller step, and never below 12.5px.
    check(`${v.n}: ordinary names keep the full size (${m.rows[2].fontPx}px)`,
      m.rows.filter(r => r.text.length <= 16).every(r => r.fontPx >= 14));
    check(`${v.n}: even the longest name stays readable (≥12.5px)`,
      m.rows.every(r => r.fontPx >= 12.5));
    // Two lines hold every name in the catalogue except the single longest,
    // «معنى الايموجي (English)», which needs three on a phone narrower than
    // ~400px. Three is the honest bar: nothing is clipped at any width (asserted
    // above, separately), so this only guards against a name sprawling further.
    check(`${v.n}: no name needs more than three lines (max ${Math.max(...m.rows.map(r => r.lines))})`,
      m.rows.every(r => r.lines <= 3));
    const worst = m.rows.reduce((a, r) => (r.pillH / r.tileH > a.pillH / a.tileH ? r : a));
    // The pill sits on top of the category artwork, so it must stay a label
    // rather than become the tile. Ordinary names land at 32-49px of a 112px
    // tile; only the longest name on the narrowest phone reaches 61px.
    check(`${v.n}: the pill never covers more than 60% of its tile (worst ${worst.pillH}/${worst.tileH}px)`,
      m.rows.every(r => r.pillH <= r.tileH * 0.6));
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
