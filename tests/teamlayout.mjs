// Board scoreboard + final-results layout with 5 teams.
//  1) Every team's helper strip sits on the SAME side of its score box
//     (the old left-half/right-half split put some on the right, some left).
//  2) The results trophy stays centred for any team count, in one un-wrapped
//     row, with the winner as the centrepiece next to it.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8355;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 960, height: 450 }, deviceScaleFactor: 1 });
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
  await clickText("ابدأ"); await page.waitForTimeout(300);
  await clickText("إنشاء لعبة جديدة"); await page.waitForTimeout(600);
  await page.evaluate(() => { state.selected = new Set(officialCategoryPool().slice(0, 6).map(c => c.id)); renderCategories(); });
  await clickText("اختيار الفرق"); await page.waitForTimeout(300);
  await page.evaluate(() => { const need = 5 - state.teamCount; for (let i = 0; i < need; i++) { const b = document.querySelector("#setup .stepper-btn.step-plus"); if (b) b.click(); } });
  await page.waitForTimeout(200);
  await clickText("ابدأ اللعبة"); await page.waitForTimeout(900);

  // ---- 1) board: every team's helper strip on the same side ----
  const board = await page.evaluate(() => {
    const cells = [...document.querySelectorAll("#scoreRow .score-cell")];
    return {
      count: cells.length,
      boxFirst: cells.every(c => c.firstElementChild && c.firstElementChild.classList.contains("score-box")),
      barLast: cells.every(c => c.lastElementChild && c.lastElementChild.classList.contains("qhelp-bar"))
    };
  });
  check("all five teams render on the board", board.count === 5);
  check("every team's score box is on the same side (box first in every cell)", board.boxFirst);
  check("every team's helper strip is on the same side (bar last in every cell)", board.barLast);

  // ---- 2) results: trophy centred, one row, winner beside it ----
  const res = await page.evaluate(() => {
    const sc = [900, 500, 400, 200, 100];
    state.teams.slice(0, 5).forEach((t, i) => { t.score = sc[i]; });
    renderResults();
    const intro = document.getElementById("resultsIntro"); if (intro) intro.classList.remove("active", "sliding");
    const stage = document.getElementById("resultsStage");
    const kids = [...stage.children];
    const trophyIdx = kids.findIndex(c => c.classList.contains("rs-trophy-stage"));
    // vertical CENTRES (align-items:center aligns centres, not tops — the taller
    // trophy has a different top by design, so compare centres to detect a wrap)
    const centres = kids.map(c => { const r = c.getBoundingClientRect(); return Math.round(r.top + r.height / 2); });
    const winnerIdx = kids.findIndex(c => c.classList.contains("winner"));
    return {
      total: kids.length,
      trophyIdx,
      centred: Math.abs(trophyIdx - (kids.length - 1) / 2) <= 1,
      oneRow: (Math.max(...centres) - Math.min(...centres)) < 40, // no wrap
      winnerNextToTrophy: winnerIdx === trophyIdx + 1 || winnerIdx === trophyIdx - 1
    };
  });
  check("results place the trophy among the teams (not first/last)", res.trophyIdx > 0 && res.trophyIdx < res.total - 1);
  check("the trophy is centred for 5 teams", res.centred);
  check("all teams + trophy sit in ONE row (no wrap)", res.oneRow);
  check("the winner card is the centrepiece next to the trophy", res.winnerNextToTrophy);

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
