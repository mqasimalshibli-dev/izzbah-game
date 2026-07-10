// E2E for (a) the topical distractor generator's quality rules — template
// clustering, rarity weighting, same-kind answer affinity, «عالم» stopword —
// and (b) the one-time admin-device data fix that regenerates the published
// «جغرافيا» category's distractors and republishes it.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8326;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

// A miniature جغرافيا with mixed question types, all carrying junk distractors.
const GEO_QUESTIONS = [
  { points: 100, q: "ما عاصمة فرنسا؟", a: "باريس", image: "", answerImage: "", distractors: ["نهر النيل", "صقلية", "آسيا"] },
  { points: 100, q: "ما عاصمة اليابان؟", a: "طوكيو", image: "", answerImage: "", distractors: ["أوروبا", "غرينلاند", "نهر السين"] },
  { points: 100, q: "ما عاصمة ألمانيا؟", a: "برلين", image: "", answerImage: "" },
  { points: 100, q: "ما عاصمة روسيا؟", a: "موسكو", image: "", answerImage: "" },
  { points: 200, q: "في أي قارة تقع مصر؟", a: "أفريقيا", image: "", answerImage: "" },
  { points: 200, q: "في أي قارة تقع الهند؟", a: "آسيا", image: "", answerImage: "" },
  { points: 200, q: "في أي قارة تقع إيطاليا؟", a: "أوروبا", image: "", answerImage: "" },
  { points: 200, q: "في أي قارة تقع المكسيك؟", a: "أمريكا الشمالية", image: "", answerImage: "" },
  { points: 300, q: "ما أطول نهر في العالم؟", a: "نهر النيل", image: "", answerImage: "" },
  { points: 300, q: "أي نهر يمر بمدينة لندن؟", a: "نهر التايمز", image: "", answerImage: "" },
  { points: 300, q: "ما النهر الذي يمر بمدينة باريس؟", a: "نهر السين", image: "", answerImage: "" },
  { points: 300, q: "ما أطول نهر في أوروبا؟", a: "نهر الفولغا", image: "", answerImage: "" },
  { points: 400, q: "ما أكبر جزيرة في العالم؟", a: "غرينلاند", image: "", answerImage: "" },
  { points: 400, q: "ما أكبر جزيرة في البحر الأبيض المتوسط؟", a: "صقلية", image: "", answerImage: "" },
  { points: 400, q: "ما أكبر جزيرة في اليابان؟", a: "هونشو", image: "", answerImage: "" },
  { points: 400, q: "ما أكبر جزيرة في البحر الكاريبي؟", a: "كوبا", image: "", answerImage: "" },
  { points: 500, q: "ما البحر الذي يقع غرب السعودية؟", a: "البحر الأحمر", image: "", answerImage: "" },
  { points: 500, q: "ما البحر الذي يفصل تركيا عن أوكرانيا؟", a: "البحر الأسود", image: "", answerImage: "" },
  { points: 500, q: "ما البحر الذي يفصل أوروبا عن أفريقيا؟", a: "البحر المتوسط", image: "", answerImage: "" },
  { points: 500, q: "ما أكبر بحيرة مغلقة في العالم؟", a: "بحر قزوين", image: "", answerImage: "" },
];
const CAPITALS = ["باريس", "طوكيو", "برلين", "موسكو"];
const CONTINENTS = ["أفريقيا", "آسيا", "أوروبا", "أمريكا الشمالية"];
const RIVERS = ["نهر النيل", "نهر التايمز", "نهر السين", "نهر الفولغا"];
const ISLANDS = ["غرينلاند", "صقلية", "هونشو", "كوبا"];
const SEAS = ["البحر الأحمر", "البحر الأسود", "البحر المتوسط", "بحر قزوين"];

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

