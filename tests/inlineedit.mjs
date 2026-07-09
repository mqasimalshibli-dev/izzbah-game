// E2E for admin inline editing: adjusting question text / answer / points
// straight from the table rows, and editing the curated four-choices
// distractors both from the row chip and the editor modal.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8319;
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

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true); });
  await page.evaluate(() => { document.getElementById("adminEntry").click(); });
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById("adminChoiceContent").click());
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    state.adminCat = { id: "pub-t", name: "اختبار", image: "", color: "#9e1322", custom: false, published: true, order: 0,
      questions: [
        { points: 100, q: "سؤال أول؟", a: "جواب أول", image: "", answerImage: "" },
        { points: 200, q: "سؤال ثانٍ؟", a: "جواب ثانٍ", image: "", answerImage: "", distractors: ["خطأ١", "خطأ٢", "خطأ٣"] },
      ] };
    clearAdminUndo(); populateAdminFilter(); renderAdminTable(); renderAdminCatHead();
  });
  await page.waitForTimeout(200);

  // ---- 1) inline question-text edit from the row ----
  const qEdit = await page.evaluate(async () => {
    const cell = document.querySelector("#adminRows tr td.col-q");
    cell.click();
    const ed = cell.querySelector("textarea.q-inline-edit");
    if (!ed) return { ok: false };
    const opened = ed.value;
    ed.value = "سؤال معدّل من السطر؟";
    ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    return { ok: true, opened, stored: state.adminCat.questions[0].q, dirty: state.adminDirty };
  });
  check("clicking the question cell opens an inline editor pre-filled", qEdit.ok && qEdit.opened === "سؤال أول؟");
  check("Enter commits the inline question edit to the data", qEdit.stored === "سؤال معدّل من السطر؟" && qEdit.dirty);

  // ---- 2) inline answer edit; Escape cancels ----
  const aEdit = await page.evaluate(async () => {
    const cell = document.querySelector("#adminRows tr td.col-a");
    cell.click();
    let ed = cell.querySelector("input.q-inline-edit");
    ed.value = "لن يُحفظ";
    ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    const afterCancel = state.adminCat.questions[0].a;
    cell.click();
    ed = cell.querySelector("input.q-inline-edit");
    ed.value = "جواب معدّل";
    ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    return { afterCancel, afterSave: state.adminCat.questions[0].a };
  });
  check("Escape cancels an inline edit (data untouched)", aEdit.afterCancel === "جواب أول");
  check("inline answer edit commits", aEdit.afterSave === "جواب معدّل");

  // ---- 3) inline points edit refreshes the points filter too ----
  const pEdit = await page.evaluate(async () => {
    const cell = document.querySelector("#adminRows tr td.col-pts");
    cell.click();
    const ed = cell.querySelector("input.q-inline-edit");
    ed.value = "500";
    ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const opts = [...document.querySelectorAll("#adminFilter option")].map(o => o.value);
    return { pts: state.adminCat.questions[0].points, filterHas500: opts.includes("500") };
  });
  check("inline points edit commits and updates the filter", pEdit.pts === 500 && pEdit.filterHas500);

  // ---- 4) undo covers inline edits ----
  const undo = await page.evaluate(async () => {
    undoAdminStep();
    await new Promise(r => setTimeout(r, 150));
    return state.adminCat.questions[0].points;
  });
  check("undo reverts the last inline edit", undo === 100);

  // ---- 5) distractors chip: count shown, expandable editor, save ----
  const chip = await page.evaluate(() => {
    const chips = [...document.querySelectorAll("#adminRows .q-dist-chip")].map(c => c.textContent);
    return chips;
  });
  check("rows show a distractors chip (count for curated, + for none)",
    chip.length === 2 && chip.some(t => /3|٣/.test(t)) && chip.some(t => t.includes("+")));

  const distEdit = await page.evaluate(async () => {
    // the first row (no distractors) — add a set from the chip
    const rows = [...document.querySelectorAll("#adminRows tr:not(.dist-row)")];
    const first = rows.find(r => r.querySelector(".q-dist-chip.empty"));
    first.querySelector(".q-dist-chip").click();
    await new Promise(r => setTimeout(r, 150));
    const drow = document.querySelector("#adminRows .dist-row");
    if (!drow) return { ok: false };
    const inputs = [...drow.querySelectorAll("input")];
    inputs[0].value = "بديل ١"; inputs[1].value = "بديل ٢"; inputs[2].value = "بديل ٣";
    drow.querySelector(".dist-save").click();
    await new Promise(r => setTimeout(r, 200));
    return { ok: true, stored: state.adminCat.questions[0].distractors };
  });
  check("the chip expands an inline editor and saves 3 distractors",
    distEdit.ok && JSON.stringify(distEdit.stored) === JSON.stringify(["بديل ١", "بديل ٢", "بديل ٣"]));

  // ---- 6) the editor modal carries the distractor fields ----
  const modal = await page.evaluate(async () => {
    openAdminQuestion(0);
    await new Promise(r => setTimeout(r, 150));
    const d1 = document.getElementById("adminQDist1").value;
    document.getElementById("adminQDist2").value = "بديل ٢ معدّل";
    saveAdminQuestion();
    await new Promise(r => setTimeout(r, 200));
    return { d1, stored: state.adminCat.questions[0].distractors };
  });
  check("editor modal pre-fills distractors and saves edits",
    modal.d1 === "بديل ١" && modal.stored.includes("بديل ٢ معدّل"));

  // ---- 7) word categories hide the distractors chip ----
  const wordChip = await page.evaluate(() => {
    state.adminCat = { id: "charadesArabic", name: "وش الكلمة عربي", image: "", color: "", custom: false, published: true, order: 0,
      questions: [{ points: 100, q: "", a: "كلمة", image: "", answerImage: "" }] };
    clearAdminUndo(); populateAdminFilter(); renderAdminTable();
    return document.querySelectorAll("#adminRows .q-dist-chip").length;
  });
  check("word categories (no four-choices) show no distractors chip", wordChip === 0);

  // ---- 8) bulk "generate missing distractors" from same-category answers ----
  const bulk = await page.evaluate(async () => {
    // a category with enough same-type answers; some questions lack distractors
    state.adminCat = { id: "pub-fill", name: "عواصم", image: "", color: "#9e1322", custom: false, published: true, order: 0,
      questions: [
        { points: 100, q: "عاصمة عُمان؟", a: "مسقط", image: "", answerImage: "" },
        { points: 200, q: "عاصمة مصر؟", a: "القاهرة", image: "", answerImage: "" },
        { points: 300, q: "عاصمة فرنسا؟", a: "باريس", image: "", answerImage: "" },
        { points: 400, q: "عاصمة اليابان؟", a: "طوكيو", image: "", answerImage: "", distractors: ["أوساكا", "كيوتو", "ناغويا"] },
      ] };
    clearAdminUndo(); populateAdminFilter(); renderAdminTable();
    fillMissingDistractors();
    await new Promise(r => setTimeout(r, 200));
    const qs = state.adminCat.questions;
    // each of the first three now has 3 distractors, none equal to its answer,
    // and every distractor is a real other answer from THIS category
    const answers = new Set(qs.map(q => q.a));
    const ok = qs.slice(0, 3).every(q =>
      Array.isArray(q.distractors) && q.distractors.length === 3
      && !q.distractors.includes(q.a)
      && q.distractors.every(dd => answers.has(dd)));
    // the already-curated one is left untouched
    const untouched = JSON.stringify(qs[3].distractors) === JSON.stringify(["أوساكا", "كيوتو", "ناغويا"]);
    return { ok, untouched };
  });
  check("generate-missing fills fitting distractors from same-category answers", bulk.ok);
  check("generate-missing leaves already-curated questions untouched", bulk.untouched);

  // undo restores the pre-fill state
  const bulkUndo = await page.evaluate(async () => {
    undoAdminStep();
    await new Promise(r => setTimeout(r, 150));
    return state.adminCat.questions[0].distractors;
  });
  check("undo reverts a bulk distractor fill", bulkUndo === undefined || bulkUndo.length === 0);

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
