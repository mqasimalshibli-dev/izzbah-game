// «كتم صوت المقطع» — the mute option on the admin's video trim step (.286).
//
// There are deliberately TWO mechanisms behind one checkbox, and conflating
// them is the mistake this file exists to prevent:
//
//   * An ordinary video is NOT re-encoded (the same reason trimming is a
//     fragment and not a cut: in-browser re-encoding is slow and unreliable
//     across formats). Muting is stored as «#mute» on the URL and honoured at
//     playback. The audio is still inside the file — this is presentation.
//   * A «من الي سجل؟» clip is already being re-encoded by the sketch filter, so
//     there the audio track is simply never attached and the sound never leaves
//     the device. That one is a real strip, because the commentary names the
//     scorer and would hand over the answer the picture is filtered to hide.
//
// The fragment grammar is the fragile part: «#t=start,end» is matched at the
// END of the string, so the mute flag has to be written ahead of it and the
// trim parser has to keep working with a «&t=» separator. A mute that quietly
// broke trimming would look fine until someone played a clipped question.
//
// Run:  IZZBAH_CHROMIUM=/path/to/chrome node tests/mutevideo.mjs

import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8286;
const checks = [];
const check = (name, ok, extra) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM || undefined });
const jsErrors = [];

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 950 } });
  await page.route("**/firebasejs/**", r => r.abort());
  await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
  page.on("pageerror", e => jsErrors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH_TEST && window.IZZBAH_TEST.mediaMuted, { timeout: 15000 });

  // ── the grammar ─────────────────────────────────────────────────────────
  const g = await page.evaluate(() => {
    const { mediaMuted, mediaFragment } = window.IZZBAH_TEST;
    const F = s => { const f = mediaFragment(s); return f ? [f.start, f.end] : null; };
    return {
      plain:      [mediaMuted("a.mp4"), F("a.mp4")],
      muteOnly:   [mediaMuted("a.mp4#mute"), F("a.mp4#mute")],
      trimOnly:   [mediaMuted("a.mp4#t=1.5,4.0"), F("a.mp4#t=1.5,4.0")],
      both:       [mediaMuted("a.mp4#mute&t=1.5,4.0"), F("a.mp4#mute&t=1.5,4.0")],
      // a filename that merely CONTAINS the word must not be treated as muted
      lookalike:  [mediaMuted("a-mute-song.mp4"), mediaMuted("a.mp4#muted")],
    };
  });
  check("a plain URL is neither muted nor trimmed", g.plain[0] === false && g.plain[1] === null);
  check("«#mute» alone reads as muted", g.muteOnly[0] === true);
  check("«#mute» alone is not mistaken for a trim", g.muteOnly[1] === null, JSON.stringify(g.muteOnly[1]));
  check("a trim alone is not mistaken for muted", g.trimOnly[0] === false);
  check("a trim alone still parses", JSON.stringify(g.trimOnly[1]) === "[1.5,4]", JSON.stringify(g.trimOnly[1]));
  // The regression that matters: mute must not eat the trim.
  check("mute + trim: both are read", g.both[0] === true && JSON.stringify(g.both[1]) === "[1.5,4]",
    `muted=${g.both[0]} range=${JSON.stringify(g.both[1])}`);
  check("a filename containing «mute» is not muted", g.lookalike[0] === false && g.lookalike[1] === false,
    JSON.stringify(g.lookalike));

  // ── playback actually honours it ────────────────────────────────────────
  const play = await page.evaluate(() => {
    const mk = src => {
      const v = document.createElement("video");
      window.IZZBAH_TEST.applyClipPlayback(v, src);
      return { muted: v.muted, defaultMuted: v.defaultMuted };
    };
    return { off: mk("a.mp4"), on: mk("a.mp4#mute"), both: mk("a.mp4#mute&t=1,3") };
  });
  check("an unmuted clip plays with sound", play.off.muted === false);
  check("a muted clip plays silent", play.on.muted === true && play.on.defaultMuted === true);
  check("mute survives alongside a trim", play.both.muted === true);

  // ── the admin control ───────────────────────────────────────────────────
  const ui = await page.evaluate(async () => {
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    const vid = new File([bytes], "clip.mp4", { type: "video/mp4" });
    const aud = new File([bytes], "voice.m4a", { type: "audio/mp4" });
    const seen = {};
    const openWith = async (file, opts) => {
      let got = "unset";
      window.IZZBAH_TEST.openMediaTrim(file, (frag, choice) => { got = { frag, choice }; }, opts);
      await new Promise(r => setTimeout(r, 250));
      const row = document.getElementById("trimMuteRow");
      const state = { rowHidden: row.hidden, sub: document.getElementById("trimMuteSub").textContent.trim() };
      return { state, result: () => got };
    };
    // video → the row is offered
    let s = await openWith(vid, null);
    seen.videoRow = s.state;
    document.getElementById("trimMute").checked = true;
    document.getElementById("trimFull").click();
    await new Promise(r => setTimeout(r, 200));
    seen.videoMuted = s.result();
    // audio → muting would leave nothing, so it is not offered
    s = await openWith(aud, null);
    seen.audioRow = s.state;
    document.getElementById("trimFull").click();
    await new Promise(r => setTimeout(r, 200));
    seen.audioResult = s.result();
    // unchecked → nothing is written
    s = await openWith(vid, null);
    seen.freshCheckbox = document.getElementById("trimMute").checked;
    document.getElementById("trimFull").click();
    await new Promise(r => setTimeout(r, 200));
    seen.videoPlain = s.result();
    // the sketch category promises a stronger thing, and says so
    s = await openWith(vid, { sketch: true });
    seen.sketchSub = s.state.sub;
    document.getElementById("trimClose") ? null : null;
    document.getElementById("trimFull").click();
    await new Promise(r => setTimeout(r, 200));
    return seen;
  });
  check("the mute row is offered for a video", ui.videoRow.rowHidden === false);
  check("it is NOT offered for a voice clip", ui.audioRow.rowHidden === true);
  check("checking it writes «#mute» onto the stored URL",
    ui.videoMuted && ui.videoMuted.frag === "#mute", JSON.stringify(ui.videoMuted));
  check("the choice is reported to the uploader too",
    !!(ui.videoMuted && ui.videoMuted.choice && ui.videoMuted.choice.mute === true));
  // A checkbox that remembered the last clip would silently mute the next one.
  check("it resets between clips", ui.freshCheckbox === false);
  check("leaving it unchecked writes nothing",
    ui.videoPlain && ui.videoPlain.frag === null && ui.videoPlain.choice.mute === false,
    JSON.stringify(ui.videoPlain));
  check("an audio clip never reports a mute", ui.audioResult && ui.audioResult.choice.mute === false);
  // The two mechanisms differ, so the wording has to differ with them.
  check("the sketch category says the audio is DELETED, not silenced",
    /يُحذف/.test(ui.sketchSub) && !/يُشغَّل/.test(ui.sketchSub), ui.sketchSub);

  // ── watermark mask ────────────────────────────────────────────────────────
  /* Only offered on the sketch path: everywhere else the file is stored
     byte-for-byte as uploaded, so there is no pass in which a mask could be
     painted and offering one would be a lie. The boxes travel as FRACTIONS of
     the frame — the encode downscales to at most 1280 wide, and a box measured
     in preview pixels would land somewhere else entirely. */
  const mask = await page.evaluate(async () => {
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    const vid = new File([bytes], "clip.mp4", { type: "video/mp4" });
    const aud = new File([bytes], "voice.m4a", { type: "audio/mp4" });
    const out = {};
    const open = async (file, opts) => {
      let got = "unset";
      window.IZZBAH_TEST.openMediaTrim(file, (frag, choice) => { got = { frag, choice }; }, opts);
      await new Promise(r => setTimeout(r, 200));
      return () => got;
    };
    const row = () => document.getElementById("trimMaskRow");
    const layer = () => document.getElementById("trimMaskLayer");

    // Who is offered the control at all
    await open(vid, null);
    out.plainVideoRow = row().hidden;
    document.getElementById("trimFull").click(); await new Promise(r => setTimeout(r, 150));
    await open(aud, { sketch: true });
    out.audioRow = row().hidden;
    document.getElementById("trimFull").click(); await new Promise(r => setTimeout(r, 150));

    let res = await open(vid, { sketch: true });
    out.sketchRow = row().hidden;
    out.layerHiddenAtFirst = layer().hidden;          // must not block the controls
    document.getElementById("trimMaskAdd").click();
    out.layerShownInMode = !layer().hidden;

    // Drive the drag directly — the layer has no size in this harness (the
    // fake file never decodes), so a real mouse drag has nothing to hit.
    // fracOf() is what the pointer handlers compute, so this exercises the
    // same path from the fractions onward.
    window.IZZBAH_TEST.addTrimMask({ x: 0.02, y: 0.03, w: 0.22, h: 0.15 });
    out.afterOne = window.IZZBAH_TEST.trimMasks().length;
    out.boxesDrawn = layer().querySelectorAll(".tm-mask-box").length;
    out.clearShown = !document.getElementById("trimMaskClear").hidden;

    // A tap is not a box.
    window.IZZBAH_TEST.addTrimMask({ x: 0.5, y: 0.5, w: 0.002, h: 0.002 });
    out.tapIgnored = window.IZZBAH_TEST.trimMasks().length === 1;
    // …and there is a ceiling.
    for (let i = 0; i < 6; i++) window.IZZBAH_TEST.addTrimMask({ x: 0.1 * i, y: 0.4, w: 0.08, h: 0.08 });
    out.capped = window.IZZBAH_TEST.trimMasks().length;

    document.getElementById("trimMaskClear").click();
    out.afterClear = window.IZZBAH_TEST.trimMasks().length;

    window.IZZBAH_TEST.addTrimMask({ x: 0.02, y: 0.03, w: 0.22, h: 0.15 });
    document.getElementById("trimFull").click();
    await new Promise(r => setTimeout(r, 200));
    out.delivered = res();

    // A fresh clip must not inherit the last one's boxes.
    res = await open(vid, { sketch: true });
    out.freshMasks = window.IZZBAH_TEST.trimMasks().length;
    out.freshLayer = layer().hidden;
    document.getElementById("trimFull").click();
    await new Promise(r => setTimeout(r, 200));
    out.freshDelivered = res();
    return out;
  });

  check("the mask control is offered on the sketch path", mask.sketchRow === false);
  check("...and NOT for an ordinary video, which is stored as uploaded", mask.plainVideoRow === true);
  check("...nor for a voice clip", mask.audioRow === true);
  // The layer covers the video, so leaving it up would swallow every click on
  // the player's own controls.
  check("the drawing layer is down until asked for", mask.layerHiddenAtFirst === true);
  check("...and comes up on «غطِّ العلامة المائية»", mask.layerShownInMode === true);
  check("a drawn box is kept and rendered", mask.afterOne === 1 && mask.boxesDrawn === 1);
  check("«مسح التغطية» appears once there is something to clear", mask.clearShown === true);
  check("a stray tap is not stored as an invisible mask", mask.tapIgnored);
  check(`there is a ceiling on boxes (${mask.capped})`, mask.capped === 3);
  check("clearing removes them all", mask.afterClear === 0);
  check("the boxes reach the uploader as fractions of the frame",
    !!(mask.delivered && mask.delivered.choice && mask.delivered.choice.masks
       && mask.delivered.choice.masks.length === 1
       && mask.delivered.choice.masks[0].w > 0 && mask.delivered.choice.masks[0].w <= 1),
    JSON.stringify(mask.delivered && mask.delivered.choice && mask.delivered.choice.masks));
  // A mask carried over would silently blank a corner of the NEXT clip.
  check("a fresh clip starts with no boxes", mask.freshMasks === 0);
  check("...and its layer starts down again", mask.freshLayer === true);
  check("...and it reports none", mask.freshDelivered && mask.freshDelivered.choice.masks.length === 0);
  check("an ordinary video says it plays silent", /يُشغَّل/.test(ui.videoRow.sub), ui.videoRow.sub);

  // ── the sketch path really drops the track ──────────────────────────────
  const stripped = await page.evaluate(async () => {
    if (!window.IZZBAH.sketchSupported()) return { skip: true };
    const c = document.createElement("canvas"); c.width = 160; c.height = 120;
    const x = c.getContext("2d");
    const stream = c.captureStream(30);
    // give the source a REAL audio track, or "no audio out" proves nothing
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      const osc = ac.createOscillator(); const dst = ac.createMediaStreamDestination();
      osc.connect(dst); osc.start();
      dst.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    } catch (e) { return { skip: true }; }
    if (!stream.getAudioTracks().length) return { skip: true };
    const rec = new MediaRecorder(stream); const parts = [];
    rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
    rec.start();
    for (let i = 0; i < 20; i++) {
      x.fillStyle = "#2b7"; x.fillRect(0, 0, 160, 120);
      x.fillStyle = "#111"; x.fillRect(20 + i * 3, 30, 40, 60);
      await new Promise(r => setTimeout(r, 33));
    }
    rec.stop(); await new Promise(r => { rec.onstop = r; });
    const src = new File(parts, "src.webm", { type: "video/webm" });
    if (!src.size) return { skip: true };
    const tracksOf = async (blob) => {
      const url = URL.createObjectURL(blob);
      const v = document.createElement("video"); v.src = url; v.muted = true;
      await new Promise(r => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 4000); });
      if (v.audioTracks) { const n = v.audioTracks.length; URL.revokeObjectURL(url); return n; }
      /* No audioTracks in this engine. webkitAudioDecodedByteCount is the next
         honest signal — but it only becomes non-zero once frames have actually
         been decoded, so the clip has to PLAY first. Testing it truthily before
         playback reports 0 as "unsupported" and quietly measures nothing. */
      if (typeof v.webkitAudioDecodedByteCount === "number") {
        try { await v.play(); } catch (e) {}
        await new Promise(r => setTimeout(r, 700));
        const bytes = v.webkitAudioDecodedByteCount;
        try { v.pause(); } catch (e) {}
        URL.revokeObjectURL(url);
        return bytes > 0 ? 1 : 0;
      }
      URL.revokeObjectURL(url);
      return -1;
    };
    const loud = await window.IZZBAH.sketchifyVideo(src, () => {}, {});
    const quiet = await window.IZZBAH.sketchifyVideo(src, () => {}, { mute: true });
    return { skip: false, loudSize: loud.size, quietSize: quiet.size,
             loudTracks: await tracksOf(loud), quietTracks: await tracksOf(quiet) };
  });
  if (stripped.skip) {
    console.log("SKIP  sketch audio strip — this machine could not build a source clip with audio");
  } else if (stripped.quietTracks === -1) {
    // No reliable way to count tracks here; size is the only honest signal left.
    check("a muted sketch clip is no bigger than the one that kept its audio",
      stripped.quietSize <= stripped.loudSize, `${stripped.quietSize} vs ${stripped.loudSize}`);
  } else {
    check("the sketch filter keeps audio by default", stripped.loudTracks > 0, `${stripped.loudTracks} tracks`);
    check("mute strips the audio track from the encoded clip", stripped.quietTracks === 0,
      `${stripped.quietTracks} tracks`);
  }

  check("no uncaught JS error", jsErrors.length === 0, jsErrors.slice(0, 2).join(" | "));
  await page.close();
} catch (e) {
  check(`threw: ${e && e.message}`, false);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
