// The category counter ring (build .281) — the owner's replacement for the
// plain «N / 6 مختارة» text line on «اختر فئاتك».
//
// The number is now drawn twice: as a digit in the middle of the ring and as a
// filled arc around it. Those two can disagree silently, which is the whole
// reason this file exists:
//
//   * The arc is filled by shortening `stroke-dashoffset` against the
//     `stroke-dasharray` in the markup. The driver carries its own copy of the
//     circumference (CCR_CIRC). If the markup's radius or dasharray is ever
//     edited without the constant, the arc keeps animating smoothly and simply
//     fills to the wrong fraction — nothing throws, and the digit still reads
//     correctly. So the offsets are pinned here numerically, per count.
//   * At six the ring swaps the digit for a tick and turns green. Both the
//     digit fading and the tick appearing are opacity transitions, so a broken
//     one leaves the ring EMPTY rather than visibly wrong.
//   * Tapping a seventh category is refused, and the only feedback is this
//     component: the count stays at six and the hint changes. If the override
//     hint stops arriving there is no other signal that the tap did anything.
//   * Dark theme. The old line inherited `.hint`'s colour; the ring paints its
//     own text and stroke, so both themes are checked for readable contrast
//     against the sheet rather than assumed.
//
// Run:  IZZBAH_CHROMIUM=/path/to/chrome node tests/catring.mjs

import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8281;
const checks = [];
const check = (name, ok, extra) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

const CIRC = 150.8;
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
    showScreen("categories");
    await new Promise(r => setTimeout(r, 600));
  }, theme);
  return page;
};

// Reads the ring's rendered state. The offset is read from the inline style
// rather than the computed value so a mid-transition sample still reports the
// TARGET the driver asked for, not wherever the animation happens to be.
const READ = () => {
  const ring = document.getElementById("catRing");
  if (!ring) return null;
  const prog = ring.querySelector(".ccr-prog");
  const num = document.getElementById("catRingNum");
  const check = ring.querySelector(".ccr-check");
  const cs = getComputedStyle(prog);
  return {
    offset: parseFloat(prog.style.strokeDashoffset),
    dasharray: prog.getAttribute("stroke-dasharray"),
    r: parseFloat(prog.getAttribute("r")),
    num: num.textContent.trim(),
    numOpacity: +getComputedStyle(num).opacity,
    checkOpacity: +getComputedStyle(check).opacity,
    main: document.getElementById("catRingMain").textContent.trim(),
    hint: document.getElementById("catRingHint").textContent.trim(),
    done: ring.classList.contains("is-done"),
    over: ring.classList.contains("is-over"),
    stroke: cs.stroke,
    mainColor: getComputedStyle(document.getElementById("catRingMain")).color,
    hintColor: getComputedStyle(document.getElementById("catRingHint")).color,
    visible: ring.getBoundingClientRect().width > 0,
  };
};

// Drive the count the way the screen does — through the real render path, so a
// counter that only updates on some code paths is caught.
const SET = async (n) => {
  const ids = window.__ringIds.slice(0, n);
  state.selected = new Set(ids);
  renderCategories();
  await new Promise(r => setTimeout(r, 700));
};

const luminance = (rgb) => {
  const m = /rgba?\(([^)]+)\)/.exec(rgb || "");
  if (!m) return null;
  const [r, g, b] = m[1].split(",").map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

