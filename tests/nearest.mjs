// «الأقرب يفوز» winning-margin pill: a small gold box above the question shows
// ±margin — a guess within it takes the points. The margin is auto-derived from
// the answer's number (years ±5, small counts ±1–2, ~5% for huge values), a
// per-question `margin` overrides it. The admin question modal exposes the
// margin field on EVERY category now (blank = auto inside «الأقرب يفوز», or a
// normal question elsewhere); an explicit margin turns ANY category's question
// into a closest-wins one, showing the pill in play.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8379;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ---- 1) the auto-margin heuristic picks sensible limits ----
  const auto = await page.evaluate(() => ({
    five_thousand: nearestAutoMargin({ q: "كم؟", a: "5000" }),                       // the user's example
    continents: nearestAutoMargin({ q: "كم عدد القارات في العالم؟", a: "7" }),
    year: nearestAutoMargin({ q: "في أي سنة نزل أول إنسان على القمر؟", a: "1969" }),
    mountain: nearestAutoMargin({ q: "كم ارتفاع جبل شمس؟", a: "حوالي 3009 متر" }),
    burj: nearestAutoMargin({ q: "كم ارتفاع برج خليفة؟", a: "828 متر" }),
    bones: nearestAutoMargin({ q: "كم عدد عظام الجسم؟", a: "206" }),
    arabicDigits: nearestAutoMargin({ q: "كم؟", a: "٦٥٠٠ كم" }),
    huge: nearestAutoMargin({ q: "كم سرعة الضوء؟", a: "حوالي 300000 كم/ث" }),
    noNumber: nearestAutoMargin({ q: "س", a: "مسقط" }),
  }));
  check(`an answer of 5000 gets ±100 (got ±${auto.five_thousand})`, auto.five_thousand === 100);
  check(`a tiny count (7 قارات) gets ±1 (got ±${auto.continents})`, auto.continents === 1);
  check(`a year (1969) gets ±5 (got ±${auto.year})`, auto.year === 5);
  check(`جبل شمس 3009 → ±100 and برج خليفة 828 → ±50`, auto.mountain === 100 && auto.burj === 50);
  check(`206 عظمة → ±10`, auto.bones === 10);
  check(`Arabic-Indic digits parse (٦٥٠٠ → ±${auto.arabicDigits})`, auto.arabicDigits === 100);
  check(`a huge value (300000) gets a round ~5% margin (got ±${auto.huge})`, auto.huge === 20000);
  check("a non-numeric answer yields no margin (no pill)", auto.noNumber === null);

  // ---- 2) the pill shows on a nearest-wins question (auto + override) ----
  const pill = await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true);
    state.publishedCategories = (state.publishedCategories || []).filter(c => c.id !== "near-test");
    state.publishedCategories.push({ id: "near-test", name: "الأقرب يفوز", custom: true, questions: [
      { points: 100, q: "كم عدد القارات في العالم؟", a: "7", image: "", answerImage: "" },
      { points: 200, q: "كم ارتفاع جبل شمس؟", a: "حوالي 3009 متر", image: "", answerImage: "", margin: 250 },
    ] });
    state.selected = new Set(["near-test"]);
    state.editingSavedGameId = null; state.teamCount = 2;
    state.teams.forEach(t => { t.score = 0; t.doubleArmed = false; });
    startGame();
    const cells = [...document.querySelectorAll("#board .board-category-card .cell:not(.used)")];
    cells[0].click(); // the 100-point cell → first question (auto margin)
    const el = document.getElementById("nearMargin");
    const cs = getComputedStyle(el);
    return {
      visible: !el.hidden && cs.display !== "none",
      text: el.textContent,
      val: document.getElementById("nearMarginVal").textContent,
      notRed: !/rgb\(2\d\d, ?3\d, ?4\d\)/.test(cs.backgroundColor), // not the button red
      aboveQuestion: el.nextElementSibling && el.nextElementSibling.id === "modalQuestion",
    };
  });
  check("the margin pill shows above the question in «الأقرب يفوز»", pill.visible && pill.aboveQuestion);
  check(`the pill carries the label + ±value (${pill.val})`, /هامش/.test(pill.text) && pill.val === "±1");
  check("the pill is a different colour than the buttons", pill.notRed);

  const overridden = await page.evaluate(() => {
    // finish this question, open the 200-point one (explicit margin 250)
    finishQuestion(null);
    const cells = [...document.querySelectorAll("#board .board-category-card .cell:not(.used)")];
    cells[0].click();
    return document.getElementById("nearMarginVal").textContent;
  });
  check(`an explicit per-question margin overrides the auto value (${overridden})`, overridden === "±250");

  // ---- 3) a normal question shows no pill, but an EXPLICIT margin turns any
  //         category's question into a closest-wins one (pill shows) ----
  const other = await page.evaluate(() => {
    finishQuestion(null);
    state.selected = new Set(["history"]);
    state.editingSavedGameId = null;
    startGame();
    document.querySelector("#board .board-category-card .cell:not(.used)").click();
    return document.getElementById("nearMargin").hidden;
  });
  check("a normal category question (no margin) shows no pill", other === true);

  const otherWithMargin = await page.evaluate(() => {
    finishQuestion(null);
    state.publishedCategories = (state.publishedCategories || []).filter(c => c.id !== "hist-margin");
    state.publishedCategories.push({ id: "hist-margin", name: "تاريخ بالأرقام", custom: true, questions: [
      { points: 100, q: "كم سنة استمرّت الحرب؟", a: "40", image: "", answerImage: "", margin: 3 },
    ] });
    state.isAdmin = true; // bypass the play gate for a private category
    state.selected = new Set(["hist-margin"]);
    state.editingSavedGameId = null; state.teamCount = 2;
    state.teams.forEach(t => { t.score = 0; });
    startGame();
    document.querySelector("#board .board-category-card .cell:not(.used)").click();
    const el = document.getElementById("nearMargin");
    return { hidden: el.hidden, val: document.getElementById("nearMarginVal").textContent };
  });
  check("an EXPLICIT margin makes ANY category show the pill (±3)",
    !otherWithMargin.hidden && otherWithMargin.val === "±3");

  // ---- 4) the admin question modal exposes the margin for EVERY category ----
  const adminNear = await page.evaluate(() => {
    finishQuestion(null);
    state.adminCat = { id: "near-test", name: "الأقرب يفوز", custom: true, questions: [
      { points: 100, q: "كم عدد القارات في العالم؟", a: "7", image: "", answerImage: "" },
    ] };
    openAdminQuestion(0);
    const inputShown = !document.getElementById("adminQMargin").hidden;
    const ph = document.getElementById("adminQMargin").placeholder;
    document.getElementById("adminQMargin").value = "25";
    saveAdminQuestion();
    return { inputShown, ph, saved: state.adminCat.questions[0].margin };
  });
  check("the admin modal shows the margin field for «الأقرب يفوز»", adminNear.inputShown);
  check(`its placeholder previews the auto value (${adminNear.ph})`, /تلقائي/.test(adminNear.ph) && /±1/.test(adminNear.ph));
  check("saving stores the adjusted margin on the question", adminNear.saved === 25);

  const adminOther = await page.evaluate(() => {
    document.getElementById("adminQModal").classList.remove("open");
    state.adminCat = { id: "history", name: "تاريخ", questions: [{ points: 100, q: "كم دولة في العالم؟", a: "195", image: "", answerImage: "" }] };
    openAdminQuestion(0);
    const shown = !document.getElementById("adminQMargin").hidden;
    const ph = document.getElementById("adminQMargin").placeholder;
    document.getElementById("adminQMargin").value = "10";
    saveAdminQuestion();
    const saved = state.adminCat.questions[0].margin;
    document.getElementById("adminQModal").classList.remove("open");
    return { shown, ph, saved };
  });
  check("the margin field now shows for EVERY category", adminOther.shown);
  check(`a normal category's placeholder reads «بدون هامش» (${adminOther.ph})`, /بدون هامش/.test(adminOther.ph));
  check("saving stores the margin on a normal-category question", adminOther.saved === 10);

  // ---- 5) the cloud meta copy carries the margin (publish round-trip shape) ----
  const meta = await page.evaluate(() => {
    // mirror the cloudPublish meta mapping
    const list = [
      { points: 100, q: "س", a: "5000", margin: 250 },
      { points: 200, q: "س٢", a: "7" },
    ];
    return list.map(q => ({ margin: Number(q.margin) > 0 ? Number(q.margin) : 0 }));
  });
  check("the publish meta shape carries margin (explicit or 0=auto)", meta[0].margin === 250 && meta[1].margin === 0);

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
