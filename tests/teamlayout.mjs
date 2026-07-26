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

  // ---- 1) board: score box + helper strip joined in ONE unit, same side ----
  const board = await page.evaluate(() => {
    const cells = [...document.querySelectorAll("#scoreRow .score-cell")];
    const units = cells.map(c => c.querySelector(".score-unit"));
    return {
      count: cells.length,
      allUnits: units.every(Boolean),
      boxFirst: units.every(u => u && u.firstElementChild && u.firstElementChild.classList.contains("score-box")),
      barLast: units.every(u => u && u.lastElementChild && u.lastElementChild.classList.contains("qhelp-bar"))
    };
  });
  check("all five teams render on the board", board.count === 5);
  check("each team's score box + helpers are joined in one connected unit", board.allUnits);
  check("every team's score box is on the same side (box first in every unit)", board.boxFirst);
  check("every team's helper strip is on the same side (bar last in every unit)", board.barLast);

  // ---- 2) results: champion column (trophy atop the winner box), centred ----
  const res = await page.evaluate(() => {
    const sc = [900, 500, 400, 200, 100];
    state.teams.slice(0, 5).forEach((t, i) => { t.score = sc[i]; });
    renderResults();
    const intro = document.getElementById("resultsIntro"); if (intro) intro.classList.remove("active", "sliding");
    const stage = document.getElementById("resultsStage");
    const kids = [...stage.children];
    const champIdx = kids.findIndex(c => c.classList.contains("rs-champion"));
    const champ = kids[champIdx];
    // bottom-aligned row (align-items:flex-end) → compare bottoms to detect wrap
    const bottoms = kids.map(c => Math.round(c.getBoundingClientRect().bottom));
    const trophy = champ && champ.querySelector(".rs-trophy-stage");
    const winner = champ && champ.querySelector(".rs-card.winner");
    const trophyR = trophy && trophy.getBoundingClientRect();
    const winnerR = winner && winner.getBoundingClientRect();
    return {
      total: kids.length,
      champIdx,
      centred: Math.abs(champIdx - (kids.length - 1) / 2) <= 1,
      oneRow: (Math.max(...bottoms) - Math.min(...bottoms)) < 40,
      hasTrophy: !!trophy,
      hasWinner: !!winner,
      trophyOnTop: !!(trophyR && winnerR && trophyR.top < winnerR.top) // trophy above the box
    };
  });
  check("the winner + trophy form a centred champion column (not first/last)", res.champIdx > 0 && res.champIdx < res.total - 1);
  check("the champion column is centred for 5 teams", res.centred);
  check("all teams share one bottom-aligned row (no wrap)", res.oneRow);
  check("the champion column holds both the trophy and the winner box", res.hasTrophy && res.hasWinner);
  check("the trophy sits ATOP the winning box", res.trophyOnTop);

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
