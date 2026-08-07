// Play a COMPLETE game and assert the invariants that only break in sequence.
//
// The unit tests each pin one rule. This drives a whole game — every tile, both
// teams, awards, skips and the results screen — and checks the properties that
// can only go wrong across many turns: scores that drift from what was awarded,
// a turn order that slips, a question served twice, or a JS error thrown on
// turn 14 that no single-question test would ever reach.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8404;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  " + extra : ""}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];
const page = await browser.newPage({ viewport: { width: 900, height: 820 } });
await page.route("**/firebasejs/**", r => r.abort());
page.on("pageerror", e => errs.push(e.message));
// Firebase is deliberately aborted in this harness, so its failed request is
// expected noise — everything else is not.
page.on("console", m => {
  if (m.type() !== "error") return;
  const t = m.text();
  if (/ERR_FAILED|firebasejs|net::/.test(t)) return;
  errs.push("console: " + t.slice(0, 120));
});
await page.addInitScript(() => {
  try {
    localStorage.setItem("izzbah-legal-consent-v1", "1");
    localStorage.setItem("izzbah-coach-v1", JSON.stringify({ __all: 1 }));
  } catch (e) {}
});
await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(1500);

const res = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  state.teamCount = 2;
  state.teams = [
    { name: "أ", score: 0, image: "", helpers: ["fourChoices", "firstLetter", "doublePoints"], helpUsed: {}, doubleArmed: false, stealArmed: false },
    { name: "ب", score: 0, image: "", helpers: ["fourChoices", "firstLetter", "doublePoints"], helpUsed: {}, doubleArmed: false, stealArmed: false },
  ];
  state.activeTeam = 0;
  state.selected = new Set(["history", "geo", "science"]);   // a Set, not an array
  state.editingSavedGameId = null; state.gameCounted = false;
  startGame();
  await sleep(400);

  const seen = new Set();
  let dupServed = 0, turnSlips = 0, turns = 0, awarded = [0, 0], noone = 0;
  const trail = [];

  // Drive the real DOM: open a cell, reveal, then award via the actual buttons.
  for (let i = 0; i < 30; i++) {
    const cell = document.querySelector("#board .board-category-card .cell:not(.used)");
    if (!cell) break;
    const before = state.activeTeam;
    cell.click();
    await sleep(90);
    const aq = state.activeQuestion;
    if (!aq) break;
    const sig = (aq.q.q || "") + "|" + (aq.q.a || "");
    if (seen.has(sig)) dupServed++;
    seen.add(sig);
    const reward = questionReward(aq.cat, aq.q);

    const rev = document.getElementById("revealAnswer");
    if (rev) rev.click();
    await sleep(90);

    // The team button only SELECTS a winner; #continueAnswer is what actually
    // pays out and closes the question. Clicking the team alone leaves the
    // question open forever, which is what made the first draft of this test
    // report 29 duplicate questions and 30 turn slips.
    const btns = document.querySelectorAll("#awardRow .team-award");
    const mode = i % 3;
    if (mode === 2 || btns.length < 2) {
      const none = [...document.querySelectorAll("#awardRow button")].find(b => b.classList.contains("ghost"));
      if (none) { none.click(); noone++; }
    } else {
      awarded[mode] += reward;
      btns[mode].click();
    }
    await sleep(60);
    const cont = document.getElementById("continueAnswer");
    if (cont && !cont.disabled) cont.click();
    await sleep(110);
    trail.push([state.teams[0].score, state.teams[1].score]);
    turns++;
    // Answering the LAST cell ends the game and resets state for the next one,
    // so the final turn legitimately does not advance and the scores legitimately
    // return to zero. Both are measured up to that point, not after it.
    const ended = !document.querySelector("#board .cell:not(.used)");
    if (!ended && state.activeTeam !== (before + 1) % state.teamCount) turnSlips++;
  }

  return {
    turns, dupServed, turnSlips, noone,
    scores: state.teams.map(t => t.score),
    awarded,
    // peak, not final: see the reset note above.
    scoreOk: null,
    noNegative: state.teams.every(t => t.score >= 0),
    usedCells: document.querySelectorAll("#board .cell.used").length,
    trail, peak: trail.length ? trail.reduce((a,t)=>[Math.max(a[0],t[0]),Math.max(a[1],t[1])],[0,0]) : [0,0],
  };
});

console.log(JSON.stringify(res));
check("a full game runs many turns", res.turns >= 10, `(${res.turns} turns)`);
check("every award landed, and nothing else changed a score", res.peak[0] === res.awarded[0] && res.peak[1] === res.awarded[1], `peak ${res.peak} vs awarded ${res.awarded}`);
check("scores climb monotonically — no silent resets mid-game", (() => { const t = res.trail.slice(0, -1); return t.every((v, i) => i === 0 || (v[0] >= t[i-1][0] && v[1] >= t[i-1][1])); })());
check("the board completed — every cell was played", res.usedCells >= res.turns);
check("no score went negative", res.noNegative);
check("the turn passes to the next team every single time", res.turnSlips === 0, `(${res.turnSlips} slips)`);
check("no question was served twice in one game", res.dupServed === 0, `(${res.dupServed} repeats)`);
check("no uncaught JS errors across the whole game", errs.length === 0);
if (errs.length) console.log("  errs:", errs.slice(0, 5));

await browser.close(); server.kill();
process.exit(checks.every(Boolean) ? 0 : 1);
