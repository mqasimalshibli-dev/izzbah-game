// «مصطلحات عربية»: the prompt defines a term and the FIRST LETTER of the answer
// is shown automatically (derived from the answer, so it can never drift out of
// sync with an edit). The first-letter lifeline is therefore hidden — spending
// it would buy nothing — while four-choices stays available.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8399;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ---- the category ships live, with a self-contained cover ----------------
  const cat = await page.evaluate(() => {
    refreshBuiltinQuestions();
    const c = categoryById("arabicTerms");
    if (!c) return null;
    const qs = c.questions || [];
    const bank = builtinQuestionBanks.arabicTerms || {};
    return {
      name: c.name,
      count: qs.length,
      bankTotal: Object.values(bank).reduce((n, list) => n + (list || []).length, 0),
      bankPerTier: Object.keys(bank).map(p => (bank[p] || []).length),
      tiers: [...new Set(qs.map(q => q.points))].sort((a, b) => a - b),
      svgCover: /^data:image\/svg\+xml/.test(c.image || ""),
      everyHasAnswer: qs.every(q => q.q && q.a),
      everyAsksTerm: qs.every(q => /المصطلح/.test(q.q)),
      distractors: qs.every(q => Array.isArray(q.distractors) && q.distractors.length === 3),
      // no question may hand-write the hint — it is derived at render time
      noHardcodedHint: qs.every(q => !/يبدأ بحرف|أول حرف/.test(q.q)),
    };
  });
  check("the «مصطلحات عربية» category exists and is live", !!cat && cat.name === "مصطلحات عربية");
  check(`the board materializes one question per tier (${cat && cat.count} cells)`,
    cat && cat.count === 5 && JSON.stringify(cat.tiers) === JSON.stringify([100, 200, 300, 400, 500]));
  check(`the bank holds several per tier so games vary (${cat && cat.bankTotal} total)`,
    cat && cat.bankTotal >= 15 && cat.bankPerTier.every(n => n >= 3));
  check("it ships a self-contained cover image (svg data URL, no missing asset)", cat && cat.svgCover);
  check("every question asks for a term and has an answer", cat && cat.everyAsksTerm && cat.everyHasAnswer);
  check("every question has 3 same-kind distractors (four-choices stays fair)", cat && cat.distractors);
  check("no question hard-codes the hint (it is derived from the answer)", cat && cat.noHardcodedHint);

  // ---- opening a question shows the first letter automatically -------------
  const opened = await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "u"); window.IZZBAH.applyAdmin(true);
    state.selected = new Set(["arabicTerms"]);
    state.editingSavedGameId = null; state.teamCount = 2;
    state.teams.forEach(t => { t.score = 0; t.helpUsed = {}; });
    startGame();
    const card = [...document.querySelectorAll(".board-category-card")]
      .find(c => c.textContent.includes("مصطلحات"));
    card.querySelector(".cell:not(.used)").click();
    const hint = document.getElementById("modalHint");
    const answer = state.activeQuestion.q.a;
    return {
      visible: hint.classList.contains("visible"),
      text: hint.textContent,
      frag: (hint.querySelector(".qhint-frag") || {}).textContent || "",
      dir: (hint.querySelector(".qhint-frag") || {}).dir || "",
      answer,
      firstChar: [...answer.trim()][0],
    };
  });
  check("opening a term question reveals the hint box with no helper spent", opened.visible);
  check(`the hint shows the answer's FIRST letter (${opened.firstChar} of «${opened.answer}»)`,
    opened.frag.startsWith(opened.firstChar));
  check("the hint is labelled «أول حرف» and rendered RTL", /أول حرف/.test(opened.text) && opened.dir === "rtl");

  // ---- the now-redundant first-letter lifeline is hidden -------------------
  const helpers = await page.evaluate(() => {
    const slots = [...document.querySelectorAll(".qhelp-slot")];
    const label = t => slots.filter(s => (s.title || "") === t);
    const firstBtns = label("كشف أول حرف");
    const fourBtns = label("أربعة خيارات");
    return {
      firstDisabled: firstBtns.length > 0 && firstBtns.every(b => b.disabled),
      fourUsable: fourBtns.some(b => !b.disabled),
    };
  });
  check("the «كشف أول حرف» lifeline is disabled (its hint is already on screen)", helpers.firstDisabled);
  check("the «أربعة خيارات» lifeline stays usable", helpers.fourUsable);

  // ---- and it can't be spent via the backstop either -----------------------
  const spent = await page.evaluate(() => {
    const before = JSON.stringify(state.teams[state.activeTeam].helpUsed || {});
    useHelper("firstLetter", state.activeTeam);
    return before === JSON.stringify(state.teams[state.activeTeam].helpUsed || {});
  });
  check("calling the first-letter helper directly is a no-op (never wasted)", spent);

  // ---- a «مصطلحات»-named word-guess category must NOT leak its word --------
  const guard = await page.evaluate(() => {
    const fake = { id: "x-charades", name: "وش الكلمة مصطلحات", questions: [] };
    return { terms: isTermsCategory(fake), word: isWordGuessCategory(fake) };
  });
  check("a وش الكلمة category named «مصطلحات» is NOT treated as a terms category",
    guard.word === true && guard.terms === false);

  // ---- a normal category still shows no automatic hint ---------------------
  const normal = await page.evaluate(() => {
    finishQuestion(null);
    state.selected = new Set(["history"]);
    state.editingSavedGameId = null;
    refreshBuiltinQuestions();
    startGame();
    const card = [...document.querySelectorAll(".board-category-card")]
      .find(c => c.textContent.includes("تاريخ"));
    card.querySelector(".cell:not(.used)").click();
    return document.getElementById("modalHint").classList.contains("visible");
  });
  check("a normal category shows NO automatic hint (helper still required)", normal === false);

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
