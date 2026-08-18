// Real screenshots of the game, for the landing page — THREE of every screen.
//
//   node preview/shots.mjs            # all four screens, three variants each
//   node preview/shots.mjs board      # just one screen
//
// The page used to show four stills, two of them twice over (`board` in the
// hero AND step 2, `answer` in the hero AND step 3), so a visitor met the same
// picture four times. This writes `<screen>-1..3.webp` and the page steps to
// the next set on every entry, repeating after the third.
//
// ⚠️ FOUR WAYS TO GET A PLAUSIBLE BUT WRONG SCREENSHOT. Every one of them
// produces a picture that looks fine and is not the game:
//
// 1. NO CATALOGUE. Firebase is fetched from gstatic, which is not reachable
//    from every network (it is not from CI), and the game then falls back to
//    the 20 BUNDLED categories with their old artwork. The published catalogue
//    is fetched here over Firestore's REST API — which is public, because every
//    player's browser reads the same data — and injected before anything is
//    captured. The run ABORTS if the count comes back low.
// 2. NO FONTS. The faces are self-hosted in `assets/fonts/` since build .216,
//    so serving the repo is enough — but that is a property of the build, not a
//    law, and if it ever regresses the game renders in Tahoma and the shots
//    look subtly cheap. `document.fonts.check()` is useless (it returns true
//    for a fallback), so this WIDTH-PROBES Cairo against a nonsense family and
//    aborts if they match.
// 3. THE WRONG THEME. The game's default is LIGHT. Do not set `data-theme`.
// 4. NO QUESTION PHOTOS. Question media lives only in the `/questions`
//    subcollection, not in the parent doc's text-only copy, so a question shot
//    taken without it is a bare sentence on a card. Hydrated here for the
//    categories each variant actually plays.
//
// ⚠️ The board is driven through `state` + `renderGame()` rather than by
// clicking through the welcome/teams flow. Clicking is what the throwaway
// script that produced the original four did, and it breaks on every copy
// change; the state route is what tests/teambox.mjs uses and it survives.
// Starting a game this way also never calls `startGame()`, so no credit is
// spent and no saved game is written.
import { chromium } from "playwright-core";
import { spawn, execFileSync } from "child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "preview", "shots");
const PORT = 8611;
const REST = "https://firestore.googleapis.com/v1/projects/izzbahgame/databases/(default)/documents";

// The page declares these dimensions on the <img>, so the files have to match
// or the layout shifts as they load.
const SIZE = { picker: [620, 1354], board: [1150, 550], question: [1150, 550], answer: [1150, 550] };

/* Three scenes. Different categories and different team names, so the three
   sets do not read as the same screenshot twice — which is the entire point.
   Category ids, not names: a rename in the admin panel would silently drop a
   category out of the scene and the variant would quietly become a duplicate
   of another. */
const SCENES = [
  // general knowledge
  { cats: ["history", "geo", "science", "culture", "sports", "pub-1783684233589-5608"],
    teams: ["جروب الحارة", "تيم خلفان"] },
  // the Omani shelf — the library's real differentiator, so it gets a board
  { cats: ["khareef", "omaniFootball", "cafesRestaurants", "pub-1783170059396-601",
           "pub-1783453062866-1028", "pub-1784798503561-5271"],
    teams: ["أبطال صحار", "شباب نزوى"] },
  // pop culture and play
  { cats: ["foreignMoviesOnly", "pub-1783170356019-2501", "pub-1783510423551-6465",
           "cars", "pub-1784486305049-7855", "pub-1784240484235-8039"],
    teams: ["فريق ظفار", "بنات مسقط"] },
];

const V = v => {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(V);
  if ("mapValue" in v) { const o = {}; for (const k in (v.mapValue.fields || {})) o[k] = V(v.mapValue.fields[k]); return o; }
  return null;
};

async function catalogue() {
  let docs = [], tok = null;
  do {
    const u = new URL(REST + "/categories");
    u.searchParams.set("pageSize", "50");
    if (tok) u.searchParams.set("pageToken", tok);
    const r = await fetch(u);
    if (!r.ok) throw new Error("catalogue " + r.status);
    const j = await r.json();
    docs.push(...(j.documents || []));
    tok = j.nextPageToken;
  } while (tok);
  return docs.map(d => {
    const f = d.fields || {}, o = { id: d.name.split("/").pop() };
    for (const k in f) o[k] = V(f[k]);
    return o;
  });
}

/* Question media for ONE category, capped.
   ⚠️ These are base64 JPEGs on the question documents — the whole catalogue is
   about 160 MB of them. Fetching eighteen categories' worth and handing it to
   `page.evaluate` in one go killed the renderer outright ("Target page, context
   or browser has been closed"), which is a confusing way to learn that a
   serialized argument has a practical size limit. Only questions that actually
   carry a picture are kept, only the first `CAP` of them, and only for the six
   categories of the scene being shot. */
