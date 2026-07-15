// E2E for the one-time «مواقع في عمان» content install: an admin device fills
// the EMPTY published category with the fact-checked photo-quiz bank, fetching
// each site's photo (stubbed here) onto BOTH the question and the answer.
// Guards under test: only-if-empty (existing content is never overwritten),
// admin-only, once-only, and photo-ID questions are dropped without a photo.
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
const blanks = () => Array.from({ length: 5 }, (_, i) => ({ points: (i + 1) * 100, q: "", a: "", image: "", answerImage: "" }));
const waitPub = async (n, tries = 120) => {
  for (let i = 0; i < tries; i++) {
    const c = await page.evaluate(() => window.__pubCount || 0);
    if (c >= n) return true;
    await page.waitForTimeout(100);
  }
  return false;
};

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ---- 0) the embedded bank is sane ----
  const bank = await page.evaluate(() => ({
    n: OMAN_SITES_INSTALL.length,
    tiers: [...new Set(OMAN_SITES_INSTALL.map(x => x.points))].sort((a, b) => a - b),
    complete: OMAN_SITES_INSTALL.every(x => x.q && x.a && Array.isArray(x.d) && x.d.length === 3 && x.w && (x.lang === "ar" || x.lang === "en")),
    dupSites: OMAN_SITES_INSTALL.length !== new Set(OMAN_SITES_INSTALL.map(x => x.w)).size,
    hasPid: OMAN_SITES_INSTALL.some(x => x.pid),
    hasPlain: OMAN_SITES_INSTALL.some(x => !x.pid),
  }));
  check(`the embedded bank is substantial (${bank.n} questions across tiers ${bank.tiers.join("/")})`,
    bank.n >= 20 && bank.tiers.length === 5);
  check("every question has text, answer, 3 distractors and a wiki pin", bank.complete);
  check("no site (wiki article) is used twice", !bank.dupSites);
  check("the bank mixes photo-ID and fact questions", bank.hasPid && bank.hasPlain);

  // ---- 1) install on an admin device with an EMPTY category ----
  // The wiki/image network is stubbed; TWO sites are made unfetchable to prove
  // the drop-vs-keep rules (photo-ID dropped, fact question kept photo-less).
  await page.evaluate((CATID) => {
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    window.__rejectPid = (OMAN_SITES_INSTALL.find(x => x.pid) || {}).w || "";
    window.__rejectPlain = (OMAN_SITES_INSTALL.find(x => !x.pid) || {}).w || "";
    const real = window.fetch.bind(window);
    window.fetch = function (url, opts) {
      const u = String(url);
      if (u.includes("wikipedia.org/w/api.php")) {
        const dec = decodeURIComponent(u).replace(/\+/g, " "); // URLSearchParams encodes space as '+'
        const rejected = (window.__rejectPid && dec.includes(window.__rejectPid))
          || (window.__rejectPlain && dec.includes(window.__rejectPlain));
        const m = dec.match(/titles=([^&]+)/);
        const body = rejected ? { query: { pages: {} } }
          : { query: { pages: { "1": { index: 1, title: m ? m[1] : "", thumbnail: { source: "https://upload.wikimedia.org/site.jpg" } } } } };
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
      }
      if (u.includes("wikimedia.org")) {
        const bytes = Uint8Array.from(atob(PNG), c => c.charCodeAt(0));
        return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob([bytes], { type: "image/png" })) });
      }
      return real(url, opts);
    };
    window.__pubCount = 0; window.__published = null;
    window.IZZBAH.cloudPublish = (c) => { window.__pubCount++; window.__published = JSON.parse(JSON.stringify(c)); return Promise.resolve(); };
    try { localStorage.removeItem("izzbah-datafix-oman-sites-v1"); } catch (e) {}
    window.IZZBAH.applyAuth(true, "adm");
    window.IZZBAH.applyPublished([{ id: CATID, name: "مواقع في عمان", image: "x.webp", order: 1,
      questions: Array.from({ length: 5 }, (_, i) => ({ points: (i + 1) * 100, q: "", a: "", image: "", answerImage: "" })) }]);
    window.IZZBAH.applyAdmin(true);
  }, CATID);
  check("the install publishes the filled category", await waitPub(1));

  const installed = await page.evaluate(() => {
    const pub = window.__published;
    const qs = (pub && pub.questions) || [];
    const rejectedPid = OMAN_SITES_INSTALL.find(x => x.w === window.__rejectPid);
    const rejectedPlain = OMAN_SITES_INSTALL.find(x => x.w === window.__rejectPlain);
    const plainEntry = rejectedPlain ? qs.find(x => x.q === rejectedPlain.q) : null;
    return {
      id: pub && pub.id,
      count: qs.length, installN: OMAN_SITES_INSTALL.length,
      allReal: qs.every(x => x.q && x.a && Array.isArray(x.distractors) && x.distractors.length === 3),
      withImages: qs.filter(x => (x.image || "").startsWith("data:image/")).length,
      bothSides: qs.filter(x => x.image).every(x => x.image === x.answerImage),
      pidDropped: rejectedPid ? !qs.some(x => x.a === rejectedPid.a) : false, // answer is unique per site
      plainKept: !!plainEntry && plainEntry.image === "",
      marker: localStorage.getItem("izzbah-datafix-oman-sites-v1"),
    };
  });
  check("it publishes THIS category with the full bank (minus the dropped photo-ID)",
    installed.id === CATID && installed.count === installed.installN - 1);
  check("every installed question is real (text + answer + 3 distractors)", installed.allReal);
  check("the site photo is placed on BOTH the question and the answer", installed.withImages >= installed.count - 1 && installed.bothSides);
  check("a photo-ID question whose photo failed is dropped", installed.pidDropped);
  check("a fact question whose photo failed is kept (photo-less)", installed.plainKept);
  check("a success marker prevents re-running", installed.marker === "1");

  // ---- 2) never runs twice ----
  const again = await page.evaluate((CATID) => {
    window.IZZBAH.applyPublished([{ id: CATID, name: "مواقع في عمان", questions: Array.from({ length: 5 }, (_, i) => ({ points: (i + 1) * 100, q: "", a: "" })) }]);
    window.IZZBAH.applyAdmin(true);
    return window.__pubCount;
  }, CATID);
  await page.waitForTimeout(400);
  check("the install never runs twice", (await page.evaluate(() => window.__pubCount)) === 1);

  // ---- 3) non-admin devices never install ----
  const nonAdmin = await page.evaluate((CATID) => {
    try { localStorage.removeItem("izzbah-datafix-oman-sites-v1"); } catch (e) {}
    window.__pubCount = 0;
    window.IZZBAH.applyAdmin(false);
    window.IZZBAH.applyPublished([{ id: CATID, name: "مواقع في عمان", questions: Array.from({ length: 5 }, (_, i) => ({ points: (i + 1) * 100, q: "", a: "" })) }]);
    return window.__pubCount;
  }, CATID);
  await page.waitForTimeout(400);
  check("non-admin devices never install", (await page.evaluate(() => window.__pubCount)) === 0);

  // ---- 4) ONLY-IF-EMPTY: existing content is never overwritten ----
  const guarded = await page.evaluate((CATID) => {
    try { localStorage.removeItem("izzbah-datafix-oman-sites-v1"); } catch (e) {}
    window.__pubCount = 0;
    window.IZZBAH.applyPublished([{ id: CATID, name: "مواقع في عمان",
      questions: [{ points: 100, q: "سؤال حقيقي موجود؟", a: "جواب", image: "", answerImage: "" }] }]);
    window.IZZBAH.applyAdmin(true);
    return true;
  }, CATID);
  await page.waitForTimeout(500);
  const afterGuard = await page.evaluate(() => ({
    pubs: window.__pubCount,
    kept: state.publishedCategories.find(c => c.id === "pub-1783170059396-601").questions[0].q,
    marker: localStorage.getItem("izzbah-datafix-oman-sites-v1"),
  }));
  check("a category WITH content is never touched (only-if-empty guard)",
    afterGuard.pubs === 0 && afterGuard.kept === "سؤال حقيقي موجود؟");
  check("the guard stands the installer down permanently", afterGuard.marker === "1");

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
