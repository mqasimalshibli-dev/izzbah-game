// Perceived-speed polish:
//  1) the community grid shows shimmer skeleton cards while the cloud pool is
//     still loading, and swaps to a warm empty state once it answers;
//  2) a no-match search shows the warm empty state (icon + title), keeping the
//     .category-empty hook other tests rely on;
//  3) a remote question image holds a media-loading shimmer until it loads,
//     while an instant data: URL never flashes it.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8358;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 900, height: 620 }, deviceScaleFactor: 1 });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1");
  localStorage.setItem("izzbah-coach-v1", JSON.stringify({ __all: 1 })); } catch (e) {} });
const clickText = (t) => page.evaluate(txt => { const el = [...document.querySelectorAll("button,.btn,a,.wlc-start")].find(x => x.textContent.trim().includes(txt)); if (el) { el.click(); return true; } return false; }, t);

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH && typeof window.IZZBAH.applyAuth === "function", { timeout: 15000 });
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.IZZBAH.applyAuth(true, "u1"); window.IZZBAH.applyAdmin(true); state.isAdmin = true; state.signedIn = true; });
  await clickText("ابدأ"); await page.waitForTimeout(300);
  await clickText("إنشاء لعبة جديدة"); await page.waitForTimeout(500);

  // ---- 1) community grid: skeletons while loading ----
  const loading = await page.evaluate(() => {
    state.communityLoaded = false;
    state.communityCategories = [];
    state.categoryMode = "community";
    renderCategories();
    return {
      skeletons: document.querySelectorAll("#categoryGrid .cat-skeleton").length,
      empty: !!document.querySelector("#categoryGrid .cat-empty-rich"),
      sr: !!document.querySelector("#categoryGrid ~ *, #categoryGrid .sr-only") || !!document.querySelector("[role=status]")
    };
  });
  check("community grid shows shimmer skeleton cards while loading", loading.skeletons >= 3);
  check("no premature empty state while still loading", !loading.empty);

  // ---- 2) once the cloud answers (empty) → warm empty state, no skeletons ----
  const answered = await page.evaluate(() => {
    window.IZZBAH.applyCommunity([]); // cloud responded with an empty pool
    return {
      loaded: state.communityLoaded,
      skeletons: document.querySelectorAll("#categoryGrid .cat-skeleton").length,
      rich: !!document.querySelector("#categoryGrid .cat-empty-rich"),
      hasIcon: !!document.querySelector("#categoryGrid .cat-empty-ico svg"),
      hasCta: !!document.getElementById("catEmptyCreate")
    };
  });
  check("the cloud answer clears the skeletons", answered.loaded && answered.skeletons === 0);
  check("empty community pool shows a warm empty state (icon + CTA)", answered.rich && answered.hasIcon && answered.hasCta);

  // ---- 3) search no-match warm empty keeps the .category-empty hook ----
  const search = await page.evaluate(() => {
    state.categoryMode = "game";
    state.catSearch = "زقنبوتيا";
    renderCategories();
    const e = document.querySelector("#categoryGrid .category-empty");
    return { hook: !!e, rich: !!document.querySelector("#categoryGrid .cat-empty-rich"),
      text: e ? e.textContent : "", cards: document.querySelectorAll("#categoryGrid .cat-name-pill").length };
  });
  check("no-match search keeps the .category-empty hook, now warmer", search.hook && search.rich && /لا توجد فئة/.test(search.text) && search.cards === 0);

  // ---- 4) media shimmer: remote holds it, data: URL does not ----
  const media = await page.evaluate(() => {
    state.catSearch = "";
    const q = document.getElementById("modalQuestionImage");
    showMedia(q, "https://example.com/pic.png", "question");
    const remoteHasShim = q.classList.contains("media-loading");
    const a = document.getElementById("modalAnswerImage");
    showMedia(a, "data:image/png;base64,iVBORw0KGgo=", "answer");
    const dataHasShim = a.classList.contains("media-loading");
    return { remoteHasShim, dataHasShim };
  });
  check("a remote image holds the shimmer until it loads", media.remoteHasShim);
  check("an instant data: image never flashes the shimmer", !media.dataHasShim);

  // ---- 5) game library «ألعابنا»: skeletons while featured sets load ----
  const glib = await page.evaluate(() => {
    window.IZZBAH.applyFeaturedSets({});   // clears featuredSets, flips featuredLoaded true
    state.featuredLoaded = false;          // pretend the cloud hasn't answered yet
    state.gameLibraryMode = "our";
    showScreen("gameLibrary"); renderGameLibrary();
    const loading = { sk: document.querySelectorAll("#gameLibraryList .gl-skeleton").length,
      empty: !!document.querySelector("#gameLibraryList .gl-empty") };
    const ids = officialCategoryPool().slice(0, 3).map(c => c.id);
    window.IZZBAH.applyFeaturedSets({ s1: { name: "مجموعة تجريبية", cats: ids, active: true, order: 1 } });
    const cards = document.querySelectorAll("#gameLibraryList .featured-set-card").length;
    const stillSk = document.querySelectorAll("#gameLibraryList .gl-skeleton").length;
    return { loading, cards, stillSk };
  });
  check("game library shows skeleton cards while featured sets load", glib.loading.sk >= 1 && !glib.loading.empty);
  check("the cloud answer replaces skeletons with real set cards", glib.cards >= 1 && glib.stillSk === 0);

  // ---- 6) announcements: skeleton while loading → empty message after ----
  const ann = await page.evaluate(() => {
    const c = document.getElementById("announceList");
    state.announcementsLoaded = false; state.announcements = []; state.inbox = [];
    renderAnnouncementCards(c, [], true);
    const loading = !!c.querySelector(".sk-wrap");
    state.announcementsLoaded = true;
    renderAnnouncementCards(c, [], true);
    const empty = !!c.querySelector(".announce-empty");
    return { loading, empty };
  });
  check("announcements show a skeleton while the feed loads", ann.loading);
  check("announcements fall back to the empty message once loaded", ann.empty);

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
