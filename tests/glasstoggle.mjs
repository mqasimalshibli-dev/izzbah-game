// The glass toggle — the switch the owner asked for (build .278), applied to
// the two real on/off rows in settings: المظهر and الصوت.
//
// It replaced a plain settings row that carried its value as text on the end.
// What makes it a toggle rather than a styled row is that the knob MOVES, the
// word CHANGES, and the icon changes with it — so those are the things pinned
// here, per state, in both themes.
//
// The traps this guards, all of which were live while building it:
//   * RTL. `inset-inline-start` is the RIGHT edge here, so the knob has to
//     travel in -x to reach the far end. Get the sign wrong and the knob sits
//     still, or leaves the pill — and the aria state still reads correctly, so
//     nothing else would catch it.
//   * A `:active` rule that re-declares `transform` cancels the knob's travel.
//     The press effect has to use the separate `scale` property.
//   * The dark sheet needs its OWN unpressed styling. Without it a sound-is-on
//     switch kept the cream glass and sat as a pale slab beside a theme switch
//     that had gone dark — two of the same control looking like two components.
//   * The pill must not resize as the word swaps: «مفعّل» and «مكتوم» are
//     different widths, and a switch that reflows mid-slide looks broken.
//
// Run:  IZZBAH_CHROMIUM=/path/to/chrome node tests/glasstoggle.mjs

import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8265;
const checks = [];
const check = (name, ok, extra) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM || undefined });
const jsErrors = [];

