// The revealed answer must be the same colour as the question that preceded it.
//
// It was not, in DARK mode only, and the cause was specificity rather than a
// colour decision. The dark-theme block does list `#modalAnswer`, but
// `#answerPage #modalAnswer` is two IDs (2,0,0) and out-specifies
// `:root[data-theme="dark"] #modalAnswer` (1,2,0) — !important on both sides,
// so importance does not break the tie. The answer kept the light-theme dark
// green on a near-black card while the question beside it rendered cream.
//
// Comparing the two computed colours is the assertion that matters: pinning a
// hex value would pass just as happily with the question changed and the answer
// left behind, which is the exact failure this file exists for.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8491;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const rgb = s => (s.match(/\d+/g) || []).slice(0, 3).map(Number);
// WCAG relative luminance + contrast ratio.
const lum = ([r, g, b]) => {
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

try {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
    await page.route("**/firebasejs/**", r => r.abort());
    page.on("pageerror", e => errs.push(e.message));
    await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
    await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1100);

    const m = await page.evaluate(async (theme) => {
      state.theme = theme;
      document.documentElement.setAttribute("data-theme", theme);
      state.teamCount = 2;
      state.teams = [0, 1].map(i => ({
        name: "فريق " + (i + 1), score: 0, helpers: [], helpUsed: {},
        helpBanned: false, doubleArmed: false,
      }));
      state.activeTeam = 0;
      const cat = { id: "pub-x", name: "تاريخ" };
      const q = { q: "عصير الأطفال في العبوة البرتقالية الصغيرة بماصة؟", a: "سن توب", points: 300 };
      state.activeQuestion = { cat, q, key: "k", team: 0 };
      fillQuestionContent(cat, q);
      showScreen("questionPage", { keepQuestion: true });
      await new Promise(r => setTimeout(r, 320));
      const qEl = document.getElementById("modalQuestion");
      const question = getComputedStyle(qEl).color;
      // Reveal exactly the way a player does.
      document.getElementById("revealAnswer").click();
      await new Promise(r => setTimeout(r, 420));
      const aEl = document.getElementById("modalAnswer");
      const card = aEl.closest(".answer-card") || aEl.parentElement;
      // Walk up for the first non-transparent background, so contrast is
      // measured against what is really behind the text.
      let bg = "rgba(0, 0, 0, 0)", node = aEl;
      while (node && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) {
        bg = getComputedStyle(node).backgroundColor;
        node = node.parentElement;
      }
      return {
        question,
        answer: getComputedStyle(aEl).color,
        eyebrow: getComputedStyle(aEl, "::before").color,
        bg,
        answerText: aEl.textContent.replace("الإجابة الصحيحة", "").trim(),
        onAnswerScreen: document.body.dataset.screen === "answerPage",
        hasCard: !!card,
      };
    }, theme);

    check(`${theme}: the reveal actually reached the answer screen`, m.onAnswerScreen);
    check(`${theme}: the answer is shown ("${m.answerText}")`, /سن توب/.test(m.answerText));
    check(`${theme}: the answer is the SAME colour as the question (${m.answer} vs ${m.question})`,
      m.answer === m.question);
    // Same colour is not enough on its own — both could be wrong together.
    const c = contrast(rgb(m.answer), rgb(m.bg));
    check(`${theme}: …and readable on the card behind it (${c.toFixed(1)}:1 on ${m.bg})`, c >= 4.5);
    const ce = contrast(rgb(m.eyebrow), rgb(m.bg));
    check(`${theme}: the «الإجابة الصحيحة» label is readable too (${ce.toFixed(1)}:1)`, ce >= 4.5);
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
