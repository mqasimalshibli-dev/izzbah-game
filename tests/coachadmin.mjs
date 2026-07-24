// Admin editor for the first-run coaching tips («التعليمات الإرشادية»):
// per-screen rows (icon/title/body), on/off toggles, live preview, adding a
// tip to a screen without one, save publishes config/coach and applies
// instantly, and a local reset replays the tour on this device.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8332;
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
  await page.waitForTimeout(1600);
  await page.evaluate(() => {
    window.IZZBAH.applyAuth(true); window.IZZBAH.applyAdmin(true); state.isAdmin = true;
    window.__saved = null;
    window.IZZBAH.loadCoachConfig = () => Promise.resolve({ map: {} });
    window.IZZBAH.saveCoachConfig = (map) => { window.__saved = JSON.parse(JSON.stringify(map)); return Promise.resolve(true); };
  });

  // ---- the chooser offers the tips editor, and it opens with all 7 rows ----
  await page.evaluate(() => { openAdminChoice(); });
  await page.waitForTimeout(150);
  check("the admin chooser has a «التعليمات الإرشادية» entry",
    await page.evaluate(() => !!document.getElementById("adminChoiceCoach")));
  await page.evaluate(() => document.getElementById("adminChoiceCoach").click());
  await page.waitForTimeout(300);
  const opened = await page.evaluate(() => ({
    open: document.getElementById("coachAdminModal").classList.contains("open"),
    rows: document.querySelectorAll("#coachAdminList .coach-tip-row").length,
    screens: [...document.querySelectorAll(".coach-tip-screen")].map(s => s.textContent)
  }));
  check("the editor opens with a row per default tip (7)", opened.open && opened.rows === 7);
  check("each row names WHERE the tip appears (screen labels)",
    opened.screens.some(s => /اختيار الفئات/.test(s)) && opened.screens.some(s => /شاشة السؤال/.test(s)));

  // ---- live preview from a row ----
  await page.evaluate(() => document.querySelectorAll(".coach-tip-preview")[1].click());
  await page.waitForTimeout(150);
  check("👁 معاينة shows the coach card exactly as players see it",
    await page.evaluate(() => !!document.querySelector(".coach-pop") && /اختر فئات/.test(document.querySelector(".coach-title").textContent)));
  await page.evaluate(() => document.querySelector(".coach-ok").click());

  // ---- edit a title, toggle one off, add a tip to a new screen ----
  const editres = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll("#coachAdminList .coach-tip-row")];
    const catRow = rows.find(r => /اختيار الفئات/.test(r.querySelector(".coach-tip-screen").textContent));
    const t = catRow.querySelector(".ct-title");
    t.value = "عنوان معدّل من المشرف"; t.dispatchEvent(new Event("input"));
    const ansRow = rows.find(r => /شاشة الإجابة/.test(r.querySelector(".coach-tip-screen").textContent));
    const cb = ansRow.querySelector(".ct-on"); cb.checked = false; cb.dispatchEvent(new Event("change"));
    // add a tip on the main menu screen
    const sel = document.getElementById("coachAddScreen");
    sel.value = "menu";
    document.getElementById("coachAddBtn").click();
    await new Promise(r => setTimeout(r, 100));
    return { rows: document.querySelectorAll("#coachAdminList .coach-tip-row").length };
  });
  check("adding a tip to a screen without one creates its row (8 rows)", editRes8(editres));
  function editRes8(r) { return r.rows === 8; }

  // ---- saving with an incomplete new tip is refused with a clear reason ----
  await page.evaluate(() => document.getElementById("coachAdminSave").click());
  await page.waitForTimeout(120);
  const refuse = await page.evaluate(() => ({
    saved: window.__saved, msg: document.getElementById("coachAdminStatus").textContent
  }));
  check("saving refuses while the new tip is empty (names the screen)",
    refuse.saved === null && /الشاشة الرئيسية/.test(refuse.msg));

  // ---- complete it and save: the bridge gets the full map ----
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("#coachAdminList .coach-tip-row")]
      .find(r => /الشاشة الرئيسية/.test(r.querySelector(".coach-tip-screen").textContent));
    const ti = row.querySelector(".ct-title"); ti.value = "أهلاً بك في عزبة"; ti.dispatchEvent(new Event("input"));
    const b = row.querySelector(".ct-body"); b.value = "من هنا تبدأ لعبتك الأولى"; b.dispatchEvent(new Event("input"));
    document.getElementById("coachAdminSave").click();
  });
  await page.waitForTimeout(200);
  const saved = await page.evaluate(() => window.__saved);
  check("save publishes the whole map: edited title, disabled tip, added tip",
    saved && saved.categories && saved.categories.title === "عنوان معدّل من المشرف"
    && saved.answerPage && saved.answerPage.on === false
    && saved.menu && saved.menu.title === "أهلاً بك في عزبة");

  // ---- the saved config applies INSTANTLY on this device ----
  const applied = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    localStorage.removeItem("izzbah-coach-v1");
    closeCoachAdmin();
    showScreen("categories"); await sleep(700);
    const catTitle = (document.querySelector(".coach-title") || {}).textContent || "";
    closeCoach();
    showScreen("answerPage", { keepQuestion: true }); await sleep(700);
    const ansPop = !!document.querySelector(".coach-pop");
    closeCoach();
    showScreen("menu"); await sleep(700);
    const menuTitle = (document.querySelector(".coach-title") || {}).textContent || "";
    closeCoach();
    return { catTitle, ansPop, menuTitle };
  });
  check("the edited categories tip shows the admin's wording", /عنوان معدّل من المشرف/.test(applied.catTitle));
  check("the disabled answer-page tip no longer appears", applied.ansPop === false);
  check("the ADDED main-menu tip appears on the menu screen", /أهلاً بك في عزبة/.test(applied.menuTitle));

  // ---- «أعد عرضها على جهازي» clears the local seen-state ----
  const reset = await page.evaluate(() => {
    localStorage.setItem("izzbah-coach-v1", JSON.stringify({ categories: 1 }));
    document.getElementById("coachResetLocal").click();
    return localStorage.getItem("izzbah-coach-v1");
  });
  check("the local reset button clears this device's seen-state", reset === null);

  // ---- remote override path used by every player at boot ----
  const remote = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    window.IZZBAH.applyCoachConfig({ setup: { icon: "⭐", title: "تجهيز مخصص", body: "نص مخصص من السحابة" } });
    localStorage.removeItem("izzbah-coach-v1");
    showScreen("setup"); await sleep(700);
    const t = (document.querySelector(".coach-title") || {}).textContent || "";
    closeCoach();
    return t;
  });
  check("applyCoachConfig (boot path) swaps a tip's content for every player", /تجهيز مخصص/.test(remote));

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
