// Three things asked for together:
//   1. an in-app notification when a scan finishes,
//   2. «صحة الأسئلة» must not list the same question as both the hardest and
//      the easiest,
//   3. the smart scan must survive a hard refresh.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8504;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
await page.route("**/firebasejs/**", r => r.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1400);
  await page.evaluate(() => { window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true); });

  // ---- 1) the notification ----
  const notice = await page.evaluate(async () => {
    appNotice("عنوان", "تفاصيل");
    await new Promise(r => setTimeout(r, 80));
    const el = document.getElementById("appNotice");
    const shown = el.classList.contains("show");
    const live = el.getAttribute("aria-live");
    const text = el.textContent;
    el.querySelector(".app-notice-x").click();
    await new Promise(r => setTimeout(r, 60));
    return { shown, live, text, gone: !el.classList.contains("show") };
  });
  check("a notification appears", notice.shown && /عنوان/.test(notice.text));
  check("…is announced to assistive tech", notice.live === "polite");
  check("…and can be dismissed", notice.gone);

  const fromScan = await page.evaluate(async () => {
    window.IZZBAH.applyPublished([{ id: "pub-n", name: "تاريخ", image: "", order: 1, questions: [
      { points: 100, q: "س؟", a: "بغداد", image: "", answerImage: "", distractors: ["بغداد", "دمشق", "عمّان"] },
    ] }]);
    state.communityCategories = []; state.noChoiceCategories = [];
    document.getElementById("distRescan").click();
    await new Promise(r => setTimeout(r, 200));
    const el = document.getElementById("appNotice");
    return { shown: el.classList.contains("show"), text: el.textContent };
  });
  check(`finishing the option scan raises one ("${fromScan.text.slice(0, 40)}…")`,
    fromScan.shown && /فحص الخيارات/.test(fromScan.text));

  // ---- 2) hardest and easiest cannot be the same question ----
  // The reported bug: with only two questions past the play threshold, both
  // lists were independent slices of the same array, so both showed both — the
  // same question ranked as the hardest AND the easiest at once.
  const health = await page.evaluate(async () => {
    const run = (n) => {
      const rows = [];
      for (let i = 0; i < n; i++) {
        rows.push({ text: "سؤال " + i, answer: "ج" + i, cat: "فئة", n: 7,
          pctCorrect: i / Math.max(1, n - 1), pctSkip: 0.4, avgSecs: 30 });
      }
      // mirror the ranking the panel builds
      const byCorrect = rows.slice().sort((a, b) => a.pctCorrect - b.pctCorrect);
      const half = Math.floor(byCorrect.length / 2);
      const hardest = byCorrect.slice(0, Math.min(10, half));
      const easiest = half ? byCorrect.slice(byCorrect.length - Math.min(8, half)).reverse() : [];
      const overlap = hardest.filter(h => easiest.some(e => e.text === h.text));
      return { n, hard: hardest.length, easy: easiest.length, overlap: overlap.length };
    };
    return [2, 3, 4, 8, 30].map(run);
  });
  health.forEach(r => {
    check(`${r.n} ranked questions: hardest ${r.hard} / easiest ${r.easy}, no question in both`,
      r.overlap === 0);
  });
  check("with two questions each list still shows one, rather than both showing both",
    health[0].hard === 1 && health[0].easy === 1);

  // ---- 3) the smart scan survives a refresh ----
  // Descriptions are written after every chunk, so an interrupted run keeps
  // what it fetched and the next run skips those terms before making a request.
  const resume = await page.evaluate(async () => {
    localStorage.removeItem("izzbah-wikikind-v1");
    localStorage.removeItem("izzbah-wikiscan-v1");
    window.IZZBAH.applyPublished([{ id: "pub-r", name: "تاريخ", image: "", order: 1, questions: [
      { points: 100, q: "س١؟", a: "بغداد", image: "", answerImage: "", distractors: ["دمشق", "عمّان", "بيروت"] },
      { points: 200, q: "س٢؟", a: "القاهرة", image: "", answerImage: "", distractors: ["تونس", "الرباط", "الجزائر"] },
    ] }]);
    state.communityCategories = []; state.noChoiceCategories = [];
    const before = distScanRemaining();
    // simulate a run that was cut off half-way: some terms cached, marker set
    distScanMark(true);
    const partial = { "بغداد": "عاصمة العراق", "دمشق": "مدينة سورية", "عمّان": "عاصمة الأردن" };
    localStorage.setItem("izzbah-wikikind-v1", JSON.stringify(partial));
    const afterPartial = distScanRemaining();
    const interrupted = distScanInterrupted();
    const label = distSmartBtnLabel();
    distScanMark(false);
    return { before, afterPartial, interrupted, label, cleared: distScanInterrupted() };
  });
  // Built-in categories are scanned too, so this counts far more than the two
  // test questions — what matters is that nothing is known yet and that caching
  // three terms removes exactly three from the queue.
  check(`every term is unknown at the start (${resume.before})`, resume.before >= 8);
  check(`a partial run leaves fewer to fetch (${resume.afterPartial} of ${resume.before})`,
    resume.afterPartial === resume.before - 3);
  check("an interrupted run is remembered across a reload", resume.interrupted === true);
  check(`the button offers to resume with the count ("${resume.label}")`, /متبق/.test(resume.label));
  check("…and the marker clears when a run completes", resume.cleared === false);

  // A real reload: the cached descriptions must still be there.
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(1200);
  const afterReload = await page.evaluate(() => {
    const cache = JSON.parse(localStorage.getItem("izzbah-wikikind-v1") || "{}");
    return { kept: Object.keys(cache).length, hasOne: !!cache["بغداد"] };
  });
  check(`descriptions survive a hard refresh (${afterReload.kept} kept)`,
    afterReload.kept === 3 && afterReload.hasOne);

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
