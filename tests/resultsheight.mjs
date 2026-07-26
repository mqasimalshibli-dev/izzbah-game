// Regression: in PORTRAIT (a tall results stage), a lone loser box used to
// stretch to the full stage height (align-self:stretch) and tower over the
// content-height champion column — so the WINNER looked smaller than the team
// it beat. Every team box must now size to its content and share the bottom
// line, with the winner (crown + «الفائز» banner) at least as tall as any loser.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8357;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 500, height: 950 }, deviceScaleFactor: 1 });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1");
  localStorage.setItem("izzbah-coach-v1", JSON.stringify({ __all: 1 })); } catch (e) {} });
const clickText = (t) => page.evaluate(txt => { const el = [...document.querySelectorAll("button,.btn,a,.wlc-start")].find(x => x.textContent.trim().includes(txt)); if (el) { el.click(); return true; } return false; }, t);

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH && typeof window.IZZBAH.applyAuth === "function", { timeout: 15000 });
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.IZZBAH.applyAuth(true, "u1"); window.IZZBAH.applyAdmin(true); state.isAdmin = true; state.signedIn = true; });
  await clickText("ابدأ"); await page.waitForTimeout(300);
  await clickText("إنشاء لعبة جديدة"); await page.waitForTimeout(600);
  await page.evaluate(() => { state.selected = new Set(officialCategoryPool().slice(0, 4).map(c => c.id)); renderCategories(); });
  await clickText("اختيار الفرق"); await page.waitForTimeout(300);
  await clickText("ابدأ اللعبة"); await page.waitForTimeout(700);

  const r = await page.evaluate(() => {
    state.teams[0].score = 1300; state.teams[1].score = 300; // team 0 wins by a lot
    renderResults();
    document.body.classList.remove("landscape-only"); // results is viewed in portrait
    const stage = document.getElementById("resultsStage");
    stage.classList.add("revealed");
    stage.querySelectorAll(".rs-card").forEach(c => { c.classList.remove("rs-mystery", "rs-hold", "rs-drum"); c.style.opacity = 1; c.style.transform = "none"; });
    const winner = stage.querySelector(".rs-card.winner");
    const losers = [...stage.querySelectorAll(".rs-card:not(.winner)")];
    const stageH = stage.getBoundingClientRect().height;
    const wH = winner.getBoundingClientRect().height;
    const maxLoserH = Math.max(...losers.map(l => l.getBoundingClientRect().height));
    const bottoms = [winner, ...losers].map(c => Math.round(c.getBoundingClientRect().bottom));
    return { wH, maxLoserH, stageH, oneRow: (Math.max(...bottoms) - Math.min(...bottoms)) < 40, hasWinner: !!winner, nLosers: losers.length };
  });
  check("the winner card renders", r.hasWinner && r.nLosers === 1);
  check("no loser box stretches to fill the tall stage", r.maxLoserH < r.stageH * 0.8);
  check("the winner box is at least as tall as the loser (not dwarfed)", r.wH >= r.maxLoserH);
  check("winner and loser share one bottom-aligned row", r.oneRow);
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
