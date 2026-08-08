// The landing page's category showcase is a SELF-CONTAINED horizontal
// carousel (preview/index.html).
//
// It used to be scroll-DRIVEN: the section was `CATS.length * 34` svh tall —
// 1360svh at 40 categories — and the page scroll stepped through it. Reading
// anything BELOW the showcase meant scrolling nearly fourteen screen-heights
// of it first. This test pins the properties that stop that regressing:
//
//   1. every category is a slide, and they all render,
//   2. the section is about ONE screen tall (not N screens),
//   3. the track is a scroll-snap scroller with `overscroll-behavior-x:
//      contain` — without that, a swipe running off the end of the track
//      chains into the page and, on iOS, into the browser's back gesture,
//   4. the arrows and the Home/End keys move the focused slide, and the
//      counter / progress bar / disabled state follow it,
//   5. covers attach lazily but the focused one is never blank,
//   6. the page loads with no JS error and no 4xx.
//
// Run:  IZZBAH_CHROMIUM=/path/to/chrome node tests/showcase.mjs

import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8207;
const checks = [];
const check = (name, ok, extra) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS ✅" : "FAIL ❌"}  ${name}${extra ? "  — " + extra : ""}`);
};

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));

const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const jsErrors = [], badStatus = [];
page.on("pageerror", e => jsErrors.push(e.message));
page.on("response", r => { if (r.status() >= 400) badStatus.push(r.status() + " " + r.url()); });

