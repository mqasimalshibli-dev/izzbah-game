// Real screenshots of the game, for the landing page — THREE of every screen.
//
//   node about/shots.mjs            # all four screens, three variants each
//   node about/shots.mjs board      # just one screen
//
// The page used to show four stills, two of them twice over (`board` in the
// hero AND step 2, `answer` in the hero AND step 3), so a visitor met the same
// picture four times. This writes `<screen>-1..3.webp` and the page steps to
// the next set on every entry, repeating after the third.
//
// ⚠️ FOUR WAYS TO GET A PLAUSIBLE BUT WRONG SCREENSHOT — no catalogue, no
// fonts, the wrong theme, no question photos. Every one produces a picture that
// looks fine and is not the game. They are cleared by `about/gamedata.mjs`,
// which is shared with `about/clip.mjs`; the reasoning lives there, with the
// code, rather than in two copies that drift.
//
// ⚠️ The board is driven through `state` + `renderGame()` rather than by
// clicking through the welcome/teams flow. Clicking is what the throwaway
// script that produced the original four did, and it breaks on every copy
// change; the state route is what tests/teambox.mjs uses and it survives.
// Starting a game this way also never calls `startGame()`, so no credit is
// spent and no saved game is written.
import { chromium } from "playwright-core";
import { spawn, execFileSync } from "child_process";
import { mkdirSync, existsSync, unlinkSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { catalogue, hydrate, assertFonts, assertLightTheme, injectCatalogue, seatScene, stampVersion }
  from "./gamedata.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "about", "shots");
const PORT = 8611;
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

const only = process.argv[2];
const want = only ? [only] : ["picker", "board", "question", "answer"];

console.log("fetching the published catalogue…");
const cats = await catalogue();
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

const fonts = await assertFonts(page).catch(async e => {
  console.error(e.message + " — aborting."); await browser.close(); server.kill(); process.exit(1);
});
console.log(`fonts ok (Cairo ${fonts.cairo}px vs fallback ${fonts.fake}px)`);

await injectCatalogue(page, cats);
await page.waitForTimeout(600);

await assertLightTheme(page).catch(async e => {
  console.error(e.message + " — aborting."); await browser.close(); server.kill(); process.exit(1);
});

for (let v = 0; v < SCENES.length; v++) {
  const scene = SCENES[v];
  const n = v + 1;
  console.log(`\nscene ${n}: ${scene.teams.join(" · ")}`);

  const chosen = await seatScene(page, scene);
  console.log(`  categories: ${chosen.join(", ")}`);
  await hydrate(page, chosen);

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
    /* Open a question that HAS a picture, by choosing it rather than by
       clicking cells and hoping.
       ⚠️ Clicking was the first approach and it mostly landed on text. The
       board draws ONE question per tier at random out of a bank of a hundred
       and something, and only a handful of those carry media — so a click is a
       lottery, and the six retries it got were nowhere near enough. Worse, the
       "did it get a picture?" test looked for a rendered <img>, and the
       word-guess categories render a QR CODE, which passed.
       `openQuestion` is the same function a cell click calls, so this is the
       real screen, just not left to chance. */
    const picked = await page.evaluate(() => {
      const cats = (state.publishedCategories || []).filter(c => state.selected.has(c.id));
      const usable = cats.filter(c => typeof usesSpecialAnswerMedia !== "function" || !usesSpecialAnswerMedia(c));
      for (const c of usable) {
        /* ⚠️ The in-memory question uses `q`/`a`, NOT `question`/`answer` — that
           is the shape the parent doc stores and the game keeps. Checking
           `x.question` matches nothing and every category looks pictureless. */
        const q = (c.questions || []).find(x => x && x.image && String(x.q || x.question || "").trim());
        if (!q) continue;
        state.used = new Set();
        openQuestion(c, q, "shot-" + c.id);
        return { cat: c.name, points: q.points };
      }
      return null;
    });
    const opened = !!picked;
    if (picked) console.log(`  question: ${picked.cat} · ${picked.points}`);
    // Hard stop: a text-only question card is a poor advertisement and shipping
    // one silently is how the QR screen survived a whole release.
    if (!opened) { console.error(`  scene ${n}: no PICTURED question in any of its categories — aborting`); await browser.close(); server.kill(); process.exit(1); }
    await page.waitForTimeout(1600);
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

// Content-addressed cache-buster — see `stampVersion` in gamedata.mjs for why.
{
  const files = [];
  for (const name of ["picker", "board", "question", "answer"])
    for (let i = 1; i <= 3; i++) {
      const f = join(OUT, `${name}-${i}.webp`);
      if (existsSync(f)) files.push(f);
    }
  const { v, changed } = stampVersion(join(ROOT, "about", "index.html"), files, {
    constant: "SHOT_V",
    // …and the same version on the markup's own srcs, which JS never rewrites
    // for set 1 — the whole point of shipping those defaults.
    srcPattern: /(src="shots\/[a-z]+-\d\.webp)(?:\?v[0-9a-f]+)?"/g,
  });
  console.log(changed ? `\nstamped about/index.html with ${v}` : `\nversion unchanged (${v})`);
}
console.log("wrote", want.map(w => `${w}-1..3.webp`).join(", "), "to about/shots/");
