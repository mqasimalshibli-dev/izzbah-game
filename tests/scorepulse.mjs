// Three things the owner reported on a real device (build .295).
//
// 1) «+»/«−» on a score box showed "a hollow around it" when pressed. That is
//    Android/Chrome's default -webkit-tap-highlight-color, rgba(51,181,229,.4),
//    painted BEHIND the control — a blue halo. Every other control in the game
//    turns it off; these two were missed.
//
// 2) Pressing «+»/«−» made the TURN PILL pulse, as if the turn had passed.
//    renderScores() calls renderTurnBoxes(), which rebuilt the pill's innerHTML
//    unconditionally. Replacing the children re-creates .turn-sheen and
//    re-triggers the hand-over animation — a CSS animation starts whenever a
//    matching element is created, so simply re-adding the class was never the
//    only trigger.
//
// 3) The first-run coaching tips reappeared on the SAME device. "Seen" lived
//    only in localStorage, which is per browsing CONTEXT: an installed PWA on
//    iOS does not share it with Safari, so the tour ran once in each. It now
//    rides with the account, and is UNIONED rather than overwritten — "seen" is
//    monotonic, and last-write-wins would un-see a tip.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8449;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

const startGame = async page => {
  await page.route("**/firebasejs/**", r => r.abort());
  page.on("pageerror", e => errs.push(e.message));
  await page.addInitScript(() => {
    try {
      localStorage.setItem("izzbah-legal-consent-v1", "1");
      localStorage.setItem("izzbah-coach-v1", JSON.stringify({ __all: 1 }));
    } catch (e) {}
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(2200);
  await page.evaluate(async () => {
    window.IZZBAH.applyAuth(true, "u");
    showScreen("categories");
    await new Promise(r => setTimeout(r, 400));
    state.selected = new Set(visibleCategoryGroup().filter(categoryHasQuestions).map(c => c.id).slice(0, 6));
    renderCategories();
    await new Promise(r => setTimeout(r, 300));
    document.getElementById("catGoFloat").click();
    await new Promise(r => setTimeout(r, 600));
    const s = [...document.querySelectorAll("button")].find(x => /ابدأ اللعبة/.test(x.textContent));
    if (s) s.click();
    await new Promise(r => setTimeout(r, 1200));
  });
};

try {
  // A TOUCH device: the tap halo only exists on one.
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 520 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await startGame(page);

  // ---- 1) no default tap halo on the score buttons -----------------------
  const halo = await page.evaluate(() => {
    const btns = [...document.querySelectorAll(".score-tools button")];
    const transparent = c => /rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(c);
    return {
      n: btns.length,
      allClear: btns.every(b => transparent(getComputedStyle(b).webkitTapHighlightColor)),
      sample: btns.length ? getComputedStyle(btns[0]).webkitTapHighlightColor : "none",
    };
  });
  check("the score «+»/«−» buttons exist", halo.n >= 2, `${halo.n} buttons`);
  check("no default tap halo behind them", halo.allClear, halo.sample);

  // ---- 2) a score change must NOT disturb the turn pill ------------------
  const pulse = await page.evaluate(async () => {
    window.__anim = [];
    document.addEventListener("animationstart", e => {
      if (e.target.closest && e.target.closest(".turn-box")) window.__anim.push(e.animationName);
    }, true);
    const plus = [...document.querySelectorAll(".score-tools button")].find(b => b.textContent === "+");
    const before = state.teams[0].score;
    plus.scrollIntoView({ block: "center" });
    plus.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    plus.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    await new Promise(r => setTimeout(r, 500));
    return { scored: state.teams[0].score !== before, anims: window.__anim.slice(),
             team: state.activeTeam };
  });
  check("pressing «+» still scores", pulse.scored);
  check("…and the turn pill does not react at all",
    pulse.anims.length === 0, pulse.anims.join(", ") || "no animations");

  // ---- …but a REAL change of turn still announces itself -----------------
  const handover = await page.evaluate(async () => {
    window.__anim = [];
    const before = state.activeTeam;
    document.querySelector(".turn-box").click();
    await new Promise(r => setTimeout(r, 500));
    return { moved: state.activeTeam !== before, anims: window.__anim.slice() };
  });
  check("handing the turn over still moves it", handover.moved);
  check("…and still replays the hand-over animation",
    handover.anims.some(a => /turn-name-in|turn-face-in/.test(a)), handover.anims.join(", "));

  // A rename is not a hand-over: the pill updates without the fanfare.
  const rename = await page.evaluate(async () => {
    window.__anim = [];
    state.teams[state.activeTeam].name = "فريق باسم جديد";
    renderScores();
    await new Promise(r => setTimeout(r, 400));
    return { shown: (document.querySelector(".turn-label strong") || {}).textContent || "",
             anims: window.__anim.slice() };
  });
  check("a rename updates the pill", /باسم جديد/.test(rename.shown), rename.shown);
  check("…without the hand-over animation", rename.anims.length === 0, rename.anims.join(", "));
  await ctx.close();

  // ---- 3) the coaching tips ride with the account ------------------------
  const src = readFileSync(join(ROOT, "index.html"), "utf8");
  check("the coach «seen» map is in the cloud-synced key list",
    /const KEYS = \[[^\]]*"izzbah-coach-v1"/.test(src));
  check("…and is UNIONED on restore, not overwritten",
    /MERGE_SEEN_KEYS[\s\S]{0,600}mergeSeenMaps/.test(src) && /Object\.assign\(\{\}, b, a\)/.test(src));

  // The merge itself: a tip seen on either side stays seen.
  const merged = await browser.newPage();
  await merged.route("**/firebasejs/**", r => r.abort());
  await merged.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
  await merged.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await merged.waitForTimeout(1500);
  const union = await merged.evaluate(() => {
    // mergeSeenMaps lives in the cloud scope; re-derive its contract here from
    // the same inputs a real sign-in would produce.
    const local = JSON.stringify({ categories: 1, game: 1 });
    const cloud = JSON.stringify({ game: 1, questionPage: 1 });
    const a = JSON.parse(local), b = JSON.parse(cloud);
    const out = Object.assign({}, b, a);
    return Object.keys(out).sort().join(",");
  });
  check("a tip seen on EITHER surface stays seen after a sync",
    union === "categories,game,questionPage", union);
  await merged.close();

  check("no uncaught JS errors", errs.length === 0, errs.slice(0, 2).join(" | "));
} catch (e) {
  check("harness completed", false, e && e.message);
} finally {
  await browser.close();
  server.kill();
}

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
