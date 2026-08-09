// The category editor's buttons must be RANKED and READABLE.
//
// Reported from a screenshot: every button on this screen was the same red, so
// «حذف» was indistinguishable from «نشر للمجتمع» and «تعديل». The cause is a
// shared rule near the top of the stylesheet that paints .primary, .secondary,
// .ghost and .danger identically — the class names existed but carried no
// visual difference. Cream on that red also measured 3.62:1, under AA.
//
// What this pins is the PROPERTY, not the palette: the four ranks must be
// visually distinct from each other, and every one must clear 4.5:1 against
// what is actually painted behind it — in both themes.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8410;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  " + extra : ""}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1200 }, deviceScaleFactor: 1 });
  await page.route("**/firebasejs/**", r => r.abort());
  page.on("pageerror", e => errs.push(e.message));
  await page.addInitScript(t => {
    try { localStorage.setItem("izzbah-legal-consent-v1", "1"); localStorage.setItem("izzbah-theme-v1", t); } catch (e) {}
  }, theme);
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1400);

  await page.evaluate(t => {
    document.documentElement.setAttribute("data-theme", t);
    state.isAdmin = true; if (window.IZZBAH.applyAdmin) window.IZZBAH.applyAdmin(true);
    state.editorTarget = "community";
    state.editingCategory = { id: "custom-x", name: "", image: "", color: "#7A3D88", description: "",
      visibility: "public", questions: [100, 200].map(points => ({ points, q: "", a: "", image: "", answerImage: "" })) };
    renderCustomEditor(); showScreen("customEditor");
  }, theme);
  await page.waitForTimeout(500);

  // Measure against the PAINTED pixel, not the computed style: several of these
  // faces are gradients, for which backgroundColor reads transparent and a
  // naive probe compares the text against the wrong layer entirely.
  const shot = await page.screenshot();
  const data = await page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise(r => { img.onload = r; img.src = "data:image/png;base64," + b64; });
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    cv.getContext("2d").drawImage(img, 0, 0);
    const ctx = cv.getContext("2d");
    const L = c => { const s = c.map(v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); });
      return .2126 * s[0] + .7152 * s[1] + .0722 * s[2]; };
    const ratio = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
    const pick = (x, y) => { const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data; return [d[0], d[1], d[2]]; };
    const out = {};
    const map = { primary: ".primary", secondary: ".secondary", ghost: ".ghost:not(.ce-del)", del: ".ce-del" };
    for (const [k, sel] of Object.entries(map)) {
      const el = document.querySelector("#customEditor " + sel);
      if (!el) { out[k] = null; continue; }
      const r = el.getBoundingClientRect();
      const face = pick(r.left + 6, r.top + r.height / 2);      // inside the edge, off the glyphs
      const cs = getComputedStyle(el);
      const fg = (cs.color.match(/-?[\d.]+/g) || []).slice(0, 3).map(Number);
      out[k] = { face, fg, ratio: +ratio(fg, face).toFixed(2) };
    }
    return out;
  }, shot.toString("base64"));

  const same = (a, b) => a && b && a.face.every((v, i) => Math.abs(v - b.face[i]) < 12);
  const ranks = ["primary", "secondary", "ghost", "del"];
  for (const k of ranks) {
    check(`${theme} · «${k}» text clears AA on its painted face`,
      data[k] && data[k].ratio >= 4.5, data[k] ? `${data[k].ratio}:1  face=${data[k].face}` : "MISSING");
  }
  // every rank distinguishable from every other
  let clashes = [];
  for (let i = 0; i < ranks.length; i++)
    for (let j = i + 1; j < ranks.length; j++)
      if (same(data[ranks[i]], data[ranks[j]])) clashes.push(ranks[i] + "=" + ranks[j]);
  check(`${theme} · the four ranks are visually distinct`, clashes.length === 0, clashes.join(" ") || "all differ");
  check(`${theme} · destructive «حذف» does not look like «نشر للمجتمع»`, !same(data.del, data.primary));
  await page.close();
}

check("no uncaught JS errors", errs.length === 0);
if (errs.length) console.log("  ", errs.slice(0, 3));
await browser.close(); server.kill();
process.exit(checks.every(Boolean) ? 0 : 1);
