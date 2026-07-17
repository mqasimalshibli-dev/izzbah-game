// The one-time «مواقع في عمان» seeding auto-fill has been RETIRED: the category
// is fully populated, so the installer must never run again and risk writing
// over an admin-edited category on a fresh device. This locks that in — even an
// admin on an EMPTY oman category must trigger no publish.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8338;
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

const CATID = "pub-1783170059396-601";

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  const result = await page.evaluate((CATID) => {
    window.__pubCount = 0;
    window.IZZBAH.cloudPublish = (c) => { window.__pubCount++; return Promise.resolve(); };
    try { localStorage.removeItem("izzbah-datafix-oman-sites-v1"); } catch (e) {}
    window.IZZBAH.applyAuth(true, "adm");
    // an EMPTY oman-sites category — the retired installer must NOT fill it
    window.IZZBAH.applyPublished([{ id: CATID, name: "مواقع في عمان", image: "x.webp", order: 1,
      questions: Array.from({ length: 5 }, (_, i) => ({ points: (i + 1) * 100, q: "", a: "", image: "", answerImage: "" })) }]);
    window.IZZBAH.applyAdmin(true);
    // directly invoking it must also be a no-op
    if (typeof maybeInstallOmanSites === "function") maybeInstallOmanSites();
    return { fn: typeof maybeInstallOmanSites };
  }, CATID);
  await page.waitForTimeout(600);
  const pubs = await page.evaluate(() => window.__pubCount);

  check("the oman-sites installer function still exists (kept for reference)", result.fn === "function");
  check("the retired auto-fill never publishes, even for an admin on an EMPTY category", pubs === 0);

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
