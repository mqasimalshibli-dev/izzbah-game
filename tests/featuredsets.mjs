// Recommended sets in «ألعابنا» (admin-curated, config/featuredSets). Players
// see the curated bundles and tap one to pre-select its categories; the admin
// authoring panel writes them. Offline — Firebase aborted, bridges stubbed.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8353;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 430, height: 920 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1");
  localStorage.setItem("izzbah-coach-v1", JSON.stringify({ __all: 1 })); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH && typeof window.IZZBAH.applyFeaturedSets === "function", { timeout: 15000 });
  await page.waitForTimeout(300);

  // seed 3 sets: valid, partially-valid (one bogus cat), all-bogus (must hide)
  const ids = await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "u1"); window.IZZBAH.applyAdmin(true); state.isAdmin = true; state.signedIn = true;
    const pool = officialCategoryPool();
    const ids = pool.map(c => c.id);
    window.IZZBAH.applyFeaturedSets({
      a: { name: "سهرة العيلة", blurb: "مزيج خفيف.", icon: "🏠", cats: ids.slice(0, 4), order: 1, active: true },
      b: { name: "مجموعة ناقصة", icon: "🎬", cats: [ids[0], "___nope___"], order: 2, active: true },
      c: { name: "كلها محذوفة", icon: "❌", cats: ["___x___", "___y___"], order: 3, active: true },
      d: { name: "مطفأة", icon: "💤", cats: ids.slice(0, 3), order: 4, active: false }
    });
    return ids.slice(0, 4);
  });

  // ---- render in «ألعابنا» ----
  await page.evaluate(() => { state.gameLibraryMode = "our"; showScreen("gameLibrary"); renderGameLibrary(); });
  await page.waitForTimeout(200);
  const grid = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#gameLibraryList .featured-set-card")];
    return { count: cards.length, names: cards.map(c => (c.querySelector(".fs-title") || {}).textContent || "") };
  });
  check("active sets with available categories render as cards", grid.count === 2);
  check("a set whose categories are ALL missing is hidden", !grid.names.some(n => /كلها محذوفة/.test(n)));
  check("an inactive set is hidden from players", !grid.names.some(n => /مطفأة/.test(n)));
  check("a partially-valid set still shows (bad category dropped)", grid.names.some(n => /ناقصة/.test(n)));

  // ---- tapping a set pre-selects its categories and goes to the team page ----
  // Route CHANGED in build .277 (owner). It used to land on the category
  // picker, but a ready-made set has already made the only choice that screen
  // offers, so it was a screen with nothing to do between «ابدأ بهذه المجموعة»
  // and naming the teams.
  const tapped = await page.evaluate(async () => {
    startFeaturedSet("a");
    await new Promise(r => setTimeout(r, 500));
    return {
      selected: [...(state.selected || [])], name: state.currentGameName,
      screen: document.body.dataset.screen,
      onCategories: document.getElementById("categories").classList.contains("active"),
      teamNameInputs: [...document.querySelectorAll("#setup input")]
        .filter(i => !i.type || i.type === "text").length,
      setupReturn: state.setupReturn,
    };
  });
  check("tapping a set pre-selects exactly its categories", tapped.selected.length === 4 && tapped.selected.every(id => ids.includes(id)));
  check("tapping a set pre-fills the game name", tapped.name === "سهرة العيلة");
  check(`tapping a set goes straight to the team-name page (${tapped.screen})`,
    tapped.screen === "setup" && !tapped.onCategories);
  check(`...with the team name fields ready (${tapped.teamNameInputs})`, tapped.teamNameInputs >= 2);
  // the set came from the library, so «رجوع» must return there rather than to
  // a category picker that was never part of this route
  check(`...and «رجوع» goes back to the library (${tapped.setupReturn})`,
    tapped.setupReturn === "gameLibrary");

  // ---- admin authoring panel writes a shape-clamped map ----
  const saved = await page.evaluate(() => {
    window.__savedFeatured = null;
    window.IZZBAH.saveFeaturedSets = (m) => { window.__savedFeatured = JSON.parse(JSON.stringify(m)); return Promise.resolve(true); };
    window.IZZBAH.openFeaturedAdmin();
    // existing 2 valid sets seed the draft (a, b); add a new one
    document.getElementById("featuredAddBtn").click();
    const lastRow = () => { const r = [...document.querySelectorAll(".fs-row")]; return r[r.length - 1]; };
    const nameIn = lastRow().querySelector(".fs-name-in");
    nameIn.value = "مجموعة جديدة";
    nameIn.dispatchEvent(new Event("input", { bubbles: true }));
    // ticking a category re-renders the row, so re-query before each click
    lastRow().querySelectorAll(".fs-cat-opt input")[0].click();
    lastRow().querySelectorAll(".fs-cat-opt input")[1].click();
    document.getElementById("featuredAdminSave").click();
    return window.__savedFeatured;
  });
  await page.waitForTimeout(100);
  const savedAfter = await page.evaluate(() => window.__savedFeatured);
  const newSet = savedAfter && Object.values(savedAfter).find(s => s.name === "مجموعة جديدة");
  check("the admin editor saves a new set to config/featuredSets", !!newSet);
  check("a saved set carries its picked categories (≤6)", newSet && Array.isArray(newSet.cats) && newSet.cats.length === 2);
  check("every saved set has a name and at least one category",
    savedAfter && Object.values(savedAfter).every(s => s.name && s.cats && s.cats.length));

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
