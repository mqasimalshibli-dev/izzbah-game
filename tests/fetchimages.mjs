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
        const dec = decodeURIComponent(u);
        // no result for the "not found" answer; and for جواب_خاص every
        // answer-only tier misses — ONLY the contextual query (carrying the
        // question keyword الغامض) hits, so the deep fallback must rescue it
        const noHit = dec.includes("لا_يوجد")
          || (dec.includes("جواب_خاص") && !dec.includes("الغامض"));
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

  // ---- question understanding: keyword extraction unit checks ----
  const kw = await page.evaluate(() => ({
    director: questionKeywords("من مخرج فيلم Inception؟", "نولان"),
    stopOnly: questionKeywords("ما هو من في؟", "جواب"),
    noAnswerEcho: questionKeywords("أين تقع مدينة مسقط الجميلة؟", "مسقط"),
  }));
  check("keywords carry the question's context (مخرج, فيلم, Inception)",
    kw.director.includes("مخرج") && kw.director.includes("فيلم") && kw.director.includes("Inception")
    && !kw.director.includes("من"));
  check("a question of pure stopwords yields no keywords", kw.stopOnly.length === 0);
  check("words already in the answer are not repeated in the keywords",
    !kw.noAnswerEcho.some(w => w.includes("مسقط")));

  // enter the admin CMS
  await page.evaluate(() => { window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true); });
  await page.evaluate(() => { document.getElementById("adminEntry").click(); });
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById("adminChoiceContent").click());
  await page.waitForTimeout(400);
  await installFetchStub();

  // a bare numeric answer with no question context is never searched (a search
  // for "1975" alone lands on an arbitrary year page)
  const numericGuard = await page.evaluate(async () => {
    window.__fetchLog = [];
    const url = await findAnswerImageUrl({ q: "", a: "1975" });
    return { url, calls: window.__fetchLog.length };
  });
  check("numeric answers are never searched without question context",
    numericGuard.url === "" && numericGuard.calls === 0);

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
        // tier-1 (answer + keywords) misses for this one — the stub rejects any
        // query carrying "الغامض" — so tier-2 (answer alone) must rescue it
        { points: 600, q: "سؤال الغامض تماماً؟", a: "جواب_خاص", image: "", answerImage: "" },
      ] };
    clearAdminUndo(); populateAdminFilter(); renderAdminTable(); renderAdminCatHead();
    fetchMissingImages(); // opens the options dialog
  });
  // ---- 0b) the options dialog appears BEFORE any generation ----
  const dialog = await page.evaluate(() => ({
    open: document.getElementById("fetchImagesModal").classList.contains("open"),
    bothOff: !document.getElementById("fetchImagesBoth").checked,
    count: document.getElementById("fetchImagesCount").textContent,
    calls: window.__fetchLog.length,
  }));
  check("an options dialog opens before generating (no network yet)", dialog.open && dialog.calls === 0);
  check("the question+answer option exists and defaults to OFF (answers only)", dialog.bothOff);
  check("the dialog shows how many answer photos will be fetched", /صورة إجابة/.test(dialog.count));
  await page.evaluate(() => document.getElementById("fetchImagesStart").click());
  await waitDone();
  const res = await page.evaluate(() => {
    const q = state.adminCat.questions;
    return {
      q0: q[0].answerImage.slice(0, 11), q1: q[1].answerImage.slice(0, 11),
      q2: q[2].answerImage, q3: q[3].answerImage, q4: q[4].answerImage,
      q5: q[5].answerImage.slice(0, 11),
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
  const noQImages = await page.evaluate(() => state.adminCat.questions.every(q => (q.image || "") === ""));
  check("answers-only mode never touches QUESTION images", noQImages);

  // ---- 2) ANSWER-FIRST deep search ----
  const apiQueries = res.log.filter(u => u.includes("/w/api.php")).map(u => decodeURIComponent(u));
  const firstMuscat = apiQueries.find(u => u.includes("مسقط"));
  check("the ANSWER is searched first: exact-title lookup, no question words",
    !!firstMuscat && firstMuscat.includes("titles=مسقط") && !firstMuscat.includes("عاصمة"));
  check("the deep contextual fallback rescues an answer the bare tiers miss",
    res.q5 === "data:image/" && apiQueries.some(u => u.includes("جواب_خاص") && u.includes("الغامض")));
  check("Arabic answers hit ar.wikipedia.org first",
    apiQueries.length > 0 && res.log.find(u => u.includes("/w/api.php")).includes("//ar.wikipedia.org"));

  // ---- 2b) accuracy: best-title scoring skips disambig pages + junk icons ----
  const accurate = await page.evaluate(() => {
    const cands = [
      { title: "مسقط (توضيح)", url: "https://upload.wikimedia.org/Disambig_gray.svg.png", disambig: true },
      { title: "مسقط رأس", url: "https://upload.wikimedia.org/other_topic.jpg", disambig: false },
      { title: "مسقط", url: "https://upload.wikimedia.org/real_muscat.jpg", disambig: false },
      { title: "صفحة", url: "https://upload.wikimedia.org/Commons-logo.svg.png", disambig: false },
    ];
    return {
      best: pickAccurateImage(cands, "مسقط", false),
      strictWeak: pickAccurateImage([{ title: "شيء آخر تماماً", url: "https://upload.wikimedia.org/x.jpg", disambig: false }], "مسقط", true),
      junkOnly: pickAccurateImage([{ title: "مسقط", url: "https://upload.wikimedia.org/Question_book.png", disambig: false }], "مسقط", false),
    };
  });
  check("the exact-title page beats higher-ranked partial matches", accurate.best === "https://upload.wikimedia.org/real_muscat.jpg");
  check("strict (title) tiers reject pages that merely mention the answer", accurate.strictWeak === "");
  check("generic wiki icons are never used as the answer photo", accurate.junkOnly === "");

  // ---- 2c) BOTH mode: activating the option fetches question pictures too ----
  await page.evaluate(() => {
    window.__fetchLog = [];
    fetchMissingImages();                                        // reopen the dialog
    document.getElementById("fetchImagesBoth").checked = true;   // activate question+answer
    document.getElementById("fetchImagesBoth").dispatchEvent(new Event("change", { bubbles: true }));
  });
  const bothCount = await page.evaluate(() => document.getElementById("fetchImagesCount").textContent);
  check("enabling the option adds question photos to the plan", /صورة سؤال/.test(bothCount));
  await page.evaluate(() => document.getElementById("fetchImagesStart").click());
  await waitDone();
  const both = await page.evaluate(() => ({
    q0img: state.adminCat.questions[0].image.slice(0, 11),
    q0ans: state.adminCat.questions[0].answerImage.slice(0, 11), // kept from the first run
    log: window.__fetchLog.filter(u => u.includes("/w/api.php")).map(u => decodeURIComponent(u)),
  }));
  check("both-mode fetches a QUESTION picture (q0.image filled)", both.q0img === "data:image/");
  check("both-mode never re-fetches answers that already have photos", both.q0ans === "data:image/");
  check("the question-picture search NEVER includes the answer (no spoilers)",
    both.log.some(u => u.includes("عاصمة")) && !both.log.some(u => u.includes("عاصمة") && u.includes("مسقط")));

  // ---- 3) undo restores the pre-fetch state ----
  const undo = await page.evaluate(async () => {
    undoAdminStep();      // undoes the both-mode run (question images)
    undoAdminStep();      // undoes the first answers-only run
    await new Promise(r => setTimeout(r, 150));
    return { q0: state.adminCat.questions[0].answerImage, q1: state.adminCat.questions[1].answerImage, q0img: state.adminCat.questions[0].image };
  });
  check("undo removes the fetched photos", undo.q0 === "" && undo.q1 === "" && undo.q0img === "");

  // ---- 4) when nothing needs an image, it says so and fetches nothing ----
  const none = await page.evaluate(async () => {
    window.__fetchLog = [];
    let toast = "";
    const o = window.showToast; window.showToast = m => { toast = m; if (o) o(m); };
    state.adminCat = { id: "pub-full", name: "مكتملة", image: "", color: "", custom: false, published: true, order: 0,
      questions: [{ points: 100, q: "س", a: "ج", image: "data:image/jpeg;base64,y", answerImage: "data:image/jpeg;base64,x" }] };
    clearAdminUndo(); renderAdminTable();
    fetchMissingImages();
    await new Promise(r => setTimeout(r, 200));
    window.showToast = o;
    return {
      toast, calls: window.__fetchLog.length,
      dialogOpen: document.getElementById("fetchImagesModal").classList.contains("open"),
    };
  });
  check("does nothing (no network, no dialog) when every photo already exists",
    none.calls === 0 && /بالفعل/.test(none.toast) && !none.dialogOpen);

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
