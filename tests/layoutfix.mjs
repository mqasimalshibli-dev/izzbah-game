// #7: the "rotate your phone" hint (body.landscape-only::after, z-index 9999)
// must NOT paint over an open sheet/modal. On a landscape-only screen held in
// portrait, opening any modal suppresses the hint; closing it restores it.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8351;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
// portrait phone → the landscape-lock media query is active
const page = await browser.newPage({ viewport: { width: 430, height: 920 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1");
  localStorage.setItem("izzbah-coach-v1", JSON.stringify({ __all: 1 })); } catch (e) {} });
const hintContent = () => page.evaluate(() => getComputedStyle(document.body, "::after").content);

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => typeof showScreen === "function", { timeout: 15000 });
  await page.waitForTimeout(300);

  // land on a landscape-only screen (portrait → hint shows)
  await page.evaluate(() => showScreen("game"));
  await page.waitForTimeout(150);
  const onGame = await page.evaluate(() => document.body.classList.contains("landscape-only"));
  check("a game screen in portrait engages the landscape lock", onGame);
  const hintBefore = await hintContent();
  check("the rotate hint is shown (its ::after has content)", /لف/.test(hintBefore));

  // open the settings sheet — the hint must be suppressed so it can't cover it
  await page.evaluate(() => { const g = document.getElementById("userSettingsBtn"); if (g) g.click(); });
  await page.waitForTimeout(250);
  const settingsOpen = await page.evaluate(() => document.getElementById("settingsModal").classList.contains("open"));
  const hintDuring = await hintContent();
  check("the settings sheet opened over the game screen", settingsOpen);
  check("the rotate hint is suppressed while a modal is open (no bleed-through)", hintDuring === "none");

  // close it → the hint returns (still portrait on a game screen)
  await page.evaluate(() => { const c = document.querySelector("#settingsModal .settings-close, #settingsClose"); if (c) c.click(); });
  await page.waitForTimeout(300);
  const hintAfter = await hintContent();
  check("closing the modal restores the rotate hint", /لف/.test(hintAfter));

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
