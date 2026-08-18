// The team card on «الفِرَق», sized against the thing players compare it to.
//
// Reported as "on some phones the team boxes are huge and are bigger than the
// categories". They were. Measured on a 390×844 phone, one team card was
// 322×529 while a category card was 176×168 — three category cards tall and
// nearly six times the area — because the avatar, the «اسم الفريق» label, the
// name field and the six lifeline chips each took a full-width row of their
// own. Three teams made `.team-fields` 1630px on a screen showing about 700.
//
// The fix packs the same parts (nothing was removed): the avatar sits BESIDE
// the name, and the chips run three across instead of two. What this test pins
// is the RATIO to a category card rather than a pixel height — the card holds a
// photo, a text field and six toggles, so it is legitimately bigger than a
// category tile; it is "several tiles tall" that was the bug.
//
// ⚠️ The board team boxes are a different thing entirely (`.score-box`, ~49px)
// and were never the problem. Don't come here to measure those — tests/teambox.mjs
// owns the board.
//
// ⚠️ The compaction keys off `(max-width: 800px), (max-height: 560px)`. The
// second half is not decoration: a phone in LANDSCAPE is 844 wide and sails past
// a width-only breakpoint, and it is the case with the least room to spare
// (390px of height for a 602px card). Delete the height clause and this test
// goes red on the landscape rows only.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8541;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

// Phones first, then one desktop row to prove the roomy layout is still there.
const VIEWPORTS = [
  ["iPhone SE  320×568", 320, 568, true],
  ["iPhone 12  390×844", 390, 844, true],
  ["Pro Max    430×932", 430, 932, true],
  ["Galaxy S20 360×800", 360, 800, true],
  ["landscape  844×390", 844, 390, true],
  ["landscape  740×360", 740, 360, true],
  ["desktop   1200×900", 1200, 900, false],
];

// ONE page, resized between cases — the shell is ~2 MB and reloading it seven
// times is most of the runtime for a test that only reads geometry.
let PAGE = null;
async function measure(w, h) {
  if (!PAGE) {
    PAGE = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await PAGE.route("**/firebasejs/**", r => r.abort());
    PAGE.on("pageerror", e => errs.push(e.message));
    PAGE.on("dialog", d => d.accept().catch(() => {}));
    await PAGE.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
    await PAGE.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
    await PAGE.waitForTimeout(1400);
  } else {
    await PAGE.setViewportSize({ width: w, height: h });
  }
  await PAGE.waitForTimeout(260);
  return PAGE.evaluate(() => {
    coachMarkAll();
    state.teamCount = 3;
    state.teams = ["جروب الحارة", "تيم خلفان", "أبطال صحار"].map(name => ({
      name, helpers: ["fourChoices", "firstLetter", "doublePoints"], helpUsed: {}, score: 0,
    }));
    const R = el => { if (!el) return null; const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: Math.round(b.width), h: Math.round(b.height), top: b.top, bottom: b.bottom, left: b.left, right: b.right }; };

    // The category tile is the yardstick — measure it in the same session.
    showScreen("categories");
    if (typeof renderCategories === "function") renderCategories();
    const cat = R(document.querySelector(".category"));

    showScreen("setup");
    if (typeof renderTeamSetup === "function") renderTeamSetup();
    else if (typeof renderTeamFields === "function") renderTeamFields();
    const card = document.querySelector("#setup .team-card");
    const chips = document.querySelector("#setup .team-card .helper-chips");
    return {
      cat,
      card: R(card),
      fields: R(document.querySelector("#setup .team-fields")),
      avatar: R(card && card.querySelector(".avatar-wrap")),
      input: R(card && card.querySelector("input.team-name-input")),
      chipCols: chips ? getComputedStyle(chips).gridTemplateColumns.split(" ").length : 0,
      chip: R(card && card.querySelector(".helper-chip")),
      nChips: card ? card.querySelectorAll(".helper-chip").length : 0,
    };
  });
}

try {
  for (const [name, w, h, phone] of VIEWPORTS) {
    const m = await measure(w, h);
    const ratio = m.cat && m.card ? m.card.h / m.cat.h : Infinity;
    console.log(`      ${name}  card ${m.card.w}×${m.card.h}   category ${m.cat.w}×${m.cat.h}   ×${ratio.toFixed(2)}`);

    if (phone) {
      // The number that was reported. It was 3.1–3.6× before; a card holding a
      // photo, a field and six toggles has no business past ~2.2 tiles.
      check(`${name}: a team card is at most 2.2 category cards tall (it is ${ratio.toFixed(2)}×)`,
        ratio <= 2.2);
      // …and the reason it is: the avatar shares a line with the name field
      // instead of sitting on a row of its own. Checked as geometry, not as a
      // CSS property, because that is what a player actually sees.
      check(`${name}: the avatar sits BESIDE the name field, not above it`,
        m.avatar && m.input &&
        m.avatar.top < m.input.bottom && m.input.top < m.avatar.bottom &&
        (m.avatar.right <= m.input.left + 1 || m.input.right <= m.avatar.left + 1));
      check(`${name}: the six lifeline chips run three across`, m.chipCols === 3 && m.nChips === 6);
      // Packing them tighter must not shrink them below a thumb.
      check(`${name}: a lifeline chip is still a real tap target (${m.chip.w}×${m.chip.h})`,
        m.chip.w >= 44 && m.chip.h >= 44);
      // Three teams used to be 1630px of card. Whatever the height ends up as,
      // it has to be reachable without an expedition.
      check(`${name}: three teams fit in under 3 screens (${m.fields.h}px of ${h * 3}px)`,
        m.fields.h < h * 3);
    } else {
      // Desktop has the room, and the owner signed off on the roomy card. The
      // compaction is a phone concession and must not leak onto a laptop.
      check(`${name}: the roomy stacked card survives on desktop (avatar above the field)`,
        m.avatar && m.input && m.avatar.bottom <= m.input.top + 1);
    }
  }

  check("no page errors" + (errs.length ? ": " + errs[0] : ""), errs.length === 0);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
