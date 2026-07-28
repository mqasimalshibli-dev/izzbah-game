// Regression test for the legal/consent gate in عزبة (Izzbah).
//
// It verifies:
//   1. On first use (empty storage) the consent modal is shown and MANDATORY —
//      the agree button is disabled until the checkbox is ticked, and tapping
//      the backdrop does NOT dismiss it.
//   2. Ticking the box + agreeing records consent, closes the gate, and does
//      not reappear on reload.
//   3. The three documents (privacy / terms / notices) switch via their tabs.
//   4. The welcome footer links reopen the text read-only (a Close button, no
//      forced checkbox), dismissible by the backdrop.
//
// Run:  IZZBAH_CHROMIUM=/path/to/chrome node tests/legal.mjs
// Exit 0 = all passed, 1 = a check failed.

import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8251;
const checks = [];
const check = (name, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS ✅" : "FAIL ❌"}  ${name}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM || undefined });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  // Never hit the real Firebase from tests: abort the SDK load so the game
  // runs offline on built-in content (no production Firestore reads/quota).
  await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));

const url = `http://127.0.0.1:${PORT}/game-mobile.html`;
try {
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // 1) gate is shown, mandatory, agree disabled until ticked
  const initial = await page.evaluate(() => {
    const m = document.getElementById("legalModal");
    return {
      open: m.classList.contains("open") && getComputedStyle(m).display !== "none",
      mode: m.dataset.mode,
      agreeDisabled: document.getElementById("legalAgreeBtn").disabled,
      closeHidden: getComputedStyle(document.getElementById("legalCloseBtn")).display === "none",
    };
  });
  check("first-run: consent gate is open in consent mode", initial.open && initial.mode === "consent");
  check("agree button starts disabled; no close button", initial.agreeDisabled && initial.closeHidden);

  // backdrop tap must NOT dismiss it
  await page.evaluate(() => { const m = document.getElementById("legalModal"); const r = m.getBoundingClientRect(); m.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await page.mouse.click(20, 20);
  await page.waitForTimeout(150);
  const stillOpen = await page.evaluate(() => document.getElementById("legalModal").classList.contains("open"));
  check("backdrop tap does NOT dismiss the mandatory gate", stillOpen);

  // 2) tabs switch documents
  await page.evaluate(() => [...document.querySelectorAll("#legalModal .legal-tab")].find(t => t.dataset.legalTab === "terms").click());
  await page.waitForTimeout(100);
  const onTerms = await page.evaluate(() => {
    const d = document.querySelector('#legalModal .legal-doc[data-legal-doc="terms"]');
    return d.classList.contains("active") && d.textContent.includes("المدفوعات") && d.textContent.includes("الاسترجاع");
  });
  check("tabs switch documents (terms shows payments + refund sections)", onTerms);
  await page.evaluate(() => [...document.querySelectorAll("#legalModal .legal-tab")].find(t => t.dataset.legalTab === "notices").click());
  await page.waitForTimeout(100);
  const onNotices = await page.evaluate(() => document.querySelector('#legalModal .legal-doc[data-legal-doc="notices"]').classList.contains("active"));
  check("notices tab activates", onNotices);

  // tick + agree
  await page.evaluate(() => { const b = document.getElementById("legalAgreeCheck"); b.checked = true; b.dispatchEvent(new Event("change", { bubbles: true })); });
  const enabled = await page.evaluate(() => !document.getElementById("legalAgreeBtn").disabled);
  check("ticking the box enables the agree button", enabled);
  await page.evaluate(() => document.getElementById("legalAgreeBtn").click());
  await page.waitForTimeout(200);
  const accepted = await page.evaluate(() => ({
    closed: !document.getElementById("legalModal").classList.contains("open"),
    stored: localStorage.getItem("izzbah-legal-consent-v1"),
  }));
  check("agreeing closes the gate and records consent", accepted.closed && accepted.stored === "1");

  // 3) reload -> gate does NOT reappear
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(1200);
  const afterReload = await page.evaluate(() => document.getElementById("legalModal").classList.contains("open"));
  check("consent persists — gate does not reappear on reload", !afterReload);

  // 4) footer link opens review mode (close button, dismissible)
  await page.evaluate(() => document.querySelector('.wlc-legal-link[data-legal="privacy"]').click());
  await page.waitForTimeout(200);
  const review = await page.evaluate(() => {
    const m = document.getElementById("legalModal");
    return {
      open: m.classList.contains("open"),
      mode: m.dataset.mode,
      closeShown: getComputedStyle(document.getElementById("legalCloseBtn")).display !== "none",
      consentHidden: getComputedStyle(document.getElementById("legalConsentRow")).display === "none",
    };
  });
  check("footer link opens text read-only (review mode, Close shown, no checkbox)", review.open && review.mode === "review" && review.closeShown && review.consentHidden);
  await page.mouse.click(20, 20); // backdrop dismiss allowed in review
  await page.waitForTimeout(150);
  const reviewClosed = await page.evaluate(() => !document.getElementById("legalModal").classList.contains("open"));
  check("review mode is dismissible by backdrop", reviewClosed);

  check("no uncaught JS errors", errs.length === 0);
  if (errs.length) console.log("   errors:", errs.slice(0, 3));
} catch (e) {
  check("test harness ran to completion", false);
  console.log("   harness error:", e.message);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(c => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
