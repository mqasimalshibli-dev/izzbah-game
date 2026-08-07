// Dark mode («المظهر») — a per-device light/dark toggle in settings.
//  • Default is light: no data-theme=dark, body ground is the cream gradient.
//  • Toggling stamps data-theme="dark" on <html>, persists to localStorage,
//    and re-skins the surfaces (body ground goes dark maroon).
//  • The choice survives a reload.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8359;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 460, height: 860 }, deviceScaleFactor: 1 });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1");
  localStorage.setItem("izzbah-coach-v1", JSON.stringify({ __all: 1 })); } catch (e) {} });

const bodyBgDark = () => page.evaluate(() => {
  const bi = getComputedStyle(document.body).backgroundImage;
  // dark ground carries the maroon stops (rgb ~ 44,7,9 / 22,7,9); light is cream (239..).
  return /rgb\(44, 7, 9\)|rgb\(22, 7, 9\)|rgb\(15, 5, 7\)/.test(bi);
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH && typeof window.IZZBAH.applyAuth === "function", { timeout: 15000 });
  await page.waitForTimeout(400);

  // ---- default = light ----
  const start = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute("data-theme"),
    theme: state.theme
  }));
  check("default theme is light (no dark attribute)", start.attr !== "dark" && start.theme !== "dark");
  check("light ground is not the dark maroon", !(await bodyBgDark()));

  // ---- toggle to dark ----
  await page.evaluate(() => { toggleTheme(); });
  const dark = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute("data-theme"),
    stored: localStorage.getItem("izzbah-theme-v1"),
    meta: (document.querySelector('meta[name="theme-color"]') || {}).getAttribute
      ? document.querySelector('meta[name="theme-color"]').getAttribute("content") : ""
  }));
  check("toggling stamps data-theme=dark on <html>", dark.attr === "dark");
  check("the dark choice is persisted to localStorage", dark.stored === "dark");
  check("the body ground turns dark maroon", await bodyBgDark());
  check("the browser theme-color follows dark", /#1a0608/i.test(dark.meta));

  // ---- settings row reflects the state ----
  const label = await page.evaluate(() => { openSettings(); renderSettingsSheet();
    return (document.getElementById("settingsThemeState") || {}).textContent || ""; });
  check("the settings «المظهر» row shows the dark state", /داكن/.test(label));

  // ---- persists across reload ----
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.IZZBAH && typeof state !== "undefined", { timeout: 15000 });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  check("dark mode survives a reload", after === "dark");
  check("body ground is still dark after reload", await bodyBgDark());

  // ---- toggle back to light ----
  await page.evaluate(() => { toggleTheme(); });
  const back = await page.evaluate(() => ({ attr: document.documentElement.getAttribute("data-theme"), stored: localStorage.getItem("izzbah-theme-v1") }));
  check("toggling back returns to light", back.attr === "light" && back.stored === "light");

  // ---- «ألعابك» has to switch themes too ----
  //
  // The saved-game card is styled by `#gameLibrary .saved-game-card { … }` with
  // !important and specificity (1,1,0). The theme rule
  // `:root[data-theme="dark"] .saved-game-card` is (0,3,0) with no !important,
  // so it could never win: the card stayed cream on the dark page. Meanwhile the
  // count pill's own dark override DOES carry !important, so its text turned
  // cream — cream on cream, measured at 1.17:1 and invisible. Fixing the pill
  // alone would have treated the symptom; the card is what failed to switch.
  //
  // Contrast is read off a screenshot, not computed: the card fill is a
  // gradient and the pills are translucent, which is where stacking by hand
  // goes wrong. Sample points avoid glyphs and the border — earlier attempts hit
  // the text itself (1.02:1) and then the border (4.07:1), both false alarms.
  {
    const lum = ([r, g, bl]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl); };
    const ratio = (a, c) => { const [x, y] = [lum(a), lum(c)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const parse = (str) => { const n = (str.match(/-?\d*\.?\d+/g) || []).map(Number);
      return /^color\(/.test(str) ? n.slice(-3).map(v => Math.round(v * 255)) : n.slice(0, 3); };

    for (const mode of ["dark", "light"]) {
      await page.evaluate((m) => {
        state.theme = m;
        document.documentElement.setAttribute("data-theme", m);
        const cats = activeCategories().slice(0, 4).map(c => c.id);
        state.savedGames = [{ id: "t1", title: "لعبة ١", categories: cats, charged: true,
          teams: [{ name: "أ", score: 0 }, { name: "ب", score: 0 }], teamCount: 2,
          activeTeam: 0, used: {}, frozen: {}, createdAt: 1700000000000 }];
        showScreen("gameLibrary");
        if (typeof renderSavedGames === "function") renderSavedGames();
      }, mode);
      await page.waitForTimeout(500);
      const targets = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll("#gameLibrary .saved-game-count").forEach(el => {
          const r = el.getBoundingClientRect();
          out.push({ label: el.className.includes("free") ? "free pill" : "count pill",
            color: getComputedStyle(el).color,
            at: { x: Math.round(r.left + 4), y: Math.round(r.top + r.height / 2) } });
        });
        const t = document.querySelector("#gameLibrary .saved-game-title");
        if (t) { const r = t.getBoundingClientRect();
          out.push({ label: "card title", color: getComputedStyle(t).color,
            at: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top - 8) } }); }
        return out;
      });
      if (!targets.length) { check(`${mode}: saved-game card rendered`, false); continue; }
      const shot = (await page.screenshot()).toString("base64");
      const bgs = await page.evaluate(async ([b64, pts]) => {
        const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
        const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
        const ctx = cv.getContext("2d"); ctx.drawImage(img, 0, 0);
        return pts.map(pt => { const d = ctx.getImageData(pt.x, pt.y, 1, 1).data; return [d[0], d[1], d[2]]; });
      }, [shot, targets.map(t => t.at)]);
      targets.forEach((t, k) => {
        const cr = ratio(parse(t.color), bgs[k]);
        check(`${mode}: the ${t.label} is readable (${cr.toFixed(2)}:1)`, cr >= 4.5);
      });
      // …and the card itself must actually change surface with the theme.
      const cardLum = lum(bgs[bgs.length - 1]);
      check(`${mode}: the card surface follows the theme (luminance ${cardLum.toFixed(2)})`,
        mode === "dark" ? cardLum < 0.2 : cardLum > 0.5);
    }
    await page.evaluate(() => { state.theme = "light"; document.documentElement.setAttribute("data-theme", "light"); });
  }

  check("no uncaught JS errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 4));
} catch (e) {
  check("harness completed", false);
  console.log("  harness error:", e.message, e.stack);
} finally {
  await browser.close();
  server.kill();
}
process.exit(checks.every(Boolean) ? 0 : 1);
