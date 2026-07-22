// Regression tests for gameplay correctness fixes found in the audit:
//  - back arrow on an opened question cancels (no burned tile, no turn rotate)
//  - ×2 (doublePoints) doesn't leak into a later question when the arming team loses
//  - startGame refuses to start with no playable category (blank-board guard)
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8302;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  // Never hit the real Firebase from tests: abort the SDK load so the game
  // runs offline on built-in content (no production Firestore reads/quota).
  await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
const clickText = t => page.evaluate(txt => { const el = [...document.querySelectorAll("button, .btn, a, .wlc-start")].find(x => x.textContent.trim().includes(txt)); if (el) { el.click(); return true; } return false; }, t);
const openCell = () => page.evaluate(() => { const card = [...document.querySelectorAll(".board-category-card")].find(c => c.textContent.includes("تاريخ")); const cell = card && card.querySelector(".cell:not(.used)"); if (cell) { cell.click(); return true; } return false; });

async function startNormalGame() {
  await page.evaluate(() => { window.IZZBAH.applyAuth(true); });
  await clickText("ابدأ"); await page.waitForTimeout(250);
  await clickText("إنشاء لعبة جديدة"); await page.waitForTimeout(400);
  await page.evaluate(() => { const c = [...document.querySelectorAll(".category-main, .category")].find(x => x.textContent.includes("تاريخ")); if (c) c.click(); });
  await clickText("اختيار الفرق"); await page.waitForTimeout(250);
  await clickText("ابدأ اللعبة"); await page.waitForTimeout(600);
}

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1600);
  await startNormalGame();

  // ---- back arrow (X) consumes the tile — taken off the board, turn unchanged ----
  const before = await page.evaluate(() => ({ used: state.used.size, team: state.activeTeam }));
  await openCell();
  await page.waitForTimeout(300);
  const opened = await page.evaluate(() => ({ used: state.used.size, active: !!state.activeQuestion }));
  check("opening a question marks the tile used", opened.used === before.used + 1 && opened.active);
  await page.evaluate(() => document.getElementById("questionBackTop").click());
  await page.waitForTimeout(300);
  const afterBack = await page.evaluate(() => ({ used: state.used.size, team: state.activeTeam, active: !!state.activeQuestion, onBoard: document.getElementById("game").classList.contains("active") }));
  check("back arrow (X) consumes the tile — taken off the board", afterBack.used === before.used + 1);
  check("back arrow does NOT rotate the turn", afterBack.team === before.team);
  check("back arrow returns to the board", afterBack.onBoard && !afterBack.active);

  // ---- ×2 does not leak when the arming team loses ----
  // Team 0 (active) arms ×2, then team 1 (the OTHER team) answers. Team 0's
  // double must clear (no leak) and team 1 must get NORMAL, not doubled, points.
  await openCell(); await page.waitForTimeout(300);
  const setup = await page.evaluate(() => {
    state.activeTeam = 0;
    state.teams[0].doubleArmed = true;            // arm ×2 for the active team
    return { pts: state.activeQuestion.q.points, t1Before: state.teams[1].score };
  });
  await page.evaluate(() => document.getElementById("revealAnswer").click());
  await page.waitForTimeout(250);
  await page.evaluate(() => { const b = document.querySelectorAll("#awardRow .team-award")[1]; if (b) b.click(); });
  await page.evaluate(() => document.getElementById("continueAnswer").click());
  await page.waitForTimeout(400);
  const res = await page.evaluate(() => ({ leak: state.teams[0].doubleArmed, t1After: state.teams[1].score, activeTeam: state.activeTeam, teamCount: state.teamCount }));
  check("×2 armed by team 0 but lost is cleared (no leak)", res.leak === false);
  check(`the winning team got NORMAL points, not doubled (+${res.t1After - setup.t1Before} for a ${setup.pts})`, res.t1After - setup.t1Before === setup.pts);
  // Turn is a strict back-and-forth from the PICKER, not a follow-the-answerer:
  // team 0 picked, team 1 answered → the turn passes to team 1 (picker+1),
  // NOT to (winner+1) which with 2 teams would loop back to team 0.
  check(`the turn alternates from the picker regardless of who answered (→ team ${res.activeTeam})`,
    res.activeTeam === (0 + 1) % res.teamCount);

  // ---- blank-board guard ----
  const guard = await page.evaluate(() => {
    // simulate a selection of only non-existent categories, then try to start
    state.selected = new Set(["__does_not_exist__"]);
    const beforeActive = state.gameActive;
    startGame();
    return { started: state.gameActive && !beforeActive, playable: (typeof activeCategories === "function") ? activeCategories().length : -1 };
  });
  check("startGame refuses to start with no playable category", guard.playable === 0 && !guard.started);

  // ---- answering the LAST cell jumps STRAIGHT to results (no «عرض النتائج» box) ----
  const auto = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // a tiny 2-cell category so the board completes fast
    state.publishedCategories = (state.publishedCategories || []).filter(c => c.id !== "done-test");
    state.publishedCategories.push({ id: "done-test", name: "نهاية", custom: true,
      questions: [{ points: 100, q: "س", a: "ج" }, { points: 200, q: "س٢", a: "ج٢" }] });
    window.IZZBAH.applyAdmin(true); state.isAdmin = true;
    state.selected = new Set(["done-test"]);
    state.editingSavedGameId = null; state.teamCount = 2; state.gameCounted = false;
    state.teams.forEach(t => { t.score = 0; });
    startGame();
    const totalCells = document.querySelectorAll("#board .cell").length;
    // answer every cell (re-query each round — the board re-renders after each)
    for (let i = 0; i < 8; i++) {
      const cell = document.querySelector("#board .board-category-card .cell:not(.used)");
      if (!cell) break;
      cell.click(); await sleep(30);
      if (state.activeQuestion) finishQuestion(0);
      await sleep(50);
    }
    await sleep(150); // let the deferred (rAF) jump fire
    return { totalCells, screen: document.body.dataset.screen,
             noBanner: !document.getElementById("doneBanner"), noBtn: !document.getElementById("showResults") };
  });
  check("a fully-played board auto-jumps to the results screen (no manual step)", auto.screen === "results");
  check("the old «انتهت الأسئلة» banner + «عرض النتائج» button are gone", auto.noBanner && auto.noBtn);

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
