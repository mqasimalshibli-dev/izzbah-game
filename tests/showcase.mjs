// The landing page's category showcase — now a 3D rail (preview/index.html).
//
// It used to be a horizontal scroll-snap track of full-width slides. The owner
// asked for the effect in a reference clip instead: the covers laid along ONE
// diagonal axis receding into the screen, near and large at one end, small and
// far at the other, every card turned by the same angle so the row reads as a
// fanned-out deck. Pressing a card shows that category's description, brings it
// toward the reader, and pushes the rest back.
//
// Three things here are load-bearing and easy to break silently:
//
// ⚠️ THE SCENE MUST STAY 3D. `perspective` belongs on the rail and
// `transform-style: preserve-3d` on the cards. Put perspective on an ancestor
// that also clips or filters and the browser FLATTENS everything onto one
// plane — the page still renders, the cards still move, and the effect is
// quietly gone. So this asserts that laid-out cards occupy DISTINCT depths,
// not merely that a perspective property is set somewhere.
//
// ⚠️ THE SECTION'S COST MUST NOT SCALE WITH THE CATALOGUE. The old drive spent
// `(n-1) × 6svh`, so every category published made the pinned section longer —
// 3.4 screens at forty, and the owner's note on it was "you can't bypass the
// scroller without scrolling all the categories". The budget is now a constant
// number of screens whatever the catalogue does. The test pins the total height
// in screens, which is the number a reader actually pays.
//
// ⚠️ A PINNED SECTION IS A TOLL GATE, SO IT NEEDS A WAY OUT. `.sc-skip` jumps
// straight to #all. Any future change that keeps the pin must keep an escape.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8207;
const checks = [];
const check = (n, ok, extra) => {
  checks.push(!!ok);
  console.log(`${ok ? "PASS ✅" : "FAIL ❌"}  ${n}${extra ? "  — " + extra : ""}`);
};

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

/* ⚠️ The touch rows must really be emulated as touch. The pinned scroll drive
   is gated on `(hover:hover) and (pointer:fine)`, and a plain narrow window
   still reports a fine pointer — so a phone-sized page WITHOUT touch emulation
   silently exercises the desktop path and proves nothing about phones.
   [label, w, h, touch] */
const VIEWPORTS = [
  ["phone     390×844", 390, 844, true],
  ["phone     320×568", 320, 568, true],
  ["landscape 844×390", 844, 390, true],
  ["desktop  1440×900", 1440, 900, false],
];

// A fresh CONTEXT per case, because touch emulation is a context-level setting
// and the whole point is that the two devices take different paths.
let CTX = null, PAGE = null;
async function load(w, h, touch) {
  if (CTX) await CTX.close();
  CTX = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1,
                                   isMobile: !!touch, hasTouch: !!touch });
  PAGE = await CTX.newPage();
  PAGE.on("pageerror", e => errs.push(e.message));
  await PAGE.goto(`http://127.0.0.1:${PORT}/preview/index.html`, { waitUntil: "load", timeout: 30000 });
  await PAGE.waitForTimeout(1000);
  await PAGE.evaluate(() => document.getElementById("cats").scrollIntoView());
  await PAGE.waitForTimeout(700);
  return PAGE;
}

// Read the rail's geometry straight off the custom properties the driver sets.
const geom = page => page.evaluate(() => {
  const rail = document.getElementById("catRail");
  const cards = [...rail.querySelectorAll(".c3")];
  const on = cards.filter(c => getComputedStyle(c).display !== "none");
  const num = (el, p) => parseFloat(el.style.getPropertyValue(p)) || 0;
  const activeEl = rail.querySelector(".c3.is-active");
  return {
    total: cards.length,
    laidOut: on.length,
    active: cards.indexOf(activeEl),
    perspective: getComputedStyle(rail).perspective,
    preserve3d: getComputedStyle(cards[0]).transformStyle,
    tabbable: cards.filter(c => c.tabIndex === 0).length,
    // ordered by index so a monotonic walk is meaningful
    laid: on.map(c => ({ i: cards.indexOf(c), x: num(c, "--x"), y: num(c, "--y"), z: num(c, "--z") }))
          .sort((a, b) => a.i - b.i),
    picked: document.getElementById("cats").classList.contains("is-picked"),
    descVis: getComputedStyle(document.getElementById("cdDesc")).visibility,
    hintVis: getComputedStyle(document.getElementById("cdHint")).visibility,
    name: document.getElementById("cdName").textContent.trim(),
    playHref: document.getElementById("cdPlay").getAttribute("href") || "",
  };
});

