// «قول غيرها»: the prompt names a DOMAIN, the obvious answers are listed as
// banned chips, and the standing rule «أي كلمة غير المذكورة… إجابتك صحيحة ✅»
// is rendered ONCE by the category (never typed into a question). The banned
// words live in `distractors`, so multiple choice must be off — offering them
// as options would invert the game.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8402;
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

  // ---- the category ships live with a full bank ----------------------------
  const cat = await page.evaluate(() => {
    refreshBuiltinQuestions();
    const c = categoryById("sayAnother");
    if (!c) return null;
    const bank = builtinQuestionBanks.sayAnother || {};
    const all = Object.values(bank).flat();
    return {
      name: c.name,
      tiers: [...new Set((c.questions || []).map(q => q.points))].sort((a, b) => a - b),
      total: all.length,
      perTier: Object.keys(bank).map(p => (bank[p] || []).length),
      svgCover: /^data:image\/svg\+xml/.test(c.image || ""),
      everyAsks: all.every(t => /اذكر/.test(t[0])),
      everyBans4: all.every(t => Array.isArray(t[2]) && t[2].length === 4),
      everyHasAccepted: all.every(t => typeof t[1] === "string" && t[1].includes("·")),
      // the rule must NOT be baked into any question or answer
      noInlineRule: all.every(t => !/إجابتك صحيحة/.test(t[0]) && !/إجابتك صحيحة/.test(t[1])),
      // a banned word must never also appear in its own accepted list
      noOverlap: all.every(t => t[2].every(b => !t[1].split("·").map(s => s.trim()).includes(b))),
    };
  });
  check("the «قول غيرها» category exists and is live", !!cat && cat.name === "قول غيرها");
  check(`the bank holds 40 questions, 8 per tier (${cat && cat.total})`,
    cat && cat.total === 40 && cat.perTier.every(n => n === 8));
  check("all five tiers are on the board", cat && JSON.stringify(cat.tiers) === JSON.stringify([100, 200, 300, 400, 500]));
  check("it ships a self-contained cover image", cat && cat.svgCover);
  check("every prompt asks for a domain («اذكر …»)", cat && cat.everyAsks);
  check("every question bans exactly 4 obvious answers", cat && cat.everyBans4);
  check("every question carries accepted examples for judging", cat && cat.everyHasAccepted);
  check("no banned word also appears in its own accepted list", cat && cat.noOverlap);
  check("the rule is NOT typed into any question (rendered once by the category)", cat && cat.noInlineRule);

  // ---- opening a question shows the bans + the rule ------------------------
  const opened = await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "u"); window.IZZBAH.applyAdmin(true);
    state.selected = new Set(["sayAnother"]);
    state.editingSavedGameId = null; state.teamCount = 2;
    state.teams.forEach(t => { t.score = 0; t.helpUsed = {}; });
    startGame();
    const card = [...document.querySelectorAll(".board-category-card")]
      .find(c => c.textContent.includes("قول غيرها"));
    card.querySelector(".cell:not(.used)").click();
    const wrap = document.getElementById("bannedWrap");
    const chips = [...document.querySelectorAll(".banned-chip")];
    const rule = document.getElementById("bannedRule");
    const qText = document.getElementById("modalQuestion");
    const banned = state.activeQuestion.q.distractors || [];
    // the block must sit ABOVE the question text
    const above = !!(wrap.compareDocumentPosition(qText) & Node.DOCUMENT_POSITION_FOLLOWING);
    return {
      shown: !wrap.hidden && wrap.offsetHeight > 0,
      chipCount: chips.length,
      chipsMatch: chips.map(c => c.textContent).join("|") === banned.join("|"),
      struck: chips.length ? /line-through/.test(getComputedStyle(chips[0]).textDecorationLine) : false,
      rule: rule.textContent,
      above,
      qVisible: qText.textContent.trim().length > 0,
    };
  });
  check("opening a question shows the banned-words block", opened.shown);
  check(`all 4 banned words render as chips (${opened.chipCount})`, opened.chipCount === 4 && opened.chipsMatch);
  check("banned chips are struck through", opened.struck);
  check("the standing rule is displayed", /أي كلمة غير المذكورة/.test(opened.rule) && /إجابتك صحيحة/.test(opened.rule));
  check("the rule sits ABOVE the question, with the question underneath", opened.above && opened.qVisible);

  // ---- multiple choice must be OFF (bans are not options) ------------------
  const helpers = await page.evaluate(() => {
    const four = [...document.querySelectorAll(".qhelp-slot")].filter(s => (s.title || "") === "أربعة خيارات");
    const before = JSON.stringify(state.teams[state.activeTeam].helpUsed || {});
    useHelper("fourChoices", state.activeTeam);
    return {
      disabled: four.length > 0 && four.every(b => b.disabled),
      noSpend: before === JSON.stringify(state.teams[state.activeTeam].helpUsed || {}),
      noChoices: document.getElementById("modalChoices").children.length === 0,
    };
  });
  check("the «أربعة خيارات» lifeline is disabled (bans aren't options)", helpers.disabled);
  check("calling it directly is a no-op and renders no choices", helpers.noSpend && helpers.noChoices);

  // ---- a normal category shows no banned block ----------------------------
  const normal = await page.evaluate(() => {
    finishQuestion(null);
    state.selected = new Set(["history"]);
    state.editingSavedGameId = null;
    refreshBuiltinQuestions();
    startGame();
    const card = [...document.querySelectorAll(".board-category-card")]
      .find(c => c.textContent.includes("تاريخ"));
    card.querySelector(".cell:not(.used)").click();
    return !document.getElementById("bannedWrap").hidden;
  });
  check("a normal category shows NO banned-words block", normal === false);

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