const waitFix = async () => {
  for (let i = 0; i < 30; i++) {
    const done = await page.evaluate(() => !!window.__pubCount || !!localStorage.getItem("izzbah-datafix-geo-dist-v1"));
    if (done) break;
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(200);
};

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ---- 1) generator quality rules on the mini category ----
  const gen = await page.evaluate((qs) => {
    const cat = { id: "geo", name: "جغرافيا", questions: qs };
    const out = {};
    qs.forEach(q => { out[q.a] = relatedDistractors(cat, q); });
    return out;
  }, GEO_QUESTIONS);
  const within = (a, pool) => Array.isArray(gen[a]) && gen[a].length === 3 && gen[a].every(d => pool.includes(d)) && !gen[a].includes(a);
  check("capital question gets only other capitals (template clustering)",
    within("باريس", CAPITALS) && within("طوكيو", CAPITALS));
  check("continent question gets only other continents", within("أفريقيا", CONTINENTS) && within("آسيا", CONTINENTS));
  check("river question gets only other rivers (same-kind answers)", within("نهر النيل", RIVERS) && within("نهر التايمز", RIVERS));
  check("island question gets only other islands (rare-word weighting)", within("غرينلاند", ISLANDS) && within("كوبا", ISLANDS));
  check("sea/lake question gets only other seas", within("البحر الأحمر", SEAS) && within("بحر قزوين", SEAS));
  check("«عالم» is a stopword (boilerplate «في العالم» never links questions)",
    await page.evaluate(() => !topicWords("ما أطول نهر في العالم؟").includes("عالم")));
  // «ما عاصمة اليابان؟» must NOT pull «هونشو» from «ما أكبر جزيرة في اليابان؟»
  check("a shared proper noun does not cross-link question types", !(gen["طوكيو"] || []).includes("هونشو"));

  // ---- 2) the one-time data fix: admin device regenerates + republishes ----
  await page.evaluate((qs) => {
    window.__pubCount = 0;
    window.__published = null;
    window.IZZBAH.cloudPublish = (c) => { window.__pubCount++; window.__published = JSON.parse(JSON.stringify(c)); return Promise.resolve(); };
    window.IZZBAH.applyAuth(true, "adm");
    window.IZZBAH.applyAdmin(true);
    window.IZZBAH.applyPublished([{ id: "geo", name: "جغرافيا", image: "x.webp", color: "#123", order: 3, questions: qs }]);
  }, GEO_QUESTIONS);
  await waitFix();
  const fix = await page.evaluate(() => ({
    count: window.__pubCount,
    marker: localStorage.getItem("izzbah-datafix-geo-dist-v1"),
    id: window.__published && window.__published.id,
    first: window.__published && window.__published.questions[0].distractors,
    all: window.__published && window.__published.questions.every(q => Array.isArray(q.distractors) && q.distractors.length === 3),
  }));
  check("the fix publishes the geo category once", fix.count === 1 && fix.id === "geo");
  check("junk distractors were replaced with topical ones",
    Array.isArray(fix.first) && fix.first.every(d => CAPITALS.includes(d)) && !fix.first.includes("باريس"));
  check("every question now carries a full curated set", !!fix.all);
  check("a success marker prevents re-running", fix.marker === "1");

  // re-applying the same data must NOT publish again (marker set)
  const again = await page.evaluate((qs) => {
    window.IZZBAH.applyPublished([{ id: "geo", name: "جغرافيا", questions: qs }]);
    window.IZZBAH.applyAdmin(true);
    return window.__pubCount;
  }, GEO_QUESTIONS);
  check("the fix never runs twice", again === 1);

  // ---- 3) guards: no admin / failed publish ----
  const guarded = await page.evaluate((qs) => {
    localStorage.removeItem("izzbah-datafix-geo-dist-v1");
    window.__pubCount = 0;
    window.IZZBAH.applyAdmin(false);
    window.IZZBAH.applyPublished([{ id: "geo", name: "جغرافيا", questions: qs }]);
    return window.__pubCount;
  }, GEO_QUESTIONS);
  check("non-admin devices never publish the fix", guarded === 0);

  const failed = await page.evaluate(async (qs) => {
    window.__pubCount = 0;
    window.IZZBAH.cloudPublish = () => { window.__pubCount++; return Promise.reject(new Error("offline")); };
    window.IZZBAH.applyAdmin(true);
    await new Promise(r => setTimeout(r, 400));
    return { count: window.__pubCount, marker: localStorage.getItem("izzbah-datafix-geo-dist-v1") };
  }, GEO_QUESTIONS);
  check("a failed publish leaves no marker (retries next visit)", failed.count === 1 && failed.marker === null);

  // a stub category (subcollection not loaded yet) must never be published —
  // that would wipe the real questions
  const stub = await page.evaluate(() => {
    window.__pubCount = 0;
    window.IZZBAH.cloudPublish = (c) => { window.__pubCount++; return Promise.resolve(); };
    window.IZZBAH.applyPublished([{ id: "geo", name: "جغرافيا", questions: [{ points: 100, q: "س", a: "ج" }] }]);
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
