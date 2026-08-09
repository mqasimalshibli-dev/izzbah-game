// E2E: the permanent-game credit model (owner reversal 2026-07-29).
// Creating a NEW game spends one credit AT START and the game becomes
// permanent; REPLAYING it is free forever (even with zero balance), and
// finishing/abandoning/exiting never charge anything on their own.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8330;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
let lastDialog = "";
page.on("dialog", d => { lastDialog = d.message(); d.accept().catch(() => {}); });
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

// force a clean, non-privileged player with a known allowance
const reset = (allowance) => page.evaluate((allowance) => {
  window.IZZBAH.applyAuth(true, "u1");
  window.IZZBAH.applyAdmin(false);
  state.isPremium = false; state.codePremium = false;
  state.gamesAllowed = 0; state.codeGamesAllowed = allowance;
  state.freeGamePlayed = false; state.gamesUsed = 0; state.gameCounted = false;
  state.editingSavedGameId = null; // a fresh NEW game (not a saved-game replay)
  state.savedGames = [];
  state.seen = {}; state.progress = {};
  state.selected = new Set(["history"]);
  refreshBuiltinQuestions();
  state.teamCount = 2;
  state.teams.forEach(t => { t.score = 0; });
}, allowance);

const snap = () => page.evaluate(() => ({
  free: state.freeGamePlayed, used: state.gamesUsed, counted: state.gameCounted,
  screen: document.body.dataset.screen,
}));

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ---- starting a NEW game charges AT START (the free game, first) ----
  await reset(3);
  await page.evaluate(() => startGame());
  let s = await snap();
  check("starting a new game consumes the free game AT START", s.free === true && s.used === 0 && s.screen === "game");
  const rec1 = await page.evaluate(() => {
    const rec = activeSavedGameRecord();
    return { charged: rec && rec.charged, id: rec && rec.id };
  });
  check("the new game's record is immediately marked permanent (charged)", rec1.charged === true);

  // ---- FINISHING the game charges NOTHING further ----
  await page.evaluate(() => { state.teams[0].score = 300; renderResults(); });
  s = await snap();
  check("finishing the game does not charge again", s.free === true && s.used === 0 && s.counted === true);

  // ---- reviewing results again must NOT double-record ----
  await page.evaluate(() => renderResults());
  s = await snap();
  check("re-opening the results screen never re-charges", s.free === true && s.used === 0);

  // ---- a SECOND new game spends one allowance game at start (free used up) ----
  await page.evaluate(() => {
    state.gameCounted = false;
    state.editingSavedGameId = null; // a NEW game
    state.teams.forEach(t => { t.score = 0; });
    startGame();
  });
  s = await snap();
  check("a second NEW game spends one allowance game at start", s.used === 1 && s.screen === "game");
  const secondId = await page.evaluate(() => state.editingSavedGameId);
  await page.evaluate(() => { state.teams[0].score = 200; renderResults(); });
  s = await snap();
  check("finishing the second game costs nothing more", s.used === 1);

  // ---- REPLAYING that game is FREE (no charge at start or finish) ----
  const replay = await page.evaluate((id) => {
    state.editingSavedGameId = id; // reopen the saved game (as playSavedGame would)
    state.gameCounted = false;
    state.teams.forEach(t => { t.score = 0; });
    startGame();
    const usedAfterStart = state.gamesUsed;
    const credit = state.runCredit;
    state.teams[0].score = 150; renderResults();
    return { usedAfterStart, usedAfterFinish: state.gamesUsed, credit,
             stillCharged: state.savedGames.find(g => g.id === id).charged === true };
  }, secondId);
  check("replaying a saved game charges nothing at start", replay.usedAfterStart === 1);
  check("finishing the replay charges nothing either", replay.usedAfterFinish === 1);
  check("the replay run is labeled 'replay' for the stats", replay.credit === "replay");
  check("the record stays permanent after the replay", replay.stillCharged);

  // ---- with ZERO balance a replay still works (free replays are a right) ----
  const zeroReplay = await page.evaluate((id) => {
    state.codeGamesAllowed = 0; state.gamesUsed = 0; state.freeGamePlayed = true; // nothing left
    state.editingSavedGameId = id; state.gameCounted = false; state.gameActive = false;
    state.teams.forEach(t => { t.score = 0; });
    startGame();
    return {
      screen: document.body.dataset.screen,
      paywall: document.getElementById("plansModal").classList.contains("open"),
      active: state.gameActive, used: state.gamesUsed,
    };
  }, secondId);
  check("with 0 credits a REPLAY still starts (no paywall, free forever)",
    zeroReplay.screen === "game" && !zeroReplay.paywall && zeroReplay.active && zeroReplay.used === 0);

  // ---- but a NEW game with zero balance is still gated ----
  const zeroNew = await page.evaluate(() => {
    showScreen("categories");
    clearLiveGame();
    state.editingSavedGameId = null; state.gameCounted = false;
    startGame();
    return {
      paywall: document.getElementById("plansModal").classList.contains("open"),
      active: state.gameActive, used: state.gamesUsed,
    };
  });
  check("a NEW game with 0 credits still hits the paywall", zeroNew.paywall && !zeroNew.active && zeroNew.used === 0);

  // ---- hopping away from a PLAYED unfinished game warns but NEVER charges ----
  await page.evaluate(() => {
    const m = document.getElementById("plansModal"); m.classList.remove("open");
    state.isAdmin = false; state.isPremium = false; state.codePremium = false;
    state.freeGamePlayed = true; state.gamesAllowed = 0; state.codeGamesAllowed = 5; state.gamesUsed = 0;
    state.editingSavedGameId = null; state.gameCounted = false;
    state.selected = new Set(["history"]);
    state.teams.forEach(t => { t.score = 0; });
    startGame(); // spends 1 at start
  });
  await page.click("#board .board-category-card .cell:not(.used)"); // open a question → "played"
  const hop = await page.evaluate(() => {
    saveLiveGame();               // persist the opened-question progress
    showScreen("categories");     // walk away — NOT the ✕
    const usedMid = state.gamesUsed;
    state.editingSavedGameId = null; state.gameCounted = false;
    state.teams.forEach(t => { t.score = 0; });
    startGame();                  // abandons the played one + starts (and pays for) a new one
    return { usedMid, usedAfter: state.gamesUsed, screen: document.body.dataset.screen };
  });
  check("the first new game charged one at start", hop.usedMid === 1);
  check("the hop warning mentions losing progress but NOT a charge",
    /لم تكتمل/.test(lastDialog) && !/تُخصم/.test(lastDialog));
  check("the abandoned game itself costs nothing — only the NEW game's start charge",
    hop.usedAfter === 2 && hop.screen === "game");

  // ---- finishing lands on «ألعابك» (saved games), NOT the welcome screen ----
  const finishNav = await page.evaluate(() => {
    state.teams[0].score = 100; renderResults();
    const onResults = document.body.dataset.screen === "results";
    document.getElementById("resultsMenu").click(); // the results «القائمة» button
    return { onResults, after: document.body.dataset.screen };
  });
  check("finishing shows the results screen", finishNav.onResults);
  check("leaving results via «القائمة» lands on «ألعابك» (saved games)", finishNav.after === "gameLibrary");

  // ---- every paid game stays in the library ----
  const library = await page.evaluate(() => ({
    count: state.savedGames.length,
    allCharged: state.savedGames.every(g => g.charged === true),
  }));
  check("every created game is saved in the library and marked permanent",
    library.count >= 3 && library.allCharged);

  // ---- a bailed saved game must not leave a free-replay pointer behind ----
  // Opening a saved game whose categories no longer resolve bailed back to the
  // picker with state.editingSavedGameId still set, so the NEXT start still
  // counted as a replay of that (already-charged) record: free games forever.
  const bail = await page.evaluate(async () => {
    state.savedGames = [{ id: "sg-gone", title: "لعبة قديمة", categoryIds: ["ghost-cat"],
                          charged: true, credit: "code", frozen: {}, createdAt: 1 }];
    playSavedGame("sg-gone");                 // categories do not resolve
    await new Promise(r => setTimeout(r, 150));
    startGame();                              // bails to the picker
    await new Promise(r => setTimeout(r, 150));
    return { pointer: state.editingSavedGameId, replay: !!(activeSavedGameRecord() || {}).charged };
  });
  check("a bailed saved game clears its record pointer", bail.pointer === null);
  check("...so the next start is NOT treated as a free replay", !bail.replay);

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
