// The emoji-guess category: a built-in category whose questions ARE emoji
// puzzles and whose answers are the words/sayings/characters. It must be live
// (has a bank), one question per point tier, keep multiple-choice (a real
// helper here), carry a self-contained cover + description, and render its
// emoji question text on the question screen.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8340;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ---- 1) the category exists, is live, and is well-formed ----
  const cat = await page.evaluate(() => {
    const c = allCategories().find(x => x.id === "emojis");
    if (!c) return null;
    const tiers = {};
    Object.keys(builtinQuestionBanks.emojis).forEach(p => { tiers[p] = builtinQuestionBanks.emojis[p].length; });
    const all = Object.values(builtinQuestionBanks.emojis).flat();
    return {
      name: c.name, empty: c.empty === true, hasImage: !!c.image,
      imageIsData: (c.image || "").startsWith("data:image/svg+xml"),
      tiers,
      count: all.length,
      everyHas3Distractors: all.every(qa => Array.isArray(qa[2]) && qa[2].length === 3),
      everyHasEmojiQ: all.every(qa => /\p{Extended_Pictographic}/u.test(qa[0]) && qa[1].trim()),
      answers: all.map(qa => qa[1]),
    };
  });
  check("the emoji category exists and is live (not empty)", !!cat && !cat.empty);
  check("it is named for the emoji-guess flow", cat && /إيموجي/.test(cat.name));
  check("it ships a self-contained cover image (svg data URL, no missing asset)", cat && cat.imageIsData);
  check("it has 5 sample questions, one per point tier",
    cat && cat.count === 5 && JSON.stringify(Object.keys(cat.tiers).sort()) === JSON.stringify(["100", "200", "300", "400", "500"]));
  check("every question is an emoji puzzle with a real answer", cat && cat.everyHasEmojiQ);
  check("every question has 3 same-kind distractors (four-choices stays usable)", cat && cat.everyHas3Distractors);
  check("the sample spans varied answers (movie, occasion, character, saying)",
    cat && cat.answers.includes("الأسد الملك") && cat.answers.includes("عيد ميلاد")
    && cat.answers.includes("الرجل العنكبوت") && cat.answers.some(a => a.includes("عصفور في اليد")));

  // ---- 2) multiple-choice is KEPT (a genuine helper for emoji puzzles) ----
  const helpers = await page.evaluate(() => {
    const c = { id: "emojis", name: "خمّن الإيموجي" };
    return { hidesMC: hidesMultipleChoice(c), isWord: isWordGuessCategory(c) };
  });
  check("the emoji category keeps multiple choice (not a word/reaction category)",
    helpers.hidesMC === false && helpers.isWord === false);

  // ---- 3) it has a curated description (no question count) ----
  const desc = await page.evaluate(() => categoryDescription({ id: "emojis", name: "خمّن الإيموجي" }));
  check("it has a curated description about guessing from emojis",
    /إيموجي/.test(desc) && desc.length > 12 && !/سؤال/.test(desc) && !/[٠-٩]/.test(desc));

  // ---- 4) the emoji question renders on the question screen ----
  const shown = await page.evaluate(() => {
    const c = allCategories().find(x => x.id === "emojis");
    const q = c.questions.find(x => (x.q || "").includes("🦁")) || c.questions[0];
    state.activeQuestion = { cat: c, q, key: "t", team: 0 };
    fillQuestionContent(c, q);
    showScreen("questionPage", { keepQuestion: true });
    return {
      text: document.getElementById("modalQuestion").textContent,
      answer: document.getElementById("modalAnswer").textContent,
    };
  });
  check("the emoji puzzle renders as the question text", /🦁|👑/u.test(shown.text));
  check("the reveal shows the worded answer", shown.answer.includes("الأسد الملك"));

  // ---- 4b) on a WIDE desktop the emoji sits CENTERED, not jammed to the top ----
  const centered = await page.evaluate(() => {
    const card = document.querySelector("#questionPage .question-main-card");
    const t = document.getElementById("modalQuestion");
    const c = card.getBoundingClientRect(), r = t.getBoundingClientRect();
    const cardMid = c.top + c.height / 2, textMid = r.top + r.height / 2;
    return {
      isEmojiClass: card.classList.contains("emoji-q"),
      offsetFromCenter: Math.abs(textMid - cardMid),
      cardHeight: c.height,
      fromTop: r.top - c.top,
    };
  });
  check("the emoji question card is tagged for centering", centered.isEmojiClass);
  check(`the emoji question is vertically centered in the card (${Math.round(centered.offsetFromCenter)}px off, not ${Math.round(centered.fromTop)}px from top)`,
    centered.offsetFromCenter < centered.cardHeight * 0.18);

  // ---- 4c) a WORDED emoji question shows its words on top with the emojis on
  //          their OWN, BIGGER line below. Pure-emoji / rebus render whole (no
  //          invented prompt line). ----
  const measure = async (q) => page.evaluate((q) => {
    const cat = { id: "emojis", name: "خمّن الإيموجي" };
    state.activeQuestion = { cat, q, key: "t", team: 0 };
    fillQuestionContent(cat, q);
    showScreen("questionPage", { keepQuestion: true });
    const card = document.querySelector("#questionPage .question-main-card");
    const prompt = document.querySelector("#modalQuestion .q-prompt");
    const em = document.querySelector("#modalQuestion .q-emojis");
    const base = { split: card.classList.contains("emoji-split"), wholeText: document.getElementById("modalQuestion").textContent };
    if (!prompt || !em) return { ...base, ok: false };
    const pr = prompt.getBoundingClientRect(), er = em.getBoundingClientRect();
    return {
      ...base, ok: true,
      promptText: prompt.textContent,
      emojiText: em.textContent,
      emojiIsBlock: getComputedStyle(em).display === "block",
      emojiBelow: er.top >= pr.bottom - 2, // emoji line starts at/after the prompt ends
      emojiPx: parseFloat(getComputedStyle(em).fontSize),
      promptPx: parseFloat(getComputedStyle(prompt).fontSize),
    };
  }, q);

  // (i) a worded question: words on top, emojis on their own BIGGER line below
  const worded = await measure({ q: "خمن اسم الفيلم 🎬 😱", a: "فيلم", points: 100 });
  check("a worded emoji question splits into a words line + an emoji line", worded.ok && worded.split);
  check("the words stay on top and the emojis move to their own line",
    worded.ok && /خمن اسم الفيلم/.test(worded.promptText) && /🎬|😱/u.test(worded.emojiText) && !/🎬/u.test(worded.promptText));
  check("the emoji line sits BELOW the words and is clearly bigger",
    worded.ok && worded.emojiIsBlock && worded.emojiBelow && worded.emojiPx >= worded.promptPx * 1.8 && worded.emojiPx >= 50);

  // (ii) the PUBLISHED questions' real shape — emojis FIRST, words after
  //      ("😱🎬 خمن اسم الفيلم") — must split the same way: words on top,
  //      emojis big below.
  const leading = await measure({ q: "😱🎬 خمن اسم الفيلم", a: "Scary Movie", points: 400 });
  check("an emojis-first question (the published shape) also splits",
    leading.ok && leading.split && /خمن اسم الفيلم/.test(leading.promptText) && !/🎬/u.test(leading.promptText)
    && /🎬|😱/u.test(leading.emojiText) && leading.emojiBelow && leading.emojiPx >= 50);

  // (ii-b) a stray trailing RTL/invisible mark must NOT defeat the split
  const marked = await measure({ q: "خمن اسم الفيلم 🎬 😱‏", a: "فيلم", points: 100 });
  check("a trailing invisible mark still splits (robust parser)",
    marked.ok && marked.split && /خمن اسم الفيلم/.test(marked.promptText) && /🎬|😱/u.test(marked.emojiText));

  // (iii) a PURE-emoji question renders WHOLE — no invented prompt line
  const pure = await measure({ q: "🦁👑", a: "الأسد الملك", points: 100 });
  check("a pure-emoji question is rendered whole with NO invented prompt",
    pure.split === false && !pure.ok && /🦁|👑/u.test(pure.wholeText) && !/الرموز/.test(pure.wholeText));

  // (iv) a rebus proverb (emoji interleaved with words) renders WHOLE, in order
  const rebus = await measure({ q: "🐦🤲 خير من 🔟🌳", a: "مثل", points: 100 });
  check("a rebus proverb renders whole (order preserved), not split",
    rebus.split === false && !rebus.ok && rebus.wholeText.includes("خير من") && !/الرموز/.test(rebus.wholeText));

  // ---- 5) four-choices for an emoji question yields 4 distinct options ----
  const opts = await page.evaluate(() => {
    const c = { id: "emojis", name: "خمّن الإيموجي" };
    const o = buildChoiceOptions(c, { q: "🦁👑", a: "الأسد الملك", distractors: ["كتاب الأدغال", "طرزان", "مدغشقر"] });
    return { n: o.length, hasAnswer: o.includes("الأسد الملك"), distinct: new Set(o).size };
  });
  check("four-choices builds the correct answer + its 3 emoji-puzzle distractors",
    opts.n === 4 && opts.hasAnswer && opts.distinct === 4);

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
