// UX-improvement batch (2026-07-25): teams-setup sticky start bar, settings
// section headers, persistent «N / ٦» category counter, a one-time glow on the
// answer-award team buttons, and the admin «تحرير النصوص» edit-mode that lets
// the owner reword any UI text live (config/text overrides). Offline — Firebase
// aborted, cloud bridges stubbed.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8345;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 420, height: 820 }, deviceScaleFactor: 2 });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
// Consent seeded; coaching tour marked fully-seen so its card never floats over
// hit-tests. Award-glow flag left UNSET so the first reveal glows.
await page.addInitScript(() => {
  try {
    localStorage.setItem("izzbah-legal-consent-v1", "1");
    localStorage.setItem("izzbah-coach-v1", JSON.stringify({ gameLibrary: 1, categories: 1, setup: 1, game: 1, questionPage: 1, answerPage: 1, results: 1, menu: 1, __all: 1 }));
    localStorage.removeItem("izzbah-award-glow-v1");
  } catch (e) {}
});
const clickText = (t) => page.evaluate(txt => {
  const el = [...document.querySelectorAll("button, .btn, a, .wlc-start")].find(x => x.textContent.trim().includes(txt));
  if (el) { el.click(); return true; } return false;
}, t);

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true); state.isAdmin = true;
    // stub the cloud text-override writer so edit-mode has an admin bridge
    window.__savedText = null;
    window.IZZBAH.saveTextConfig = (map) => { window.__savedText = JSON.parse(JSON.stringify(map)); return Promise.resolve(true); };
  });

  // ── Category counter (step 8): persistent «N / ٦» + button pill ──
  await clickText("ابدأ"); await page.waitForTimeout(400);
  await clickText("إنشاء لعبة جديدة"); await page.waitForTimeout(700);
  const counter = await page.evaluate(() => {
    // deterministic pick of exactly 3 categories, then re-render
    state.selected = new Set();
    const all = (typeof visibleCategoryGroup === "function") ? visibleCategoryGroup() : [];
    all.slice(0, 3).forEach(c => state.selected.add(c.id));
    renderCategories();
    const st = document.getElementById("categoryStatus");
    const go = document.getElementById("goTeams");
    return {
      frac: !!st.querySelector(".cat-count-frac"),
      txt: st.textContent.replace(/\s+/g, " ").trim(),
      pill: (go.querySelector(".cat-count-pill") || {}).textContent || "",
      goDisabled: go.disabled
    };
  });
  check("category status shows a «N / 6» fraction chip", counter.frac && /3 \/ 6 مختارة/.test(counter.txt));
  check("the proceed button carries a live count pill", /3/.test(counter.pill) && /6/.test(counter.pill));
  check("proceed is enabled once at least one category is picked", counter.goDisabled === false);

  // ── Teams setup: the start button lives in a pinned sticky bar ──
  await clickText("اختيار الفرق"); await page.waitForTimeout(500);
  const setup = await page.evaluate(() => {
    const sticky = document.querySelector("#setup .setup-sticky");
    const start = document.getElementById("startGame");
    const shell = document.querySelector("#setup .setup-shell");
    return {
      inSticky: !!(sticky && start && sticky.contains(start)),
      shellScrolls: shell ? getComputedStyle(shell).overflowY : "",
      setupOverflow: getComputedStyle(document.getElementById("setup")).overflow,
      startVisible: !!(start && start.getBoundingClientRect().height > 0)
    };
  });
  check("the «ابدأ اللعبة» button sits inside the pinned sticky bar", setup.inSticky);
  check("the setup shell scrolls independently, the screen itself does not", setup.shellScrolls === "auto" && setup.setupOverflow === "hidden");
  check("the start button is rendered and visible", setup.startVisible);

  // ── Award-button one-time glow (first reveal only) ──
  await clickText("ابدأ اللعبة"); await page.waitForTimeout(900);
  const firstReveal = await page.evaluate(() => {
    const card = document.querySelector(".board-category-card");
    const cell = card && card.querySelector(".cell:not(.used)");
    if (cell) cell.click();
    return new Promise(res => setTimeout(() => {
      const b = document.getElementById("revealAnswer"); if (b) b.click();
      setTimeout(() => res({
        glow: document.querySelectorAll("#awardRow .team-award.award-glow").length,
        awards: document.querySelectorAll("#awardRow .team-award").length,
        flag: localStorage.getItem("izzbah-award-glow-v1")
      }), 250);
    }, 600));
  });
  check("the answer-award team buttons render", firstReveal.awards >= 2);
  check("the first-ever reveal glows the award buttons", firstReveal.glow >= 2);
  check("the one-time glow flag is set after the first reveal", firstReveal.flag === "1");

  // award the question, continue, then a SECOND reveal must NOT glow
  const secondReveal = await page.evaluate(() => {
    const a = document.querySelector("#awardRow .team-award"); if (a) a.click();
    const cont = document.getElementById("continueAnswer"); if (cont) cont.click();
    return new Promise(res => setTimeout(() => {
      const card = document.querySelector(".board-category-card");
      const cell = card && card.querySelector(".cell:not(.used)");
      if (cell) cell.click();
      setTimeout(() => {
        const b = document.getElementById("revealAnswer"); if (b) b.click();
        setTimeout(() => res({ glow: document.querySelectorAll("#awardRow .team-award.award-glow").length }), 250);
      }, 500);
    }, 400));
  });
  check("a later reveal does NOT glow again (fires once)", secondReveal.glow === 0);

  // ── Settings sheet section headers (step 7) ──
  const settings = await page.evaluate(() => {
    showScreen("game", { keepQuestion: true });
    const g = document.getElementById("userSettingsBtn"); if (g) g.click();
    const secs = [...document.querySelectorAll("#settingsModal .settings-section")].map(s => s.textContent.trim());
    return { count: secs.length, secs };
  });
  await page.waitForTimeout(150);
  check("the settings sheet is grouped under section headers", settings.count >= 3);
  check("the section headers name account, game, and news groups",
    settings.secs.some(s => /الحساب/.test(s)) && settings.secs.some(s => /اللعبة/.test(s)) && settings.secs.some(s => /الأخبار|الدعم/.test(s)));

  // ── Admin «تحرير النصوص» edit-mode: reword any UI text live ──
  await page.evaluate(() => { const c = document.querySelector("#settingsModal .close, #settingsClose"); if (c) c.click(); showScreen("setup"); });
  await page.waitForTimeout(300);
  // apply an override the way the boot loader does — text swaps live everywhere
  const applied = await page.evaluate(() => {
    window.IZZBAH.applyTextConfig({ "ابدأ اللعبة": "يلا نبدأ" });
    return document.getElementById("startGame").textContent.trim();
  });
  check("applyTextConfig rewords matching UI text live", applied === "يلا نبدأ");
  // revert via empty config → original text restored on the touched node
  const reverted = await page.evaluate(() => {
    window.IZZBAH.applyTextConfig({});
    return document.getElementById("startGame").textContent.trim();
  });
  check("clearing the override restores the original text", reverted === "ابدأ اللعبة");

  // enter edit-mode → toolbar appears, text elements become tap-to-edit
  const entered = await page.evaluate(() => {
    window.IZZBAH.enterTextEdit();
    return {
      bar: !!document.querySelector(".text-edit-bar"),
      armed: document.body.classList.contains("text-edit-armed"),
      tagged: document.querySelectorAll("[data-izz-editable]").length > 0,
      startTagged: document.getElementById("startGame").hasAttribute("data-izz-editable")
    };
  });
  check("entering edit-mode shows the floating toolbar", entered.bar);
  check("edit-mode arms tap-to-edit and outlines text elements", entered.armed && entered.tagged && entered.startTagged);

  // tapping a text element (the setup title, away from the bottom bar) opens
  // the inline editor; saving writes the override
  await page.click("#setup .screen-title");
  await page.waitForTimeout(200);
  const popOpen = await page.evaluate(() => !!document.querySelector(".text-edit-pop"));
  check("tapping a text element opens the inline editor popover", popOpen);
  const saved = await page.evaluate(() => {
    const ta = document.querySelector(".text-edit-pop textarea");
    ta.value = "الفِرْقان";
    document.querySelector(".text-edit-pop .tep-save").click();
    return {
      live: document.querySelector("#setup .screen-title").textContent.trim(),
      saved: window.__savedText,
      popGone: !document.querySelector(".text-edit-pop"),
      bdGone: !document.querySelector(".text-edit-pop-backdrop")
    };
  });
  check("saving rewrites the on-screen text immediately", saved.live === "الفِرْقان");
  check("saving publishes the override to config/text (original → new)",
    saved.saved && saved.saved["الفِرَق"] === "الفِرْقان");
  check("saving closes the editor popover (no stuck popover)", saved.popGone && saved.bdGone);

  // reopen → «إلغاء» must also close it, and tapping the backdrop must dismiss
  const dismiss = await page.evaluate(() => {
    document.querySelector("#setup .screen-title").click();
    const openedA = !!document.querySelector(".text-edit-pop");
    document.querySelector(".text-edit-pop .tep-cancel").click();
    const afterCancel = !!document.querySelector(".text-edit-pop");
    document.querySelector("#setup .screen-title").click();
    const openedB = !!document.querySelector(".text-edit-pop");
    const bd = document.querySelector(".text-edit-pop-backdrop"); if (bd) bd.click();
    const afterBackdrop = !!document.querySelector(".text-edit-pop");
    return { openedA, afterCancel, openedB, afterBackdrop };
  });
  check("«إلغاء» closes the editor popover", dismiss.openedA && dismiss.afterCancel === false);
  check("tapping the backdrop dismisses the editor (never stacks a new one)",
    dismiss.openedB && dismiss.afterBackdrop === false);

  // navigate sub-mode lets the admin move around without editing
  const nav = await page.evaluate(() => {
    document.querySelector(".text-edit-bar .teb-toggle").click();
    return document.body.classList.contains("text-edit-armed");
  });
  check("the toolbar toggles a «navigate» sub-mode (clicks pass through)", nav === false);

  // exit cleans everything up
  const exited = await page.evaluate(() => {
    const bar = document.querySelector(".text-edit-bar");
    bar.querySelector(".teb-exit").click();
    return {
      bar: !!document.querySelector(".text-edit-bar"),
      tagged: document.querySelectorAll("[data-izz-editable]").length,
      cls: document.body.classList.contains("text-edit-on")
    };
  });
  check("exiting edit-mode removes the toolbar and all edit affordances", !exited.bar && exited.tagged === 0 && !exited.cls);

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
