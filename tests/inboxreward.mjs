// Approval rewards: when an admin approves a community category, its maker
// gets a 5-game code delivered PRIVATELY via the notification center (inbox).
// This drives the player side: the badge counts the personal message, the
// reward renders as a gift card (title/body/code), «تفعيل الكود» redeems it
// through the normal code bridge, and the redeemed state persists.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8363;
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

  // ---- 1) the congratulation message builder (shared with the cloud side) --
  const msg = await page.evaluate(() => buildApprovalRewardMsg("جلسة حريم"));
  check("the reward message congratulates by name", /مبروك/.test(msg.title) && msg.body.includes("جلسة حريم"));
  check("the reward message states the 5-game gift", /٥ ألعاب/.test(msg.body) && /🎁/.test(msg.body));
  check("the reward message invites more categories (every approval rewards)", /كل فئة تُعتمد/.test(msg.body));

  // ---- 2) a personal reward message reaches the notification center -------
  const setup = await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "maker1");
    try { localStorage.setItem("izzbah-ann-seen-v1", "0"); localStorage.removeItem("izzbah-inbox-redeemed-v1"); } catch (e) {}
    const m = buildApprovalRewardMsg("جلسة حريم");
    window.IZZBAH.applyInbox([{ id: "catreward-x", type: "reward", title: m.title, body: m.body,
      icon: "🎁", code: "MZZH-TEST", games: 5, catName: "جلسة حريم", createdAt: Date.now() }]);
    const badge = document.getElementById("settingsAnnounceBadge");
    return { badgeShown: badge && !badge.hidden, badgeText: badge ? badge.textContent : "" };
  });
  check("the notification badge counts the personal reward", setup.badgeShown && setup.badgeText.length > 0);

  // ---- 3) the reward renders as a gift card with the code + actions -------
  const card = await page.evaluate(() => {
    openAnnouncements();
    const c = document.querySelector("#announceList .ann-card.reward");
    return {
      exists: !!c,
      title: c ? c.querySelector(".ann-card-title").textContent : "",
      code: c ? (c.querySelector(".reward-code") || {}).textContent : "",
      hasRedeem: !!(c && c.querySelector(".reward-redeem")),
      hasCopy: !!(c && c.querySelector(".reward-copy")),
      first: c && c.parentElement.firstElementChild === c,
    };
  });
  check("the gift card renders FIRST in the notification center", card.exists && card.first);
  check("it shows the congratulation and the code", /مبروك/.test(card.title) && card.code === "MZZH-TEST");
  check("it offers activate + copy buttons", card.hasRedeem && card.hasCopy);

  // ---- 4) «تفعيل الكود» redeems through the normal bridge -----------------
  const redeem = await page.evaluate(async () => {
    window.__redeemed = null;
    window.IZZBAH.redeemCode = (code) => { window.__redeemed = code; return Promise.resolve({ gamesAllowed: 5 }); };
    const btn = document.querySelector("#announceList .reward-redeem");
    btn.click();
    await new Promise(r => setTimeout(r, 150));
    return { code: window.__redeemed, label: btn.textContent, done: btn.classList.contains("done"), disabled: btn.disabled };
  });
  check("activating passes the exact code to the redeem bridge", redeem.code === "MZZH-TEST");
  check("the button becomes the receipt (✓ done, disabled)", redeem.done && redeem.disabled && /تم التفعيل/.test(redeem.label));

  // ---- 5) the redeemed state survives re-opening the center ---------------
  const reopened = await page.evaluate(() => {
    closeAnnouncements(); openAnnouncements();
    const btn = document.querySelector("#announceList .reward-redeem");
    return { done: btn.classList.contains("done"), disabled: btn.disabled };
  });
  check("re-opening still shows the code as redeemed", reopened.done && reopened.disabled);

  // ---- 6) opening the center clears the badge -----------------------------
  const cleared = await page.evaluate(() => {
    const badge = document.getElementById("settingsAnnounceBadge");
    return badge ? badge.hidden : null;
  });
  check("opening the center marks the reward as seen (badge clears)", cleared === true);

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
