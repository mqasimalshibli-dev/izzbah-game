// E2E for the admin "undo last step" button.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8294;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  // Never hit the real Firebase from tests: abort the SDK load so the game
  // runs offline on built-in content (no production Firestore reads/quota).
  await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {})); // auto-accept the delete confirm
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

const qCount = () => page.evaluate(() => (state.adminCat && state.adminCat.questions.length) || 0);
const undoDisabled = () => page.evaluate(() => document.getElementById("adminUndo").disabled);

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1600);
  await page.evaluate(() => { window.IZZBAH.applyAuth(true); window.IZZBAH.applyAdmin(true); });
  await page.waitForTimeout(150);
  // the gear now opens a chooser; pick "content management" to reach the panel
  await page.evaluate(() => document.getElementById("adminEntry").click());
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById("adminChoiceContent").click());
  await page.waitForTimeout(400);

  check("undo button starts disabled (no steps yet)", await undoDisabled());
  const start = await qCount();

  // --- add a question ---
  await page.evaluate(() => {
    document.getElementById("adminAddQuestion").click();
  });
  await page.waitForTimeout(150);
  await page.fill("#adminQPoints", "300");
  await page.fill("#adminQText", "سؤال تجريبي للتراجع؟");
  await page.fill("#adminQAnswer", "إجابة");
  await page.evaluate(() => document.getElementById("adminQSave").click());
  await page.waitForTimeout(200);
  check("adding a question increases the count", (await qCount()) === start + 1);
  check("undo button enabled after a change", !(await undoDisabled()));

  // --- undo the add ---
  await page.evaluate(() => document.getElementById("adminUndo").click());
  await page.waitForTimeout(200);
  check("undo reverts the add (count back to start)", (await qCount()) === start);
  check("undo button disabled again after reverting the only step", await undoDisabled());

  // --- delete a question, then undo ---
  const before = await qCount();
  const q0 = await page.evaluate(() => state.adminCat.questions[0] && state.adminCat.questions[0].q);
  await page.evaluate(() => {
    const del = document.querySelector("#adminRows tr .q-del");
    if (del) del.click();
  });
  await page.waitForTimeout(250);
  check("deleting a question decreases the count", (await qCount()) === before - 1);
  await page.evaluate(() => document.getElementById("adminUndo").click());
  await page.waitForTimeout(200);
  const restored = await page.evaluate(() => state.adminCat.questions.some(q => q.q === (window.__q0 || "")));
  check("undo restores the deleted question (count back)", (await qCount()) === before);

  // --- multi-step: two adds, undo twice ---
  for (const t of ["أول إضافة؟", "ثاني إضافة؟"]) {
    await page.evaluate(() => document.getElementById("adminAddQuestion").click());
    await page.waitForTimeout(120);
    await page.fill("#adminQText", t);
    await page.fill("#adminQAnswer", "ج");
    await page.evaluate(() => document.getElementById("adminQSave").click());
    await page.waitForTimeout(150);
  }
  check("two adds applied", (await qCount()) === before + 2);
  await page.evaluate(() => document.getElementById("adminUndo").click());
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById("adminUndo").click());
  await page.waitForTimeout(150);
  check("undoing twice reverts both adds", (await qCount()) === before);

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
