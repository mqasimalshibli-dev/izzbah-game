// A saved game's questions are FROZEN: replaying it always serves the same
// question in every cell. Only a brand-NEW game draws fresh questions. Without
// freezing, a tier with several questions would re-roll on each replay — this
// drives a 6-question tier and proves it never changes across replays.
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
    window.IZZBAH.applyAdmin(true); // admin bypasses the one-free-game gate
    // A category with SIX distinct questions in the 100 tier — re-rolling would
    // almost never repeat the same one five times in a row.
    window.IZZBAH.applyPublished([{
      id: "pub-freeze-test", name: "تجميد", image: "", order: 1,
      questions: Array.from({ length: 6 }, (_, i) => ({ points: 100, q: "سؤال " + i, a: "جواب " + i, image: "", answerImage: "" })),
    }]);
    // helpers used by the harness
    window.__startFresh = () => {
      state.selected = new Set(["pub-freeze-test"]);
      state.currentGameName = "";
      state.editingSavedGameId = null; // brand-new game
      state.teamCount = 2;
      startGame();
      return state.editingSavedGameId; // the record it created
    };
    window.__replay = (id) => { playSavedGame(id); startGame(); };
    window.__served = () => {
      const card = [...document.querySelectorAll(".board-category-card")].find(c => c.textContent.includes("تجميد"));
      const cell = card.querySelector(".cell:not(.used)");
      cell.click();
      return state.activeQuestion.q.a;
    };
  });

  // ---- 1) first play of a NEW game creates a record and freezes a question ----
  const first = await page.evaluate(() => {
    const id = window.__startFresh();
    const rec = state.savedGames.find(g => g.id === id);
    const served = window.__served();
    return { id, frozenSig: rec && rec.frozen && rec.frozen["pub-freeze-test-100"], served };
  });
  check("a new game creates a saved-game record", !!first.id);
  check("the played cell's question is frozen onto the record", !!first.frozenSig);
  check("the served question is one of the six", /^جواب [0-5]$/.test(first.served));

  // ---- 2) replaying that saved game serves the SAME question, every time ----
  const replays = [];
  for (let i = 0; i < 5; i++) {
    replays.push(await page.evaluate((id) => { window.__replay(id); return window.__served(); }, first.id));
  }
  check(`5 replays all serve the SAME question (${first.served} → ${JSON.stringify(replays)})`,
    replays.every(a => a === first.served));

  // the frozen signature never changed across those replays
  const sigStable = await page.evaluate((id) =>
    state.savedGames.find(g => g.id === id).frozen["pub-freeze-test-100"], first.id);
  check("the frozen signature is unchanged after replays", sigStable === first.frozenSig);

  // ---- 3) a brand-NEW game is a separate record (its own fresh draw) ----
  const second = await page.evaluate(() => {
    const id = window.__startFresh();
    return { id, served: window.__served() };
  });
  check("a brand-new game is a DIFFERENT saved-game record", second.id && second.id !== first.id);
  check("the new game's question is independently valid", /^جواب [0-5]$/.test(second.served));

  // ---- 4) the original record still holds its original question ----
  const back = await page.evaluate((id) => { window.__replay(id); return window.__served(); }, first.id);
  check("re-opening the original saved game STILL serves its frozen question", back === first.served);

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
