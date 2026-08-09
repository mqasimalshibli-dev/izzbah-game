// «من الي سجل؟» sketch filter — question clips are rendered to black-and-white
// line art in the browser BEFORE upload, so the unfiltered original never
// reaches R2 and cannot be fished out of the network tab. In that category the
// clean video is the answer.
//
// Two real bugs are pinned here, both found by testing rather than reading:
//   • sketchSupported() used to ask ONE canvas for both a 2D and a WebGL
//     context. The second call always returns null, so it reported every
//     browser as unsupported and the filter would never have run anywhere.
//   • MediaRecorder.isTypeSupported("video/mp4") returns true in Chromium,
//     which then writes VP9-in-MP4 — a pair Safari and iOS refuse to play.
//     Candidates must name their codecs, and the extension must follow the
//     CODECS, not the container.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8373;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({
  executablePath: process.env.IZZBAH_CHROMIUM,
  // WebGL is off by default in headless; the filter needs it
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 460, height: 860 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH && typeof window.IZZBAH.sketchifyVideo === "function", { timeout: 15000 });

  // ---- 1) which categories get the filter ----
  const cat = await page.evaluate(() => {
    const f = window.IZZBAH.isSketchVideoCategory;
    return {
      byId:      f({ id: "pub-1784043823835-6035", name: "" }),
      byName:    f({ id: "whatever", name: "من الي سجل؟" }),
      spelling:  f({ id: "x", name: "من اللي سجل" }),   // both spellings in use
      football:  f({ id: "footballMix", name: "منوعات كرة قدم" }),
      unrelated: f({ id: "geo", name: "جغرافيا" }),
      empty:     f(null),
    };
  });
  check("the goalscorer category is matched by id", cat.byId);
  check("...and by name, so a re-publish keeps working", cat.byName);
  check("...including the «من اللي» spelling", cat.spelling);
  check("other football categories are NOT filtered", !cat.football);
  check("unrelated categories are NOT filtered", !cat.unrelated);
  check("a missing category is handled", !cat.empty);

  // ---- 2) codec selection ----
  const mime = await page.evaluate(() => ({
    chosen: window.IZZBAH.sketchMimeType(),
    extVp9: window.IZZBAH.sketchExtFor("video/mp4;codecs=vp9"),   // the trap
    extH264: window.IZZBAH.sketchExtFor("video/mp4;codecs=h264,aac"),
    extWebm: window.IZZBAH.sketchExtFor("video/webm;codecs=vp8,opus"),
    extJunk: window.IZZBAH.sketchExtFor(""),
  }));
  check("a codec-explicit mime type is chosen", /codecs=/.test(mime.chosen) || mime.chosen === "video/webm");
  check("bare video/mp4 is never chosen", mime.chosen !== "video/mp4");
  check("VP9 gets .webm even when the container claims mp4", mime.extVp9 === "webm");
  check("h264 gets .mp4", mime.extH264 === "mp4");
  check("vp8 gets .webm", mime.extWebm === "webm");
  check("an unknown type falls back to .webm", mime.extJunk === "webm");

  // ---- 3) the capability probe ----
  // The old version asked one canvas for two context types and always said no.
  const sup = await page.evaluate(() => {
    const twoD = !!document.createElement("canvas").getContext("2d");
    const gl = !!(document.createElement("canvas").getContext("webgl")
             || document.createElement("canvas").getContext("experimental-webgl"));
    return { reported: window.IZZBAH.sketchSupported(), twoD, gl, rec: typeof MediaRecorder === "function" };
  });
  check("support probe agrees with the browser's real capabilities",
    sup.reported === (sup.twoD && sup.gl && sup.rec));

  // ---- 4) an actual clip through the filter ----
  if (!sup.reported) {
    console.log("SKIP  filter run — this browser lacks WebGL/MediaRecorder");
  } else {
    const out = await page.evaluate(async () => {
      // build a short clip in-page so the test needs no codec-dependent fixture
      const c = document.createElement("canvas"); c.width = 320; c.height = 240;
      const x = c.getContext("2d");
      const stream = c.captureStream(30);
      const rec = new MediaRecorder(stream);
      const parts = [];
      rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
      rec.start();
      for (let i = 0; i < 30; i++) {
        x.fillStyle = "#2b7"; x.fillRect(0, 0, 320, 240);
        x.fillStyle = "#111"; x.fillRect(40 + i * 4, 60, 90, 120);   // a moving dark shape
        x.fillStyle = "#fff"; x.font = "28px sans-serif"; x.fillText("9", 70 + i * 4, 130);
        // A STATIC dark slab with one long, clean horizontal edge at y=180.
        // The filter inks that edge; how THICK the inked band is measures the
        // stroke weight directly — which is the parameter that made the output
        // "too heavy" — and it is a far steadier signal than any ink
        // percentage. Kept clear of the moving shape and the text.
        x.fillStyle = "#151515"; x.fillRect(0, 180, 320, 60);
        await new Promise(r => setTimeout(r, 33));
      }
      rec.stop();
      await new Promise(r => { rec.onstop = r; });
      const src = new File(parts, "src.webm", { type: "video/webm" });
      /* The source is RECORDED here rather than shipped as a fixture, so a
         starved CPU can hand back zero chunks — the 33ms frame loop simply
         never runs often enough for MediaRecorder to emit anything. Filtering
         an empty file makes sketchifyVideo reject with "sketch-empty", which
         reads exactly like the filter being broken. Report it as what it is. */
      if (!src.size) return { noSource: true };

      const seen = [];
      const filtered = await window.IZZBAH.sketchifyVideo(src, p => seen.push(p));

      // decode a frame of the result and measure it
      const url = URL.createObjectURL(filtered);
      const v = document.createElement("video"); v.src = url; v.muted = true;
      await new Promise(r => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 4000); });
      v.currentTime = 0.3;
      await new Promise(r => { v.onseeked = r; setTimeout(r, 2000); });
      const oc = document.createElement("canvas");
      oc.width = v.videoWidth || 2; oc.height = v.videoHeight || 2;
      oc.getContext("2d").drawImage(v, 0, 0);
      let black = 0, white = 0, colour = 0, n = 0;
      if (v.videoWidth) {
        const d = oc.getContext("2d").getImageData(0, 0, oc.width, oc.height).data;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          if (Math.max(r, g, b) - Math.min(r, g, b) > 28) colour++;
          if (r < 40) black++; else if (r > 215) white++;
          n++;
        }
      }
      /* Is the slab's top edge (y=180 of 240) drawn at all? Measured as the
         share of INK in a band straddling it, across the FULL width.
         Per-column run lengths were tried first and were flaky: the moving
         shape sits directly on that edge for part of its travel, so which
         columns carry a visible edge depends on where the seek lands. Summing
         the whole band does not care.
         «Ink» is anything darker than paper, at any strength — a tonal ramp
         draws plenty of real edges that never reach full black, so a <60 test
         reports a good line as missing. */
      let edgeInk = -1;
      if (v.videoWidth) {
        const edgeY = Math.round(180 / 240 * oc.height);
        const half = Math.max(3, Math.round(8 / 240 * oc.height));
        const top = Math.max(0, edgeY - half);
        const band = oc.getContext("2d").getImageData(0, top, oc.width, Math.min(half * 2, oc.height - top)).data;
        let dark = 0, tot = 0;
        for (let i = 0; i < band.length; i += 4) { if (band[i] < 200) dark++; tot++; }
        edgeInk = tot ? dark / tot * 100 : -1;
      }
      // Tonal now, so the interesting statistics are the mean level and how
      // much of the frame is neither paper nor full ink.
      let meanLum = -1, midPct = -1;
      if (v.videoWidth) {
        const d2 = oc.getContext("2d").getImageData(0, 0, oc.width, oc.height).data;
        let sum = 0, mid = 0, n2 = 0;
        for (let i = 0; i < d2.length; i += 4) {
          sum += d2[i]; n2++;
          if (d2[i] > 45 && d2[i] < 225) mid++;
        }
        meanLum = sum / n2; midPct = mid / n2 * 100;
      }
      return { meanLum, midPct, edgeInk, name: filtered.name, type: filtered.type, size: filtered.size,
               w: v.videoWidth, h: v.videoHeight, progress: seen.length,
               blackPct: n ? black / n * 100 : -1, whitePct: n ? white / n * 100 : -1,
               colourPct: n ? colour / n * 100 : -1 };
    });

    if (out.noSource) {
      console.log("SKIP  filter run — this machine could not record a source clip");
    } else {
    check("the filter returns a non-empty file", out.size > 0);
    check("the result decodes as video", out.w > 0 && out.h > 0);
    check("the extension matches the declared type",
      (out.type === "video/webm" && /\.webm$/.test(out.name)) ||
      (out.type === "video/mp4" && /\.mp4$/.test(out.name)));
    check("progress is reported while encoding", out.progress > 0);
    check("output is black and white — no colour survives", out.colourPct >= 0 && out.colourPct < 1);
    /* The filter is TONAL as of .288 — ink strength follows edge strength — so
       "two-tone" is no longer the goal and asserting it would pin the very
       thing that made a crowd render as a black mass. What must hold instead is
       that the result reads as graphite ON PAPER. */
    check("the result is mostly paper, not a dark mass", out.meanLum > 190,
      `mean luminance ${out.meanLum.toFixed(0)}/255`);
    check("output actually has ink in it", out.blackPct > 0.2, `${out.blackPct.toFixed(2)}% full ink`);
    /* The signature of the tonal ramp: real mid-greys. A revert to the old
       step() shader makes this collapse towards zero, since every pixel is then
       either paper or full black. */
    check("ink is graded, not switched on and off", out.midPct > 1.5,
      `${out.midPct.toFixed(1)}% mid-tones`);
    /* An edge still has to be DRAWN — "light" must not have become "blank". The
       slab's boundary is the one mark guaranteed to be in every frame. */
    check(`a hard edge is still inked (${out.edgeInk.toFixed(1)}% of the band)`, out.edgeInk > 8);
    console.log(`      (${out.w}x${out.h}, ${Math.round(out.size/1024)}KB, black ${out.blackPct.toFixed(1)}% / white ${out.whitePct.toFixed(1)}%)`);
    }
  }

  check("no page errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 3));
} catch (e) {
  check(`threw: ${e && e.message}`, false);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
