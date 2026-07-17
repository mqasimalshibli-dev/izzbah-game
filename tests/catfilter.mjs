// Category-type filter: the admin assigns a «type» to each category, and the
// category-selection screen shows chips to filter by type. Cloud read/write is
// stubbed (Firebase is offline here); this drives the UI + filtering logic.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8343;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // pick three real categories to work with
  const cats = await page.evaluate(() => allCategories().filter(c => !c.community).slice(0, 3).map(c => ({ id: c.id, name: c.name })));

  // ---- 1) ADMIN: assign types, save hands the bridge the map ----
  const admin = await page.evaluate(async (cats) => {
    window.IZZBAH = window.IZZBAH || {};
    window.__saved = null;
    window.IZZBAH.loadCatFilter = () => Promise.resolve({ map: {} });
    window.IZZBAH.saveCatFilter = (map) => { window.__saved = map; return Promise.resolve(); };
    openCatFilterAdmin();
    await new Promise(r => setTimeout(r, 100));
    const open = document.getElementById("catFilterAdminModal").classList.contains("open");
    const rows = [...document.querySelectorAll("#catFilterList .catfilter-row")];
    const byName = (nm) => rows.find(r => r.querySelector(".cf-name").textContent === nm);
    // assign the first two categories "معلومات", the third "ترفيه"
    const set = (nm, val) => { const inp = byName(nm).querySelector("input"); inp.value = val; inp.dispatchEvent(new Event("input", { bubbles: true })); };
    set(cats[0].name, "معلومات"); set(cats[1].name, "معلومات"); set(cats[2].name, "ترفيه");
    document.getElementById("catFilterSave").click();
    await new Promise(r => setTimeout(r, 120));
    return { open, rowCount: rows.length, saved: window.__saved };
  }, cats);
  check("the admin category-type panel opens with a row per category", admin.open && admin.rowCount >= 3);
  check("saving hands the bridge the category→type map",
    admin.saved && admin.saved[cats[0].id] === "معلومات" && admin.saved[cats[1].id] === "معلومات" && admin.saved[cats[2].id] === "ترفيه");

  // ---- 2) PLAYER: chips appear on the category screen and filter ----
  const chips = await page.evaluate(async (cats) => {
    state.catTypes = { map: { [cats[0].id]: "معلومات", [cats[1].id]: "معلومات", [cats[2].id]: "ترفيه" } };
    state.categoryMode = "game";
    state.activeCatFilter = "";
    showScreen("categories"); renderCategories();
    const row = document.getElementById("catFilterRow");
    const labels = [...row.querySelectorAll(".cat-filter-chip")].map(c => c.textContent);
    return { hidden: row.hidden, labels };
  }, cats);
  check("the filter row shows «الكل» + each admin-defined type", !chips.hidden
    && chips.labels[0] === "الكل" && chips.labels.includes("معلومات") && chips.labels.includes("ترفيه"));

  const filtered = await page.evaluate(async (cats) => {
    // click the "ترفيه" chip
    const row = document.getElementById("catFilterRow");
    [...row.querySelectorAll(".cat-filter-chip")].find(c => c.textContent === "ترفيه").click();
    await new Promise(r => setTimeout(r, 60));
    const names = [...document.querySelectorAll("#categoryGrid .cat-name-pill")].map(n => n.textContent);
    return { activeVal: state.activeCatFilter, shows3rd: names.includes(cats[2].name), shows1st: names.includes(cats[0].name), count: names.length };
  }, cats);
  check("clicking a type shows only its categories (the ترفيه one, not the معلومات ones)",
    filtered.activeVal === "ترفيه" && filtered.shows3rd && !filtered.shows1st && filtered.count === 1);

  const all = await page.evaluate(async (cats) => {
    const row = document.getElementById("catFilterRow");
    [...row.querySelectorAll(".cat-filter-chip")].find(c => c.textContent === "الكل").click();
    await new Promise(r => setTimeout(r, 60));
    const names = [...document.querySelectorAll("#categoryGrid .cat-name-pill")].map(n => n.textContent);
    return { showsBoth: names.includes(cats[0].name) && names.includes(cats[2].name) };
  }, cats);
  check("«الكل» clears the filter and shows every category again", all.showsBoth);

  // ---- 3) the filter is game-tab only + hidden when no types are set ----
  const tabScope = await page.evaluate(() => {
    state.categoryMode = "community"; renderCategories();
    const communityHidden = document.getElementById("catFilterRow").hidden;
    state.categoryMode = "game";
    state.catTypes = { map: {} }; renderCategories(); // no types assigned
    const noTypesHidden = document.getElementById("catFilterRow").hidden;
    return { communityHidden, noTypesHidden };
  });
  check("the filter is hidden on the community tab", tabScope.communityHidden);
  check("the filter is hidden when no types are assigned", tabScope.noTypesHidden);

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
