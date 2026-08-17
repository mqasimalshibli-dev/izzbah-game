// Admin duplicate-question scanner: flags questions repeated across the
// catalog. «مكرّر» = same question + same answer; «تعارض» = same question with
// different answers. Report-only.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8377;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1000, height: 950 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

const UNIQ_DUP = "سؤال تكرار فريد جدا لهذا الاختبار؟";
const UNIQ_CONF = "سؤال تعارض فريد جدا لهذا الاختبار؟";

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.IZZBAH.applyAuth(true); });

  // Inject known duplicates/conflicts as community categories (scanned too).
  const res = await page.evaluate((u) => {
    state.communityCategories = [
      { id: "t_a", name: "فئة أ", questions: [{ q: u.dup, a: "الجواب نفسه", points: 100 }] },
      { id: "t_b", name: "فئة ب", questions: [{ q: u.dup + " ", a: "الجواب نفسه", points: 200 }] }, // dup (punctuation/space-insensitive)
      { id: "t_c", name: "فئة ج", questions: [
        { q: u.conf, a: "جواب س", points: 300 },
        { q: u.conf, a: "جواب مختلف", points: 400 },  // conflict: same q, different a, same category
      ] },
    ];
    const report = findDuplicateQuestions();
    const dupG = report.dups.find(g => g.items.some(i => i.q.includes("تكرار فريد")));
    const confG = report.dups.find(g => g.items.some(i => i.q.includes("تعارض فريد")));
    return {
      dupFound: !!dupG, dupCount: dupG ? dupG.items.length : 0, dupIsConflict: dupG ? dupG.conflict : null,
      confFound: !!confG, confIsConflict: confG ? confG.conflict : null, confSameCat: confG ? confG.sameCatOnly : null,
    };
  }, { dup: UNIQ_DUP, conf: UNIQ_CONF });

  check("finds the same-question/same-answer pair as a DUPLICATE", res.dupFound && res.dupCount === 2 && res.dupIsConflict === false);
  check("normalization ignores trailing punctuation/space when matching", res.dupCount === 2);
  check("finds the same-question/different-answer pair as a CONFLICT", res.confFound && res.confIsConflict === true);
  check("a conflict inside one category is flagged as same-category", res.confSameCat === true);

  // ---- a photo SERIES must not drown the report -----------------------------
  // «ما اسم هذا الموقع في سلطنة عُمان؟» is the prompt for 178 real questions
  // whose PICTURE is the question; «من سجل هذا الهدف؟» for 24. Identical text
  // is correct there. Grouping by text alone put 604 such rows ABOVE the two
  // genuine repeats, which landed at positions 39 and 40 — reported, and still
  // invisible. And a repeat INSIDE a series could never surface at all, because
  // it was two items inside one 178-strong group.
  const series = await page.evaluate(() => {
    const shot = (a, points) => ({ q: "ما اسم هذا الموقع في الاختبار؟", a, points });
    state.communityCategories = [{
      id: "t_series", name: "سلسلة", questions: [
        shot("موقع ١", 100), shot("موقع ٢", 200), shot("موقع ٣", 300),
        shot("موقع ٤", 400), shot("موقع ٥", 500), shot("موقع ٦", 100),
        shot("مكرر حقيقي", 200), shot("مكرر حقيقي", 300),   // ← buried inside it
      ],
    }];
    const report = findDuplicateQuestions();
    const mine = report.dups.filter(g => g.items.some(i => i.q.includes("الاختبار")));
    const real = mine.filter(g => !g.conflict);
    const ser = mine.filter(g => g.series);
    return {
      realCount: real.length,
      realAnswer: real[0] ? real[0].items[0].a : "",
      realSize: real[0] ? real[0].items.length : 0,
      seriesCount: ser.length,
      seriesSize: ser[0] ? ser[0].items.length : 0,
      // position in the WHOLE report, which is what the admin actually scrolls
      realRank: real[0] ? report.dups.indexOf(real[0]) : -1,
      seriesRank: ser[0] ? report.dups.indexOf(ser[0]) : -1,
    };
  });
  check("a repeat BURIED inside a photo series is extracted as its own entry",
    series.realCount === 1 && series.realSize === 2, `${series.realCount} group(s)`);
  check("...identified by its answer, since the text is shared with the series",
    series.realAnswer === "مكرر حقيقي", series.realAnswer);
  check("the series itself is recognised, not reported as a fault",
    series.seriesCount === 1 && series.seriesSize === 8, `${series.seriesSize} items`);
  check("⚠️ the real repeat sorts ABOVE the series — this is the whole fix",
    series.realRank > -1 && series.seriesRank > -1 && series.realRank < series.seriesRank,
    `real #${series.realRank + 1}, series #${series.seriesRank + 1}`);

  // A SMALL group with differing answers is more likely a genuine mistake than
  // a series, so it must stay visible between the two bands.
  const small = await page.evaluate(() => {
    state.communityCategories = [{ id: "t_small", name: "صغيرة", questions: [
      { q: "سؤال صغير للاختبار؟", a: "جواب أ", points: 100 },
      { q: "سؤال صغير للاختبار؟", a: "جواب ب", points: 200 },
    ] }];
    const report = findDuplicateQuestions();
    const g = report.dups.find(x => x.items.some(i => i.q.includes("صغير للاختبار")));
    return { conflict: g ? g.conflict : null, series: g ? g.series : null };
  });
  check("two same-text questions with different answers stay a CONFLICT, not a series",
    small.conflict === true && small.series === false);

  // ⚠️ Put the original fixtures back. The blocks above replaced
  // state.communityCategories wholesale, and everything below reads the report
  // built from the FIRST set — without this the UI checks measure a catalogue
  // that no longer contains what they are looking for.
  await page.evaluate((u) => {
    state.communityCategories = [
      { id: "t_a", name: "فئة أ", questions: [{ q: u.dup, a: "الجواب نفسه", points: 100 }] },
      { id: "t_b", name: "فئة ب", questions: [{ q: u.dup + " ", a: "الجواب نفسه", points: 200 }] },
      { id: "t_c", name: "فئة ج", questions: [
        { q: u.conf, a: "جواب س", points: 300 },
        { q: u.conf, a: "جواب مختلف", points: 400 },
      ] },
    ];
  }, { dup: UNIQ_DUP, conf: UNIQ_CONF });

  // The modal renders the report with tags + a summary.
  const ui = await page.evaluate(() => {
    openDupModal();
    return {
      open: document.getElementById("dupModal").classList.contains("open"),
      title: document.getElementById("dupTitle").textContent,
      btnName: document.getElementById("adminChoiceDupes").textContent,
      summary: document.getElementById("dupSummary").textContent,
      groups: document.querySelectorAll("#dupList .dup-group").length,
      hasDupTag: !!document.querySelector("#dupList .dup-tag.dup"),
      hasConfTag: !!document.querySelector("#dupList .dup-tag.conf"),
      hasDeleteBtns: document.querySelectorAll("#dupList .dup-del").length > 0,
    };
  });
  check("the scanner modal opens and lists duplicate groups", ui.open && ui.groups >= 2);
  check("the tool is named «المتكررات» (not «الأسئلة المكرّرة»)", /المتكررات/.test(ui.title) && /المتكررات/.test(ui.btnName) && !/الأسئلة المكرّرة/.test(ui.btnName));
  check("the summary reports how many duplicates were found", /مكرّرة|تكرار/.test(ui.summary));
  check("groups are tagged «مكرّر» and «تعارض»", ui.hasDupTag && ui.hasConfTag);
  check("each occurrence has a «حذف هذه» resolve button", ui.hasDeleteBtns);

  // ---- resolve: a COMMUNITY delete updates INSTANTLY, saves in background ----
  const resolveComm = await page.evaluate(async () => {
    window.__set = [];
    window.IZZBAH.adminSetCommunityQuestions = (catId, qs) => { window.__set.push({ catId, qs }); return Promise.resolve(); };
    const dupGroup = [...document.querySelectorAll("#dupList .dup-group")].find(g => /تكرار فريد/.test(g.textContent));
    dupGroup.querySelector(".dup-del").click();
    await new Promise(r => setTimeout(r, 60)); // the report should already be updated
    const instantGone = ![...document.querySelectorAll("#dupList .dup-group")].some(g => /تكرار فريد/.test(g.textContent));
    const calledYet = window.__set.length; // still 0 — the save is debounced
    await new Promise(r => setTimeout(r, 900)); // wait out the debounce
    return {
      instantGone, calledYet,
      called: window.__set.length,
      catId: window.__set[0] && window.__set[0].catId,
      leftInCat: window.__set[0] ? window.__set[0].qs.length : -1,
      syncShown: !document.getElementById("dupSync").hidden,
    };
  });
  check("a community delete updates the report instantly (no wait/stuck)", resolveComm.instantGone && resolveComm.calledYet === 0);
  check("the change saves in the background via the bridge with the question removed",
    resolveComm.called === 1 && resolveComm.catId === "t_a" && resolveComm.leftInCat === 0);
  check("a save-status line is shown while/after persisting", resolveComm.syncShown);

  // ---- resolve: an OFFICIAL delete updates INSTANTLY, publishes in background ----
  const resolveOfficial = await page.evaluate(async () => {
    window.__pub = [];
    window.IZZBAH.cloudPublish = (cat) => { window.__pub.push(cat); return Promise.resolve(); };
    window.fitCategoryForPublish = () => Promise.resolve(true); // skip image work offline
    state.communityCategories = [];
    state.publishedCategories = [
      { id: "off1", name: "رسمية أ", custom: true, questions: [{ q: "سؤال رسمي مكرّر فريد جداً؟", a: "ثابت", points: 100, image: "", answerImage: "" }] },
      { id: "off2", name: "رسمية ب", custom: true, questions: [{ q: "سؤال رسمي مكرّر فريد جداً؟", a: "ثابت", points: 200, image: "", answerImage: "" }] },
    ];
    renderDupReport();
    const grp = [...document.querySelectorAll("#dupList .dup-group")].find(g => /رسمي مكرّر فريد/.test(g.textContent));
    grp.querySelector(".dup-del").click();
    await new Promise(r => setTimeout(r, 60));
    const instantGone = ![...document.querySelectorAll("#dupList .dup-group")].some(g => /رسمي مكرّر فريد/.test(g.textContent));
    await new Promise(r => setTimeout(r, 900));
    return {
      instantGone,
      published: window.__pub.length,
      publishedId: window.__pub[0] && window.__pub[0].id,
      publishedQCount: window.__pub[0] ? window.__pub[0].questions.length : -1,
    };
  });
  check("an official delete updates the report instantly (no wait/stuck)", resolveOfficial.instantGone);
  check("the official change publishes in the background with the question removed",
    resolveOfficial.published === 1 && resolveOfficial.publishedId === "off1" && resolveOfficial.publishedQCount === 0);

  // A clean catalog (no injected dupes, and none in built-ins) shows the all-clear.
  const clean = await page.evaluate(() => {
    state.communityCategories = [
      { id: "u1", name: "فريدة", questions: [{ q: "سؤال فريد لا يتكرر أبداً ٱبجد؟", a: "جواب", points: 100 }] },
    ];
    const report = findDuplicateQuestions();
    // our injected one must NOT be a duplicate
    return report.dups.some(g => g.items.some(i => i.q.includes("لا يتكرر أبداً")));
  });
  check("a unique question is not flagged", clean === false);

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
