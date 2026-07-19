// Category-screen search box: filters the grid by name (Arabic-normalized),
// sits under the game-name box, has a clear button and a no-results message.
// Also checks the share button is gone and the name pills are the bright
// (cream) style with dark text.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8367;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1000, height: 950 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

const names = () => page.evaluate(() =>
  [...document.querySelectorAll("#categoryGrid .cat-name-pill")].map(n => n.textContent));

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.IZZBAH.applyAuth(true); openNewGameCategories(); });
  await page.waitForTimeout(300);

  // ---- 0) the search box sits under the game-name box; share button is gone
  const layout = await page.evaluate(() => {
    const gnb = document.querySelector(".game-name-box");
    const search = document.querySelector(".cat-search");
    return {
      hasSearch: !!search,
      underName: !!(gnb && search) && (search.getBoundingClientRect().top >= gnb.getBoundingClientRect().bottom - 2),
      placeholder: search ? search.querySelector("input").placeholder : "",
      shareGone: !document.getElementById("shareGameBtn"),
    };
  });
  check("a category search box exists, placed under the game-name box", layout.hasSearch && layout.underName);
  check("the search box prompts to search by name", /ابحث/.test(layout.placeholder) && /فئة/.test(layout.placeholder));
  check("the «شارك اللعبة» button was removed from the category screen", layout.shareGone);

  // ---- 1) the pills are the BRIGHT (cream) style with dark text ----
  const pill = await page.evaluate(() => {
    const p = document.querySelector("#categoryGrid .cat-name-pill");
    if (!p) return null;
    const cs = getComputedStyle(p);
    const rgb = cs.color.match(/\d+/g).map(Number);
    const bg = cs.backgroundImage + " " + cs.backgroundColor;
    return { dark: rgb[0] < 150 && rgb[1] < 90 && rgb[2] < 90, bg };
  });
  check("category name pills use DARK text", pill && pill.dark);
  check("category name pills are BRIGHT (cream gradient, not the old red)", pill && /251|243|248|253/.test(pill.bg));

  // ---- 2) searching narrows the grid by name ----
  const all = (await names()).length;
  check("the grid shows many categories before searching", all > 5);

  await page.fill("#catSearchInput", "تاريخ");
  await page.waitForTimeout(200);
  const hist = await names();
  check("searching «تاريخ» shows only matching categories", hist.length >= 1 && hist.every(n => n.includes("تاريخ")));

  // ---- 3) Arabic-normalized: «عمان» matches «عُمان» (harakat-insensitive) ----
  await page.fill("#catSearchInput", "عمان");
  await page.waitForTimeout(200);
  const oman = await names();
  check("searching «عمان» matches diacritic variants", oman.length >= 1);

  // ---- 3b) prefix-only: a letter in the MIDDLE of a word no longer matches ----
  // «واقع» sits inside «مواقع في عمان» but isn't a prefix of any word, so with
  // first-letter (prefix) search it must NOT surface that category.
  await page.fill("#catSearchInput", "واقع");
  await page.waitForTimeout(200);
  const mid = await names();
  check("a mid-word substring («واقع») does NOT match «مواقع…» (prefix search)", !mid.some(n => n.includes("مواقع")));

  // ---- 4) a no-match search shows a friendly message ----
  await page.fill("#catSearchInput", "زقنبوتيا");
  await page.waitForTimeout(200);
  const empty = await page.evaluate(() => {
    const e = document.querySelector("#categoryGrid .category-empty");
    return { shown: !!e, cards: document.querySelectorAll("#categoryGrid .cat-name-pill").length, text: e ? e.textContent : "" };
  });
  check("a no-result search shows a message and no cards", empty.shown && empty.cards === 0 && /لا توجد فئة/.test(empty.text));

  // ---- 5) the clear button resets the search ----
  const cleared = await page.evaluate(async () => {
    document.getElementById("catSearchClear").click();
    await new Promise(r => setTimeout(r, 150));
    return { val: document.getElementById("catSearchInput").value, cards: document.querySelectorAll("#categoryGrid .cat-name-pill").length };
  });
  check("clearing the search restores the full grid", cleared.val === "" && cleared.cards > 5);

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
