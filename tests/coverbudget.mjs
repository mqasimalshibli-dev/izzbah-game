// A category cover must never ship over COVER_BUDGET without saying so.
//
// The cover rides in the PARENT doc, and boot reads every parent doc in one
// query — so a heavy cover is multiplied by the catalogue and paid by every
// cold visitor before a single tile paints. fitCoverImage exists to prevent
// that, and it works: measured against the live artwork it took 521 KB to
// 60 KB in ONE pass.
//
// The hole was the failure case. recompressDataUrl resolves with the ORIGINAL
// whenever the browser cannot decode the image, so all five passes hand back
// the input, fitCategoryForPublish returns true anyway (it only ever failed on
// a QUESTION), and the oversized cover is published in silence. Two live
// categories reached 521 KB and 511 KB exactly this way — together 1 MB of
// every cold boot, unnoticed for days.
//
// Run:  IZZBAH_CHROMIUM=/path/to/chrome node tests/coverbudget.mjs
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8433;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
await page.route("**/firebasejs/**", r => r.abort());
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // A real, decodable cover far above the budget: 1400×1400 of noise, which
  // JPEG cannot squeeze small, encoded at maximum quality.
  const big = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 1400;
    const ctx = c.getContext("2d");
    const im = ctx.createImageData(1400, 1400);
    // Deterministic pseudo-noise: incompressible, but identical every run.
    let s = 12345;
    for (let i = 0; i < im.data.length; i += 4) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      im.data[i] = s & 255; im.data[i + 1] = (s >> 8) & 255; im.data[i + 2] = (s >> 16) & 255; im.data[i + 3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    return c.toDataURL("image/jpeg", 1);
  });

  // ---- 1) the happy path: a decodable cover really is brought under budget
  const shrunk = await page.evaluate(async src => {
    const before = JSON.stringify({ i: src }).length;
    const out = await fitCoverImage(src);
    return { before, after: JSON.stringify({ i: out }).length, budget: COVER_BUDGET };
  }, big);
  check("a big but decodable cover is brought under budget",
    shrunk.after <= shrunk.budget && shrunk.after < shrunk.before,
    `${Math.round(shrunk.before / 1024)} KB → ${Math.round(shrunk.after / 1024)} KB (budget ${Math.round(shrunk.budget / 1024)} KB)`);

  // ---- 2) the failure path: an UNDECODABLE cover must not pass in silence
  // A data: URL that claims to be an image and is not — exactly what makes
  // recompressDataUrl hand back the original.
  const undecodable = "data:image/jpeg;base64," + "A".repeat(200000);
  const warned = await page.evaluate(async src => {
    const toast = document.getElementById("appToast");
    toast.classList.remove("show");
    const cat = { id: "cover-test", name: "غلاف", image: src, questions: [{ points: 100, q: "س", a: "ج" }] };
    const fits = await fitCategoryForPublish(cat);
    await new Promise(r => setTimeout(r, 150));
    return {
      fits,                                   // questions still fine
      unchanged: cat.image === src,           // proof the passes could not help
      shown: toast.classList.contains("show"),
      text: toast.textContent || "",
      // It must NOT blank the cover — an empty image is how 823 pictures died.
      blanked: !cat.image,
    };
  }, undecodable);
  check("an undecodable cover is left intact, never blanked", !warned.blanked && warned.unchanged);
  check("publishing an over-budget cover WARNS the admin",
    warned.shown && /كبيرة/.test(warned.text), warned.text.trim());
  check("…and still publishes, rather than blocking the admin's edits", warned.fits === true);

  // ---- 3) a cover comfortably under budget says nothing at all
  const quiet = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#9e1322"; ctx.fillRect(0, 0, 64, 64);
    const small = c.toDataURL("image/jpeg", 0.7);
    const toast = document.getElementById("appToast");
    toast.classList.remove("show");
    const cat = { id: "cover-ok", name: "غلاف", image: small, questions: [] };
    await fitCategoryForPublish(cat);
    await new Promise(r => setTimeout(r, 150));
    return { shown: toast.classList.contains("show"), bytes: JSON.stringify({ i: cat.image }).length };
  });
  check("a normal cover publishes silently (no nagging)",
    !quiet.shown, `${Math.round(quiet.bytes / 1024)} KB`);

  // ---- 4) the repair button still targets exactly the over-budget covers
  const repair = await page.evaluate(() => typeof shrinkPublishedCovers === "function");
  check("the «⚡ ضغط صور الفئات» repair path still exists", repair);

  check("no uncaught JS errors", errs.length === 0, errs.slice(0, 2).join(" | "));
} catch (e) {
  check("harness completed", false, e && e.message);
} finally {
  await browser.close();
  server.kill();
}

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