try {
  for (const theme of ["light", "dark"]) {
    const page = await open(theme);

    // Take real category ids off the rendered grid rather than hard-coding
    // them: the built-in catalogue can be renamed, and a test that silently
    // selects nothing would pass every count check at zero.
    const ids = await page.evaluate(() => {
      const list = visibleCategoryGroup()
        .filter(c => categoryHasQuestions(c))
        .map(c => c.id)
        .slice(0, 8);
      window.__ringIds = list;
      return list;
    });
    check(`${theme}: found real categories to select`, ids.length >= 7, `${ids.length}`);

    const at0 = await page.evaluate(READ);
    check(`${theme}: the ring is on the screen`, at0 && at0.visible);
    // If these two disagree the arc fills to the wrong fraction, silently.
    check(`${theme}: the markup's circumference matches the driver's constant`,
      at0 && Math.abs(2 * Math.PI * at0.r - CIRC) < 0.2 && Math.abs(parseFloat(at0.dasharray) - CIRC) < 0.2,
      at0 ? `r=${at0.r} dash=${at0.dasharray}` : "no ring");

    const seen = [];
    for (let n = 0; n <= 7; n++) {
      await page.evaluate(SET, n);
      seen.push(await page.evaluate(READ));
    }

    // 0 → empty arc, 6 → full, and each step exactly one sixth.
    const expected = n => CIRC - (Math.min(6, n) / 6) * CIRC;
    const offOk = seen.every((s, n) => Math.abs(s.offset - expected(n)) < 0.5);
    check(`${theme}: the arc fills one sixth per category`, offOk,
      seen.map(s => s.offset.toFixed(1)).join(" "));
    check(`${theme}: empty at zero, full at six`,
      Math.abs(seen[0].offset - CIRC) < 0.5 && Math.abs(seen[6].offset) < 0.5);
    // A seventh tap is refused, so the arc must not overfill past the ring.
    check(`${theme}: a seventh does not overfill the arc`, Math.abs(seen[7].offset) < 0.5);

    const digitsOk = seen.every((s, n) => s.num === String(n) && s.main.startsWith(String(n)));
    check(`${theme}: the digit and the line agree with the count`, digitsOk,
      seen.map(s => s.num).join(" "));
    check(`${theme}: the line names the six-category limit`,
      seen.every(s => s.main.includes("من 6 مختارة")), seen[3].main);

    check(`${theme}: hint at zero asks for one`, seen[0].hint === "اختر فئة واحدة على الأقل", seen[0].hint);
    check(`${theme}: hint mid-way invites more`, seen[3].hint === "تقدر تضيف أكثر", seen[3].hint);
    check(`${theme}: hint at six says it is full`, seen[6].hint === "اكتمل الحد الأقصى", seen[6].hint);

    check(`${theme}: is-done only at six`, seen.every((s, n) => s.done === (n === 6)),
      seen.map(s => +s.done).join(""));
    // SET writes state.selected directly, so it can reach seven where a real
    // tap cannot. That is the point: is-over is the safety net for a count that
    // arrives from somewhere other than the picker (a shared «#g=» link, a
    // restored game), and it must paint differently from a legitimate six.
    check(`${theme}: is-over is the overflow net, and only past six`,
      seen.every((s, n) => s.over === (n > 6)), seen.map(s => +s.over).join(""));
    check(`${theme}: an overflowing count does not look like a completed one`,
      seen[7].stroke !== seen[6].stroke, `${seen[6].stroke} vs ${seen[7].stroke}`);

    // The swap is two opacity transitions; a broken one leaves the ring blank.
    check(`${theme}: the digit shows below six`, seen[3].numOpacity > 0.9 && seen[3].checkOpacity < 0.1,
      `num=${seen[3].numOpacity} tick=${seen[3].checkOpacity}`);
    check(`${theme}: at six the tick replaces the digit`,
      seen[6].numOpacity < 0.1 && seen[6].checkOpacity > 0.9,
      `num=${seen[6].numOpacity} tick=${seen[6].checkOpacity}`);
    check(`${theme}: the ring goes green when it is full`,
      seen[6].stroke !== seen[3].stroke && /rgb\(31, ?157, ?87\)/.test(seen[6].stroke),
      `${seen[3].stroke} → ${seen[6].stroke}`);

    // Refusing a seventh tap is fed back ONLY through this component.
    await page.evaluate(SET, 6);
    const refused = await page.evaluate(async () => {
      const seventh = window.__ringIds[6];
      const card = document.querySelector(`.category[data-cat-id="${seventh}"]`);
      if (card) card.click();
      else setCategoryRing(state.selected.size, `الحد الأقصى ${toArabicDigits(6)} فئات`);
      await new Promise(r => setTimeout(r, 400));
      return {
        hint: document.getElementById("catRingHint").textContent.trim(),
        count: state.selected.size,
        clicked: !!card,
      };
    });
    check(`${theme}: a seventh tap is refused and says so`,
      refused.count === 6 && refused.hint.includes("الحد الأقصى"),
      `${refused.count} sel, "${refused.hint}"${refused.clicked ? "" : " (driver)"}`);

    // The ring paints its own colours, so neither theme may inherit an
    // unreadable one. Sheet luminance differs wildly between the two.
    // Every ancestor of the ring is transparent and the page colour comes from a
    // radial-gradient on `body`, so `backgroundColor` reports rgba(0,0,0,0) — it
    // scores as pure black and would let LIGHT theme pass on a colour the text is
    // actually invisible against. Average the gradient's stops instead.
    const bg = await page.evaluate(() => {
      const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const opaque = c => c && c !== "transparent" && !/rgba\([^)]*,\s*0\s*\)/.test(c);
      for (let el = document.getElementById("catRingMain"); el; el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (opaque(cs.backgroundColor)) {
          const [r, g, b] = /\(([^)]+)\)/.exec(cs.backgroundColor)[1].split(",").map(Number);
          return lum(r, g, b);
        }
        const stops = [...cs.backgroundImage.matchAll(/rgba?\(([^)]+)\)/g)]
          .map(m => m[1].split(",").map(Number))
          .filter(p => p.length < 4 || p[3] > 0.15);
        if (stops.length) return stops.reduce((a, p) => a + lum(p[0], p[1], p[2]), 0) / stops.length;
      }
      return null;
    });
    const mainL = luminance(seen[3].mainColor), hintL = luminance(seen[3].hintColor);
    check(`${theme}: the counter text contrasts with the page`,
      mainL !== null && bg !== null && Math.abs(mainL - bg) > 40 && Math.abs(hintL - bg) > 30,
      `bg=${Math.round(bg)} main=${Math.round(mainL)} hint=${Math.round(hintL)}`);

    // The old text line was one row; the ring is a two-line block beside a
    // 52px circle. It must not push the picker off a phone.
    const height = await page.evaluate(() =>
      Math.round(document.getElementById("catRing").getBoundingClientRect().height));
    check(`${theme}: the ring stays compact`, height > 40 && height <= 72, `${height}px`);

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
