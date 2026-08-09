// E2E for the admin bulk question importer.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8281;
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
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1600);
  // become admin and open the admin panel
  await page.evaluate(() => { window.IZZBAH.applyAuth && window.IZZBAH.applyAuth(true); window.IZZBAH.applyAdmin && window.IZZBAH.applyAdmin(true); });
  await page.waitForTimeout(200);
  // the gear now opens a chooser; pick "content management" to reach the panel
  await page.evaluate(() => document.getElementById("adminEntry").click());
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById("adminChoiceContent").click());
  await page.waitForTimeout(400);
  const onAdmin = await page.evaluate(() => document.getElementById("adminPanel").classList.contains("active"));
  check("admin panel opens", onAdmin);

  // open the import modal
  await page.evaluate(() => document.getElementById("adminImportQuestions").click());
  await page.waitForTimeout(200);
  const modalOpen = await page.evaluate(() => document.getElementById("importModal").classList.contains("open"));
  check("import modal opens", modalOpen);

  // paste 6 rows: pipe-separated, one bad row (no answer), mix of distractors/points
  const text = [
    "السؤال | الإجابة | خطأ١ | خطأ٢ | خطأ٣ | النقاط",   // header, should be skipped
    "ما عاصمة عُمان؟ | مسقط | صلالة | نزوى | صحار | 100",
    "أطول نهر في العالم؟ | النيل | الأمازون | الكونغو | اليانغتسي",
    "كم لون في قوس قزح؟ | ٧ | ٥ | ٦ | ٨ | 200",
    "سؤال بلا إجابة؟ |  |  |  | ",                       // bad row -> error
    "أكبر كوكب؟ | المشتري | زحل | نبتون | الأرض | 300",
    "عملة اليابان؟ | الين | الوون | اليوان | الروبية"
  ].join("\n");
  await page.fill("#importText", text);
  await page.waitForTimeout(250);

  const preview = await page.evaluate(() => document.getElementById("importPreview").textContent);
  check(`preview shows a valid count (${JSON.stringify(preview.slice(0,60))})`, /سيتم استيراد/.test(preview));
  const runDisabled = await page.evaluate(() => document.getElementById("importRun").disabled);
  check("run button enabled with valid rows", !runDisabled);
  check("preview flags the bad row (no answer)", /لا توجد إجابة/.test(preview));

  // choose "new category" + name, points = auto
  await page.selectOption("#importTarget", "new");
  await page.waitForTimeout(100);
  const nameShown = await page.evaluate(() => getComputedStyle(document.getElementById("importNewNameWrap")).display !== "none");
  check("new-category name field appears", nameShown);
  await page.fill("#importNewName", "فئة اختبار الاستيراد");

  // run import
  await page.evaluate(() => document.getElementById("importRun").click());
  await page.waitForTimeout(500);

  const result = await page.evaluate(() => {
    const rows = document.querySelectorAll("#adminRows tr").length;
    const head = document.querySelector(".admin-cathead .ac-name");
    const modal = document.getElementById("importModal").classList.contains("open");
    return { rows, name: head ? head.value : "", modalOpen: modal };
  });
  check(`imported 5 questions into the new category (got ${result.rows})`, result.rows === 5);
  check("new category carries the given name", result.name === "فئة اختبار الاستيراد");
  check("modal closes after import", !result.modalOpen);

  // verify distractors + auto points landed on the first question via the table
  const firstRowPts = await page.evaluate(() => {
    const tr = document.querySelector("#adminRows tr");
    return tr ? tr.querySelector("td.col-pts").textContent.trim() : "";
  });
  check(`first question got an auto points value (${firstRowPts})`, /\d|[٠-٩]/.test(firstRowPts));

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
