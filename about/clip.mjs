// The hero's motion clip — one real turn of عِزبة, recorded from the game.
//
//     node about/clip.mjs
//
// writes about/shots/turn.webm + turn.mp4 and stamps the page.
//
// ⚠️ WHY THIS EXISTS. عِزبة is a party game and the site sold it with still
// screenshots. The one thing a still cannot show is the LOOP — pick a square,
// argue over a photo, reveal, take the points — which is the whole product.
// This records that loop from the real game, so it can never depict a version
// of the game that does not exist.
//
// ⚠️ IT IS NOT A SCREEN RECORDING OF SOMEONE PLAYING. The turn is choreographed
// through the same functions a tap calls (`openQuestion`, `revealAnswer`,
// `finishQuestion`), for the reason `shots.mjs` gives about clicking: the board
// draws ONE question per tier at random out of a bank of a hundred and
// something, only a handful carry a photo, so clicking cells is a lottery. The
// cell is still CLICKED with a real mouse — the press animation is part of what
// the clip is for — but only after the board has been seeded so that cell holds
// a pictured question.
//
// ⚠️ THE FIRST SECONDS OF THE RECORDING ARE SETUP. Playwright starts the video
// when the page is created, and the catalogue injection and media hydration
// happen after that, so the raw file opens on the welcome screen. The page is
// covered with a flat slab for the whole of it, and the trim point is found by
// LOOKING FOR THE FRAME WHERE THAT SLAB DISAPPEARS.
// ⚠️ It was measured from the wall clock first, and it was 2.5s out — the video
// does not begin at `newPage()`, it begins whenever the capture pipeline
// actually starts, and the difference is not a constant to be subtracted. That
// error opened the clip on blank cream AND cut the last 2.5s off the end, so
// the turn had no payoff. Measure the file, never the clock.
// ⚠️ The slab is MAGENTA for the same reason: it has to be a colour the game
// can never produce, so "is this still the cover?" is a question about one
// pixel and not a judgement call.
import { chromium } from "playwright-core";
import { spawn, execFileSync } from "child_process";
import { mkdirSync, existsSync, rmSync, readdirSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { catalogue, hydrate, assertFonts, assertLightTheme, injectCatalogue, seatScene, stampVersion }
  from "./gamedata.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "about", "shots");
const TMP = join(ROOT, "about", ".cliptmp");
const PORT = 8615;

/* ⚠️ THE VIEWPORT AND THE RECORDING MUST BE THE SAME SIZE, and that size is the
   device frame the page draws: 1150×550.
   Playwright's `recordVideo.size` only ever scales a page DOWN to fit. A 900×430
   viewport asked to record at 1150×550 is therefore placed at 1:1 and PADDED —
   the first version of this clip sat in the middle of the hero filling about 78%
   of the frame each way with grey margins all round it, which is what the owner
   saw. Matching them is also the sharper answer: nothing is resampled at any
   stage.
   The stills are still captured at 900×430; the aspect matches to within a
   thousandth (2.093 vs 2.091), so the clip and the stills read as one game. */
const CSS = { width: 1150, height: 550 };
const VIDEO = { width: 1150, height: 550 };

/* One scene, deliberately the Omani shelf: it is the library's real
   differentiator and the clip is the first thing a visitor watches. */
const SCENE = {
  cats: ["khareef", "omaniFootball", "cafesRestaurants", "pub-1783170059396-601",
         "pub-1783453062866-1028", "pub-1784798503561-5271"],
  teams: ["أبطال صحار", "شباب نزوى"],
};

/* The turn, in beats. Each is [label, hold-ms] and the labels line up with the
   three `.device-steps` buttons on the page, which seek the video. The cue
   times are computed from the real holds and written into the page, so the
   buttons cannot drift from the choreography. */
const HOLD = {
  board:    1300,   // the board, still — a reader needs a moment to see a board
  press:     900,   // the cell going down and the question opening
  question: 3000,   // long enough to actually read an Arabic question
  reveal:   2600,   // the answer, with the photo
  award:    1800,   // points landing on a team
  settle:   1500,   // back on the board: one cell ticked, the score changed
};

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();

console.log("fetching the published catalogue…");
const cats = await catalogue();
console.log(`  ${cats.length} categories`);

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(OUT, { recursive: true });

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });

const ctx = await browser.newContext({
  viewport: CSS,
  // ⚠️ deviceScaleFactor is deliberately 1. Video capture records CSS pixels;
  // a 2 here costs render time and changes nothing in the file.
  recordVideo: { dir: TMP, size: VIDEO },
});
const page = await ctx.newPage();
page.on("pageerror", e => console.error("  page error:", e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

const t0 = Date.now();                      // ≈ when the video starts
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 40000 });

