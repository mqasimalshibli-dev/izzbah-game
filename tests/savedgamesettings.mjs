// The «الإعدادات» button on a saved game edits ONLY the teams (names + icons):
// it jumps to the team-setup screen, NOT the category editor, and its «رجوع»
// returns to the library — so a saved game's categories can't be changed. The
// new-game flow still routes team-setup «رجوع» back to the category picker.
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
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

const screen = () => page.evaluate(() => document.body.dataset.screen);

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    window.IZZBAH.applyAuth(true);
    state.savedGames = [{ id: "g1", title: "لعبتي", categoryIds: ["history"], frozen: {}, charged: true }];
    renderGameLibrary();
    showScreen("gameLibrary");
  });

  // ---- «الإعدادات» goes to team setup, NOT the category editor ----
  await page.evaluate(() => document.querySelector('[data-saved-settings="g1"]').click());
  await page.waitForTimeout(200);
  check("«الإعدادات» opens the TEAM setup screen (not categories)", (await screen()) === "setup");
  const hasTeamFields = await page.evaluate(() =>
    document.querySelectorAll("#teamFields input").length > 0);
  check("team name/icon fields are shown for editing", hasTeamFields);

  // ---- its «رجوع» returns to the library — categories stay unreachable ----
  await page.evaluate(() => document.getElementById("setupBack").click());
  await page.waitForTimeout(200);
  check("«رجوع» from a saved game's settings returns to the library (no category editor)",
    (await screen()) === "gameLibrary");

  // ---- the PLAY button also locks categories (back → library) ----
  await page.evaluate(() => document.querySelector('[data-saved-game-card="g1"]').click());
  await page.waitForTimeout(200);
  check("playing a saved game opens team setup", (await screen()) === "setup");
  await page.evaluate(() => document.getElementById("setupBack").click());
  await page.waitForTimeout(200);
  check("play flow's «رجوع» also returns to the library for a saved game",
    (await screen()) === "gameLibrary");

  // ---- a brand-NEW game still lets you go back to the category picker ----
  await page.evaluate(() => {
    openNewGameCategories();
    state.selected = new Set(["history"]);
    renderCategories();
    document.getElementById("goTeams").click();
  });
  await page.waitForTimeout(200);
  check("new-game flow reaches team setup", (await screen()) === "setup");
  await page.evaluate(() => document.getElementById("setupBack").click());
  await page.waitForTimeout(200);
  check("new-game flow's «رجوع» returns to the CATEGORY picker (categories editable there)",
    (await screen()) === "categories");

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
