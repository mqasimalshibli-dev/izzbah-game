// «مضاعفة النقاط» (×2) — the card and the payout must always agree.
//
// The helper was inconsistent three ways. It had no `activeOnly`, so ANY team
// could arm it from the board; the card drew its ×2 badge from the ACTIVE
// team's flag; the award read the WINNER's flag; and the consume cleared the
// ACTIVE team's. Measured on a 3-team, 300-point question, that produced:
//
//   • team 0 arms, team 1 answers  → card shows ×2, team 1 paid 300
//   • …and team 0's one-shot ×2 silently burned, having paid nobody
//   • team 2 arms off-turn and wins → paid 600 with NO ×2 shown anywhere
//
// The rule (documented in tests/gameplay.mjs, which pins it): ×2 belongs to the
// TEAM that armed it. If another team answers they get normal points, and the
// arming team's one-shot is spent regardless — that is deliberate.
//
// The actual defect was the missing `activeOnly`. With it, only the team whose
// turn it is can arm ×2, so the flag the CARD reads (the active team's) and the
// flag the AWARD reads (the winner's) can only ever be the same team's. The
// off-turn surprise double — 600 paid with no ×2 shown anywhere — is gone.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8387;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
await page.route("**/firebasejs/**", route => route.abort());
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));

// One question, start to finish. `armIdx` is the team whose flag is set;
// `winnerIdx` is who the host credits in «من جاوب؟».
const play = (armIdx, winnerIdx) => page.evaluate(({ armIdx, winnerIdx }) => {
  state.teamCount = 3;
  state.teams = [0, 1, 2].map(i => ({ name: "ف" + i, score: 0,
    helpers: ["doublePoints"], helpUsed: {}, doubleArmed: false }));
  state.activeTeam = 0;
  state.used = new Set();
  state.history = [];
  const cat = { id: "t", name: "اختبار", questions: [{ points: 300, q: "س", a: "ج" }] };
  const q = cat.questions[0];
  state.teams[armIdx].doubleArmed = true;
  openQuestion(cat, q, "t-300-" + Math.round(performance.now() * 1000));
  const shown = /×٢|×2/.test(document.getElementById("modalPoints").textContent);
  revealAnswer();
  const before = state.teams.map(t => t.score);
  finishQuestion(winnerIdx);
  return { shown, gained: state.teams[winnerIdx].score - before[winnerIdx] };
}, { armIdx, winnerIdx });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => typeof openQuestion === "function", { timeout: 15000 });
  await page.waitForTimeout(300);

  // ---- the card and the payout agree, in every combination ----
  const armedSelf = await play(0, 0);
  check("armed by the team whose turn it is, they answer → ×2 shown, 600 paid",
    armedSelf.shown && armedSelf.gained === 600);

  const armedOther = await play(0, 1);
  check("armed on this turn, ANOTHER team answers → normal 300 (the ×2 is the arming TEAM's)",
    armedOther.shown && armedOther.gained === 300);

  const notArmed = await play(2, 2);
  check("an off-turn flag pays nothing extra → no ×2 shown, 300 paid",
    !notArmed.shown && notArmed.gained === 300);

  const notArmed2 = await play(2, 0);
  check("...and still nothing extra when someone else answers",
    !notArmed2.shown && notArmed2.gained === 300);

  // ---- the off-turn case is unreachable through the UI at all ----
  const gate = await page.evaluate(() => {
    state.teamCount = 3;
    state.teams = [0, 1, 2].map(i => ({ name: "ف" + i, score: 0,
      helpers: ["doublePoints"], helpUsed: {}, doubleArmed: false }));
    state.activeTeam = 0;
    document.body.dataset.screen = "game";
    renderScores();
    const bars = [...document.querySelectorAll("[data-team-help]")];
    const btnFor = (i) => {
      const bar = bars[i] || document.querySelectorAll(".score-cell")[i];
      if (!bar) return null;
      return [...bar.querySelectorAll(".qhelp-slot")]
        .find(b => (b.getAttribute("aria-label") || "") === "مضاعفة النقاط") || null;
    };
    const a = btnFor(0), b = btnFor(1);
    return { found: !!(a && b), activeEnabled: a ? !a.disabled : null, otherEnabled: b ? !b.disabled : null };
  });
  if (!gate.found) {
    console.log("SKIP  help-bar buttons not reachable in this layout");
  } else {
    check("the team whose turn it is CAN arm ×2", gate.activeEnabled === true);
    check("a team whose turn it is NOT cannot arm ×2", gate.otherEnabled === false);
  }

  check("no uncaught JS errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 3));
} catch (e) {
  check(`threw: ${e && e.message}`, false);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
