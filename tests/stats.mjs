// E2E for the admin "insights" panel: a finished game tallies its categories
// into the global counters, and the admin panel renders games-played + a ranked
// most-played-categories board from that data.
//
// Runs OFFLINE (Firebase SDK aborted); the cloud bridges are stubbed, so we
// exercise the same UI + recording code paths the live bridges drive.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8336;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ---- 1) finishing a game tallies its categories exactly once ----
  const record = await page.evaluate(() => {
    const calls = [];
    window.IZZBAH.recordGamePlay = (ids) => { calls.push(ids); return Promise.resolve(true); };
    window.IZZBAH.applyAuth(true, "u1"); window.IZZBAH.applyAdmin(false);
    state.selected = new Set(["history", "geo", "science"]);
    refreshBuiltinQuestions();
    state.teamCount = 2; state.teams.forEach(t => { t.score = 0; });
    state.teams[0].score = 300;
    state.gameCounted = false;
    renderResults();                 // reaches the results screen -> records once
    renderResults();                 // re-opening must NOT record again
    return { calls, count: calls.length, ids: calls[0] || [] };
  });
  check("finishing a game records exactly once (guarded like the credit spend)", record.count === 1);
  check("the recorded play carries the game's category ids",
    Array.isArray(record.ids) && ["history", "geo", "science"].every(id => record.ids.includes(id)));

  // ---- 2) the admin chooser exposes an Insights option ----
  await page.evaluate(() => { window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true); });
  await page.waitForTimeout(120);
  await page.evaluate(() => document.getElementById("adminEntry").click());
  await page.waitForTimeout(180);
  const chooser = await page.evaluate(() => ({
    open: document.getElementById("adminChoiceModal").classList.contains("open"),
    hasStats: !!document.getElementById("adminChoiceStats"),
  }));
  check("the admin chooser shows an Insights (الإحصائيات) option", chooser.open && chooser.hasStats);

  // ---- 3) opening Insights renders games-played + a ranked category board ----
  const view = await page.evaluate(async () => {
    window.IZZBAH.loadStats = () => Promise.resolve({
      gamesPlayed: 42,
      categoryPlays: { seerah: 10, geo: 25, history: 5, culture: 25 },
    });
    document.getElementById("adminChoiceStats").click();
    await new Promise(r => setTimeout(r, 250));
    const modalOpen = document.getElementById("statsModal").classList.contains("open");
    const chooserClosed = !document.getElementById("adminChoiceModal").classList.contains("open");
    const tiles = document.getElementById("statsTiles").textContent;
    const rows = [...document.querySelectorAll("#statsCats .stats-bar-row")];
    const first = rows[0];
    return {
      modalOpen, chooserClosed, tiles,
      rowCount: rows.length,
      firstText: first ? first.textContent : "",
      firstIsRank1: first ? first.classList.contains("rank-1") : false,
      firstFillPct: first ? first.querySelector(".stats-bar-fill").style.width : "",
      allText: document.getElementById("statsCats").textContent,
    };
  });
  check("choosing Insights opens the stats modal and closes the chooser", view.modalOpen && view.chooserClosed);
  check("the tiles show the total games played (42)", /٤٢|42/.test(view.tiles) && /لعبة/.test(view.tiles));
  check("all four played categories are ranked", view.rowCount === 4);
  check("the top category is one of the most-played (25 plays) at 100% width",
    view.firstIsRank1 && view.firstFillPct === "100%" && (/٢٥|25/.test(view.firstText)));
  check("categories are shown by NAME, not raw id", /السيرة النبوية|جغرافيا|تاريخ/.test(view.allText) && !/seerah|geo/.test(view.allText));

  // ---- 4) empty stats render a friendly placeholder, not a broken board ----
  const empty = await page.evaluate(async () => {
    window.IZZBAH.loadStats = () => Promise.resolve({});
    document.getElementById("statsRefresh").click();
    await new Promise(r => setTimeout(r, 200));
    return {
      cats: document.getElementById("statsCats").textContent,
      tiles: document.getElementById("statsTiles").textContent,
    };
  });
  check("no data yet shows a friendly placeholder + zero counts", /لا توجد بيانات/.test(empty.cats) && /٠|0/.test(empty.tiles));

  // ---- 5) without the cloud bridge (signed out) it explains, not crashes ----
  const noBridge = await page.evaluate(async () => {
    delete window.IZZBAH.loadStats;
    document.getElementById("statsRefresh").click();
    await new Promise(r => setTimeout(r, 120));
    return document.getElementById("statsStatus").textContent;
  });
  check("without an admin bridge, the panel explains instead of failing", /مشرف/.test(noBridge));

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
