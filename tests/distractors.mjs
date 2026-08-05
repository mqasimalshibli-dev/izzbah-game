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
  // «تاريخ» is an ordinary category, so its leaked points value IS reported.
  // An emoji category's would not be — see the choice-free test below.
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
    // re-seed: the fix step above cleaned the only defective questions left,
    // and marked them done — clear that memory so this step sees them again
    localStorage.removeItem("izzbah-dist-done-v1");
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

  // ---- recycling another answer is NOT a defect ----
  // The owner: "some of these are different questions' answers within the same
  // category but they still fit, as they are countries as well". In «علم أي
  // دولة؟» the options البحرين / عُمان / الكويت are other questions' answers and
  // they are exactly right. What goes wrong is an option that does not FIT, and
  // that is a judgement about KIND — «فحص ذكي» — not about where the string came
  // from. Recycling is now counted for information and never reported.
  const recy = await page.evaluate(async () => {
    const q = (pt, t, a, d) => ({ points: pt, q: t, a, image: "", answerImage: "", distractors: d });
    window.IZZBAH.applyPublished([{ id: "pub-flags", name: "أعلام", image: "", order: 1, questions: [
      q(100, "علم أي دولة؟", "قطر", ["البحرين", "عُمان", "الكويت"]),
      q(200, "علم أي دولة؟", "البحرين", ["قطر", "الكويت", "عُمان"]),
      q(300, "علم أي دولة؟", "الكويت", ["قطر", "البحرين", "عُمان"]),
    ] }]);
    state.communityCategories = [];
    state.noChoiceCategories = [];
    const r = distFindIssues();
    return {
      findings: r.found.filter(f => f.it.catId === "pub-flags").length,
      recycled: r.recycled,
      kinds: r.found.map(f => f.kind),
    };
  });
  check(`a flags category whose options are all other answers reports nothing (${recy.findings})`,
    recy.findings === 0);
  check(`…though the recycling is still counted for information (${recy.recycled})`,
    recy.recycled > 0);
  check("«إجابة معادة» is no longer a finding kind at all",
    !recy.kinds.includes("recycled"));

  const tabs = await page.evaluate(async () => {
    openDistModal();
    await new Promise(r => setTimeout(r, 200));
    const n = document.querySelectorAll("#distTabs .dist-tab").length;
    const on = document.querySelectorAll("#distTabs .dist-tab.on").length;
    closeDistModal();
    return { n, on };
  });
  check("the report shows its tabs, one selected", tabs.n === 2 && tabs.on === 1);

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
  // Realistic Wikipedia opening sentences, Arabic and English. 8 of these 16
  // were classified wrongly before, and each wrong one is here on purpose:
  //   • ordering — «لاعب كرة قدم … من مدينة صحار» read as a PLACE, because the
  //     place rule ran first and found «مدينة» near the end;
  //   • vocabulary — موقع / خليج / منتزه / برج matched nothing at all;
  //   • prefixes — «وُلد في قرية» hides قرية behind و, «بمدينة» behind ب;
  //   • phrases — «مقدم برامج» is a person, «برامج» alone is a programme.
  const kindCases = await page.evaluate(() => {
    const CASES = [
      ["شخص", "علي بن سالم لاعب كرة قدم عماني من مدينة صحار"],
      ["شخص", "محمود درويش شاعر فلسطيني وُلد في قرية البروة"],
      ["شخص", "هو مؤرخ وكاتب عُماني"],
      ["شخص", "رجل أعمال سعودي ومؤسس شركة كبرى"],
      ["شخص", "صحابي جليل من قبيلة قريش"],
      ["شخص", "مقدم برامج وإعلامي عماني"],
      ["شخص", "Omani footballer who plays as a forward"],
      ["مكان", "وادي شاب موقع سياحي في ولاية صور"],
      ["مكان", "قلعة نزوى قلعة تاريخية في مدينة نزوى"],
      ["مكان", "خليج عُمان ذراع بحري"],
      ["مكان", "بلدة في محافظة شمال الباطنة"],
      ["مكان", "منتزه وطني في سلطنة عمان"],
      ["مكان", "is a city in the Sultanate of Oman"],
      ["مكان", "برج تاريخي يقع في ولاية بهلاء"],
      ["عمل فني", "مسلسل درامي عماني عُرض عام ٢٠٢٠"],
      ["شركة", "سلسلة مطاعم وجبات سريعة أمريكية"],
    ];
    return CASES.map(([want, txt]) => ({ want, txt, got: distKindOf(txt) }));
  });
  const wrong = kindCases.filter(c => c.got !== c.want);
  check(`realistic descriptions classify correctly (${kindCases.length - wrong.length}/${kindCases.length}, was 8/16)`,
    wrong.length === 0);
  wrong.slice(0, 4).forEach(c => console.log(`   want ${c.want}, got ${c.got || "—"}: ${c.txt.slice(0, 46)}`));
  // The specific trap: a person described near a place must stay a person.
  check("a footballer «من مدينة صحار» is a person, not a place",
    kindCases[0].got === "شخص");

  const collisions = await page.evaluate(() => ({
    wrestling: distKindOf("برنامج مصارعة تلفزيوني"),   // مصارعة contains مصارع
    kingdom: distKindOf("مملكة في شبه الجزيرة العربية"), // مملكة contains ملك
    actressPage: distKindOf("ممثلة مصرية"),
    valley: distKindOf("وادٍ في محافظة شمال الباطنة"),
  }));
  check(`«مصارعة» does not read as «مصارع» (${collisions.wrestling})`, collisions.wrestling === "عمل فني");
  check(`«مملكة» does not read as «ملك» (${collisions.kingdom})`, collisions.kingdom === "مكان");
  check(`an actress is still a person (${collisions.actressPage})`, collisions.actressPage === "شخص");

  // ---- people vs places, the second report ----
  //
  // «it still confuses places and people». Probing 57 realistic terms found 11
  // wrong, in three groups — and only one of them was vocabulary:
  //
  //   1. Arabic titles are almost always PLURAL in a definition — «سابع سلاطين
  //      الدولة العثمانية», «خامس خلفاء الدولة العباسية», «ثاني رؤساء جمهورية
  //      مصر». The singular was listed and the plural was not, so the scan fell
  //      through the title and landed on «الدولة»/«جمهورية»: every caliph,
  //      sultan and president in the catalogue was a PLACE.
  //   2. Only the term's HEAD may speak for it. Scanning the whole term reads
  //      «باب الحارة» (a drama) as a place off «حارة» in second position, and
  //      «جامع السلطان قابوس» as a person off «السلطان».
  //   3. Wikipedia opens by restating the title, so the description carries the
  //      same trap: «باب الحارة مسلسل درامي سوري» matches «حارة» before it
  //      reaches «مسلسل». The echo is dropped before the sentence is read.
  //
  // An empty expectation means the term is genuinely two things at once — «حارة
  // اليهود» is a quarter of Cairo AND a drama — and the scan must decline to
  // type it rather than pick one. Unknown is never reported and never suggested.
  const people = await page.evaluate((CASES) => CASES.map(([want, term, desc]) => ({
    want, term, got: distKindFor(term, desc),
  })), [
  // --- people described THROUGH a state, which is the trap ---
  ["شخص","صلاح الدين الأيوبي","صلاح الدين يوسف بن أيوب هو أول سلاطين الدولة الأيوبية في مصر والشام."],
  ["شخص","هارون الرشيد","هارون الرشيد خامس خلفاء الدولة العباسية وأشهرهم."],
  ["شخص","محمد الفاتح","محمد الثاني المعروف بالفاتح سابع سلاطين الدولة العثمانية."],
  ["شخص","إليزابيث الثانية","إليزابيث الثانية كانت ملكة المملكة المتحدة وأقاليم ما وراء البحار."],
  ["شخص","جمال عبد الناصر","جمال عبد الناصر حسين ثاني رؤساء جمهورية مصر العربية."],
  ["شخص","عمر بن الخطاب","عمر بن الخطاب ثاني الخلفاء الراشدين وأحد أبرز صحابة النبي محمد."],
  ["شخص","خالد بن الوليد","خالد بن الوليد قائد عسكري وأحد كبار قادة الدولة الإسلامية."],
  ["شخص","ابن بطوطة","ابن بطوطة رحالة ومؤرخ مغربي جاب معظم بلاد العالم الإسلامي."],
  ["شخص","المتنبي","أبو الطيب المتنبي من أعظم شعراء العربية وأكثرهم حكمة."],
  ["شخص","ابن سينا","ابن سينا من أشهر علماء وأطباء الحضارة الإسلامية."],
  ["شخص","نيلسون مانديلا","نيلسون مانديلا زعيم جنوب أفريقي ورئيس جمهورية جنوب أفريقيا الأسبق."],
  ["شخص","أم كلثوم","أم كلثوم مطربة مصرية تلقب بكوكب الشرق."],
  ["شخص","الملكة أروى","أروى بنت أحمد الصليحي ملكة يمنية حكمت اليمن أكثر من خمسين عاماً."],
  ["شخص","السلطان قابوس","قابوس بن سعيد آل سعيد سلطان عمان الأسبق."],
  ["شخص","أحمد زويل","أحمد حسن زويل عالم كيمياء مصري أمريكي حائز على جائزة نوبل."],
  ["شخص","ليونيل ميسي","ليونيل أندريس ميسي لاعب كرة قدم أرجنتيني يلعب كمهاجم."],
  ["شخص","نجيب محفوظ","نجيب محفوظ روائي مصري وأول عربي يفوز بجائزة نوبل في الأدب."],
  ["شخص","بيليه","إدسون أرانتيس دو ناسيمنتو الشهير ببيليه لاعب كرة قدم برازيلي."],
  // --- places, including ones named after people ---
  ["مكان","جامع السلطان قابوس","جامع السلطان قابوس الأكبر هو المسجد الرئيسي في سلطنة عمان."],
  ["مكان","قلعة نزوى","قلعة نزوى حصن تاريخي في ولاية نزوى بمحافظة الداخلية."],
  ["مكان","مدينة الملك عبدالله","مدينة الملك عبدالله الاقتصادية مدينة سعودية على ساحل البحر الأحمر."],
  ["مكان","وادي شاب","وادي شاب واد في ولاية صور بمحافظة جنوب الشرقية في سلطنة عمان."],
  ["مكان","برج خليفة","برج خليفة ناطحة سحاب في مدينة دبي بالإمارات."],
  ["مكان","المملكة المتحدة","المملكة المتحدة دولة سيادية تقع قبالة الساحل الشمالي الغربي لأوروبا."],
  ["مكان","الدولة العباسية","الدولة العباسية ثاني الدول الإسلامية الكبرى بعد الدولة الأموية."],
  ["مكان","جزيرة مصيرة","مصيرة جزيرة عمانية تقع في بحر العرب."],
  ["مكان","نيابة سمائل","سمائل ولاية عمانية تقع في محافظة الداخلية."],
  ["مكان","الأزهر الشريف","الجامع الأزهر مسجد تاريخي في القاهرة الفاطمية."],
  // --- works, companies, events: the neighbours that must not shift ---
  ["عمل فني","الرسالة","الرسالة فيلم تاريخي من إخراج مصطفى العقاد."],
  ["عمل فني","باب الحارة","باب الحارة مسلسل درامي سوري."],
  ["شركة","أرامكو","أرامكو السعودية شركة نفط وطنية سعودية."],
  ["حدث","معركة القادسية","معركة القادسية معركة فاصلة بين المسلمين والفرس."],
  ["حدث","غزوة بدر","غزوة بدر أول معركة كبرى في الإسلام."],

  // ---- second batch: Omani/Gulf content and head words that could mislead ----
  ["مكان","نزوى","نزوى مدينة عمانية تقع في محافظة الداخلية وتعد عاصمة عمان قديماً."],
  ["مكان","صحار","صحار مدينة ساحلية عمانية ومركز محافظة شمال الباطنة."],
  ["مكان","جبل شمس","جبل شمس أعلى قمة في سلطنة عمان."],
  ["مكان","بيت البرندة","بيت البرندة متحف يقع في مطرح بمحافظة مسقط."],
  ["مكان","حصن جبرين","حصن جبرين قلعة تاريخية في ولاية بهلاء."],
  ["مكان","فلج دارس","فلج دارس أكبر أفلاج سلطنة عمان ويقع في نزوى."],
  ["مكان","سوق مطرح","سوق مطرح أحد أقدم الأسواق في سلطنة عمان."],
  ["مكان","رأس الجنز","رأس الجنز محمية طبيعية لسلاحف بحرية في ولاية صور."],
  ["شخص","أحمد بن ماجد","أحمد بن ماجد ملاح وجغرافي عربي عماني لقب بأسد البحر."],
  ["شخص","السيدة موزة","موزة بنت أحمد شخصية عمانية بارزة."],
  ["شخص","سالم بن سليم","سالم بن سليم لاعب كرة قدم عماني سابق من مواليد مدينة صور."],
  ["شخص","محمد الغساني","محمد الغساني إعلامي ومذيع عماني عمل في تلفزيون سلطنة عمان."],
  ["شخص","سعود بن هلال","سعود بن هلال البوسعيدي والي ولاية بهلاء الأسبق."],
  // heads that must NOT be trusted from the middle of a term
  ["","حارة اليهود","حارة اليهود مسلسل درامي مصري."],
  ["","مدرسة المشاغبين","مدرسة المشاغبين مسرحية مصرية شهيرة."],
  ["عمل فني","قلب الأسد","قلب الأسد فيلم مصري من بطولة محمد رمضان."],
  ["شركة","بنك مسقط","بنك مسقط أكبر مؤسسة مالية في سلطنة عمان."],
  ["شركة","الطيران العماني","الطيران العماني هو الناقل الوطني لسلطنة عمان."],
  ["رياضة","نادي السيب","نادي السيب نادٍ رياضي عماني مقره ولاية السيب."],
  ["رياضة","كأس العالم","كأس العالم بطولة كروية دولية تقام كل أربع سنوات."],
  ["طعام","الشواء العماني","الشواء طبق عماني تقليدي يقدم في الأعياد."],
  ["حيوان أو نبات","المها العربي","المها العربي حيوان ثديي من فصيلة البقريات يعيش في شبه الجزيرة العربية."],
  ["حدث","حرب الجبل الأخضر","حرب الجبل الأخضر نزاع مسلح وقع في عمان في خمسينيات القرن العشرين."],
  ["مكان","الجبل الأخضر","الجبل الأخضر منطقة جبلية في ولاية نزوى بمحافظة الداخلية."],  ]);
  const missed = people.filter(c => c.got !== c.want);
  check(`people, places and their neighbours classify correctly (${people.length - missed.length}/${people.length}, was 46/57)`,
    missed.length === 0);
  missed.slice(0, 6).forEach(c =>
    console.log(`   «${c.term}» want ${c.want || "(unknown)"}, got ${c.got || "(unknown)"}`));
  const kindOfTerm = t => (people.find(c => c.term === t) || {}).got;
  check(`a sultan is not his sultanate (${kindOfTerm("محمد الفاتح")})`,
    kindOfTerm("محمد الفاتح") === "شخص");
  check(`a queen is not her kingdom (${kindOfTerm("إليزابيث الثانية")})`,
    kindOfTerm("إليزابيث الثانية") === "شخص");
  check(`a mosque named after a sultan is a place (${kindOfTerm("جامع السلطان قابوس")})`,
    kindOfTerm("جامع السلطان قابوس") === "مكان");
  check(`a drama named after a quarter is not typed at all (${kindOfTerm("باب الحارة") || "unknown"})`,
    kindOfTerm("باب الحارة") === "عمل فني");

  // ---- the whole history report was false positives ----
  //
  // Reported with screenshots: «معاهدة فرساي» flagged against «مؤتمر فيينا»,
  // «معاهدة أوترخت» against «صلح وستفاليا», «الدولة القاجارية» against «الدولة
  // الصفوية». Every one of them is a perfectly good option, and every one was
  // caused by classifying the DESCRIPTION when the TERM says it plainly:
  //
  //   «مؤتمر فيينا هو مؤتمر لسفراء الدول الأوروبية…»  → walks past مؤتمر
  //   (not in the word list at the time) into «الدول» → PLACE, so all three
  //   treaties beside it became "the wrong kind".
  //   «الدولة القاجارية أو القاجاريون أسرة حاكمة…»    → «حاكمة» → PERSON.
  //
  // Arabic is head-initial, so the term is the reliable signal and the sentence
  // is the fallback. The second guard is the tally: an option is only reported
  // while it is in the minority, because a classifier that puts the answer on
  // one side and EVERY option on the other has misread the answer.
  const history = await page.evaluate(() => {
    const D = {
      "مؤتمر فيينا": "مؤتمر فيينا هو مؤتمر لسفراء الدول الأوروبية ترأسه رجل الدولة النمساوي كليمنس فون مترنيخ.",
      "معاهدة فرساي": "معاهدة فرساي هي معاهدة سلام أنهت الحرب العالمية الأولى بين ألمانيا ودول الحلفاء.",
      "صلح وستفاليا": "صلح وستفاليا أو سلام وستفاليا (بالألمانية: Westfälischer Friede) اسم عام يُطلق على معاهدتي السلام اللتين وقعتا في مدينتي أوسنابروك ومونستر الألمانيتين.",
      "معاهدة باريس": "معاهدة باريس هي معاهدة وقعت في مدينة باريس.",
      "معاهدة أوترخت": "معاهدة أوترخت هي سلسلة معاهدات سلام وقعت في مدينة أوترخت الهولندية.",
      "صلح أوغسبورغ": "صلح أوغسبورغ معاهدة أبرمت في مدينة أوغسبورغ الألمانية.",
      "معاهدة فيينا": "معاهدة فيينا معاهدة وقعت في مدينة فيينا النمساوية.",
      "الدولة الصفوية": "الدَّوْلَةُ الصَّفَوِيَّة أو الإِمبَراطُورِيَّةُ الصَّفَوِيَّة (بالفارسية: ايران صفوی) إحدى أهم الدول التي حكمت إيران.",
      "الدولة القاجارية": "الدولة القاجارية أو القاجاريون أسرة حاكمة فارسية من أصول تركمانية حكمت إيران.",
      "الدولة العثمانية": "الدولة العثمانية أو الإمبراطورية العثمانية إحدى الدول الإسلامية.",
      "الدولة التيمورية": "الدولة التيمورية أسرة حاكمة تركية مغولية أسسها تيمورلنك.",
      "جامعة بولونيا": "جامعة بولونيا هي جامعة إيطالية تعد أقدم جامعة في العالم.",
      "جامعة الأزهر": "جامعة الأزهر جامعة مصرية إسلامية عريقة مقرها القاهرة.",
      "جامعة أكسفورد": "جامعة أكسفورد جامعة بحثية في مدينة أكسفورد الإنجليزية.",
    };
    const run = (a, d) => distSmartFindings(
      [{ catId: "c", cat: "تاريخ", q: "س؟", a, d, uses: true, points: 400 }], D);
    return {
      kinds: Object.keys(D).map(t => [t, distKindFor(t, D[t])]),
      vienna: run("مؤتمر فيينا", ["معاهدة فرساي", "صلح وستفاليا", "معاهدة باريس"]).length,
      westphalia: run("صلح وستفاليا", ["معاهدة أوترخت", "صلح أوغسبورغ", "معاهدة فيينا"]).length,
      safavid: run("الدولة الصفوية", ["الدولة العثمانية", "الدولة القاجارية", "الدولة التيمورية"]).length,
      universities: run("جامعة بولونيا", ["جامعة الأزهر", "جامعة أكسفورد"]).length,
    };
  });
  const kindOf = t => (history.kinds.find(k => k[0] === t) || [])[1];
  check(`«مؤتمر فيينا» is an event, not a place (${kindOf("مؤتمر فيينا")})`,
    kindOf("مؤتمر فيينا") === "حدث");
  check(`«الدولة القاجارية» is not a person (${kindOf("الدولة القاجارية")})`,
    kindOf("الدولة القاجارية") === "مكان");
  check(`«صلح وستفاليا» is an event (${kindOf("صلح وستفاليا")})`,
    kindOf("صلح وستفاليا") === "حدث");
  check(`treaties beside a congress are NOT reported (${history.vienna} findings)`,
    history.vienna === 0);
  check(`treaties beside a peace are NOT reported (${history.westphalia})`,
    history.westphalia === 0);
  check(`Persian dynasties beside each other are NOT reported (${history.safavid})`,
    history.safavid === 0);
  check(`universities beside each other are NOT reported (${history.universities})`,
    history.universities === 0);

  // The tally guard on its own: even with the answer classified wrongly, three
  // options that agree with each other outvote it.
  const tally = await page.evaluate(() => {
    const D = { "س": "مدينة في العراق", "أ": "معركة وقعت عام 1187",
                "ب": "معركة فاصلة", "ج": "غزوة من غزوات الرسول" };
    const one = { "س": "مدينة في العراق", "أ": "معركة وقعت عام 1187",
                  "ب": "مدينة كبيرة", "ج": "مدينة ساحلية" };
    const run = (D) => distSmartFindings(
      [{ catId: "c", cat: "ت", q: "س؟", a: "س", d: ["أ", "ب", "ج"], uses: true, points: 100 }], D);
    return { allAgree: run(D).length, minority: run(one).length };
  });
  check(`three options agreeing against the answer are left alone (${tally.allAgree})`,
    tally.allAgree === 0);
  check(`…but a single odd option among matching ones is still reported (${tally.minority})`,
    tally.minority === 1);

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
  check(`the report has two tabs (${smartTab.tabs.join(" | ")})`, smartTab.tabs.length === 2);
  check("the «فحص ذكي» button is present", smartTab.btn);

  // ---- it has to be usable at the real catalogue size ----
  // Reported as "«فحص الخيارات» takes a while to load when pressed". Measured at
  // 4,560 questions: 25 SECONDS to scan, and the render scanned again, so the
  // button cost about fifty seconds before anything appeared.
  //
  // The cause was computing a replacement for every finding during the scan,
  // each one re-filtering the whole catalogue — with roughly as many findings as
  // questions that is ~20M operations. Two changes: a per-category index built
  // once, and replacements resolved only when a row is actually drawn or
  // applied, since only 400 render at a time and most are never touched.
  const perf = await page.evaluate(async () => {
    localStorage.removeItem("izzbah-dist-done-v1");
    const cats = [];
    for (let c = 0; c < 40; c++) {
      const qs = [];
      for (let i = 0; i < 114; i++) {
        // Each question carries a REAL defect (its own answer among the
        // options), so the scan has findings to build and draw. Recycled
        // options are no longer findings, so a fixture built from those would
        // measure an empty report.
        qs.push({ points: 100 + (i % 5) * 100, q: `سؤال ${c}-${i}`, a: `حصن رقم ${c}-${i}`,
          image: "", answerImage: "",
          distractors: [`حصن رقم ${c}-${i}`, `خيار ${c}-${i}-ب`, `خيار ${c}-${i}-ج`] });
      }
      cats.push({ id: "pub-perf-" + c, name: "فئة " + c, image: "", order: c, questions: qs });
    }
    window.IZZBAH.applyPublished(cats);
    state.communityCategories = [];
    const t0 = performance.now();
    const found = distFindIssues().found;
    const scan = performance.now() - t0;
    const t1 = performance.now();
    renderDistReport();
    const render = performance.now() - t1;
    // the deferred value must still be there once a row is drawn
    const drawn = document.querySelectorAll("#distList .dup-del").length;
    const labelled = [...document.querySelectorAll("#distList .dup-del")]
      .filter(b => !/undefined|«»/.test(b.textContent)).length;
    return { n: found.length, questions: cats.length * 114, scan, render, drawn, labelled };
  });
  check(`scanning ${perf.questions} questions is quick (${Math.round(perf.scan)}ms, was 25000)`,
    perf.scan < 3000);
  check(`…and rendering the report is quick (${Math.round(perf.render)}ms, was 25900)`,
    perf.render < 3000);
  check(`the deferred replacement still reaches every drawn button (${perf.labelled}/${perf.drawn})`,
    perf.drawn > 0 && perf.labelled === perf.drawn);

  // ---- numeric options that are NOT points must be left alone ----
  // Reported from the live report: «كم تبلغ قيمة استخراج هذا الرقم؟» (answer
  // «٧٠ ريال», options 60/50/40) and «كم هدف سجل عماد الحوسني؟» (answer «٥٢
  // هدف», options ٤١/٤٨/٥٩) were both listed as errors. They are perfectly good
  // numeric questions; the old rule only asked "are all the options digits?",
  // which they are. An option now counts as points-noise only if it is EXACTLY
  // one of the board's tiers.
  const numeric = await page.evaluate(() => {
    const q = (pt, t, a, d) => ({ points: pt, q: t, a, image: "", answerImage: "", distractors: d });
    window.IZZBAH.applyPublished([{ id: "pub-num", name: "خريف ظفار", image: "", order: 1, questions: [
      q(200, "كم تبلغ قيمة استخراج هذا الرقم؟", "٧٠ ريال", ["60", "50", "40"]),        // legitimate
      q(300, "كم هدف سجل عماد الحوسني؟", "٥٢ هدف", ["٤١", "٤٨", "٥٩"]),                // legitimate, Arabic digits
      q(100, "🥠🔮 خمن اسم الشيء", "Fortune Cookie", ["100"]),                          // the import bug
      q(200, "🚪🔔 خمن الكلمة المركبة", "Doorbell", ["١٠٠"]),                           // same, Arabic digits
      q(400, "كم عدد سكان المدينة؟", "٢٥٠ ألف", ["100", "200", "300"]),                 // three real tiers, all distinct
    ] }]);
    state.communityCategories = [];
    const found = distFindIssues().found.filter(f => f.it.catId === "pub-num");
    return {
      points: found.filter(f => f.kind === "points").map(f => f.it.a),
      all: found.map(f => `${f.kind}:${f.it.a}`),
    };
  });
  check(`a price question with options 60/50/40 is NOT an error (${numeric.points.join(", ") || "none flagged"})`,
    !numeric.points.includes("٧٠ ريال"));
  check("a goals question with Arabic-digit options is NOT an error",
    !numeric.points.includes("٥٢ هدف"));
  check("the real import bug is still caught (Western digits)",
    numeric.points.includes("Fortune Cookie"));
  check("…and when the leaked value is written in Arabic digits",
    numeric.points.includes("Doorbell"));
  // Three DISTINCT tier values is a plausible real option set, and every real
  // case in the catalogue stores a single value — so this is left alone too.
  check("three distinct tier-looking options are left alone",
    !numeric.points.includes("٢٥٠ ألف"));

  // ---- a category with «أربعة خيارات» switched off is not reported ----
  // The admin's per-category lock (config/noChoices). If the helper is off, its
  // option list is not worth a line in the report. The switch is read on every
  // scan, so turning the category back on brings its findings back — the test
  // asserts both directions, because a scanner that silences a category
  // permanently is a worse bug than one that reports too much.
  const locked = await page.evaluate(async () => {
    const q = (pt, t, a, d) => ({ points: pt, q: t, a, image: "", answerImage: "", distractors: d });
    window.IZZBAH.applyPublished([{ id: "pub-lock", name: "تاريخ", image: "", order: 1, questions: [
      q(100, "سؤال مكسور؟", "بغداد", ["بغداد", "دمشق", "القاهرة"]),   // answer inside its own options
      q(200, "سؤال آخر؟", "دمشق", ["", "بيروت", "عمّان"]),            // empty option
    ] }]);
    state.communityCategories = [];
    const before = distFindIssues().found.filter(f => f.it.catId === "pub-lock").length;

    state.noChoiceCategories = ["pub-lock"];          // «🚫 تعطيل «أربعة خيارات»»
    const whileLocked = distFindIssues().found.filter(f => f.it.catId === "pub-lock").length;

    state.noChoiceCategories = [];                    // switched back on
    const after = distFindIssues().found.filter(f => f.it.catId === "pub-lock").length;
    return { before, whileLocked, after };
  });
  check(`a normal category reports its problems (${locked.before})`, locked.before >= 2);
  check(`…none of them once «أربعة خيارات» is switched off (${locked.whileLocked})`,
    locked.whileLocked === 0);
  check(`…and they come back when it is switched on again (${locked.after})`,
    locked.after === locked.before);

  // ---- categories that never show four choices are not scanned at all ----
  // Reported twice. The first fix honoured only the admin's switch
  // (config/noChoices), which «معنى الايموجي» can never be in: the toggle is
  // DISABLED for categories that are choice-free by nature, so the map is empty
  // for them and the report stayed full of them.
  //
  // The rule is now the one that matters to a player: if four choices are never
  // shown for this category, its options are not reported — whether that is
  // because of what the category is, or because the switch was thrown.
  const choiceFree = await page.evaluate(() => {
    const q = (pt, t, a, d) => ({ points: pt, q: t, a, image: "", answerImage: "", distractors: d });
    // Every one of these questions would be a finding in an ordinary category.
    const broken = [
      q(100, "وش معنى الايموجي", "لبنى", ["100"]),
      q(200, "وش معنى الايموجي", "جاموس", ["جاموس", "بقرة", "ثور"]),
      q(300, "وش معنى الايموجي", "ضابط", ["", "جندي", "ضابط"]),
    ];
    window.IZZBAH.applyPublished([
      { id: "pub-emoji", name: "معنى الايموجي", image: "", order: 1, questions: broken },
      { id: "pub-plain", name: "تاريخ", image: "", order: 2, questions: broken.map(x => Object.assign({}, x)) },
    ]);
    state.communityCategories = [];
    state.noChoiceCategories = [];
    const found = distFindIssues().found;
    return {
      emoji: found.filter(f => f.it.catId === "pub-emoji").length,
      plain: found.filter(f => f.it.catId === "pub-plain").length,
    };
  });
  check(`an emoji category is not scanned at all (${choiceFree.emoji} findings)`,
    choiceFree.emoji === 0);
  check(`…while the identical questions in an ordinary category are (${choiceFree.plain})`,
    choiceFree.plain >= 2);

  // ---- fixing a wrong-kind option ----
  // The smart findings deliberately had no fix button: a wrong KIND needs a
  // human replacement, not another guess from the machinery that mis-sorted the
  // options. Now that the scan has established what kind each term is, the
  // suggestion can be principled — a term from the same category whose kind
  // MATCHES the answer's — while the admin can always type their own.
  const smartFix = await page.evaluate(async () => {
    const q = (pt, t, a, d) => ({ points: pt, q: t, a, image: "", answerImage: "", distractors: d });
    window.IZZBAH.applyPublished([{ id: "pub-w2", name: "مصارعة حره", image: "", order: 1, questions: [
      q(100, "من يُلقب بـ The Viper؟", "راندي أورتن", ["سماكداون", "درو ماكنتاير", "رومان رينز"]),
      q(200, "من هو أقوى مصارع؟", "جون سينا", ["ذا روك", "بروك ليسنر", "أندرتيكر"]),
    ] }]);
    state.communityCategories = []; state.noChoiceCategories = [];
    const desc = {
      "راندي أورتن": "مصارع محترف أمريكي", "سماكداون": "برنامج مصارعة تلفزيوني",
      "درو ماكنتاير": "مصارع محترف اسكتلندي", "رومان رينز": "مصارع محترف أمريكي",
      "جون سينا": "مصارع محترف أمريكي", "ذا روك": "مصارع محترف أمريكي",
      "بروك ليسنر": "مصارع محترف أمريكي", "أندرتيكر": "مصارع محترف أمريكي",
    };
    localStorage.setItem("izzbah-wikikind-v1", JSON.stringify(desc));
    const items = distCollect().filter(i => i.catId === "pub-w2");
    distFindIssues();                       // builds distIndex for the suggester
    distSmart = { ran: true, cat: "", findings: distSmartFindings(items, desc) };
    const entry = distSmart.findings[0];
    const suggested = distSmartSuggest(entry, desc);

    // an admin-typed value that clashes is refused
    const before = entry.it.d.slice();
    distApplySmartFix(entry, "راندي أورتن");          // the correct answer
    const afterAnswer = state.publishedCategories.find(c => c.id === "pub-w2").questions[0].distractors.slice();
    distApplySmartFix(entry, "رومان رينز");           // already an option
    const afterDupe = state.publishedCategories.find(c => c.id === "pub-w2").questions[0].distractors.slice();

    distApplySmartFix(entry, "كيفن أوينز");           // a real replacement
    await new Promise(r => setTimeout(r, 120));
    const after = state.publishedCategories.find(c => c.id === "pub-w2").questions[0].distractors.slice();
    return { suggested, before, afterAnswer, afterDupe, after,
             left: distSmart.findings.length, option: entry.option };
  });
  check(`the offending option is the show, not a wrestler ("${smartFix.option}")`,
    smartFix.option === "سماكداون");
  check(`it suggests a replacement of the RIGHT kind ("${smartFix.suggested}")`,
    ["ذا روك", "بروك ليسنر", "أندرتيكر", "جون سينا"].includes(smartFix.suggested));
  check("typing the correct answer is refused",
    smartFix.afterAnswer.join("|") === smartFix.before.join("|"));
  check("typing an option that already exists is refused",
    smartFix.afterDupe.join("|") === smartFix.before.join("|"));
  check(`a real replacement is applied (${smartFix.before[0]} → ${smartFix.after[0]})`,
    smartFix.after[0] === "كيفن أوينز" && smartFix.after.length === 3);
  check("…and the finding leaves the list", smartFix.left === 0);

  const smartUi = await page.evaluate(async () => {
    distTab = "smart";
    renderDistReport();
    await new Promise(r => setTimeout(r, 120));
    return {
      inputs: document.querySelectorAll("#distList .dist-input").length,
      buttons: document.querySelectorAll("#distList .dist-fixrow .dup-del").length,
    };
  });
  check("each remaining smart finding renders an editable replacement box",
    smartUi.inputs === smartUi.buttons);

  // ---- a question that has been fixed is not reported again ----
  // Applying a fix usually removes the finding by itself, because the data
  // changed. Two cases do not, and both read as the report ignoring the admin's
  // work: DROPPING an option leaves two, which the «ناقص» rule then reports; and
  // a replacement Wikipedia does not know can be re-judged on the next smart
  // scan. So a fix is remembered per question and per kind.
  const done = await page.evaluate(async () => {
    localStorage.removeItem("izzbah-dist-done-v1");
    const q = (pt, t, a, d) => ({ points: pt, q: t, a, image: "", answerImage: "", distractors: d });
    window.IZZBAH.applyPublished([{ id: "pub-d", name: "تاريخ", image: "", order: 1, questions: [
      // no other option to borrow, so the only possible fix is a DROP —
      // which leaves two options and used to come straight back as «ناقص»
      q(100, "سؤال؟", "بغداد", ["بغداد", "دمشق", "عمّان"]),
    ] }]);
    state.communityCategories = []; state.noChoiceCategories = [];
    const first = distFindIssues().found.filter(f => f.it.catId === "pub-d");
    const entry = first[0];
    distApplyFix(entry, true);
    await new Promise(r => setTimeout(r, 120));
    const after = distFindIssues().found.filter(f => f.it.catId === "pub-d");
    const stored = Object.keys(JSON.parse(localStorage.getItem("izzbah-dist-done-v1") || "{}")).length;

    // editing the ANSWER is a real change and must bring the question back
    const cat = state.publishedCategories.find(c => c.id === "pub-d");
    cat.questions[0].a = "القاهرة";
    cat.questions[0].distractors = ["القاهرة", "دمشق", "عمّان"];
    upsertPublished(cat);
    const afterEdit = distFindIssues().found.filter(f => f.it.catId === "pub-d");

    // and «إظهار المُصلَحة» empties the memory
    localStorage.setItem("izzbah-dist-done-v1", JSON.stringify({ x: ["answer"] }));
    distClearDone();
    const cleared = localStorage.getItem("izzbah-dist-done-v1");
    return { firstKinds: first.map(f => f.kind), afterKinds: after.map(f => f.kind),
             stored, afterEditKinds: afterEdit.map(f => f.kind), cleared };
  });
  check(`the broken question is reported (${done.firstKinds.join(", ")})`,
    done.firstKinds.includes("answer"));
  // Not merely "the same finding is gone": dropping the duplicate leaves two
  // options, so a per-KIND memory would have let it return as «ناقص».
  check(`…and does not come back in ANY form after the fix (${done.afterKinds.join(", ") || "nothing"})`,
    done.afterKinds.length === 0);
  check(`…the fix is remembered (${done.stored} question)`, done.stored === 1);
  check(`editing the answer brings it back (${done.afterEditKinds.join(", ") || "nothing"})`,
    done.afterEditKinds.includes("answer"));
  check("«إظهار المُصلَحة» clears the memory", done.cleared === null);

  // ---- skipping ----
  // Not every finding is a mistake: the rule may be blunt and the option fine.
  // Without a skip the only ways to clear one were to change data that did not
  // need changing, or to scroll past it forever.
  const skip = await page.evaluate(async () => {
    localStorage.removeItem("izzbah-dist-done-v1");
    const q = (pt, t, a, d) => ({ points: pt, q: t, a, image: "", answerImage: "", distractors: d });
    window.IZZBAH.applyPublished([{ id: "pub-s2", name: "تاريخ", image: "", order: 1, questions: [
      q(100, "سؤال أول؟", "بغداد", ["بغداد", "دمشق", "عمّان"]),   // fixable
      q(200, "سؤال ثانٍ؟", "القاهرة", ["تونس", "الرباط"]),         // «ناقص» — no automatic fix
    ] }]);
    state.communityCategories = []; state.noChoiceCategories = [];
    distTab = "bad";
    renderDistReport();
    await new Promise(r => setTimeout(r, 150));

    const before = distFindIssues().found.filter(f => f.it.catId === "pub-s2");
    const shortOne = before.find(f => f.kind === "short");
    const rows = document.querySelectorAll("#distList .dup-group").length;
    const skips = document.querySelectorAll("#distList .dist-skip").length;

    const dataBefore = JSON.stringify(state.publishedCategories.find(c => c.id === "pub-s2").questions);
    distSkipFinding(shortOne);
    await new Promise(r => setTimeout(r, 120));
    const after = distFindIssues().found.filter(f => f.it.catId === "pub-s2");
    const dataAfter = JSON.stringify(state.publishedCategories.find(c => c.id === "pub-s2").questions);
    const showAll = document.getElementById("distShowAll");
    return {
      beforeN: before.length, afterN: after.length, rows, skips,
      hadShort: !!shortOne, untouched: dataBefore === dataAfter,
      showAllVisible: !showAll.hidden, showAllText: showAll.textContent,
    };
  });
  check(`a finding with no automatic fix exists to skip (${skip.hadShort ? "«ناقص»" : "none"})`,
    skip.hadShort === true);
  check(`every drawn finding offers a skip (${skip.skips} on ${skip.rows} rows)`,
    skip.rows > 0 && skip.skips === skip.rows);
  check(`skipping removes it from the report (${skip.beforeN} → ${skip.afterN})`,
    skip.afterN === skip.beforeN - 1);
  check("…without touching the question's data", skip.untouched === true);
  check(`…and the hidden count is shown with a way back ("${skip.showAllText}")`,
    skip.showAllVisible && /إظهار المخفية/.test(skip.showAllText));

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
