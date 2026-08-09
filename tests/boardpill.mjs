// The board card's anatomy, and the turn pill (build .289).
//
// Two things, both reported by the owner from a real device.
//
// 1) THE BOARD CARD. Each category is a cover with its NAME in a pill at the
//    top-right and the point cells below. That only works because the card is a
//    flex column with `justify-content: flex-end`: the cells are the sole
//    in-flow child, so as a block they sit at the TOP — directly over the
//    absolutely-positioned title, which shares their z-index and loses on DOM
//    order. The result is "the names are gone and the cells are on top".
//    It shipped that way in .287 because a sed used to temporarily revert an
//    unrelated rule also matched this one, and the restore pattern was anchored
//    so it did not match back. Hence a behavioural pin rather than trust.
//
// 2) THE TURN PILL. A maroon lozenge carrying the team PHOTO, the label and a
//    swap control. Its layout is easy to undo from a distance: three separate
//    rules used to repaint its background translucent-white, and a short
//    landscape rule used to place its children at explicit GRID coordinates —
//    which came apart silently the moment the photo gained a wrapper element.
//
// Run:  IZZBAH_CHROMIUM=/path/to/chrome node tests/boardpill.mjs

import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8289;
const checks = [];
const check = (name, ok, extra) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM || undefined });
const jsErrors = [];

// A landscape phone AND a portrait one: the pill has a separate compact layout
// under `(orientation: landscape) and (max-height: 600px)`, and that is the one
// that broke. Testing only portrait would have missed it entirely.
const VIEWPORTS = [[1280, 589, "landscape"], [390, 844, "portrait"]];

