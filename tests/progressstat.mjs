// Two additive features:
//  1) In-game progress bar («N / total سؤال») under the top-bar logo — hidden
//     off the board, visible during play, and it advances as cells are opened.
//  2) Per-device «الأكثر لعباً» pill on the category picker — a localStorage
//     play tally that surfaces the most-played category (off the cards, so
//     covers stay untouched) and is hidden until the device has any history.
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
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH && typeof window.IZZBAH.applyAuth === "function", { timeout: 15000 });
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.IZZBAH.applyAuth(true, "u1"); window.IZZBAH.applyAdmin(true); state.isAdmin = true; state.signedIn = true; });

  // ---- category picker: pill hidden with no play history ----------------
  await clickText("ابدأ"); await page.waitForTimeout(300);
  await clickText("إنشاء لعبة جديدة"); await page.waitForTimeout(600);
  const pillHiddenInitially = await page.evaluate(() => {
    const el = document.getElementById("catPlaysStat");
    return !!el && el.hidden;
  });
  check("«الأكثر لعباً» pill is hidden before any game is played", pillHiddenInitially);

  const firstCatId = await page.evaluate(() => {
    const ids = officialCategoryPool().slice(0, 4).map(c => c.id);
    state.selected = new Set(ids);
    renderCategories();
    return ids[0];
  });

  // ---- board: progress bar visible and reads 0 / total ------------------
  await clickText("اختيار الفرق"); await page.waitForTimeout(300);
  await clickText("ابدأ اللعبة"); await page.waitForTimeout(900);

  const start = await page.evaluate(() => {
    const el = document.getElementById("gameProgress");
    const cats = activeCategories();
    const total = cats.reduce((n, c) => n + new Set((c.questions || []).map(q => q.points)).size, 0);
    return {
      visible: !!el && el.style.display !== "none",
      total,
      domCells: document.querySelectorAll("#board .cell").length,
      valuemax: el && +el.getAttribute("aria-valuemax"),
      valuenow: el && +el.getAttribute("aria-valuenow"),
      label: el && el.querySelector(".gp-frac").textContent.trim(),
      fillW: el && el.querySelector(".gp-fill").style.width
    };
  });
  check("progress bar is visible during play", start.visible);
  check("progress max equals the board's cell count", start.total > 0 && start.valuemax === start.total);
  check("progress total exactly matches the tiles rendered on the board", start.valuemax === start.domCells);
  check("progress starts at zero", start.valuenow === 0 && /^0/.test(start.label) && (start.fillW === "0%" || start.fillW === "0px" || start.fillW === ""));

  // a malformed question (missing/invalid points) must NOT spawn a phantom
  // tile — the board count and the progress total stay in lockstep.
  const phantom = await page.evaluate(() => {
    const cat = activeCategories()[0];
    const before = { cells: document.querySelectorAll("#board .cell").length, total: boardTileCount() };
    cat.questions.push({ q: "؟", a: "x" });               // no points
    cat.questions.push({ q: "؟", a: "y", points: 0 });    // zero points
    cat.questions.push({ q: "؟", a: "z", points: null }); // null points
    renderGame();
    const after = { cells: document.querySelectorAll("#board .cell").length, total: boardTileCount() };
    return { before, after };
  });
  check("junk-points questions add no phantom tile to the board", phantom.after.cells === phantom.before.cells);
  check("the progress total ignores junk points too (no off-by-one)", phantom.after.total === phantom.before.total);

  // open one cell → progress advances by one
  const after = await page.evaluate(() => {
    const cells = [...document.querySelectorAll("#board .cell:not(.used)")];
    if (cells.length) cells[0].click();
    // question page opened; mark it answered-ish by returning to board render
    const el = document.getElementById("gameProgress");
    return { usedSize: state.used.size, valuenow: el && +el.getAttribute("aria-valuenow"), fillW: el && el.querySelector(".gp-fill").style.width };
  });
  check("opening a cell records a used question", after.usedSize >= 1);
  check("progress bar advances as questions are opened", after.valuenow >= 1);

  // ---- finish a game → the play tally bumps the selected categories ------
  const tallied = await page.evaluate((cid) => {
    // Drive straight to a finished game and let renderResults spend the credit
    // + bump the local play tally.
    state.gameCounted = false;
    state.teams.forEach((t, i) => { t.score = 100 * (i + 1); });
    renderResults();
    const counts = JSON.parse(localStorage.getItem("izzbah-cat-plays-v1") || "{}");
    return { count: counts[cid] || 0, best: (typeof mostPlayedCategory === "function") ? mostPlayedCategory() : null };
  }, firstCatId);
  check("finishing a game bumps the per-device play tally", tallied.count === 1);
  check("mostPlayedCategory resolves to a real category", !!(tallied.best && tallied.best.cat));

  // ---- back on the picker → pill now shows the most-played category ------
  await page.evaluate(() => { showScreen("categories"); state.categoryMode = "game"; renderCategories(); });
  await page.waitForTimeout(200);
  const pill = await page.evaluate(() => {
    const el = document.getElementById("catPlaysStat");
    return { hidden: el.hidden, text: el.textContent.replace(/\s+/g, " ").trim(), hasFire: !!el.querySelector(".cps-fire") };
  });
  check("the pill is shown once the device has play history", !pill.hidden);
  check("the pill names the most-played category with a 🔥 marker", pill.hasFire && /الأكثر لعبا/.test(pill.text) && /مرّة/.test(pill.text));

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
