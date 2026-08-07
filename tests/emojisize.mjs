// An emoji-category question that carries NO emoji must be sized like any other
// worded question.
//
// Reported from a tablet: in «معنـى الايموجي» the question filled the whole card
// and spilled past it. The picture in the report showed no emoji either, and the
// two facts are connected:
//
//   fillQuestionContent splits an emoji question into a prompt + a big emoji
//   line, and marks the card `emoji-split`. When there are no emoji to split out
//   it marks it only `emoji-q`, and renders the words whole. fitQuestionText's
//   height cap (FILL) was keyed on `text-only`, which an emoji card never gets
//   — line 20413 excludes emoji categories from it explicitly — and on the
//   ABSENCE of an emoji line, which is exactly the broken case. So the cap was
//   off, and the grow loop ran to its 220px ceiling, overflowing the card.
//
// The live category «معنـى الايموجي» (pub-1784240484235-8039) has 107 questions
// reading «وش معنى الايموجي» with no emoji anywhere — so this is not a
// hypothetical shape, it is what players are seeing today.
//
// What this pins:
//   1. an emoji-category question with no emoji obeys the same height cap,
//   2. it does not overflow the card,
//   3. a REAL emoji question is untouched — the emoji line still dominates,
//      which is the behaviour the cap must not break.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8391;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const VIEWPORTS = [
  ["tablet landscape 1280×800", 1280, 800],
  ["landscape 1024×600", 1024, 600],
  ["landscape 844×390", 844, 390],
  ["portrait 402×874", 402, 874],
];

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

const measure = (page, qText) => page.evaluate(async (t) => {
  state.teamCount = 2;
  state.teams = [{ name: "أ", helpers: [], helpUsed: {}, score: 0 },
                 { name: "ب", helpers: [], helpUsed: {}, score: 0 }];
  state.activeTeam = 0;
  // Named so isEmojiCategory() matches it, exactly as the live one does.
  const cat = { id: "pub-emoji-test", name: "معنـى الايموجي" };
  const q = { q: t, a: "السويد", points: 100 };
  state.activeQuestion = { cat, q, key: "k", team: 0 };
  fillQuestionContent(cat, q);
  showScreen("questionPage", { keepQuestion: true });
  renderTeamHelpBar(document.getElementById("questionHelpBar"), 0, "question");
  await new Promise(z => setTimeout(z, 350));
  fitQuestionText();
  await new Promise(z => setTimeout(z, 80));

  const el = document.getElementById("modalQuestion");
  const card = document.querySelector("#questionPage .question-main-card");
  const box = el.getBoundingClientRect();
  const cardBox = card.getBoundingClientRect();
  const hit = (r) => {
    const h = Math.min(box.right, r.right) - Math.max(box.left, r.left);
    const v = Math.min(box.bottom, r.bottom) - Math.max(box.top, r.top);
    return (h > 1 && v > 1) ? Math.round(Math.min(h, v)) : 0;
  };
  const R = (id) => document.getElementById(id).getBoundingClientRect();
  const emojiLine = el.querySelector(".q-emojis");
  return {
    font: Math.round(parseFloat(getComputedStyle(el).fontSize)),
    share: cardBox.height > 0 ? box.height / cardBox.height : 0,
    cut: el.scrollHeight - el.clientHeight,
    // how far the text box escapes the card it lives in
    spill: Math.round(Math.max(0, box.bottom - cardBox.bottom) + Math.max(0, cardBox.top - box.top)),
    emojiPx: emojiLine ? Math.round(parseFloat(getComputedStyle(emojiLine).fontSize)) : 0,
    split: card.classList.contains("emoji-split"),
    emojiQ: card.classList.contains("emoji-q"),
    reveal: hit(R("questionActions")),
    bar: hit(R("questionHelpBar")),
  };
}, qText);

// The FILL cap in fitQuestionText is 0.25 for a picture-less question. Allow a
// little headroom: a single line of Cairo plus its reserved ink padding sits
// just under that, and the assertion is here to catch a card-filling runaway,
// not to track the dial's exact value.
const CAP = 0.42;

try {
  for (const [label, w, h] of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.route("**/firebasejs/**", r => r.abort());
    page.on("pageerror", e => errs.push(e.message));
    await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
    await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1300);

    // (1) the broken-content shape: emoji category, no emoji in the question
    const bare = await measure(page, "وش معنى الايموجي");
    check(`${label} · no-emoji question is on an emoji card but NOT split`,
      bare.emojiQ && !bare.split);
    check(`${label} · no-emoji question is height-capped (${Math.round(bare.share * 100)}% of the card, ${bare.font}px)`,
      bare.share <= CAP);
    check(`${label} · no-emoji question does not spill out of the card (${bare.spill}px)`,
      bare.spill <= 1);
    check(`${label} · no-emoji question is not cut off (${bare.cut}px past its box)`,
      bare.cut <= 1);
    check(`${label} · no-emoji question clears the reveal button and lifelines`,
      bare.reveal === 0 && bare.bar === 0);

    // (2) a real emoji question must keep its big emoji line — the cap must not
    //     reach the case it was deliberately excluded from.
    const real = await measure(page, "🍔👑 خمن اسم المطعم");
    check(`${label} · a real emoji question still splits`, real.split);
    check(`${label} · its emoji line stays large (${real.emojiPx}px, words ${real.font}px)`,
      real.emojiPx >= real.font * 2);
    check(`${label} · real emoji question does not spill (${real.spill}px)`, real.spill <= 1);

    await page.close();
  }

  check("no uncaught JS errors", errs.length === 0);
  if (errs.length) console.log("  errs:", errs.slice(0, 3));
} finally {
  await browser.close();
  server.kill();
}

process.exit(checks.every(Boolean) ? 0 : 1);
