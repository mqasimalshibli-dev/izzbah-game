// A polish/optimization fix: official categories with NO playable questions
// (e.g. a category the admin created but hasn't filled yet) are hidden from the
// PLAYER category grid entirely, instead of sitting there forever as an
// unplayable «قريباً» card. They stay fully visible in the admin CMS, so adding
// one question brings the card straight back. Community categories are NOT
// filtered (an author still needs to see their own in-progress card).
//
// Also asserts the lazy/async image hints are present on the remote-image
// builders so long CMS lists and announcement galleries don't fetch/decode
// every image up front.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8390;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

// ---- static: the remote-image builders carry loading="lazy" decoding="async" ----
const html = readFileSync(join(ROOT, "game-mobile.html"), "utf8");
check("CMS question thumbnails are lazy + async-decoded",
  /<img class="q-thumb"[^>]*loading="lazy" decoding="async"/.test(html));
check("category thumbnails are lazy + async-decoded",
  /<img class="category-thumb"[^>]*loading="lazy" decoding="async"/.test(html));
check("announcement gallery images are lazy + async-decoded",
  /<img class="ann-card-img"[^>]*loading="lazy" decoding="async"/.test(html));

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

  // ---- an empty official category is hidden; a filled one still shows ----
  const game = await page.evaluate(() => {
    state.categoryMode = "game";
    state.publishedCategories = [
      { id: "filled-x", name: "فئة ممتلئة", custom: true, published: true,
        questions: [{ points: 100, q: "س", a: "ج" }] },
      { id: "empty-x", name: "فئة فارغة", custom: true, published: true, questions: [] },
    ];
    renderCategories();
    const names = [...document.querySelectorAll("#categoryGrid .cat-name-pill")].map(n => n.textContent.trim());
    return { names, filledShown: names.includes("فئة ممتلئة"), emptyShown: names.includes("فئة فارغة") };
  });
  check("a filled official category is shown in the player grid", game.filledShown);
  check("an EMPTY official category is hidden from the player grid", !game.emptyShown);

  // ---- adding a question brings the hidden category back ----
  const back = await page.evaluate(() => {
    const c = state.publishedCategories.find(x => x.id === "empty-x");
    c.questions = [{ points: 200, q: "س٢", a: "ج٢" }];
    renderCategories();
    const names = [...document.querySelectorAll("#categoryGrid .cat-name-pill")].map(n => n.textContent.trim());
    return names.includes("فئة فارغة");
  });
  check("adding a question brings the hidden category back into the grid", back);

  // ---- community keeps its «قريباً» card for an empty (in-progress) category ----
  const community = await page.evaluate(() => {
    state.communityCategories = [
      { id: "comm-empty", name: "مجتمع فارغ", community: true, questions: [] },
    ];
    state.customCategories = [];
    setCategoryMode("community");
    const names = [...document.querySelectorAll("#categoryGrid .cat-name-pill")].map(n => n.textContent.trim());
    const soon = !!document.querySelector("#categoryGrid .cat-soon");
    return { shown: names.includes("مجتمع فارغ"), soon };
  });
  check("an empty COMMUNITY category still appears (as «قريباً») so its author sees it",
    community.shown && community.soon);

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
