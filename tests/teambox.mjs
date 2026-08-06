// The board team box, laid out as the owner specified.
//
// It used to be a tall card: a vertical strip of lifeline icons down one edge,
// the name and a big score centred, the +/- buttons underneath. The owner sent
// a layout to follow instead — ONE horizontal row per team, reading right to
// left: who the team is (badge, name, score), the manual +/- controls, then the
// lifelines laid out across with their names underneath.
//
// What this test pins is the arrangement and the things that make it readable,
// not the pixels: the order of the three parts, that they share a line, that
// each lifeline carries a caption, and that the caption disappears rather than
// squeezing the box on a narrow screen — a phone in landscape has a question
// grid to fit underneath.
//
// It also pins the team picture. A team with no photo of its own gets one of the
// five illustrated portraits by slot. Those briefly stopped being used on the
// board, which drew the عِزبة mark for every team — while the SETUP screen still
// offered the portraits as each team's placeholder, so a team picked as a falcon
// became a tent as soon as the board rendered. The portraits are the default
// again; the mark is only the fallback past the end of the list, and only the
// mark is contained rather than cropped (it is a wide tent, and a circular crop
// cuts the guy ropes off).
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8507;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

// Landscape is how the game is actually held — portrait phones get the game's
// own rotate prompt, so measuring the board there measures nothing.
const VIEWPORTS = [
  ["desktop 1000×700", 1000, 700, true],
  ["landscape 844×390", 844, 390, false],
  ["landscape 1024×600", 1024, 600, false],
];

// ONE page, resized and re-seated between cases. This used to open a fresh page
// for every viewport × team-count pair — fourteen loads of a 1.7 MB document,
// 35 seconds of the CI run for a test that only ever measures geometry.
let PAGE = null;
async function board(w, h, n) {
  if (!PAGE) {
    PAGE = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await PAGE.route("**/firebasejs/**", r => r.abort());
    PAGE.on("pageerror", e => errs.push(e.message));
    PAGE.on("dialog", d => d.accept().catch(() => {}));
    await PAGE.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
    await PAGE.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
    await PAGE.waitForTimeout(1400);
  } else {
    await PAGE.setViewportSize({ width: w, height: h });
  }
  const page = PAGE;
  await page.evaluate((n) => {
    coachMarkAll();
    const NAMES = ["جروب الحارة", "تيم خلفان", "أبطال صحار", "شباب نزوى", "فريق ظفار"];
    state.teamCount = n;
    state.teams = NAMES.slice(0, n).map(name => ({
      name, helpers: ["fourChoices", "firstLetter", "doublePoints"], helpUsed: {}, score: 0,
    }));
    state.activeTeam = 0;
    state.selectedCategories = activeCategories().slice(0, 6).map(c => c.id);
    showScreen("game");
    renderGame();
  }, n || 2);
  // The layout keys off each box's own width via container queries, so give the
  // resize a frame to settle before anything is measured.
  await page.waitForTimeout(260);
  return page;
}