try {
  await page.goto(`http://127.0.0.1:${PORT}/preview/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1200);

  const base = await page.evaluate(() => {
    const t = document.getElementById("catTrack");
    const sec = document.getElementById("cats");
    if (!t || !sec) return null;
    const cs = getComputedStyle(t);
    return {
      // the all-categories grid is built from the same list, so it is an
      // independent count of how many categories the page knows about
      cats: document.querySelectorAll("#allGrid .gcard").length,
      slides: t.children.length,
      secH: Math.round(sec.getBoundingClientRect().height),
      vh: innerHeight,
      pageH: document.documentElement.scrollHeight,
      // the track is 43,000px of content and the ambient glow overhangs the
      // section by 25% each side — neither may widen the PAGE
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
      snap: cs.scrollSnapType,
      overX: cs.overscrollBehaviorX,
      overflowX: cs.overflowX,
      count: document.getElementById("scCount").textContent.trim(),
      prevDis: document.getElementById("scPrev").disabled,
      nextDis: document.getElementById("scNext").disabled,
      prevX: Math.round(document.getElementById("scPrev").getBoundingClientRect().left),
      nextX: Math.round(document.getElementById("scNext").getBoundingClientRect().left),
      prevGlyph: document.getElementById("scPrev").textContent.trim(),
      nextGlyph: document.getElementById("scNext").textContent.trim(),
      // the first slide must be fully populated, not an empty shell
      firstTitle: t.children[0].querySelector("h3").textContent.trim(),
      firstDesc: t.children[0].querySelector("p").textContent.trim().length,
      firstTag: t.children[0].querySelector(".cat-tag").textContent.trim().length,
      firstPlay: t.children[0].querySelector(".cat-play").getAttribute("href") || "",
      pending: [...t.querySelectorAll("img[data-src]")].length,
    };
  });

  check("the showcase carousel is present", !!base);
  if (!base) throw new Error("no #catTrack — the showcase did not build");

  check("one slide per category", base.slides > 0 && base.slides === base.cats,
    `${base.slides} slides / ${base.cats} categories`);
  check("the first slide is fully populated",
    base.firstTitle.length > 0 && base.firstDesc > 0 && base.firstTag > 0
    && base.firstPlay.includes("#g="),
    base.firstTitle);

  // (2) the whole point of the change: the section is ~one screen, not N.
  check("the section is about one screen tall",
    base.secH < base.vh * 2, `${base.secH}px vs ${base.vh}px viewport`);
  check("the page is not dominated by the showcase",
    base.pageH < base.vh * 14, `page ${base.pageH}px`);
  check("the showcase does not widen the page",
    base.docScrollW <= base.docClientW + 1, `${base.docScrollW} vs ${base.docClientW}`);

  // (3) the gesture must stay inside the track
  check("the track is a horizontal scroller", /auto|scroll/.test(base.overflowX), base.overflowX);
  check("the track snaps horizontally", /x/.test(base.snap) && /mandatory|proximity/.test(base.snap), base.snap);
  check("the swipe cannot chain into the page", base.overX === "contain", base.overX);

  // (4) controls
  check("it starts on the first category", base.prevDis === true && base.nextDis === false);
  check("«السابق» sits on the right, RTL-style",
    base.prevX > base.nextX, `prev@${base.prevX} next@${base.nextX}`);
  // ‹ › (U+2039/U+203A) are Bidi_Mirrored: inside an RTL run the browser flips
  // them, so the right-hand «previous» arrow ends up pointing left and the
  // left-hand «next» arrow points right — both backwards. Only non-mirroring
  // glyphs are safe here.
  check("the arrows do not use bidi-mirrored glyphs",
    !/[‹›❬❭❮❯❰❱<>]/.test(base.prevGlyph + base.nextGlyph),
    `${base.prevGlyph} ${base.nextGlyph}`);
  check("the counter reads the position", base.count.length > 0, base.count);

  const stepped = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const t = document.getElementById("catTrack");
    const read = () => ({
      count: document.getElementById("scCount").textContent.trim(),
      bar: document.querySelector("#pips i").style.width,
      prevDis: document.getElementById("scPrev").disabled,
      nextDis: document.getElementById("scNext").disabled,
      accent: document.getElementById("cats").style.getPropertyValue("--accent").trim(),
      // which slide sits under the track's centre, measured from rects
      focus: (() => {
        const tr = t.getBoundingClientRect(), mid = tr.left + tr.width / 2;
        let best = 0, bd = Infinity;
        [...t.children].forEach((s, i) => {
          const r = s.getBoundingClientRect();
          const d = Math.abs(r.left + r.width / 2 - mid);
          if (d < bd) { bd = d; best = i; }
        });
        return best;
      })(),
    });
    const out = { at0: read() };
    document.getElementById("scNext").click();
    await wait(900);
    out.at1 = read();
    document.getElementById("scPrev").click();
    await wait(900);
    out.back = read();
    t.focus();
    t.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    await wait(1400);
    out.end = read();
    t.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    await wait(1400);
    out.home = read();
    out.blankFocused = (() => {
      const im = t.children[read().focus].querySelector("img");
      return !im || !im.src || (im.complete && im.naturalWidth === 0);
    })();
    out.last = t.children.length - 1;
    return out;
  });

  check("«التالي» advances one category",
    stepped.at1.focus === 1, `focus ${stepped.at0.focus} → ${stepped.at1.focus}`);
  check("«السابق» goes back",
    stepped.back.focus === 0 && stepped.back.prevDis === true,
    `focus ${stepped.back.focus}`);
  check("the progress bar follows the position",
    parseFloat(stepped.at1.bar) > parseFloat(stepped.at0.bar),
    `${stepped.at0.bar} → ${stepped.at1.bar}`);
  check("the counter changes with the position",
    stepped.at1.count !== stepped.at0.count, `${stepped.at0.count} → ${stepped.at1.count}`);
  check("End jumps to the last category",
    stepped.end.focus === stepped.last && stepped.end.nextDis === true,
    `focus ${stepped.end.focus} / last ${stepped.last}`);
  check("Home jumps back to the first",
    stepped.home.focus === 0 && stepped.home.prevDis === true, `focus ${stepped.home.focus}`);
  check("the ambient accent tracks the category", stepped.end.accent.length > 0, stepped.end.accent);

  // (5) lazy covers, but never a blank focused one
  check("covers attach lazily, not all at once", base.pending > 0, `${base.pending} deferred at load`);
  check("the focused cover is never blank", stepped.blankFocused === false);

  // (6) hygiene
  check("no uncaught JS error", jsErrors.length === 0, jsErrors.slice(0, 2).join(" | "));
  const real4xx = badStatus.filter(s => !/favicon/.test(s));
  check("no failed requests", real4xx.length === 0, real4xx.slice(0, 3).join(" | "));

  // narrow phone: the arrows are hidden (the swipe is the affordance) but the
  // slides must still be one-per-screen and the track still scrollable
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(500);
  const phone = await page.evaluate(() => {
    const t = document.getElementById("catTrack");
    const sec = document.getElementById("cats");
    const s0 = t.children[0].getBoundingClientRect();
    return {
      secH: Math.round(sec.getBoundingClientRect().height),
      vh: innerHeight,
      slideW: Math.round(s0.width),
      trackW: Math.round(t.clientWidth),
      arrowsHidden: getComputedStyle(document.getElementById("scNext")).display === "none",
      scrollable: t.scrollWidth > t.clientWidth + 10,
      overX: getComputedStyle(t).overscrollBehaviorX,
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
    };
  });
  check("phone: one slide fills the track",
    Math.abs(phone.slideW - phone.trackW) <= 2, `${phone.slideW} vs ${phone.trackW}`);
  check("phone: the track still scrolls", phone.scrollable === true);
  check("phone: the gesture is still contained", phone.overX === "contain");
  check("phone: the arrows give way to the swipe", phone.arrowsHidden === true);
  check("phone: the section is still about one screen",
    phone.secH < phone.vh * 2, `${phone.secH}px vs ${phone.vh}px`);
  check("phone: the page still does not scroll sideways",
    phone.docScrollW <= phone.docClientW + 1, `${phone.docScrollW} vs ${phone.docClientW}`);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
