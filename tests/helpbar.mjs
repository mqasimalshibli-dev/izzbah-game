// Regression: a long question on the question screen must not render BEHIND any
// of the overlaid controls — the lifeline (helper) bar on the right, the reveal
// ("continue") button at the bottom, or the category/points badges at the top.
// The card reserves horizontal room for the bar and bounds the text to the safe
// vertical area (it scrolls within its own box only in the extreme case).
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8329;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

// Drive the question screen with an extreme-length question and return the
// overlap (in px) between the question text and each overlaid control.
async function probe(page, helpers, repeat) {
  return page.evaluate(({ helpers, repeat }) => {
    state.teamCount = 2;
    state.teams = [
      { name: "أ", helpers: helpers.slice(), helpUsed: {}, score: 0, helpBanned: false, doubleArmed: false },
      { name: "ب", helpers: helpers.slice(), helpUsed: {}, score: 0, helpBanned: false, doubleArmed: false },
    ];
    state.activeTeam = 0;
    const cat = { id: "pub-x", name: "تاريخ" };
    const q = { q: "ما هو السؤال ".repeat(repeat) + "؟", a: "جواب", points: 100 };
    state.activeQuestion = { cat, q, key: "t", team: 0 };
    fillQuestionContent(cat, q);
    showScreen("questionPage", { keepQuestion: true });
    renderTeamHelpBar(document.getElementById("questionHelpBar"), 0, "question");
    fitQuestionText(); // the font-fit that showScreen schedules async — run it now
    const R = id => document.getElementById(id).getBoundingClientRect();
    const t = R("modalQuestion");
    const overlap = r => {
      const h = Math.min(t.right, r.right) - Math.max(t.left, r.left);
      const v = Math.min(t.bottom, r.bottom) - Math.max(t.top, r.top);
      return (h > 1 && v > 1) ? Math.round(Math.min(h, v)) : 0;
    };
    const card = document.querySelector("#questionPage .question-main-card");
    return {
      hasClass: card.classList.contains("has-helpbar"),
      slots: document.getElementById("questionHelpBar").children.length,
      bar: overlap(R("questionHelpBar")),
      reveal: overlap(R("revealAnswer")),
      category: overlap(R("modalCategory")),
      points: overlap(R("modalPoints")),
    };
  }, { helpers, repeat });
}

