// Two regressions from Safari testing:
//  1. Game screens (board / question / answer) must never scroll the page on
//     ANY viewport size, and the bottom action buttons must sit fully inside
//     the visible height (the .app min-height:100vh override bug).
//  2. Curated four-choices distractors must survive the publish pipeline
//     (normalization + bank backfill for previously-stripped overrides).
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8318;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
// a TALL landscape viewport — bigger than the 600px media-query cutoff, like
// an iPad or desktop Safari window, where the lock used to be missing
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ---- 1) board screen: page locked, no scroll, on a tall viewport ----
  await page.evaluate(() => {
    state.selected = new Set(["history", "geo", "science", "culture"]);
    refreshBuiltinQuestions();
    state.gameActive = true;
    renderGame();
    showScreen("game");
  });
  await page.waitForTimeout(400);
  const board = await page.evaluate(() => ({
    bodyPos: getComputedStyle(document.body).position,
    bodyOverflow: getComputedStyle(document.body).overflow,
    scrollable: document.scrollingElement.scrollHeight > window.innerHeight + 1,
    gameH: document.getElementById("game").getBoundingClientRect().height,
    vh: window.innerHeight,
  }));
  check("board: body is pinned (position fixed, overflow hidden)", board.bodyPos === "fixed" && board.bodyOverflow === "hidden");
  check("board: the page has nothing to scroll", !board.scrollable);
  check(`board: section fits inside the viewport (${Math.round(board.gameH)} vs ${board.vh})`,
    board.gameH <= board.vh + 1 && board.gameH >= board.vh - 60);

  // ---- 2) answer page: .app min-height override + buttons fully visible ----
  await page.evaluate(() => {
    const cat = allCategories().find(c => c.id === "history");
    const q = cat.questions[0];
    state.activeQuestion = { cat, q, key: "t", team: 0 };
    fillQuestionContent(cat, q);
    showScreen("answerPage", { keepQuestion: true });
  });
  await page.waitForTimeout(400);
  const ans = await page.evaluate(() => {
    const app = document.querySelector(".app");
    const bar = document.querySelector(".answer-bottom-actions");
    const cont = document.getElementById("continueAnswer").getBoundingClientRect();
    const back = document.getElementById("backToQuestion").getBoundingClientRect();
    return {
      appMinH: getComputedStyle(app).minHeight,
      appH: app.getBoundingClientRect().height,
      vh: window.innerHeight,
      contBottom: cont.bottom, backBottom: back.bottom,
      contVisible: cont.height > 0, backVisible: back.height > 0,
      scrollable: document.scrollingElement.scrollHeight > window.innerHeight + 1,
    };
  });
  check("answer page: .app min-height is overridden (no 100vh overflow)", ans.appMinH === "0px" && Math.abs(ans.appH - ans.vh) <= 2);
  check("answer page: continue + back buttons sit fully inside the viewport",
    ans.contVisible && ans.backVisible && ans.contBottom <= ans.vh + 1 && ans.backBottom <= ans.vh + 1);
  check("answer page: nothing to scroll", !ans.scrollable);

  // ---- 3) distractor pipeline ----
  const distractors = await page.evaluate(() => {
    // (a) explicit distractors survive normalization
    const kept = normalizePublishedCategory({ id: "pub-x", name: "x", questions: [
      { points: 100, q: "س؟", a: "ج", distractors: ["خطأ1", "خطأ2", "خطأ3"] },
    ] }).questions[0].distractors;
    // (b) a stripped override of a built-in question gets its bank set back
    let bankQ = null, bankD = null;
    outer: for (const pts of Object.keys(builtinQuestionBanks.history)) {
      for (const qa of builtinQuestionBanks.history[pts]) {
        if (Array.isArray(qa[2]) && qa[2].length >= 3) { bankQ = qa; break outer; }
      }
    }
    const healed = normalizePublishedCategory({ id: "history", name: "تاريخ", questions: [
      { points: 100, q: bankQ[0], a: bankQ[1] }, // no distractors — as saved by old publishes
    ] }).questions[0].distractors;
    // (c) buildChoiceOptions prefers curated distractors
    const opts = buildChoiceOptions({ id: "pub-x" }, { q: "س؟", a: "ج", distractors: ["خطأ1", "خطأ2", "خطأ3"] });
    return { kept, healed, expect: bankQ[2], opts };
  });
  check("explicit distractors survive normalization", Array.isArray(distractors.kept) && distractors.kept.length === 3);
  check("stripped built-in overrides are healed from the bank",
    Array.isArray(distractors.healed) && JSON.stringify(distractors.healed) === JSON.stringify(distractors.expect.slice(0, 3)));
  check("four-choices uses the curated set (correct + its 3 wrong answers)",
    Array.isArray(distractors.opts) && distractors.opts.length === 4
    && ["خطأ1", "خطأ2", "خطأ3"].every(d => distractors.opts.includes(d)));

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
