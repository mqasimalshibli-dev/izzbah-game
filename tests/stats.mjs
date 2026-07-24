// E2E for the admin "insights" panel: a finished game tallies a full stats
// payload (categories, teams, credit type, lifelines, answer stats) into the
// global counters, and the admin panel renders the complete overview —
// games/trend tiles, ranked categories, community votes, content health,
// players & subscriptions, and play-style stats.
//
// Runs OFFLINE (Firebase SDK aborted); the cloud bridges are stubbed, so we
// exercise the same UI + recording code paths the live bridges drive.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8336;
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

  // ---- 1) finishing a game tallies a full payload exactly once ----
  const record = await page.evaluate(() => {
    const calls = [];
    window.IZZBAH.recordGamePlay = (p) => { calls.push(p); return Promise.resolve(true); };
    window.IZZBAH.applyAuth(true, "u1"); window.IZZBAH.applyAdmin(false);
    state.selected = new Set(["history", "geo", "science"]);
    refreshBuiltinQuestions();
    state.teamCount = 2; state.teams.forEach(t => { t.score = 0; t.helpUsed = {}; });
    state.teams[0].score = 300;
    state.teams[0].helpUsed = { fourChoices: true };
    state.history = [
      { winnerIndex: 0, seconds: 12 },
      { winnerIndex: null, seconds: 30 },   // «لا أحد» — no one answered
      { winnerIndex: 1, seconds: 8 },
    ];
    state.gameStartedAt = Date.now() - 15 * 60000; // a 15-minute game
    state.freeGamePlayed = false; state.gamesUsed = 0; state.isPremium = false; state.codePremium = false;
    state.gameCounted = false;
    renderResults();                 // reaches the results screen -> records once
    renderResults();                 // re-opening must NOT record again
    return { count: calls.length, p: calls[0] || {} };
  });
  check("finishing a game records exactly once (guarded like the credit spend)", record.count === 1);
  check("the payload carries the game's category ids",
    Array.isArray(record.p.catIds) && ["history", "geo", "science"].every(id => record.p.catIds.includes(id)));
  check("the payload carries teams, credit type and duration",
    record.p.teams === 2 && record.p.credit === "free"
    && record.p.durationSec >= 14 * 60 && record.p.durationSec <= 16 * 60);
  check("the payload tallies answered vs no-answer and answer times",
    record.p.answered === 2 && record.p.noAnswer === 1
    && record.p.timedCount === 3 && record.p.secsSum === 50);
  check("the payload tallies lifeline usage", record.p.helpers && record.p.helpers.fourChoices === 1);

  // ---- 2) the admin chooser exposes an Insights option ----
  await page.evaluate(() => { window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true); });
  await page.waitForTimeout(120);
  await page.evaluate(() => document.getElementById("adminEntry").click());
  await page.waitForTimeout(180);
  const chooser = await page.evaluate(() => ({
    open: document.getElementById("adminChoiceModal").classList.contains("open"),
    hasStats: !!document.getElementById("adminChoiceStats"),
  }));
  check("the admin chooser shows an Insights (الإحصائيات) option", chooser.open && chooser.hasStats);

  // ---- 3) opening Insights renders the FULL overview ----
  const view = await page.evaluate(async () => {
    const p2 = n => String(n).padStart(2, "0");
    const key = back => { const d = new Date(Date.now() - back * 86400000); return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()); };
    const days = {}; days[key(0)] = 4; days[key(2)] = 3; days[key(9)] = 2; // 7 this week vs 2 last week
    window.IZZBAH.loadStats = () => Promise.resolve({
      gamesPlayed: 42,
      categoryPlays: { seerah: 10, geo: 25, history: 5, culture: 25 },
      days,
      teamCounts: { "2": 30, "4": 10 },
      durationSum: 40 * 1200, durationCount: 40,          // avg 20 min
      helpers: { fourChoices: 18, firstLetter: 7, doublePoints: 4 },
      answers: { answered: 300, noAnswer: 100 },           // 25% no-answer
      answerSecsSum: 4500, answerTimedCount: 300,          // avg 15s
      credits: { free: 12, allowance: 25, premium: 5 },
      updatedAt: Date.now() - 3600000,                     // last game ~1h ago
    });
    window.IZZBAH.listCodes = () => Promise.resolve([
      { code: "AAAA-1111", gamesAllowed: 5, premium: false, used: true, usedBy: "uA" },
      { code: "BBBB-2222", gamesAllowed: 10, premium: false, used: true, usedBy: "uA" },
      { code: "CCCC-3333", gamesAllowed: 0, premium: true, used: true, usedBy: "uB" },
      { code: "DDDD-4444", gamesAllowed: 3, premium: false, used: false, usedBy: "" },
    ]);
    window.IZZBAH.listUsage = () => Promise.resolve({
      uA: { used: 6, granted: 15, premium: false },
      uB: { used: 2, granted: 0, premium: true },
    });
    window.IZZBAH.listSales = () => Promise.resolve([
      { id: "s1", pack: "باقة ٥ ألعاب", games: 5, premium: false, priceOMR: 1.5, email: "buyer1@x.com", createdAt: Date.now() },
      { id: "s2", pack: "باقة ١٥ لعبة", games: 15, premium: false, priceOMR: 3.5, email: "buyer2@x.com", createdAt: Date.now() - 3 * 3600000 },
      { id: "s3", pack: "باقة لعبتين", games: 2, premium: false, priceOMR: 0.9, email: "buyer3@x.com", createdAt: Date.now() - 2 * 86400000 },
    ]); // total 5.900 ر.ع, 3 sales, 22 games
    const nowMs = Date.now(), monthAgo = nowMs - 30 * 86400000;
    window.IZZBAH.listPlayerStats = () => Promise.resolve([
      { games: 1, firstAt: nowMs,    lastAt: nowMs },     // new this week
      { games: 5, firstAt: monthAgo, lastAt: nowMs },     // returning, active this week
      { games: 3, firstAt: monthAgo, lastAt: monthAgo },  // returning, not active
      { games: 1, firstAt: monthAgo, lastAt: monthAgo },  // old one-timer
    ]); // 4 total, 2 returning (50%), 1 new this week
    state.communityCategories = [
      { name: "فئة المجتمع الأولى", votes: 9, approved: true },
      { name: "فئة المجتمع الثانية", votes: 4, approved: true },
    ];
    state.pendingCommunity = [{ id: "p1" }];
    document.getElementById("adminChoiceStats").click();
    await new Promise(r => setTimeout(r, 300));
    const txt = id => document.getElementById(id).textContent;
    const rows = [...document.querySelectorAll("#statsCats .stats-bar-row")];
    return {
      modalOpen: document.getElementById("statsModal").classList.contains("open"),
      chooserClosed: !document.getElementById("adminChoiceModal").classList.contains("open"),
      tiles: txt("statsTiles"), cats: txt("statsCats"), community: txt("statsCommunity"),
      health: txt("statsHealth"), sales: txt("statsSales"), audience: txt("statsAudience"),
      players: txt("statsPlayers"), play: txt("statsPlay"),
      salesList: txt("statsSalesList"), salesRows: document.querySelectorAll("#statsSalesList .prem-row").length,
      updatedAt: txt("statsUpdatedAt"), hasSalesRefresh: !!document.getElementById("salesRefresh"),
      rowCount: rows.length,
      firstIsRank1: rows[0] ? rows[0].classList.contains("rank-1") : false,
      firstFillPct: rows[0] ? rows[0].querySelector(".stats-bar-fill").style.width : "",
      tilesHtml: document.getElementById("statsTiles").innerHTML,
    };
  });
  check("choosing Insights opens the stats modal and closes the chooser", view.modalOpen && view.chooserClosed);
  check("overview shows totals + weekly trend + avg duration + avg teams",
    /٤٢|42/.test(view.tiles) && /هذا الأسبوع/.test(view.tiles) && /٧|7/.test(view.tiles)
    && /٢٠|20/.test(view.tiles) && /متوسط عدد الفرق/.test(view.tiles) && /trend-up/.test(view.tilesHtml));
  check("overview shows the time of the last game played", /آخر لعبة/.test(view.tiles));
  check("all four played categories are ranked, top at 100%",
    view.rowCount === 4 && view.firstIsRank1 && view.firstFillPct === "100%");
  check("categories are shown by NAME, not raw id",
    /السيرة النبوية|جغرافيا|تاريخ/.test(view.cats) && !/seerah|geo/.test(view.cats));
  check("community section ranks top-voted categories",
    /فئة المجتمع الأولى/.test(view.community) && /٩|9/.test(view.community));
  check("content health shows question total, unplayed, no-cover and pending counts",
    /سؤالاً منشوراً/.test(view.health) && /لم تُلعب/.test(view.health)
    && /بلا غلاف/.test(view.health) && /بانتظار المراجعة/.test(view.health) && /١(?![٠-٩])|(?<![0-9])1(?![0-9])/.test(view.health));
  check("audience splits new vs returning players with a return rate",
    /لاعباً مميزاً/.test(view.audience) && /لاعباً عائداً/.test(view.audience)
    && /نسبة العودة/.test(view.audience) && /٥٠|50/.test(view.audience)
    && /لاعب جديد هذا الأسبوع/.test(view.audience));
  check("sales section totals revenue, sale count and games sold",
    /إجمالي الإيرادات/.test(view.sales) && /5\.900|٥٫٩٠٠/.test(view.sales)
    && /3|٣/.test(view.sales) && /22|٢٢/.test(view.sales) && /متوسط قيمة البيع/.test(view.sales));
  check("every purchase is listed as a row with its OWN timestamp (🕒 + relative)",
    view.salesRows === 3 && /🕒/.test(view.salesList)
    && /الآن/.test(view.salesList)                      // the just-now sale
    && /buyer1@x\.com/.test(view.salesList) && /باقة لعبتين/.test(view.salesList));
  check("the sales section has its own refresh button", view.hasSalesRefresh);
  check("the stats header stamps when the data was last refreshed", /آخر تحديث/.test(view.updatedAt));

  // ---- 3a-2) «تصفير» resets the play counters behind a DOUBLE confirm ----
  const reset = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const calls = [];
    window.IZZBAH.resetStats = () => { calls.push(1); return Promise.resolve(true); };
    const btn = document.getElementById("statsReset");
    if (!btn) return { hasBtn: false };
    const origConfirm = window.confirm;
    const asked = [];
    // decline the FIRST confirm → nothing happens
    window.confirm = m => { asked.push(m); return false; };
    btn.click(); await sleep(80);
    const afterDecline = calls.length;
    // accept the first, decline the SECOND → still nothing
    let n = 0;
    window.confirm = m => { asked.push(m); return ++n === 1; };
    btn.click(); await sleep(80);
    const afterSecondDecline = calls.length;
    // accept both → the bridge runs
    window.confirm = m => { asked.push(m); return true; };
    btn.click(); await sleep(120);
    window.confirm = origConfirm;
    return { hasBtn: true, afterDecline, afterSecondDecline, calls: calls.length, asked };
  });
  check("the stats header has a «تصفير» reset button", reset.hasBtn);
  check("the reset confirm spells out what is erased AND what is kept",
    reset.asked.length >= 1 && /سيُمسح/.test(reset.asked[0]) && /لن يُمسح/.test(reset.asked[0])
    && /المبيعات/.test(reset.asked[0]) && /الأكواد/.test(reset.asked[0]));
  check("declining either confirm leaves the stats untouched",
    reset.afterDecline === 0 && reset.afterSecondDecline === 0);
  check("accepting both confirms wipes the play counters (bridge called once)", reset.calls === 1);

  // ---- 3a-3) the REVENUE counter has its OWN reset, fully independent ----
  const salesReset = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const statsCalls = [], salesCalls = [];
    window.IZZBAH.resetStats = () => { statsCalls.push(1); return Promise.resolve(true); };
    window.IZZBAH.resetSales = () => { salesCalls.push(1); return Promise.resolve(3); };
    const btn = document.getElementById("salesReset");
    if (!btn) return { hasBtn: false };
    const origConfirm = window.confirm;
    const asked = [];
    window.confirm = m => { asked.push(m); return false; };   // decline → no-op
    btn.click(); await sleep(80);
    const afterDecline = salesCalls.length;
    window.confirm = m => { asked.push(m); return true; };    // accept both
    btn.click(); await sleep(120);
    window.confirm = origConfirm;
    const warns = [...document.querySelectorAll("#statsModal .reset-warn")].map(w => w.textContent);
    return { hasBtn: true, afterDecline, salesCalls: salesCalls.length,
             statsCalls: statsCalls.length, asked, warns };
  });
  check("the sales section has its OWN «تصفير» reset button", salesReset.hasBtn);
  check("the sales reset confirm scopes itself to revenue only (keeps play stats + orders)",
    salesReset.asked.length >= 1 && /المبيعات والإيرادات/.test(salesReset.asked[0])
    && /لن يُمسح/.test(salesReset.asked[0]) && /إحصائيات اللعب/.test(salesReset.asked[0])
    && /الطلبات المعلّقة/.test(salesReset.asked[0]));
  check("declining leaves the sales records untouched", salesReset.afterDecline === 0);
  check("accepting wipes ONLY sales — the play-stats reset is never called",
    salesReset.salesCalls === 1 && salesReset.statsCalls === 0);
  check("both resets carry an always-visible ⚠️ warning line (before any click)",
    salesReset.warns.length === 2 && salesReset.warns.every(w => /⚠️/.test(w) && /لا يمكن التراجع/.test(w))
    && /عدّادات اللعب/.test(salesReset.warns[0]) && /المبيعات والإيرادات/.test(salesReset.warns[1]));
  check("players section shows redeemers, granted vs consumed, and unused codes",
    /٢|2/.test(view.players) && /لاعباً فعّل/.test(view.players)
    && /١٥|15/.test(view.players) && /استُهلك ٨|استُهلك 8/.test(view.players)
    && /كوداً غير مستخدم/.test(view.players));
  check("play-style shows lifelines, no-answer rate and the free-vs-paid mix",
    /١٨|18/.test(view.play) && /أول حرف/.test(view.play)
    && /٢٥٪|25٪/.test(view.play) && /١٥ ث|15 ث/.test(view.play)
    && /رصيد ٢٥|رصيد 25/.test(view.play));

  // ---- 3b) the «لم تُلعب بعد» tile is pressable and reveals WHICH categories ----
  const reveal = await page.evaluate(async () => {
    const tile = document.querySelector('#statsHealth [data-reveal="never"]');
    if (!tile) return { hasTile: false };
    tile.click();
    await new Promise(r => setTimeout(r, 60));
    const box = document.getElementById("statsHealthReveal");
    const chips = [...box.querySelectorAll(".stats-reveal-chip")];
    return { hasTile: true, revealed: !box.hidden, chipCount: chips.length, firstName: chips[0] ? chips[0].textContent : "" };
  });
  check("the «لم تُلعب بعد» tile is pressable (data-reveal)", reveal.hasTile);
  check("pressing it reveals the never-played category names as chips", reveal.revealed && reveal.chipCount > 0);

  // pressing a category chip opens it in the CMS editor and closes the stats modal
  const jumped = await page.evaluate(async () => {
    const chip = document.querySelector("#statsHealthReveal .stats-reveal-chip");
    const name = chip.textContent;
    chip.click();
    await new Promise(r => setTimeout(r, 100));
    return {
      modalClosed: !document.getElementById("statsModal").classList.contains("open"),
      loadedName: state.adminCat ? state.adminCat.name : "",
      name,
    };
  });
  check("pressing a chip opens that category in the CMS and closes the stats modal",
    jumped.modalClosed && jumped.loadedName === jumped.name);

  // ---- 4) empty stats render friendly placeholders, not a broken board ----
  const empty = await page.evaluate(async () => {
    window.IZZBAH.loadStats = () => Promise.resolve({});
    window.IZZBAH.listCodes = () => Promise.resolve([]);
    window.IZZBAH.listUsage = () => Promise.resolve({});
    window.IZZBAH.listSales = () => Promise.resolve([]);
    window.IZZBAH.listPlayerStats = () => Promise.resolve([]);
    state.communityCategories = [];
    document.getElementById("statsRefresh").click();
    await new Promise(r => setTimeout(r, 200));
    return {
      cats: document.getElementById("statsCats").textContent,
      tiles: document.getElementById("statsTiles").textContent,
      community: document.getElementById("statsCommunity").textContent,
    };
  });
  check("no data yet shows friendly placeholders + zero counts",
    /لا توجد بيانات/.test(empty.cats) && /٠|0/.test(empty.tiles) && /لا توجد فئات مجتمع/.test(empty.community));

  // ---- 5) without the cloud bridge (signed out) it explains, not crashes ----
  const noBridge = await page.evaluate(async () => {
    delete window.IZZBAH.loadStats;
    document.getElementById("statsRefresh").click();
    await new Promise(r => setTimeout(r, 120));
    return document.getElementById("statsStatus").textContent;
  });
  check("without an admin bridge, the panel explains instead of failing", /مشرف/.test(noBridge));

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
