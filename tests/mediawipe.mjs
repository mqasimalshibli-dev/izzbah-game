// Publishing a media-LITE category must never blank its stored pictures.
//
// This is the bug that destroyed real content. Between 5 and 6 August 2026 ten
// published categories lost EVERY question image — «براندات» 0/132, «مواقع في
// عمان» 0/198, «العاب» 0/149, «تاريخ» 0/130, both emoji categories, and more.
// Read straight from the Firestore REST API: each category's question docs all
// carried the same updateTime, i.e. one bulk rewrite per category.
//
// Mechanism. Build .209 made question media lazy: boot reads only the parent
// doc, so every category in memory has `image: ""` on every question and is
// marked `__lite`. hydrateMediaInto() puts the pictures back, but ONLY for a
// category about to be played or opened in the editor. The duplicate remover
// and the smart-scan distractor editor both save by republishing the WHOLE
// category from that in-memory copy — so cloudPublish wrote `image: ""` over
// each stored photo, and the diff loop happily treated "big base64" -> "" as a
// change worth committing.
//
// The fix is at the choke point rather than in each caller: an empty image on a
// category whose media was never hydrated means "not loaded", never "delete".
// A hydrated category still honours a clear, so removing a picture in the
// editor keeps working — which this test also pins, because a fix that made
// deletion impossible would be its own bug.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8393;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
await page.route("**/firebasejs/**", r => r.abort());
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(1300);

// Firebase is blocked in this harness, so cloudPublish does not exist. Rebuild
// the exact write the real one performs — the per-question doc shape and the
// keepImg guard — against a fake store, and drive it the way the distractor
// editor does. What is pinned is the RULE, at the line where the damage happened.
const result = await page.evaluate(() => {
  const STORED = { image: "data:image/webp;base64,AAAAsomeRealPhoto", answerImage: "" };
  // what the parent doc gives you at boot: text only, marked __lite
  const liteCat = {
    id: "pub-test", __lite: true,
    questions: [{ points: 100, q: "س", a: "ج", image: "", answerImage: "" }]
  };
  const hydratedCat = JSON.parse(JSON.stringify(liteCat));
  hydratedCat.id = "pub-hydrated";
  hydratedCat.questions[0].image = STORED.image;

  // The published shape, lifted from cloudPublish.
  const buildDoc = (cat, prev, isHydrated) => {
    const mediaTrusted = !cat.__lite || isHydrated;
    const keepImg = (v, p) => (!v && !mediaTrusted) ? (p || "") : (v || "");
    const q = cat.questions[0];
    return {
      points: q.points || 0, q: q.q || "", a: q.a || "",
      image: keepImg(q.image, prev && prev.image),
      answerImage: keepImg(q.answerImage, prev && prev.answerImage), idx: 0
    };
  };

  // 1. the disaster case: save a text edit on a lite category
  const wroteFromLite = buildDoc(liteCat, STORED, false);
  // 2. a hydrated category whose picture is intact — must round-trip
  const wroteFromHydrated = buildDoc(hydratedCat, STORED, true);
  // 3. a hydrated category where the admin genuinely cleared the picture
  const cleared = JSON.parse(JSON.stringify(hydratedCat));
  cleared.questions[0].image = "";
  const wroteCleared = buildDoc(cleared, STORED, true);
  // 4. a category that never had media at all — must stay empty, not invent one
  const wroteEmpty = buildDoc(liteCat, { image: "", answerImage: "" }, false);

  // 5. the diff gate: an unchanged lite save must produce NO write at all,
  //    otherwise every scan fix rewrites every question doc in the category.
  const prev = Object.assign({ points: 100, q: "س", a: "ج", idx: 0 }, STORED);
  const d = buildDoc(liteCat, prev, false);
  const wouldWrite = !(prev.points === d.points && prev.q === d.q && prev.a === d.a
    && prev.image === d.image && prev.answerImage === d.answerImage && prev.idx === d.idx);

  return { STORED, wroteFromLite, wroteFromHydrated, wroteCleared, wroteEmpty, wouldWrite };
});

check("a LITE category's save keeps the stored picture (the 5-6 Aug wipe)",
  result.wroteFromLite.image === result.STORED.image);
check("…and does not invent one where there was none",
  result.wroteEmpty.image === "");
check("…and writes nothing at all when only the picture would 'change'",
  result.wouldWrite === false);
check("a HYDRATED category round-trips its picture",
  result.wroteFromHydrated.image === result.STORED.image);
check("a HYDRATED category can still CLEAR a picture on purpose",
  result.wroteCleared.image === "");

// The guard is only as good as the flag it reads, so pin the real wiring too:
// the source must consult __lite / hydratedCats at both writers, and the
// debounced saver must pass the trust flag through.
const src = await page.evaluate(() => fetch("index.html").then(r => r.text()));
check("cloudPublish computes mediaTrusted from __lite + hydratedCats",
  /const mediaTrusted = !cat\.__lite \|\| hydratedCats\.has\(cat\.id\)/.test(src));
check("cloudPublish routes both images through keepImg",
  /image: keepImg\(q\.image, prev && prev\.image\)/.test(src)
  && /answerImage: keepImg\(q\.answerImage, prev && prev\.answerImage\)/.test(src));
check("the community writer takes a mediaTrusted argument",
  /adminSetCommunityQuestions = function \(catId, questions, mediaTrusted\)/.test(src));
check("flushDupPersist passes the trust flag to the community writer",
  /adminSetCommunityQuestions\(catId, job\.cat\.questions, trusted\)/.test(src));
check("no publish path writes a bare `image: q.image || \"\"` any more",
  !/image: q\.image \|\| "", answerImage: q\.answerImage \|\| "", idx: i/.test(src));

check("no uncaught JS errors", errs.length === 0);
if (errs.length) console.log("  errs:", errs.slice(0, 3));

await browser.close();
server.kill();
process.exit(checks.every(Boolean) ? 0 : 1);
