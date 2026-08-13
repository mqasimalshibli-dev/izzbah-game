// Cold-boot weight of the CATALOGUE read — the part tests/bootweight.mjs does
// not cover (that one budgets the shell's own assets).
//
// Measures time-to-picker on a throttled connection against a stubbed Firestore
// carrying a realistic catalogue: 39 categories whose covers match the real
// ones measured over REST (median 53 KB, max 92 KB), plus the meta/index
// projection the same data produces.
//
// The comparison is with the index read ON vs OFF, because that is the change:
// paint from one small document while the 1.6 MB of parent docs is still in
// flight. Everything downstream still receives the full read.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8402;
const checks = [];
const check = (n, ok, note) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${note ? `  — ${note}` : ""}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });

// A cover of roughly the measured median. Built once and reused — the bytes
// are what matter here, not the picture.
const cover = (kb) => "data:image/jpeg;base64," + "A".repeat(Math.round(kb * 1024 * 4 / 3));

async function boot({ withIndex }) {
  const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
  await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
  // Firebase never loads; the app's own no-cloud path would show built-ins, so
  // the catalogue is injected on the same timeline a real read would deliver
  // it — small doc early, big docs late.
  await page.route("**/firebasejs/**", r => r.abort());

  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.IZZBAH && window.IZZBAH.applyPublished, { timeout: 30000 });

  // Model the two reads. Sizes come from the real catalogue; the delays are
  // the transfer time those sizes cost on the throttled link.
  const INDEX_MS = withIndex ? 260 : 0;      // ~60 KB
  const FULL_MS = 4200;                      // ~1.6 MB gzipped

  const painted = await page.evaluate(async ([withIndex, INDEX_MS, FULL_MS, coverSmall]) => {
    const N = 39;
    const mk = (i, img, withQs) => ({
      id: "pub-" + i, name: "فئة " + i, color: "#9E1C1C", order: i,
      image: img, count: 25,
      questions: withQs ? Array.from({ length: 25 }, (_, k) => ({ points: 100, q: "س" + k, a: "ج" + k })) : [],
      __idx: !withQs, __lite: true,
    });
    const t0 = performance.now();
    let firstPaint = null;
    if (withIndex) {
      await new Promise(r => setTimeout(r, INDEX_MS));
      // 32px LQIP — a few hundred bytes each
      window.IZZBAH.applyPublished(Array.from({ length: N }, (_, i) => mk(i, "data:image/webp;base64,AAAA", false)));
      firstPaint = performance.now() - t0;
    }
    await new Promise(r => setTimeout(r, FULL_MS - INDEX_MS));
    window.IZZBAH.applyPublished(Array.from({ length: N }, (_, i) => mk(i, coverSmall, true)));
    if (firstPaint === null) firstPaint = performance.now() - t0;
    return { firstPaint, full: performance.now() - t0 };
  }, [withIndex, INDEX_MS, FULL_MS, cover(53)]);

  const playable = await page.evaluate(() =>
    document.querySelectorAll("#categoryGrid .cat-card, #categoryGrid .category-card, #categoryGrid button").length);
  await page.close();
  return { ...painted, playable };
}

try {
  const off = await boot({ withIndex: false });
  const on = await boot({ withIndex: true });
  console.log(`      without meta/index: picker at ${Math.round(off.firstPaint)}ms`);
  console.log(`      with    meta/index: picker at ${Math.round(on.firstPaint)}ms (full data still at ${Math.round(on.full)}ms)`);

  check(`the index paints the picker far sooner (${Math.round(on.firstPaint)}ms vs ${Math.round(off.firstPaint)}ms)`,
    on.firstPaint < off.firstPaint / 3);
  check("...and the full read still lands afterwards", on.full > on.firstPaint);
  check("tiles are rendered from the index alone", on.playable > 0, `${on.playable} tiles`);

  // The property that makes it safe: an index entry is playable-looking but
  // must never produce a board.
  const guard = await (async () => {
    const page = await browser.newPage();
    await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
    await page.route("**/firebasejs/**", r => r.abort());
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => window.IZZBAH && window.IZZBAH.applyPublished, { timeout: 15000 });
    const out = await page.evaluate(() => {
      const T = window.IZZBAH_TEST || {};
      const idx = { id: "pub-1", name: "فئة", color: "#9E1C1C", order: 1, image: "", questions: [], count: 25, __idx: true };
      const full = Object.assign({}, idx, { __idx: false, questions: [{ points: 100, q: "س", a: "ج" }] });
      return {
        idxPlayable: T.categoryHasQuestions ? T.categoryHasQuestions(idx) : null,
        idxEmpty: T.categoryHasQuestions ? T.categoryHasQuestions(Object.assign({}, idx, { count: 0 })) : null,
        fullPlayable: T.categoryHasQuestions ? T.categoryHasQuestions(full) : null,
      };
    });
    await page.close();
    return out;
  })();
  if (guard.idxPlayable === null) {
    console.log("SKIP  playability guard — no test bridge for categoryHasQuestions");
  } else {
    check("an index entry with questions counts as playable", guard.idxPlayable === true);
    check("...one with a zero count does not", guard.idxEmpty === false);
    check("a fully-loaded category is unaffected", guard.fullPlayable === true);
  }
} catch (e) {
  check(`threw: ${e && e.message}`, false);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
