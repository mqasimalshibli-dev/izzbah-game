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

  // The last-resort case, and the contract CHANGED here (owner, build .277).
  //
  // .218 made this box `overflow-y: auto` so a question the fitter could not
  // shrink far enough would scroll rather than be silently truncated — the
  // scrollbar was the safety net. The owner then saw that scrollbar in play and
  // asked for it gone, which is only safe if the fitter genuinely always fits.
  // It now does: a strict final pass shrinks on the REAL scrollHeight rather
  // than the 0.6em-tolerant test, so `cut` is 0 by construction.
  //
  // So this asserts the property the scrollbar was standing in for — nothing is
  // hidden — directly, which is strictly stronger than asking whether an escape
  // hatch exists. A future change that clips text fails here whether or not it
  // leaves overflow-y alone.
  {
    const page = await browser.newPage({ viewport: { width: 667, height: 375 } });
    await page.route("**/firebasejs/**", r => r.abort());
    page.on("pageerror", e => errs.push(e.message));
    await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
    await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1300);
    const m = await measure(page, "سؤال طويل جداً بلا نهاية ".repeat(60) + "؟");
    // 1500 characters — about fourteen times the longest question in the live
    // catalogue (109 chars across 3536 published questions, median 33). Nobody
    // will see this; an admin could still type it.
    check(`an absurd question is never silently truncated (${m.cut}px hidden, overflow-y: ${m.overflowY})`,
      m.cut <= 0 || m.overflowY === "auto" || m.overflowY === "scroll");
    check(`...and it stays readable rather than collapsing (${m.font}px)`, m.font >= 12);
    await page.close();
  }

  // The case that actually matters: content LONGER than anything in the
  // catalogue must fit outright — no scrollbar, nothing hidden. This is the
  // owner's report (build .277); the fitter used to stop a few real pixels over
  // because `overlaps()` tolerates 0.6em, and `overflow-y: auto` drew a
  // scrollbar for those 3-8px.
  {
    const page = await browser.newPage({ viewport: { width: 667, height: 375 } });
    await page.route("**/firebasejs/**", r => r.abort());
    page.on("pageerror", e => errs.push(e.message));
    await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
    await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1300);
    // 150 chars — comfortably past the real-world maximum of 109
    const m2 = await measure(page, "في أي سنة تأسست الدولة البوسعيدية في عُمان على يد الإمام أحمد بن سعيد، وما المدينة التي اتخذها عاصمةً له بعد أن طرد الغزاة من البلاد كاملةً؟ اذكرهما");
    check(`a longer-than-real question fits with no scrollbar (overflow-y: ${m2.overflowY})`,
      m2.overflowY !== "auto" && m2.overflowY !== "scroll");
    check(`...and nothing is hidden (${m2.cut}px)`, m2.cut <= 0);
    check(`...at a readable size (${m2.font}px)`, m2.font >= 15);
    await page.close();
  }

  // ---- the scrollbar must not come back from sub-pixel rounding ----
  // Reported twice. scrollHeight/clientHeight are integers but the fitter lands
  // on fractional sizes (30.4px, 29.36px), so they round apart by 1-2px on a box
  // that is actually exact. A strict `>` read that as overflow and switched the
  // scrollbar on for ordinary questions. Widest viewports first — that is where
  // the fractional sizes land.
  for (const [label, w, h] of [["desktop", 1280, 860], ["tablet landscape", 1112, 834]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.route("**/firebasejs/**", r => r.abort());
    page.on("pageerror", e => errs.push(e.message));
    await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
    await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1300);
    // the real-world maximum: 109 characters, the longest of 3536 published
    const m = await measure(page, "أنا فيزيائي.\nساهمت في تأسيس ميكانيكا الكم.\nأشتهر بمبدأ يحمل اسمي يمنع تحديد الموقع والزخم بدقة في الوقت نفسه.");
    check(`${label}: a real catalogue question draws NO scrollbar (overflow-y: ${m.overflowY}, ${m.cut}px over)`,
      m.overflowY !== "auto" && m.overflowY !== "scroll");
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
