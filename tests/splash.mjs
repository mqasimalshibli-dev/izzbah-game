// Verifies the instant splash ships in the HTML and clears once the app boots.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8299;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));

// 1) the splash markup is in the served HTML (so it can paint before the script runs)
const html = await (await fetch(`http://127.0.0.1:${PORT}/game-mobile.html`)).text();
check("splash markup is present in the served HTML", /id="appSplash"/.test(html) && /splash-mark/.test(html));
// it must appear before the main <script> so it paints first
check("splash appears before the main script tag", html.indexOf('id="appSplash"') < html.lastIndexOf("<script"));

const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  // Never hit the real Firebase from tests: abort the SDK load so the game
  // runs offline on built-in content (no production Firestore reads/quota).
  await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  // after the app boots, the splash fades and is removed
  await page.waitForTimeout(2500);
  const gone = await page.evaluate(() => !document.getElementById("appSplash"));
  check("splash is removed once the app is ready", gone);
  // and the welcome screen is now interactive underneath
  const welcome = await page.evaluate(() => document.getElementById("menu").classList.contains("active"));
  check("welcome screen is active after the splash clears", welcome);
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
