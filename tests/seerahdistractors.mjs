// E2E: the published «السيرة النبوية» category was saved with auto-generated
// distractors that cross-linked unrelated questions (a birthplace question got
// a mother/year/grandfather as its wrong options). A one-time admin-device fix
// restores each question's HAND-CURATED bank distractors and republishes.
// Also guards the four web-verified accuracy corrections to the bank itself.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8334;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ---- 0) the bank's accuracy corrections (web-verified) ----
  const bank = await page.evaluate(() => {
    const find = (needle) => {
      for (const pts of Object.keys(builtinQuestionBanks.seerah))
        for (const qa of builtinQuestionBanks.seerah[pts])
          if ((qa[0] || "").indexOf(needle) >= 0) return { a: qa[1], d: qa[2] };
      return null;
    };
    return {
      nurse: find("مرضعة"),
      tabuk: find("أمير المدينة عندما خرج"),
      boycott: find("كتب صحيفة المقاطعة"),
      mustaliq: find("غزوة بني المصطلق"),
    };
  });
  check("wet-nurse distractors drop ثويبة (a real wet-nurse of the Prophet)",
    bank.nurse && !bank.nurse.d.includes("ثويبة الأسلمية"));
  check("Tabuk-governor distractors drop علي (arguably the correct answer via hadith al-manzila)",
    bank.tabuk && !bank.tabuk.d.includes("علي بن أبي طالب"));
  check("boycott-scribe distractors drop النضر بن الحارث (a reported scribe)",
    bank.boycott && !bank.boycott.d.includes("النضر بن الحارث"));
  check("Banu al-Mustaliq year drops السادسة (Ibn Ishaq's competing view)",
    bank.mustaliq && !bank.mustaliq.d.includes("السنة السادسة للهجرة"));

  // ---- 1) build a corrupted published seerah + trigger the admin fix ----
  const built = await page.evaluate(() => {
    const junk = ["المسجد النبوي", "عثمان بن عفان", "عام الفيل"]; // wrong KIND on purpose
    const qs = [];
    Object.keys(builtinQuestionBanks.seerah).forEach(pts => builtinQuestionBanks.seerah[pts].forEach(qa => {
      qs.push({ points: +pts, q: qa[0], a: qa[1], distractors: junk.slice(), image: "", answerImage: "" });
    }));
    window.__pubCount = 0; window.__published = null;
    window.IZZBAH.cloudPublish = (c) => { window.__pubCount++; window.__published = JSON.parse(JSON.stringify(c)); return Promise.resolve(); };
    try { localStorage.removeItem("izzbah-datafix-seerah-dist-v1"); } catch (e) {}
    window.IZZBAH.applyAuth(true, "adm");
    window.IZZBAH.applyPublished([{ id: "seerah", name: "السيرة النبوية", image: "x.webp", order: 2, questions: qs }]);
    window.IZZBAH.applyAdmin(true);
    return qs.length;
  }, );
  await page.waitForTimeout(500);

  const fix = await page.evaluate(() => {
    const pub = window.__published;
    const q = pub && pub.questions;
    const birth = q && q.find(x => (x.q || "").indexOf("أين وُلد") >= 0);
    // does every published question now match the curated bank set?
    let allMatchBank = !!q;
    (q || []).forEach(x => {
      const want = bankDistractorsFor("seerah", x.q, x.a);
      if (want && JSON.stringify(want.slice(0, 3)) !== JSON.stringify(x.distractors)) allMatchBank = false;
    });
    // no question should still carry the junk placeholder set
    const stillJunk = (q || []).some(x => Array.isArray(x.distractors)
      && x.distractors.includes("المسجد النبوي") && x.distractors.includes("عثمان بن عفان"));
    return {
      count: window.__pubCount, id: pub && pub.id,
      birth: birth && birth.distractors,
      allMatchBank, stillJunk, marker: localStorage.getItem("izzbah-datafix-seerah-dist-v1"),
    };
  });
  check("the fix republishes the seerah category once", fix.count === 1 && fix.id === "seerah");
  check("the birthplace question now gets real PLACES (curated bank set)",
    Array.isArray(fix.birth) && fix.birth.includes("المدينة المنورة") && fix.birth.includes("الطائف") && fix.birth.includes("جدة"));
  check("every question now carries its curated bank distractors", fix.allMatchBank === true);
  check("no question is left with the cross-linked junk", fix.stillJunk === false);
  check("a success marker prevents re-running", fix.marker === "1");

  // ---- 2) re-applying must NOT republish again (marker set) ----
  const again = await page.evaluate(() => {
    const junk = ["المسجد النبوي", "عثمان بن عفان", "عام الفيل"];
    const qs = [];
    Object.keys(builtinQuestionBanks.seerah).forEach(pts => builtinQuestionBanks.seerah[pts].forEach(qa => {
      qs.push({ points: +pts, q: qa[0], a: qa[1], distractors: junk.slice() });
    }));
    window.IZZBAH.applyPublished([{ id: "seerah", name: "السيرة النبوية", questions: qs }]);
    window.IZZBAH.applyAdmin(true);
    return window.__pubCount;
  });
  check("the fix never runs twice", again === 1);

  // ---- 3) a non-admin device never publishes the fix ----
  const guarded = await page.evaluate(() => {
    const junk = ["المسجد النبوي", "عثمان بن عفان", "عام الفيل"];
    const qs = [];
    Object.keys(builtinQuestionBanks.seerah).forEach(pts => builtinQuestionBanks.seerah[pts].forEach(qa => {
      qs.push({ points: +pts, q: qa[0], a: qa[1], distractors: junk.slice() });
    }));
    try { localStorage.removeItem("izzbah-datafix-seerah-dist-v1"); } catch (e) {}
    window.__pubCount = 0;
    window.IZZBAH.applyAdmin(false);
    window.IZZBAH.applyPublished([{ id: "seerah", name: "السيرة النبوية", questions: qs }]);
    return window.__pubCount;
  });
  check("non-admin devices never publish the fix", guarded === 0);

  // ---- 4) a half-loaded (stub) category is never republished ----
  const stub = await page.evaluate(() => {
    window.IZZBAH.applyAdmin(false);
    window.IZZBAH.applyPublished([{ id: "seerah", name: "السيرة النبوية", questions: [{ points: 100, q: "س", a: "ج" }] }]);
    try { localStorage.removeItem("izzbah-datafix-seerah-dist-v1"); } catch (e) {}
    window.__pubCount = 0;
    window.IZZBAH.applyAdmin(true); // fix sees only the stub (< 20 questions) → no publish
    return window.__pubCount;
  });
  check("a half-loaded (stub) category is never republished", stub === 0);

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
