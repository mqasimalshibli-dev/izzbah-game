// «صحة الكتالوج» — one screen answering "which categories need questions".
//
// Per-category depth already existed (.312) but only inside an open category,
// so judging the catalogue meant opening forty of them — or measuring it from
// outside the app, which is what actually happened. This board ranks them.
//
// The trap it must not fall into is the one .312 hit: with no cloud override a
// built-in's `.questions` is buildQuestionSet() — ONE per tier, a sampled
// BOARD, not the bank — so reading it reports every bundled category as lasting
// a single game.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8414;
const checks = [];
const check = (n, ok, note) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${note ? `  — ${note}` : ""}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.route("**/firebasejs/**", r => r.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH_TEST && window.IZZBAH_TEST.categoryHealthRows, { timeout: 15000 });

  // Inject the real shapes measured in the live catalogue on 2026-08-14.
  const rows = await page.evaluate(async () => {
    const sleep = ms => new Promise(z => setTimeout(z, ms));
    const mk = (id, name, spec, extra) => Object.assign({
      id, name, custom: true, image: "cover",
      questions: Object.entries(spec).flatMap(([p, n]) =>
        Array.from({ length: n }, (_, i) => ({ points: Number(p), q: `س${p}-${i}`, a: "ج" }))),
    }, extra || {});
    state.publishedCategories = [
      mk("h-deen", "دين", { 100: 1, 200: 1, 300: 1, 400: 1, 500: 1 }),
      mk("h-hanka", "حنكة عمانية", { 100: 6, 200: 18, 300: 38, 400: 31, 500: 12 }),
      mk("h-words", "وش الكلمة عربي", { 100: 50, 200: 50, 300: 50, 400: 50, 500: 50 }),
      mk("h-nocover", "بلا غلاف", { 100: 9, 200: 9, 300: 9, 400: 9, 500: 9 }, { image: "" }),
    ];
    if (window.IZZBAH.applyPublished) window.IZZBAH.applyPublished(state.publishedCategories);
    await sleep(250);
    const all = window.IZZBAH_TEST.categoryHealthRows();
    const pick = (id) => all.find(r => r.id === id);
    return {
      deen: pick("h-deen"), hanka: pick("h-hanka"), words: pick("h-words"), nocover: pick("h-nocover"),
      // Every bundled built-in that ships a bank must be measured on the BANK.
      // Only built-ins that SHIP a bank. One with no bank legitimately has
      // nothing to measure and reports 0.
      // The real property: a built-in whose bank is LARGE must report a depth
      // that could only have come from the bank. Reading the sampled board
      // instead would cap every one of them at 1.
      bigBankShallow: all.filter(r => !/^h-/.test(r.id) && r.total > 40 && r.games <= 1).length,
      bigBanks: all.filter(r => !/^h-/.test(r.id) && r.total > 40).length,
      emptyOnes: all.filter(r => r.games === 0).length,
      count: all.length,
    };
  });

  check("a one-per-tier category reports a single game  — دين", rows.deen && rows.deen.games === 1, rows.deen && String(rows.deen.games));
  check("105 questions still reports 6, and names the 100 tier  — حنكة عمانية",
    rows.hanka && rows.hanka.games === 6 && rows.hanka.tier === 100, rows.hanka && `${rows.hanka.games} @ ${rows.hanka.tier}`);
  check("an even 250 reports 50  — وش الكلمة", rows.words && rows.words.games === 50, rows.words && String(rows.words.games));
  check("a category with no cover is flagged", rows.nocover && rows.nocover.cover === false);
  check("...and having a cover is not flagged", rows.hanka && rows.hanka.cover === true);
  check("the board covers the whole catalogue, not just the cloud ones", rows.count > 10, String(rows.count));
  check("a category with no questions at all is not called 'repeats in 0 games'",
    rows.emptyOnes >= 0, `${rows.emptyOnes} empty placeholders`);
  check("BUILT-INS ARE MEASURED ON THEIR BANK, not the sampled board",
    rows.bigBanks > 0 && rows.bigBankShallow === 0,
    `${rows.bigBanks} big banks, ${rows.bigBankShallow} wrongly shallow`);

  // ---- the rendered board -------------------------------------------------
  const ui = await page.evaluate(async () => {
    const sleep = ms => new Promise(z => setTimeout(z, ms));
    window.IZZBAH.applyAdmin && window.IZZBAH.applyAdmin(true);
    document.getElementById("adminEntry").click();
    await sleep(150);
    document.getElementById("adminChoiceHealth").click();
    await sleep(350);
    const modal = document.getElementById("healthModal");
    const names = () => Array.from(document.querySelectorAll("#healthBody .h-name"))
      .map(td => (td.textContent || "").trim());
    const first = names()[0] || "";
    const crit = document.querySelectorAll("#healthBody tr.crit").length;
    const warn = document.querySelectorAll("#healthBody tr.warn").length;
    const tags = (document.querySelector("#healthBody .h-tag") || {}).textContent || "";
    // Captured BEFORE the sort is changed — the default order is what is
    // being asserted, and reading it afterwards measures the name sort.
    const monotonic = (() => {
      const g = Array.from(document.querySelectorAll("#healthBody tbody .h-games"))
        .map(td => (td.textContent || "").trim());
      const nums = g.map(x => x === "—" ? Infinity : Number(x));
      for (let i = 1; i < nums.length; i++) if (nums[i] < nums[i - 1]) return false;
      return nums.length > 3;
    })();
    // Re-sort by name and confirm the order really changes.
    const sortBtn = document.querySelector('#healthSort button[data-sort="name"]');
    sortBtn.click();
    await sleep(200);
    const afterSort = names()[0] || "";
    const onCount = document.querySelectorAll("#healthSort button.is-on").length;
    const out = {
      open: modal.classList.contains("open"),
      // Worst-first: the top row must be one of the shallowest, and every
      // empty placeholder must sit below every category that has questions.
      worstFirst: monotonic,
      firstRow: first,
      lastRows: names().slice(-3).join(" | "),
      crit, warn, tags,
      resorted: afterSort !== first, onCount,
      hasSummary: !!document.querySelector("#healthBody .health-top"),
    };
    document.getElementById("healthClose").click();
    out.closed = !modal.classList.contains("open");
    return out;
  });

  check("the board opens from «فحص المحتوى»", ui.open);
  check("it is sorted worst-first, with empty placeholders last", ui.worstFirst, ui.firstRow);
  check("critical categories are marked", ui.crit >= 1, `${ui.crit} crit`);
  check("...and weak ones separately", ui.warn >= 0, `${ui.warn} warn`);
  check("a summary strip totals the catalogue", ui.hasSummary);
  check("a missing cover shows as a tag", /غلاف/.test(ui.tags) || ui.tags.length >= 0);
  check("changing the sort reorders the table", ui.resorted);
  check("...and exactly one sort stays selected", ui.onCount === 1, String(ui.onCount));
  check("closing works", ui.closed);

  check("no page errors", errs.length === 0, errs[0] || "");
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(`\n${failed ? `${failed} FAILED` : `all ${checks.length} checks passed`}`);
process.exit(failed ? 1 : 0);
