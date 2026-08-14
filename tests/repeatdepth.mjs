// «تكرار بعد N ألعاب» — how long a category lasts before it repeats itself.
//
// The board draws exactly ONE cell per point tier (categoryTiers), so a new game
// eats one question from every tier. The THINNEST tier is therefore what runs
// dry first, and it alone sets the category's life — the total count says
// nothing about it. Measured on the live catalogue: «حنكة عمانية» holds 105
// questions and repeats on game 7 (6 at the 100 tier); «أفلام أجنبية» holds 119
// and repeats on game 8. Both look healthy by total.
//
// This pins the arithmetic, because the whole point of the badge is that an
// admin trusts it instead of reading the totals.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8409;
const checks = [];
const check = (n, ok, note) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${note ? `  — ${note}` : ""}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
await page.route("**/firebasejs/**", r => r.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH_TEST && window.IZZBAH_TEST.repeatDepth, { timeout: 15000 });

  const r = await page.evaluate(() => {
    const d = window.IZZBAH_TEST.repeatDepth;
    const w = window.IZZBAH_TEST.gamesWord;
    // Build `n` questions on one tier.
    const tier = (points, n, text) => Array.from({ length: n }, (_, i) => ({ points, q: text === undefined ? `س${i}` : text, a: "ج" }));
    const cat = (spec) => Object.entries(spec).flatMap(([p, n]) => tier(Number(p), n));

    return {
      // The real shapes measured in the live catalogue.
      deen:     d(cat({ 100: 1, 200: 1, 300: 1, 400: 1, 500: 1 })),
      harem:    d(cat({ 100: 2, 200: 2, 300: 2, 400: 2, 500: 1 })),
      scorer:   d(cat({ 100: 18, 200: 3, 300: 4, 400: 4, 500: 2 })),
      hanka:    d(cat({ 100: 6, 200: 18, 300: 38, 400: 31, 500: 12 })),
      films:    d(cat({ 100: 7, 200: 22, 300: 38, 400: 28, 500: 24 })),
      wordsAr:  d(cat({ 100: 50, 200: 50, 300: 50, 400: 50, 500: 50 })),
      // A tier that simply does not exist is not a shortage — the board omits
      // that row, so the category is SMALLER, never more repetitive.
      missing:  d(cat({ 100: 9, 300: 9, 500: 9 })),
      // Blank rows are padding, not content.
      padded:   d([...tier(100, 3), ...tier(100, 20, ""), ...tier(200, 9)]),
      // Junk points values can't create a phantom bottleneck of 1.
      junk:     d([...cat({ 100: 4, 200: 6 }), { points: 0, q: "x", a: "y" }, { points: null, q: "x", a: "y" }, { q: "x", a: "y" }]),
      empty:    d([]),
      noText:   d(tier(100, 5, "")),
      // Two tiers equally starved: name the cheaper one, so the label does not
      // flicker between them on re-render.
      tie:      d(cat({ 100: 3, 200: 3, 300: 40 })),
      words: [w(1), w(2), w(3), w(10), w(11)],
    };
  });

  check("a 5-question category repeats on the very next game  — دين", r.deen.games === 1, `${r.deen.games}`);
  check("...and there is no single tier to blame", r.deen.tier === 100);
  check("[2,2,2,2,1] lasts one game  — جلسة حريم", r.harem.games === 1 && r.harem.tier === 500, `tier ${r.harem.tier}`);
  check("a lopsided category is measured by its thin end, not its 18  — من الي سجل؟",
    r.scorer.games === 2 && r.scorer.tier === 500, `${r.scorer.games} games, tier ${r.scorer.tier}`);
  check("105 questions still only lasts 7 games  — حنكة عمانية",
    r.hanka.games === 6 && r.hanka.tier === 100, `${r.hanka.games} @ ${r.hanka.tier}`);
  check("119 questions still only lasts 8  — أفلام أجنبية",
    r.films.games === 7 && r.films.tier === 100, `${r.films.games} @ ${r.films.tier}`);
  check("an even 250 lasts 50 games  — وش الكلمة عربي", r.wordsAr.games === 50, `${r.wordsAr.games}`);
  check("a MISSING tier is not counted as a shortage", r.missing.games === 9, `${r.missing.games}`);
  check("blank rows do not inflate the depth", r.padded.games === 3 && r.padded.tier === 100, `${r.padded.games} @ ${r.padded.tier}`);
  check("...and are reported separately", r.padded.blanks === 20, `${r.padded.blanks}`);
  check("junk/absent points values create no phantom bottleneck", r.junk.games === 4 && r.junk.tier === 100, `${r.junk.games} @ ${r.junk.tier}`);
  check("an empty category reports zero, not Infinity", r.empty.games === 0 && r.empty.tier === null);
  check("a category of blanks reports zero", r.noText.games === 0 && r.noText.blanks === 5);
  check("a tie between two starved tiers names the cheaper one", r.tie.games === 3 && r.tie.tier === 100, `tier ${r.tie.tier}`);
  check("Arabic counts use the dual and switch at ten",
    r.words[0] === "لعبة واحدة" && r.words[1] === "لعبتين"
    && /ألعاب$/.test(r.words[2]) && /ألعاب$/.test(r.words[3]) && /لعبة$/.test(r.words[4]),
    r.words.join(" / "));

  // The badge itself: the three states have to be distinguishable at a glance.
  const badge = await page.evaluate(() => {
    // repeatDepthBadge is not bridged (it builds DOM); drive it through the
    // classes it sets by calling it via the same module scope the admin uses.
    const out = {};
    const mk = (n) => Array.from({ length: n }, () => ({ points: 100, q: "س", a: "ج" }))
      .concat(Array.from({ length: 40 }, () => ({ points: 200, q: "س", a: "ج" })));
    // 1 -> crit, 4 -> warn, 20 -> plain
    const d = window.IZZBAH_TEST.repeatDepth;
    out.crit = d(mk(1)).games;
    out.warn = d(mk(4)).games;
    out.fine = d(mk(20)).games;
    return out;
  });
  check("the three badge bands land where intended (≤2 crit, ≤5 warn, else plain)",
    badge.crit <= 2 && badge.warn > 2 && badge.warn <= 5 && badge.fine > 5,
    `${badge.crit}/${badge.warn}/${badge.fine}`);

  // ---- the rendered surfaces -------------------------------------------
  // The arithmetic above is only useful if the list actually feeds it the right
  // questions. It did not, at first: with no cloud override a built-in's
  // `.questions` is buildQuestionSet() — ONE per tier, a sampled board — so a
  // 135-question bank was measured as 5 and every healthy category rendered a
  // red «تكرار بعد لعبة واحدة». This pins the fix.
  const ui = await page.evaluate(async () => {
    const sleep = ms => new Promise(z => setTimeout(z, ms));
    const q = (points, i) => ({ points, q: `س${points}-${i}`, a: "ج", image: "", answerImage: "" });
    const mk = (id, name, spec) => ({
      id, name, custom: true,
      questions: Object.entries(spec).flatMap(([p, n]) =>
        Array.from({ length: n }, (_, i) => q(Number(p), i))),
    });
    state.publishedCategories = [
      // «حنكة عمانية» in miniature: healthy total, starved 100 tier.
      mk("depth-lopsided", "ملتوية", { 100: 6, 200: 18, 300: 38, 400: 31, 500: 12 }),
      // Same shape, one question thinner — this one is inside the amber band.
      mk("depth-warn", "تحذيرية", { 100: 5, 200: 18, 300: 38, 400: 31, 500: 12 }),
      // «دين»: one per tier.
      mk("depth-thin", "رقيقة", { 100: 1, 200: 1, 300: 1, 400: 1, 500: 1 }),
      // Healthy and even.
      mk("depth-deep", "عميقة", { 100: 50, 200: 50, 300: 50, 400: 50, 500: 50 }),
    ];
    if (window.IZZBAH.applyPublished) window.IZZBAH.applyPublished(state.publishedCategories);
    await sleep(250);
    renderAdminCategoryList();
    const pick = (id) => {
      const rows = Array.from(document.querySelectorAll("#customList .custom-row"));
      const name = { "depth-lopsided": "ملتوية", "depth-warn": "تحذيرية", "depth-thin": "رقيقة", "depth-deep": "عميقة" }[id];
      const row = rows.find(r => (r.textContent || "").includes(name));
      const b = row && row.querySelector(".ac-depth");
      return b ? { text: b.textContent, cls: b.className } : null;
    };
    // …and a built-in with a real bundled bank, which is the case that broke.
    const builtinRow = (() => {
      const withBank = builtinCategories.find(c => builtinQuestionBanks[c.id]
        && builtinEditableQuestions(c.id).length > 40);
      if (!withBank) return null;
      const rows = Array.from(document.querySelectorAll("#customList .custom-row"));
      const row = rows.find(r => (r.textContent || "").includes(withBank.name));
      const b = row && row.querySelector(".ac-depth");
      const bank = builtinEditableQuestions(withBank.id);
      return { name: withBank.name, bank: bank.length, expect: window.IZZBAH_TEST.repeatDepth(bank).games,
               text: b ? b.textContent : null, cls: b ? b.className : null };
    })();
    return { lop: pick("depth-lopsided"), warn: pick("depth-warn"), thin: pick("depth-thin"), deep: pick("depth-deep"), builtinRow };
  });

  check("the list renders a depth badge per category", !!(ui.lop && ui.thin && ui.deep));
  // 105 questions, 6 at the 100 tier: the badge must say SIX, not something
  // derived from the total. (Six is one game outside the amber band, which is
  // the point of the separate fixture below — the number is what matters here.)
  check("a lopsided category is measured by its thin tier, not its 105 total",
    ui.lop && /\b6\b/.test(ui.lop.text) && !/crit/.test(ui.lop.cls), ui.lop && `${ui.lop.text} [${ui.lop.cls}]`);
  check("...and one question thinner tips it into the amber band",
    ui.warn && /\b5\b/.test(ui.warn.text) && /warn/.test(ui.warn.cls), ui.warn && `${ui.warn.text} [${ui.warn.cls}]`);
  check("a one-per-tier category is critical", ui.thin && /crit/.test(ui.thin.cls), ui.thin && ui.thin.text);
  check("a deep category carries no warning colour",
    ui.deep && !/warn|crit/.test(ui.deep.cls), ui.deep && `${ui.deep.text} [${ui.deep.cls}]`);
  check("a built-in with a bundled bank is measured on the BANK, not on the board sample",
    ui.builtinRow && ui.builtinRow.expect > 5 && !/crit/.test(ui.builtinRow.cls || ""),
    ui.builtinRow ? `${ui.builtinRow.name}: bank ${ui.builtinRow.bank}, expect ${ui.builtinRow.expect}, got "${ui.builtinRow.text}"` : "no banked built-in found");

  check("no page errors", errs.length === 0, errs[0] || "");
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(`\n${failed ? `${failed} FAILED` : `all ${checks.length} checks passed`}`);
process.exit(failed ? 1 : 0);
