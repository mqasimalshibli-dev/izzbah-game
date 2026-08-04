// Questions must never be cut off on the question screen.
//
// The report was "some questions get clipped behind «إظهار الإجابة»". The cause
// was not the button at all:
//
//   Cairo's Arabic glyphs (ج ح ع م) draw BELOW the line box. At the
//   line-heights the question card uses, that puts `scrollHeight` about 0.25em
//   above `clientHeight` — at EVERY font size, proportionally. fitQuestionText
//   treated any excess over 1px as "the text overflows its box", so the
//   condition could never be satisfied: the shrink loop ran all the way to its
//   15px floor on every question, three words or thirty. At 15px inside a box
//   styled `overflow: hidden`, the tail of a long question was simply cut off,
//   with the reveal button sitting where the missing text should have been.
//
// Three things had to change, and this test pins all three:
//   1. the box reserves room for the ink (padding in em, so it scales),
//   2. the fitter's own-box test tolerates the residual glyph overhang but
//      still catches a genuine extra wrapped line (0.6em sits between 0.25em
//      of ink and ~1.4em of line),
//   3. the box scrolls rather than hiding, so a question that truly cannot fit
//      at the floor is still readable instead of silently truncated.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8383;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const QS = {
  "3 words": "ما عاصمة عُمان؟",
  "one line": "ما هي أطول سلسلة جبال في العالم وفي أي قارة تقع بالضبط؟",
  "long": "من هو القائد المسلم الذي فتح الأندلس وأحرق السفن بعد وصوله إلى الشاطئ، وفي أي سنة هجرية وقعت هذه المعركة الفاصلة التي غيّرت مجرى التاريخ في شبه الجزيرة الأيبيرية بأكملها؟",
  "extreme": "اذكر بالتفصيل الكامل ترتيب الخلفاء الراشدين الأربعة مع سنة تولي كل واحد منهم الخلافة وسنة وفاته، ثم اذكر أهم إنجاز عسكري وأهم إنجاز إداري تحقق في عهد كل خليفة منهم، مع بيان المدينة التي اتخذها عاصمة لحكمه وأبرز الصحابة الذين عاونوه في إدارة شؤون الدولة الإسلامية آنذاك؟",
};
// Sizes players actually hold the game at, portrait and landscape.
const VIEWPORTS = [
  ["landscape 1024×600", 1024, 600],
  ["landscape 844×390", 844, 390],
  ["landscape 667×375", 667, 375],
  ["portrait 402×874", 402, 874],
];

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

const measure = (page, text) => page.evaluate(async (t) => {
  state.teamCount = 2;
  state.teams = [{ name: "أ", helpers: ["fourChoices", "firstLetter", "doublePoints"], helpUsed: {}, score: 0 },
                 { name: "ب", helpers: ["fourChoices", "firstLetter", "doublePoints"], helpUsed: {}, score: 0 }];
  state.activeTeam = 0;
  const cat = { id: "pub-clip", name: "تاريخ" };
  const q = { q: t, a: "جواب", points: 500 };
  state.activeQuestion = { cat, q, key: "k", team: 0 };
  fillQuestionContent(cat, q);
  showScreen("questionPage", { keepQuestion: true });
  renderTeamHelpBar(document.getElementById("questionHelpBar"), 0, "question");
  await new Promise(z => setTimeout(z, 350));
  fitQuestionText();
  await new Promise(z => setTimeout(z, 80));

  const el = document.getElementById("modalQuestion");
  const cs = getComputedStyle(el);
  const box = el.getBoundingClientRect();
  const hit = (r) => {
    const h = Math.min(box.right, r.right) - Math.max(box.left, r.left);
    const v = Math.min(box.bottom, r.bottom) - Math.max(box.top, r.top);
    return (h > 1 && v > 1) ? Math.round(Math.min(h, v)) : 0;
  };
  const R = (id) => document.getElementById(id).getBoundingClientRect();
  return {
    font: Math.round(parseFloat(cs.fontSize)),
    // how much of the text is outside the box it is painted in
    cut: el.scrollHeight - el.clientHeight,
    overflowY: cs.overflowY,
    reveal: hit(R("questionActions")),
    bar: hit(R("questionHelpBar")),
    category: hit(R("modalCategory")),
    points: hit(R("modalPoints")),
  };
}, text);

try {
  for (const [label, w, h] of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.route("**/firebasejs/**", r => r.abort());
    page.on("pageerror", e => errs.push(e.message));
    await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
    await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1300);

    const sizes = {};
    for (const [qlabel, text] of Object.entries(QS)) {
      const m = await measure(page, text);
      sizes[qlabel] = m.font;
      check(`${label} · ${qlabel}: no text is cut off (${m.cut}px past the box, ${m.font}px type)`,
        m.cut <= 1);
      check(`${label} · ${qlabel}: clears the reveal button, the lifelines and the badges`,
        m.reveal === 0 && m.bar === 0 && m.category === 0 && m.points === 0);
    }

    // The fitter must be doing real work, not just parking everything at one
    // size: a short clue gets big type, a long one gets smaller type.
    // The bound is deliberately well clear of the 15px floor rather than tuned
    // to whatever the fitter currently produces. It was 40 when the fitter grew
    // a question until it nearly touched the reveal button; the owner asked for
    // smaller type (FILL in fitQuestionText), so a 3-word clue now lands at
    // ~38px in landscape. What this canary exists to catch is the .218 bug —
    // EVERY question, three words or thirty, driven to 15px and then clipped —
    // and the relational check on the next line is what proves the fitter is
    // still doing real work.
    check(`${label}: a 3-word question is NOT driven to the 15px floor (${sizes["3 words"]}px)`,
      sizes["3 words"] >= 30);
    check(`${label}: type shrinks as the question grows (${sizes["3 words"]} > ${sizes["long"]} ≥ ${sizes["extreme"]})`,
      sizes["3 words"] > sizes["long"] && sizes["long"] >= sizes["extreme"]);
    await page.close();
  }

  // The last-resort behaviour: a question that cannot fit even at the floor has
  // to remain reachable, not be silently truncated.
  {
    const page = await browser.newPage({ viewport: { width: 667, height: 375 } });
    await page.route("**/firebasejs/**", r => r.abort());
    page.on("pageerror", e => errs.push(e.message));
    await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
    await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1300);
    const m = await measure(page, "سؤال طويل جداً بلا نهاية ".repeat(60) + "؟");
    check(`an unfittable question scrolls instead of being hidden (overflow-y: ${m.overflowY})`,
      m.overflowY === "auto" || m.overflowY === "scroll");
    await page.close();
  }

  check("no page errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 3));
} catch (e) {
  check(`threw: ${e && e.message}`, false);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
