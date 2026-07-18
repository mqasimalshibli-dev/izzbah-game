// The emoji category «خمّن الإيموجي» is worth a FLAT 200 points: every board
// cell shows 200, the question screen shows 200, and answering awards exactly
// 200 (×2 only with the double-points helper). Other categories keep tiers.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8359;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // start an emoji-only game (admin bypasses the one-free-game gate)
  const board = await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true);
    state.selected = new Set(["emojis"]);
    state.editingSavedGameId = null; state.teamCount = 2;
    state.teams.forEach(t => { t.score = 0; t.doubleArmed = false; });
    startGame();
    const cells = [...document.querySelectorAll("#board .board-category-card .cell")];
    return { count: cells.length, labels: cells.map(c => c.textContent) };
  });
  check("the emoji category shows board cells", board.count >= 1);
  check(`every emoji cell is worth 200 (${JSON.stringify(board.labels)})`,
    board.labels.length > 0 && board.labels.every(t => t === "200"));

  // open a puzzle → the question screen shows 200
  const opened = await page.evaluate(() => {
    document.querySelector("#board .board-category-card .cell:not(.used)").click();
    return {
      modal: document.getElementById("modalPoints").textContent,
      qPoints: state.activeQuestion && state.activeQuestion.q ? state.activeQuestion.q.points : null,
    };
  });
  check("the question screen shows 200 نقطة", /200/.test(opened.modal) && /نقطة/.test(opened.modal));

  // answering awards exactly 200
  const scored = await page.evaluate(() => {
    finishQuestion(0);
    return { s0: state.teams[0].score, hist: (state.history || []).slice(-1)[0] };
  });
  check(`answering an emoji puzzle awards exactly 200 (got ${scored.s0})`, scored.s0 === 200);
  check("the history records the emoji question at 200", scored.hist && scored.hist.points === 200);

  // ---- a NON-emoji category still keeps its tier value ----
  const other = await page.evaluate(() => {
    state.selected = new Set(["history"]);
    state.editingSavedGameId = null;
    state.teams.forEach(t => { t.score = 0; t.doubleArmed = false; });
    startGame();
    const labels = [...document.querySelectorAll("#board .board-category-card .cell")].map(c => c.textContent);
    return { labels };
  });
  check(`a normal category still shows varied tiers, not all 200 (${JSON.stringify(other.labels)})`,
    other.labels.length > 1 && new Set(other.labels).size > 1);

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
