// The floating «رجوع», and the games library that packs tighter as it grows.
//
// BACK BUTTON. One fixed button bottom-right replaced five per-screen ones.
// The risk it carries is navigation: it does not own any targets, it clicks
// whichever [data-back] control sits on the screen currently showing. So the
// things worth pinning are (a) it appears only where there is somewhere to go,
// (b) it actually lands on the right screen from each one, and (c) the five
// originals really are gone from the page rather than merely overlapped.
//
// Two exclusions are deliberate and must not quietly come back:
//   * menu — the welcome screen, with nothing behind it,
//   * game / questionPage / answerPage — the board and the inside of a cell,
//     which are driven by their own ✕. A second way out mid-question is how a
//     live game gets lost.
//
// LIBRARY DENSITY. The list used to be a fixed minmax(330px) grid, so each new
// game made the page taller. The minimum track now steps down with the count
// and the card's typography is derived from it. What matters is that the
// ladder is monotonic (more games never means bigger tiles), that it has a
// readable floor, and that the text scales WITH the tile rather than
// overflowing it.
//
// Run:  IZZBAH_CHROMIUM=/path/to/chrome node tests/backfloat.mjs

import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8252;
const checks = [];
const check = (name, ok, extra) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.route("**/firebasejs/**", r => r.abort());
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
const jsErrors = [];
page.on("pageerror", e => jsErrors.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(2300);
  await page.evaluate(() => { window.IZZBAH.applyAuth(true, "u"); window.IZZBAH.applyAdmin(true); });
  await page.waitForTimeout(600);

  const back = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const gb = document.getElementById("globalBack");
    if (!gb) return null;
    const shown = () => getComputedStyle(gb).display !== "none";
    const out = { on: {}, off: {}, nav: {}, oldDrawn: [] };
    for (const id of ["gameLibrary", "categories", "setup", "customManager", "adminPanel", "results"]) {
      if (id === "setup") state.selected = new Set(["history"]);
      showScreen(id); await wait(350);
      out.on[id] = shown();
    }
    for (const id of ["menu", "game", "questionPage", "answerPage"]) {
      try { showScreen(id); } catch (e) { out.off[id] = "threw"; continue; }
      await wait(350);
      out.off[id] = shown();
    }
    // the five originals must not be painted anywhere
    document.querySelectorAll("[data-back]").forEach(el => {
      if (getComputedStyle(el).display !== "none") out.oldDrawn.push(el.id || el.getAttribute("data-screen"));
    });
    out.oldCount = document.querySelectorAll("[data-back]").length;
    for (const [from, want] of [["gameLibrary", "menu"], ["categories", "gameLibrary"], ["results", "gameLibrary"]]) {
      showScreen(from); await wait(350);
      gb.click(); await wait(550);
      out.nav[from] = `${document.body.dataset.screen}${document.body.dataset.screen === want ? "" : " (wanted " + want + ")"}`;
    }
    showScreen("gameLibrary"); await wait(300);
    const r = gb.getBoundingClientRect();
    const cs = getComputedStyle(gb);
    out.pos = cs.position;
    out.fromRight = Math.round(innerWidth - r.right);
    out.fromBottom = Math.round(innerHeight - r.bottom);
    out.height = Math.round(r.height);
    return out;
  });

  check("the floating back button exists", !!back);
  if (!back) throw new Error("no #globalBack");

  check("it shows on every screen that has somewhere to go",
    Object.values(back.on).every(Boolean),
    Object.entries(back.on).map(([k, v]) => `${k}:${v ? "y" : "NO"}`).join(" "));
  check("it is hidden on the welcome screen and inside a cell",
    Object.values(back.off).every(v => v === false),
    Object.entries(back.off).map(([k, v]) => `${k}:${v === false ? "hidden" : v}`).join(" "));
  check("the five per-screen «رجوع» buttons are still the carriers",
    back.oldCount === 5, `${back.oldCount} [data-back] controls`);
  check("...and none of them is drawn any more",
    back.oldDrawn.length === 0, back.oldDrawn.join(" ") || "all hidden");
  check("it lands on the right screen from each one",
    Object.values(back.nav).every(v => !v.includes("wanted")),
    Object.entries(back.nav).map(([k, v]) => `${k}→${v}`).join("  "));
  check("it is pinned to the bottom-right corner",
    back.pos === "fixed" && back.fromRight <= 24 && back.fromBottom <= 24,
    `${back.pos} right:${back.fromRight} bottom:${back.fromBottom}`);
  check("it stays finger-sized", back.height >= 40, `${back.height}px`);

  // ── library density ──────────────────────────────────────────────────────
  const rows = [];
  for (const n of [1, 5, 12, 25, 45]) {
    rows.push(await page.evaluate(async (n) => {
      state.savedGames = Array.from({ length: n }, (_, i) => ({
        id: "g" + i, name: "لعبة " + (i + 1), createdAt: Date.now() - i * 1000,
        categories: ["history", "science"], teams: [{ name: "أ", score: 0 }, { name: "ب", score: 0 }],
        used: [], scores: {}, frozen: {}, charged: true,
      }));
      showScreen("gameLibrary");
      await new Promise(r => setTimeout(r, 550));
      const list = document.getElementById("gameLibraryList");
      const card = list.querySelector(".saved-game-card");
      const title = card && card.querySelector(".saved-game-title");
      const num = v => parseFloat(list.style.getPropertyValue(v));
      return {
        n,
        cards: list.querySelectorAll(".saved-game-card").length,
        tile: num("--tile"), pad: num("--tile-pad"), titleVar: num("--tile-title"),
        titlePx: title ? parseFloat(getComputedStyle(title).fontSize) : 0,
        cardW: card ? Math.round(card.getBoundingClientRect().width) : 0,
        listH: Math.round(list.getBoundingClientRect().height),
        overflow: card ? Math.round(card.scrollWidth - card.clientWidth) : 0,
      };
    }, n));
  }
  console.log("   " + rows.map(r => `${r.n}g:tile=${r.tile} title=${r.titlePx}`).join("  "));

  check("every game renders a card", rows.every(r => r.cards === r.n),
    rows.map(r => `${r.cards}/${r.n}`).join(" "));
  const mono = (k) => rows.every((r, i) => i === 0 || r[k] <= rows[i - 1][k] + 0.01);
  check("the tile never grows as games are added", mono("tile"),
    rows.map(r => r.tile).join(" → "));
  check("padding and title come down with it", mono("pad") && mono("titleVar"),
    "pad " + rows.map(r => r.pad).join("→") + " | title " + rows.map(r => r.titleVar).join("→"));
  check("the ladder actually moves, it is not one flat value",
    rows[0].tile - rows[rows.length - 1].tile >= 100,
    `${rows[0].tile} down to ${rows[rows.length - 1].tile}`);
  check("a dense library still has a readable title",
    rows[rows.length - 1].titlePx >= 15, `${rows[rows.length - 1].titlePx}px at 45 games`);
  check("the card CSS really follows the variable",
    Math.abs(rows[1].titlePx - rows[1].titleVar) < 0.6,
    `rendered ${rows[1].titlePx} vs --tile-title ${rows[1].titleVar}`);
  check("nothing overflows its card", rows.every(r => r.overflow <= 1),
    rows.map(r => r.overflow).join(" "));
  // the whole point: a big collection must not be a proportionally huge page
  const perGame = rows[rows.length - 1].listH / rows[rows.length - 1].n;
  check("the list grows far slower than one full tile per game",
    perGame < 90, `${Math.round(perGame)}px of list per game at 45`);

  // a narrow phone must not be pushed sideways by the grid
  await page.setViewportSize({ width: 320, height: 720 });
  await page.waitForTimeout(600);
  const phone = await page.evaluate(() => ({
    docW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    cardW: Math.round((document.querySelector(".saved-game-card") || {}).getBoundingClientRect
      ? document.querySelector(".saved-game-card").getBoundingClientRect().width : 0),
  }));
  check("a 320px phone does not scroll sideways",
    phone.docW <= phone.clientW + 1, `${phone.docW} vs ${phone.clientW}`);
  check("the card fits that phone", phone.cardW > 0 && phone.cardW <= 320,
    `${phone.cardW}px`);

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
