// Per-category «أربعة خيارات» switch.
//
// A few categories have always hidden the multiple-choice helper because their
// format demands it — word guessing, reactions, «من الي سجل؟», «الأقرب يفوز»,
// emoji, «قول غيرها». Each of those is recognised by id or name in code, which
// meant a NEW category that reads badly with four options needed a code change
// to opt out. This is the admin's own switch for every other category.
//
// It is global (config/noChoices, public read / admin write, mirrored in
// localStorage for offline) and reversible, and it deliberately does NOT delete
// the curated wrong answers — switching back restores them.
//
// The trap this test exists to pin: `hidesMultipleChoice()` was also being used
// to decide "don't fetch pictures for this category". Those are different
// facts. Had the new switch been folded into that call, turning multiple choice
// off on an ordinary picture category would have silently disabled its image
// fetching too.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8381;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const html = readFileSync(join(ROOT, "index.html"), "utf8");
const rules = readFileSync(join(ROOT, "firestore.rules"), "utf8");

// ── static: the setting must fit the DEPLOYED rules ─────────────────────────
// /config/{doc} allows exactly {map, updatedAt} for an admin. Storing the flag
// as a field on the category doc instead would need a rules change, because the
// categories rule field-locks its key set.
check("the switch is stored in config/noChoices, like config/hidden",
  /db\.collection\("config"\)\.doc\("noChoices"\)/.test(html));