try {
  for (const [w, h, label] of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.route("**/firebasejs/**", r => r.abort());
    await page.addInitScript(() => {
      try {
        localStorage.setItem("izzbah-legal-consent-v1", "1");
        localStorage.setItem("izzbah-coach-v1", JSON.stringify({ __all: 1 }));
      } catch (e) {}
    });
    page.on("pageerror", e => jsErrors.push(`${label}: ${e.message}`));
    await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(2200);

    const board = await page.evaluate(async () => {
      window.IZZBAH.applyAuth(true, "u");
      showScreen("categories");
      await new Promise(r => setTimeout(r, 400));
      state.selected = new Set(visibleCategoryGroup().filter(categoryHasQuestions).map(c => c.id).slice(0, 6));
      renderCategories();
      await new Promise(r => setTimeout(r, 300));
      document.getElementById("catGoFloat").click();
      await new Promise(r => setTimeout(r, 600));
      const start = [...document.querySelectorAll("button")].find(b => /ابدأ اللعبة/.test(b.textContent));
      if (start) start.click();
      await new Promise(r => setTimeout(r, 1100));

      const cards = [...document.querySelectorAll(".board-category-card")];
      const rows = [];
      for (const card of cards.slice(0, 3)) {
        // elementFromPoint works in VIEWPORT coordinates, so the title has to be
        // on screen before it means anything. Untouched, it reported the sticky
        // header (or nothing) as the covering element on a portrait phone and
        // the check failed on a board that was perfectly fine.
        card.scrollIntoView({ block: "center" });
        await new Promise(r => setTimeout(r, 120));
        const t = card.querySelector(".board-card-title");
        const p = card.querySelector(".board-card-points");
        const tr = t.getBoundingClientRect(), pr = p.getBoundingClientRect();
        const cr = card.getBoundingClientRect();
        // Is any of the title actually PAINTED, or is the points grid over it?
        const cx = Math.round(tr.left + tr.width / 2), cy = Math.round(tr.top + tr.height / 2);
        const hitEl = document.elementFromPoint(cx, cy);
        const onScreen = cy > 0 && cy < innerHeight && cx > 0 && cx < innerWidth;
        rows.push({
          name: (t.textContent || "").trim(),
          display: getComputedStyle(card).display,
          titleTop: Math.round(tr.top - cr.top),
          pointsTop: Math.round(pr.top - cr.top),
          onScreen,
          // Only meaningful when the point is actually in the viewport.
          covered: onScreen && !(hitEl && (hitEl === t || t.contains(hitEl))),
          hit: hitEl ? (hitEl.className || hitEl.tagName).toString().slice(0, 30) : "none",
          cells: card.querySelectorAll(".cell").length,
        });
      }
      /* The board is LANDSCAPE-ONLY: in portrait the game covers it with a
         «rotate your device» overlay. Hit-testing the title there measures that
         overlay, not the stacking inside the card, so the caller skips the
         board assertions rather than reporting a phantom failure. */
      /* `landscape-only` is a class on BODY, so querySelector matches it in
         LANDSCAPE too — using that alone skipped the board checks everywhere,
         which is how a guard turns into a silent pass. The overlay is a ::after
         on that body and only paints when the window is actually portrait. */
      const blocked = document.body.classList.contains("landscape-only")
        && window.innerHeight > window.innerWidth;
      return { screen: document.body.dataset.screen, cards: cards.length, rows, blocked };
    });

    check(`${label}: the game started`, board.screen === "game" && board.cards >= 3, board.screen);
    if (board.blocked) {
      console.log(`SKIP  ${label}: board checks — the game shows its rotate-to-landscape overlay here`);
    } else {
    check(`${label}: every card names its category`,
      board.rows.every(r => r.name.length > 0), board.rows.map(r => r.name).join(" | "));
    // The direct cause: a block card puts the cells at the top of the flow.
    check(`${label}: the card is a column, so the cells sit at the BOTTOM`,
      board.rows.every(r => r.display === "flex" && r.titleTop < r.pointsTop),
      board.rows.map(r => `${r.display} title@${r.titleTop} pts@${r.pointsTop}`).join(" ; "));
    // …and the symptom, measured where it is seen: is the name actually visible?
    check(`${label}: the name is not painted over by the cells`,
      board.rows.every(r => !r.covered) && board.rows.some(r => r.onScreen),
      board.rows.map(r => `${r.onScreen ? "" : "offscreen "}${r.hit}`).join(" | "));
    check(`${label}: the cells are still there`, board.rows.every(r => r.cells >= 3),
      board.rows.map(r => r.cells).join(","));
    }

    // ── the turn pill ────────────────────────────────────────────────────
    const pill = await page.evaluate(() => {
      const box = document.querySelector(".turn-box");
      const br = box.getBoundingClientRect();
      const cs = getComputedStyle(box);
      const rect = sel => {
        const el = box.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { l: r.left - br.left, r: r.right - br.left, t: r.top - br.top, b: r.bottom - br.top, w: r.width, h: r.height };
      };
      return {
        w: Math.round(br.width), h: Math.round(br.height),
        radius: cs.borderRadius,
        // the design is a maroon gradient; three separate rules once repainted
        // it flat translucent-white, which is what "the old pill" looks like
        gradient: /gradient/.test(cs.backgroundImage),
        photo: rect(".turn-photo"), avatar: rect(".turn-avatar"),
        label: rect(".turn-label"), swap: rect(".turn-switch"),
        swapIcon: !!box.querySelector(".turn-switch svg"),
        name: (box.querySelector(".turn-label strong") || {}).textContent || "",
        rtl: cs.direction === "rtl",
      };
    });
    check(`${label}: the pill shows the team PHOTO, not a letter`,
      !!pill.photo && pill.photo.w > 12, pill.photo ? `${Math.round(pill.photo.w)}px` : "missing");
    check(`${label}: it keeps its own gradient`, pill.gradient && pill.radius === "999px",
      `${pill.radius} gradient=${pill.gradient}`);
    check(`${label}: the swap control is an icon button`, pill.swapIcon);
    check(`${label}: it names the team`, pill.name.trim().length > 0, pill.name);
    // RTL row: photo on the right, swap on the far left, label between them.
    check(`${label}: photo right, swap left, label between`,
      pill.rtl && pill.photo.l > pill.label.l && pill.label.l > pill.swap.l,
      `photo@${Math.round(pill.photo.l)} label@${Math.round(pill.label.l)} swap@${Math.round(pill.swap.l)}`);
    /* Everything inside the lozenge. The compact landscape layout placed the
       photo and the swap at fixed grid coordinates; once the photo gained a
       wrapper those coordinates addressed nothing and the pieces spilled out of
       the pill — while every other assertion here still passed. */
    const inside = el => el && el.t >= -1 && el.b <= pill.h + 1 && el.l >= -1 && el.r <= pill.w + 1;
    check(`${label}: nothing spills out of the pill`,
      inside(pill.photo) && inside(pill.swap) && inside(pill.label),
      `pill ${pill.w}x${pill.h}; photo ${Math.round(pill.photo.t)}..${Math.round(pill.photo.b)}`);

    await page.close();
  }

  check("no uncaught JS error", jsErrors.length === 0, jsErrors.slice(0, 2).join(" | "));
} catch (e) {
  check(`threw: ${e && e.message}`, false);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
