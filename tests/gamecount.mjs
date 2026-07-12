// E2E: a play credit is spent only when a game FINISHES (reaches the results
// screen) — entering a game and leaving, then re-entering, must NOT charge.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8330;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

// force a clean, non-privileged player with a known allowance
const reset = (allowance) => page.evaluate((allowance) => {
  window.IZZBAH.applyAuth(true, "u1");
  window.IZZBAH.applyAdmin(false);
  state.isPremium = false; state.codePremium = false;
  state.gamesAllowed = 0; state.codeGamesAllowed = allowance;
  state.freeGamePlayed = false; state.gamesUsed = 0; state.gameCounted = false;
  state.selected = new Set(["history"]);
  refreshBuiltinQuestions();
  state.teamCount = 2;
  state.teams.forEach(t => { t.score = 0; });
}, allowance);

const snap = () => page.evaluate(() => ({
  free: state.freeGamePlayed, used: state.gamesUsed, counted: state.gameCounted,
  screen: document.body.dataset.screen,
}));

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ---- start a game: NOT charged ----
  await reset(3);
  await page.evaluate(() => startGame());
  let s = await snap();
  check("starting a game does not consume the free game", s.free === false && s.used === 0 && s.screen === "game");

  // ---- leave and RE-ENTER (start again): still not charged ----
  await page.evaluate(() => { showScreen("categories"); startGame(); });
  s = await snap();
  check("re-entering an unfinished game does not charge", s.free === false && s.used === 0);

  // ---- FINISH the game (reach results): free game consumed, once ----
  await page.evaluate(() => { state.teams[0].score = 300; renderResults(); });
  s = await snap();
  check("finishing the game consumes the free game", s.free === true && s.counted === true);
  check("the finished game did not touch the paid allowance yet", s.used === 0);

  // ---- reviewing results again must NOT double-charge ----
  await page.evaluate(() => renderResults());
  s = await snap();
  check("re-opening the results screen never re-charges", s.free === true && s.used === 0);

  // ---- a SECOND full game now spends one allowance game (free already used) ----
  await page.evaluate(() => {
    state.gameCounted = false; // new game
    state.teams.forEach(t => { t.score = 0; });
    startGame();
  });
  const afterStart2 = await snap();
  await page.evaluate(() => { state.teams[0].score = 200; renderResults(); });
  const afterFinish2 = await snap();
  check("starting the second game still doesn't charge until it finishes", afterStart2.used === 0);
  check("finishing the second game spends exactly one allowance game", afterFinish2.used === 1);

  // ---- abandoning games never drains the allowance ----
  await page.evaluate(() => {
    // three starts, no finishes
    for (let i = 0; i < 3; i++) { state.gameCounted = false; state.teams.forEach(t => { t.score = 0; }); startGame(); showScreen("categories"); }
  });
  const abandoned = await snap();
  check("abandoning several games spends nothing", abandoned.used === 1);

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
