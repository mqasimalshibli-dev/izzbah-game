// The hero's motion clip — one real turn of عِزبة, playing on the landing page.
//
// The site sold a party game with still screenshots. `preview/clip.mjs` records
// the loop the stills cannot show — pick a square, read the photo, reveal, take
// the points — from the real game, and the hero plays it.
//
// What has to stay true, and why each of these is here:
//
// ⚠️ THE STILLS MUST SURVIVE AS THE FALLBACK. Reduced motion, a refused
// autoplay, a data-saver browser, a 404 on the file — every one of those has to
// land on the three-screen slideshow that shipped before the clip existed, not
// on a black rectangle where the hero was. There is no way to see that by
// looking at a working page, so all four are exercised.
//
// ⚠️ IT MUST NOT COST A COLD BOOT. This is the hero of a page whose boot weight
// has been fought for twice (see the .217 notes). The clip is a quarter of a
// megabyte, so it is armed lazily and must download NOTHING until the device is
// on screen. A `preload` left at `auto` would undo that silently.
//
// ⚠️ THE STEP LABELS MUST TELL THE TRUTH. «اختاروا خانة / جاوبوا / خذوا النقاط»
// seek the clip, and their cue times are written into the page by the recorder
// from the real choreography. Hand-typed numbers were the alternative and they
// would be wrong the first time a hold changed.
import { chromium } from "playwright-core";
import { readFileSync, existsSync, statSync, createReadStream } from "fs";
import { execFileSync } from "child_process";
import { createServer } from "http";
import { fileURLToPath } from "url";
import { dirname, join, extname, normalize } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MP4 = join(ROOT, "preview", "shots", "turn.mp4");
const WEBM = join(ROOT, "preview", "shots", "turn.webm");
const PORT = 8779;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`); };

/* ── the files ────────────────────────────────────────────────────
   ⚠️ BOTH formats, and webm is not optional. H.264 is proprietary and the
   open-source Chromium build does not ship it, so an mp4-only hero cannot be
   verified by anything here — the first take got videoWidth 0 and a clip that
   never played, while real Chrome would have played it fine. webm is what makes
   the playback checks below mean something; mp4 is what serves Safari. */
check("both encodes exist", existsSync(MP4) && existsSync(WEBM),
  `mp4 ${existsSync(MP4)}, webm ${existsSync(WEBM)}`);
if (!existsSync(MP4) || !existsSync(WEBM)) { console.log("\n1 check(s) FAILED"); process.exit(1); }

const kb = (statSync(MP4).size + statSync(WEBM).size) / 2 / 1024;
const CLIP = MP4;
/* A budget, not a description. The hero of a page that fought its boot weight
   down twice does not get to grow a megabyte of video by accident; 600 KB is
   roughly three times what the current encode costs, so a real regression in
   the encoder settings trips it and ordinary variation between takes does not. */
check(`it is small enough to be a hero asset (${kb.toFixed(0)} KB each)`, kb < 600);

const probe = (...args) => execFileSync("ffprobe", ["-v", "error", ...args]).toString().trim();
const meta = probe("-select_streams", "v:0", "-show_entries",
  "stream=width,height,codec_name,nb_frames:format=duration", "-of", "default=nw=1", CLIP)
  .split("\n").reduce((o, l) => { const [k, v] = l.split("="); o[k] = v; return o; }, {});
check("it is H.264 in MP4 — the one format every browser decodes",
  meta.codec_name === "h264", meta.codec_name);
check("it matches the device frame the page draws", meta.width === "1150" && meta.height === "550",
  `${meta.width}×${meta.height}`);
/* Long enough to show the whole loop, short enough to loop without becoming
   wallpaper. The recorder's holds add up to about eleven seconds. */
const dur = Number(meta.duration);
check(`it is a loop, not a film (${dur.toFixed(1)}s)`, dur > 6 && dur < 20);
const wmeta = probe("-select_streams", "v:0", "-show_entries", "stream=codec_name:format=duration",
  "-of", "default=nw=1", WEBM).split("\n").reduce((o, l) => { const [k, v] = l.split("="); o[k] = v; return o; }, {});
check("the webm is VP9 and the same length", wmeta.codec_name === "vp9"
  && Math.abs(Number(wmeta.duration) - Number(meta.duration)) < 0.3,
  `${wmeta.codec_name}, ${Number(wmeta.duration).toFixed(1)}s vs ${Number(meta.duration).toFixed(1)}s`);
// No audio track at all — not muted, absent. A muted track is bytes nobody hears.
const audio = probe("-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", CLIP);
check("it carries no audio track", audio === "", audio);

/* ── the page's own numbers ───────────────────────────────────── */
const src = readFileSync(join(ROOT, "preview", "index.html"), "utf8");
const cues = (src.match(/const CLIP_CUES = \[([^\]]*)\];/) || [])[1];
const cueList = (cues || "").split(",").map(s => Number(s.trim()));
check("the page carries the recorder's cue times", cueList.length === 3 && cueList.every(n => !isNaN(n)),
  cues);
/* ⚠️ The recorder writes these; the placeholder it ships with is all zeros. All
   three at zero means every step button seeks to the start — the buttons would
   still "work" and would all do the same thing. */
check("and they are the real ones, not the placeholder",
  cueList.some(n => n > 0) && cueList[0] === 0 && cueList[1] < cueList[2],
  cueList.join(" · "));
check("every cue lands inside the clip", cueList.every(n => n >= 0 && n < dur),
  `last cue ${cueList[2]} of ${dur.toFixed(1)}s`);
const clipV = (src.match(/const CLIP_V = "([^"]*)";/) || [])[1];
check("the clip has a cache-busting version stamped from its bytes",
  /^v[0-9a-f]{8}$/.test(clipV || ""), clipV);
// ⚠️ The markup must stay version-free: the driver appends CLIP_V itself, and
// a version in both places produced `turn.mp4?v…?v…`.
check("the markup's data-src carries no version of its own",
  /data-src="shots\/turn\.mp4"/.test(src) && /data-src="shots\/turn\.webm"/.test(src));
/* ⚠️ webm BEFORE mp4. A browser takes the first `<source>` it can play, so the
   order is what decides whether Chrome downloads the smaller file or the
   larger one — and it is invisible in every rendering check. */
check("webm is offered first, mp4 as the fallback",
  src.indexOf('data-src="shots/turn.webm"') < src.indexOf('data-src="shots/turn.mp4"'));
// The hero is a quarter of a megabyte of video; it must not be in the boot read.
check("the video does not preload", /<video[^>]*preload="none"/.test(src));

/* ⚠️ A RANGE-CAPABLE SERVER, not `python3 -m http.server` like every other test
   here. Python's SimpleHTTPRequestHandler answers every request with a plain
   200 and no `Accept-Ranges`, so a browser cannot seek inside the video: setting
   `currentTime = 8.5` snapped straight back to 0.5 and the two step-button
   checks below failed against a page that is perfectly correct. GitHub Pages
   serves ranges, so the site is fine — the harness was not. */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".mp4": "video/mp4", ".webm": "video/webm",
  ".ico": "image/x-icon", ".json": "application/json" };
const server = createServer((req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  const size = statSync(file).size;
  const type = TYPES[extname(file)] || "application/octet-stream";
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, { "Content-Type": type, "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": size });
  createReadStream(file).pipe(res);
}).listen(PORT);
await new Promise(r => setTimeout(r, 400));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

const open = async (opts = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
  const page = await ctx.newPage();
  page.on("pageerror", e => errs.push(e.message));
  return { ctx, page };
};
const url = `http://127.0.0.1:${PORT}/preview/index.html`;

