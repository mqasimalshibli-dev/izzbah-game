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
    const done = await page.evaluate(() => !!window.__pubCount || !!localStorage.getItem("izzbah-datafix-geo-dist-v2"));
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
  // capitals have no geographic "family", so they exercise the sibling-borrow
  // path — distractors must be other capitals FROM THE CATEGORY.
  const within = (a, pool) => Array.isArray(gen[a]) && gen[a].length === 3 && gen[a].every(d => pool.includes(d)) && !gen[a].includes(a);
  // typed families are on-KIND (drawn from the curated pool + category), so
  // assert the feature type, not membership of the tiny category set.
  const onKind = (a, rx) => Array.isArray(gen[a]) && gen[a].length === 3 && gen[a].every(d => rx.test(d)) && !gen[a].includes(a);
  check("capital question gets only other capitals (template clustering)",
    within("باريس", CAPITALS) && within("طوكيو", CAPITALS));
  check("continent question gets only other continents", onKind("أفريقيا", /آسيا|أفريقيا|أوروبا|أمريكا|أستراليا|أنتاركتيكا/) && onKind("آسيا", /آسيا|أفريقيا|أوروبا|أمريكا|أستراليا|أنتاركتيكا/));
  check("river question gets only other rivers (same-kind answers)", onKind("نهر النيل", /نهر|دجلة|الفرات/) && onKind("نهر التايمز", /نهر|دجلة|الفرات/));
  check("island question gets only other islands (rare-word weighting)", onKind("غرينلاند", /غرينلاند|صقلية|هونشو|كوبا|مدغشقر|بورنيو|أيسلندا/) && onKind("كوبا", /غرينلاند|صقلية|هونشو|كوبا|مدغشقر|بورنيو|أيسلندا/));
  check("sea question gets only other seas", onKind("البحر الأحمر", /بحر/));
  check("lake question gets only other lakes (not seas)", onKind("بحر قزوين", /بحيرة|قزوين/));
  check("«عالم» is a stopword (boilerplate «في العالم» never links questions)",
    await page.evaluate(() => !topicWords("ما أطول نهر في العالم؟").includes("عالم")));
  // «ما عاصمة اليابان؟» must NOT pull «هونشو» from «ما أكبر جزيرة في اليابان؟»
  check("a shared proper noun does not cross-link question types", !(gen["طوكيو"] || []).includes("هونشو"));

  // ---- 1d) GAMING category: distractors stay the same KIND as the answer ----
  const gaming = await page.evaluate(() => {
    const cat = { id: "pub-games", name: "العاب", questions: [
      { q: "لعبة بناء المكعبات؟", a: "ماينكرافت", points: 100 },
      { q: "لعبة الباتل رويال من إيبك؟", a: "فورتنايت", points: 100 },
      { q: "بطل سوبر ماريو؟", a: "ماريو", points: 200 },
      { q: "القنفذ الأزرق في ألعاب سيجا؟", a: "سونيك", points: 200 },
      { q: "شركة أجهزة بلايستيشن؟", a: "سوني", points: 200 },
      { q: "شركة أجهزة إكس بوكس؟", a: "مايكروسوفت", points: 200 },
      { q: "جهاز نينتندو المحمول الهجين؟", a: "نينتندو سويتش", points: 300 },
    ]};
    const out = {}; cat.questions.forEach(q => { out[q.a] = relatedDistractors(cat, q); });
    // pools mirror GAMING_FAMILIES in the app
    const P = {
      consoles: ["بلايستيشن","بلايستيشن 5","بلايستيشن 4","إكس بوكس","إكس بوكس سيريس","نينتندو سويتش","نينتندو واي","نينتندو 64","سيجا","أتاري","بلايستيشن بورتابل","نينتندو دي إس"],
      companies: ["سوني","مايكروسوفت","نينتندو","سيجا","روكستار","إلكترونيك آرتس","يوبي سوفت","بليزارد","فالف","إيبك جيمز","أكتيفجن","كابكوم","سكوير إنيكس","بانداي نامكو"],
      characters: ["ماريو","سونيك","لينك","كراتوس","ماستر تشيف","لارا كروفت","بيكاتشو","لويجي","دونكي كونغ","ساموس","كيربي","زيلدا"],
      titles: ["ماينكرافت","فورتنايت","كول أوف ديوتي","فيفا","ببجي","جراند ثفت أوتو","بوكيمون","كاندي كراش","أنجري بيردز","تيتريس","سوبر ماريو","روبلوكس","أمونج أص","فول جارد","ليج أوف ليجندز","فالورانت","أوفرواتش","ذا ويتشر","إلدن رينغ","كلاش أوف كلانس","كلاش رويال","فري فاير","سبيس إنفيدرز","باك مان"],
    };
    // "same kind" = the answer and the distractor share ANY pool (سيجا / Sega is
    // legitimately both a company AND a console brand, so it lives in two pools).
    const sameKind = (a, d) => Object.values(P).some(pool => pool.includes(a) && pool.includes(d));
    const allSame = a => Array.isArray(out[a]) && out[a].length === 3 && out[a].every(d => sameKind(a, d)) && !out[a].includes(a);
    // characters (ماريو/سونيك) now get SAME-UNIVERSE characters (بيتش/شادو…) that
    // aren't in the generic pool — so a character's distractors are validated as
    // "not a company / console / title" rather than pool membership.
    const nonCharPools = [...P.companies, ...P.consoles, ...P.titles];
    const areCharacters = a => Array.isArray(out[a]) && out[a].length === 3 && out[a].every(d => !nonCharPools.includes(d)) && !out[a].includes(a);
    return {
      title: allSame("ماينكرافت") && allSame("فورتنايت"),
      character: areCharacters("ماريو") && areCharacters("سونيك"),
      company: allSame("سوني") && allSame("مايكروسوفت"),
      console: allSame("نينتندو سويتش"),
      // the Sony/Sonic substring trap: Sonic (a character) must NOT get companies
      sonicNotCompany: (out["سونيك"] || []).every(d => !P.companies.includes(d)),
    };
  });
  check("gaming: a game TITLE gets other titles", gaming.title);
  check("gaming: a CHARACTER gets other characters", gaming.character);
  check("gaming: a COMPANY gets other companies", gaming.company);
  check("gaming: a CONSOLE gets other consoles", gaming.console);
  check("gaming: «سونيك» (Sonic) is not confused with «سوني» (Sony)", gaming.sonicNotCompany);

  // ---- 1e) FRANCHISE-aware: a character gets others from the SAME universe ----
  const fr = await page.evaluate(() => {
    const cat = { id: "pub-games", name: "العاب", questions: [
      { q: "من هو بطل سلسلة زيلدا؟", a: "لينك" },
      { q: "بطل سوبر ماريو؟", a: "ماريو" },
      { q: "بطل جود أوف وور؟", a: "كراتوس" },
      { q: "أشهر بوكيمون؟", a: "بيكاتشو" },
      { q: "الشرير ذو الزي الأصفر في مورتال كومبات؟", a: "سكوربيون" },
      { q: "أي شركة طورت ماريو؟", a: "نينتندو" }, // control: company, must NOT franchise
    ]};
    const out = {}; cat.questions.forEach(q => out[q.a] = relatedDistractors(cat, q));
    const VERSE = {
      zelda: ["لينك","زيلدا","غانون","غانوندورف","نافي","إمبو"],
      mario: ["ماريو","لويجي","الأميرة بيتش","بيتش","باوزر","يوشي","تود","واريو","دونكي كونغ","ديزي"],
      gow: ["كراتوس","أتريوس","فريا","بالدور","زيوس","أثينا","ميميير"],
      pokemon: ["بيكاتشو","تشارمندر","بلباصور","سكويرتل","تشاريزارد","إيفي","ميوتو","جيغليبوف","آش","سنورلاكس"],
      mk: ["سكوربيون","سب زيرو","رايدن","ليو كانغ","كيتانا","شاو كان","جوني كيج","سونيا"],
      companies: ["سوني","مايكروسوفت","نينتندو","سيجا","روكستار","إلكترونيك آرتس","يوبي سوفت","بليزارد","فالف","إيبك جيمز","أكتيفجن","كابكوم","سكوير إنيكس","بانداي نامكو"],
    };
    const within = (a, pool) => Array.isArray(out[a]) && out[a].length === 3 && out[a].every(d => pool.includes(d)) && !out[a].includes(a);
    return {
      zelda: within("لينك", VERSE.zelda),
      mario: within("ماريو", VERSE.mario),
      gow: within("كراتوس", VERSE.gow),
      pokemon: within("بيكاتشو", VERSE.pokemon),
      mk: within("سكوربيون", VERSE.mk),
      companyControl: within("نينتندو", VERSE.companies), // stays a company, not franchised
    };
  });
  check("franchise: a Zelda character gets other Zelda characters", fr.zelda);
  check("franchise: a Mario character gets other Mario characters", fr.mario);
  check("franchise: a God of War character gets other GoW characters", fr.gow);
  check("franchise: a Pokémon gets other Pokémon", fr.pokemon);
  check("franchise: a Mortal Kombat fighter gets other MK fighters", fr.mk);
  check("franchise: a company answer is NOT franchised (stays companies)", fr.companyControl);

  // ---- 1b) curated family pools cover SINGLETON geographic subtypes ----
  const fam = await page.evaluate(() => {
    // a category with exactly ONE ocean / desert / gulf / mountain-range /
    // continent-count question — no same-kind sibling to borrow, so the curated
    // pool must supply three on-type distractors instead of a random other kind.
    const cat = { id: "geo", name: "جغرافيا", questions: [
      { points: 100, q: "ما أكبر محيط في العالم؟", a: "المحيط الهادئ" },
      { points: 100, q: "ما هي أكبر صحراء حارة في العالم؟", a: "الصحراء الكبرى" },
      { points: 100, q: "ما الخليج الذي تقع عليه مدينة دبي؟", a: "الخليج العربي" },
      { points: 100, q: "ما أطول سلسلة جبال في العالم؟", a: "جبال الأنديز" },
      { points: 100, q: "كم عدد القارات في العالم؟", a: "سبع قارات" },
      { points: 100, q: "ما عاصمة فرنسا؟", a: "باريس" },
    ]};
    const out = {};
    cat.questions.forEach(q => { out[q.a] = relatedDistractors(cat, q); });
    return out;
  });
  const allMatch = (a, rx) => Array.isArray(fam[a]) && fam[a].length === 3 && fam[a].every(d => rx.test(d)) && !fam[a].includes(a);
  check("a lone ocean question gets other oceans", allMatch("المحيط الهادئ", /محيط/));
  check("a lone desert question gets other deserts", allMatch("الصحراء الكبرى", /صحراء|الربع الخالي/));
  check("a lone gulf question gets other gulfs", allMatch("الخليج العربي", /خليج/));
  check("a lone mountain-range question gets other ranges", allMatch("جبال الأنديز", /جبال/));
  check("a continent-count question gets other counts (not place names)", allMatch("سبع قارات", /قارات/));

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
    marker: localStorage.getItem("izzbah-datafix-geo-dist-v2"),
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
    localStorage.removeItem("izzbah-datafix-geo-dist-v2");
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
    return { count: window.__pubCount, marker: localStorage.getItem("izzbah-datafix-geo-dist-v2") };
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
