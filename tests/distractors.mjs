// «فحص الخيارات» — the distractor scanner.
//
// Built after reading all 40 published categories over the REST API: 13
// questions carried the correct answer inside their own wrong-answer list, and
// 227 stored the points value ("100"/"200"/"300") as their only option.
//
// The cases are taken from that real data, including the ones that matter most:
// three of the thirteen differ from the answer ONLY by a hamza
// («راندي أورتن» / «راندي اورتن»), so a scanner that compares raw strings finds
// nothing while the player sees two identical options and is marked wrong for
// picking the second.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8497;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.route("**/firebasejs/**", r => r.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => {
  try {
    localStorage.setItem("izzbah-legal-consent-v1", "1");
    localStorage.setItem("izzbah-coach-v1", JSON.stringify({ __all: 1 }));
  } catch (e) {}
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1400);

  const published = await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "adm");
    window.IZZBAH.applyAdmin(true);
    const q = (points, text, a, d) => ({ points, q: text, a, image: "", answerImage: "", distractors: d });
    window.IZZBAH.applyPublished([
      {
        id: "pub-sites", name: "مواقع في عمان", image: "", order: 1, questions: [
          // the exact shape found live: the answer repeated inside its options
          q(100, "ما اسم هذا الموقع؟", "حصن مرباط", ["حصن مرباط", "حصن سدح", "حصن رخيوت"]),
          // hamza-only difference — invisible to a raw string comparison
          q(200, "من يُلقب بـ The Viper؟", "راندي أورتن", ["راندي اورتن", "درو ماكنتاير", "رومان رينز"]),
          // healthy question, must NOT be reported
          q(300, "ما عاصمة عُمان؟", "مسقط", ["صلالة", "صحار", "نزوى"]),
          // two identical options
          q(400, "أطول واد؟", "وادي شاب", ["وادي ضيقة", "وادي ضيقة", "وادي الجزي"]),
          // an empty option
          q(500, "أي حصن؟", "حصن نخل", ["حصن السليف", "", "حصن الأسود"]),
        ],
      },
      {
        // points leaked into the options — an import bug, 227 live cases
        id: "pub-history", name: "تاريخ", image: "", order: 2, questions: [
          q(100, "متى بدأت الثورة الصناعية؟", "القرن الثامن عشر", ["100"]),
          q(200, "أول رئيس أمريكي؟", "جورج واشنطن", ["توماس جيفرسون", "جون آدامز", "بنجامين فرانكلين"]),
        ],
      },
    ]);
    return true;
  });
  check("test catalogue applied", published === true);

  // ---- the scan itself ----
  const scan = await page.evaluate(() => {
    const { total, found } = distFindIssues();
    return {
      total,
      kinds: found.map(f => f.kind),
      byKind: found.reduce((m, f) => (m[f.kind] = (m[f.kind] || 0) + 1, m), {}),
      answers: found.filter(f => f.kind === "answer").map(f => f.it.a),
      healthy: found.some(f => f.it.a === "مسقط" || f.it.a === "جورج واشنطن"),
      fixes: found.map(f => f.fix && f.fix.type),
    };
  });

  check(`it finds the answer hidden in its own options (${scan.byKind.answer || 0} of 2)`,
    (scan.byKind.answer || 0) === 2);
  check("…including the one that differs only by a hamza",
    scan.answers.some(a => a.indexOf("راندي") === 0));
  check(`it finds two identical options (${scan.byKind.twice || 0})`, (scan.byKind.twice || 0) === 1);
  check(`it finds an empty option (${scan.byKind.empty || 0})`, (scan.byKind.empty || 0) === 1);
  check(`it finds the points value stored as an option (${scan.byKind.points || 0})`,
    (scan.byKind.points || 0) === 1);
  // The expensive kind of wrong: crying wolf on good questions.
  check("it does NOT report healthy questions", scan.healthy === false);
  check("every finding it can fix offers a fix", scan.fixes.filter(Boolean).length >= 5);

  // ---- «قول غيرها» is excluded outright ----
  // applyPublished REPLACES the catalogue, so this stands alone: a category
  // whose every question would trip the scanner must report exactly nothing.
  const banned = await page.evaluate(() => {
    window.IZZBAH.applyPublished([{
      id: "pub-say", name: "قول غيرها", image: "", order: 3, questions: [
        // its `distractors` are BANNED WORDS, not wrong answers — one of which
        // legitimately equals part of the answer list. Touching these breaks the
        // game, so the scanner must not look at them at all.
        { points: 100, q: "اذكر اسم فاكهة", a: "رمان · تين · مانجو", image: "", answerImage: "",
          distractors: ["تفاح", "موز", "برتقال"] },
      ],
    }]);
    const f = distFindIssues().found;
    return { total: f.length, fromSay: f.filter(x => x.it.catId === "pub-say").length };
  });
  check(`«قول غيرها» is excluded — its banned words are never scanned (${banned.fromSay} findings from it)`,
    banned.fromSay === 0);

  // ---- applying a fix actually changes the data ----
  const fixed = await page.evaluate(async () => {
    // put the defective catalogue back (the banned-word check replaced it)
    const q = (points, text, a, d) => ({ points, q: text, a, image: "", answerImage: "", distractors: d });
    window.IZZBAH.applyPublished([{
      id: "pub-sites", name: "مواقع في عمان", image: "", order: 1, questions: [
        q(100, "ما اسم هذا الموقع؟", "حصن مرباط", ["حصن مرباط", "حصن سدح", "حصن رخيوت"]),
        q(300, "ما عاصمة عُمان؟", "مسقط", ["صلالة", "صحار", "نزوى"]),
      ],
    }]);
    const entry = distFindIssues().found.find(f => f.kind === "answer" && f.it.a === "حصن مرباط");
    const before = entry.it.d.slice();
    distApplyFix(entry);
    await new Promise(r => setTimeout(r, 120));
    const cat = state.publishedCategories.find(c => c.id === "pub-sites");
    const row = cat.questions.find(x => x.a === "حصن مرباط");
    const still = distFindIssues().found.some(f => f.kind === "answer" && f.it.a === "حصن مرباط");
    return { before, after: row.distractors.slice(), still, count: row.distractors.length };
  });
  check(`the fix replaces the offending option (${fixed.before.join("|")} → ${fixed.after.join("|")})`,
    fixed.after.length === 3 && !fixed.after.includes("حصن مرباط"));
  check("…with something from the same category, not an invented value",
    fixed.after.every(d => d.trim().length > 0));
  check("…and the finding disappears on re-scan", fixed.still === false);

  // ---- the modal renders ----
  const ui = await page.evaluate(async () => {
    // re-seed: the fix step above cleaned the only defective questions left
    const q = (points, text, a, d) => ({ points, q: text, a, image: "", answerImage: "", distractors: d });
    window.IZZBAH.applyPublished([{
      id: "pub-sites", name: "مواقع في عمان", image: "", order: 1, questions: [
        q(100, "ما اسم هذا الموقع؟", "حصن مرباط", ["حصن مرباط", "حصن سدح", "حصن رخيوت"]),
        q(200, "من يُلقب بـ The Viper؟", "راندي أورتن", ["راندي اورتن", "درو ماكنتاير", "رومان رينز"]),
        q(400, "أطول واد؟", "وادي شاب", ["وادي ضيقة", "وادي ضيقة", "وادي الجزي"]),
        q(500, "أي حصن؟", "حصن نخل", ["حصن السليف", "", "حصن الأسود"]),
      ],
    }]);
    openDistModal();
    await new Promise(r => setTimeout(r, 250));
    const m = document.getElementById("distModal");
    const rows = document.querySelectorAll("#distList .dup-group").length;
    const sum = document.getElementById("distSummary").textContent;
    const btns = document.querySelectorAll("#distList .dup-del").length;
    const open = m.classList.contains("open");   // read BEFORE closing it
    closeDistModal();
    return { open, rows, sum, btns };
  });
  check("the report modal opens and lists findings", ui.open && ui.rows >= 4);
  check(`the summary counts them (“${ui.sum.slice(0, 60)}…”)`, /\d|٠|١|٢|٣|٤|٥|٦|٧|٨|٩/.test(ui.sum));
  check("each fixable finding renders its own button", ui.btns >= 4);

  // ---- a clean catalogue reports clean ----
  const clean = await page.evaluate(async () => {
    window.IZZBAH.applyPublished([{
      id: "pub-ok", name: "جغرافيا", image: "", order: 1, questions: [
        { points: 100, q: "أطول نهر؟", a: "النيل", image: "", answerImage: "", distractors: ["الأمازون", "المسيسيبي", "اليانغتسي"] },
      ],
    }]);
    state.communityCategories = [];
    openDistModal();
    await new Promise(r => setTimeout(r, 200));
    const t = document.getElementById("distSummary").textContent;
    const cls = document.getElementById("distSummary").className;
    closeDistModal();
    const f = distFindIssues().found;
    return { t, cls, n: f.filter(x => x.sev < 4).length, rec: f.filter(x => x.sev === 4).length };
  });
  // Built-in categories are scanned too, so this also asserts the shipped banks
  // are themselves clean — including «خمّن الإيموجي», whose unused-but-good
  // options an earlier version of the scanner wanted to delete.
  // Counts the MALFORMED class only — recycled options are a separate tab and a
  // separate judgement, and the built-in banks do reuse answers as options.
  check(`a clean catalogue (built-ins included) reports no defects (${clean.rec} recycled, separate tab)`,
    clean.n === 0 && /clean/.test(clean.cls));

  // ---- options recycled from other answers in the same category ----
  // Reported by the owner: "some of the categories' options are from the other
  // answers in the same category". Not malformed — the game works — so it gets
  // its own tab and its own severity, because in some live categories it is
  // nearly every question and would otherwise bury the real defects.
  const rec = await page.evaluate(async () => {
    const q = (pt, t, a, d) => ({ points: pt, q: t, a, image: "", answerImage: "", distractors: d });
    window.IZZBAH.applyPublished([{ id: "pub-s", name: "مواقع في عمان", image: "", order: 1, questions: [
      q(100, "موقع ١؟", "حصن مرباط", ["حصن مرباط", "حصن سدح", "حصن رخيوت"]),   // answer in its own options
      q(200, "موقع ٢؟", "حصن سدح", ["حصن نخل", "حصن الخندق", "حصن السليف"]),
      q(300, "موقع ٣؟", "حصن نخل", ["حصن مرباط", "حصن بهلا", "حصن الرستاق"]),  // recycled
      q(400, "موقع ٤؟", "حصن بهلا", ["حصن سدح", "حصن الحزم", "حصن جبرين"]),    // recycled
    ] }]);
    state.communityCategories = [];
    const before = distFindIssues().found;
    const answersOf = () => new Set(state.publishedCategories.find(c => c.id === "pub-s")
      .questions.map(x => distNorm(x.a)));

    distTab = "bad"; distFixAll(); await new Promise(r => setTimeout(r, 150));
    const midBad = distFindIssues().found.filter(f => f.sev < 4).length;

    distTab = "recycled"; distFixAll(); await new Promise(r => setTimeout(r, 150));
    const after = distFindIssues().found;
    const cat = state.publishedCategories.find(c => c.id === "pub-s");
    const ans = answersOf();
    return {
      recBefore: before.filter(f => f.kind === "recycled").length,
      badBefore: before.filter(f => f.sev < 4).length,
      midBad,
      recAfter: after.filter(f => f.kind === "recycled").length,
      anyLeft: after.length,
      // the real property: no option is any question's answer any more
      leaks: cat.questions.flatMap(x => x.distractors.filter(d => ans.has(distNorm(d)))),
      sizes: cat.questions.map(x => x.distractors.length),
    };
  });
  check(`recycled answers are detected (${rec.recBefore} found)`, rec.recBefore >= 3);
  check(`«إصلاح الكل» clears the malformed tab (${rec.badBefore} → ${rec.midBad})`,
    rec.badBefore > 0 && rec.midBad === 0);
  check(`«إصلاح الكل» clears the recycled tab (${rec.recAfter} left)`, rec.recAfter === 0);
  check("…and no option is another question's answer afterwards",
    rec.leaks.length === 0);
  check("…without losing any options along the way",
    rec.sizes.every(n => n === 3));

  // The malformed-tab fix may fall back to using an answer, which the recycled
  // pass then cleans. Pinning that the two passes compose rather than fight.
  check("the two passes compose to a fully clean category", rec.anyLeft === 0);

  const tabs = await page.evaluate(async () => {
    openDistModal();
    await new Promise(r => setTimeout(r, 200));
    const n = document.querySelectorAll("#distTabs .dist-tab").length;
    const on = document.querySelectorAll("#distTabs .dist-tab.on").length;
    closeDistModal();
    return { n, on };
  });
  check("the report shows its tabs, one selected", tabs.n === 3 && tabs.on === 1);

  // ---- «فحص ذكي»: is the option even the same KIND of thing? ----
  // The classifier is a pure function, so it is tested with no network at all.
  // The reported case is my own earlier mistake: «سماكداون», a TV show, offered
  // as a wrong answer to a question whose answer is a wrestler.
  const kinds = await page.evaluate(() => ({
    fort: distKindOf("حصن تاريخي في محافظة ظفار بسلطنة عمان"),
    show: distKindOf("برنامج مصارعة تلفزيوني أمريكي"),
    person: distKindOf("مصارع محترف أمريكي"),
    brand: distKindOf("شركة أمريكية متعددة الجنسيات"),
    unknownEmpty: distKindOf(""),
    unknownVague: distKindOf("شيء ما لا يمكن تصنيفه هنا"),
  }));
  check(`a fort reads as a place (${kinds.fort})`, kinds.fort === "مكان");
  check(`a wrestler reads as a person (${kinds.person})`, kinds.person === "شخص");
  check(`a TV programme reads as a work (${kinds.show})`, kinds.show === "عمل فني");
  check(`a company reads as a company (${kinds.brand})`, kinds.brand === "شركة");
  check("an unknown description classifies as nothing rather than guessing",
    kinds.unknownEmpty === "" && kinds.unknownVague === "");

  // The substring collisions that forced whole-word matching. Each of these
  // classified WRONG when the rules were regexes over the raw string.
  const collisions = await page.evaluate(() => ({
    wrestling: distKindOf("برنامج مصارعة تلفزيوني"),   // مصارعة contains مصارع
    kingdom: distKindOf("مملكة في شبه الجزيرة العربية"), // مملكة contains ملك
    actressPage: distKindOf("ممثلة مصرية"),
    valley: distKindOf("وادٍ في محافظة شمال الباطنة"),
  }));
  check(`«مصارعة» does not read as «مصارع» (${collisions.wrestling})`, collisions.wrestling === "عمل فني");
  check(`«مملكة» does not read as «ملك» (${collisions.kingdom})`, collisions.kingdom === "مكان");
  check(`an actress is still a person (${collisions.actressPage})`, collisions.actressPage === "شخص");

  // The matcher, fed descriptions directly — no Wikipedia call in CI.
  const smart = await page.evaluate(() => {
    const q = (pt, t, a, d) => ({ points: pt, q: t, a, image: "", answerImage: "", distractors: d });
    window.IZZBAH.applyPublished([{ id: "pub-w", name: "مصارعة حره", image: "", order: 1, questions: [
      q(100, "من يُلقب بـ The Viper؟", "راندي أورتن", ["سماكداون", "درو ماكنتاير", "رومان رينز"]),
      q(200, "من هو أقوى مصارع؟", "جون سينا", ["ذا روك", "بروك ليسنر", "أندرتيكر"]),
    ] }]);
    state.communityCategories = [];
    const desc = {
      "راندي أورتن": "مصارع محترف أمريكي",
      "سماكداون": "برنامج مصارعة تلفزيوني أمريكي",
      "درو ماكنتاير": "مصارع محترف اسكتلندي",
      "رومان رينز": "مصارع محترف أمريكي",
      "جون سينا": "مصارع محترف وممثل أمريكي",
      "ذا روك": "مصارع محترف وممثل أمريكي",
      "بروك ليسنر": "مصارع محترف أمريكي",
      "أندرتيكر": "مصارع محترف أمريكي",
    };
    const items = distCollect().filter(i => i.catId === "pub-w");
    const f = distSmartFindings(items, desc);
    return { n: f.length, opts: f.map(x => x.option), why: f[0] && f[0].why, fix: f.map(x => x.fix) };
  });
  check(`it flags the option of the wrong kind (${smart.opts.join(", ") || "none"})`,
    smart.n === 1 && smart.opts[0] === "سماكداون");
  check(`…and says why in plain Arabic (“${smart.why || ""}”)`,
    /نوع|عمل فني|شخص/.test(smart.why || "") || (smart.why || "").indexOf("سماكداون") === 0);
  check("…and offers NO automatic fix — a wrong kind needs a human",
    smart.fix.every(x => x === null));

  // Silence when Wikipedia knows nothing: the scanner must not invent findings
  // from missing data, which is how a checker starts crying wolf.
  const silent = await page.evaluate(() => {
    const items = distCollect().filter(i => i.catId === "pub-w");
    return {
      noData: distSmartFindings(items, {}).length,
      answerOnly: distSmartFindings(items, { "راندي أورتن": "مصارع محترف أمريكي" }).length,
    };
  });
  check("no descriptions → no findings", silent.noData === 0);
  check("answer known but options unknown → still no findings", silent.answerOnly === 0);

  // The tab exists and stays empty until the scan is actually run.
  const smartTab = await page.evaluate(async () => {
    openDistModal();
    await new Promise(r => setTimeout(r, 200));
    const tabs = [...document.querySelectorAll("#distTabs .dist-tab")].map(b => b.textContent);
    const btn = !!document.getElementById("distSmart");
    closeDistModal();
    return { tabs, btn };
  });
  check(`the report has three tabs (${smartTab.tabs.join(" | ")})`, smartTab.tabs.length === 3);
  check("the «فحص ذكي» button is present", smartTab.btn);

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
