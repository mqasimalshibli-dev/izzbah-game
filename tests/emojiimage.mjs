// An emoji-category question that carries a PHOTO must actually show it.
//
// «معنـى الايموجي» stores its emoji as JPEGs on each question, not as text —
// which is why the category read as empty when those images were blanked. With
// the images restored, the remaining question is whether the renderer shows
// them: the card is marked emoji-q, whose stylesheet enlarges the question
// text, and the code already carries a note that this once "swelled to 110px,
// leaving the image 0px tall — reported as: when there's a picture it doesn't
// display it at all".
//
// So this loads a REAL restored question (text + a 60 KB JPEG pulled from
// Firestore and saved beside this file) and measures the painted image box.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(ROOT, "tests/fixtures/emojiq.json");
const PORT = 8402;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

if (!existsSync(FIX)) { console.error("missing fixture " + FIX); process.exit(2); }
const Q = JSON.parse(readFileSync(FIX, "utf8"));

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

for (const [label, w, h] of [["tablet 1280×800", 1280, 800], ["phone 402×874", 402, 874]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.route("**/firebasejs/**", r => r.abort());
  page.on("pageerror", e => errs.push(e.message));
  await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1300);

  const r = await page.evaluate(async (Q) => {
    state.teamCount = 2;
    state.teams = [{ name: "أ", helpers: [], helpUsed: {}, score: 0 }, { name: "ب", helpers: [], helpUsed: {}, score: 0 }];
    state.activeTeam = 0;
    const cat = { id: "pub-1784240484235-8039", name: "معنـى الايموجي" };
    const q = { q: Q.q, a: Q.a, image: Q.image, points: 100 };
    state.activeQuestion = { cat, q, key: "k", team: 0 };
    fillQuestionContent(cat, q);
    showScreen("questionPage", { keepQuestion: true });
    await new Promise(z => setTimeout(z, 500));
    fitQuestionText();
    await new Promise(z => setTimeout(z, 300));
    const img = document.getElementById("modalQuestionImage");
    const card = document.querySelector("#questionPage .question-main-card");
    const b = img.getBoundingClientRect();
    const txt = document.getElementById("modalQuestion").getBoundingClientRect();
    return {
      hasSrc: !!img.getAttribute("src"),
      visible: img.classList.contains("visible"),
      display: getComputedStyle(img).display,
      w: Math.round(b.width), h: Math.round(b.height),
      natural: img.naturalWidth + "x" + img.naturalHeight,
      classes: card.className,
      textPx: Math.round(parseFloat(getComputedStyle(document.getElementById("modalQuestion")).fontSize)),
      textShare: +(txt.height / card.getBoundingClientRect().height).toFixed(2),
    };
  }, Q);

  console.log(`\n${label}: ${JSON.stringify(r)}`);
  check(`${label} · the image element has a src`, r.hasSrc);
  check(`${label} · it is marked visible`, r.visible && r.display !== "none");
  check(`${label} · it is actually painted with real height (${r.w}×${r.h})`, r.h > 60 && r.w > 60);
  check(`${label} · the JPEG decoded (${r.natural})`, !/^0x0$/.test(r.natural));
  check(`${label} · the card knows it has an image`, /has-image/.test(r.classes));
  check(`${label} · the question text did not swallow the card (${r.textPx}px, ${Math.round(r.textShare*100)}%)`,
    r.textShare <= 0.45);
  await page.close();
}

check("no uncaught JS errors", errs.length === 0);
if (errs.length) console.log("  errs:", errs.slice(0, 3));
await browser.close(); server.kill();
process.exit(checks.every(Boolean) ? 0 : 1);
