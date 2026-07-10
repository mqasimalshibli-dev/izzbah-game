// E2E for the admin "fetch missing answer photos" tool. It looks up each
// answer on Wikipedia (Arabic first, English fallback), stores the page image
// on `answerImage` as a downscaled data URL, is undoable, and skips questions
// that already have an image / have no answer. Network is fully STUBBED — the
// test must never touch the real Wikipedia.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8324;
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

// Install the Wikimedia network stub only over the game's OWN fetch (not
// firebase, which is route-aborted). We do this AFTER boot so it can't disturb
// startup — the tool only fetches when the admin clicks the button.
const installFetchStub = () => page.evaluate(() => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const real = window.fetch.bind(window);
  window.__fetchLog = [];
  window.fetch = function (url, opts) {
    const u = String(url);
    if (u.includes("wikipedia.org") || u.includes("wikimedia.org")) {
      window.__fetchLog.push(u);
      if (u.includes("/w/api.php")) {
        const noHit = decodeURIComponent(u).includes("لا_يوجد");
        const body = noHit
          ? { query: { pages: {} } }
          : { query: { pages: { "1": { index: 1, thumbnail: { source: "https://upload.wikimedia.org/fake.jpg" } } } } };
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
      }
      const bytes = Uint8Array.from(atob(PNG), c => c.charCodeAt(0));
      return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob([bytes], { type: "image/png" })) });
    }
    return real(url, opts);
  };
});

const waitDone = async () => {
  // fetchMissingImages is async & not awaited by the click; poll the button.
  for (let i = 0; i < 40; i++) {
    const busy = await page.evaluate(() => document.getElementById("adminFetchImages").disabled);
    if (!busy) return;
    await page.waitForTimeout(100);
  }
};

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ---- 0) CSP whitelists Wikimedia (else the browser blocks the fetch) ----
  const csp = await page.evaluate(() =>
    document.querySelector('meta[http-equiv="Content-Security-Policy"]').getAttribute("content"));
  check("CSP connect-src allows Wikipedia + Wikimedia",
    /connect-src[^;]*wikipedia\.org/.test(csp) && /connect-src[^;]*wikimedia\.org/.test(csp));

  // ---- predicate unit checks ----
  const pred = await page.evaluate(() => ({
    needsWhenNoImage: questionNeedsImage({ a: "مسقط", answerImage: "" }),
    skipWhenHasImage: !questionNeedsImage({ a: "مسقط", answerImage: "data:image/jpeg;base64,x" }),
    skipWhenNoAnswer: !questionNeedsImage({ a: "", answerImage: "" }),
  }));
  check("questionNeedsImage: true when it has an answer and no image", pred.needsWhenNoImage);
  check("questionNeedsImage: false when an answer image already exists", pred.skipWhenHasImage);
  check("questionNeedsImage: false when there is no answer to search", pred.skipWhenNoAnswer);

  // enter the admin CMS
  await page.evaluate(() => { window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true); });
  await page.evaluate(() => { document.getElementById("adminEntry").click(); });
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById("adminChoiceContent").click());
  await page.waitForTimeout(400);
  await installFetchStub();

  // ---- 1) bulk fetch fills only the questions that need it ----
  await page.evaluate(() => {
    window.IZZBAH.cloudPublish = () => Promise.resolve();
    window.__fetchLog = [];
    state.adminCat = { id: "pub-img", name: "صور", image: "", color: "#9e1322", custom: false, published: true, order: 0,
      questions: [
        { points: 100, q: "ما عاصمة عُمان؟", a: "مسقط", image: "", answerImage: "" },
        { points: 200, q: "ما عاصمة مصر؟", a: "القاهرة", image: "", answerImage: "" },
        { points: 300, q: "سؤال بلا جواب؟", a: "", image: "", answerImage: "" },
        { points: 400, q: "سؤال له صورة؟", a: "جواب", image: "", answerImage: "data:image/jpeg;base64,keepme" },
        { points: 500, q: "غير موجود؟", a: "لا_يوجد", image: "", answerImage: "" },
      ] };
    clearAdminUndo(); populateAdminFilter(); renderAdminTable(); renderAdminCatHead();
    fetchMissingImages(); // confirm auto-accepted by the dialog handler
  });
  await waitDone();
  const res = await page.evaluate(() => {
    const q = state.adminCat.questions;
    return {
      q0: q[0].answerImage.slice(0, 11), q1: q[1].answerImage.slice(0, 11),
      q2: q[2].answerImage, q3: q[3].answerImage, q4: q[4].answerImage,
      canUndo: !document.getElementById("adminUndo").disabled,
      log: window.__fetchLog,
    };
  });
  check("fetches an answer photo for a question that lacks one (q0)", res.q0 === "data:image/");
  check("fetches for a second question too (q1)", res.q1 === "data:image/");
  check("skips a question with no answer to search (q2 untouched)", res.q2 === "");
  check("never overwrites an existing answer image (q3 kept)", res.q3 === "data:image/jpeg;base64,keepme");
  check("leaves a question with no Wikipedia hit empty (q4)", res.q4 === "");
  check("the fetch step is a single undoable operation", res.canUndo);

  // ---- 2) Arabic answers query Arabic Wikipedia FIRST ----
  const firstApi = res.log.find(u => u.includes("/w/api.php"));
  check("Arabic answers hit ar.wikipedia.org first", !!firstApi && firstApi.includes("//ar.wikipedia.org"));

  // ---- 3) undo restores the pre-fetch state ----
  const undo = await page.evaluate(async () => {
    undoAdminStep();
    await new Promise(r => setTimeout(r, 150));
    return { q0: state.adminCat.questions[0].answerImage, q1: state.adminCat.questions[1].answerImage };
  });
  check("undo removes the fetched photos", undo.q0 === "" && undo.q1 === "");

  // ---- 4) when nothing needs an image, it says so and fetches nothing ----
  const none = await page.evaluate(async () => {
    window.__fetchLog = [];
    let toast = "";
    const o = window.showToast; window.showToast = m => { toast = m; if (o) o(m); };
    state.adminCat = { id: "pub-full", name: "مكتملة", image: "", color: "", custom: false, published: true, order: 0,
      questions: [{ points: 100, q: "س", a: "ج", image: "", answerImage: "data:image/jpeg;base64,x" }] };
    clearAdminUndo(); renderAdminTable();
    fetchMissingImages();
    await new Promise(r => setTimeout(r, 200));
    window.showToast = o;
    return { toast, calls: window.__fetchLog.length };
  });
  check("does nothing (no network) when every answer already has a photo",
    none.calls === 0 && /بالفعل/.test(none.toast));

  // ---- 5) special-media (word / reaction) categories are left alone ----
  const word = await page.evaluate(async () => {
    window.__fetchLog = [];
    let toast = "";
    const o = window.showToast; window.showToast = m => { toast = m; if (o) o(m); };
    state.adminCat = { id: "charadesArabic", name: "وش الكلمة عربي", image: "", color: "", custom: false, published: true, order: 0,
      questions: [{ points: 100, q: "", a: "كلمة", image: "", answerImage: "" }] };
    clearAdminUndo(); renderAdminTable();
    fetchMissingImages();
    await new Promise(r => setTimeout(r, 200));
    window.showToast = o;
    return { toast, calls: window.__fetchLog.length };
  });
  check("word/reaction categories are skipped (no fetch, special media)",
    word.calls === 0 && /خاصة/.test(word.toast));

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
