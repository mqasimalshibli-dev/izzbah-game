// The option scan has to look the same on every device the admin signs in on.
//
// Two halves of state used to live only in localStorage:
//   • the classifier's VERDICTS (term → kind), which decide what the report
//     says, and
//   • the admin's DECISIONS — which findings are fixed or skipped — which
//     decide what the report still shows.
// So a scan run on the laptop meant the phone re-asked Wikipedia about all
// 7,454 terms and then listed the findings the admin had already dealt with.
//
// What is NOT synced is deliberate: the raw Wikipedia extracts are ~1.5 MB at
// the live catalogue size, past Firestore's 1 MiB document limit. The verdicts
// derived from them are ~250 KB and are the only part the report reads.
//
// This test runs TWO browser contexts against one shared fake of the cloud doc
// — separate localStorage, same account — which is the actual situation being
// fixed. It is offline: Firebase is aborted and window.IZZBAH.loadDistScan /
// saveDistScan are replaced with an in-memory pair, so what is under test is
// the merge logic rather than Firestore.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8506;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

// The shared cloud document, held here in the harness so both pages see the
// same one — exactly the role config/distScan plays for the real admin.
let CLOUD = null;

const CATS = [{
  id: "pub-sync", name: "تاريخ", image: "", order: 1, questions: [
    { points: 100, q: "س١؟", a: "معاهدة فرساي", image: "", answerImage: "",
      distractors: ["مؤتمر فيينا", "صلح وستفاليا", "معاهدة باريس"] },
    { points: 200, q: "س٢؟", a: "بروك ليسنر", image: "", answerImage: "",
      distractors: ["سماكداون", "كيفن أوينز", "رومان رينز"] },
    { points: 300, q: "س٣؟", a: "صلاح الدين الأيوبي", image: "", answerImage: "",
      distractors: ["قلعة نزوى", "هارون الرشيد", "عمر بن الخطاب"] },
  ],
}];
const DESC = {
  "معاهدة فرساي": "معاهدة فرساي هي معاهدة سلام أنهت الحرب العالمية الأولى.",
  "مؤتمر فيينا": "مؤتمر فيينا هو مؤتمر لسفراء الدول الأوروبية.",
  "صلح وستفاليا": "صلح وستفاليا معاهدة سلام أنهت حرب الثلاثين عاماً.",
  "معاهدة باريس": "معاهدة باريس معاهدة وقعت في باريس.",
  "بروك ليسنر": "بروك إدوارد ليسنر مصارع محترف أمريكي.",
  "سماكداون": "سماكداون هو برنامج تلفزيوني للمصارعة المحترفة.",
  "كيفن أوينز": "كيفن ستين مصارع محترف كندي.",
  "رومان رينز": "ليتي جوزيف أنواي مصارع محترف أمريكي.",
  "صلاح الدين الأيوبي": "صلاح الدين يوسف بن أيوب أول سلاطين الدولة الأيوبية.",
  "قلعة نزوى": "قلعة نزوى حصن تاريخي في ولاية نزوى.",
  "هارون الرشيد": "هارون الرشيد خامس خلفاء الدولة العباسية.",
  "عمر بن الخطاب": "عمر بن الخطاب ثاني الخلفاء الراشدين وأحد الصحابة.",
};

// A fresh browser context = a different device: its own localStorage, the same
// signed-in admin, and the same shared cloud doc.
async function device(label) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 950 } });
  const page = await ctx.newPage();
  await page.route("**/firebasejs/**", r => r.abort());
  page.on("pageerror", e => errs.push(`${label}: ${e.message}`));
  page.on("dialog", d => d.accept().catch(() => {}));
  await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1400);

  // Bridge the page's cloud calls to the harness-held document.
  await page.exposeFunction("__cloudGet", () => CLOUD);
  await page.exposeFunction("__cloudSet", (map) => { CLOUD = map; return true; });
  await page.evaluate(([cats, desc]) => {
    window.IZZBAH.applyAuth(true, "admin-uid");
    window.IZZBAH.applyAdmin(true);
    window.IZZBAH.applyPublished(cats);
    state.communityCategories = []; state.noChoiceCategories = [];
    window.IZZBAH.loadDistScan = () => window.__cloudGet().then(m => m || {});
    window.IZZBAH.saveDistScan = (kinds, done, version) => window.__cloudSet({
      v: String(version), kinds: JSON.stringify(kinds), done: JSON.stringify(done),
      at: String(1700000000000),
    }).then(() => ({ dropped: 0, bytes: 0 }));
    // Wikipedia, stubbed: this test is about what crosses between devices.
    window.wikiApi = (lang, params) => {
      const pages = {};
      String(params.titles).split("|").forEach((t, i) => {
        if (lang === "ar" && desc[t]) pages[i] = { title: t, extract: desc[t] };
      });
      return Promise.resolve({ query: { pages } });
    };
  }, [cats0(), DESC]);
  return { ctx, page };
}
function cats0() { return CATS; }

