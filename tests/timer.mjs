// E2E for the question timer: red-at-a-minute + tick logic + keeps counting.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8295;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
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
  // open a question so the timer is on screen
  await page.evaluate(() => { const card = [...document.querySelectorAll(".board-category-card")].find(c => c.textContent.includes("تاريخ")); card.querySelector(".cell:not(.used)").click(); });
  await page.waitForTimeout(600);

  const wrapExists = await page.evaluate(() => !!document.getElementById("qTimerWrap"));
  check("timer is present on the question screen", wrapExists);

  const notRedEarly = await page.evaluate(() => { handleTimerSecond(30); return !document.getElementById("qTimerWrap").classList.contains("overminute"); });
  check("timer is NOT red before one minute (30s)", notRedEarly);

  const notRedAt59 = await page.evaluate(() => { handleTimerSecond(59); return !document.getElementById("qTimerWrap").classList.contains("overminute"); });
  check("timer still not red at 59s", notRedAt59);

  const redAt60 = await page.evaluate(() => { handleTimerSecond(60); return document.getElementById("qTimerWrap").classList.contains("overminute"); });
  check("timer turns red exactly at one minute", redAt60);

  // it keeps counting past the minute (format shows > 1:00) and stays red
  const keepsCounting = await page.evaluate(() => {
    answerTimer.elapsed = 75000; // 1:15
    paintAnswerTimer();
    handleTimerSecond(75);
    const txt = document.getElementById("qTimerNum").textContent;
    return { txt, stillRed: document.getElementById("qTimerWrap").classList.contains("overminute") };
  });
  check(`clock keeps counting past a minute (shows ${keepsCounting.txt})`, keepsCounting.txt === "1:15");
  check("stays red while over the minute", keepsCounting.stillRed);

  // a fresh question resets: not red, back to 0:00
  const reset = await page.evaluate(() => {
    startAnswerTimer();
    return { red: document.getElementById("qTimerWrap").classList.contains("overminute"), txt: document.getElementById("qTimerNum").textContent };
  });
  check("new question clears the red state and resets to 0:00", !reset.red && reset.txt === "0:00");

  check("no uncaught JS errors (incl. tick/alarm audio)", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 4));
} catch (e) {
  check("harness completed", false);
  console.log("  harness error:", e.message);
} finally {
  await browser.close();
  server.kill();
}
process.exit(checks.every(Boolean) ? 0 : 1);