try {
  for (const [label, w, h, wide] of VIEWPORTS) {
    const page = await board(w, h, 2);
    const m = await page.evaluate(() => {
      const unit = document.querySelector("#scoreRow .score-unit");
      const kid = (sel) => unit.querySelector(sel);
      const parts = [...unit.children].map(el => el.className.split(" ")[0]);
      const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, mid: b.y + b.height / 2, right: b.right }; };
      const boxR = r(kid(".score-box")), toolsR = r(kid(".score-tools")), barR = r(kid(".qhelp-bar--team"));
      const slots = [...unit.querySelectorAll(".qhelp-slot")].map(r);
      const caps = [...unit.querySelectorAll(".qhelp-cap")]
        .filter(c => getComputedStyle(c).display !== "none");
      const photo = kid(".score-photo");
      const cs = getComputedStyle(photo);
      return {
        parts,
        boxR, toolsR, barR, slots,
        capCount: caps.length,
        capTexts: caps.map(c => c.textContent.trim()),
        rowHeight: document.querySelector("#scoreRow").getBoundingClientRect().height,
        photoSrc: photo.getAttribute("src"),
        photoFit: cs.objectFit,
        photoLogo: photo.classList.contains("avatar-logo"),
        teamCount: document.querySelectorAll("#scoreRow .score-unit").length,
        allPhotos: [...new Set([...document.querySelectorAll("#scoreRow .score-photo")]
          .map(x => x.getAttribute("src")))],
        // the +/- pair: on an RTL row «+» sits to the right of «−»
        plusRight: (() => {
          const bs = [...kid(".score-tools").querySelectorAll("button")];
          const plus = bs.find(b => b.textContent.trim() === "+");
          const minus = bs.find(b => b.textContent.trim() === "−");
          return plus.getBoundingClientRect().x > minus.getBoundingClientRect().x;
        })(),
      };
    });

    // ---- the three parts, in order, on one line ----
    check(`${label}: the unit holds identity, the score controls and the lifelines (${m.parts.join(" → ")})`,
      m.parts.join(",") === "score-box,score-tools,qhelp-bar");
    check(`${label}: identity sits at the START of the row (right, in RTL)`,
      m.boxR.right > m.toolsR.right && m.toolsR.right > m.barR.right);
    check(`${label}: all three share one line`,
      Math.abs(m.boxR.mid - m.toolsR.mid) < 6 && Math.abs(m.toolsR.mid - m.barR.mid) < 6);
    check(`${label}: «+» sits to the right of «−»`, m.plusRight);

    // ---- the lifelines run ACROSS, not down ----
    const ys = m.slots.map(s => Math.round(s.mid));
    check(`${label}: the three lifelines are in a row, not a column (${m.slots.length} slots)`,
      m.slots.length === 3 && Math.max(...ys) - Math.min(...ys) < 6);

    // ---- captions ----
    if (wide) {
      check(`${label}: each lifeline is named underneath (${m.capTexts.join("، ")})`,
        m.capCount === 3 && m.capTexts.every(t => t.length > 2));
      const cap = m.slots[0];
      check(`${label}: the caption sits BELOW its button, not beside it`, cap.h > 0);
    } else {
      check(`${label}: the row stays short enough to leave the board room (${Math.round(m.rowHeight)}px)`,
        m.rowHeight < h * 0.42);
    }

    // ---- the team picture ----
    check(`${label}: a team with no photo gets an illustrated portrait (${m.photoSrc})`,
      /assets\/img\/avatar-/.test(m.photoSrc) && m.photoLogo === false);
    check(`${label}: …filling the circle, as a portrait should (${m.photoFit})`,
      m.photoFit === "cover");
    check(`${label}: every team gets a DIFFERENT one (${m.allPhotos.length} distinct of ${m.teamCount})`,
      m.allPhotos.length === Math.min(m.teamCount, 5));

  }

  // ---- a team's OWN photo still fills the circle ----
  // Only the placeholder is the mark. An uploaded picture is a portrait and
  // should crop to the circle exactly as it always did.
  {
    const page = await board(1000, 700, 2);
    const own = await page.evaluate(() => {
      state.teams[0].image = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
      renderScores();
      const img = document.querySelector("#scoreRow .score-photo");
      return { logo: img.classList.contains("avatar-logo"), fit: getComputedStyle(img).objectFit,
               src: img.getAttribute("src").slice(0, 11) };
    });
    check(`a team's own photo is not treated as the mark (${own.src}…)`, own.logo === false);
    check(`…and still fills the circle (${own.fit})`, own.fit === "cover");
  }

  // ---- narrow: the captions go, the arrangement stays ----
  {
    const page = await board(760, 420, 2);
    const narrow = await page.evaluate(() => {
      const unit = document.querySelector("#scoreRow .score-unit");
      const caps = [...unit.querySelectorAll(".qhelp-cap")];
      const slots = [...unit.querySelectorAll(".qhelp-slot")].map(s => s.getBoundingClientRect().y + s.getBoundingClientRect().height / 2);
      return {
        shown: caps.filter(c => getComputedStyle(c).display !== "none").length,
        present: caps.length,
        stillARow: Math.max(...slots) - Math.min(...slots) < 6,
      };
    });
    check(`below 800px the captions are hidden rather than shrunk (${narrow.shown} of ${narrow.present} shown)`,
      narrow.present === 3 && narrow.shown === 0);
    check("…and the lifelines are still a row", narrow.stillARow);
  }

  // ---- three, four and five teams have to look organised too ----
  //
  // How much room a team box gets depends on HOW MANY TEAMS there are, not on
  // the screen — five teams share the same row two do. The first version of
  // this layout asked a viewport media query instead, so on a 1000px display
  // five teams each got 182px and still had the roomy treatment: the board's
  // own row grew to 203px, and in landscape to 282px of a 390px screen, leaving
  // almost nothing for the question grid. The box is a container query now and
  // asks about its own width.
  for (const [label, w, h] of [["desktop 1280×800", 1280, 800], ["landscape 844×390", 844, 390], ["landscape 1024×600", 1024, 600]]) {
    for (const n of [3, 4, 5]) {
      const page = await board(w, h, n);
      const m = await page.evaluate(() => {
        const row = document.getElementById("scoreRow");
        const units = [...row.querySelectorAll(".score-unit")];
        const r = el => el.getBoundingClientRect();
        const heights = units.map(u => Math.round(r(u).height));
        const orders = units.map(u => [...u.children].map(e => e.className.split(" ")[0]).join(","));
        const capsPerUnit = units.map(u =>
          [...u.querySelectorAll(".qhelp-cap")].filter(c => getComputedStyle(c).display !== "none").length);
        const slotRows = units.map(u => {
          const ys = [...u.querySelectorAll(".qhelp-slot")].map(s => Math.round(r(s).y));
          return new Set(ys).size;
        });
        // the «دورهم الآن» tab must not sit over the active team's name
        const cell = row.querySelector(".score-cell.active-team");
        const name = cell.querySelector(".score-name");
        const cs = getComputedStyle(cell, "::before");
        const tabBottom = r(cell).top + parseFloat(cs.top) + parseFloat(cs.height || "0")
          + parseFloat(cs.paddingTop || "0") + parseFloat(cs.paddingBottom || "0");
        return {
          count: units.length, heights, orders, capsPerUnit, slotRows,
          rowH: Math.round(r(row).height),
          tabClearsName: tabBottom <= r(name).top + 1,
        };
      });
      check(`${label} · ${n} teams: every team is drawn (${m.count})`, m.count === n);
      check(`${label} · ${n} teams: all boxes are the same height (${m.heights.join("، ")})`,
        Math.max(...m.heights) - Math.min(...m.heights) <= 1);
      check(`${label} · ${n} teams: all boxes are arranged identically`,
        new Set(m.orders).size === 1);
      // Whatever it decides, it must decide the SAME for every team — one box
      // with captions beside one without is the disorganised look being fixed.
      check(`${label} · ${n} teams: captions are all-or-nothing (${m.capsPerUnit.join("، ")})`,
        new Set(m.capsPerUnit).size === 1);
      check(`${label} · ${n} teams: no box wraps its lifelines into a block (${m.slotRows.join("، ")})`,
        m.slotRows.every(v => v === 1));
      check(`${label} · ${n} teams: the row leaves the board its room (${m.rowH}px of ${h})`,
        m.rowH < h * 0.42);
      check(`${label} · ${n} teams: «دورهم الآن» does not cover the team's name`, m.tabClearsName);
    }
  }

  // ---- dark mode: the team's own colour is not a text colour ----
  //
  // A team's name and its +/- glyphs are painted in that team's colour, which is
  // chosen to sit on cream. On the dark board the same colour is dark-on-dark:
  // measured against the PAINTED pixel, purple came out at 2.3:1, blue 2.8:1 and
  // teal 2.9:1. Only the gold cleared 4.5:1.
  //
  // The +/- were worse and were a regression from the row layout: they used to
  // live inside the score box and inherit the team colour, and moving them out
  // left `color: inherit` resolving against the unit — cream, on a white button.
  //
  // Contrast is measured off a screenshot rather than computed from the CSS,
  // because color-mix() and translucent layers are exactly where hand-stacking
  // goes wrong. Note color-mix computes to `color(srgb 0.49 …)` — 0..1 floats,
  // not bytes; parsing those as bytes reports a bright pastel as near-black.
  {
    const page = await board(1280, 800, 5);
    await page.evaluate(() => {
      state.theme = "dark";
      document.documentElement.setAttribute("data-theme", "dark");
      renderGame();
    });
    await page.waitForTimeout(400);
    const targets = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("#scoreRow .score-unit").forEach((u, i) => {
        const push = (label, el, bgEl) => {
          if (!el) return;
          const br = (bgEl || u).getBoundingClientRect();
          out.push({ i, label, color: getComputedStyle(el).color,
            at: { x: Math.round(br.left + 6), y: Math.round(br.top + br.height / 2) } });
        };
        push("name", u.querySelector(".score-name"));
        push("score", u.querySelector(".score-value"));
        u.querySelectorAll(".score-tools button").forEach(btn => {
          const r = btn.getBoundingClientRect();
          out.push({ i, label: btn.textContent.trim() === "+" ? "plus" : "minus",
            color: getComputedStyle(btn).color,
            at: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 4) } });
        });
      });
      return out;
    });
    const shot = (await page.screenshot()).toString("base64");
    const bgs = await page.evaluate(async ([b64, pts]) => {
      const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
      const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
      cv.getContext("2d").drawImage(img, 0, 0);
      const ctx = cv.getContext("2d");
      return pts.map(pt => { const d = ctx.getImageData(pt.x, pt.y, 1, 1).data; return [d[0], d[1], d[2]]; });
    }, [shot, targets.map(t => t.at)]);
    const lum = ([r, g, bl]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl); };
    const ratio = (a, c) => { const [x, y] = [lum(a), lum(c)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const parse = (str) => {
      const n = (str.match(/-?\d*\.?\d+/g) || []).map(Number);
      return /^color\(/.test(str) ? n.slice(-3).map(v => Math.round(v * 255)) : n.slice(0, 3);
    };
    const worst = {};
    targets.forEach((t, k) => {
      const cr = ratio(parse(t.color), bgs[k]);
      if (worst[t.label] === undefined || cr < worst[t.label]) worst[t.label] = cr;
    });
    Object.keys(worst).forEach(label => {
      check(`dark mode: the worst «${label}» is readable (${worst[label].toFixed(2)}:1)`,
        worst[label] >= 4.5);
    });
    await page.evaluate(() => {
      state.theme = "light";
      document.documentElement.setAttribute("data-theme", "light");
      renderGame();
    });
  }

  check("no uncaught JS errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 4));
} catch (e) {
  check("harness completed", false);
  console.log("  harness error:", e.message);
} finally {
  if (PAGE) await PAGE.close().catch(() => {});
  await browser.close();
  server.kill();
}
process.exit(checks.every(Boolean) ? 0 : 1);