check("...written as { map, updatedAt } so the existing /config rules accept it",
  /doc\("noChoices"\)\s*\n?\s*\.set\(\{ map: clean, updatedAt:/.test(html));
check("...and the categories rule is untouched (no new field on the category doc)",
  /hasOnly\(\['name', 'image', 'color', 'order', 'description', 'questions', 'updatedAt'\]\)/.test(rules)
  && !/noChoices/.test(rules));
check("writing it is admin-only",
  /saveNoChoices = function[\s\S]{0,120}if \(!cloudIsAdmin\) return Promise\.reject/.test(html));
check("the image-fetch gate no longer keys off hidesMultipleChoice",
  /if \(usesSpecialAnswerMedia\(cat\)\) \{ showToast\("هذه الفئة تستخدم وسائط خاصة/.test(html));

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  await page.route("**/firebasejs/**", r => r.abort());
  page.on("pageerror", e => errs.push(e.message));
  await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1200);

  const CAT = { id: "pub-switch-me", name: "تاريخ" };   // an ordinary category

  // ── default: an ordinary category keeps the helper ────────────────────────
  const before = await page.evaluate((cat) => ({
    hides: hidesMultipleChoice(cat),
    special: usesSpecialAnswerMedia(cat),
  }), CAT);
  check("by default an ordinary category offers «أربعة خيارات»", before.hides === false);

  // ── switched off ──────────────────────────────────────────────────────────
  const after = await page.evaluate((cat) => {
    setCategoryChoiceFree(cat.id, true);
    return {
      hides: hidesMultipleChoice(cat),
      flagged: isCategoryChoiceFree(cat.id),
      special: usesSpecialAnswerMedia(cat),
      stored: JSON.parse(localStorage.getItem("izzbah-nochoice-cats-v1") || "[]"),
      otherUntouched: hidesMultipleChoice({ id: "pub-other", name: "علوم" }),
    };
  }, CAT);
  check("switching it off hides «أربعة خيارات» for that category", after.hides === true);
  check("...only for that category, not every category", after.otherUntouched === false);
  check("...and it is remembered on the device", after.stored.includes(CAT.id));
  check("...while the category is still NOT treated as special-media (images keep working)",
    after.special === false && before.special === false);

  // The help bar must actually disable the slot on a question from it.
  const bar = await page.evaluate((cat) => {
    state.teams = [{ name: "A", helpers: ["fourChoices", "firstLetter", "doublePoints"], helpUsed: {}, score: 0 },
                   { name: "B", helpers: ["fourChoices", "firstLetter", "doublePoints"], helpUsed: {}, score: 0 }];
    state.teamCount = 2; state.activeTeam = 0;
    state.activeQuestion = { cat, q: { q: "؟", a: "x", points: 100 }, team: 0 };
    const el = document.createElement("div");
    renderTeamHelpBar(el, 0, "question");
    const slots = [...el.querySelectorAll(".qhelp-slot")];
    return { four: slots[0] ? slots[0].disabled : null, first: slots[1] ? slots[1].disabled : null };
  }, CAT);
  check("the four-choices slot is disabled on a question from it", bar.four === true);
  check("...and the first-letter helper is left alone", bar.first === false);

  // Pressing it anyway must be a no-op, not a way around the switch.
  const forced = await page.evaluate((cat) => {
    state.activeQuestion = { cat, q: { q: "؟", a: "x", points: 100 }, team: 0 };
    const usedBefore = !!teamHelpUsed(0).fourChoices;
    try { useHelper("fourChoices"); } catch (e) {}
    return { usedBefore, usedAfter: !!teamHelpUsed(0).fourChoices };
  }, CAT);
  check("invoking the helper directly is refused (no spent lifeline, no options)",
    forced.usedBefore === false && forced.usedAfter === false);

  // ── switching back on, and the curated wrong answers coming back with it ──
  // The switch must be a display decision, not a data deletion: the same three
  // authored options have to reappear, in the same round, after switching back.
  const back = await page.evaluate((base) => {
    const q = { points: 100, q: "س", a: "الجواب", distractors: ["خيار١", "خيار٢", "خيار٣"] };
    const cat = { id: base.id, name: base.name, questions: [q] };
    const offOptions = hidesMultipleChoice(cat) ? null : buildChoiceOptions(cat, q);
    setCategoryChoiceFree(cat.id, false);
    const onOptions = hidesMultipleChoice(cat) ? null : buildChoiceOptions(cat, q);
    return {
      hides: hidesMultipleChoice(cat),
      stored: JSON.parse(localStorage.getItem("izzbah-nochoice-cats-v1") || "[]"),
      offOptions,
      onOptions,
      distractorsIntact: (q.distractors || []).slice(),
    };
  }, CAT);
  check("switching it back on restores «أربعة خيارات»", back.hides === false);
  check("...and clears it from the stored list", !back.stored.includes(CAT.id));
  check("while switched off, no options are built at all", back.offOptions === null);
  check("switching off never deleted the authored wrong answers",
    JSON.stringify(back.distractorsIntact) === JSON.stringify(["خيار١", "خيار٢", "خيار٣"]));
  check("...so the same three curated options come back on the very next round",
    Array.isArray(back.onOptions)
    && ["خيار١", "خيار٢", "خيار٣", "الجواب"].every(v => back.onOptions.includes(v)));

  // ── it survives a reload from the local mirror (cloud is unreachable here) ─
  await page.evaluate((cat) => setCategoryChoiceFree(cat.id, true), CAT);
  await page.reload({ waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1200);
  const survived = await page.evaluate((cat) => hidesMultipleChoice(cat), CAT);
  check("the switch survives a reload", survived === true);

  // ── categories that were ALREADY choice-free stay that way, and the admin
  //    button tells the truth about them rather than offering a dead toggle ──
  const builtin = await page.evaluate(() => ({
    word: hidesMultipleChoice({ id: "charadesArabic", name: "وش الكلمة" }),
    reaction: hidesMultipleChoice({ id: "pub-r", name: "رياكشنات عمانية" }),
    nearest: hidesMultipleChoice({ id: "pub-n", name: "الأقرب يفوز" }),
    // …and none of them is flagged, so the button reads "off by nature"
    flaggedWord: isCategoryChoiceFree("charadesArabic"),
  }));
  check("the built-in choice-free categories are unaffected",
    builtin.word && builtin.reaction && builtin.nearest);
  check("...without being marked as manually switched off", builtin.flaggedWord === false);

  check("no page errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 3));
  await page.close();
} catch (e) {
  check(`threw: ${e && e.message}`, false);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
