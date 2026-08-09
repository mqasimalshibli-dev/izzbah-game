// Verifies the in-app-browser (webview) guidance: when the game is opened
// inside an embedded browser (Instagram/WhatsApp/etc.), Google OAuth is
// blocked, so the game must detect it, show a warning banner, and steer the
// player to a real browser instead of the "disallowed_useragent" wall.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8313;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });

// 1) Instagram in-app browser UA → banner shows, detector true
const IG_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 250.0.0.0";
const ctx1 = await browser.newContext({ userAgent: IG_UA, viewport: { width: 390, height: 844 } });
const p1 = await ctx1.newPage();
await p1.route("**/firebasejs/**", r => r.abort());
await p1.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
const errs = [];
p1.on("pageerror", e => errs.push(e.message));
p1.on("dialog", d => d.accept().catch(() => {}));
try {
  await p1.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await p1.waitForTimeout(1500);
  const r = await p1.evaluate(() => ({
    detected: isInAppBrowser(),
    bannerShown: getComputedStyle(document.getElementById("webviewNote")).display !== "none",
  }));
  check("Instagram webview is detected", r.detected);
  check("the warning banner is shown in a webview", r.bannerShown);

  // tapping sign-in shows the help note (does NOT navigate to Google)
  const help = await p1.evaluate(() => {
    showInAppBrowserHelp();
    return {
      open: document.getElementById("notePop").classList.contains("open"),
      msg: document.getElementById("notePopMsg").textContent,
    };
  });
  check("webview help note opens with browser guidance", help.open && /المتصفح/.test(help.msg));
  check("no uncaught JS errors (webview)", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 3));
} catch (e) { check("webview harness completed", false); console.log("  err:", e.message); }
await ctx1.close();

// 2) Normal mobile Safari → detector false, banner hidden
const SAFARI_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const ctx2 = await browser.newContext({ userAgent: SAFARI_UA, viewport: { width: 390, height: 844 } });
const p2 = await ctx2.newPage();
await p2.route("**/firebasejs/**", r => r.abort());
await p2.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
try {
  await p2.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await p2.waitForTimeout(1200);
  const r = await p2.evaluate(() => ({
    detected: isInAppBrowser(),
    bannerHidden: getComputedStyle(document.getElementById("webviewNote")).display === "none",
  }));
  check("real Safari is NOT flagged as a webview", !r.detected);
  check("no warning banner in a real browser", r.bannerHidden);
} catch (e) { check("safari harness completed", false); console.log("  err:", e.message); }
await ctx2.close();

await browser.close();
server.kill();
process.exit(checks.every(Boolean) ? 0 : 1);
