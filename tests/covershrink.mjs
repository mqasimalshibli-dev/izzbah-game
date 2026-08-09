// Category cover compression — the category picker reads EVERY category's
// parent doc in one query, and the cover image rides in that doc, so each
// cover's size is paid on every cold load. Covers published before build .205
// were allowed up to 600 KB each, which is what made the list slow.
//
//  • fitCoverImage() caps a cover at 480px and ~95 KB (480px is 160 CSS px on
//    a 3× phone — the largest size a cover is ever actually shown at).
//  • It re-encodes from the ORIGINAL on every pass. Recompressing an already
//    recompressed JPEG stacks artefacts without saving meaningful bytes, and
//    an earlier version of this code did exactly that.
//  • The admin «ضغط صور الفئات» button rewrites already-published covers,
//    writing ONLY the cover field, and is safe to run twice.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8371;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 460, height: 860 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

// A synthetic cover that is genuinely hard to compress — random blocks defeat
// the JPEG quantiser, so this stands in for the busiest real artwork.
const makeBigCover = () => page.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = c.height = 1254;
  const x = c.getContext("2d");
  for (let i = 0; i < 5200; i++) {
    x.fillStyle = `hsl(${(i * 37) % 360},${60 + (i % 40)}%,${25 + (i % 55)}%)`;
    x.fillRect((i * 71) % 1254, (i * 131) % 1254, 4 + (i % 26), 4 + (i % 19));
  }
  return c.toDataURL("image/jpeg", 0.95);
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH && typeof window.IZZBAH.applyPublished === "function", { timeout: 15000 });
  await page.waitForTimeout(300);

  const big = await makeBigCover();
  check("test fixture is a genuinely oversized cover (> 250 KB)", big.length > 250000);

  // ---- 1) the button exists in the admin toolbar ----
  check("admin toolbar offers «ضغط صور الفئات»",
    await page.evaluate(() => !!document.querySelector("#adminShrinkCovers")));

  // ---- 2) a run shrinks every oversized cover and writes only the cover ----
  const run = await page.evaluate(async (bigImg) => {
    const writes = [];
    window.IZZBAH.cloudUpdateCover = (id, image) => { writes.push({ id, image }); return Promise.resolve(); };
    window.confirm = () => true;
    window.IZZBAH.applyPublished([
      { id: "catA", name: "أ", image: bigImg, questions: [] },
      { id: "catB", name: "ب", image: bigImg, questions: [] },
    ]);
    document.querySelector("#adminShrinkCovers").click();
    const btn = document.querySelector("#adminShrinkCovers");
    for (let i = 0; i < 160 && (btn.disabled || writes.length < 2); i++) await new Promise(r => setTimeout(r, 200));
    // measure what a real <img> makes of the shrunk data
    const dims = await new Promise(res => {
      const im = new Image();
      im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => res({ w: 0, h: 0 });
      im.src = writes[0] ? writes[0].image : "";
    });
    return { ids: writes.map(w => w.id), sizes: writes.map(w => w.image.length), dims,
             jpeg: writes.every(w => w.image.indexOf("data:image/jpeg") === 0) };
  }, big);

  check("every oversized category is rewritten", run.ids.length === 2 && run.ids.includes("catA") && run.ids.includes("catB"));
  check("each cover lands under the 95 KB budget", run.sizes.length === 2 && run.sizes.every(n => n <= 95000));
  check("covers are meaningfully smaller than the original",
    run.sizes.every(n => n < big.length / 2));
  check("the shrunk cover is still a decodable image", run.dims.w > 0 && run.dims.h > 0);
  check("it is capped at 480px, not blown up or over-shrunk",
    run.dims.w <= 480 && run.dims.w >= 288);
  check("output stays JPEG", run.jpeg);

  // ---- 3) no compounding: re-encoding must start from the original ----
  // Feeding an ALREADY-shrunk cover back in must not shrink it again — if it
  // does, every migration run would degrade the artwork a little further.
  const rerun = await page.evaluate(async () => {
    const writes = [];
    window.IZZBAH.cloudUpdateCover = (id, image) => { writes.push({ id, image }); return Promise.resolve(); };
    window.confirm = () => true;
    // the covers on state are now the shrunk ones from the previous run
    document.querySelector("#adminShrinkCovers").click();
    const btn = document.querySelector("#adminShrinkCovers");
    for (let i = 0; i < 60 && btn.disabled; i++) await new Promise(r => setTimeout(r, 200));
    await new Promise(r => setTimeout(r, 400));
    return writes.length;
  });
  check("re-running is a no-op — already-small covers are skipped", rerun === 0);

  // ---- 4) a cover already under budget is never touched ----
  const small = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = c.height = 200;
    const x = c.getContext("2d"); x.fillStyle = "#c8102e"; x.fillRect(0, 0, 200, 200);
    const tiny = c.toDataURL("image/jpeg", 0.8);
    const writes = [];
    window.IZZBAH.cloudUpdateCover = (id, image) => { writes.push({ id, image }); return Promise.resolve(); };
    window.confirm = () => true;
    window.IZZBAH.applyPublished([{ id: "small", name: "ص", image: tiny, questions: [] }]);
    document.querySelector("#adminShrinkCovers").click();
    await new Promise(r => setTimeout(r, 900));
    return writes.length;
  });
  check("a cover already under budget is left alone", small === 0);

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
