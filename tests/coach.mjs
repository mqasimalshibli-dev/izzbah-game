// First-run coaching tour (تعليمات أول لعبة): every core screen shows a
// one-time tip teaching it — library, category selection, team setup, the
// board, the question page (helpers/timer), the answer page (awarding) and
// the results. Each tip fires once ever, never blocks the game, and
// «إخفاء كل التعليمات» silences the whole tour.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8331;
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
const clickText = t => page.evaluate(txt => { const el = [...document.querySelectorAll("button, .btn, a, .wlc-start")].find(x => x.textContent.trim().includes(txt)); if (el) { el.click(); return true; } return false; }, t);
const coachState = () => page.evaluate(() => ({
  open: !!document.querySelector(".coach-pop"),
  title: (document.querySelector(".coach-title") || {}).textContent || "",
  seen: (() => { try { return JSON.parse(localStorage.getItem("izzbah-coach-v1")) || {}; } catch (e) { return {}; } })()
}));

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1600);
  await page.evaluate(() => { window.IZZBAH.applyAuth(true); });

  // ---- library tip on first visit ----
  await clickText("ابدأ"); await page.waitForTimeout(800);
  let st = await coachState();
  check("first visit to the library shows its tip", st.open && /مكتبة ألعابك/.test(st.title));
  check("the tip is marked seen immediately (fires once ever)", !!st.seen.gameLibrary);
  await page.evaluate(() => document.querySelector(".coach-ok").click());
  await page.waitForTimeout(100);
  check("«فهمت» dismisses the tip", !(await coachState()).open);

  // ---- categories tip, and no repeat on a second visit ----
  await clickText("إنشاء لعبة جديدة"); await page.waitForTimeout(800);
  st = await coachState();
  check("the category-selection screen teaches picking up to 6 + 🎲 + ⓘ",
    st.open && /اختر فئات/.test(st.title));
  const catTipBody = await page.evaluate(() => (document.querySelector(".coach-body") || {}).textContent || "");
  check("the categories tip mentions the random pick and the info button",
    /🎲/.test(catTipBody) && /ⓘ/.test(catTipBody));
  await page.evaluate(() => document.querySelector(".coach-ok").click());
  // leave and come back — no tip the second time
  await page.evaluate(() => showScreen("gameLibrary"));
  await page.waitForTimeout(600);
  await page.evaluate(() => showScreen("categories"));
  await page.waitForTimeout(800);
  check("returning to a screen does NOT repeat its tip", !(await coachState()).open);

  // ---- setup + board + question + answer tips through a real game ----
  await page.evaluate(() => { const c = [...document.querySelectorAll(".category-main, .category")].find(x => x.textContent.includes("تاريخ")); if (c) c.click(); });
  await clickText("اختيار الفرق"); await page.waitForTimeout(800);
  st = await coachState();
  check("team setup teaches naming + team pictures + ⇄",
    st.open && /جهّز فرقانك/.test(st.title));
  const setupBody = await page.evaluate(() => (document.querySelector(".coach-body") || {}).textContent || "");
  check("the setup tip mentions changing the team picture and who starts",
    /صورة الفريق/.test(setupBody) && /⇄/.test(setupBody));
  await page.evaluate(() => document.querySelector(".coach-ok").click());

  await clickText("ابدأ اللعبة"); await page.waitForTimeout(900);
  st = await coachState();
  check("the board explains columns, values, the lit team and the end flag",
    st.open && /لوحة اللعب/.test(st.title));
  // NON-BLOCKING: with the tip still open, tapping a cell must still work
  const opened = await page.evaluate(() => {
    const card = [...document.querySelectorAll(".board-category-card")].find(c => c.textContent.includes("تاريخ"));
    const cell = card && card.querySelector(".cell:not(.used)");
    if (cell) { cell.click(); return true; } return false;
  });
  await page.waitForTimeout(900);
  check("an open tip never blocks the game (cell tap opened the question)",
    opened && await page.evaluate(() => !!state.activeQuestion));
  st = await coachState();
  check("the question page teaches the helpers (٤ خيارات / أول حرف / ×٢) and the timer",
    st.open && /السؤال/.test(st.title));
  const qBody = await page.evaluate(() => (document.querySelector(".coach-body") || {}).textContent || "");
  check("the question tip covers all three helpers + the timer",
    /٤ خيارات/.test(qBody) && /أول حرف/.test(qBody) && /×٢/.test(qBody) && /المؤقّت/.test(qBody));
  await page.evaluate(() => document.querySelector(".coach-ok").click());

  await page.evaluate(() => document.getElementById("revealAnswer").click());
  await page.waitForTimeout(800);
  st = await coachState();
  check("the answer page teaches awarding the answering team (or no answer)",
    st.open && /من جاوب/.test(st.title));
  const aBody = await page.evaluate(() => (document.querySelector(".coach-body") || {}).textContent || "");
  check("the answer tip explains the automatic turn hand-off", /تلقائ/.test(aBody));

  // ---- «إخفاء كل التعليمات» silences everything ----
  await page.evaluate(() => document.querySelector(".coach-skip").click());
  await page.waitForTimeout(100);
  st = await coachState();
  check("«إخفاء كل التعليمات» closes the tip and marks the WHOLE tour seen",
    !st.open && !!st.seen.results && !!st.seen.answerPage && !!st.seen.__all);

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
