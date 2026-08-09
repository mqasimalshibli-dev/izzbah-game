// A question with a picture must actually SHOW the picture.
//
// Reported as "when there's a picture in the question, it doesn't display it at
// all because the font is too big". Measured on an 800×500 tablet: the question
// rendered at 110px and took 77% of the card, and the image — which is
// `flex: 0 1 auto` — was shrunk to exactly 0px tall. Not clipped, not small:
// absent.
//
// The cause was that the fitter's growth veto tested the CARD CLASS rather than
// the picture. Its comment claimed image questions were excluded, and for a
// plain photo category they were, because such a card is neither `text-only`
// nor `emoji-*`. But «معنى الايموجي» is an emoji category, so a photo question
// inside it matched `emoji-q`, grew freely, and starved the image.
//
// The wording on a picture card now takes the SAME size step as the revealed
// answer, mirrored at every breakpoint — asserted here by COMPARING the two
// computed sizes rather than pinning numbers, so the two cannot drift apart.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8494;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

// A 4:3 block of colour — big enough that the layout has to make room for it.
const IMG = "data:image/svg+xml;base64," + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#c0392b"/></svg>'
).toString("base64");

const VIEWPORTS = [
  { w: 1024, h: 640, n: "tablet landscape" },
  { w: 800, h: 500, n: "small tablet landscape" },   // the size that failed
  { w: 844, h: 390, n: "phone landscape" },
  { w: 390, h: 844, n: "phone portrait" },
];

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

try {
  for (const v of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: v.w, height: v.h } });
    await page.route("**/firebasejs/**", r => r.abort());
    page.on("pageerror", e => errs.push(e.message));
    await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1000);

    const m = await page.evaluate(async (IMG) => {
      state.teamCount = 2;
      state.teams = [0, 1].map(i => ({
        name: "فريق " + (i + 1), score: 0,
        helpers: ["fourChoices", "firstLetter", "doublePoints"],
        helpUsed: {}, helpBanned: false, doubleArmed: false,
      }));
      state.activeTeam = 0;

      const show = async (cat, q) => {
        state.activeQuestion = { cat, q, key: "k", team: 0 };
        fillQuestionContent(cat, q);
        showScreen("questionPage", { keepQuestion: true });
        updateHelpBars();
        await new Promise(r => setTimeout(r, 550));
        const el = document.getElementById("modalQuestion");
        const card = document.querySelector("#questionPage .question-main-card");
        const img = document.querySelector("#questionPage .question-image");
        const c = card.getBoundingClientRect();
        const ir = img ? img.getBoundingClientRect() : null;
        const shown = !!img && getComputedStyle(img).display !== "none";
        return {
          font: parseFloat(getComputedStyle(el).fontSize),
          textPct: el.getBoundingClientRect().height / c.height,
          imgShown: shown,
          imgH: ir ? ir.height : 0,
          imgPct: ir ? ir.height / c.height : 0,
          // the picture must sit INSIDE the card, not spill past it
          imgOverflows: ir ? (ir.bottom > c.bottom + 2 || ir.top < c.top - 2) : false,
          cardH: c.height,
        };
      };

      // an emoji category carrying a photo — the exact reported combination
      const emojiCat = { id: "pub-emoji", name: "معنى الايموجي" };
      const withImg = await show(emojiCat, { q: "وش معنى الايموجي", a: "سن توب", points: 200, image: IMG });

      // the revealed answer, for the size comparison
      document.getElementById("revealAnswer").click();
      await new Promise(r => setTimeout(r, 480));
      const answerFont = parseFloat(getComputedStyle(document.getElementById("modalAnswer")).fontSize);

      // a plain picture question in an ordinary category
      const plain = await show({ id: "pub-pic", name: "تاريخ" },
        { q: "من في الصورة؟", a: "جواب", points: 300, image: IMG });

      // regression guard: a picture-LESS question must be untouched by all this
      const noImg = await show({ id: "pub-pic", name: "تاريخ" },
        { q: "ما عاصمة عُمان؟", a: "مسقط", points: 300 });

      return { withImg, plain, noImg, answerFont };
    }, IMG);

    // ---- the picture is actually on screen ----
    check(`${v.n}: the picture is rendered at a real size (${Math.round(m.withImg.imgH)}px, was 0)`,
      m.withImg.imgShown && m.withImg.imgH > 40);
    check(`${v.n}: …taking a meaningful share of the card (${Math.round(m.withImg.imgPct * 100)}%)`,
      m.withImg.imgPct >= 0.20);
    check(`${v.n}: …and staying inside the card, not spilling out of it`,
      !m.withImg.imgOverflows);
    check(`${v.n}: a plain picture question shows its picture too (${Math.round(m.plain.imgH)}px)`,
      m.plain.imgShown && m.plain.imgH > 40 && !m.plain.imgOverflows);

    // ---- the wording sits one step BELOW the answer screen ----
    // It was first matched to the answer exactly; the owner then asked for it
    // smaller still, so what is pinned now is the RELATIONSHIP (a step below,
    // never above) rather than equality — the answer's own size still moves
    // across four breakpoints, and the two must move together.
    const ratio = m.withImg.font / m.answerFont;
    check(`${v.n}: the question sits below the answer's size (${Math.round(m.withImg.font)}px vs ${Math.round(m.answerFont)}px, ${ratio.toFixed(2)}×)`,
      ratio >= 0.7 && ratio <= 0.9);
    check(`${v.n}: …but stays readable (${Math.round(m.withImg.font)}px ≥ 12px)`,
      m.withImg.font >= 12);

    // ---- and no longer dominates ----
    check(`${v.n}: the wording no longer crowds out the picture (${Math.round(m.withImg.textPct * 100)}% of the card, was 77%)`,
      m.withImg.textPct <= 0.35);

    // ---- picture-less questions keep their own, larger treatment ----
    check(`${v.n}: a picture-LESS question still gets its own bigger type (${Math.round(m.noImg.font)}px > ${Math.round(m.withImg.font)}px)`,
      m.noImg.font > m.withImg.font);
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
