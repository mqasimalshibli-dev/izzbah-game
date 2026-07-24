// «إخفاء الفئة» — a SEPARATE, reversible admin control that pulls a category
// off every player's selection screen while keeping all its content, distinct
// from the permanent «حذف الفئة». Hiding is global (config/hidden): the admin
// toggle writes it, every player's picker reads it at boot.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8333;
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
  await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true); state.isAdmin = true;
    window.__hiddenSaved = null;
    window.IZZBAH.saveHidden = (map) => { window.__hiddenSaved = JSON.parse(JSON.stringify(map)); return Promise.resolve(true); };
    // a cloud (deletable) category + reset the hidden set
    state.publishedCategories = [{ id: "pub-h", name: "فئة سحابية", image: "", color: "#9e1322", custom: false, published: true, order: 0,
      questions: [{ points: 100, q: "س؟", a: "ج", image: "", answerImage: "" }] }];
    state.hiddenCategories = []; saveHiddenCategories();
  });
  await page.evaluate(() => { document.getElementById("adminEntry").click(); });
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById("adminChoiceContent").click());
  await page.waitForTimeout(400);

  // ---- a cloud category head shows BOTH controls, side by side ----
  await page.evaluate(() => {
    state.adminCat = state.publishedCategories.find(c => c.id === "pub-h");
    populateAdminFilter(); renderAdminTable(); renderAdminCatHead();
  });
  await page.waitForTimeout(150);
  let head = await page.evaluate(() => ({
    hide: !!document.querySelector(".ac-hide"),
    hideText: (document.querySelector(".ac-hide") || {}).textContent || "",
    del: !!document.querySelector(".ac-delete"),
    delText: (document.querySelector(".ac-delete") || {}).textContent || ""
  }));
  check("a cloud category shows a SEPARATE hide button and a delete button",
    head.hide && head.del && /إخفاء الفئة/.test(head.hideText) && /حذف/.test(head.delText));

  // ---- hiding: pulls it from the picker + publishes globally, keeps content ----
  const afterHide = await page.evaluate(() => {
    const before = visibleCategoryGroup().some(c => c.id === "pub-h");
    document.querySelector(".ac-hide").click();
    const inPicker = visibleCategoryGroup().some(c => c.id === "pub-h");
    const stillExists = state.publishedCategories.some(c => c.id === "pub-h"); // content intact
    return { before, inPicker, stillExists, saved: window.__hiddenSaved, btn: (document.querySelector(".ac-hide") || {}).textContent || "" };
  });
  check("before hiding, the category IS on the player's selection screen", afterHide.before);
  check("hiding removes it from the selection screen for players", afterHide.inPicker === false);
  check("hiding does NOT delete the category (content stays intact)", afterHide.stillExists === true);
  check("hiding publishes the choice globally (config/hidden gets the id)",
    afterHide.saved && afterHide.saved["pub-h"] === true);
  check("the button flips to «إظهار الفئة» after hiding", /إظهار الفئة/.test(afterHide.btn));

  // ---- showing again: back on the picker, id removed from the global map ----
  const afterShow = await page.evaluate(() => {
    document.querySelector(".ac-hide").click();
    return { inPicker: visibleCategoryGroup().some(c => c.id === "pub-h"),
             saved: window.__hiddenSaved, btn: (document.querySelector(".ac-hide") || {}).textContent || "" };
  });
  check("showing returns the category to the selection screen", afterShow.inPicker === true);
  check("showing removes the id from the global hidden map", !(afterShow.saved && afterShow.saved["pub-h"]));
  check("the button flips back to «إخفاء الفئة»", /إخفاء الفئة/.test(afterShow.btn));

  // ---- a built-in category: hide only, NO delete ----
  const builtin = await page.evaluate(() => {
    const b = builtinCategories[0];
    state.adminCat = adminCloneCategory(b.id) || { id: b.id, name: b.name, questions: [], custom: false };
    renderAdminCatHead();
    return { id: b.id, hide: !!document.querySelector(".ac-hide"), del: !!document.querySelector(".ac-delete") };
  });
  check("a built-in category can be hidden but NOT deleted (hide present, delete absent)",
    builtin.hide && builtin.del === false);

  // ---- the boot loader applies the global hidden set for every player ----
  const boot = await page.evaluate(async () => {
    window.IZZBAH.loadHidden = () => Promise.resolve({ map: { "pub-h": true } });
    await loadHiddenConfig();
    return { hidden: isCategoryHidden("pub-h"), inPicker: visibleCategoryGroup().some(c => c.id === "pub-h") };
  });
  check("at boot, loadHidden hides the category on every device", boot.hidden && boot.inPicker === false);

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
