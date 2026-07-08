// E2E for the admin media preview: clicking a question thumbnail (or the
// editor's preview button) opens a full-size preview that plays video/audio.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = spawn("python3", ["-m", "http.server", "8304"], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
await page.route("**/firebasejs/**", r => r.abort());
const errs = []; page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1","1"); } catch(e){} });
const checks = []; const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const MP4 = "https://pub-96b6f75530b74a74b2d68be46911ef2c.r2.dev/sample.mp4";
try {
  await page.goto("http://127.0.0.1:8304/game-mobile.html", { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.IZZBAH.applyAuth(true); window.IZZBAH.applyAdmin(true); });
  await page.waitForTimeout(150);
  // the gear now opens a chooser; pick "content management" to reach the panel
  await page.evaluate(() => document.getElementById("adminEntry").click());
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById("adminChoiceContent").click());
  await page.waitForTimeout(400);
  // inject a question carrying an image (question media) and a video URL (answer media)
  await page.evaluate(({ png, mp4 }) => {
    state.adminCat.questions = [{ points: 100, q: "سؤال بصورة؟", a: "الإجابة", image: png, answerImage: mp4 }];
    renderAdminTable();
  }, { png: PNG, mp4: MP4 });
  await page.waitForTimeout(200);

  const thumbs = await page.evaluate(() => document.querySelectorAll("#adminRows .q-thumb-wrap.q-thumb-clickable").length);
  check(`question row shows 2 clickable thumbnails (got ${thumbs})`, thumbs === 2);

  // click the image thumbnail → preview modal opens with an <img>
  await page.evaluate(() => document.querySelectorAll("#adminRows .q-thumb-wrap")[0].click());
  await page.waitForTimeout(200);
  const imgPrev = await page.evaluate(() => {
    const m = document.getElementById("mediaPreviewModal");
    return { open: m.classList.contains("open"), hasImg: !!document.querySelector("#mediaPreviewStage img") };
  });
  check("clicking an image thumbnail opens the preview with an <img>", imgPrev.open && imgPrev.hasImg);
  await page.evaluate(() => document.getElementById("mediaPreviewClose").click());
  await page.waitForTimeout(150);
  const closed = await page.evaluate(() => !document.getElementById("mediaPreviewModal").classList.contains("open") && document.getElementById("mediaPreviewStage").children.length === 0);
  check("closing the preview clears the stage", closed);

  // click the video (answer) thumbnail → preview opens with a <video controls>
  await page.evaluate(() => document.querySelectorAll("#adminRows .q-thumb-wrap")[1].click());
  await page.waitForTimeout(200);
  const vidPrev = await page.evaluate(() => {
    const v = document.querySelector("#mediaPreviewStage video");
    return { open: document.getElementById("mediaPreviewModal").classList.contains("open"), hasVideo: !!v, controls: v ? v.hasAttribute("controls") : false };
  });
  check("clicking a video thumbnail opens a playable <video controls>", vidPrev.open && vidPrev.hasVideo && vidPrev.controls);
  await page.evaluate(() => document.getElementById("mediaPreviewModal").click()); // backdrop close (target is modal itself only if clicked on backdrop)
  await page.evaluate(() => document.getElementById("mediaPreviewClose").click());
  await page.waitForTimeout(150);

  // editor: open the question → the media picker shows a preview (🔍) button that opens the modal
  await page.evaluate(() => openAdminQuestion(0));
  await page.waitForTimeout(200);
  const editorBtn = await page.evaluate(() => document.querySelectorAll("#adminQModal .img-preview").length);
  check(`editor media pickers show a preview button when media is set (got ${editorBtn})`, editorBtn >= 1);
  await page.evaluate(() => document.querySelector("#adminQModal .img-preview").click());
  await page.waitForTimeout(200);
  const fromEditor = await page.evaluate(() => document.getElementById("mediaPreviewModal").classList.contains("open") && !!document.querySelector("#mediaPreviewStage img, #mediaPreviewStage video"));
  check("editor preview button opens the media preview", fromEditor);

  check("no uncaught JS errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 4));
} catch (e) { check("harness completed", false); console.log("  harness error:", e.message); }
finally { await browser.close(); server.kill(); }
process.exit(checks.every(Boolean) ? 0 : 1);
