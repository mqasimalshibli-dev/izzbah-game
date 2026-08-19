// The landing page's screenshots of the game — three of every screen.
//
// It used to ship four stills, and two of them appeared TWICE on the one page:
// `board` in the hero device and again in the "how it works" strip, `answer` in
// the hero and again in step 3. A visitor met the same picture four times.
//
// `preview/shots.mjs` now writes `<screen>-1..3.webp` from three different
// games, and the page steps to the next set on every entry, wrapping after the
// third. This pins the contract that makes that worth anything:
//
// ⚠️ THE FILES MUST EXIST AND DIFFER. Three names pointing at three copies of
// the same capture would satisfy every structural check here and change
// nothing a reader sees, so the bytes are compared.
// ⚠️ THE TWO PLACES MUST NOT AGREE. The hero and the strip both show a board
// and both show an answer; give them the same set and the page is back to
// showing one picture twice, which is the whole complaint.
// ⚠️ AND IT MUST WRAP. Three sets, then back to the first — not a counter that
// climbs into `board-4.webp` and 404s on the fourth visit.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "preview", "shots");
const PORT = 8613;
const checks = [];
const check = (n, ok, extra) => {
  checks.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`);
};

const SCREENS = ["picker", "board", "question", "answer"];
const SETS = 3;

/* ── on disk ─────────────────────────────────────────────────── */
for (const name of SCREENS) {
  const files = [];
  for (let i = 1; i <= SETS; i++) {
    const f = join(SHOTS, `${name}-${i}.webp`);
    if (existsSync(f)) files.push(readFileSync(f));
  }
  check(`${name}: all ${SETS} sets exist`, files.length === SETS, `${files.length}/${SETS}`);
  if (files.length === SETS) {
    // Byte comparison, because "three files" is not the same claim as "three
    // different pictures" and only one of them is worth anything.
    const same = new Set(files.map(b => b.length + ":" + b.subarray(0, 512).toString("base64")));
    check(`${name}: the three are actually different captures`, same.size === SETS,
      files.map(b => (b.length / 1024).toFixed(0) + "KB").join(", "));
  }
}

/* ── in the page ─────────────────────────────────────────────── */
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [], http = [];

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", e => errs.push(e.message));
  page.on("response", r => { if (r.status() >= 400) http.push(r.status() + " " + r.url().split("/").pop()); });

  // Six visits: two full laps of the three sets.
  const seen = [];
  for (let visit = 0; visit < SETS * 2; visit++) {
    await page.goto(`http://127.0.0.1:${PORT}/preview/index.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(700);
    seen.push(await page.evaluate(() => {
      const of = sel => [...document.querySelectorAll(sel)]
        .map(i => (i.getAttribute("src") || "").split("/").pop());   // keeps the ?version
      return { hero: of("#device img[data-shot]"), strip: of("img[data-shot]:not(#device img)") };
    }));
  }

  /* ── the question and answer cards must SHOW something ────────────
     The owner asked for pictured questions only, and the capture aborts if it
     cannot find one — but the capture is where the mistake would be made, so
     the files are checked here independently. A text-only card is a wall of
     cream with a line of type on it; a photographed one has a block of colour
     in the middle. Measuring the spread of colour across the centre separates
     them without needing to know what the picture is.
     ⚠️ Not file size: a small photo and a long question can weigh the same.
     ⚠️ IN THE BROWSER, not through Pillow. This was a `python3 -c "from PIL
     import …"`, which works on any machine that has happened to install it and
     fails on a GitHub runner, which has not — so the step crashed on import and
     the whole test was red in CI while passing locally. Chromium is already a
     dependency here and decodes WebP; a second one is not worth having. */
  const spread = await page.evaluate(async files => {
    const out = {};
    for (const f of files) {
      const im = new Image();
      im.src = f;
      await im.decode();
      const c = document.createElement("canvas");
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      const g = c.getContext("2d");
      g.drawImage(im, 0, 0);
      const x = Math.round(c.width * 0.25), y = Math.round(c.height * 0.22);
      const w = Math.round(c.width * 0.5), h = Math.round(c.height * 0.58);
      const d = g.getImageData(x, y, w, h).data;
      const n = d.length / 4;
      let sum = [0, 0, 0], sq = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4)
        for (let k = 0; k < 3; k++) { sum[k] += d[i + k]; sq[k] += d[i + k] * d[i + k]; }
      out[f] = +([0, 1, 2].reduce((a, k) =>
        a + Math.sqrt(Math.max(0, sq[k] / n - (sum[k] / n) ** 2)), 0) / 3).toFixed(1);
    }
    return out;
  }, SCREENS.slice(2).flatMap(n => [1, 2, 3].map(i => `shots/${n}-${i}.webp`)));

  for (const [f, sd] of Object.entries(spread)) {
    /* Calibrated against real shots rather than guessed: the text-only
       «قديمك نديمك» card that shipped scores 30.8, the pictured ones 54–81.
       ⚠️ This does NOT catch the word-guess QR screen — a QR is high-contrast
       and scores well above any threshold that would let a photograph through.
       That one is kept out at capture time, by asking the game which categories
       behave that way. Two different mistakes, two different guards. */
    check(`${f.split("/").pop()} shows a picture, not a wall of text`, sd >= 42,
      `colour spread ${sd}`);
  }

  check("every shot on the page is a numbered set",
    seen.every(v => [...v.hero, ...v.strip].every(f => /-[123]\.webp(\?|$)/.test(f))),
    seen[0].hero.join(", "));

  /* ⚠️ Every shot URL carries the version `preview/shots.mjs` stamps from the
     files' own bytes. Re-capturing keeps the same twelve FILENAMES, so without
     it a browser that already has them keeps showing the old pictures — the
     shots were replaced, the site served the new ones, and it read as a deploy
     that had not happened. It had. */
  const stamped = seen.every(v => [...v.hero, ...v.strip].every(f => /\?v[0-9a-f]{8}$/.test(f)));
  check("each shot URL carries the capture's version", stamped, seen[0].hero[0]);

  const setOf = f => Number((f.match(/-(\d)\.webp/) || [])[1]);
  const heroSets = seen.map(v => setOf(v.hero[0]));
  check("a visit moves to the next set", heroSets[1] !== heroSets[0], heroSets.join(" → "));
  check("it wraps after the third rather than running off the end",
    heroSets.every(n => n >= 1 && n <= SETS) && heroSets[3] === heroSets[0],
    heroSets.join(" → "));
  check("all three sets are reached", new Set(heroSets).size === SETS);

  // The hero is internally consistent — a board, question and answer from the
  // SAME game. Mixing them would show a question that was never on that board.
  check("each visit's hero shows one coherent game",
    seen.every(v => new Set(v.hero.map(setOf)).size === 1),
    seen.map(v => v.hero.map(setOf).join("")).join(" "));

  // …and the strip never repeats the hero's pictures.
  check("the strip never shows the hero's set",
    seen.every(v => setOf(v.strip[0]) !== setOf(v.hero[0])),
    seen.map(v => setOf(v.hero[0]) + "/" + setOf(v.strip[0])).join(" "));

  check("no missing files" + (http.length ? ": " + http[0] : ""), http.length === 0);
  check("no page errors" + (errs.length ? ": " + errs[0] : ""), errs.length === 0);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
