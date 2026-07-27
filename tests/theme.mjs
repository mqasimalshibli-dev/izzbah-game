// Dark mode («المظهر») — a per-device light/dark toggle in settings.
//  • Default is light: no data-theme=dark, body ground is the cream gradient.
//  • Toggling stamps data-theme="dark" on <html>, persists to localStorage,
//    and re-skins the surfaces (body ground goes dark maroon).
//  • The choice survives a reload.
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
const page = await browser.newPage({ viewport: { width: 460, height: 860 }, deviceScaleFactor: 1 });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1");
  localStorage.setItem("izzbah-coach-v1", JSON.stringify({ __all: 1 })); } catch (e) {} });

const bodyBgDark = () => page.evaluate(() => {
  const bi = getComputedStyle(document.body).backgroundImage;
  // dark ground carries the maroon stops (rgb ~ 44,7,9 / 22,7,9); light is cream (239..).
  return /rgb\(44, 7, 9\)|rgb\(22, 7, 9\)|rgb\(15, 5, 7\)/.test(bi);
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH && typeof window.IZZBAH.applyAuth === "function", { timeout: 15000 });
  await page.waitForTimeout(400);

  // ---- default = light ----
  const start = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute("data-theme"),
    theme: state.theme
  }));
  check("default theme is light (no dark attribute)", start.attr !== "dark" && start.theme !== "dark");
  check("light ground is not the dark maroon", !(await bodyBgDark()));

  // ---- toggle to dark ----
  await page.evaluate(() => { toggleTheme(); });
  const dark = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute("data-theme"),
    stored: localStorage.getItem("izzbah-theme-v1"),
    meta: (document.querySelector('meta[name="theme-color"]') || {}).getAttribute
      ? document.querySelector('meta[name="theme-color"]').getAttribute("content") : ""
  }));
  check("toggling stamps data-theme=dark on <html>", dark.attr === "dark");
  check("the dark choice is persisted to localStorage", dark.stored === "dark");
  check("the body ground turns dark maroon", await bodyBgDark());
  check("the browser theme-color follows dark", /#1a0608/i.test(dark.meta));

  // ---- settings row reflects the state ----
  const label = await page.evaluate(() => { openSettings(); renderSettingsSheet();
    return (document.getElementById("settingsThemeState") || {}).textContent || ""; });
  check("the settings «المظهر» row shows the dark state", /داكن/.test(label));

  // ---- persists across reload ----
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.IZZBAH && typeof state !== "undefined", { timeout: 15000 });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  check("dark mode survives a reload", after === "dark");
  check("body ground is still dark after reload", await bodyBgDark());

  // ---- toggle back to light ----
  await page.evaluate(() => { toggleTheme(); });
  const back = await page.evaluate(() => ({ attr: document.documentElement.getAttribute("data-theme"), stored: localStorage.getItem("izzbah-theme-v1") }));
  check("toggling back returns to light", back.attr === "light" && back.stored === "light");

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
