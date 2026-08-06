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
// It also pins the team picture. A team with no photo of its own shows the
// عِزبة mark, and the mark is a wide tent: CONTAINED on a tinted disc, never
// cropped to a circle, which would cut the guy ropes off on both sides.
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

async function board(w, h, n) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.route("**/firebasejs/**", r => r.abort());
  page.on("pageerror", e => errs.push(e.message));
  page.on("dialog", d => d.accept().catch(() => {}));
  await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1400);
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
  await page.waitForTimeout(500);
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
    check(`${label}: a team with no photo shows the عِزبة mark (${m.photoSrc})`,
      /izzbah-mark/.test(m.photoSrc) && m.photoLogo);
    check(`${label}: …contained rather than cropped, so the tent is whole (${m.photoFit})`,
      m.photoFit === "contain");

    await page.close();
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
    await page.close();
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
    await page.close();
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
      await page.close();
    }
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
