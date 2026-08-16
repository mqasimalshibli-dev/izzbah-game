// The admin centre's structure.
//
// It grew to twelve flat buttons, several of which are plainly facets of
// another: «تصنيف الفئات» and «الألعاب المقترحة» are both content, «المتكررات»
// and «فحص الخيارات» are both catalogue scans, «التعليمات الإرشادية» is a slice
// of «تحرير النصوص». They are grouped now.
//
// The thing this test exists to protect is the wiring. Every entry keeps its id
// and its click handler; only its position in the DOM changed. A reorganisation
// that quietly drops an entry, or moves one out of reach of its listener, would
// look completely fine on screen — the button is still there, it just stops
// doing anything.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8501;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

// id -> the modal it must open. This is the wiring, stated independently of the
// code, so a broken listener fails here rather than in the owner's hands.
const ENTRIES = [
  ["adminChoiceContent", null],            // switches screen rather than opening a modal
  ["adminChoiceFilters", "catFilterAdminModal"],
  ["adminChoiceFeatured", "featuredAdminModal"],
  ["adminChoiceDupes", "dupModal"],
  ["adminChoiceDist", "distModal"],
  ["adminChoiceLog", "auditModal"],
  ["adminChoiceHealth", "healthModal"],
  ["adminChoiceStats", "statsModal"],
  ["adminChoiceQHealth", "qHealthModal"],
  ["adminChoiceSubs", "premiumModal"],
  ["adminChoiceFeedback", "feedbackAdminModal"],
  ["adminChoiceAnnounce", "announceAdminModal"],
  ["adminChoiceText", null],
  ["adminChoiceCoach", "coachAdminModal"],
  ["adminChoiceEditors", "editorsAdminModal"],
];

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
await page.route("**/firebasejs/**", r => r.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1400);
  await page.evaluate(() => { window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true); });

  const shape = await page.evaluate(() => {
    const groups = [...document.querySelectorAll(".admin-group")].map(g => ({
      id: g.dataset.group,
      name: (g.querySelector(".admin-group-name") || {}).textContent || "",
      items: [...g.querySelectorAll(".admin-choice-btn")].map(b => b.id),
      open: g.dataset.open,
    }));
    const loose = [...document.querySelectorAll(".admin-choice-btn")]
      .filter(b => !b.closest(".admin-group")).map(b => b.id);
    return { groups, loose, total: document.querySelectorAll(".admin-choice-btn").length };
  });

  check(`the panel is organised into groups (${shape.groups.length})`, shape.groups.length === 6);
  check(`every entry lives in one (${shape.loose.length} loose)`, shape.loose.length === 0);
  check(`no entry was lost in the move (${shape.total} of ${ENTRIES.length})`,
    shape.total === ENTRIES.length);
  const flat = shape.groups.flatMap(g => g.items);
  check("…and none is duplicated", new Set(flat).size === flat.length);
  const missing = ENTRIES.map(([id]) => id).filter(id => !flat.includes(id));
  check(`every known entry is present (${missing.join(", ") || "none missing"})`, missing.length === 0);
  check("groups start expanded, so nothing is hidden from someone used to the flat list",
    shape.groups.every(g => g.open === "1"));
  /* Every group earns its heading by holding more than one entry — EXCEPT
     «الصلاحيات», which is deliberately a group of one. It is there so that
     appointing staff reads as its own concern rather than as a stray button
     under «المحتوى», and so applyAdminGroups can hide the whole thing
     from a content editor in one move. */
  const SOLO_GROUPS = ["access"];
  shape.groups.forEach(g => {
    const min = SOLO_GROUPS.includes(g.id) ? 1 : 2;
    check(`«${g.name}» holds ${g.items.length} entries`, g.items.length >= min);
  });

  // ---- the wiring still works from inside a group ----
  for (const [id, modal] of ENTRIES) {
    if (!modal) continue;
    const opened = await page.evaluate(async ([id, modal]) => {
      document.querySelectorAll(".modal-backdrop.open").forEach(m => m.classList.remove("open"));
      openAdminChoice();
      await new Promise(r => setTimeout(r, 120));
      const btn = document.getElementById(id);
      if (!btn) return { missing: true };
      btn.click();
      await new Promise(r => setTimeout(r, 260));
      const m = document.getElementById(modal);
      return { open: !!m && m.classList.contains("open") };
    }, [id, modal]);
    check(`${id} still opens its panel`, opened.open === true);
  }

  // ---- collapsing hides the children and is remembered ----
  const collapse = await page.evaluate(async () => {
    openAdminChoice();
    await new Promise(r => setTimeout(r, 120));
    const g = document.querySelector('.admin-group[data-group="content"]');
    const head = g.querySelector(".admin-group-head");
    head.click();
    await new Promise(r => setTimeout(r, 120));
    const body = g.querySelector(".admin-group-body");
    const hidden = getComputedStyle(body).display === "none";
    const stored = JSON.parse(localStorage.getItem("izzbah-admin-groups-v1") || "{}");
    const aria = head.getAttribute("aria-expanded");
    head.click();   // put it back
    await new Promise(r => setTimeout(r, 100));
    return { hidden, stored, aria, reopened: g.dataset.open };
  });
  check("collapsing a group hides its entries", collapse.hidden === true);
  check("…and is announced to assistive tech", collapse.aria === "false");
  check("…and remembered between visits", collapse.stored.content === 0);
  check("…and it opens again", collapse.reopened === "1");

  // ---- the group header has to be READABLE, in both themes ----
  // A <button> does not inherit text colour: it takes the UA default, which is
  // BLACK. The subtitle and chevron were therefore pure black on a dark maroon
  // panel — visible enough in a screenshot to look intentional, and unreadable
  // in use. Contrast is measured against the PAINTED pixel rather than computed
  // from the CSS, because the header background is translucent and stacking the
  // layers by hand is exactly where such a check goes quietly wrong.
  const lum = ([r, g, b]) => {
    const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const rgbOf = s => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);

  for (const theme of ["light", "dark"]) {
    const c = await page.evaluate(async (theme) => {
      state.theme = theme;
      document.documentElement.setAttribute("data-theme", theme);
      openAdminChoice();
      await new Promise(r => setTimeout(r, 260));
      const g = document.querySelector(".admin-group");
      const cs = k => getComputedStyle(g.querySelector(k));
      const r = g.querySelector(".admin-group-head").getBoundingClientRect();
      return {
        name: cs(".admin-group-name").color,
        sub: cs(".admin-group-sub").color,
        subOp: cs(".admin-group-sub").opacity,
        chev: cs(".admin-group-chev").color,
        at: { x: Math.round(r.left + r.width * 0.5), y: Math.round(r.top + r.height * 0.72) },
      };
    }, theme);
    const shot = await page.screenshot({ clip: { x: c.at.x - 2, y: c.at.y - 2, width: 4, height: 4 } });
    const bg = await page.evaluate(async (b64) => {
      const img = new Image(); img.src = "data:image/png;base64," + b64;
      await img.decode();
      const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext("2d"); ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(2, 2, 1, 1).data;
      return [d[0], d[1], d[2]];
    }, shot.toString("base64"));

    const blend = (col, op) => {
      const C = rgbOf(col), a = parseFloat(op || "1");
      return C.map((v, i) => v * a + bg[i] * (1 - a));
    };
    const nm = contrast(rgbOf(c.name), bg);
    const sb = contrast(blend(c.sub, c.subOp), bg);
    const cv = contrast(rgbOf(c.chev), bg);
    check(`${theme}: the group name is readable (${nm.toFixed(1)}:1)`, nm >= 4.5);
    check(`${theme}: the group subtitle is readable (${sb.toFixed(1)}:1)`, sb >= 4.5);
    check(`${theme}: the chevron is readable (${cv.toFixed(1)}:1)`, cv >= 4.5);
    // The specific regression: nothing in the header may fall back to black.
    check(`${theme}: nothing in the header is the browser's default black`,
      ![c.name, c.sub, c.chev].some(x => /^rgb\(0, 0, 0\)$/.test(x)));
  }
  await page.evaluate(() => { state.theme = "light"; document.documentElement.setAttribute("data-theme", "light"); });

  // ---- the category-editor toolbar has a hierarchy ----
  //
  // It was eleven buttons in equal grid cells, all the same bright red:
  // «حذف كل الأسئلة» shouted exactly as loudly as «ضغط صور الفئات», and the one
  // action reached for constantly — adding a question — could not be found at a
  // glance. Rank is carried by weight now: one primary, quiet everyday actions,
  // outlined-red destructive ones, and the rare maintenance tools last.
  //
  // The contrast half of this is worth its own note: the admin panel is a DARK
  // surface in BOTH themes (measured, its ground sits at rgb(20,17,12) either
  // way). A light-theme palette was written for it on the assumption it went
  // light, which put dark brown text on near-black at 1.97:1 — so the check runs
  // in both themes and the palette is deliberately theme-independent.
  const toolbarLum = ([r, g, bl]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl); };
  const toolbarRatio = (a, c) => { const [x, y] = [toolbarLum(a), toolbarLum(c)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const toolbarParse = (str) => { const n = (str.match(/-?\d*\.?\d+/g) || []).map(Number);
    return /^color\(/.test(str) ? n.slice(-3).map(v => Math.round(v * 255)) : n.slice(0, 3); };

  for (const mode of ["dark", "light"]) {
    const shape = await page.evaluate((m) => {
      state.theme = m; document.documentElement.setAttribute("data-theme", m);
      document.querySelectorAll(".modal-backdrop.open").forEach(x => x.classList.remove("open"));
      openAdminPanel();
      const foot = document.querySelector("#adminPanel .admin-foot");
      const btns = [...foot.querySelectorAll("button")].filter(x => !x.hidden);
      const tier = x => (x.className.match(/af-\w+/) || ["none"])[0];
      const r = x => x.getBoundingClientRect();
      const visual = btns.slice().sort((a, b) => (r(a).top - r(b).top) || (r(b).left - r(a).left));
      return {
        total: btns.length,
        untiered: btns.filter(x => tier(x) === "none").length,
        primaries: btns.filter(x => tier(x) === "af-primary").length,
        // the primary must come FIRST visually, whatever the source order
        firstTier: tier(visual[0]),
        // The tail of the toolbar must be the RARE stuff. Since .296 that is
        // the maintenance strip, which ends with the destructive pair — so the
        // test is "nothing everyday is last", not "af-tool is last".
        lastTier: tier(visual[visual.length - 1]),
        // Stronger: no everyday action may appear after a tool/destructive one.
        orderClean: (() => {
          const rare = t => t === "af-tool" || t === "af-danger";
          let seenRare = false;
          for (const x of visual) {
            const t = tier(x);
            if (rare(t)) seenRare = true;
            else if (seenRare) return false;      // an everyday button after a rare one
          }
          return true;
        })(),
        rows: new Set(btns.map(x => Math.round(r(x).top))).size,
        // a tool is quieter than an everyday button, which is quieter than the primary
        sizes: ["af-primary", "af-quiet", "af-tool"].map(t => {
          const el = btns.find(x => tier(x) === t);
          return el ? parseFloat(getComputedStyle(el).fontSize) : null;
        }),
        targets: btns.map(x => ({ tier: tier(x), color: getComputedStyle(x).color,
          at: { x: Math.round(r(x).left + 3), y: Math.round(r(x).top + r(x).height / 2) } })),
      };
    }, mode);

    if (mode === "dark") {
      check(`the toolbar puts every button in a tier (${shape.untiered} untiered of ${shape.total})`,
        shape.untiered === 0 && shape.total >= 8);
      check(`…with exactly one primary (${shape.primaries})`, shape.primaries === 1);
      check(`…drawn first (${shape.firstTier})`, shape.firstTier === "af-primary");
      check(`…and something RARE last, never an everyday action (${shape.lastTier})`,
        shape.lastTier === "af-tool" || shape.lastTier === "af-danger");
      check("…with no everyday button stranded after the rare ones", shape.orderClean);
      // Grouped into tiers since .296, so a couple of rows per group is the
      // shape now. The bug this still guards is the original one: eleven
      // buttons each on their own line.
      check(`…flowing onto a few rows rather than one cell each (${shape.rows} rows)`,
        shape.rows >= 1 && shape.rows <= 6);
      check(`…the primary is the largest and a tool the smallest (${shape.sizes.join(" > ")})`,
        shape.sizes[0] > shape.sizes[2] && shape.sizes[1] >= shape.sizes[2]);
    }

    const shot = (await page.screenshot()).toString("base64");
    const bgs = await page.evaluate(async ([b64, pts]) => {
      const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
      const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext("2d"); ctx.drawImage(img, 0, 0);
      return pts.map(pt => { const d = ctx.getImageData(pt.x, pt.y, 1, 1).data; return [d[0], d[1], d[2]]; });
    }, [shot, shape.targets.map(t => t.at)]);
    const worst = {};
    shape.targets.forEach((t, k) => {
      const cr = toolbarRatio(toolbarParse(t.color), bgs[k]);
      if (worst[t.tier] === undefined || cr < worst[t.tier]) worst[t.tier] = cr;
    });
    Object.keys(worst).forEach(t => {
      check(`${mode}: the worst «${t}» button is readable (${worst[t].toFixed(2)}:1)`, worst[t] >= 4.5);
    });
  }
  await page.evaluate(() => { state.theme = "light"; document.documentElement.setAttribute("data-theme", "light"); });

  check("no uncaught JS errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 4));
} catch (e) {
  check("harness completed", false);
  console.log("  harness error:", e.message);
} finally {
  await browser.close();
  server.kill();
}
process.exit(checks.every(Boolean) ? 0 : 1);
