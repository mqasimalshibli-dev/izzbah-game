// The emoji «خمّن الإيموجي», riddles «ألغاز», AND connections «إيش يجمعهم؟»
// categories are worth a FLAT 200 points: every board cell shows 200, the
// question screen shows 200, and answering awards exactly 200 (×2 only with the
// double-points helper). Other categories keep their per-tier values.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8359;
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

  // start an emoji-only game (admin bypasses the one-free-game gate)
  const board = await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true);
    state.selected = new Set(["emojis"]);
    state.editingSavedGameId = null; state.teamCount = 2;
    state.teams.forEach(t => { t.score = 0; t.doubleArmed = false; });
    startGame();
    const cells = [...document.querySelectorAll("#board .board-category-card .cell")];
    return { count: cells.length, labels: cells.map(c => c.textContent) };
  });
  check("the emoji category shows board cells", board.count >= 1);
  check(`every emoji cell is worth 200 (${JSON.stringify(board.labels)})`,
    board.labels.length > 0 && board.labels.every(t => t === "200"));

  // open a puzzle → the question screen shows 200
  const opened = await page.evaluate(() => {
    document.querySelector("#board .board-category-card .cell:not(.used)").click();
    return {
      modal: document.getElementById("modalPoints").textContent,
      qPoints: state.activeQuestion && state.activeQuestion.q ? state.activeQuestion.q.points : null,
    };
  });
  check("the question screen shows 200 نقطة", /200/.test(opened.modal) && /نقطة/.test(opened.modal));

  // answering awards exactly 200
  const scored = await page.evaluate(() => {
    finishQuestion(0);
    return { s0: state.teams[0].score, hist: (state.history || []).slice(-1)[0] };
  });
  check(`answering an emoji puzzle awards exactly 200 (got ${scored.s0})`, scored.s0 === 200);
  check("the history records the emoji question at 200", scored.hist && scored.hist.points === 200);

  // ---- a NON-emoji category still keeps its tier value ----
  const other = await page.evaluate(() => {
    state.selected = new Set(["history"]);
    state.editingSavedGameId = null;
    state.teams.forEach(t => { t.score = 0; t.doubleArmed = false; });
    startGame();
    const labels = [...document.querySelectorAll("#board .board-category-card .cell")].map(c => c.textContent);
    return { labels };
  });
  check(`a normal category still shows varied tiers, not all 200 (${JSON.stringify(other.labels)})`,
    other.labels.length > 1 && new Set(other.labels).size > 1);

  // ---- the «ألغاز» (riddles) category is ALSO flat 200 (matched by name) ----
  const riddles = await page.evaluate(() => {
    state.publishedCategories = (state.publishedCategories || []).filter(c => c.id !== "riddles-test");
    state.publishedCategories.push({ id: "riddles-test", name: "ألغاز", questions: [
      { q: "لغز أول؟", a: "حل ١", points: 100 },
      { q: "لغز ثانٍ؟", a: "حل ٢", points: 300 },
      { q: "لغز ثالث؟", a: "حل ٣", points: 500 },
    ] });
    state.selected = new Set(["riddles-test"]);
    state.editingSavedGameId = null;
    state.teams.forEach(t => { t.score = 0; t.doubleArmed = false; });
    startGame();
    const labels = [...document.querySelectorAll("#board .board-category-card .cell")].map(c => c.textContent);
    document.querySelector("#board .board-category-card .cell:not(.used)").click();
    const modal = document.getElementById("modalPoints").textContent;
    finishQuestion(0);
    return { labels, modal, score: state.teams[0].score };
  });
  check(`every «ألغاز» cell is worth 200 (${JSON.stringify(riddles.labels)})`,
    riddles.labels.length > 0 && riddles.labels.every(t => t === "200"));
  check("a riddle question shows 200 نقطة", /200/.test(riddles.modal) && /نقطة/.test(riddles.modal));
  check(`answering a riddle awards exactly 200 (got ${riddles.score})`, riddles.score === 200);

  // ---- «إيش يجمعهم؟» (connections) is ALSO flat 200 (matched by name) ----
  const conns = await page.evaluate(() => {
    state.publishedCategories = (state.publishedCategories || []).filter(c => c.id !== "conns-test");
    state.publishedCategories.push({ id: "conns-test", name: "إيش يجمعهم؟", questions: [
      { q: "أحمر · أخضر · أزرق · أصفر", a: "ألوان", points: 100 },
      { q: "ميسي · رونالدو · نيمار · صلاح", a: "لاعبو كرة قدم", points: 400 },
      { q: "عطارد · الزهرة · الأرض · المريخ", a: "كواكب", points: 500 },
    ] });
    state.selected = new Set(["conns-test"]);
    state.editingSavedGameId = null;
    state.teams.forEach(t => { t.score = 0; t.doubleArmed = false; });
    startGame();
    const labels = [...document.querySelectorAll("#board .board-category-card .cell")].map(c => c.textContent);
    document.querySelector("#board .board-category-card .cell:not(.used)").click();
    const modal = document.getElementById("modalPoints").textContent;
    finishQuestion(0);
    return { labels, modal, score: state.teams[0].score };
  });
  check(`every «إيش يجمعهم؟» cell is worth 200 (${JSON.stringify(conns.labels)})`,
    conns.labels.length > 0 && conns.labels.every(t => t === "200"));
  check("a connections question shows 200 نقطة", /200/.test(conns.modal) && /نقطة/.test(conns.modal));
  check(`answering a connections question awards exactly 200 (got ${conns.score})`, conns.score === 200);

  // the connections matcher covers BOTH names the category ships under
  const nameMatch = await page.evaluate(() => ({
    a: isConnectionsCategory({ name: "إيش يجمعهم؟" }),
    b: isConnectionsCategory({ name: "وش الرابط؟" }),
    c: isConnectionsCategory({ name: "ما الرابط بينهم؟" }),
    d: isConnectionsCategory({ name: "تاريخ" }),
  }));
  check("«إيش يجمعهم؟» AND «وش الرابط؟» both count as connections; a normal name doesn't",
    nameMatch.a && nameMatch.b && nameMatch.c && !nameMatch.d);

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
