// E2E for the user settings / account sheet (top-right floating button).
// Verifies visibility rules per screen, that the sheet opens with account +
// balance + all rows, and that buy/redeem/sound/how-to/legal/diagnostics wire up.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8314;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

const visible = sel => page.evaluate(s => {
  const el = document.querySelector(s);
  if (!el) return false;
  const cs = getComputedStyle(el);
  return cs.display !== "none" && cs.visibility !== "hidden";
}, sel);

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ---- visibility per screen ----
  await page.evaluate(() => showScreen("menu"));
  check("settings button is visible on the welcome screen", await visible("#userSettingsBtn"));
  await page.evaluate(() => showScreen("gameLibrary"));
  check("settings button is visible on the game library", await visible("#userSettingsBtn"));
  await page.evaluate(() => showScreen("categories"));
  check("settings button is HIDDEN on the category-selection screen", !(await visible("#userSettingsBtn")));
  await page.evaluate(() => showScreen("setup"));
  check("settings button is HIDDEN during team setup", !(await visible("#userSettingsBtn")));
  await page.evaluate(() => showScreen("game"));
  check("settings button is HIDDEN in game", !(await visible("#userSettingsBtn")));
  await page.evaluate(() => showScreen("menu"));

  // ---- sheet opens with the expected sections ----
  await page.evaluate(() => document.getElementById("userSettingsBtn").click());
  await page.waitForTimeout(200);
  const opened = await page.evaluate(() => ({
    open: document.getElementById("settingsModal").classList.contains("open"),
    account: !!document.getElementById("settingsAccount").textContent.trim(),
    balance: document.getElementById("settingsBalance").textContent,
    buy: !!document.getElementById("settingsBuy"),
    redeem: !!document.getElementById("redeemInputSettings"),
    sound: !!document.getElementById("settingsSound"),
    howto: !!document.getElementById("settingsHowTo"),
    legal: !!document.getElementById("settingsLegal"),
    about: !!document.getElementById("settingsAbout"),
    soundState: document.getElementById("settingsSoundState").textContent,
  }));
  check("the settings sheet opens", opened.open);
  check("it shows an account block and a balance line", opened.account && /رصيدك|مجانية|غير محدود|رصيد/.test(opened.balance));
  check("it has buy / redeem / sound / how-to / legal / about rows",
    opened.buy && opened.redeem && opened.sound && opened.howto && opened.legal && opened.about);
  check("the sound row reflects the current state", /مفعّل|مكتوم/.test(opened.soundState));

  // ---- buy row opens the plans modal ----
  await page.evaluate(() => document.getElementById("settingsBuy").click());
  await page.waitForTimeout(200);
  check("the buy row opens the plans modal and closes the sheet", await page.evaluate(() =>
    document.getElementById("plansModal").classList.contains("open")
    && !document.getElementById("settingsModal").classList.contains("open")));
  await page.evaluate(() => document.getElementById("plansClose").click());

  // ---- sound toggle flips the state in place ----
  await page.evaluate(() => document.getElementById("userSettingsBtn").click());
  await page.waitForTimeout(150);
  const soundFlip = await page.evaluate(() => {
    const before = document.getElementById("settingsSoundState").textContent;
    document.getElementById("settingsSound").click();
    const after = document.getElementById("settingsSoundState").textContent;
    return before !== after;
  });
  check("tapping the sound row toggles it live", soundFlip);

  // ---- redeem from the sheet requires sign-in (offline: shows a toast, no throw) ----
  const redeem = await page.evaluate(() => {
    let toasted = "";
    const orig = window.showToast; window.showToast = (m) => { toasted = m; if (orig) orig(m); };
    document.getElementById("redeemInputSettings").value = "AB2D-EF4H";
    document.getElementById("redeemBtnSettings").click();
    return toasted;
  });
  check("redeeming from the sheet while signed-out prompts sign-in", /الدخول/.test(redeem));

  // ---- about row opens diagnostics ----
  await page.evaluate(() => document.getElementById("userSettingsBtn").click());
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById("settingsAbout").click());
  await page.waitForTimeout(200);
  check("the about row opens the diagnostics popup with the version", await page.evaluate(() =>
    document.getElementById("notePop").classList.contains("open")
    && /النسخة/.test(document.getElementById("notePopMsg").textContent)));

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
