// The final screen's staged suspense reveal: lower places pop in one at a
// time (LAST place first) while the leader stays a masked «؟» card; then a
// drumroll, then the winner bursts in with the trophy, headline and stats.
// The DOM is fully built up front (names/scores/stats readable at any time) —
// the staging is purely visual, so nothing functional rides on it.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8353;
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

// Card state probe: for each rs-card → its score + reveal classes.
const probe = () => page.evaluate(() => ({
  cards: [...document.querySelectorAll("#resultsStage .rs-card")].map(c => ({
    score: parseInt(c.querySelector(".rs-score .clean-number")?.dataset.count || "0", 10),
    mystery: c.classList.contains("rs-mystery"),
    drum: c.classList.contains("rs-drum"),
    revealed: c.classList.contains("rs-in"),
  })),
  congratsHeld: document.getElementById("resultsCongrats").classList.contains("rs-hold"),
  statsHeld: document.getElementById("resultsStats").classList.contains("rs-hold"),
  statsText: document.getElementById("resultsStats").textContent,
  trophyIn: !!document.querySelector("#resultsStage .rs-trophy-stage.rs-in"),
  confetti: document.querySelectorAll("#results .confetti").length,
}));

const startResults = (teams) => page.evaluate((tms) => {
  playResultsIntro = (done) => { if (done) done(); }; // skip the 2.7s intro
  state.teamCount = tms.length;
  state.teams = tms.map(t => ({ name: t.name, helpers: [], helpUsed: {}, doubleArmed: false, score: t.score }));
  state.history = [
    { winnerIndex: 0, seconds: 4, points: 100 },
    { winnerIndex: 1, seconds: 9, points: 200 },
  ];
  state.gameCounted = true; // results-screen test only — don't touch credits
  renderResults();
}, teams);

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.IZZBAH.applyAuth(true); });

  // ---- 1) three teams: staged from last place up to the winner ----
  await startResults([{ name: "أ", score: 100 }, { name: "ب", score: 300 }, { name: "ج", score: 200 }]);
  await page.waitForTimeout(150);
  let s = await probe();
  const winner = () => s.cards.find(c => c.score === 300);
  check("the leader starts as a masked «؟» card", winner().mystery && !winner().revealed);
  check("no other card is revealed yet", s.cards.filter(c => c.revealed).length === 0);
  check("the headline and stats are held back", s.congratsHeld && s.statsHeld);
  check("held stats are still READABLE in the DOM (CI-safe, text is only faded)",
    /أسرع إجابة/.test(s.statsText));

  await page.waitForTimeout(600); // ≈750ms: first reveal (400ms) has fired
  s = await probe();
  check("LAST place (١٠٠) pops in first", s.cards.find(c => c.score === 100).revealed
    && !s.cards.find(c => c.score === 200).revealed);

  await page.waitForTimeout(850); // ≈1.6s: second reveal (1250ms) has fired
  s = await probe();
  check("2nd place (٢٠٠) follows", s.cards.find(c => c.score === 200).revealed && winner().mystery);

  await page.waitForTimeout(800); // ≈2.4s: drum phase (2100ms) underway
  s = await probe();
  check("the drumroll shakes the masked leader", winner().mystery && winner().drum);
  check("headline still held through the drumroll", s.congratsHeld);

  await page.waitForTimeout(1500); // ≈3.9s: finale (3600ms) has fired
  s = await probe();
  check("the winner bursts in (mask off, card revealed)", !winner().mystery && winner().revealed);
  check("trophy + headline + stats land with the winner", s.trophyIn && !s.congratsHeld && !s.statsHeld);
  check("confetti rains on the finale", s.confetti > 0);

  // ---- 2) a draw masks every tied leader and reveals them together ----
  await startResults([{ name: "أ", score: 300 }, { name: "ب", score: 300 }, { name: "ج", score: 100 }]);
  await page.waitForTimeout(150);
  s = await probe();
  check("draw: BOTH tied leaders start masked", s.cards.filter(c => c.mystery).length === 2);
  await page.waitForTimeout(3000); // one loser card → finale at ≈2750ms
  s = await probe();
  check("draw: the tied leaders reveal together at the finale",
    s.cards.filter(c => c.score === 300).every(c => c.revealed && !c.mystery));

  // ---- 3) reduced motion: everything at once, no suspense ----
  await page.emulateMedia({ reducedMotion: "reduce" });
  await startResults([{ name: "أ", score: 100 }, { name: "ب", score: 300 }]);
  await page.waitForTimeout(300);
  s = await probe();
  check("reduced motion: no mask, nothing held back", s.cards.every(c => !c.mystery)
    && !s.congratsHeld && !s.statsHeld);
  await page.emulateMedia({ reducedMotion: "no-preference" });

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
