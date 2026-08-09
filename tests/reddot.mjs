// Gear red-dot (unread indicator) lifecycle. The settings-gear dot must light
// for unread DEV messages (announcements + dev replies) and, for ADMINS, unread
// USER messages (incoming player feedback) — and must clear once each is seen.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8347;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 420, height: 820 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try {
  localStorage.setItem("izzbah-legal-consent-v1", "1");
  localStorage.setItem("izzbah-coach-v1", JSON.stringify({ __all: 1 }));
  localStorage.removeItem("izzbah-ann-seen-v1");
  localStorage.removeItem("izzbah-feedback-read-v1");
  localStorage.removeItem("izzbah-fb-admin-read-v1");
} catch (e) {} });
const dot = () => page.evaluate(() => document.getElementById("userSettingsBtn").classList.contains("has-unread"));

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ── Player side: dev announcement + dev reply light the dot ──
  await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "u1"); state.signedIn = true;
    const now = Date.now();
    state.announcements = [{ id: "a1", title: "إعلان", body: "مرحبا", createdAt: now - 1000, active: true }];
    state.inbox = [];
    updateAnnounceBadge();
    window.IZZBAH.applyFeedback([{ from: "admin", text: "رد المطوّر", createdAt: now - 500 }]);
  });
  check("an unseen announcement + dev reply light the gear dot", await dot() === true);

  // seeing the announcements center clears the dev-announcement part, but the
  // unread dev REPLY keeps the dot lit
  await page.evaluate(() => openAnnouncements());
  check("opening «إعلانات المطوّر» alone leaves the dot (dev reply still unread)", await dot() === true);

  // reading the feedback thread clears the last unread → dot off
  await page.evaluate(() => { setFeedbackReadAt(Date.now()); updateFeedbackBadge(); });
  check("once BOTH dev messages are seen, the dot clears", await dot() === false);

  // ── Admin side: incoming player messages light the dot, reading clears it ──
  await page.evaluate(() => {
    const now = Date.now();
    // a fresh player message, plus a thread the admin already answered
    window.__threads = [
      { uid: "p1", name: "لاعب أ", lastFrom: "user", updatedAt: now, lastText: "عندي اقتراح" },
      { uid: "p2", name: "لاعب ب", lastFrom: "admin", updatedAt: now, lastText: "شكراً لك" }
    ];
    window.IZZBAH.adminListFeedback = () => Promise.resolve(window.__threads);
    // reset any prior seen-state so only the admin thread drives the dot
    localStorage.setItem("izzbah-ann-seen-v1", String(now + 1000));
    localStorage.setItem("izzbah-feedback-read-v1", String(now + 1000));
    localStorage.removeItem("izzbah-fb-admin-read-v1");
    state.announcements = []; state.inbox = []; state.feedbackLatestAdminTs = 0;
    updateAnnounceBadge(); updateFeedbackBadge();
  });
  check("with everything else seen, the dot is off before the player writes", await dot() === false);

  // becoming admin preloads the threads → the unread player message lights it
  await page.evaluate(() => window.IZZBAH.applyAdmin(true));
  await page.waitForTimeout(200); // preload is async
  check("an unread player message lights the gear dot for the admin", await dot() === true);

  // a thread the admin already answered must NOT count on its own
  const onlyAnswered = await page.evaluate(async () => {
    window.__threads = [{ uid: "p2", name: "لاعب ب", lastFrom: "admin", updatedAt: Date.now(), lastText: "شكراً" }];
    await window.IZZBAH.adminListFeedback().then(t => { state.adminThreads = t; refreshGearUnread(); });
    return document.getElementById("userSettingsBtn").classList.contains("has-unread");
  });
  check("an already-answered thread does not light the dot", onlyAnswered === false);

  // restore the unread thread, then reading it clears the dot
  await page.evaluate(async () => {
    window.__threads = [{ uid: "p1", name: "لاعب أ", lastFrom: "user", updatedAt: Date.now(), lastText: "اقتراح" }];
    await window.IZZBAH.adminListFeedback().then(t => { state.adminThreads = t; refreshGearUnread(); });
  });
  check("the unread player message re-lights the dot", await dot() === true);
  await page.evaluate(() => markAdminThreadRead("p1"));
  check("reading the player's thread clears the gear dot", await dot() === false);

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