const CAP = 10;
async function media(id) {
  let out = [], tok = null;
  do {
    const u = new URL(`${REST}/categories/${encodeURIComponent(id)}/questions`);
    u.searchParams.set("pageSize", "300");
    if (tok) u.searchParams.set("pageToken", tok);
    const r = await fetch(u);
    if (!r.ok) return out;
    const j = await r.json();
    for (const d of (j.documents || [])) {
      const f = d.fields || {};
      const image = V(f.image) || "", answerImage = V(f.answerImage) || "";
      if (!image && !answerImage) continue;
      out.push({ idx: V(f.idx), image, answerImage });
      if (out.length >= CAP) return out;
    }
    tok = j.nextPageToken;
  } while (tok);
  return out;
}

const only = process.argv[2];
const want = only ? [only] : ["picker", "board", "question", "answer"];

console.log("fetching the published catalogue…");
const cats = await catalogue();
if (cats.length < 20) { console.error(`only ${cats.length} categories came back — refusing to shoot the bundled fallback`); process.exit(1); }
console.log(`  ${cats.length} categories`);

mkdirSync(OUT, { recursive: true });
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });

// PNG out of the browser, WebP on disk: Playwright encodes png/jpeg only.
const toWebp = (png, webp, [w, h]) => {
  execFileSync("python3", ["-c", `
from PIL import Image
im = Image.open(${JSON.stringify(png)}).convert("RGB").resize((${w}, ${h}), Image.LANCZOS)
im.save(${JSON.stringify(webp)}, "WEBP", quality=88, method=6)
`]);
  unlinkSync(png);
};

const page = await browser.newPage({ viewport: { width: 900, height: 430 }, deviceScaleFactor: 2 });
page.on("pageerror", e => console.error("  page error:", e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 40000 });
await page.waitForTimeout(2500);

