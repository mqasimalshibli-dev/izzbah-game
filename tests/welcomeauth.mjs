// Welcome-screen sign-in affordance. The «أو» divider + Google button must
// appear ONLY when signed OUT (alternative to «ابدأ لعبة جديدة» = sign in).
// When signed IN, both hide — a prominent «سجّل الخروج» there reads as nonsense
// and sign-out already lives in Settings.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8349;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 430, height: 920 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1");
  localStorage.setItem("izzbah-coach-v1", JSON.stringify({ __all: 1 })); } catch (e) {} });
const shown = sel => page.evaluate(s => {
  const el = document.querySelector(s);
  if (!el) return false;
  return getComputedStyle(el).display !== "none" && el.offsetParent !== null;
}, sel);

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH && typeof window.IZZBAH.applyAuth === "function", { timeout: 15000 });
  await page.waitForTimeout(300);

  // signed OUT → «أو» + Google sign-in button both visible
  await page.evaluate(() => window.IZZBAH.applyAuth(false, ""));
  check("signed out: the «أو» divider is shown", await shown(".wlc-or"));
  check("signed out: the Google sign-in button is shown", await shown("#authBtn"));

  // signed IN → both hidden (no «ابدأ لعبة جديدة … أو … سجّل الخروج»)
  await page.evaluate(() => window.IZZBAH.applyAuth(true, "u1"));
  check("signed in: the «أو» divider is hidden", await shown(".wlc-or") === false);
  check("signed in: the sign-out button is not shown on the welcome screen", await shown("#authBtn") === false);

  // back to signed out → both return
  await page.evaluate(() => window.IZZBAH.applyAuth(false, ""));
  check("signing out restores the divider + sign-in button", await shown(".wlc-or") && await shown("#authBtn"));

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
