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
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
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

  // The modal renders the report with tags + a summary.
  const ui = await page.evaluate(() => {
    openDupModal();
    return {
      open: document.getElementById("dupModal").classList.contains("open"),
      summary: document.getElementById("dupSummary").textContent,
      groups: document.querySelectorAll("#dupList .dup-group").length,
      hasDupTag: !!document.querySelector("#dupList .dup-tag.dup"),
      hasConfTag: !!document.querySelector("#dupList .dup-tag.conf"),
    };
  });
  check("the scanner modal opens and lists duplicate groups", ui.open && ui.groups >= 2);
  check("the summary reports how many duplicates were found", /مكرّرة|تكرار/.test(ui.summary));
  check("groups are tagged «مكرّر» and «تعارض»", ui.hasDupTag && ui.hasConfTag);

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
