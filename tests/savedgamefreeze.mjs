// Saved-game question policy (permanent games, 2026-07-29): a game's questions
// are pinned PERMANENTLY when it is created — every replay serves the exact
// same board and is free. NEW games avoid questions that appeared in earlier
// games (the izzbah-seen-v1 tracker); only when a category is exhausted do the
// least-recently-seen questions come back.
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
    // A category with SIX distinct questions in the 100 tier, so draws are
    // observable and the pool can be exhausted in six games.
    window.IZZBAH.applyPublished([{
      id: "pub-freeze-test", name: "تجميد", image: "", order: 1,
      questions: Array.from({ length: 6 }, (_, i) => ({ points: 100, q: "سؤال " + i, a: "جواب " + i, image: "", answerImage: "" })),
    }]);
    state.seen = {}; state.progress = {};
    window.__startFresh = () => {
      state.selected = new Set(["pub-freeze-test"]);
      state.currentGameName = "";
      state.editingSavedGameId = null; // brand-new game
      state.teamCount = 2;
      startGame();
      return state.editingSavedGameId; // the record it created
    };
    window.__rerun = (id) => { playSavedGame(id); startGame(); };
    window.__pinOf = (id) => {
      const rec = state.savedGames.find(g => g.id === id);
      return rec && rec.frozen && rec.frozen["pub-freeze-test-100"];
    };
  });

  // ---- 1) a new game creates a PERMANENT record and pins its question ----
  const first = await page.evaluate(() => {
    const id = window.__startFresh();
    const rec = state.savedGames.find(g => g.id === id);
    return { id, frozenSig: window.__pinOf(id), charged: rec && rec.charged,
             seen: (state.seen["pub-freeze-test"] || []).length };
  });
  check("a new game creates a saved-game record", !!first.id);
  check("its question is pinned onto the record at creation", !!first.frozenSig);
  check("the record is marked permanent (charged) at creation", first.charged === true);
  check("the pinned question is recorded in the cross-game seen tracker", first.seen === 1);

  // ---- 2) a re-render (resume) keeps the pin ----
  const resumed = await page.evaluate((id) => { renderGame(); return window.__pinOf(id); }, first.id);
  check("re-rendering the same run keeps the pinned question (resume-safe)", resumed === first.frozenSig);

  // ---- 3) REPLAYS keep the SAME question forever (pins never cleared) ----
  const replayPins = [];
  for (let i = 0; i < 3; i++) {
    replayPins.push(await page.evaluate((id) => { window.__rerun(id); return window.__pinOf(id); }, first.id));
  }
  check(`replays serve the exact same pinned question every time`,
    replayPins.every(sig => sig === first.frozenSig));

  // ---- 4) the record STAYS charged after replays ----
  const stillCharged = await page.evaluate((id) => state.savedGames.find(g => g.id === id).charged, first.id);
  check("the record stays permanent (charged) across replays", stillCharged === true);

  // ---- 5) a replay with NO credits is still allowed (free forever) ----
  const gated = await page.evaluate((id) => {
    window.IZZBAH.applyAdmin(false);
    state.isPremium = false; state.codePremium = false;
    state.gamesAllowed = 0; state.codeGamesAllowed = 0; state.gamesUsed = 0;
    state.freeGamePlayed = true; state.gameActive = false;
    window.__rerun(id);
    return {
      paywall: document.getElementById("plansModal").classList.contains("open"),
      active: state.gameActive,
      pin: window.__pinOf(id),
    };
  }, first.id);
  check("a replay with no balance still starts (free replays)", !gated.paywall && gated.active);
  check("…and still serves the same pinned question", gated.pin === first.frozenSig);

  // ---- 6) NEW games never repeat questions from earlier games ----
  const freshRun = await page.evaluate(() => {
    window.IZZBAH.applyAdmin(true); state.isAdmin = true; // unlimited for the loop
    const pins = [window.__pinOf(state.editingSavedGameId)]; // game 1's pin (already seen)
    for (let i = 0; i < 5; i++) pins.push(window.__pinOf(window.__startFresh()));
    return { pins, distinct: new Set(pins).size, seenLen: (state.seen["pub-freeze-test"] || []).length };
  });
  check(`six games drain all six questions with NO repeats (got ${freshRun.distinct} distinct)`,
    freshRun.distinct === 6);
  check("the seen tracker now holds the whole pool", freshRun.seenLen === 6);

  // ---- 7) with the pool exhausted, an OLD question returns — but at random ----
  // This used to assert the single strict least-recently-seen question. That
  // was deterministic, and since serving a question bumps it to the end of the
  // recency list it produced a perfect round-robin: with N questions, game N+1
  // was byte-identical to game 1. The owner reported it as "the questions are
  // locked in sets". The pick is now random over the least-recently-seen HALF,
  // so what has to hold is the property, not the exact choice: the returned
  // question is one of the older half, never one of the recently served ones.
  const lru = await page.evaluate(() => {
    const before = (state.seen["pub-freeze-test"] || []).slice();
    const olderHalf = before.slice(0, Math.ceil(before.length / 2));
    const recentHalf = before.slice(Math.ceil(before.length / 2));
    const id = window.__startFresh(); // 7th game: pool exhausted → recycle
    const pin = window.__pinOf(id);
    const list = state.seen["pub-freeze-test"] || [];
    return { pin, fromOlderHalf: olderHalf.includes(pin), fromRecentHalf: recentHalf.includes(pin),
             bumpedToEnd: list[list.length - 1] === pin, len: list.length };
  });
  check("an exhausted category re-serves one of the least-recently-seen questions",
    lru.fromOlderHalf && !lru.fromRecentHalf);
  check("the re-served question is bumped to most-recent (so games keep cycling)",
    lru.bumpedToEnd && lru.len === 6);

  // ---- 8) the seen list survives a reload (persisted + re-loaded) ----
  const persisted = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("izzbah-seen-v1") || "{}");
    return Array.isArray(raw["pub-freeze-test"]) && raw["pub-freeze-test"].length === 6;
  });
  check("the seen tracker is persisted to izzbah-seen-v1", persisted);

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
