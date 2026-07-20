// The in-game ✕ ABANDONS the run: it warns that progress AND one game are lost,
// then (on confirm) spends one game. Distinct from navigating away / resuming,
// which keep the board and only charge on finish. Also: an UNSAVED game pins its
// questions so a resume never re-rolls, and the resume card lists the categories.
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

  // ---- 1) the ✕ warns + spends one game ----
  const abandon = await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "u"); // a normal player (NOT admin)
    state.isAdmin = false; state.isPremium = false; state.codePremium = false;
    state.freeGamePlayed = true; state.gamesAllowed = 0; state.codeGamesAllowed = 5; state.gamesUsed = 0;
    state.selected = new Set(["history"]); state.editingSavedGameId = null;
    state.teamCount = 2; state.gameCounted = false;
    state.teams.forEach(t => { t.score = 0; });
    startGame();
    const usedBeforeExit = state.gamesUsed;
    document.getElementById("exitGame").click(); // dialog auto-accepted
    return {
      usedBeforeExit,
      usedAfter: state.gamesUsed,
      counted: state.gameCounted,
      active: state.gameActive,
      onMenu: document.getElementById("menu").classList.contains("active"),
    };
  });
  check("starting the game doesn't charge yet", abandon.usedBeforeExit === 0);
  check("the ✕ warns that a game will be lost", /لعبة واحدة/.test(lastDialog) && /تفقد تقدّمك/.test(lastDialog));
  check("confirming the ✕ spends exactly one game", abandon.usedAfter === 1);
  check("after abandoning, the game ends (back at the menu, not active)", !abandon.active && abandon.onMenu);

  // ---- 1b) an admin/subscriber loses only the progress (no charge, softer warning)
  const adminExit = await page.evaluate(() => {
    window.IZZBAH.applyAdmin(true); state.isAdmin = true;
    state.gamesUsed = 3;
    state.selected = new Set(["history"]); state.editingSavedGameId = null; state.gameCounted = false;
    startGame();
    document.getElementById("exitGame").click();
    return { used: state.gamesUsed, msg: window.__lastMsg };
  });
  check("an admin abandoning is NOT charged", adminExit.used === 3);
  check("the admin's warning doesn't threaten a game charge", !/لعبة واحدة/.test(lastDialog) && /تفقد تقدّمك/.test(lastDialog));

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
      names: card.textContent,
      badge: /غير مكتملة/.test(card.textContent),
      count: /فئات|فئة|فئتان|٣/.test(card.textContent),
    };
  });
  check("the incomplete-game card shows the categories being played", resumeCard.chips === 3);
  check("the incomplete-game card keeps the «غير مكتملة» badge + a category count", resumeCard.badge && resumeCard.count);

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
