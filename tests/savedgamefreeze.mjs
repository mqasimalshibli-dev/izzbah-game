// Saved-game question policy: questions are pinned only WITHIN a run — a
// resumed board serves the same question — but every NEW run (a re-run of the
// saved game) clears the pins and draws FRESH questions, and is gated like a
// new paid game. (Policy change 2026-07-20: re-runs are no longer free and no
// longer serve the same questions.)
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8355;
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

  await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "adm");
    window.IZZBAH.applyAdmin(true); // admin bypasses the play gate for the draw checks
    // A category with SIX distinct questions in the 100 tier, so fresh draws
    // are observable.
    window.IZZBAH.applyPublished([{
      id: "pub-freeze-test", name: "تجميد", image: "", order: 1,
      questions: Array.from({ length: 6 }, (_, i) => ({ points: 100, q: "سؤال " + i, a: "جواب " + i, image: "", answerImage: "" })),
    }]);
    window.__startFresh = () => {
      state.selected = new Set(["pub-freeze-test"]);
      state.currentGameName = "";
      state.editingSavedGameId = null; // brand-new game
      state.teamCount = 2;
      startGame();
      return state.editingSavedGameId; // the record it created
    };
    window.__rerun = (id) => { playSavedGame(id); startGame(); };
    window.__served = () => {
      const card = [...document.querySelectorAll(".board-category-card")].find(c => c.textContent.includes("تجميد"));
      const cell = card.querySelector(".cell:not(.used)");
      cell.click();
      const a = state.activeQuestion.q.a;
      finishQuestion(null); // close it (marks it seen for the unseen-first draw)
      return a;
    };
  });

  // ---- 1) a new game creates a record and pins this RUN's question ----
  const first = await page.evaluate(() => {
    const id = window.__startFresh();
    const rec = state.savedGames.find(g => g.id === id);
    const served = window.__served();
    return { id, frozenSig: rec && rec.frozen && rec.frozen["pub-freeze-test-100"], served };
  });
  check("a new game creates a saved-game record", !!first.id);
  check("the played cell's question is pinned onto the record for this run", !!first.frozenSig);
  check("the served question is one of the six", /^جواب [0-5]$/.test(first.served));

  // ---- 2) WITHIN the run (a resume re-render), the pin holds ----
  const resumed = await page.evaluate((id) => {
    renderGame(); // what a resume does — re-render the same run's board
    const rec = state.savedGames.find(g => g.id === id);
    return rec.frozen["pub-freeze-test-100"];
  }, first.id);
  check("re-rendering the same run keeps the pinned question (resume-safe)", resumed === first.frozenSig);

  // ---- 3) every RE-RUN clears the pins and draws fresh questions ----
  const rerunAnswers = [];
  for (let i = 0; i < 5; i++) {
    rerunAnswers.push(await page.evaluate((id) => { window.__rerun(id); return window.__served(); }, first.id));
  }
  const distinct = new Set([first.served, ...rerunAnswers]);
  check(`re-runs draw FRESH questions (${JSON.stringify([first.served, ...rerunAnswers])} → ${distinct.size} distinct)`,
    distinct.size >= 2);

  // ---- 4) a re-run resets the record's charge (paid like a new game) ----
  const recState = await page.evaluate((id) => {
    const rec = state.savedGames.find(g => g.id === id);
    rec.charged = true; // as after a finished run
    window.__rerun(id);
    return state.savedGames.find(g => g.id === id).charged;
  }, first.id);
  check("starting a re-run makes the record chargeable again", recState === false);

  // ---- 5) with no credits at all, a re-run is blocked by the paywall ----
  const gated = await page.evaluate((id) => {
    window.IZZBAH.applyAdmin(false);
    state.isPremium = false; state.codePremium = false;
    state.gamesAllowed = 0; state.codeGamesAllowed = 0; state.gamesUsed = 0;
    state.freeGamePlayed = true; state.gameActive = false;
    window.__rerun(id);
    return {
      paywall: document.getElementById("plansModal").classList.contains("open"),
      active: state.gameActive,
    };
  }, first.id);
  check("a re-run with no balance hits the paywall (no free replays)", gated.paywall && !gated.active);

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