/* The cover, and the tap indicator that goes with it.
   ⚠️ The RIPPLE is the one thing on the clip that is not the game. Playwright's
   recorder does not draw a cursor, so without it the board simply mutates into
   a question and a viewer never learns that someone TAPPED a square — which is
   the first of the three things this clip exists to show. It is a tap
   indicator, painted over the game the way a screen-recording tool would, and
   it deliberately looks like nothing the game itself renders. */
await page.evaluate(() => {
  const d = document.createElement("div");
  d.id = "__cliphood";
  d.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#ff00ff";
  document.body.appendChild(d);
  const css = document.createElement("style");
  css.textContent = `
    @keyframes __cliptap { from { transform: translate(-50%,-50%) scale(.32); opacity: .9 }
                             to { transform: translate(-50%,-50%) scale(1.5);  opacity: 0 } }
    .__cliptap { position: fixed; width: 92px; height: 92px; border-radius: 50%;
      border: 3px solid rgba(255,255,255,.95); background: rgba(255,255,255,.28);
      z-index: 2147483646; pointer-events: none;
      animation: __cliptap .62s cubic-bezier(.2,.7,.3,1) forwards }`;
  document.head.appendChild(css);
  window.__cliptap = (x, y) => {
    const r = document.createElement("div");
    r.className = "__cliptap";
    r.style.left = x + "px"; r.style.top = y + "px";
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 900);
  };
});
await page.waitForTimeout(2500);

const fonts = await assertFonts(page).catch(async e => {
  console.error(e.message + " — aborting."); await ctx.close(); await browser.close(); server.kill(); process.exit(1);
});
console.log(`fonts ok (Cairo ${fonts.cairo}px vs fallback ${fonts.fake}px)`);

await injectCatalogue(page, cats);
await page.waitForTimeout(500);
await assertLightTheme(page).catch(async e => {
  console.error(e.message + " — aborting."); await ctx.close(); await browser.close(); server.kill(); process.exit(1);
});

const chosen = await seatScene(page, SCENE);
console.log(`categories: ${chosen.join(", ")}`);
await hydrate(page, chosen);

/* Seed the board so ONE named cell can only hold a pictured question.
   ⚠️ The obvious way — writing the saved-game record's `frozen` pin, the same
   mechanism a replay uses — DOES NOT WORK HERE and fails silently. There is no
   saved-game record, because the scene is seated directly into `state` and
   `startGame()` (which creates one) is deliberately never called, so
   `activeSavedGameRecord()` returns null and the pin goes nowhere. `renderGame`
   then draws that tier at random out of a bank of a hundred and something, and
   the first clip shipped a question with no photo on it while the console
   happily reported the pictured one this had chosen.
   So the POOL is narrowed instead: at the target tier, that category keeps only
   the pictured question. Whatever the board picks, it picks that. */
const target = await page.evaluate(() => {
  const cats = (state.publishedCategories || []).filter(c => state.selected.has(c.id));
  const usable = cats.filter(c => typeof usesSpecialAnswerMedia !== "function" || !usesSpecialAnswerMedia(c));
  for (const c of usable) {
    /* ⚠️ `q`/`a`, NOT `question`/`answer` — that is the shape the parent doc
       stores and the game keeps in memory. Checking `x.question` matches
       nothing and every category looks pictureless. */
    const q = (c.questions || []).find(x => x && x.image && String(x.q || "").trim());
    if (!q) continue;
    // Everything else at this tier goes; every other tier is untouched, so the
    // board still draws its full five columns.
    c.questions = c.questions.filter(x => x.points !== q.points || x === q);
    return { id: c.id, name: c.name, points: q.points, q: q.q, a: q.a };
  }
  return null;
});
if (!target) {
  console.error("no PICTURED question in any of the scene's categories — aborting");
  await ctx.close(); await browser.close(); server.kill(); process.exit(1);
}
console.log(`question: ${target.name} · ${target.points} — ${target.q.slice(0, 44)}`);

await page.evaluate(() => { showScreen("game"); renderGame(); });
await page.waitForTimeout(1200);

/* Find the cell on screen. The board is a grid of category cards; the cell's
   text is its point value, so it is located by walking the rendered board
   rather than by an index that a reorder would silently invalidate. */
const cellBox = await page.evaluate(({ id, points }) => {
  const cards = [...document.querySelectorAll("#game .board-category-card")];
  const cats = (typeof activeCategories === "function" ? activeCategories() : []);
  const i = cats.findIndex(c => c.id === id);
  const card = cards[i];
  if (!card) return null;
  const want = String(points);
  const cell = [...card.querySelectorAll(".cell")].find(b => (b.textContent || "").trim() === want);
  if (!cell) return null;
  const r = cell.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}, target);
