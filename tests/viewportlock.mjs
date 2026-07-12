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

  // ---- 4) a question WITH a picture must still show the question text ----
  // (a global flex:1 on the text once made it collapse to 0 behind the image)
  await page.evaluate(() => {
    const IMG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Crect width='400' height='300' fill='%23c8431b'/%3E%3C/svg%3E";
    const cat = allCategories().find(c => c.id === "history");
    const q = { q: "من هو أول من مشى على القمر؟", a: "نيل أرمسترونغ", points: 100, image: IMG, answerImage: "" };
    state.activeQuestion = { cat, q, key: "t", team: 0 };
    fillQuestionContent(cat, q);
    showScreen("questionPage", { keepQuestion: true });
  });
  await page.waitForTimeout(300); // let the image decode
  const withImage = await page.evaluate(() => {
    const t = document.getElementById("modalQuestion").getBoundingClientRect();
    const im = document.getElementById("modalQuestionImage");
    return { textH: t.height, imgShown: getComputedStyle(im).display !== "none", imgH: im.getBoundingClientRect().height };
  });
  check(`a question picture does not hide the question text (text ${Math.round(withImage.textH)}px, img ${Math.round(withImage.imgH)}px)`,
    withImage.textH > 8 && withImage.imgShown && withImage.imgH > 4);

  // ---- 5) tablet-landscape (>600px tall): the game fills edge-to-edge ----
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.evaluate(() => {
    state.selected = new Set(["history", "geo", "science", "culture"]);
    refreshBuiltinQuestions(); state.gameActive = true; renderGame(); showScreen("game");
  });
  await page.waitForTimeout(200);
  const fill = await page.evaluate(() => {
    const gs = document.querySelector("#game.game-screen").getBoundingClientRect();
    const app = getComputedStyle(document.querySelector(".app"));
    return {
      left: Math.round(gs.left), top: Math.round(gs.top),
      right: Math.round(gs.right), bottom: Math.round(gs.bottom),
      w: window.innerWidth, h: window.innerHeight, pad: app.paddingLeft,
    };
  });
  check(`tablet: the game screen spans the full viewport (no framing padding)`,
    fill.left === 0 && fill.top === 0 && fill.right === fill.w && fill.bottom === fill.h && fill.pad === "0px");

  // ---- 6) the question card FILLS the screen (no floating card in a frame) ----
  const cardFill = async (w, h) => {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(() => {
      const cat = allCategories().find(c => c.id === "history");
      const q = { q: "سؤال قصير؟", a: "ج", points: 100, image: "", answerImage: "" };
      state.activeQuestion = { cat, q, key: "t", team: 0 };
      fillQuestionContent(cat, q);
      showScreen("questionPage", { keepQuestion: true });
    });
    await page.waitForTimeout(250);
    return page.evaluate(() => {
      const c = document.querySelector("#questionPage .question-main-card").getBoundingClientRect();
      return { top: c.top, bottom: c.bottom, left: c.left, right: c.right, w: window.innerWidth, h: window.innerHeight };
    });
  };
  const tabletCard = await cardFill(1024, 700);
  check(`tablet: the question card fills the height (bottom ${Math.round(tabletCard.bottom)} vs ${tabletCard.h})`,
    tabletCard.bottom >= tabletCard.h - 40 && tabletCard.right >= tabletCard.w - 40 && tabletCard.left <= 40);
  const phoneCard = await cardFill(986, 444);
  check(`wide phone: the question card fills width+height (no huge empty margin)`,
    phoneCard.bottom >= phoneCard.h - 40 && phoneCard.right >= phoneCard.w - 120);

  // ---- 7) all SIX categories fit the board (no clipped 2nd row / scroll) ----
  const boardFit = async (w, h) => {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(() => {
      state.selected = new Set(["foreignSeries", "footballMix", "sports", "history", "omaniFootball", "culture"]);
      refreshBuiltinQuestions(); state.teamCount = 2;
      state.teams[0].score = 3000; state.teams[1].score = 1700;
      state.gameActive = true; renderGame(); showScreen("game");
    });
    await page.waitForTimeout(250);
    return page.evaluate(() => {
      const game = document.getElementById("game").getBoundingClientRect();
      const cards = [...document.querySelectorAll(".board-category-card")].map(c => c.getBoundingClientRect());
      return { count: cards.length, maxBottom: Math.max(...cards.map(c => c.bottom)), gameBottom: game.bottom };
    });
  };
  const tb = await boardFit(1600, 700); // tablet with browser chrome eating height
  check(`tablet: all 6 categories fit the board (bottom ${Math.round(tb.maxBottom)} ≤ ${Math.round(tb.gameBottom)})`,
    tb.count === 6 && tb.maxBottom <= tb.gameBottom + 2);
  const shortTb = await boardFit(1600, 600);
  check(`short tablet: all 6 categories still fit (no clipped row)`,
    shortTb.count === 6 && shortTb.maxBottom <= shortTb.gameBottom + 2);

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
