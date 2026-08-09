// Regression: pressing the (!) on a category card reveals its description in
// place. A long description used to overflow the card and get its last line
// clipped. The panel now auto-shrinks the text to fit, so the WHOLE
// description is visible (no vertical overflow) after the flip.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8335;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
// a phone viewport, where the cards are smallest and clipping was worst
const page = await browser.newPage({ viewport: { width: 412, height: 900 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try {
  localStorage.setItem("izzbah-legal-consent-v1", "1");
  // This test hit-tests with elementFromPoint — run with the first-run coach
  // tour already seen so its floating card never sits over a sampled point
  // (the tour has its own suites: coach.mjs / coachadmin.mjs).
  localStorage.setItem("izzbah-coach-v1", JSON.stringify({ gameLibrary: 1, categories: 1, setup: 1, game: 1, questionPage: 1, answerPage: 1, results: 1, menu: 1, customManager: 1, customEditor: 1, __all: 1 }));
} catch (e) {} });

// Flip a card's (!) open and report whether its description overflows, plus the
// natural (un-fitted) overflow so we can prove the fitter actually did work.
const probe = (idx, longDesc) => page.evaluate(({ idx, longDesc }) => {
  const cards = [...document.querySelectorAll(".category")];
  const card = cards[idx];
  if (!card) return { ok: false, reason: "no card" };
  const p = card.querySelector(".cat-info p");
  if (longDesc) p.textContent = longDesc; // force an extreme description
  const panel = card.querySelector(".cat-info");
  // measure the natural overflow (stylesheet size, no fit) with the panel shown
  card.classList.add("showing-info");
  p.style.fontSize = "";
  const naturalOverflow = panel.scrollHeight - panel.clientHeight;
  card.classList.remove("showing-info");
  // now the real flow: the (!) click runs fitCatInfo
  card.querySelector(".category-eye").click();
  return {
    ok: true,
    showing: card.classList.contains("showing-info"),
    overflow: panel.scrollHeight - panel.clientHeight, // >1 means clipped/needs scroll
    naturalOverflow,
    fontSize: parseFloat(getComputedStyle(p).fontSize),
  };
}, { idx, longDesc });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  // show the category selection screen so the cards have real layout (the
  // .category height only resolves when the screen isn't display:none)
  await page.evaluate(() => {
    showScreen("categories");
    renderCategories();
  });
  await page.waitForTimeout(400);

  // a normal (built-in) description must fully fit once flipped open
  const normal = await probe(0, null);
  check("a card exists and the (!) opens its description", normal.ok && normal.showing);
  check(`a normal description fits with no clipping (overflow ${Math.round(normal.overflow)}px)`,
    normal.overflow <= 1);

  // an EXTREME description (far longer than any real one) would overflow at the
  // base size — the fitter must shrink it so it still fits, no clipped last line
  // a realistic long description (~2× the longest real one) overflows at the
  // base size but must fit after the fitter shrinks it — WITHOUT bottoming out
  // at the 9px scroll fallback (i.e. it fits by shrinking a little)
  const long = "أسئلة عن موسم خريف ظفار وصلالة: طبيعة وسياحة ومعالم ومهرجانات وأنشطة عائلية "
    + "وأماكن جميلة للزيارة، وتفاصيل عن المواسم والفعاليات المتنوعة في المحافظة.";
  const extreme = await probe(1, long);
  check(`a long description WOULD overflow unfitted (natural ${Math.round(extreme.naturalOverflow)}px)`,
    extreme.naturalOverflow > 1);
  check(`a long description fits after the fitter runs (overflow ${Math.round(extreme.overflow)}px, font ${extreme.fontSize}px)`,
    extreme.ok && extreme.overflow <= 1 && extreme.fontSize > 9);

  // the OPEN description must paint ABOVE the card's name pill and badges —
  // it used to share the pill's z-index and the name showed through the text
  const layering = await page.evaluate(() => {
    const card = [...document.querySelectorAll(".category")].find(c => c.classList.contains("showing-info"))
      || document.querySelector(".category");
    card.classList.add("showing-info");
    const pill = card.querySelector(".cat-name-pill");
    const eye = card.querySelector(".category-eye");
    const r = pill.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const er = eye.getBoundingClientRect();
    const eyeHit = document.elementFromPoint(er.left + er.width / 2, er.top + er.height / 2);
    return {
      overPill: !!(hit && hit.closest(".cat-info")), // the panel covers the pill spot
      eyeStillOnTop: eyeHit === eye || (eyeHit && eyeHit.closest(".category-eye") === eye),
    };
  });
  check("the open description covers the category name (not behind it)", layering.overPill);
  check("the (!) button stays clickable above the open description", layering.eyeStillOnTop);

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
