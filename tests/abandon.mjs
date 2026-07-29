// Abandon/pause under the permanent-game model: the in-game ✕ and the resume
// card's «تجاهل» only drop the RUN's progress — they warn (progress is lost,
// the game stays in «ألعابك») and charge NOTHING; the credit was spent when
// the game was created. «إيقاف مؤقت» pause saves and stays resumable. An
// unsaved game pins its questions so a resume never re-rolls, and the resume
// card lists the categories.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8381;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
let lastDialog = "";
page.on("dialog", d => { lastDialog = d.message(); d.accept().catch(() => {}); });
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ---- 1) the ✕ exit button is GONE — only ⏸️ pause and 🏁 end remain ----
  // (owner, 2026-07-29: with permanent games + free replays a "leave and
  // silently discard the scores" path was a trap; pause or finish instead)
  const buttons = await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "u"); // a normal player (NOT admin)
    state.isAdmin = false; state.isPremium = false; state.codePremium = false;
    state.freeGamePlayed = true; state.gamesAllowed = 0; state.codeGamesAllowed = 5; state.gamesUsed = 0;
    state.selected = new Set(["history"]); state.editingSavedGameId = null;
    state.teamCount = 2; state.gameCounted = false;
    state.teams.forEach(t => { t.score = 0; });
    startGame(); // charge-at-start: spends 1 here
    return {
      usedAfterStart: state.gamesUsed,
      exitGone: !document.getElementById("exitGame"),
      pauseThere: !!document.getElementById("pauseGame"),
      endThere: !!document.getElementById("endGameEarly"),
      onBoard: document.body.dataset.screen === "game",
    };
  });
  check("creating the game charged one at start", buttons.usedAfterStart === 1 && buttons.onBoard);
  check("the ✕ exit button is removed from the game screen", buttons.exitGone);
  check("⏸️ pause and 🏁 end-game are the two remaining actions", buttons.pauseThere && buttons.endThere);

  // ---- 2) every started game pins its questions — a resume never re-rolls ----
  const noReroll = await page.evaluate(() => {
    const qs = Array.from({ length: 8 }, (_, i) => ({ points: 100, q: "س" + i, a: "ج" + i }));
    state.publishedCategories = (state.publishedCategories || []).filter(c => c.id !== "freeze-test");
    state.publishedCategories.push({ id: "freeze-test", name: "تجميد", custom: true, questions: qs });
    state.isAdmin = true; // bypass the play gate for a private category
    state.selected = new Set(["freeze-test"]); state.editingSavedGameId = null;
    state.teamCount = 2; state.teams.forEach(t => { t.score = 0; });
    startGame(); // auto-creates a saved-game record and pins the questions
    const key = "freeze-test-100";
    const rec = activeSavedGameRecord();
    const sig1 = rec && rec.frozen[key];
    renderGame(); // a re-render (like navigating back in) must NOT re-roll
    const sig2 = activeSavedGameRecord().frozen[key];
    // a full resume from storage keeps the same record + pins
    saveLiveGame();
    const savedId = state.editingSavedGameId;
    state.editingSavedGameId = null; state.gameActive = false; // wipe the in-memory context
    resumeLiveGame();
    const sig3 = activeSavedGameRecord().frozen[key];
    return { sig1, sig2, sig3, hadRecord: !!rec, resumedId: state.editingSavedGameId, savedId };
  });
  check("every started game pins its questions to a record (no re-roll on re-render)",
    noReroll.hadRecord && !!noReroll.sig1 && noReroll.sig1 === noReroll.sig2);
  check("resuming keeps the exact same record + pinned questions",
    noReroll.resumedId === noReroll.savedId && noReroll.sig1 === noReroll.sig3);

  // ---- 3) the resume card lists the categories being played ----
  const resumeCard = await page.evaluate(() => {
    const live = { selected: ["history", "science", "geo"], currentGameName: "لعبة ٢",
      teams: [{ name: "أ", score: 100 }, { name: "ب", score: 0 }] };
    const card = buildResumeCard(live);
    return {
      chips: card.querySelectorAll(".saved-game-cats .saved-game-category").length,
      badge: /غير مكتملة/.test(card.textContent),
      count: /فئات|فئة|فئتان|٣/.test(card.textContent),
    };
  });
  check("the incomplete-game card shows the categories being played", resumeCard.chips === 3);
  check("the incomplete-game card keeps the «غير مكتملة» badge + a category count", resumeCard.badge && resumeCard.count);

  // ---- 4) «تجاهل» closes an unfinished game — warns, charges NOTHING ----
  const discard = await page.evaluate(() => {
    state.isAdmin = false; state.isPremium = false; state.codePremium = false;
    state.freeGamePlayed = true; state.gamesAllowed = 0; state.codeGamesAllowed = 5; state.gamesUsed = 2;
    state.savedGames = [{ id: "sg-x", title: "لعبة", categoryIds: ["history"], frozen: {}, charged: true }];
    const live = { selected: ["history"], currentGameName: "لعبة", counted: false, savedGameId: "sg-x",
      teams: [{ name: "أ", score: 0 }, { name: "ب", score: 0 }] };
    const card = buildResumeCard(live);
    document.body.appendChild(card);
    const usedBefore = state.gamesUsed;
    card.querySelector("[data-resume-discard]").click(); // dialog auto-accepted
    const rec = state.savedGames.find(g => g.id === "sg-x");
    const stillLive = !!localStorage.getItem("izzbah-trivia-live-game-v1");
    return { usedBefore, usedAfter: state.gamesUsed, recKept: !!rec, charged: rec && rec.charged, stillLive };
  });
  check("«تجاهل» warns about progress but does NOT threaten a charge",
    /تفقد تقدّمك/.test(lastDialog) && !/تُخصم/.test(lastDialog));
  check("confirming «تجاهل» spends NOTHING", discard.usedBefore === 2 && discard.usedAfter === 2);
  check("the record survives the discard (and the live game is cleared)",
    discard.recKept && discard.charged === true && !discard.stillLive);

  // ---- 5) «إيقاف مؤقت» pause — warns, saves, stays resumable, no extra cost ----
  const pause = await page.evaluate(() => {
    window.IZZBAH.applyAdmin(false); state.isAdmin = false;
    state.isPremium = false; state.codePremium = false;
    state.freeGamePlayed = true; state.gamesAllowed = 0; state.codeGamesAllowed = 5; state.gamesUsed = 0;
    state.selected = new Set(["history"]); state.editingSavedGameId = null;
    state.teamCount = 2; state.gameCounted = false;
    state.teams.forEach(t => { t.score = 0; });
    startGame(); // spends 1 at start
    const savedId = state.editingSavedGameId;
    const usedAfterStart = state.gamesUsed;
    // the pause button must actually be VISIBLE (sized, bordered, drawn icon)
    const btn = document.getElementById("pauseGame");
    const bcs = getComputedStyle(btn);
    const svg = btn.querySelector("svg");
    const shown = btn.offsetWidth > 10 && btn.offsetHeight > 10
      && parseFloat(bcs.borderTopWidth) > 0
      && svg && svg.getBoundingClientRect().width > 4;
    document.getElementById("pauseGame").click(); // dialog auto-accepted
    const liveAfter = getLiveGameInfo();
    return {
      shown,
      usedAfterStart, usedAfterPause: state.gamesUsed,
      active: state.gameActive,
      onLibrary: document.body.dataset.screen === "gameLibrary",
      liveKept: !!liveAfter,
      liveCounted: liveAfter && !!liveAfter.counted,
      liveId: liveAfter && liveAfter.savedGameId, savedId,
    };
  });
  check("the pause button is actually visible (sized, bordered, drawn icon)", pause.shown);
  check("pause asks the host to confirm", /إيقاف اللعبة مؤقتًا/.test(lastDialog));
  check("pausing costs nothing beyond the start charge", pause.usedAfterStart === 1 && pause.usedAfterPause === 1);
  check("pausing ends the active session and lands on «ألعابك»", !pause.active && pause.onLibrary);
  check("pausing keeps the live game resumable (kept, uncounted, same record)",
    pause.liveKept && !pause.liveCounted && pause.liveId === pause.savedId);

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
