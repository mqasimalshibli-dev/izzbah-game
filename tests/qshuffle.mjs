// Boards must keep shuffling — including after a category runs out.
//
// The report: "the questions should shuffle always, they shouldn't be locked in
// sets; the same set of questions is found exactly on another device."
//
// New games were already drawing at random from the unseen pool, and that part
// measured clean (two fresh devices, and a device that had pulled another's
// cloud blob, all produced boards with zero overlap). The break was at the far
// end: once a category was EXHAUSTED, pickUnseen returned the single strict
// least-recently-seen question, and serving a question bumps it to the end of
// the recency list. That is a perfect round-robin — with N questions in a tier,
// game N+1 came back byte-identical to game 1, N+2 to game 2, forever, and two
// players whose histories lined up saw the same boards in the same order.
//
// The pick is now random across the least-recently-seen HALF, which keeps the
// guarantee that mattered (a question just served is in the recent half and
// cannot come straight back) while making the recycled boards differ.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8385;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const TIERS = [100, 200, 300, 400, 500];
const mkCat = (id, perTier) => ({
  id, name: id, image: "", order: 1,
  questions: TIERS.flatMap(p => Array.from({ length: perTier },
    (_, i) => ({ points: p, q: `${id}-${p}-${i}`, a: `ج${i}`, image: "", answerImage: "" }))),
});

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

// A device: its own browser context, so localStorage is genuinely separate.
async function device(cats, seed) {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
  if (seed) await ctx.addInitScript(s => {
    for (const k of Object.keys(s)) { try { localStorage.setItem(k, s[k]); } catch (e) {} }
  }, seed);
  const page = await ctx.newPage();
  await page.route("**/firebasejs/**", r => r.abort());
  page.on("pageerror", e => errs.push(e.message));
  page.on("dialog", d => d.accept().catch(() => {}));
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1300);
  await page.evaluate((cs) => {
    window.IZZBAH.applyAuth(true, "u"); window.IZZBAH.applyAdmin(true);
    window.IZZBAH.applyPublished(cs);
    // A brand-new game (fresh selection, not a replay of a saved record).
    window.__newGame = () => {
      state.selected = new Set(cs.map(x => x.id));
      state.currentGameName = "";
      state.editingSavedGameId = null;
      state.teamCount = 2;
      startGame();
      const rec = state.savedGames.find(g => g.id === state.editingSavedGameId);
      return Object.keys(rec.frozen).sort().map(k => rec.frozen[k]);
    };
    window.__replay = (id) => { playSavedGame(id); startGame();
      const rec = state.savedGames.find(g => g.id === id);
      return Object.keys(rec.frozen).sort().map(k => rec.frozen[k]); };
    window.__dump = () => {
      const o = {};
      for (const k of ["izzbah-trivia-saved-games-v1", "izzbah-seen-v1", "izzbah-progress-v1"]) {
        const v = localStorage.getItem(k); if (v != null) o[k] = v;
      }
      return o;
    };
  }, cats);
  return { ctx, page };
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

try {
  // ── 1) the round-robin is gone ────────────────────────────────────────────
  // 4 questions per tier: games 1-4 drain the pool, 5-8 recycle it. Under the
  // old strict-oldest rule game 5 == game 1, 6 == 2, 7 == 3, 8 == 4, every time.
  {
    const A = await device([mkCat("pub-rot", 4)]);
    const runs = [];
    for (let i = 0; i < 8; i++) runs.push(await A.page.evaluate(() => window.__newGame()));
    const repeats = [4, 5, 6, 7].filter(i => same(runs[i], runs[i - 4])).length;
    check(`after the pool is exhausted the boards do NOT replay in a fixed cycle (${repeats}/4 repeated)`,
      repeats === 0);

    // …and the recycled boards are not all the same board either.
    const recycled = runs.slice(4).map(r => r.join("|"));
    check(`the recycled boards differ from each other (${new Set(recycled).size}/4 distinct)`,
      new Set(recycled).size >= 3);
    await A.ctx.close();
  }

  // ── 2) a question just served never comes straight back ───────────────────
  // The freshness guarantee the strict-oldest rule was there to provide has to
  // survive the randomisation.
  {
    const A = await device([mkCat("pub-back", 4)]);
    for (let i = 0; i < 4; i++) await A.page.evaluate(() => window.__newGame()); // drain
    let immediate = 0;
    let prev = await A.page.evaluate(() => window.__newGame());
    for (let i = 0; i < 8; i++) {
      const next = await A.page.evaluate(() => window.__newGame());
      immediate += next.filter((v, k) => v === prev[k]).length;
      prev = next;
    }
    check(`a question served in one game never reappears in the very next one (${immediate} did)`,
      immediate === 0);
    await A.ctx.close();
  }

  // ── 3) new games on different devices are not the same board ──────────────
  // Both a never-used device and one that has pulled the first device's cloud
  // blob (saved games + seen history) down on sign-in.
  {
    // Three categories -> a 15-tile board. With 20 questions per tier two
    // independent devices coincide on 0.75 tiles on average by pure chance, so
    // a low ceiling here is a real signal rather than a lucky run.
    const cat = ["x", "y", "z"].map(k => mkCat("pub-dev-" + k, 20));
    const A = await device(cat);
    const a = await A.page.evaluate(() => window.__newGame());
    const blob = await A.page.evaluate(() => window.__dump());

    const B = await device(cat);                 // fresh device, no history
    const b = await B.page.evaluate(() => window.__newGame());
    const C = await device(cat, blob);           // same account, synced from A
    const c = await C.page.evaluate(() => window.__newGame());

    const overlapB = a.filter((v, i) => v === b[i]).length;
    const overlapC = a.filter((v, i) => v === c[i]).length;
    check(`a new game on a fresh device is not the same board (${overlapB}/${a.length} tiles shared)`,
      overlapB < a.length && overlapB <= 4);
    check(`a new game on a device synced from the first is not the same board (${overlapC}/${a.length} shared)`,
      overlapC < a.length && overlapC <= 4);
    check("the synced device really did inherit the other's history (the test means something)",
      await C.page.evaluate(() => state.savedGames.length > 0
        && Object.values(state.seen || {}).some(v => v.length > 0)));
    await A.ctx.close(); await B.ctx.close(); await C.ctx.close();
  }

  // ── 4) REPLAYING a saved game still serves its own board ──────────────────
  // Owner's call (2026-08-02): only NEW games shuffle. A game that was paid for
  // keeps its board on replay, or one purchase would yield endless fresh
  // questions.
  {
    const A = await device([mkCat("pub-replay", 20)]);
    const first = await A.page.evaluate(() => { window.__newGame(); return state.editingSavedGameId; });
    const boards = [];
    for (let i = 0; i < 3; i++) boards.push(await A.page.evaluate((id) => window.__replay(id), first));
    check("replaying a saved game still serves the identical board every time",
      boards.every(b => same(b, boards[0])));
    await A.ctx.close();
  }

  // ── 5) a tier with ONE question cannot shuffle, and must not crash ────────
  // «دين» and «ميمز» are like this in the live catalogue: 5 questions, one per
  // tier. No selection logic can vary that board — it is a content gap, not a
  // bug — but it must still be served cleanly.
  {
    const A = await device([mkCat("pub-thin", 1)]);
    const r1 = await A.page.evaluate(() => window.__newGame());
    const r2 = await A.page.evaluate(() => window.__newGame());
    check("a one-question-per-tier category still serves a full board", r1.length === TIERS.length);
    check("...and repeats it, because there is nothing else to serve", same(r1, r2));
    await A.ctx.close();
  }

  check("no page errors", errs.length === 0);
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