if (!cellBox) {
  console.error("could not locate the seeded cell on the board — aborting");
  await ctx.close(); await browser.close(); server.kill(); process.exit(1);
}

/* ── the turn ─────────────────────────────────────────────────────── */
await page.mouse.move(cellBox.x, cellBox.y);
await page.evaluate(() => { const d = document.getElementById("__cliphood"); if (d) d.remove(); });
const cue = Date.now();                     // ≈ the clip's zero; the FILE decides
const at = () => (Date.now() - cue) / 1000; // seconds into the clip
const cues = {};

await page.waitForTimeout(HOLD.board);

cues.pick = at();
await page.evaluate(({ x, y }) => window.__cliptap(x, y), cellBox);
await page.mouse.down();
await page.waitForTimeout(160);
await page.mouse.up();
await page.waitForTimeout(HOLD.press);

cues.answer = at();
await page.waitForTimeout(HOLD.question);
await page.evaluate(() => revealAnswer());
await page.waitForTimeout(HOLD.reveal);

cues.score = at();
// Team 0 takes it. `finishQuestion` is what «من جاوب؟» calls.
await page.evaluate(() => finishQuestion(0));
await page.waitForTimeout(HOLD.award);
await page.waitForTimeout(HOLD.settle);

const endedAt = at();
await page.waitForTimeout(300);

const opened = await page.evaluate(() => ({
  used: state.used.size,
  top: Math.max(...state.teams.map(t => t.score)),
  // What the board ACTUALLY opened, read from the game's own history of the
  // turn — `finishQuestion` pushes the question text it just resolved.
  played: (state.history && state.history.length)
    ? state.history[state.history.length - 1].question : "",
}));
if (!opened.used || !opened.top) {
  console.error(`the turn did not play through (used ${opened.used}, top score ${opened.top}) — aborting`);
  await ctx.close(); await browser.close(); server.kill(); process.exit(1);
}
/* ⚠️ Assert that the question on screen is the pictured one this script chose.
   It was not, in the first two takes: the pin silently did nothing and the
   board drew a photo-less question, which no other check here could see —
   `used` and `top` were both correct and the clip was still wrong. */
if (opened.played && opened.played.trim() !== target.q.trim()) {
  console.error(`the board opened a different question:\n  wanted: ${target.q}\n  got:    ${opened.played}`);
  await ctx.close(); await browser.close(); server.kill(); process.exit(1);
}
console.log(`turn played: ${opened.used} cell used, top score ${opened.top}`);

const guess = (cue - t0) / 1000;            // only ever a sanity check
await ctx.close();                          // flushes the video
await browser.close();
server.kill();

/* ── where does the clip actually begin? ──────────────────────────────
   Sample the raw file eight times a second at 16×16 and find the first frame
   that is not the magenta slab. `SAMPLE` is the sampling rate and also the
   precision of the cut; 8 is a 125ms window, which is inside the board's
   opening hold and therefore invisible. */
const SAMPLE = 8;
const probeDir = join(TMP, "probe");
mkdirSync(probeDir, { recursive: true });
const raw = readdirSync(TMP).map(f => join(TMP, f)).filter(f => f.endsWith(".webm"))
  .sort((a, b) => statSync(b).size - statSync(a).size)[0];
if (!raw) { console.error("playwright wrote no video"); process.exit(1); }
sh("ffmpeg", ["-y", "-v", "error", "-i", raw, "-vf", `fps=${SAMPLE},scale=16:16`,
              join(probeDir, "p%05d.png")]);
/* ⚠️ The LAST covered frame, not the first uncovered one. The recording opens
   on a blank white page — the navigation has not finished, so the cover does
   not exist yet — and "first frame that is not magenta" is frame 0 every time.
   That version reported a 0.00s start with a 14.89s drift, i.e. it trimmed
   nothing and produced eleven seconds of setup. */
const covered = sh("python3", ["-c", `
import glob
from PIL import Image
# The slab is #ff00ff. A frame is "covered" while its average is mostly red and
# blue with almost no green — a test no screen of the game can pass.
last, seen = -1, 0
for i, f in enumerate(sorted(glob.glob(${JSON.stringify(join(probeDir, "*.png"))}))):
    px = list(Image.open(f).convert("RGB").getdata())
    n = len(px)
    r = sum(p[0] for p in px) / n
    g = sum(p[1] for p in px) / n
    b = sum(p[2] for p in px) / n
    if r > 200 and b > 200 and g < 60:
        last = i; seen += 1
print(last, seen)
`]).trim().split(/\s+/).map(Number);
const [lastCovered, coveredFrames] = covered;
/* Both halves matter. No covered frames at all means the cover never made it
   into the recording and the trim would be a guess; a cover that never lifts
   means the turn was never captured. Either way the output would be wrong in a
   way that is only visible by watching it. */
