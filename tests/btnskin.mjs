// One button skin, everywhere.
//
// The app used to carry TWO button designs at once. The shared base rule
// painted every .primary/.secondary/.ghost/.danger/.gold-btn as a chunky
// arcade button — 8px radius, a 3px border, cream text and a hard `0 6px 0`
// bottom edge — while the newer screens each re-styled their own buttons to a
// softer face with `!important` (#createSavedGame, the answer-page pair, the
// category tabs…). Nothing in the suite compared one screen's buttons to
// another's, so the two languages drifted apart unnoticed until the owner
// pointed at «رجوع» and asked why it did not look like «إنشاء لعبة».
//
// This pins the shared skin against that reference button:
//
//   1. every button carries the same face — 14px radius, the red gradient,
//      white text, a Cairo 800 label at the shared size,
//   2. the hard `0 Npx 0` bottom edge is gone app-wide (it is the single
//      clearest marker of the old design, and easy to reintroduce),
//   3. the community editor keeps its own MEASURED contrast palette — the
//      point was never to make everything red — but shares the shape,
//   4. buttons stay finger-sized.
//
// Run:  IZZBAH_CHROMIUM=/path/to/chrome node tests/btnskin.mjs

import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8241;
const checks = [];
const check = (name, ok, extra) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM || undefined });
const page = await browser.newPage({ viewport: { width: 1100, height: 950 } });
await page.route("**/firebasejs/**", r => r.abort());
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
const jsErrors = [];
page.on("pageerror", e => jsErrors.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(2200);
  await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "u");
    window.IZZBAH.applyAdmin(true);
  });
  await page.waitForTimeout(700);

  // Walk the screens so every button below is laid out at least once.
  const skin = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const seen = {};
    const read = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        sel,
        text: el.textContent.trim().slice(0, 18),
        radius: parseFloat(cs.borderTopLeftRadius),
        font: cs.fontFamily,
        weight: cs.fontWeight,
        size: parseFloat(cs.fontSize),
        bg: cs.backgroundImage !== "none" ? cs.backgroundImage : cs.backgroundColor,
        color: cs.color,
        shadow: cs.boxShadow,
        height: Math.round(el.getBoundingClientRect().height),
        borderW: parseFloat(cs.borderTopWidth),
        disabled: !!el.disabled,
      };
    };
    const visit = async (fn, sels) => {
      fn(); await wait(700);
      for (const s of sels) { const r = read(s); if (r) seen[s] = r; }
    };
    await visit(() => showScreen("gameLibrary"), ["#createSavedGame"]);
    await visit(() => showScreen("categories"), ["#goTeams", "#randomPick"]);
    await visit(() => { state.selected = new Set(["history"]); showScreen("setup"); },
      ["#setupBack", "#startGame"]);
    await visit(() => showScreen("customEditor"), ["#customBack"]);
    await visit(() => showScreen("adminPanel"), ["#adminClose"]);
    return seen;
  });

  const got = Object.values(skin).filter(Boolean);
  check("found buttons across the screens", got.length >= 4,
    got.map(g => g.sel).join(" "));

  const ref = skin["#createSavedGame"];
  check("the reference button «إنشاء لعبة» is present", !!ref);
  if (!ref) throw new Error("no #createSavedGame — cannot compare against the reference");

  // (1) same face as the reference
  const gradient = /linear-gradient/.test(ref.bg) ? ref.bg : null;
  const reds = got.filter(g => /linear-gradient\(.*204, 37, 49.*\)/.test(g.bg));
  check("the red buttons all use the reference gradient",
    reds.length >= 3, `${reds.length} of ${got.length} on ${gradient ? "the gradient" : "?"}`);

  const offRadius = got.filter(g => Math.abs(g.radius - ref.radius) > 0.6);
  check("every button shares the reference corner radius",
    offRadius.length === 0,
    offRadius.length ? offRadius.map(g => `${g.sel}=${g.radius}`).join(" ") : `${ref.radius}px`);

  const offFont = got.filter(g => !/Cairo/.test(g.font) || g.weight !== "800");
  check("every button is Cairo 800", offFont.length === 0,
    offFont.map(g => `${g.sel}:${g.font}/${g.weight}`).join(" "));

  // The old base was clamp(21px, 2.3vw, 28px) — far bigger than the 18px
  // reference, which is most of why the two designs looked unrelated.
  const offSize = got.filter(g => g.size > ref.size + 4 || g.size < ref.size - 4);
  check("no button is wildly off the reference size",
    offSize.length === 0,
    offSize.length ? offSize.map(g => `${g.sel}=${g.size}`).join(" ") : `ref ${ref.size}px`);

  // (2) The hard bottom edge is the fingerprint of the old skin: an OUTER
  // shadow offset down with zero blur. The `inset` hairline highlight on the
  // new face has that same `0px 1px 0px` shape, so inset layers must be
  // dropped first — the naive probe flags the reference button itself.
  const outerLayers = sh => sh.split(/,(?![^()]*\))/).filter(l => !/\binset\b/.test(l));
  const isHardEdge = sh => outerLayers(sh).some(l => /\b0px\s+\d+px\s+0px\b/.test(l));
  const hardEdge = got.filter(g => isHardEdge(g.shadow));
  check("no button still has the hard 3D bottom edge",
    hardEdge.length === 0,
    hardEdge.length ? hardEdge.map(g => g.sel).join(" ") : "all soft");

  // `button:disabled` deliberately clears the shadow, so #goTeams (disabled
  // until a category is picked) is expected to have none.
  const noShadow = got.filter(g => g.shadow === "none" && !g.disabled);
  check("every enabled button keeps a drop shadow", noShadow.length === 0,
    noShadow.map(g => g.sel).join(" "));

  // (4) finger-sized
  const small = got.filter(g => g.height > 0 && g.height < 40);
  check("buttons stay finger-sized", small.length === 0,
    small.length ? small.map(g => `${g.sel}=${g.height}`).join(" ") : "all >= 40px");

  // (3) the community editor is allowed — required — to keep its own palette,
  // but must share the shape. Its colours are covered by tests/editorcolors.mjs.
  const ce = await page.evaluate(async () => {
    // the editor panel is built by renderCustomEditor(); just showing the
    // screen leaves it empty, which is how the first version of this test
    // measured nothing and passed anyway
    state.isAdmin = true;
    state.editorTarget = "community";
    state.editingCategory = { id: "custom-x", name: "", image: "", color: "#7A3D88",
      description: "", visibility: "public",
      questions: [100, 200].map(points => ({ points, q: "", a: "", image: "", answerImage: "" })) };
    renderCustomEditor(); showScreen("customEditor");
    await new Promise(r => setTimeout(r, 700));
    const out = {};
    // «حذف» is class="ghost ce-del", so a bare `.ghost` selector matches the
    // delete button and the two rows measure identical.
    for (const [cls, sel] of [["secondary", ".secondary"],
                              ["ghost", ".ghost:not(.ce-del)"],
                              ["ce-del", ".ce-del"]]) {
      const el = document.querySelector(`#customEditor ${sel}`);
      if (!el) continue;
      const cs = getComputedStyle(el);
      out[cls] = { radius: parseFloat(cs.borderTopLeftRadius), shadow: cs.boxShadow, bg: cs.backgroundColor };
    }
    return out;
  });
  const ceRows = Object.entries(ce);
  // guard the vacuous case explicitly: every() on [] is true
  check("the community editor buttons exist", ceRows.length === 3,
    ceRows.length ? ceRows.map(r => r[0]).join(" ") : "NONE — the checks below would pass vacuously");
  check("the editor shares the corner radius",
    ceRows.length > 0 && ceRows.every(([, v]) => Math.abs(v.radius - ref.radius) <= 0.6),
    ceRows.map(([k, v]) => `${k}=${v.radius}`).join(" "));
  check("the editor has no hard edge either",
    ceRows.length > 0 && ceRows.every(([, v]) => !isHardEdge(v.shadow)),
    ceRows.map(([k, v]) => `${k}:${isHardEdge(v.shadow) ? "HARD" : "soft"}`).join(" "));
  check("the editor still has its OWN palette, not the red gradient",
    ceRows.length > 0 && new Set(ceRows.map(([, v]) => v.bg)).size === ceRows.length,
    ceRows.map(([k, v]) => `${k}:${v.bg}`).join(" "));

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
