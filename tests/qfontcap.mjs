// The question font must never run away, on any device shape.
//
// Reported as "some devices have very outlandish and big font", with a
// screenshot of a landscape phone where the question filled the card and was
// cut off behind «إظهار الإجابة».
//
// The cause was a real regression, fixed in .267: fitQuestionText's height cap
// was keyed on the `text-only` class, and its FILL share was 0.45 — so on a
// wide viewport the stylesheet's own clamp(48px, 7vw, 96px) starting size
// already sat just under the cap and the shrink loop never ran. What the
// screenshot shows is the pre-.267 build.
//
// This pins the property across device shapes rather than one viewport: the
// question box may never take more than a fair share of the card, never spill
// out of it, and never scroll — for a short question and a long one.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8420;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  " + extra : ""}`); };

// Deliberately awkward shapes as well as ordinary ones: very wide and short is
// where the runaway happened, because 7vw scales with WIDTH while the cap is a
// share of HEIGHT.
const VIEWPORTS = [
  ["landscape phone 844×390", 844, 390], ["landscape phone 932×430", 932, 430],
  ["landscape 1280×601", 1280, 601], ["tablet 1280×800", 1280, 800],
  ["tablet 1024×600", 1024, 600], ["desktop 1600×900", 1600, 900],
  ["ultra-wide 1920×620", 1920, 620], ["portrait 402×874", 402, 874],
  ["small portrait 320×568", 320, 568], ["split-screen 720×360", 720, 360],
];
const QS = {
  "3 words": "من فاز بالكأس؟",
  "one line": "من كان هداف كأس العالم ٢٠٢٢ وكم هدفاً سجّل؟",
  "long": "من هو اللاعب الذي سجل أكبر عدد من الأهداف في تاريخ بطولات كأس العالم لكرة القدم منذ انطلاق النسخة الأولى منها وحتى اليوم؟",
};
// A fair share of the card. The fitter targets 0.25 (0.30 with a picture); this
// is the runaway threshold, well clear of the dial so tuning it does not break
// the test, but far below the 0.45 that shipped the bug.
const MAX_SHARE = 0.38;
let answerPx = 0;
// …except once the font reaches the readable floor. fitQuestionText stops
// applying the height cap below FLOOR (22px) on purpose — a long question on a
// 320px phone genuinely needs the room, and shrinking further "buys nothing but
// strain". There, the thing that matters is that it still does not spill or
// scroll, which is asserted separately on every case.
const FLOOR = 22;

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

for (const [label, w, h] of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.route("**/firebasejs/**", r => r.abort());
  page.on("pageerror", e => errs.push(e.message));
  await page.addInitScript(() => {
    try { localStorage.setItem("izzbah-legal-consent-v1", "1"); localStorage.setItem("izzbah-coach-v1", JSON.stringify({ __all: 1 })); } catch (e) {}
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1200);

  const sizes = {};
  for (const [qlabel, q] of Object.entries(QS)) {
    const r = await page.evaluate(async (q) => {
      const sleep = ms => new Promise(z => setTimeout(z, ms));
      state.teamCount = 2;
      state.teams = [{ name: "أ", score: 0, helpers: ["fourChoices", "firstLetter", "doublePoints"], helpUsed: {} },
                     { name: "ب", score: 0, helpers: ["fourChoices", "firstLetter", "doublePoints"], helpUsed: {} }];
      state.activeTeam = 0;
      const cat = { id: "footballMix", name: "منوعات كرة قدم" };
      const qq = { q, a: "ميسي", points: 500 };
      state.activeQuestion = { cat, q: qq, key: "k", team: 0 };
      fillQuestionContent(cat, qq);
      showScreen("questionPage", { keepQuestion: true });
      renderTeamHelpBar(document.getElementById("questionHelpBar"), 0, "question");
      await sleep(380); fitQuestionText(); await sleep(140);
      const el = document.getElementById("modalQuestion");
      const card = document.querySelector("#questionPage .question-main-card");
      const eb = el.getBoundingClientRect(), cb = card.getBoundingClientRect();
      const hit = (id) => {
        const o = document.getElementById(id); if (!o) return 0;
        const r = o.getBoundingClientRect();
        const v = Math.min(eb.bottom, r.bottom) - Math.max(eb.top, r.top);
        const hz = Math.min(eb.right, r.right) - Math.max(eb.left, r.left);
        return (v > 1 && hz > 1) ? Math.round(Math.min(v, hz)) : 0;
      };
      // The size the ANSWER renders at on this viewport — resolved through a
      // probe because --answer-size is a clamp(). Since .289 the question is
      // capped at it, so it is the yardstick, not a magic number.
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;left:-9999px;font-size:var(--answer-size)";
      document.body.appendChild(probe);
      const answerPx = Math.round(parseFloat(getComputedStyle(probe).fontSize) || 0);
      probe.remove();
      return { answerPx,
               font: Math.round(parseFloat(getComputedStyle(el).fontSize)),
               share: +(eb.height / cb.height).toFixed(2),
               spill: Math.round(Math.max(0, eb.bottom - cb.bottom)),
               cut: el.scrollHeight - el.clientHeight,
               reveal: hit("questionActions"), badge: hit("modalPoints") };
    }, q);
    sizes[qlabel] = r.font;
    answerPx = r.answerPx;
    /* THE requirement, asked for repeatedly: a question is never bigger than
       the answer it belongs to. Before .289 a short clue grew to several times
       it. */
    check(`${label} · ${qlabel}: no bigger than the answer (${r.font}px vs ${r.answerPx}px)`,
      r.answerPx > 0 && r.font <= r.answerPx + 1);
    check(`${label} · ${qlabel}: font is capped (${r.font}px, ${Math.round(r.share * 100)}% of the card)`,
      r.share <= MAX_SHARE || r.font <= FLOOR,
      r.font <= FLOOR ? "at the readable floor — cap does not apply" : "");
    check(`${label} · ${qlabel}: nothing spills or scrolls`, r.spill <= 1 && r.cut <= 1,
      `spill=${r.spill} cut=${r.cut}`);
    check(`${label} · ${qlabel}: clears the reveal button and the points badge`,
      r.reveal === 0 && r.badge === 0);
  }
  /* Monotonic, not strict. Since the cap landed, a short and a long question
     that both FIT legitimately render at the same size — that is the point of
     the cap — so demanding a strict difference would be asserting the old
     behaviour. What must still hold is that a longer question is never LARGER,
     and that a short one is nowhere near the 15px floor (the .218 bug). */
  check(`${label}: a longer question is never larger (${sizes["3 words"]} ≥ ${sizes["long"]})`,
    sizes["3 words"] >= sizes["long"]);
  check(`${label}: a short question sits at the cap, not the floor (${sizes["3 words"]}px of ${answerPx}px)`,
    sizes["3 words"] >= Math.min(answerPx, 20));
  await page.close();
}

check("no uncaught JS errors", errs.length === 0);
if (errs.length) console.log("  ", errs.slice(0, 3));
await browser.close(); server.kill();
process.exit(checks.every(Boolean) ? 0 : 1);
