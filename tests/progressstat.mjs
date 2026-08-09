// Board tile-count integrity — stray/non-canonical point values must NOT
// spawn a phantom 6th tile (the real cause of a «31 / 30» reading). The
// visible progress bar was later removed, but the underlying boardTileCount /
// categoryTiers logic it relied on is still exercised here.
//
// This file also used to cover the «الأكثر لعباً» pill and its localStorage
// play tally. Both were removed at the owner's request in build .284, along
// with the tally itself — the admin panel's most-played list is a separate,
// cloud-side count fed by recordGameStats and is untouched.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8356;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 960, height: 520 }, deviceScaleFactor: 1 });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1");
  localStorage.setItem("izzbah-coach-v1", JSON.stringify({ __all: 1, gameLibrary: 1, categories: 1, setup: 1, game: 1, questionPage: 1, answerPage: 1, results: 1, menu: 1 })); } catch (e) {} });
const clickText = (t) => page.evaluate(txt => { const el = [...document.querySelectorAll("button,.btn,a,.wlc-start")].find(x => x.textContent.trim().includes(txt)); if (el) { el.click(); return true; } return false; }, t);

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH && typeof window.IZZBAH.applyAuth === "function", { timeout: 15000 });
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.IZZBAH.applyAuth(true, "u1"); window.IZZBAH.applyAdmin(true); state.isAdmin = true; state.signedIn = true; });

  await clickText("ابدأ"); await page.waitForTimeout(300);
  await clickText("إنشاء لعبة جديدة"); await page.waitForTimeout(600);

  // Four real categories, so the board below is built from a real selection.
  await page.evaluate(() => {
    state.selected = new Set(officialCategoryPool().slice(0, 4).map(c => c.id));
    renderCategories();
  });

  // ---- board renders ----------------------------------------------------
  await clickText("اختيار الفرق"); await page.waitForTimeout(300);
  await clickText("ابدأ اللعبة"); await page.waitForTimeout(900);

  const start = await page.evaluate(() => {
    const cats = activeCategories();
    const total = cats.reduce((n, c) => n + new Set((c.questions || []).map(q => q.points)).size, 0);
    return { total, domCells: document.querySelectorAll("#board .cell").length, tileCount: boardTileCount() };
  });
  check("board renders one cell per canonical tier", start.total > 0 && start.domCells === start.tileCount);

  // A stray point value — junk (missing/0/null) OR a NON-canonical number like
  // 250/600 (e.g. from an import) — must NOT spawn a phantom 6th tile. The board
  // count and the progress total stay in lockstep, capped at the 5 canonical
  // tiers. This is the real cause behind a «31» reading on a 6×5=30 board.
  const phantom = await page.evaluate(() => {
    const cat = activeCategories()[0];
    const before = { cells: document.querySelectorAll("#board .cell").length, total: boardTileCount() };
    cat.questions.push({ q: "؟", a: "x" });               // no points
    cat.questions.push({ q: "؟", a: "y", points: 0 });    // zero points
    cat.questions.push({ q: "؟", a: "z", points: null }); // null points
    cat.questions.push({ q: "؟", a: "w", points: 250 });  // non-canonical
    cat.questions.push({ q: "؟", a: "v", points: 600 });  // non-canonical
    renderGame();
    const after = { cells: document.querySelectorAll("#board .cell").length, total: boardTileCount() };
    return { before, after, tiers: categoryTiers(cat).length };
  });
  check("stray/non-canonical points add no phantom tile to the board", phantom.after.cells === phantom.before.cells);
  check("the progress total ignores stray points too (no off-by-one)", phantom.after.total === phantom.before.total);
  check("a category never exceeds the 5 canonical tiers", phantom.tiers <= 5);

  // open one cell → it's recorded as used
  const after = await page.evaluate(() => {
    const cells = [...document.querySelectorAll("#board .cell:not(.used)")];
    if (cells.length) cells[0].click();
    return { usedSize: state.used.size };
  });
  check("opening a cell records a used question", after.usedSize >= 1);

  // ---- finishing a game still records it, and leaves no local play tally --
  const finished = await page.evaluate(() => {
    state.gameCounted = false;
    state.teams.forEach((t, i) => { t.score = 100 * (i + 1); });
    renderResults();
    return {
      counted: state.gameCounted === true,
      screen: document.body.dataset.screen,
      // the pill's store is gone; nothing may keep writing to it
      stale: localStorage.getItem("izzbah-cat-plays-v1"),
    };
  });
  check("finishing a game records it exactly once", finished.counted);
  check("finishing a game reaches the results screen", finished.screen === "results");
  check("no local play tally is written any more", finished.stale === null);
  check("the removed pill leaves nothing behind in the picker",
    await page.evaluate(() => {
      showScreen("categories"); state.categoryMode = "game"; renderCategories();
      return !document.getElementById("catPlaysStat") && !document.querySelector(".cat-plays-stat");
    }));

  check("no uncaught JS errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 4));
} catch (e) {
  check("harness completed", false);
  console.log("  harness error:", e.message, e.stack);
} finally {
  await browser.close();
  server.kill();
}
process.exit(checks.every(Boolean) ? 0 : 1);
