// E2E for the results-screen fun stats + share-as-image card.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeFileSync } from "fs";
import { tmpdir } from "os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8301;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  // Never hit the real Firebase from tests: abort the SDK load so the game
  // runs offline on built-in content (no production Firestore reads/quota).
  await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
const clickText = t => page.evaluate(txt => { const el = [...document.querySelectorAll("button, .btn, a, .wlc-start")].find(x => x.textContent.trim().includes(txt)); if (el) { el.click(); return true; } return false; }, t);

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1600);
  await page.evaluate(() => { window.IZZBAH.applyAuth(true); });
  await clickText("ابدأ"); await page.waitForTimeout(300);
  await clickText("إنشاء لعبة جديدة"); await page.waitForTimeout(400);
  await page.evaluate(() => { const c = [...document.querySelectorAll(".category-main, .category")].find(x => x.textContent.includes("تاريخ")); if (c) c.click(); });
  await clickText("اختيار الفرق"); await page.waitForTimeout(300);
  await clickText("ابدأ اللعبة"); await page.waitForTimeout(700);

  // Q1: answered by team 1 (fast)
  await page.evaluate(() => { const card = [...document.querySelectorAll(".board-category-card")].find(c => c.textContent.includes("تاريخ")); card.querySelector(".cell:not(.used)").click(); });
  await page.waitForTimeout(800); // ~1s on the clock
  await page.evaluate(() => document.getElementById("revealAnswer").click());
  await page.waitForTimeout(250);
  await page.evaluate(() => document.querySelectorAll("#awardRow .team-award")[0].click());
  await page.evaluate(() => document.getElementById("continueAnswer").click());
  await page.waitForTimeout(400);

  // Q2: no one answers (slower)
  await page.evaluate(() => { const card = [...document.querySelectorAll(".board-category-card")].find(c => c.textContent.includes("تاريخ")); card.querySelector(".cell:not(.used)").click(); });
  await page.waitForTimeout(2000);
  await page.evaluate(() => document.getElementById("revealAnswer").click());
  await page.waitForTimeout(250);
  await clickText("لا أحد");
  await page.evaluate(() => document.getElementById("continueAnswer").click());
  await page.waitForTimeout(400);

  // history entries carry seconds
  const hist = await page.evaluate(() => state.history.map(h => ({ w: h.winnerIndex, s: h.seconds })));
  check(`history records per-question seconds (${JSON.stringify(hist)})`, hist.length === 2 && hist.every(h => typeof h.s === "number"));

  // end the game -> results
  await page.evaluate(() => document.getElementById("endGameEarly").click());
  await page.waitForTimeout(3400);

  const stats = await page.evaluate(() => document.getElementById("resultsStats").textContent);
  check("stats show أسرع إجابة with the team + seconds", /أسرع إجابة/.test(stats) && /ث/.test(stats));
  check("stats count the unanswered question (بلا إجابة)", /بلا إجابة/.test(stats));

  // the share card pre-rendered as a PNG blob
  await page.waitForTimeout(600);
  const card = await page.evaluate(async () => {
    const blob = state.resultCardBlob || await buildResultsImage();
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
    return { size: blob.size, type: blob.type, b64: btoa(bin) };
  });
  check(`result card is a compact JPEG (${Math.round(card.size / 1024)} KB)`, card.type === "image/jpeg" && card.size > 20000 && card.size < 600000);
  writeFileSync(join(tmpdir(), "izzbah-results-card.jpg"), Buffer.from(card.b64, "base64"));

  // share button prefers the image file when the platform supports it
  const shared = await page.evaluate(async () => {
    window.__share = null;
    navigator.canShare = p => !!(p && p.files && p.files.length);
    navigator.share = p => { window.__share = { files: p.files ? p.files.length : 0, type: p.files && p.files[0] ? p.files[0].type : "", hasText: !!p.text }; return Promise.resolve(); };
    document.getElementById("shareResult").click();
    await new Promise(r => setTimeout(r, 400));
    return window.__share;
  });
  check("share sends the image file + text through the share sheet", !!shared && shared.files === 1 && shared.type === "image/jpeg" && shared.hasText);

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
