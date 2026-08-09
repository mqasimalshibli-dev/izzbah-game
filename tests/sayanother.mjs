// «قول غيرها»: the QUESTION screen names only a DOMAIN («اذكر اسم حيوان») —
// the banned words are a hidden trap the team answers blind against. The REVEAL
// shows them, and dodging them scores. The banned words live in `distractors`,
// so multiple choice must be off (it would hand the team the trap), and nothing
// on the question screen may leak them.
// ---- static: the built-in bank's own consistency ---------------------------
// Offline checks on the question data itself, so a bad entry is caught at author
// time rather than surfacing as a one-in-N flaky failure on whichever question a
// board happened to draw.
import { readFileSync as __read } from "fs";
import { fileURLToPath as __f } from "url";
import { dirname as __d, join as __j } from "path";
function __bankChecks(check) {
  const src = __read(__j(__d(__f(import.meta.url)), "..", "index.html"), "utf8");
  const start = src.indexOf("sayAnother:");
  const after = src.slice(start + 11);
  const end = after.search(/\n\s{4,6}[a-zA-Z_]\w*:\s*\{/);
  const seg = after.slice(0, end > 0 ? end : 80000);
  const re = /\[\s*"([^"]{4,})"\s*,\s*"([^"]*)"\s*,\s*\[([^\]]*)\]/g;
  const norm = (x) => x.replace(/[\u064B-\u0652\u0670]/g, "")
    .replace(/[\u0623\u0625\u0622]/g, "\u0627").replace(/\u0629/g, "\u0647").replace(/\u0649/g, "\u064A");
  const strip = (x) => x.replace(/^(ال|و|ب|ل|ف)/, "");
  let m, n = 0, self = [], dup = [], clash = [], thin = [];
  while ((m = re.exec(seg))) {
    n++;
    const q = m[1];
    const acc = m[2].split("·").map(x => x.trim()).filter(Boolean);
    const bans = m[3].split(",").map(x => x.trim().replace(/"/g, "")).filter(Boolean);
    const qw = new Set(norm(q).split(/[\s\u060C.\u061F!:()«»\-]+/).filter(Boolean).map(strip));
    bans.forEach(w => {
      if (norm(w).split(/\s+/).every(t => qw.has(strip(t)))) self.push(`${q} → ${w}`);
    });
    if (new Set(bans.map(norm)).size !== bans.length) dup.push(q);
    const B = new Set(bans.map(norm));
    acc.forEach(x => { if (B.has(norm(x))) clash.push(`${q} → ${x}`); });
    if (acc.length < 3) thin.push(q);
  }
  check(`the built-in bank has questions (${n})`, n > 100);
  // A ban lifted straight from the prompt costs the team nothing — nobody
  // answers «ميناء» to «اذكر اسم ميناء» — so that question is really playing
  // with one ban fewer than it looks.
  check(`no question bans a word from its own prompt${self.length ? " (" + self.slice(0, 3).join("; ") + ")" : ""}`,
    self.length === 0);
  check(`no question lists the same ban twice${dup.length ? " (" + dup.slice(0, 3).join("; ") + ")" : ""}`,
    dup.length === 0);
  // The two lists must not contradict: a word cannot be both banned and offered
  // as an accepted answer on the reveal screen.
  check(`no banned word also appears in its own accepted list${clash.length ? " (" + clash.slice(0, 3).join("; ") + ")" : ""}`,
    clash.length === 0);
  check(`every question keeps at least 3 accepted examples${thin.length ? " (" + thin.slice(0, 3).join("; ") + ")" : ""}`,
    thin.length === 0);
}

import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8402;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };
__bankChecks(check);

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
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
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
      everyAsks: all.every(t => /^اذكر/.test(t[0])),
      prompts: all.map(t => t[0]),
      everyBans4: all.every(t => Array.isArray(t[2]) && t[2].length === 4),
      everyHasAccepted: all.every(t => typeof t[1] === "string" && t[1].includes("·")),
      // the rule must NOT be baked into any question or answer
      noInlineRule: all.every(t => !/إجابتك صحيحة/.test(t[0]) && !/إجابتك صحيحة/.test(t[1])),
      // a banned word must never also appear in its own accepted list
      noOverlap: all.every(t => t[2].every(b => !t[1].split("·").map(s => s.trim()).includes(b))),
    };
  });
  check("the «قول غيرها» category exists and is live", !!cat && cat.name === "قول غيرها");
  check(`the bank holds 150 questions, 30 per tier (${cat && cat.total})`,
    cat && cat.total === 150 && cat.perTier.every(n => n === 30));
  check("no domain prompt is repeated", cat && new Set(cat.prompts).size === cat.prompts.length);
  check("all five tiers are on the board", cat && JSON.stringify(cat.tiers) === JSON.stringify([100, 200, 300, 400, 500]));
  check("it ships a self-contained cover image", cat && cat.svgCover);
  check("every prompt asks for a domain («اذكر …»)", cat && cat.everyAsks);
  check("every question bans exactly 4 obvious answers", cat && cat.everyBans4);
  check("every question carries accepted examples for judging", cat && cat.everyHasAccepted);
  check("no banned word also appears in its own accepted list", cat && cat.noOverlap);
  check("the rule is NOT typed into any question (rendered once by the category)", cat && cat.noInlineRule);

  // ---- opening it in the ADMIN editor must expose all 150 WITH their bans --
  // (this is the path that turns a built-in into an editable cloud category;
  // it used to drop `distractors`, which silently gutted this category)
  const editable = await page.evaluate(() => {
    const qs = builtinEditableQuestions("sayAnother");
    return {
      count: qs.length,
      allHaveBans: qs.every(q => Array.isArray(q.distractors) && q.distractors.length === 4),
      sample: qs[0] && qs[0].distractors,
    };
  });
  check(`the admin editor exposes the whole bank (${editable.count} questions)`, editable.count === 150);
  check("every question keeps its 4 banned words through the editor/publish path",
    editable.allHaveBans && Array.isArray(editable.sample));

  // ---- a stale PUBLISHED copy shadows the bank; re-seed must recover it ----
  // Reproduces the real incident: the category was published when the bank held
  // 40, so the editor kept showing 40 forever while the bank grew to 150.
  const reseed = await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true);
    const stale = {
      id: "sayAnother", name: "قول غيرها", published: true, order: -1,
      questions: Array.from({ length: 40 }, (_, i) => ({ points: 100, q: "قديم " + i, a: "x", distractors: ["a", "b", "c", "d"] })),
    };
    window.IZZBAH.applyPublished([stale]);
    selectAdminCategory("sayAnother");                // the admin CMS path
    const shadowed = state.adminCat.questions.length; // the bug: 40, not 150
    const btn = document.getElementById("adminReseedBuiltin");
    // capture BEFORE re-seeding — afterwards the button correctly stops
    // advertising a count, because the copy is no longer behind
    const flagged = !btn.hidden && btn.classList.contains("reseed-behind");
    const btnLabel = btn.textContent;
    window.confirm = () => true;
    reseedFromBuiltin();
    const after = state.adminCat.questions.length;
    const bansKept = state.adminCat.questions.every(q => Array.isArray(q.distractors) && q.distractors.length === 4);
    const calmAfter = !document.getElementById("adminReseedBuiltin").classList.contains("reseed-behind");
    window.IZZBAH.applyPublished([]); // restore
    return { shadowed, after, flagged, bansKept, btnLabel, calmAfter };
  });
  check("a published copy shadows the built-in bank (the reported bug)", reseed.shadowed === 40);
  check("the re-seed button appears and flags that the copy is behind",
    reseed.flagged && /١٥٠|150/.test(reseed.btnLabel));
  check("re-seeding pulls the full bank back in (40 → 150)", reseed.after === 150);
  check("re-seeded questions keep their banned words", reseed.bansKept);
  check("once re-seeded the button stops flagging (no longer behind)", reseed.calmAfter);

  // ---- the QUESTION screen shows ONLY the domain — the bans stay hidden ----
  const opened = await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "u"); window.IZZBAH.applyAdmin(true);
    state.selected = new Set(["sayAnother"]);
    state.editingSavedGameId = null; state.teamCount = 2;
    state.teams.forEach(t => { t.score = 0; t.helpUsed = {}; });
    startGame();
    const card = [...document.querySelectorAll(".board-category-card")]
      .find(c => c.textContent.includes("قول غيرها"));
    card.querySelector(".cell:not(.used)").click();
    const banned = state.activeQuestion.q.distractors || [];
    const page = document.getElementById("questionPage");
    return {
      bannedHidden: document.getElementById("bannedWrap").hidden,
      qText: document.getElementById("modalQuestion").textContent.trim(),
      // No banned word may be VISIBLE while answering. Matched as a whole word,
      // not a substring: Arabic roots nest, so `includes()` flagged «حر» inside
      // «الصحراء» and failed at random depending on which question the board
      // drew. The property that matters is that the player cannot READ a banned
      // word, and a word buried inside a longer one is not readable as itself.
      leaks: (() => {
        const norm = (x) => x.replace(/[\u064B-\u0652\u0670]/g, "")
          .replace(/[\u0623\u0625\u0622]/g, "\u0627").replace(/\u0629/g, "\u0647").replace(/\u0649/g, "\u064A");
        const strip = (x) => x.replace(/^(ال|و|ب|ل|ف)/, "");
        const tokens = (x) => new Set(norm(x).split(/[\s\u060C.\u061F!،:()«»\-]+/)
          .filter(Boolean).map(strip));
        const onScreen = tokens(page.textContent);
        // A banned word that is part of the PROMPT ITSELF is not a leak — the
        // player is meant to read the prompt, and «اذكر اسم ميناء» tells them
        // nothing by containing «ميناء». (It IS a wasted ban slot, but that is a
        // content question for the owner, not a spoiler this test can decide.)
        const inPrompt = tokens(document.getElementById("modalQuestion").textContent);
        const isWholeWordIn = (set, w) =>
          norm(w).split(/\s+/).filter(Boolean).every(t => set.has(strip(t)));
        return banned.filter(w => isWholeWordIn(onScreen, w) && !isWholeWordIn(inPrompt, w));
      })(),
    };
  });
  check("the question screen shows only the domain prompt", /اذكر/.test(opened.qText));
  check("the banned words are HIDDEN while answering", opened.bannedHidden);
  check(`no banned word leaks onto the question screen (${opened.leaks.length} leaks)`, opened.leaks.length === 0);

  // ---- revealing the answer exposes the bans + the rule -------------------
  const revealed = await page.evaluate(() => {
    const banned = state.activeQuestion.q.distractors || [];
    revealAnswer();
    const wrap = document.getElementById("bannedWrap");
    const chips = [...document.querySelectorAll(".banned-chip")];
    const answerEl = document.getElementById("modalAnswer");
    return {
      shown: !wrap.hidden && wrap.offsetHeight > 0,
      chipCount: chips.length,
      chipsMatch: chips.map(c => c.textContent).join("|") === banned.join("|"),
      struck: chips.length ? /line-through/.test(getComputedStyle(chips[0]).textDecorationLine) : false,
      rule: document.getElementById("bannedRule").textContent,
      // the bans must sit with the answer, above the accepted-examples line
      beforeAnswer: !!(wrap.compareDocumentPosition(answerEl) & Node.DOCUMENT_POSITION_FOLLOWING),
      acceptedShown: answerEl.textContent.includes("·"),
      // the rule labels the chips, so it must come FIRST and there is no
      // separate «الكلمات الممنوعة» heading
      ruleAboveChips: !!(document.getElementById("bannedRule")
        .compareDocumentPosition(document.getElementById("bannedList")) & Node.DOCUMENT_POSITION_FOLLOWING),
      noHeading: !document.querySelector(".banned-head") && !wrap.textContent.includes("الكلمات الممنوعة"),
      strikeThin: chips.length ? parseFloat(getComputedStyle(chips[0]).textDecorationThickness) <= 1.5 : false,
    };
  });
  check("revealing the answer shows the banned-words block", revealed.shown);
  check(`all 4 banned words render as chips (${revealed.chipCount})`, revealed.chipCount === 4 && revealed.chipsMatch);
  check("banned chips are struck through", revealed.struck);
  check("the strike is hairline so the Arabic word stays legible", revealed.strikeThin);
  check("the rule sits ABOVE the chips and labels them", revealed.ruleAboveChips);
  check("there is no separate «الكلمات الممنوعة» heading", revealed.noHeading);
  check("the rule explains that dodging them scores", /إجابتكم صحيحة/.test(revealed.rule));
  check("the bans sit above the accepted-examples answer line",
    revealed.beforeAnswer && revealed.acceptedShown);

  // ---- the answer must be labelled EXAMPLES, not "the correct answer" ------
  const label = await page.evaluate(() => {
    const el = document.getElementById("modalAnswer");
    return {
      sayAnother: getComputedStyle(el, "::before").content,
      flagged: document.getElementById("answerPage").classList.contains("say-another"),
    };
  });
  check("the answer is labelled «أمثلة مقبولة», not «الإجابة الصحيحة»",
    label.flagged && /أمثلة مقبولة/.test(label.sayAnother));

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
    const atQuestion = !document.getElementById("bannedWrap").hidden;
    revealAnswer();
    return { atQuestion, atReveal: !document.getElementById("bannedWrap").hidden };
  });
  check("a normal category shows NO banned-words block, at question OR reveal",
    normal.atQuestion === false && normal.atReveal === false);

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