const scanned = (page) => page.evaluate(async () => {
  openDistModal();
  await new Promise(r => setTimeout(r, 120));
  distRunSmart();
  for (let i = 0; i < 60 && distSmartBusy; i++) await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 300));
  return {
    findings: distSmart.findings.length,
    which: distSmart.findings.map(f => f.option).sort(),
    kinds: Object.keys(distKinds()).length,
  };
});

try {
  // ---- device A: run the scan ----
  const A = await device("A");
  const a1 = await scanned(A.page);
  check(`device A scans and finds something (${a1.findings}: ${a1.which.join("، ")})`,
    a1.findings > 0);
  check(`…and records a verdict for every term it touched (${a1.kinds})`, a1.kinds >= 12);
  check("…and publishes them to the shared document", !!CLOUD && !!CLOUD.kinds);

  // ---- device B: never scanned, no Wikipedia at all ----
  const B = await device("B");
  const bFresh = await B.page.evaluate(() => ({
    kinds: Object.keys(distKinds()).length,
    done: Object.keys(distDone()).length,
  }));
  check("device B starts empty, as a second device does", bFresh.kinds === 0);

  const b1 = await B.page.evaluate(async () => {
    let calls = 0;
    const real = window.wikiApi;
    window.wikiApi = (...a) => { calls++; return real(...a); };
    openDistModal();
    await new Promise(r => setTimeout(r, 700));
    return {
      calls, ran: distSmart.ran,
      findings: distSmart.findings.length,
      which: distSmart.findings.map(f => f.option).sort(),
      remaining: distScanRemaining(),
      notice: (document.getElementById("appNotice") || {}).textContent || "",
    };
  });
  check(`device B shows the report without being asked to scan (${b1.findings})`,
    b1.ran === true && b1.findings > 0);
  check(`…identical to device A's (${b1.which.join("، ")})`,
    JSON.stringify(b1.which) === JSON.stringify(a1.which));
  check(`…having made ZERO Wikipedia requests (${b1.calls})`, b1.calls === 0);
  check(`…and with nothing left to fetch (${b1.remaining} remaining)`, b1.remaining === 0);
  check(`…and it says where the results came from ("${b1.notice.slice(0, 30)}…")`,
    /جهازك الآخر/.test(b1.notice));

  // ---- a decision on B must hold on A ----
  const bSkip = await B.page.evaluate(async () => {
    const before = distSmart.findings.length;
    distSkipFinding(distSmart.findings[0]);
    await new Promise(r => setTimeout(r, 1900));   // the push is debounced 1.5s
    return { before, after: distSmart.findings.length, done: Object.keys(distDone()).length };
  });
  check(`skipping on device B removes it there (${bSkip.before} → ${bSkip.after})`,
    bSkip.after === bSkip.before - 1);
  check("…and the decision reaches the shared document",
    !!CLOUD && Object.keys(JSON.parse(CLOUD.done || "{}")).length === 1);

  // A is a fresh session again (the admin comes back to the laptop next day).
  const A2 = await device("A2");
  const a2 = await A2.page.evaluate(async () => {
    openDistModal();
    await new Promise(r => setTimeout(r, 700));
    return { findings: distSmart.findings.length, done: Object.keys(distDone()).length };
  });
  check(`the laptop no longer lists what the phone skipped (${a2.findings} vs ${a1.findings})`,
    a2.findings === a1.findings - 1);
  check(`…because the decision travelled with it (${a2.done} recorded)`, a2.done === 1);

  // ---- «إظهار المخفية» has to clear BOTH sides ----
  await A2.page.evaluate(async () => { distClearDone(); await new Promise(r => setTimeout(r, 250)); });
  check("clearing hidden findings empties the shared document too",
    Object.keys(JSON.parse((CLOUD || {}).done || "{}")).length === 0);
  const C = await device("C");
  const c1 = await C.page.evaluate(async () => {
    openDistModal();
    await new Promise(r => setTimeout(r, 700));
    return { findings: distSmart.findings.length };
  });
  check(`…so a third device sees the full list again (${c1.findings})`, c1.findings === a1.findings);

  // ---- a classifier change must invalidate the verdicts, not pin them ----
  // Cached verdicts written under an older classifier would reinstate exactly
  // the misreadings each fix removed, so they are dropped on version change.
  const stale = await C.page.evaluate(async () => {
    const cur = JSON.parse(localStorage.getItem("izzbah-distkinds-v1") || "{}");
    localStorage.setItem("izzbah-distkinds-v1",
      JSON.stringify({ v: cur.v - 1, m: { "مؤتمر فيينا": "مكان" } }));
    location.reload();
    return true;
  });
  await C.page.waitForTimeout(1600);
  const afterReload = await C.page.evaluate(() => ({
    kept: Object.keys(distKinds()).length,
    vienna: distKinds()["مؤتمر فيينا"],
  }));
  check(`a verdict cached under an older classifier is discarded (${afterReload.kept} kept)`,
    stale && afterReload.kept === 0 && afterReload.vienna === undefined);

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
