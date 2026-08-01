// Lazy question media — the fix for the repeated Safari crash.
//
// The game used to read every category's /questions subcollection at boot, and
// those docs carry the base64 question/answer images. At the real catalogue
// size (39 categories / 4405 questions) that measured 541 MB of JS heap — far
// past what iOS Safari grants a tab, so WebKit killed the page and killed it
// again on reload: "A problem repeatedly occurred".
//
// Now boot holds the parent doc's TEXT-ONLY copy (5 MB) and the pictures for a
// game's categories are fetched just before the board is drawn (~94 MB peak
// with six categories loaded). Media is merged into the question objects IN
// PLACE, which is why nothing downstream of q.image / q.answerImage changed.
//
// The failure mode this must never regress into is the old "no pictures" bug:
// a failed media read being treated as "this category has none", cached, and
// frozen that way. loadCategoryMedia returns null (unknown) on error and caches
// nothing; the checks below pin the client half of that contract.
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
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
await page.route("**/firebasejs/**", route => route.abort());
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));

// Seed a catalogue in the shape boot now produces: text-only questions, and a
// __lite flag saying "pictures still to fetch".
const seed = (n = 8) => page.evaluate((n) => {
  const cats = [];
  for (let c = 0; c < n; c++) {
    const qs = [];
    for (let q = 0; q < 5; q++) {
      qs.push({ points: (q + 1) * 100, q: "سؤال " + c + "/" + q, a: "إجابة " + c + "/" + q,
                image: "", answerImage: "" });
    }
    cats.push({ id: "cat" + c, name: "فئة " + c, image: "", color: "#8b1c1f",
                questions: qs, __lite: true, updatedAtMs: 1000 + c });
  }
  window.IZZBAH.applyPublished(cats);
}, n);

// Replace the cloud call with a spy; `mode` picks what the fake cloud does.
const installSpy = (mode) => page.evaluate((mode) => {
  window.__calls = [];
  window.IZZBAH.hydrateCategoryMedia = (ids) => {
    window.__calls.push(ids.slice());
    if (mode === "fail") return Promise.reject(new Error("network"));
    if (mode === "missing") return Promise.resolve(new Map());   // read failed = absent
    const m = new Map();
    ids.forEach(id => {
      // only the middle question carries pictures, so index alignment matters
      const qs = [];
      for (let q = 0; q < 5; q++) {
        qs.push(q === 2 ? { image: "data:image/jpeg;base64,IMG" + id, answerImage: "data:image/jpeg;base64,ANS" + id }
                        : { image: "", answerImage: "" });
      }
      m.set(id, qs);
    });
    return Promise.resolve(m);
  };
}, mode);

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH && window.IZZBAH.applyPublished, { timeout: 15000 });
  await page.waitForTimeout(300);

  // ---- 1) boot carries no question media at all ----
  await seed();
  const boot = await page.evaluate(() => ({
    cats: state.publishedCategories.length,
    withMedia: state.publishedCategories.reduce((n, c) =>
      n + c.questions.filter(q => q.image || q.answerImage).length, 0),
    lite: state.publishedCategories.every(c => c.__lite === true),
    keptVer: state.publishedCategories.every(c => c.updatedAtMs > 0),
  }));
  check("boot holds every category", boot.cats === 8);
  check("boot holds ZERO question images — the whole point", boot.withMedia === 0);
  check("__lite survives normalization (else hydration never fires)", boot.lite);
  check("the publish version survives too (keys the media cache)", boot.keptVer);

  // ---- 2) starting a game fetches ONLY that game's categories ----
  await installSpy("ok");
  const played = await page.evaluate(async () => {
    state.selected = new Set(["cat1", "cat3"]);
    await ensureBoardMedia();
    const c1 = state.publishedCategories.find(c => c.id === "cat1");
    const c7 = state.publishedCategories.find(c => c.id === "cat4");
    return {
      calls: window.__calls,
      c1img: c1.questions.map(q => q.image ? 1 : 0).join(""),
      c1ans: c1.questions[2].answerImage,
      c7withMedia: c7.questions.filter(q => q.image || q.answerImage).length, // cat4
    };
  });
  check("exactly the selected categories are fetched", played.calls.length === 1
    && played.calls[0].length === 2
    && played.calls[0].includes("cat1") && played.calls[0].includes("cat3"));
  check("pictures land on the RIGHT question (index alignment)", played.c1img === "00100");
  check("answer images land too", played.c1ans === "data:image/jpeg;base64,ANScat1");
  check("categories nobody played stay text-only", played.c7withMedia === 0);

  // ---- 3) a second game does not re-fetch what is already loaded ----
  const again = await page.evaluate(async () => {
    window.__calls = [];
    state.selected = new Set(["cat1", "cat3"]);
    await ensureBoardMedia();
    return window.__calls.length;
  });
  check("replaying the same categories costs no further reads", again === 0);

  const mixed = await page.evaluate(async () => {
    window.__calls = [];
    state.selected = new Set(["cat1", "cat5"]);
    await ensureBoardMedia();
    return window.__calls[0] || [];
  });
  check("a new category is fetched, an already-loaded one is not",
    mixed.length === 1 && mixed[0] === "cat5");

  // ---- 4) a failed read must NOT be remembered as "has no pictures" ----
  // This is the old "no pictures" bug: once a category is marked done, the
  // images never come back. A failure has to leave it retryable.
  // A fresh category per mode: once a category hydrates successfully it is
  // (correctly) never re-fetched, so reusing one would mask the retry.
  for (const [mode, cat] of [["fail", "cat6"], ["missing", "cat7"]]) {
    await installSpy(mode);
    const res = await page.evaluate(async (cat) => {
      state.selected = new Set([cat]);
      window.__calls = [];
      await ensureBoardMedia();          // first attempt: fails / returns nothing
      const first = window.__calls.length;
      window.__calls = [];
      await ensureBoardMedia();          // must try again, not give up
      return { first, second: window.__calls.length };
    }, cat);
    check(`a "${mode}" media read is retried on the next game, not cached as none`,
      res.first === 1 && res.second === 1);
  }
  check("a failed hydration raises no uncaught error", errs.length === 0);

  // ---- 5) the board still opens, and the veil does not stay up ----
  await installSpy("ok");
  const board = await page.evaluate(async () => {
    state.selected = new Set(["cat2"]);
    state.teamCount = 2;
    state.teams = [{ name: "أ", score: 0 }, { name: "ب", score: 0 }];
    await enterBoard();
    await new Promise(r => setTimeout(r, 250));
    return {
      screen: document.body.dataset.screen,
      veil: !document.getElementById("bootVeil").hidden,
      cells: document.querySelectorAll("#board .board-category-card").length,
    };
  });
  check("entering the board lands on the game screen", board.screen === "game");
  check("the hydration veil is taken down afterwards", !board.veil);
  check("the board actually renders its categories", board.cells >= 1);

  check("no page errors overall", errs.length === 0);
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
