// «مواقع في عمان» is a "name this place" category: the question shows a photo
// of the place and the answer IS the place name. For it, the image fetch pulls
// ONE photo (by the place name = the answer) and puts it on BOTH the question
// (`image`) and the reveal (`answerImage`). Any OTHER category keeps the normal
// behaviour (answers-only fills `answerImage`, questions fills `image`).
// Network is fully STUBBED — the test never touches the real Wikipedia.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8351;
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

// Wiki stub: any answer resolves to a fake thumbnail, and any image URL to a
// 1x1 PNG. So every fetched photo is the SAME data URL — which lets us assert
// "same photo on both sides" by equality.
const installFetchStub = () => page.evaluate(() => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const real = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    const u = String(url);
    if (u.includes("wikipedia.org") || u.includes("wikimedia.org")) {
      if (u.includes("/w/api.php")) {
        const body = { query: { pages: { "1": { index: 1, thumbnail: { source: "https://upload.wikimedia.org/fake.jpg" } } } } };
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
      }
      const bytes = Uint8Array.from(atob(PNG), c => c.charCodeAt(0));
      return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob([bytes], { type: "image/png" })) });
    }
    return real(url, opts);
  };
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  await installFetchStub();
  await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true);
    window.IZZBAH.cloudPublish = () => Promise.resolve();
  });

  // ---- 0) the category is detected by its id AND by its name ----
  const detect = await page.evaluate(() => ({
    byId: isOmanSitesCategory({ id: "pub-1783170059396-601", name: "شيء آخر" }),
    byName: isOmanSitesCategory({ id: "pub-xyz", name: "مواقع في عُمان" }),
    other: isOmanSitesCategory({ id: "pub-abc", name: "تاريخ عُمان" }),
  }));
  check("detected by the known category id", detect.byId === true);
  check("detected by name (with or without diacritics)", detect.byName === true);
  check("a different category is NOT treated as oman-sites", detect.other === false);

  // ---- 1) oman-sites: one fetch fills BOTH image and answerImage, identically
  const twin = await page.evaluate(async () => {
    state.adminCat = {
      id: "pub-1783170059396-601", name: "مواقع في عمان", custom: false, published: true, color: "#9e1322",
      questions: [
        { points: 100, q: "ما اسم هذا الموقع في سلطنة عُمان؟", a: "قلعة نزوى", image: "", answerImage: "" },
        { points: 200, q: "ما اسم هذا الموقع في سلطنة عُمان؟", a: "حصن جبرين", image: "", answerImage: "" },
      ],
    };
    await runFetchImages({ answers: true, questions: false });
    return state.adminCat.questions.map(q => ({
      img: (q.image || "").slice(0, 11), ans: (q.answerImage || "").slice(0, 11), same: !!q.image && q.image === q.answerImage,
    }));
  });
  check("q0 gets a QUESTION photo", twin[0].img === "data:image/");
  check("q0 gets a REVEAL photo", twin[0].ans === "data:image/");
  check("q0: the question photo and reveal photo are the SAME", twin[0].same);
  check("q1 also gets the same photo on both sides", twin[1].img === "data:image/" && twin[1].same);

  // ---- 2) a normal category is unchanged: answers-only fills answerImage only
  const normal = await page.evaluate(async () => {
    state.adminCat = {
      id: "pub-normal-1", name: "عواصم", custom: false, published: true, color: "#123456",
      questions: [{ points: 100, q: "ما عاصمة عُمان؟", a: "مسقط", image: "", answerImage: "" }],
    };
    await runFetchImages({ answers: true, questions: false });
    const q = state.adminCat.questions[0];
    return { img: (q.image || ""), ans: (q.answerImage || "").slice(0, 11) };
  });
  check("a normal category (answers-only) fills the reveal photo", normal.ans === "data:image/");
  check("a normal category leaves the QUESTION photo empty (no twin)", normal.img === "");

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