const open = async (theme) => {
  const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
  await page.route("**/firebasejs/**", r => r.abort());
  await page.addInitScript(t => {
    try {
      localStorage.setItem("izzbah-legal-consent-v1", "1");
      localStorage.setItem("izzbah-theme-v1", t);
    } catch (e) {}
  }, theme);
  page.on("pageerror", e => jsErrors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(2200);
  await page.evaluate(async (t) => {
    document.documentElement.setAttribute("data-theme", t);
    window.IZZBAH.applyAuth(true, "u");
    openSettings();
    await new Promise(r => setTimeout(r, 600));
  }, theme);
  return page;
};

// knobOffset is measured from the pill's INLINE-START edge, so it is
// direction-agnostic: it grows when the knob travels, whichever way that is.
const READ = `(id) => {
  const el = document.getElementById(id);
  if (!el) return null;
  const knob = el.querySelector(".izz-knob");
  const word = el.querySelector(".izz-word");
  const er = el.getBoundingClientRect(), kr = knob.getBoundingClientRect();
  const rtl = getComputedStyle(el).direction === "rtl";
  const cs = getComputedStyle(el);
  return {
    pressed: el.getAttribute("aria-pressed") === "true",
    role: el.getAttribute("role"),
    label: el.getAttribute("aria-label") || "",
    word: word.textContent.trim(),
    hasSvg: !!knob.querySelector("svg"),
    // the knobs draw SVGs now, so identify the icon by its geometry rather
    // than by text — comparing textContent silently compared "" with ""
    emoji: knob.querySelector("svg")
      ? [...knob.querySelectorAll("svg *")].map(e => e.getAttribute("d") || e.tagName).join("|").slice(0, 60)
      : knob.textContent.trim(),
    knobOffset: Math.round(rtl ? er.right - kr.right : kr.left - er.left),
    pillW: Math.round(er.width), pillH: Math.round(er.height),
    knobW: Math.round(kr.width),
    track: cs.backgroundImage,
    inside: kr.left >= er.left - 1 && kr.right <= er.right + 1,
  };
}`;

try {
  for (const theme of ["light", "dark"]) {
    const page = await open(theme);
    const read = (id) => page.evaluate(`(${READ})(${JSON.stringify(id)})`);
    const click = async (id) => {
      await page.evaluate(i => document.getElementById(i).click(), id);
      await page.waitForTimeout(520);
    };

    const t0 = await read("settingsTheme");
    const s0 = await read("settingsSound");
    check(`${theme}: both rows are switches`,
      t0 && s0 && t0.role === "switch" && s0.role === "switch");
    check(`${theme}: each switch is labelled for a screen reader`,
      t0.label.length > 0 && s0.label.length > 0, `${t0.label} / ${s0.label}`);
    check(`${theme}: the theme switch reflects the actual theme (${t0.word})`,
      t0.pressed === (theme === "dark"));
    check(`${theme}: the knob starts inside the pill`, t0.inside && s0.inside);

    // ---- the knob actually travels, and the word and icon change with it ----
    await click("settingsTheme");
    const t1 = await read("settingsTheme");
    check(`${theme}: tapping flips the state (${t0.word} → ${t1.word})`,
      t1.pressed !== t0.pressed);
    check(`${theme}: ...the word changes with it`, t1.word !== t0.word && t1.word.length > 0);
    check(`${theme}: ...the knob MOVES (${t0.knobOffset}px → ${t1.knobOffset}px)`,
      Math.abs(t1.knobOffset - t0.knobOffset) > t0.knobW / 2);
    check(`${theme}: ...and stays inside the pill`, t1.inside);
    check(`${theme}: ...the knob icon changes too (sun ⇄ moon)`,
      t0.emoji !== t1.emoji && t1.emoji.length > 0,
      `${t0.emoji.slice(0, 22)}… → ${t1.emoji.slice(0, 22)}…`);
    check(`${theme}: ...and the real theme followed`,
      await page.evaluate(() => document.documentElement.getAttribute("data-theme")) !== theme);
    check(`${theme}: the pill does not resize as the word swaps`,
      t1.pillW === t0.pillW && t1.pillH === t0.pillH,
      `${t0.pillW}x${t0.pillH} → ${t1.pillW}x${t1.pillH}`);

    // ---- sound uses a real speaker glyph, not an emoji ----
    check(`${theme}: the sound knob draws a speaker glyph, not an emoji`, s0.hasSvg);
    await click("settingsSound");
    const s1 = await read("settingsSound");
    check(`${theme}: sound flips (${s0.word} → ${s1.word})`,
      s1.pressed !== s0.pressed && s1.word !== s0.word);
    check(`${theme}: ...its knob travels too`,
      Math.abs(s1.knobOffset - s0.knobOffset) > s0.knobW / 2);
    check(`${theme}: ...and it still draws a glyph when muted`, s1.hasSvg);
    await click("settingsSound");
    const s2 = await read("settingsSound");
    check(`${theme}: sound flips back (${s1.word} → ${s2.word})`, s2.word === s0.word);

    await page.close();
  }

  // ---- the dark sheet must not leave an unpressed switch in cream glass ----
  {
    const light = await open("light");
    const dark = await open("dark");
    const grab = (p) => p.evaluate(`(${READ})("settingsSound")`);
    const l = await grab(light), d = await grab(dark);
    check("an OFF switch is styled for its own theme, not left cream on dark",
      l.track !== d.track, "light and dark tracks differ");
    // and the two STATES still separate within the dark sheet
    await dark.evaluate(() => document.getElementById("settingsSound").click());
    await dark.waitForTimeout(520);
    const d2 = await grab(dark);
    check("dark: the two states are still visually distinct", d.track !== d2.track);
    await light.close(); await dark.close();
  }

  // ---- the settings sheet carries LINE icons, not emoji ----
  // Reported after build .279: the tiles had been restyled but still held
  // 🌙 🔊 🔗 📲 📢 💬 🚩 📖 ✉️ 📄 ℹ️ 🗑️, which render at a different size,
  // weight and colour on every platform and cannot be tinted at all — so a
  // row's icon never matched the row's meaning or the sheet's palette.
  for (const theme of ["light", "dark"]) {
    const page = await open(theme);
    const r = await page.evaluate(() => {
      const sheet = document.getElementById("settingsModal");
      const tiles = [...sheet.querySelectorAll(".settings-ico")];
      const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;
      const stray = [];
      sheet.querySelectorAll("*").forEach(n => {
        [...n.childNodes].filter(c => c.nodeType === 3).forEach(c => {
          const m = (c.textContent || "").match(EMOJI);
          // ✕ is a typographic close mark, monochrome and inheriting colour
          if (m && m.some(ch => ch !== "\u2715")) stray.push(m.join(""));
        });
      });
      return {
        tiles: tiles.length,
        withSvg: tiles.filter(t => t.querySelector("svg")).length,
        knobsWithSvg: [...sheet.querySelectorAll(".izz-knob")].filter(k => k.querySelector("svg")).length,
        tints: new Set(tiles.map(t => getComputedStyle(t).color)).size,
        strayEmoji: [...new Set(stray)],
      };
    });
    check(`${theme}: every settings tile draws a line icon`,
      r.tiles > 10 && r.withSvg === r.tiles, `${r.withSvg}/${r.tiles}`);
    check(`${theme}: both toggle knobs draw one too`, r.knobsWithSvg === 2, `${r.knobsWithSvg}/2`);
    check(`${theme}: no coloured emoji left anywhere in the sheet`,
      r.strayEmoji.length === 0, r.strayEmoji.join(" ") || "clean");
    // the tint is the point — a single flat colour would be no better than emoji
    check(`${theme}: the icons are tinted by meaning, not one flat colour`,
      r.tints >= 4, `${r.tints} distinct`);
    await page.close();
  }

  check("no uncaught JS error", jsErrors.length === 0, jsErrors.slice(0, 2).join(" | "));
} catch (e) {
  check(`threw: ${e && e.message}`, false);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
