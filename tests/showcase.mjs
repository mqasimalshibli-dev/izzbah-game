// The landing page's category showcase (preview/index.html) is a horizontal
// carousel on a PINNED stage, driven by page scroll for a bounded distance.
//
// It used to be scroll-driven with no bound: the section was `CATS.length * 34`
// svh tall — 1360svh at 40 categories — so reading anything BELOW the showcase
// meant scrolling nearly fourteen screen-heights of it first. The scroll drive
// is wanted; the fourteen screens are not. This test pins both halves:
//
//   1. every category is a slide, and they all render,
//   2. the stage is ONE screen and the whole section costs only a few — the
//      budget is `SPOT` categories, not all forty,
//   3. page scroll advances the carousel while the stage is pinned, and the
//      pin releases at the end of the budget,
//   4. taking hold of the carousel by hand stops the scroll driver, so the
//      two never fight over the track,
//   5. the track is a scroll-snap scroller with `overscroll-behavior-x:
//      contain` — without that, a swipe running off the end of the track
//      chains into the page and, on iOS, into the browser's back gesture,
//   6. the arrows and the Home/End keys move the focused slide, and the
//      counter / progress bar / disabled state follow it,
//   7. covers attach lazily but the focused one is never blank,
//   8. the page loads with no JS error and no 4xx.
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
      stageH: Math.round(document.getElementById("catStage").getBoundingClientRect().height),
      stagePos: getComputedStyle(document.getElementById("catStage")).position,
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

  // (2) the scroll budget is bounded. 40 categories × 34svh was 1360svh; the
  // stage itself must stay one screen, and the section only a few.
  check("the stage is pinned", base.stagePos === "sticky", base.stagePos);
  check("the stage is one screen tall",
    base.stageH <= base.vh + 2, `${base.stageH}px vs ${base.vh}px viewport`);
  check("the scroll budget is bounded, not a screen-third per category",
    base.secH > base.vh * 1.5 && base.secH < base.vh * 7,
    `${base.secH}px = ${(base.secH / base.vh).toFixed(1)} screens (was 13.6)`);
  check("the page is not dominated by the showcase",
    base.pageH < base.vh * 18, `page ${base.pageH}px`);
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
      accent: document.getElementById("catStage").style.getPropertyValue("--accent").trim(),
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

  // (3)/(4) the scroll drive, and handing control over.
  // Fresh load: the arrow clicks above deliberately hand control to the reader
  // and switch the scroll driver off for the rest of that page's life.
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(1000);
  const driven = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const t = document.getElementById("catTrack");
    const sec = document.getElementById("cats");
    const stage = document.getElementById("catStage");
    const focus = () => {
      const tr = t.getBoundingClientRect(), mid = tr.left + tr.width / 2;
      let best = 0, bd = Infinity;
      [...t.children].forEach((s, i) => {
        const r = s.getBoundingClientRect();
        const d = Math.abs(r.left + r.width / 2 - mid);
        if (d < bd) { bd = d; best = i; }
      });
      return best;
    };
    const top = () => scrollY + sec.getBoundingClientRect().top;
    const out = {};
    const secTop = top();
    scrollTo({ top: secTop, behavior: "instant" }); await wait(250);
    out.atStart = focus();
    out.pinnedAtStart = Math.abs(stage.getBoundingClientRect().top) < 3;

    // a third of the way through the budget
    const budget = sec.getBoundingClientRect().height - innerHeight;
    scrollTo({ top: secTop + budget * 0.5, behavior: "instant" });
    await wait(250);
    out.atHalf = focus();
    out.pinnedAtHalf = Math.abs(stage.getBoundingClientRect().top) < 3;

    scrollTo({ top: secTop + budget, behavior: "instant" }); await wait(250);
    out.atEnd = focus();
    out.budgetPx = Math.round(budget);
    out.last = t.children.length - 1;

    // past the budget the pin must let go
    scrollTo({ top: secTop + budget + innerHeight * 0.8, behavior: "instant" }); await wait(250);
    out.releasedAfter = stage.getBoundingClientRect().top < -10;

    // now take hold by hand: a touch on the track, then a manual scroll
    scrollTo({ top: secTop, behavior: "instant" }); await wait(250);
    t.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const kids = [...t.children];
    const tr = t.getBoundingClientRect(), r = kids[5].getBoundingClientRect();
    t.style.scrollSnapType = "none";
    t.scrollBy({ left: (r.left + r.width / 2) - (tr.left + tr.width / 2), behavior: "auto" });
    t.style.scrollSnapType = "";
    // the re-snap is a SMOOTH animation — read it too early and you catch the
    // track in flight, which looks exactly like the driver fighting back
    await wait(900);
    out.afterHand = focus();
    // page scroll must NOT drag it back now
    scrollTo({ top: secTop + budget * 0.5, behavior: "instant" }); await wait(600);
    out.afterHandThenScroll = focus();
    return out;
  });

  check("the stage pins while the budget lasts",
    driven.pinnedAtStart && driven.pinnedAtHalf);
  check("page scroll advances the carousel",
    driven.atHalf > driven.atStart && driven.atEnd > driven.atHalf,
    `${driven.atStart} → ${driven.atHalf} → ${driven.atEnd} over ${driven.budgetPx}px`);
  // it must walk the WHOLE catalogue, not a spotlight of the first few — the
  // budget is short because the RATE is fast, not because categories are
  // dropped from the drive
  check("the scroll reaches the last category",
    driven.atEnd === driven.last, `ended on ${driven.atEnd + 1} of ${driven.last + 1}`);
  check("the scroll passes the halfway category too",
    Math.abs(driven.atHalf - driven.last / 2) <= 1,
    `halfway showed ${driven.atHalf + 1}, expected ~${Math.round(driven.last / 2) + 1}`);
  check("the pin releases at the end of the budget", driven.releasedAfter === true);
  check("a hand on the carousel stops the scroll driver",
    driven.afterHand === 5 && driven.afterHandThenScroll === 5,
    `hand→${driven.afterHand}, then page scroll→${driven.afterHandThenScroll}`);

  // Covers: a 4/5 frame filled by `cover` keeps only 0.8/aspect of a wide
  // image — 45% of a 480x270 — and the subject is usually in the part that
  // goes. Wide covers must switch to the whole-picture treatment; square and
  // portrait ones must NOT (they lose little, and letterboxing them all would
  // fill the page with blur).
  const crops = await page.evaluate(async () => {
    const t = document.getElementById("catTrack");
    t.querySelectorAll("img[data-src]").forEach(i => { i.src = i.dataset.src; delete i.dataset.src; });
    await new Promise(r => setTimeout(r, 5000));
    const rows = [...t.children].map(s => {
      const im = s.querySelector("img"), art = s.querySelector(".cat-art");
      return {
        ar: im.naturalWidth ? im.naturalWidth / im.naturalHeight : 0,
        fit: art.classList.contains("fit"),
        haze: !!(art.querySelector(".haze") || {}).style?.backgroundImage,
        w: im.naturalWidth,
      };
    });
    return {
      loaded: rows.filter(r => r.w).length,
      total: rows.length,
      wrongWide: rows.filter(r => r.w && r.ar > 1.2 && !r.fit).length,
      wrongSquare: rows.filter(r => r.w && r.ar >= 0.75 && r.ar <= 1.05 && r.fit).length,
      fitted: rows.filter(r => r.fit).length,
      hazeMissing: rows.filter(r => r.fit && !r.haze).length,
      tiny: rows.filter(r => r.w && r.w < 500).length,
    };
  });
  check("every cover loads", crops.loaded === crops.total, `${crops.loaded}/${crops.total}`);
  check("wide covers show the whole picture instead of being cropped",
    crops.wrongWide === 0 && crops.fitted > 0, `${crops.fitted} fitted, ${crops.wrongWide} still cropped`);
  check("square and portrait covers still fill the frame",
    crops.wrongSquare === 0, `${crops.wrongSquare} needlessly letterboxed`);
  check("every fitted cover has its blurred backdrop", crops.hazeMissing === 0);
  // the showcase art is ~446 CSS px wide = ~892 device px at 2x; a file under
  // 500px across is being blown up more than twice by the browser
  check("no showcase cover is under 500px across",
    crops.tiny === 0, `${crops.tiny} too small`);

  // (7) lazy covers, but never a blank focused one
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
      vw: innerWidth,
      slideW: Math.round(s0.width),
      trackW: Math.round(t.clientWidth),
      arrowsHidden: getComputedStyle(document.getElementById("scNext")).display === "none",
      scrollable: t.scrollWidth > t.clientWidth + 10,
      overX: getComputedStyle(t).overscrollBehaviorX,
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
    };
  });
  // `slideW === trackW` alone passes happily when BOTH are stuck at the
  // desktop width (a grid item whose min-content refuses to shrink), and the
  // section's `overflow-x: clip` hides the damage — so pin the track to the
  // viewport too.
  check("phone: one slide fills the track",
    Math.abs(phone.slideW - phone.trackW) <= 2, `${phone.slideW} vs ${phone.trackW}`);
  check("phone: the track fits the phone",
    phone.trackW <= phone.vw, `track ${phone.trackW}px in a ${phone.vw}px window`);
  check("phone: the track still scrolls", phone.scrollable === true);
  check("phone: the gesture is still contained", phone.overX === "contain");
  check("phone: the arrows give way to the swipe", phone.arrowsHidden === true);
  check("phone: the scroll budget is still bounded",
    phone.secH > phone.vh * 1.5 && phone.secH < phone.vh * 7,
    `${phone.secH}px = ${(phone.secH / phone.vh).toFixed(1)} screens`);
  check("phone: the page still does not scroll sideways",
    phone.docScrollW <= phone.docClientW + 1, `${phone.docScrollW} vs ${phone.docClientW}`);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
