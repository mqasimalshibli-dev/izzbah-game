// Lightweight regression smoke test for عزبة (Izzbah).
//
// It boots the real game in a headless browser and drives the core paths that
// break most often when the single game file is edited:
//   1. the page loads with NO uncaught JS error (catches syntax/runtime breaks),
//   2. a normal category plays: open a question -> reveal its answer,
//   3. a وش الكلمة word category shows a QR code as its question image AND the
//      two answer-revealing helpers are disabled there.
//
// Run:  IZZBAH_CHROMIUM=/path/to/chrome node tests/smoke.mjs
// CI installs a browser and sets IZZBAH_CHROMIUM (see .github/workflows/smoke.yml).
//
// Exit code 0 = all checks passed, 1 = a check failed (fails the CI job).

import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8199;
const checks = [];
const check = (name, ok) => { checks.push({ name, ok: !!ok }); console.log(`${ok ? "PASS ✅" : "FAIL ❌"}  ${name}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));

const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM || undefined });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
// Pre-accept the first-run legal consent gate so this test stays focused on
// gameplay (the gate itself is covered by tests/legal.mjs).
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
const jsErrors = [];
page.on("pageerror", e => jsErrors.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));

const clickText = async (t) => page.evaluate((txt) => {
  const el = [...document.querySelectorAll("button, .btn, a, .wlc-start")].find(x => x.textContent.trim().includes(txt));
  if (el) { el.click(); return true; } return false;
}, t);
const pickCategory = async (name) => page.evaluate((nm) => {
  const el = [...document.querySelectorAll(".category-main, .category")].find(x => x.textContent.includes(nm));
  if (el) { el.click(); return true; } return false;
}, name);
const openFirstCell = async (name) => page.evaluate((nm) => {
  const card = [...document.querySelectorAll(".board-category-card")].find(c => c.textContent.includes(nm));
  if (!card) return false;
  const cell = card.querySelector(".cell:not(.used)");
  if (!cell) return false; cell.click(); return true;
}, name);
const exitQuestion = async () => {
  await page.evaluate(() => { const x = document.querySelector("#questionPage .topbar-x"); if (x) x.click(); });
  await page.waitForTimeout(250);
  await page.evaluate(() => { const y = document.querySelector(".confirm-yes, #exitQuestionConfirm button.primary, .modal .primary"); if (y) y.click(); });
  await page.waitForTimeout(500);
};

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(2000);

  // (1) boot with no uncaught JS error
  check("game boots with no uncaught JS error", jsErrors.length === 0);
  if (jsErrors.length) console.log("   errors:", jsErrors.slice(0, 3));

  // simulate a signed-in user so the start gate opens (test hook the app exposes)
  await page.evaluate(() => { window.IZZBAH = window.IZZBAH || {}; if (window.IZZBAH.applyAuth) window.IZZBAH.applyAuth(true); });

  // (2) a normal category plays end to end
  await clickText("ابدأ"); await page.waitForTimeout(400);        // welcome -> library
  await clickText("إنشاء لعبة جديدة"); await page.waitForTimeout(500);
  const gotNormal = await pickCategory("تاريخ");
  await pickCategory("وش الكلمة مسلسلات"); // also select the word game for step (3)
  await page.waitForTimeout(200);
  await clickText("اختيار الفرق"); await page.waitForTimeout(400);
  await clickText("ابدأ اللعبة"); await page.waitForTimeout(900);

  const openedNormal = await openFirstCell("تاريخ");
  await page.waitForTimeout(700);
  await page.evaluate(() => { const b = document.querySelector("#revealAnswer"); if (b) b.click(); });
  await page.waitForTimeout(500);
  const answerText = (await page.evaluate(() => (document.getElementById("modalAnswer") || {}).textContent || "")).trim();
  check("normal category: question opens and reveals an answer", gotNormal && openedNormal && answerText.length > 0);
  await exitQuestion();

  // (3) word category: QR question image + revealing helpers disabled
  const openedWord = await openFirstCell("وش الكلمة مسلسلات");
  await page.waitForTimeout(700);
  const qImg = await page.evaluate(() => { const im = document.getElementById("modalQuestionImage"); return im ? (im.getAttribute("src") || "") : ""; });
  check("word category: question shows a QR image", /qr-/.test(qImg));
  const helpers = await page.evaluate(() => {
    const bar = document.getElementById("questionHelpBar");
    if (!bar) return [];
    return [...bar.querySelectorAll(".qhelp-slot")].map(s => ({ label: s.getAttribute("aria-label"), disabled: s.disabled }));
  });
  const revealOff = helpers.length > 0 && helpers.every(h => (h.label === "أربعة خيارات" || h.label === "كشف أول حرف") ? h.disabled : true);
  check("word category: reveal helpers (4-choices / first-letter) are disabled", revealOff);

  // no new JS errors accumulated during play
  check("no uncaught JS error during gameplay", jsErrors.length === 0);
} catch (e) {
  check("test harness ran to completion", false);
  console.log("   harness error:", e.message);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(c => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
