// How much of the question card the question is allowed to occupy, and how
// legible the two badges hanging off the top edge are.
//
// The fitter GREW a worded question until it almost collided with the reveal
// button, which left the card with no quiet space: 62% of its height in
// landscape, 77% in portrait. The owner's report was simply "the question is
// too big", next to the points badge being small enough to squint at.
//
// The cap (FILL in fitQuestionText) now applies in BOTH directions — a
// grow-only cap changed nothing on a landscape phone, where the stylesheet's
// own size was already over the line. It is scoped to worded questions: on an
// emoji card the emoji line IS the puzzle and must stay dominant, which
// tests/emojis.mjs pins separately.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8487;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

// The question from the owner's screenshot, plus a short and a long one, so the
// cap is exercised at both ends.
const QUESTIONS = {
  real: "ما أول غزوة خرج فيها النبي ﷺ بنفسه؟",
  short: "ما عاصمة عمان؟",
  long: "من هو الصحابي الجليل الذي تولى قيادة الجيش الإسلامي في معركة اليرموك وكان يلقب بسيف الله المسلول ثم عزله عمر بن الخطاب عن القيادة؟",
};

const VIEWPORTS = [
  { w: 678, h: 305, n: "the owner's landscape phone", minBadge: 19 },
  { w: 844, h: 390, n: "iPhone landscape", minBadge: 16 },
  { w: 390, h: 844, n: "iPhone portrait", minBadge: 15 },
  { w: 820, h: 1180, n: "iPad portrait", minBadge: 15 },
];

try {
  for (const v of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: v.w, height: v.h } });
    await page.route("**/firebasejs/**", r => r.abort());
    page.on("pageerror", e => errs.push(e.message));
    await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
    await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1100);

    const m = await page.evaluate(async (QUESTIONS) => {
      state.teamCount = 2;
      state.teams = [0, 1].map(i => ({
        name: "فريق " + (i + 1), score: 0,
        helpers: ["fourChoices", "firstLetter", "doublePoints"],
        helpUsed: {}, helpBanned: false, doubleArmed: false,
      }));
      state.activeTeam = 0;
      const cat = { id: "pub-seerah", name: "السيرة النبوية" };
      const measure = async (text) => {
        const q = { q: text, a: "جواب", points: 400 };
        state.activeQuestion = { cat, q, key: "k", team: 0 };
        fillQuestionContent(cat, q);
        showScreen("questionPage", { keepQuestion: true });
        updateHelpBars();
        await new Promise(r => setTimeout(r, 450));
        const el = document.getElementById("modalQuestion");
        const card = document.querySelector("#questionPage .question-main-card");
        const pts = document.getElementById("modalPoints");
        const reveal = document.getElementById("revealAnswer");
        const t = el.getBoundingClientRect(), c = card.getBoundingClientRect();
        const r = reveal.getBoundingClientRect();
        const hit = (A, B) => {
          const h = Math.min(A.right, B.right) - Math.max(A.left, B.left);
          const vv = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
          return h > 1 && vv > 1;
        };
        return {
          font: parseFloat(getComputedStyle(el).fontSize),
          fill: t.height / c.height,
          clipped: el.scrollHeight > el.clientHeight + parseFloat(getComputedStyle(el).fontSize) * 0.6,
          hitsReveal: hit(t, r),
          badgeFont: parseFloat(getComputedStyle(pts).fontSize),
          badgeH: Math.round(pts.getBoundingClientRect().height),
          badgeText: pts.textContent.trim(),
        };
      };
      // What the ANSWER renders at here. Since .289 the question is capped at
      // it, so "large enough to read" is measured against that rather than an
      // absolute px value — on a short landscape phone the answer itself is
      // only ~20px, and holding the question to 22 would fail a render that
      // matches the answer exactly, which is what was asked for.
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;left:-9999px;font-size:var(--answer-size)";
      document.body.appendChild(probe);
      const answerPx = Math.round(parseFloat(getComputedStyle(probe).fontSize) || 0);
      probe.remove();
      return {
        answerPx,
        real: await measure(QUESTIONS.real),
        short: await measure(QUESTIONS.short),
        long: await measure(QUESTIONS.long),
      };
    }, QUESTIONS);

    // ---- the question leaves room in the card ----
    check(`${v.n}: the screenshot question no longer fills the card (${Math.round(m.real.fill * 100)}%, was 62-77%)`,
      m.real.fill <= 0.5);
    check(`${v.n}: …and is still large enough to read (${Math.round(m.real.font)}px of ${m.answerPx}px)`,
      m.real.font >= Math.min(22, m.answerPx));
    check(`${v.n}: …and never bigger than the answer (${Math.round(m.real.font)}px ≤ ${m.answerPx}px)`,
      m.answerPx > 0 && m.real.font <= m.answerPx + 1);
    check(`${v.n}: a short question still gets big type (${Math.round(m.short.font)}px)`,
      m.short.font >= m.real.font);
    // The cap must never cost legibility on a long question: below the fitter's
    // floor it stops applying, so a long question is bounded by the card, not by
    // the cap.
    check(`${v.n}: a long question stays readable (${Math.round(m.long.font)}px)`,
      m.long.font >= 15);

    // ---- nothing is clipped or overlapped, at any length ----
    ["real", "short", "long"].forEach(k => {
      check(`${v.n}: the ${k} question is not clipped and clears the reveal button`,
        !m[k].clipped && !m[k].hitsReveal);
    });

    // ---- the points badge is bigger ----
    check(`${v.n}: the points badge is legible (${m.real.badgeFont}px ≥ ${v.minBadge}px)`,
      m.real.badgeFont >= v.minBadge);
    // The badge has a max-width with an ellipsis, so a bigger font could have
    // started truncating it. Accept either digit form — the badge renders
    // Western digits here, which is what the owner's screenshot shows too.
    check(`${v.n}: the bigger badge is not truncated ("${m.real.badgeText}")`,
      /(٤٠٠|400)/.test(m.real.badgeText) && /نقطة/.test(m.real.badgeText) && !/…/.test(m.real.badgeText));
    await page.close();
  }

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