// TRAP 2 — a width probe, because `document.fonts.check()` returns true for a
// fallback and would wave a Tahoma render straight through.
const fonts = await page.evaluate(async () => {
  await document.fonts.ready;
  const probe = (fam, w) => {
    const s = document.createElement("span");
    s.textContent = "عِزبة اختبار الخط";
    s.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${w} 40px ${fam}`;
    document.body.appendChild(s); const x = s.offsetWidth; s.remove(); return x;
  };
  return { cairo: probe("'Cairo',sans-serif", 900), fake: probe("'NoSuchFace123',sans-serif", 900) };
});
if (fonts.cairo === fonts.fake) {
  console.error("Cairo did not render — the shots would be in the fallback face. Aborting.");
  await browser.close(); server.kill(); process.exit(1);
}
console.log(`fonts ok (Cairo ${fonts.cairo}px vs fallback ${fonts.fake}px)`);

await page.evaluate((cats) => {
  state.publishedCategories = cats;
  if (typeof applyPublished === "function") applyPublished(cats);
}, cats);
await page.waitForTimeout(600);

// Merge media onto the text-only copy by position, exactly as
// hydrateCategoryMedia does at play time — one category at a time.
const hydrate = async (ids) => {
  for (const id of ids) {
    const rows = await media(id);
    if (!rows.length) continue;
    await page.evaluate(({ id, rows }) => {
      const c = (state.publishedCategories || []).find(x => x.id === id);
      if (!c || !c.questions) return;
      for (const row of rows) {
        const q = c.questions[row.idx];
        if (!q) continue;
        if (row.image) q.image = row.image;
        if (row.answerImage) q.answerImage = row.answerImage;
      }
    }, { id, rows });
  }
};

const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
if (theme === "dark") { console.error("the page is in dark mode — the game's default is light. Aborting."); await browser.close(); server.kill(); process.exit(1); }

for (let v = 0; v < SCENES.length; v++) {
  const scene = SCENES[v];
  const n = v + 1;
  console.log(`\nscene ${n}: ${scene.teams.join(" · ")}`);

  const chosen = await page.evaluate(({ scene }) => {
    const all = (typeof allCategories === "function" ? allCategories() : state.publishedCategories) || [];
    const has = id => all.find(c => c.id === id && (typeof categoryHasQuestions !== "function" || categoryHasQuestions(c)));
    let ids = scene.cats.filter(has);
    // Top the scene up rather than draw a short board: a five-column board is a
    // different picture from the six the copy promises.
    if (ids.length < 6) {
      const extra = all.filter(c => !ids.includes(c.id) && (typeof categoryHasQuestions !== "function" || categoryHasQuestions(c)));
      ids = ids.concat(extra.slice(0, 6 - ids.length).map(c => c.id));
    }
    ids = ids.slice(0, 6);
    state.selected = new Set(ids);
    state.teamCount = scene.teams.length;
    state.teams = scene.teams.map(name => ({
      name, helpers: ["fourChoices", "firstLetter", "doublePoints"], helpUsed: {}, score: 0,
    }));
    state.activeTeam = 0;
    state.used = new Set();
    if (typeof coachMarkAll === "function") coachMarkAll();
    return ids;
  }, { scene });
  console.log(`  categories: ${chosen.join(", ")}`);
  await hydrate(chosen);

  if (want.includes("picker")) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { showScreen("categories"); if (typeof renderCategories === "function") renderCategories(); });
    await page.waitForTimeout(1400);
    const png = join(OUT, `picker-${n}.png`);
    await page.screenshot({ path: png });
    toWebp(png, join(OUT, `picker-${n}.webp`), SIZE.picker);
    console.log("  picker ✓");
  }

  // The board and everything after it are played in LANDSCAPE — portrait gets
  // the game's own rotate prompt over the top, which is not a screenshot.
  await page.setViewportSize({ width: 900, height: 430 });
  await page.evaluate(() => { showScreen("game"); renderGame(); });
  await page.waitForTimeout(1600);
  if (want.includes("board")) {
    const png = join(OUT, `board-${n}.png`);
    await page.screenshot({ path: png });
    toWebp(png, join(OUT, `board-${n}.webp`), SIZE.board);
    console.log("  board ✓");
  }

  if (want.includes("question") || want.includes("answer")) {
    // A different tier per scene, so the three question cards are not the same
    // points value three times.
    /* Prefer a question that actually HAS a photo. A bare sentence on a card is
       a true screenshot and a poor advertisement, and which cells carry media
       is not knowable from the board — so open one, look, and try another if it
       came up text-only. Resetting `state.used` puts the board back the way it
       was, so a rejected try does not grey out a cell in the next shot. */
    let opened = false;
    for (let attempt = 0; attempt < 6 && !opened; attempt++) {
      const clicked = await page.evaluate(({ v, attempt }) => {
        const cells = [...document.querySelectorAll("#game .cell:not(.used)")];
        if (!cells.length) return false;
        cells[([7, 13, 20][v] + attempt * 3) % cells.length].click();
        return true;
      }, { v, attempt });
      if (!clicked) break;
      await page.waitForTimeout(1500);
      /* ⚠️ "There is an image" is NOT the test. The word-guess categories hand
         the word to one player as a QR CODE, and the question card is an empty
         box with a QR in the middle — a perfectly true screenshot of the game
         and a useless advertisement, which is exactly what shipped. The game
         already knows which categories work that way, so ask it rather than
         keeping a list here that drifts. */
      const hasPhoto = await page.evaluate(() => {
        const cat = state.activeQuestion && state.activeQuestion.cat;
        if (cat && typeof usesSpecialAnswerMedia === "function" && usesSpecialAnswerMedia(cat)) return false;
        return [...document.querySelectorAll("#questionPage img, #questionPage video")]
          .some(m => m.offsetParent !== null && m.getBoundingClientRect().height > 60);
      });
      if (hasPhoto || attempt === 5) { opened = true; break; }
      await page.evaluate(() => { state.used = new Set(); showScreen("game"); renderGame(); });
      await page.waitForTimeout(700);
    }
    if (!opened) { console.error("  no board cell to open — skipping question/answer"); continue; }
    await page.waitForTimeout(700);
    if (want.includes("question")) {
      const png = join(OUT, `question-${n}.png`);
      await page.screenshot({ path: png });
      toWebp(png, join(OUT, `question-${n}.webp`), SIZE.question);
      console.log("  question ✓");
    }
    if (want.includes("answer")) {
      await page.evaluate(() => revealAnswer());
      await page.waitForTimeout(1600);
      const png = join(OUT, `answer-${n}.png`);
      await page.screenshot({ path: png });
      toWebp(png, join(OUT, `answer-${n}.webp`), SIZE.answer);
      console.log("  answer ✓");
    }
  }
}

await browser.close();
server.kill();

/* Stamp the page with a version taken from the shots' own bytes.
   ⚠️ Re-capturing reuses the same twelve FILENAMES, so a browser holding the
   old ones keeps showing them until its cache expires — the site serves the
   new pictures and the reader sees the old ones, which is indistinguishable
   from a deploy that did not happen. Content-addressed, so an unchanged
   capture does not churn the URL and throw away a warm cache for nothing. */
{
  const { createHash } = await import("crypto");
  const h = createHash("sha256");
  for (const name of ["picker", "board", "question", "answer"])
    for (let i = 1; i <= 3; i++) {
      const f = join(OUT, `${name}-${i}.webp`);
      if (existsSync(f)) h.update(readFileSync(f));
    }
  const v = "v" + h.digest("hex").slice(0, 8);
  const page = join(ROOT, "preview", "index.html");
  let html = readFileSync(page, "utf8");
  const before = html;
  html = html.replace(/const SHOT_V = "[^"]*";/, `const SHOT_V = "${v}";`);
  // …and the same version on the markup's own srcs, which JS never rewrites
  // for set 1 — the whole point of shipping those defaults.
  html = html.replace(/(src="shots\/[a-z]+-\d\.webp)(\?v[0-9a-f]+)?"/g, `$1?${v}"`);
  if (html !== before) { writeFileSync(page, html); console.log(`\nstamped preview/index.html with ${v}`); }
  else console.log(`\nversion unchanged (${v})`);
}
console.log("wrote", want.map(w => `${w}-1..3.webp`).join(", "), "to preview/shots/");
