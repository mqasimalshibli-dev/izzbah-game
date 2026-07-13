// E2E: word-guess categories with no bundled QR PNG (e.g. the user's
// «ولا كلمة عماني» local category) render the answer word as a scannable QR
// generated client-side. Verified by decoding the rendered QR back to the word.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8333;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

// jsQR UMD bundle lives in the scratchpad node_modules (dev-only decoder).
const SP = process.env.IZZBAH_SCRATCH || join(ROOT, "..", "izzbah-game", "scratchpad");
let jsqrSrc = "";
for (const p of [
  join(SP, "node_modules/jsqr/dist/jsQR.js"),
  join(ROOT, "tests/node_modules/jsqr/dist/jsQR.js"), // CI installs deps in tests/
  join(ROOT, "node_modules/jsqr/dist/jsQR.js"),
]) {
  try { jsqrSrc = readFileSync(p, "utf8"); break; } catch (e) {}
}
if (!jsqrSrc) { console.log("SKIP  jsQR bundle not found — install jsqr to run the decode check"); }

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  if (jsqrSrc) await page.addScriptTag({ content: jsqrSrc });

  // ---- 1) the category is recognized as word-guess by its NAME ----
  const recognised = await page.evaluate(() => ({
    omani: isWordGuessCategory({ id: "pub-1783189569201-313", name: "ولا كلمة عماني" }),
    wesh: isWordGuessCategory({ id: "pub-x", name: "وش الكلمة" }),
    charades: isWordGuessCategory({ id: "charades100", name: "تمثيل" }),
    normal: isWordGuessCategory({ id: "pub-y", name: "تاريخ" }),
  }));
  check("«ولا كلمة عماني» is treated as a word-guess category (by name)", recognised.omani);
  check("«وش الكلمة» is treated as a word-guess category (by name)", recognised.wesh);
  check("built-in charades stays word-guess (by id)", recognised.charades);
  check("an ordinary category is NOT word-guess", recognised.normal === false);

  // ---- 2) makeWordQr returns a valid SVG data-URL for an Arabic word ----
  const url = await page.evaluate(() => makeWordQr("اللبان"));
  check("makeWordQr returns an svg+xml data URL", typeof url === "string" && url.startsWith("data:image/svg+xml"));
  check("empty word yields no QR", (await page.evaluate(() => makeWordQr("")) === ""));

  // ---- 3) the question screen shows the QR image for a word-guess question ----
  const shown = await page.evaluate(() => {
    const cat = { id: "pub-1783189569201-313", name: "ولا كلمة عماني" };
    const q = { q: "", a: "الخنجر العماني", points: 100, image: "", answerImage: "" };
    state.activeQuestion = { cat, q, key: "t", team: 0 };
    fillQuestionContent(cat, q);
    const im = document.getElementById("modalQuestionImage");
    return { src: im.getAttribute("src") || im.src || "", display: getComputedStyle(im).display };
  });
  check("word-guess question shows a QR image (not empty, not hidden)",
    shown.src.startsWith("data:image/svg+xml") && shown.display !== "none");

  // ---- 4) roundtrip: the rendered QR decodes back to the exact word ----
  if (jsqrSrc) {
    const decoded = await page.evaluate(async (word) => {
      const dataUrl = makeWordQr(word);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const S = 360;
      const cv = document.createElement("canvas"); cv.width = S; cv.height = S;
      const cx = cv.getContext("2d");
      cx.fillStyle = "#fff"; cx.fillRect(0, 0, S, S);
      cx.imageSmoothingEnabled = false;
      cx.drawImage(img, 0, 0, S, S);
      const d = cx.getImageData(0, 0, S, S);
      const r = window.jsQR(d.data, S, S);
      return r ? r.data : null;
    }, "الخنجر العماني");
    check(`the rendered QR decodes back to the word (got: ${JSON.stringify(decoded)})`,
      decoded === "الخنجر العماني");
  }

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