if (coveredFrames < SAMPLE) {
  console.error(`only ${coveredFrames} covered frames in the recording — the trim point cannot be trusted. Aborting.`);
  process.exit(1);
}
const start = (lastCovered + 1) / SAMPLE;
/* ⚠️ A sanity check, not the source of truth. The wall clock was the source of
   truth once and was 2.5 seconds out; if the two now disagree by a lot, one of
   them is broken and it is worth being told rather than shipping the result. */
const drift = Math.abs(start - guess);
console.log(`raw ${(statSync(raw).size / 1024).toFixed(0)} KB — cover lifts at ${start.toFixed(2)}s`
  + ` (clock said ${guess.toFixed(2)}s, drift ${drift.toFixed(2)}s)`);
if (drift > 6) console.warn("⚠️  the two estimates disagree by a lot — check the clip before shipping it");
console.log(`trimming ${start.toFixed(2)}s → +${endedAt.toFixed(2)}s`);

/* TWO formats, webm first.
   ⚠️ This shipped as MP4 ONLY for one take, on the reasonable-sounding grounds
   that H.264 is decoded everywhere and VP9 lost on size here (241 KB against
   226 KB — eleven seconds of flat UI colour is close to H.264's best case). The
   size argument was right and the conclusion was wrong: H.264 is a PROPRIETARY
   codec that the open-source Chromium build does not ship, so an mp4-only hero
   cannot be verified — `tests/heroclip.mjs` got videoWidth 0 and a clip that
   never played. Real Chrome would have played it and the test could never have
   said so. Fifteen kilobytes is a cheap price for a hero that is provably
   playing; webm serves Chrome and Firefox, mp4 serves Safari. */
const mp4 = join(OUT, "turn.mp4"), webm = join(OUT, "turn.webm");
/* ⚠️ `-ss` BEFORE `-i` seeks by keyframe and would land wherever the last one
   was; after `-i` it decodes and cuts exactly, which matters when the cut is
   the difference between opening on the board and opening on the welcome
   screen. The clip is a few seconds, so the cost is irrelevant.
   ⚠️ `-vsync cfr` + an explicit `-r`: Playwright's raw capture is variable
   frame rate, and a VFR source handed straight to H.264 gives players a
   duration they disagree about — which shows up as a loop that stutters. */
const common = ["-y", "-i", raw, "-ss", start.toFixed(3), "-t", endedAt.toFixed(3),
                "-an", "-vsync", "cfr", "-r", "25",
                // No scale filter: the capture is already the target size,
                // and a lanczos pass over identical dimensions only softens it.
                ];
sh("ffmpeg", [...common, "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
              "-crf", "27", "-preset", "slow", "-movflags", "+faststart", mp4]);
sh("ffmpeg", [...common, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "42",
              "-row-mt", "1", "-deadline", "good", webm]);
rmSync(TMP, { recursive: true, force: true });

const dur = f => Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration",
  "-of", "default=nw=1:nk=1", f]).trim());
for (const f of [webm, mp4])
  console.log(`  ${f.split("/").pop()} — ${(statSync(f).size / 1024).toFixed(0)} KB, ${dur(f).toFixed(1)}s`);

/* ── stamp the page ───────────────────────────────────────────────────
   The cue times go in beside the version, so the three `.device-steps`
   buttons seek to the moment they name. Hand-written numbers would be right
   until the first time a hold changed. */
/* ⚠️ No `srcPattern` here, unlike the stills. The clip's URL is built by the
   page's driver (`s.dataset.src + "?" + CLIP_V`) because the source is armed
   lazily, so the markup must stay version-free. Passing the stills' pattern
   stamped `data-src` too — it ends in `src="` — and the driver then appended a
   SECOND query string to an already-stamped URL. */
const { v, changed } = stampVersion(join(ROOT, "about", "index.html"), [webm, mp4], {
  constant: "CLIP_V",
});
{
  const { readFileSync, writeFileSync } = await import("fs");
  const p = join(ROOT, "about", "index.html");
  const line = `const CLIP_CUES = [${[0, cues.answer, cues.score].map(n => n.toFixed(2)).join(", ")}];`;
  let html = readFileSync(p, "utf8");
  if (!/const CLIP_CUES = \[[^\]]*\];/.test(html))
    console.warn("⚠️  no CLIP_CUES line in about/index.html — the step buttons will not seek");
  else { writeFileSync(p, html.replace(/const CLIP_CUES = \[[^\]]*\];/, line)); console.log(`cues ${line}`); }
}
console.log(changed ? `stamped about/index.html with ${v}` : `version unchanged (${v})`);
