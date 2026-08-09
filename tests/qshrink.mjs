// Question-media shrink — the publish-time cap and the migration for what is
// already out there.
//
// Question images are shown at most 680 CSS px wide, but the old budget let one
// question carry ~950 KB of base64. With media now fetched per game
// (tests/lazymedia.mjs) that is the dominant cost of a loaded board, so the cap
// is 1024px / 300 KB.
//
// The migration writes to each category's /questions docs and must touch the
// parent afterwards: BOTH the lite cache and the per-category media cache are
// keyed by that timestamp, so without the touch every device keeps serving the
// old large images from its own cache.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8381;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
await page.route("**/firebasejs/**", route => route.abort());
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
const errs = [];
page.on("pageerror", e => errs.push(e.message));

// A genuinely hard-to-compress photo, so the budget is actually exercised.
const bigPhoto = () => page.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = c.height = 1600;
  const x = c.getContext("2d");
  for (let i = 0; i < 7000; i++) {
    x.fillStyle = `hsl(${(i * 31) % 360},${55 + (i % 45)}%,${20 + (i % 60)}%)`;
    x.fillRect((i * 67) % 1600, (i * 137) % 1600, 6 + (i % 30), 6 + (i % 22));
  }
  return c.toDataURL("image/jpeg", 0.95);
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH && window.IZZBAH.applyPublished, { timeout: 15000 });
  await page.waitForTimeout(300);

  const src = await bigPhoto();
  check("fixture is a genuinely oversized question image (> 300 KB)", src.length > 300000);

  // ---- 1) publish-time cap ----
  const fit = await page.evaluate(async (src) => {
    const q = { points: 100, q: "س", a: "ج", image: src, answerImage: src };
    await fitQuestionForDoc(q);
    const dims = await new Promise(res => {
      const im = new Image();
      im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => res({ w: 0, h: 0 });
      im.src = q.image;
    });
    return { bytes: JSON.stringify({ i: q.image, ai: q.answerImage }).length,
             dims, jpeg: q.image.indexOf("data:image/jpeg") === 0,
             hasAnswer: !!q.answerImage };
  }, src);
  check("a published question is brought under the 300 KB budget", fit.bytes <= 300000);
  check("its image is capped at 1024px, not blown up or over-shrunk",
    fit.dims.w > 0 && fit.dims.w <= 1024 && fit.dims.w >= 420);
  check("the result is still a decodable JPEG", fit.jpeg && fit.dims.h > 0);
  check("the answer image survives too", fit.hasAnswer);

  // A question already within budget must not be needlessly re-encoded larger.
  const small = await page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = c.height = 300;
    const x = c.getContext("2d"); x.fillStyle = "#c8102e"; x.fillRect(0, 0, 300, 300);
    const tiny = c.toDataURL("image/jpeg", 0.8);
    const q = { points: 100, q: "س", a: "ج", image: tiny, answerImage: "" };
    await fitQuestionForDoc(q);
    return { grew: q.image.length > tiny.length * 1.2, still: !!q.image };
  });
  check("a small question image is not inflated", !small.grew && small.still);

  // ---- 2) the migration ----
  const mig = await page.evaluate(async (src) => {
    const writes = [], touched = [];
    window.IZZBAH.listQuestionMedia = (catId) => Promise.resolve(
      catId === "big"
        ? [{ docId: "q0", idx: 0, image: src, answerImage: src },
           { docId: "q1", idx: 1, image: "data:image/jpeg;base64,SMALL", answerImage: "" }]
        : []);
    window.IZZBAH.writeQuestionMedia = (catId, docId, patch) => { writes.push({ catId, docId, patch }); return Promise.resolve(); };
    window.IZZBAH.touchCategory = (catId) => { touched.push(catId); return Promise.resolve(); };
    window.confirm = () => true;
    window.IZZBAH.applyPublished([
      { id: "big", name: "كبيرة", image: "", questions: [] },
      { id: "none", name: "بلا", image: "", questions: [] },
    ]);
    document.querySelector("#adminShrinkQMedia").click();
    const btn = document.querySelector("#adminShrinkQMedia");
    for (let i = 0; i < 200 && btn.disabled; i++) await new Promise(r => setTimeout(r, 200));
    return { writes: writes.map(w => ({ cat: w.catId, doc: w.docId,
               bytes: JSON.stringify(w.patch).length,
               keys: Object.keys(w.patch).sort().join(",") })), touched };
  }, src);

  check("only the oversized question is rewritten", mig.writes.length === 1 && mig.writes[0].doc === "q0");
  check("the rewrite is smaller than the original", mig.writes[0] && mig.writes[0].bytes < src.length * 2);
  check("both media fields are written when both exist",
    mig.writes[0] && mig.writes[0].keys === "answerImage,image");
  check("the changed category's parent is touched (invalidates every cache)",
    mig.touched.length === 1 && mig.touched[0] === "big");
  check("a category with nothing to shrink is NOT touched", !mig.touched.includes("none"));

  // ---- 3) re-running is a no-op ----
  const rerun = await page.evaluate(async () => {
    const writes = [], touched = [];
    let served = null;
    window.IZZBAH.listQuestionMedia = () => Promise.resolve(served || []);
    window.IZZBAH.writeQuestionMedia = (c, d, p) => { writes.push(d); return Promise.resolve(); };
    window.IZZBAH.touchCategory = (c) => { touched.push(c); return Promise.resolve(); };
    window.confirm = () => true;
    // now everything is already within budget
    served = [{ docId: "q0", idx: 0, image: "data:image/jpeg;base64,SMALL", answerImage: "" }];
    document.querySelector("#adminShrinkQMedia").click();
    const btn = document.querySelector("#adminShrinkQMedia");
    for (let i = 0; i < 100 && btn.disabled; i++) await new Promise(r => setTimeout(r, 150));
    return { writes: writes.length, touched: touched.length };
  });
  check("re-running writes nothing once everything fits", rerun.writes === 0);
  check("...and touches nothing, so no device re-reads for no reason", rerun.touched === 0);

  check("no page errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 3));
} catch (e) {
  check(`threw: ${e && e.message}`, false);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