try {
  // ---- phone-landscape ----
  const phone = await browser.newPage({ viewport: { width: 820, height: 460 } });
  await phone.route("**/firebasejs/**", r => r.abort());
  phone.on("pageerror", e => errs.push(e.message));
  await phone.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
  await phone.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await phone.waitForTimeout(1400);

  const p = await probe(phone, ["fourChoices", "firstLetter", "doublePoints"], 55); // very long → must shrink even in the now-full-height card
  check("the lifeline bar renders with slots and the card reserves room", p.slots >= 1 && p.hasClass);
  check(`phone: long question clears the lifeline bar (${p.bar}px)`, p.bar === 0);
  check(`phone: long question clears the reveal button (${p.reveal}px)`, p.reveal === 0);
  check(`phone: long question clears the top badges (${p.category}/${p.points}px)`, p.category === 0 && p.points === 0);

  // ---- dynamic font fit: long questions shrink until they fully fit ----
  await phone.waitForTimeout(400); // let the second fit pass run
  const fit = await phone.evaluate(() => {
    const el = document.getElementById("modalQuestion");
    // the element's base (stylesheet) size, measured with the override lifted
    const applied = el.style.getPropertyValue("font-size");
    el.style.removeProperty("font-size");
    const base = parseFloat(getComputedStyle(el).fontSize);
    if (applied) el.style.setProperty("font-size", applied, "important");
    return { size: parseFloat(getComputedStyle(el).fontSize), base, overflow: el.scrollHeight - el.clientHeight };
  });
  // it shrinks the font below the base (an extreme question may still hit the
  // 17px floor and scroll — that's the intended fallback, so don't require a
  // perfect fit; just that the shrink happened).
  check(`phone: long question font is shrunk below base (${fit.size}px < ${fit.base}px)`,
    fit.size < fit.base - 1);

  // a SHORT question keeps the normal large type (font NOT shrunk toward the floor)
  const short = await phone.evaluate(async () => {
    const cat = { id: "pub-x", name: "تاريخ" };
    const q = { q: "ما عاصمة عمان؟", a: "مسقط", points: 100 };
    state.activeQuestion = { cat, q, key: "t", team: 0 };
    fillQuestionContent(cat, q);
    showScreen("questionPage", { keepQuestion: true });
    await new Promise(r => setTimeout(r, 400));
    const el = document.getElementById("modalQuestion");
    const applied = el.style.getPropertyValue("font-size");
    el.style.removeProperty("font-size");
    const base = parseFloat(getComputedStyle(el).fontSize);
    if (applied) el.style.setProperty("font-size", applied, "important");
    return { size: parseFloat(getComputedStyle(el).fontSize), base };
  });
  // A short question must be rendered LARGE — not merely "no smaller than a
  // long one". The old assertion was `short >= long`, which passed happily
  // while BOTH sat on the 15px floor, and that is exactly what was happening:
  // Cairo's Arabic ink box overhangs its line box by ~0.25em at every size, so
  // scrollHeight was permanently above clientHeight, the fitter read that as
  // overflow forever, and every question — three words or thirty — was driven
  // to 15px and then cut off by the card's `overflow: hidden`. Pin the floor
  // explicitly so it can never silently come back.
  /* 40px was right while the question could grow freely. Since .289 it is
     capped at the ANSWER's size, and the help bar's reserved strip narrows the
     text column enough that a short question wraps and fits below that cap — so
     a fixed 40 now fails a perfectly good render. What this canary is really
     for is the .218 bug, where EVERY question was driven to the 15px floor and
     clipped; a floor-relative bound still catches that outright. */
  check(`phone: a short question is rendered at readable size, not the floor (${short.size}px)`,
    short.size >= 22);
  check(`phone: a short question is never shrunk more than a long one (${short.size}px ≥ ${fit.size}px)`,
    short.size >= fit.size);

  // proof the guard works: without the horizontal reservation the text overlaps the bar
  const wouldOverlap = await phone.evaluate(() => {
    const card = document.querySelector("#questionPage .question-main-card");
    card.classList.remove("has-helpbar");
    const t = document.getElementById("modalQuestion").getBoundingClientRect();
    const b = document.getElementById("questionHelpBar").getBoundingClientRect();
    const h = Math.min(t.right, b.right) - Math.max(t.left, b.left);
    const v = Math.min(t.bottom, b.bottom) - Math.max(t.top, b.top);
    card.classList.add("has-helpbar");
    return h > 1 && v > 1;
  });
  check("without the reservation the text overlaps the bar (guard is doing work)", wouldOverlap);
  await phone.close();

  // ---- iPad-landscape (where the card isn't height-locked the same way) ----
  const ipad = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  await ipad.route("**/firebasejs/**", r => r.abort());
  ipad.on("pageerror", e => errs.push(e.message));
  await ipad.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
  await ipad.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await ipad.waitForTimeout(1400);

  const i = await probe(ipad, ["fourChoices", "firstLetter", "doublePoints"], 60); // extreme length
  check(`iPad: extreme question clears the reveal button (${i.reveal}px)`, i.reveal === 0);
  check(`iPad: extreme question clears the bar + badges (${i.bar}/${i.category}/${i.points}px)`,
    i.bar === 0 && i.category === 0 && i.points === 0);

  // ---- picture-less question: centered + enlarged, not hugging the top ----
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const textOnly = await ipad.evaluate(async (PNG) => {
    const cat = { id: "pub-din", name: "دين" };
    const measure = async (q) => {
      state.activeQuestion = { cat, q, key: "t", team: 0 };
      fillQuestionContent(cat, q);
      showScreen("questionPage", { keepQuestion: true });
      await new Promise(r => setTimeout(r, 400));
      const card = document.querySelector("#questionPage .question-main-card");
      const el = document.getElementById("modalQuestion");
      const c = card.getBoundingClientRect(), r = el.getBoundingClientRect();
      // BASE (stylesheet) size, override lifted — viewport-based (vw clamp), so
      // font-metric-independent, unlike the fitted size CI would shrink.
      const applied = el.style.getPropertyValue("font-size");
      el.style.removeProperty("font-size");
      const base = parseFloat(getComputedStyle(el).fontSize);
      if (applied) el.style.setProperty("font-size", applied, "important");
      return {
        textOnlyClass: card.classList.contains("text-only"),
        offCenter: Math.abs((r.top + r.height / 2) - (c.top + c.height / 2)),
        cardHeight: c.height,
        fromTop: r.top - c.top,
        base,
      };
    };
    const noImg = await measure({ q: "ما اسم والد النبي؟", a: "عبدالله", points: 100 });
    const withImg = await measure({ q: "ما اسم والد النبي؟", a: "عبدالله", points: 100, image: PNG });
    return { noImg, withImg };
  }, PNG);
  check("a picture-less question is tagged text-only", textOnly.noImg.textOnlyClass);
  check(`a picture-less question is vertically centered (${Math.round(textOnly.noImg.offCenter)}px off, not ${Math.round(textOnly.noImg.fromTop)}px from top)`,
    textOnly.noImg.offCenter < textOnly.noImg.cardHeight * 0.2);
  check(`a picture-less question uses a LARGER base type than an image question (${Math.round(textOnly.noImg.base)}px > ${Math.round(textOnly.withImg.base)}px)`,
    textOnly.noImg.base > textOnly.withImg.base);
  check("a question WITH an image is NOT text-only (keeps the image layout)", textOnly.withImg.textOnlyClass === false);
  await ipad.close();

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