try {
  for (const [name, w, h, touch] of VIEWPORTS) {
    const page = await load(w, h, touch);
    const phone = touch;

    const g0 = await geom(page);
    check(`${name}: the rail holds every category`, g0.total === 40, `${g0.total} cards`);

    // Only a window is laid out — forty composited layers of blur-backed art is
    // a lot of work for a phone, and the far ones are under a pixel of opacity.
    check(`${name}: only a window of cards is laid out`,
      g0.laidOut > 3 && g0.laidOut < g0.total, `${g0.laidOut} of ${g0.total}`);

    // THE 3D CHECK. Not "is perspective set" — "do the cards actually occupy
    // different depths", which is what a flattened scene loses.
    const depths = new Set(g0.laid.map(c => Math.round(c.z)));
    check(`${name}: the scene is genuinely 3D — cards sit at distinct depths`,
      depths.size >= 3 && g0.perspective !== "none" && g0.preserve3d === "preserve-3d",
      `${depths.size} depths, perspective ${g0.perspective}`);

    // ONE diagonal axis: x and y both walk monotonically with the index, so the
    // row reads as a single receding line rather than a scatter or an arc.
    const xs = g0.laid.map(c => c.x), ys = g0.laid.map(c => c.y);
    const mono = a => a.every((v, i) => i === 0 || v > a[i - 1]) || a.every((v, i) => i === 0 || v < a[i - 1]);
    check(`${name}: the cards lie on one straight diagonal`, mono(xs) && mono(ys),
      `x ${xs[0]}→${xs[xs.length - 1]}, y ${ys[0]}→${ys[ys.length - 1]}`);
    // …and depth peaks at the active card and falls away on both sides.
    const zActive = g0.laid.find(c => c.i === g0.active);
    check(`${name}: the active card is the nearest one`,
      g0.laid.every(c => c.z <= zActive.z + 0.5), `active z ${zActive.z}`);

    /* ⚠️ No border, no opaque fill on a rail cover. `.cat-art` carries a 1px
       `--rule` and a `--maroon-lo` background for the flat grid, and on a
       fanned rail the covers overlap by about half — so what shows of the card
       behind is a thin strip of ITS border and backdrop, which reads as a line
       drawn between the covers. Reported as "there is a red line behind the
       category covers". */
    const skin = await page.evaluate(() => {
      const art = document.querySelector(".c3 .cat-art"), cs = getComputedStyle(art);
      const a = (cs.backgroundColor.match(/[\d.]+\)$/) || ["1)"])[0];
      return { bw: cs.borderTopWidth, bg: cs.backgroundColor,
               opaqueBg: cs.backgroundColor !== "rgba(0, 0, 0, 0)" && parseFloat(a) > 0.05,
               radius: parseFloat(cs.borderTopLeftRadius) };
    });
    check(`${name}: covers draw no hairline where they overlap`,
      parseFloat(skin.bw) === 0 && !skin.opaqueBg, `border ${skin.bw}, bg ${skin.bg}`);
    check(`${name}: and their corners are not sharp`, skin.radius >= 18, `${skin.radius}px`);

    /* ⚠️ Every frame the same size, measured as LAYOUT size (offsetWidth), not
       the transformed rect — the whole point of the rail is that depth changes
       the projected size, so bounding rects legitimately differ.
       `aspect-ratio` only wins when nothing in flow says otherwise, and the
       cover <img> was in flow: each frame took its own picture's ratio, so a
       4/5 cover came out 300x375 and a 1080x720 one 300x200. */
    const frames = await page.evaluate(() =>
      [...document.querySelectorAll(".c3")]
        .filter(c => getComputedStyle(c).display !== "none")
        .map(c => { const a = c.querySelector(".cat-art"), im = c.querySelector("img");
                    return { w: a.offsetWidth, h: a.offsetHeight, loaded: im.naturalWidth > 0 }; }));
    const shapes = new Set(frames.map(f => f.w + "x" + f.h));
    check(`${name}: every cover is drawn at the same size`,
      shapes.size === 1 && frames[0].w > 40 && frames[0].h > 40, [...shapes].join(", "));
    // ⚠️ And every card that is LAID OUT has its picture. The source was being
    // attached for ±3 while layout places ±WINDOW, so six of thirteen visible
    // cards were empty frames and the fan looked half-populated.
    check(`${name}: every laid-out cover has actually loaded`,
      frames.every(f => f.loaded), `${frames.filter(f => f.loaded).length}/${frames.length}`);

    // Roving tabindex: forty buttons would be forty tab stops before the reader
    // ever reached the rest of the page.
    check(`${name}: only the active card is a tab stop`, g0.tabbable === 1, `${g0.tabbable} tabbable`);

    // Before a press: a hint, no description. The press is not discoverable on
    // a phone otherwise — there is no hover to reveal it.
    check(`${name}: it opens with a hint, not a description`,
      !g0.picked && g0.descVis === "hidden" && g0.hintVis === "visible");

    /* ── pressing a card ─────────────────────────────────────────────
       ⚠️ With a REAL pointer, never `el.click()`. Two shipped bugs hid behind
       a synthetic click: the rail called `setPointerCapture` on pointerdown,
       which retargets the click to the RAIL instead of the card, so pressing a
       cover did nothing — and `el.click()` sails straight past that because it
       dispatches at the node and skips the pointer stream entirely. If it can
       be pressed with a finger, press it with a finger. */
    const before = g0.laid.map(c => c.z);
    /* ⚠️ Do not tap the centre of a card's bounding rect. These cards are
       rotated in 3D, and `getBoundingClientRect` returns the axis-aligned box
       of the PROJECTED quad — bigger than the card, and on a short landscape
       rail its centre lands on empty stage. Hit-test for a point that really
       resolves to the card, exactly as the game's turn-pill test has to. */
    const tapCard = async () => {
      const box = await page.evaluate(() => {
        const on = [...document.querySelectorAll(".c3")].filter(c => getComputedStyle(c).display !== "none");
        const act = on.findIndex(c => c.classList.contains("is-active"));
        // The neighbour if it is reachable, else the active card — on a narrow
        // rail the neighbours are mostly behind the front card, and a reader
        // drags one forward before pressing it.
        for (const el of [on[act + 1], on[act]]) {
          if (!el) continue;
          const r = el.getBoundingClientRect();
          for (const fy of [0.5, 0.35, 0.65]) for (const fx of [0.5, 0.4, 0.6]) {
            const x = r.left + r.width * fx, y = r.top + r.height * fy;
            if (y < 4 || y > innerHeight - 4 || x < 4 || x > innerWidth - 4) continue;
            const hit = document.elementFromPoint(x, y);
            if (hit && hit.closest && hit.closest(".c3") === el) return { x, y };
          }
        }
        return null;
      });
      if (!box) return false;
      await page.mouse.move(box.x, box.y);
      await page.mouse.down();
      await page.mouse.up();
      return true;
    };
    check(`${name}: a card is reachable by a real tap`, await tapCard());
    await page.waitForTimeout(700);
    const g1 = await geom(page);

    check(`${name}: pressing a card reveals its description`,
      g1.picked && g1.descVis === "visible" && g1.hintVis === "hidden");
    check(`${name}: the description belongs to the card that was pressed`,
      g1.name.length > 0 && g1.playHref.includes("#g="), g1.name);
    // The two halves of the requested motion. Moving one card forward on its
    // own reads as a rendering glitch; pushing the rest back on its own reads
    // as the whole rail retreating. Both, or neither.
    const zAct = g1.laid.find(c => c.i === g1.active).z;
    const others = g1.laid.filter(c => c.i !== g1.active);
    check(`${name}: the chosen cover steps forward`, zAct > Math.max(...before),
      `z ${zAct} vs ${Math.max(...before)} before`);
    check(`${name}: the rest step back`,
      others.every(c => c.z < -Math.abs(c.i - g1.active) * 50), `${others.length} cards`);

    // ⚠️ The chosen card comes toward the reader, and perspective magnifies
    // whatever comes forward — so on a short rail the pop can grow the card
    // straight over the copy it is supposed to be introducing. This caught it
    // twice: once when the card was sized from the viewport instead of the
    // rail, and once when the forward step was a fixed 150px.
    const clear = await page.evaluate(() => {
      const a = document.querySelector(".c3.is-active").getBoundingClientRect();
      const n = document.getElementById("cdName").getBoundingClientRect();
      return { gap: Math.round(n.top - a.bottom), cardBottom: Math.round(a.bottom), nameTop: Math.round(n.top) };
    });
    // A real gap, not merely "did not overlap". Clearance of a few pixels is a
    // near miss that the next tweak to the pop turns into a hit.
    check(`${name}: the chosen cover leaves room above the copy`,
      clear.gap >= 12, `gap ${clear.gap}px (card ends ${clear.cardBottom}, name starts ${clear.nameTop})`);

    // Pressing the forward card again puts it back — the copy is dismissable
    // without hunting for a close button.
    const act = await page.evaluate(() => {
      const el = document.querySelector(".c3.is-active"), r = el.getBoundingClientRect();
      for (const fy of [0.5, 0.35, 0.65]) for (const fx of [0.5, 0.4, 0.6]) {
        const x = r.left + r.width * fx, y = r.top + r.height * fy;
        if (y < 4 || y > innerHeight - 4) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit && hit.closest && hit.closest(".c3") === el) return { x, y };
      }
      return null;
    });
    check(`${name}: the front card is reachable by a real tap`, !!act);
    if (act) { await page.mouse.move(act.x, act.y); await page.mouse.down(); await page.mouse.up(); }
    await page.waitForTimeout(600);
    const g2 = await geom(page);
    check(`${name}: pressing it again dismisses the description`,
      !g2.picked && g2.descVis === "hidden");

    /* ── the section's cost ──────────────────────────────────────── */
    const cost = await page.evaluate(() =>
      +(document.getElementById("cats").getBoundingClientRect().height / innerHeight).toFixed(2));
    check(`${name}: the section costs a fixed, small number of screens`, cost <= 2.7, `${cost} screens`);

    const noSide = await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    check(`${name}: the page still does not scroll sideways`, noSide);

    /* ── the two devices take different paths ─────────────────────
       A mouse scrolls in small deliberate notches and can stop on a frame, so
       holding the page while the wheel drives the rail is a reasonable desktop
       idiom. A thumb cannot: a flick is one gesture meaning "take me past
       this", and hijacking it makes the page feel stuck. Touch therefore gets
       an ordinary block that scrolls past, and the rail is swiped. */
    const mode = await page.evaluate(() => ({
      noPin: document.getElementById("cats").classList.contains("no-pin"),
      stage: getComputedStyle(document.getElementById("catStage")).position,
      hint: document.getElementById("cdHint").textContent.trim(),
    }));
    check(`${name}: ${phone ? "touch is NOT pinned" : "a mouse gets the pinned sweep"}`,
      phone ? (mode.noPin && mode.stage === "static") : (!mode.noPin && mode.stage === "sticky"),
      `${mode.stage}${mode.noPin ? ", no-pin" : ""}`);
    check(`${name}: the hint names a gesture that works here`,
      phone ? mode.hint.includes("اسحب") : !mode.hint.includes("اسحب"), mode.hint);

    if (phone) {
      const gone = await page.evaluate(() => {
        const a = document.getElementById("scSkip");
        return !a || getComputedStyle(a).display === "none";
      });
      check(`${name}: no escape button where there is no toll gate`, gone);
      const past = await page.evaluate(async () => {
        const on = () => [...document.querySelectorAll(".c3")].findIndex(c => c.classList.contains("is-active"));
        document.getElementById("cats").scrollIntoView();
        await new Promise(r => setTimeout(r, 350));
        const i0 = on(), y0 = window.scrollY;
        window.scrollBy(0, window.innerHeight * 1.2);
        await new Promise(r => setTimeout(r, 400));
        return { i0, i1: on(), moved: window.scrollY - y0 };
      });
      check(`${name}: scrolling goes past the section instead of driving it`,
        past.i0 === past.i1 && past.moved > 100,
        `index ${past.i0}→${past.i1}, page +${Math.round(past.moved)}px`);
      continue;
    }

    // The way out of a pinned section.
    // ⚠️ "Displayed" is not the test. The stage is PINNED, so anything that
    // falls outside the viewport cannot be reached while the pin holds. On a
    // landscape phone the skip button sat 96px BELOW the fold — present,
    // styled, and completely unreachable, which is the one failure this
    // control must never have.
    const skip = await page.evaluate(() => {
      const a = document.getElementById("scSkip");
      if (!a) return null;
      const r = a.getBoundingClientRect();
      return { href: a.getAttribute("href"), h: Math.round(r.height), bottom: Math.round(r.bottom),
               vh: window.innerHeight, shown: getComputedStyle(a).display !== "none" };
    });
    check(`${name}: there is a way past the showcase`,
      skip && skip.href === "#all" && skip.shown && skip.h >= 44, skip && `${skip.h}px`);
    check(`${name}: and it is on screen while the section is pinned`,
      skip && skip.bottom <= skip.vh + 1, skip && `bottom ${skip.bottom} of ${skip.vh}`);

    if (!phone) {
      // ‹ › are Bidi_Mirrored: in an RTL run the browser flips them and both
      // arrows end up pointing the wrong way. Geometric triangles are not.
      const arrows = await page.evaluate(() => ({
        prev: document.getElementById("scPrev").textContent.trim(),
        next: document.getElementById("scNext").textContent.trim(),
      }));
      check(`${name}: the arrows are not bidi-mirrored characters`,
        arrows.prev === "▸" && arrows.next === "◂", `${arrows.prev} ${arrows.next}`);
    }
  }

  /* ── page scroll drives the rail, then gets out of the way ──────── */
  let page = await load(1440, 900, false);
  /* ⚠️ `behavior: "instant"`. The page sets `html{scroll-behavior:smooth}`, so a
     plain `scrollTo` ANIMATES — every sample was being read mid-flight and the
     sweep looked like it stopped early. It failed about one run in three, which
     is the worst kind of red: real enough to chase, rare enough to dismiss.
     The last stop is deliberately past the end of the budget, so the answer is
     the last category or the assertion is about something real. */
  const swept = await page.evaluate(async () => {
    const SWEEP = 1.35;
    const at = () => [...document.querySelectorAll(".c3")].findIndex(c => c.classList.contains("is-active"));
    const sec = document.getElementById("cats");
    sec.scrollIntoView({ behavior: "instant" });
    await new Promise(r => setTimeout(r, 400));
    const top = window.scrollY, seen = [at()];
    for (const f of [0.3, 0.6, 0.9, 1.2]) {
      window.scrollTo({ top: top + f * innerHeight * SWEEP, behavior: "instant" });
      await new Promise(r => setTimeout(r, 350));
      seen.push(at());
    }
    return seen;
  });
  const rising = swept.every((v, i) => i === 0 || v >= swept[i - 1]);
  check("page scroll sweeps the whole rail", swept[0] === 0 && rising && swept[swept.length - 1] >= 38,
    swept.join(" → "));

  // Once the reader takes hold themselves the scroll driver must step aside for
  // good, or the next scroll event yanks the rail back and the two fight.
  const handedOver = await page.evaluate(async () => {
    const rail = document.getElementById("catRail");
    rail.focus();
    rail.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const mine = [...document.querySelectorAll(".c3")].indexOf(document.querySelector(".c3.is-active"));
    window.scrollBy(0, innerHeight * 0.4);
    await new Promise(r => setTimeout(r, 350));
    const after = [...document.querySelectorAll(".c3")].indexOf(document.querySelector(".c3.is-active"));
    return { mine, after };
  });
  /* ⚠️ A JUMP larger than the window is the only way a card gets stranded.
     `layout()` skips everything past the window, so a card that is more than
     WINDOW steps away in ONE move never runs the branch that would take its
     `is-active` off — and it keeps the gold ring, out in the distance, while
     the real front card has one too. Stepping one at a time never shows it,
     which is why nothing caught this for two builds. End/Home jump the lot. */
  const jumped = await page.evaluate(async () => {
    const rail = document.getElementById("catRail");
    rail.focus();
    rail.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const end = document.querySelectorAll(".c3.is-active").length;
    rail.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    return { end, home: document.querySelectorAll(".c3.is-active").length };
  });
  check("a far jump leaves exactly one card marked active",
    jumped.end === 1 && jumped.home === 1, `End ${jumped.end}, Home ${jumped.home}`);

  check("once the reader drives, page scroll stops moving the rail",
    handedOver.mine === handedOver.after, `${handedOver.mine} → ${handedOver.after}`);

  /* ── a tap must not switch the scroll driver off ─────────────────
     Reported from real use as "they don't scroll": `manual = true` ran on every
     pointerdown, so the first touch anywhere on the rail — a tap on a cover, or
     a touch that only meant to scroll the page — stopped page scroll ever
     moving the rail again. Handover belongs to a real DRAG. */
  // ⚠️ Reload first. The check above deliberately hands the rail over for good,
  // and this one is about a page where that has NOT happened.
  // ⚠️ `load()` closes the previous CONTEXT and returns a NEW page, so the
  // handle has to be rebound. Reusing the old one throws "Target page, context
  // or browser has been closed" several checks later, nowhere near the cause.
  page = await load(1440, 900, false);
  const afterTap = await page.evaluate(async () => {
    const sec = document.getElementById("cats");
    sec.scrollIntoView(); await new Promise(r => setTimeout(r, 400));
    return { top: window.scrollY,
             i: [...document.querySelectorAll(".c3")].indexOf(document.querySelector(".c3.is-active")) };
  });
  const card = await page.evaluate(() => {
    const r = document.querySelector(".c3.is-active").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(card.x, card.y);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(400);
  const tapped = await page.evaluate(() => document.getElementById("cats").classList.contains("is-picked"));
  check("a real tap opens the description", tapped);
  const stillSweeps = await page.evaluate(async (top) => {
    window.scrollTo(0, top + innerHeight * 0.5);
    await new Promise(r => setTimeout(r, 400));
    return { i: [...document.querySelectorAll(".c3")].indexOf(document.querySelector(".c3.is-active")),
             picked: document.getElementById("cats").classList.contains("is-picked") };
  }, afterTap.top);
  check("page scroll still sweeps the rail after a tap", stillSweeps.i > afterTap.i,
    `${afterTap.i} → ${stillSweeps.i}`);
  check("and scrolling on puts the description away", !stillSweeps.picked);

  // A real DRAG, by contrast, does take the wheel — and must not be mistaken
  // for a press on whichever card the finger lifted over.
  const drag = await page.evaluate(async () => {
    // Start mid-rail: at index 0 a drag can only travel one way and the test
    // would be measuring the clamp rather than the drag.
    // ⚠️ `behavior: "instant"` again, and the rail's box is read AFTER the page
    // has settled. With smooth scrolling the rect was measured mid-animation,
    // the rail had moved on by the time the mouse arrived, and the pointerdown
    // landed off it — so the drag simply never started.
    document.getElementById("cats").scrollIntoView({ behavior: "instant" });
    await new Promise(r => setTimeout(r, 300));
    window.scrollBy({ top: innerHeight * 0.6, behavior: "instant" });
    await new Promise(r => setTimeout(r, 450));
    const r = document.getElementById("catRail").getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             onRail: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) !== null,
             i: [...document.querySelectorAll(".c3")].findIndex(c => c.classList.contains("is-active")) };
  });
  await page.mouse.move(drag.x, drag.y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) { await page.mouse.move(drag.x - k * 30, drag.y); await page.waitForTimeout(40); }
  await page.mouse.up();
  await page.waitForTimeout(500);
  const dragged = await page.evaluate(() => ({
    i: [...document.querySelectorAll(".c3")].indexOf(document.querySelector(".c3.is-active")),
    picked: document.getElementById("cats").classList.contains("is-picked"),
  }));
  /* ⚠️ Assert the drag moves PROPORTIONALLY, not merely that it moved. A cover
     is an <img>, and images are draggable by default: a mouse drag started a
     native drag-and-drop, the browser fired `pointercancel` after the FIRST
     pointermove, and everything after it was discarded. The rail then advanced
     exactly one card for a drag of any length — which passes "it moved" while
     feeling completely broken. 240px at 46px per card is five. */
  check("a real drag moves the rail by the distance dragged",
    Math.abs(dragged.i - drag.i) >= 3, `${drag.i} → ${dragged.i}`);
  check("a drag is not mistaken for a press", !dragged.picked);

  check("no page errors" + (errs.length ? ": " + errs[0] : ""), errs.length === 0);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\n${checks.length}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
