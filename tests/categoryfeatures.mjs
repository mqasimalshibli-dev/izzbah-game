// E2E for two category features:
//  1. Reaction categories (رياكشنات) hide the four-choices (multiple choice)
//     helper, while first-letter stays available; word categories still hide
//     both; ordinary categories keep both.
//  2. A per-category answered-progress % badge shows on the categories screen,
//     driven by a persistent, cloud-synced store.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8312;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

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

  // ---- 1) multiple-choice gating by category type ----
  const gating = await page.evaluate(() => {
    const reaction = { id: "pub-123", name: "رياكشنات عمانية" };
    const word = { id: "charadesArabic", name: "وش الكلمة" };
    const normal = { id: "pub-999", name: "تاريخ" };
    return {
      reactionHidesFour: hidesMultipleChoice(reaction),
      reactionKeepsFirst: !isWordGuessCategory(reaction),
      wordHidesBoth: hidesMultipleChoice(word) && isWordGuessCategory(word),
      normalKeepsAll: !hidesMultipleChoice(normal) && !isWordGuessCategory(normal),
    };
  });
  check("رياكشنات category hides multiple choice", gating.reactionHidesFour);
  check("رياكشنات keeps first-letter (only MC is disabled)", gating.reactionKeepsFirst);
  check("word category still hides both helpers", gating.wordHidesBoth);
  check("an ordinary category keeps both helpers", gating.normalKeepsAll);

  // The help bar actually disables the four-choices slot on a reaction question
  const barGating = await page.evaluate(() => {
    state.teams = [{ name: "A", helpers: ["fourChoices", "firstLetter", "doublePoints"], helpUsed: {}, score: 0 },
                   { name: "B", helpers: ["fourChoices", "firstLetter", "doublePoints"], helpUsed: {}, score: 0 }];
    state.teamCount = 2; state.activeTeam = 0;
    state.activeQuestion = { cat: { id: "pub-123", name: "رياكشنات عمانية" }, q: { q: "؟", a: "x", points: 100 }, team: 0 };
    const bar = document.createElement("div");
    renderTeamHelpBar(bar, 0, "question");
    const slots = [...bar.querySelectorAll(".qhelp-slot")];
    // slot order follows the team loadout: fourChoices, firstLetter, doublePoints
    return { four: slots[0] ? slots[0].disabled : null, first: slots[1] ? slots[1].disabled : null };
  });
  check("on a رياكشنات question the four-choices slot is disabled", barGating.four === true);
  check("on a رياكشنات question the first-letter slot stays enabled", barGating.first === false);

  // ---- 2) per-category progress badge ----
  const prog = await page.evaluate(() => {
    // A cloud category with 5 questions; answer 2 of them.
    const qs = [1, 2, 3, 4, 5].map(i => ({ q: "س" + i, a: "ج" + i, points: i * 100 }));
    const cat = { id: "pub-react", name: "رياكشنات عمانية", questions: qs };
    state.progress = {};
    markQuestionAnswered(cat, qs[0]);
    markQuestionAnswered(cat, qs[1]);
    markQuestionAnswered(cat, qs[0]); // duplicate must not double-count
    return {
      total: categoryTotalQuestions(cat),
      pct: categoryProgressPercent(cat),
      stored: (state.progress["pub-react"] || []).length,
      persisted: !!localStorage.getItem("izzbah-progress-v1"),
    };
  });
  check("category total question count is correct (5)", prog.total === 5);
  check("answering 2 of 5 gives 40% (duplicates ignored)", prog.pct === 40 && prog.stored === 2);
  check("progress is persisted to localStorage", prog.persisted);

  // the badge renders on the categories screen for a category with progress
  const badge = await page.evaluate(() => {
    // seed progress for a real built-in category, then render the picker
    const cat = allCategories().find(c => categoryTotalQuestions(c) > 0);
    if (!cat) return { ok: false };
    const total = categoryTotalQuestions(cat);
    const bank = builtinQuestionBanks[cat.id];
    // sign a handful of real bank questions as answered
    let answered = 0;
    Object.keys(bank || {}).forEach(k => (bank[k] || []).slice(0, 2).forEach(qa => {
      markQuestionAnswered(cat, { q: qa[0], a: qa[1] }); answered++;
    }));
    state.categoryMode = "game";
    renderCategories();
    const card = [...document.querySelectorAll("#categoryGrid .category")]
      .find(c => (c.querySelector(".cat-name-pill") || {}).textContent === cat.name);
    const pill = card && card.querySelector(".cat-progress");
    return { ok: true, hasPill: !!pill, text: pill ? pill.textContent : "", expectPct: Math.round(answered / total * 100) };
  });
  check("a category with progress shows a % badge on its card", badge.ok && badge.hasPill && /%/.test(badge.text));

  // ---- 3) empty categories are locked and shown as "coming soon" ----
  const soon = await page.evaluate(() => {
    // inject cloud categories: one with real questions, one with only blank
    // placeholders, one with an empty questions array.
    window.IZZBAH.applyPublished([
      { id: "pub-full",  name: "فئة كاملة",  color: "#123", order: 1, questions: [{ points: 100, q: "سؤال؟", a: "جواب", image: "", answerImage: "" }] },
      { id: "pub-blank", name: "فئة فارغة",  color: "#123", order: 2, questions: [{ points: 100, q: "", a: "", image: "", answerImage: "" }, { points: 200, q: "", a: "", image: "", answerImage: "" }] },
      { id: "pub-none",  name: "بدون أسئلة", color: "#123", order: 3, questions: [] },
    ]);
    state.categoryMode = "game";
    state.selected = new Set();
    renderCategories();
    const cardFor = nm => [...document.querySelectorAll("#categoryGrid .category")]
      .find(c => (c.querySelector(".cat-name-pill") || {}).textContent === nm);
    const info = nm => {
      const c = cardFor(nm);
      if (!c) return { present: false };
      return {
        present: true,
        locked: c.classList.contains("empty-bank"),
        soon: !!c.querySelector(".cat-soon") && /قريبا/.test(c.querySelector(".cat-soon").textContent),
      };
    };
    // predicate directly
    const has = (qs) => categoryHasQuestions({ id: "x", questions: qs });
    // try to click a locked card — it must NOT become selected
    const blankCard = cardFor("فئة فارغة");
    if (blankCard) blankCard.click();
    const full = info("فئة كاملة"), blank = info("فئة فارغة"), none = info("بدون أسئلة");
    // a real built-in bank category must stay available
    const builtin = allCategories().find(c => c.id === "history");
    return {
      full, blank, none,
      blankSelected: state.selected.has("pub-blank"),
      predFull: has([{ q: "س", a: "ج" }]), predBlank: has([{ q: "", a: "" }]), predEmpty: has([]),
      builtinPlayable: categoryHasQuestions(builtin),
    };
  });
  check("a category WITH questions is not locked", soon.full.present && !soon.full.locked && !soon.full.soon);
  check("a category with only blank questions is locked + «قريباً»", soon.blank.present && soon.blank.locked && soon.blank.soon);
  check("a category with an empty questions array is locked + «قريباً»", soon.none.present && soon.none.locked && soon.none.soon);
  check("clicking a locked (coming-soon) card does not select it", soon.blankSelected === false);
  check("categoryHasQuestions: true for real, false for blank/empty",
    soon.predFull === true && soon.predBlank === false && soon.predEmpty === false);
  check("a built-in bank category stays available (not falsely locked)", soon.builtinPlayable === true);

  // ---- 3b) question draws prefer NEVER-PLAYED questions ----
  // Plain random re-served recently played questions constantly; the picker
  // must exhaust the unseen pool before anything can repeat.
  const unseen = await page.evaluate(() => {
    const qs = [1, 2, 3, 4, 5].map(i => ({ q: "سؤال" + i, a: "جواب" + i, points: 100 }));
    const cat = { id: "pub-fresh", name: "ف", questions: qs };
    const snapshot = JSON.stringify(state.progress || {}); // restore afterwards
    state.progress = {};
    // play 4 of the 5 — 40 draws must ALL return the remaining one
    [0, 1, 2, 3].forEach(i => markQuestionAnswered(cat, qs[i]));
    let alwaysFresh = true;
    for (let i = 0; i < 40; i++) {
      const pick = pickUnseen("pub-fresh", qs, questionSig);
      if (pick !== qs[4]) alwaysFresh = false;
    }
    // whole pool played -> falls back to random (never null / never sticks)
    markQuestionAnswered(cat, qs[4]);
    const fallback = pickUnseen("pub-fresh", qs, questionSig);
    // built-in banks go through the same picker: mark every 100-tier history
    // question except ONE, then draw repeatedly — must always get that one
    const bank = builtinQuestionBanks.history[100];
    const histCat = { id: "history" };
    bank.slice(1).forEach(t => markQuestionAnswered(histCat, { q: t[0], a: t[1] }));
    let bankFresh = true;
    for (let i = 0; i < 20; i++) {
      const drawn = randomQuestion("history", 100);
      if (drawn.q !== bank[0][0]) bankFresh = false;
    }
    localStorage.setItem("izzbah-progress-v1", snapshot);
    loadProgress(); // put the pre-test progress back for the later checks
    return { alwaysFresh, fallbackOk: !!fallback && qs.includes(fallback), bankFresh };
  });
  check("cloud draws always serve a never-played question while one exists", unseen.alwaysFresh);
  check("a fully-played pool falls back to random (still returns a question)", unseen.fallbackOk);
  check("built-in bank draws prefer the never-played question too", unseen.bankFresh);

  // ---- 4) picked categories are SHADED (dark overlay + ✓), not just ringed ----
  const shade = await page.evaluate(() => {
    state.categoryMode = "game";
    state.selected = new Set(["history"]);
    renderCategories();
    const card = [...document.querySelectorAll("#categoryGrid .category")].find(c => c.classList.contains("selected"));
    if (!card) return null;
    const ring = card.querySelector(".cat-ring");
    const cs = getComputedStyle(ring);
    const after = getComputedStyle(ring, "::after");
    const other = [...document.querySelectorAll("#categoryGrid .category:not(.selected)")][0];
    return {
      display: cs.display,
      bg: cs.backgroundImage + " " + cs.backgroundColor,
      mark: after.content || "",
      pillZ: +getComputedStyle(card.querySelector(".cat-name-pill")).zIndex || 0,
      otherRing: other ? getComputedStyle(other.querySelector(".cat-ring")).display : "none",
    };
  });
  check("a picked category shows the dark shade overlay", !!shade && shade.display === "block" && /gradient|rgba/.test(shade.bg));
  check("the shade carries a gold ✓ mark", !!shade && shade.mark.includes("✓"));
  check("the name pill stays readable above the shade", !!shade && shade.pillZ >= 2);
  check("unpicked categories show no shade", !!shade && shade.otherRing === "none");

  // progress survives a reload via the synced key
  const persist = await page.evaluate(() => {
    const before = JSON.stringify(state.progress);
    state.progress = {};                 // wipe in-memory
    loadProgress();                      // reload from localStorage
    return JSON.stringify(state.progress) === before && Object.keys(state.progress).length > 0;
  });
  check("progress reloads from storage intact", persist);

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