try {
  /* ── it plays ─────────────────────────────────────────────── */
  {
    const { ctx, page } = await open();
    const asked = [];
    page.on("request", r => { if (/turn\.(mp4|webm)/.test(r.url())) asked.push(r.url()); });
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(2500);

    const v = await page.evaluate(() => {
      const el = document.getElementById("heroClip");
      return el && {
        exists: true, paused: el.paused, t: el.currentTime, loop: el.loop, muted: el.muted,
        on: el.classList.contains("on"),
        w: el.videoWidth, h: el.videoHeight,
        stills: [...document.querySelectorAll("#device img[data-shot]")].length,
        // the stills stay in the DOM as the fallback — they are just covered
        stillsOn: [...document.querySelectorAll("#device img.on")].length,
      };
    });
    check("the clip is in the hero", v && v.exists);
    check("it is playing", v && !v.paused, v && `paused=${v.paused}, t=${(v.t || 0).toFixed(2)}`);
    check("it has really decoded, not just been created",
      v && v.w === 1150 && v.h === 550, v && `${v.w}×${v.h}`);
    check("it loops and is muted — the two things autoplay depends on", v && v.loop && v.muted);
    check("it is visible over the stills", v && v.on);
    check("and the stills are still there underneath, as the fallback", v && v.stills === 3);
    check("the file was fetched exactly once", asked.length === 1, `${asked.length} requests`);
    check("and the fetch carried the version", /\?v[0-9a-f]{8}$/.test(asked[0] || ""), asked[0]);

    // The step labels follow the clip rather than sitting on the first one.
    const stepAt = async t => {
      await page.evaluate(t => { const el = document.getElementById("heroClip"); el.currentTime = t; }, t);
      await page.waitForTimeout(500);
      return page.evaluate(() => [...document.querySelectorAll(".dstep")].findIndex(s => s.classList.contains("on")));
    };
    check("the step labels follow the clip", await stepAt(cueList[2] + 0.4) === 2);
    check("and go back with it", await stepAt(0.2) === 0);

    // Pressing a step seeks — the three words are a scrubber while it plays.
    await page.click(".dstep[data-i='1']");
    await page.waitForTimeout(400);
    const sought = await page.evaluate(() => document.getElementById("heroClip").currentTime);
    check("pressing a step seeks the clip to that beat",
      Math.abs(sought - cueList[1]) < 1.2, `seeked to ${sought.toFixed(2)}, cue ${cueList[1]}`);
    await ctx.close();
  }

  /* ── reduced motion: the stills, and NOT one byte of video ── */
  {
    const { ctx, page } = await open({ reducedMotion: "reduce" });
    const asked = [];
    page.on("request", r => { if (/turn\.(mp4|webm)/.test(r.url())) asked.push(r.url()); });
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(2200);
    const r = await page.evaluate(() => ({
      on: document.getElementById("heroClip").classList.contains("on"),
      stills: [...document.querySelectorAll("#device img.on")].length,
    }));
    await ctx.close();
    check("reduced motion never arms the clip", !r.on);
    /* ⚠️ Not just "it does not play" — it must not DOWNLOAD. Someone who has
       asked their system for less motion should not be paying for a video they
       will never see. */
    check("and downloads none of it", asked.length === 0, `${asked.length} requests`);
    check("the stills carry the hero instead", r.stills === 1);
  }

  /* ── armed by the observer, not by the parser ─────────────────
     ⚠️ There is no "it must not download until scrolled to" test here, and that
     is deliberate rather than an omission: the device is IN the hero, so on a
     real visit it is on screen at once and downloading immediately is the
     correct behaviour. The property that matters is that the fetch is the
     driver's decision (preload="none" + the observer) and not the parser's —
     which is what makes the reduced-motion case above able to skip it. */
  /* ── the file is missing ──────────────────────────────────────
     A 404 has to look like the page before the clip existed, not like a hole
     where the hero was. */
  {
    const { ctx, page } = await open();
    await page.route("**/turn.*", r => r.fulfill({ status: 404, body: "" }));
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(2500);
    const r = await page.evaluate(() => ({
      on: document.getElementById("heroClip").classList.contains("on"),
      stills: [...document.querySelectorAll("#device img.on")].length,
      opacity: +getComputedStyle(document.getElementById("heroClip")).opacity,
    }));
    await ctx.close();
    check("a missing clip leaves the stills showing", !r.on && r.stills === 1 && r.opacity === 0,
      `on=${r.on}, stills=${r.stills}, opacity=${r.opacity}`);
  }

  /* ── autoplay refused ─────────────────────────────────────────
     Data-saver and battery-saver modes reject `play()`. The promise rejection
     must be caught — an unhandled one is an uncaught error on the hero — and
     the slideshow must keep running rather than freezing on frame one. */
  {
    const { ctx, page } = await open();
    await page.addInitScript(() => {
      const P = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () { return Promise.reject(new DOMException("NotAllowedError")); };
      void P;
    });
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(3000);
    const r = await page.evaluate(() => ({
      on: document.getElementById("heroClip").classList.contains("on"),
      stills: [...document.querySelectorAll("#device img.on")].length,
    }));
    await ctx.close();
    check("a refused autoplay does not raise an error", errs.length === 0, errs[0] || "");
    check("and the slideshow carries on", !r.on && r.stills === 1, `on=${r.on}, stills=${r.stills}`);
  }

  check("no page errors" + (errs.length ? ": " + errs[0] : ""), errs.length === 0);
} finally {
  await browser.close();
  server.close();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
