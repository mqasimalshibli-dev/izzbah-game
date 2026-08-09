// The admin «⬇ نسخة احتياطية» button downloads the FULL catalog (published +
// community + custom categories, questions included) as one JSON file — the
// safety net against any bulk admin mistake. Also asserts App Check is wired
// with a real site key (abuse protection for stats/usage/code redemption).
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8384;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));

// ---- static: App Check is wired with a real key (not a placeholder) ----
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const keyMatch = html.match(/IZZBAH_APPCHECK_SITE_KEY = "([^"]*)"/);
check("App Check has a real reCAPTCHA site key wired",
  !!keyMatch && keyMatch[1].length > 20 && keyMatch[1].indexOf("PASTE_") !== 0);
check("App Check activates on boot when the key is set",
  /firebase\.appCheck\(\)\.activate\(acKey, true\)/.test(html));

const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // seed a known catalog, then build the backup object
  const built = await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true);
    state.publishedCategories = [
      { id: "pub-1", name: "فئة أ", questions: [{ points: 100, q: "س١", a: "ج١" }, { points: 200, q: "س٢", a: "ج٢" }] },
      { id: "pub-2", name: "فئة ب", questions: [{ points: 100, q: "س٣", a: "ج٣" }] },
    ];
    state.communityCategories = [{ id: "comm-1", name: "مجتمع", questions: [{ points: 100, q: "س", a: "ج" }] }];
    state.customCategories = [{ id: "custom-1", name: "خاصة", questions: [] }];
    const b = buildCatalogBackup();
    return {
      kind: b.kind, version: b.version, build: b.build,
      hasDate: /^\d{4}-\d{2}-\d{2}T/.test(b.exportedAt),
      pub: b.published.length, comm: b.community.length, cust: b.custom.length,
      qs: b.published.reduce((s, c) => s + c.questions.length, 0),
      q1: b.published[0].questions[0].q,
    };
  });
  check("the backup object carries kind/version/build + timestamp",
    built.kind === "izzbah-catalog-backup" && built.version === 1 && !!built.build && built.hasDate);
  check("it includes published + community + custom categories",
    built.pub === 2 && built.comm === 1 && built.cust === 1);
  check("questions are included in full", built.qs === 3 && built.q1 === "س١");

  // the admin button exists and clicking it downloads a dated JSON file
  const btn = await page.evaluate(() => {
    const b = document.getElementById("adminExportAll");
    return { exists: !!b, label: b ? b.textContent : "" };
  });
  check("the admin panel has the «نسخة احتياطية» button", btn.exists && /نسخة احتياطية/.test(btn.label));

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 10000 }),
    page.evaluate(() => document.getElementById("adminExportAll").click()),
  ]);
  const fname = download.suggestedFilename();
  check(`clicking it downloads a dated backup file (${fname})`, /^izzbah-backup-\d{4}-\d{2}-\d{2}\.json$/.test(fname));
  const path = await download.path();
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  check("the downloaded JSON round-trips (2 published categories, 3 questions)",
    parsed.kind === "izzbah-catalog-backup" && parsed.published.length === 2
    && parsed.published.reduce((s, c) => s + c.questions.length, 0) === 3);

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
