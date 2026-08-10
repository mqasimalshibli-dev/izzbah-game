// The category toolbar, rebuilt to the owner's mock (build .296).
//
// It was eleven equal-weight buttons in ONE wrapped row, ordered by CSS
// `order:`. That ordering only holds while everything fits on a line, so at
// some window widths «حذف كل الأسئلة» wrapped up beside «إضافة سؤال جديد».
// It is now four tiers — identity + publish, category state, question actions,
// then a muted maintenance strip with the destructive pair pushed to the end.
//
// Two things this must never do, and both nearly happened while building it:
//   • lose a control. Restructuring markup silently drops whatever you forget
//     to move, and the handler goes with it. Every id and its click wiring is
//     checked here.
//   • reveal a hidden one. `.admin-foot button { display: inline-flex }` beats
//     the UA's `[hidden] { display: none }`, so «إعادة تحميل من الأصل» and
//     «حذف المحدد» painted for every category until an explicit override.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8453;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.route("**/firebasejs/**", r => r.abort());
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

// Every control the toolbar has ever carried. If one disappears from the DOM
// the restructure dropped it.
const IDS = ["adminPublishBtn", "adminAddQuestion", "adminImportQuestions", "adminSelectAll",
  "adminFillDistractors", "adminFetchImages", "adminUndo", "adminDeleteSelected",
  "adminClearQuestions", "adminExportAll", "adminShrinkCovers", "adminShrinkQMedia",
  "adminBuildIndex", "adminReseedBuiltin", "adminToggleChoices"];

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1600);
  const seed = async () => page.evaluate(async () => {
    window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true);
    document.getElementById("adminEntry").click();
    await new Promise(r => setTimeout(r, 200));
    document.getElementById("adminChoiceContent").click();
    await new Promise(r => setTimeout(r, 400));
    const mk = (pts, n) => Array.from({ length: n }, (_, i) => ({ points: pts, q: "سؤال " + i, a: "جواب " + i }));
    state.adminCat = { id: "emoji", name: "معنى الايموجي", image: "", color: "#6b3fb8",
      custom: false, published: true, order: 0,
      questions: [...mk(100, 18), ...mk(200, 23), ...mk(300, 27)] };
    clearAdminUndo(); populateAdminFilter(); renderAdminTable(); renderAdminCatHead();
    await new Promise(r => setTimeout(r, 300));
  });
  await seed();

  const present = await page.evaluate(ids => {
    const out = {};
    ids.forEach(id => { out[id] = !!document.getElementById(id); });
    return out;
  }, IDS);
  const missing = IDS.filter(id => !present[id]);
  check("every control survived the restructure", missing.length === 0, missing.join(", ") || "all present");

  // ---- grouping ----------------------------------------------------------
  const groups = await page.evaluate(() => {
    const groupOf = id => {
      const el = document.getElementById(id);
      if (!el) return null;
      const g = el.closest(".af-group") || el.closest(".ac-row");
      return g ? (g.className.match(/(af-group-\w+|ac-row-\w+)/) || [null])[0] : "loose";
    };
    return {
      publish: groupOf("adminPublishBtn"),
      hide: groupOf("adminToggleChoices"),
      add: groupOf("adminAddQuestion"),
      undo: groupOf("adminUndo"),
      shrink: groupOf("adminShrinkCovers"),
      index: groupOf("adminBuildIndex"),
      clear: groupOf("adminClearQuestions"),
      delSel: groupOf("adminDeleteSelected"),
    };
  });
  check("publish sits with the category's identity", groups.publish === "ac-row-id", groups.publish);
  check("the state switches are their own band", groups.hide === "ac-row-state", groups.hide);
  check("the question actions are one group",
    groups.add === "af-group-do" && groups.undo === "af-group-do", `${groups.add}/${groups.undo}`);
  check("maintenance is one group",
    groups.shrink === "af-group-maint" && groups.index === "af-group-maint", `${groups.shrink}/${groups.index}`);
  check("the destructive pair lives in the maintenance strip, not beside «إضافة»",
    groups.clear === "af-group-maint" && groups.delSel === "af-group-maint",
    `${groups.clear}/${groups.delSel}`);

  // The actual complaint the grouping fixes: never adjacent.
  const adjacency = await page.evaluate(() => {
    const add = document.getElementById("adminAddQuestion");
    const clear = document.getElementById("adminClearQuestions");
    const a = add.getBoundingClientRect(), c = clear.getBoundingClientRect();
    const sameLine = Math.abs(a.top - c.top) < 14;
    return { sameLine, gap: Math.round(Math.abs(a.top - c.top)) };
  });
  check("«حذف كل الأسئلة» is never on the same line as «إضافة سؤال جديد»",
    !adjacency.sameLine, `${adjacency.gap}px apart vertically`);

  // ---- hidden must STAY hidden ------------------------------------------
  const hiddenState = await page.evaluate(() => {
    const box = id => {
      const e = document.getElementById(id);
      return { hidden: e.hasAttribute("hidden"), painted: e.getBoundingClientRect().height > 0 };
    };
    return { reseed: box("adminReseedBuiltin"), delSel: box("adminDeleteSelected") };
  });
  check("«إعادة تحميل من الأصل» is hidden for a category with no bundled bank",
    hiddenState.reseed.hidden && !hiddenState.reseed.painted,
    `hidden=${hiddenState.reseed.hidden} painted=${hiddenState.reseed.painted}`);
  check("«حذف المحدد» is hidden while nothing is selected",
    hiddenState.delSel.hidden && !hiddenState.delSel.painted,
    `hidden=${hiddenState.delSel.hidden} painted=${hiddenState.delSel.painted}`);

  // …and appears the moment something IS selected.
  const shows = await page.evaluate(async () => {
    document.querySelector("#adminRows .q-sel").click();
    await new Promise(r => setTimeout(r, 200));
    const e = document.getElementById("adminDeleteSelected");
    return { hidden: e.hasAttribute("hidden"), painted: e.getBoundingClientRect().height > 0 };
  });
  check("…and appears once a row is ticked", !shows.hidden && shows.painted);

  // ---- the primary action holds its place on a wide panel ---------------
  const line = await page.evaluate(() => {
    const pub = document.getElementById("adminPublishBtn").getBoundingClientRect();
    const name = document.querySelector(".ac-name").getBoundingClientRect();
    return { sameLine: Math.abs(pub.top - name.top) < 14, delta: Math.round(Math.abs(pub.top - name.top)) };
  });
  check("publish shares the identity line rather than wrapping alone",
    line.sameLine, `${line.delta}px off`);

  // ---- the handlers still fire ------------------------------------------
  const wired = await page.evaluate(async () => {
    const before = state.adminCat.questions.length;
    document.getElementById("adminAddQuestion").click();
    await new Promise(r => setTimeout(r, 250));
    const opened = !!document.querySelector("#adminQModal.open, #adminQModal[style*='block']")
      || state.adminCat.questions.length !== before;
    const toast = document.getElementById("appToast");
    toast.classList.remove("show");
    document.getElementById("adminBuildIndex").click();      // no admin bridge offline
    await new Promise(r => setTimeout(r, 250));
    return { addResponds: opened, indexResponds: toast.classList.contains("show") };
  });
  check("«إضافة سؤال جديد» still responds after the move", wired.addResponds);
  check("«بناء فهرس الفئات» still responds after the move", wired.indexResponds);

  // ---- icons: one stroked family, no emoji ------------------------------
  // The toolbar shipped with ✦ ⬆ ☑ ✨ 🖼 ↶ ⚡ 🗂 ⬇ ⟲ 🗑 🙈 🚫, which render in
  // each platform's own style, colour and optical size — a row that can never
  // look like a set. Every icon is now a <use> into one inline sprite.
  const icons = await page.evaluate(() => {
    const scope = [document.querySelector(".admin-cathead"), document.querySelector(".admin-foot")];
    const all = scope.flatMap(el => [...el.querySelectorAll(".af-ico")]);
    const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2190}-\u{27BF}\u{FE0F}]/u;
    const buttons = scope.flatMap(el => [...el.querySelectorAll("button")]);
    return {
      total: all.length,
      notSvg: all.filter(i => i.tagName.toLowerCase() !== "svg").length,
      // every <use> must point at a symbol that exists in the document
      dangling: all.map(i => (i.querySelector("use") || {}).getAttribute?.("href"))
                   .filter(h => !h || !document.querySelector(h)),
      // a VISIBLE icon must actually have a box
      unpainted: all.filter(i => {
        const btn = i.closest("button");
        if (btn && btn.hasAttribute("hidden")) return false;   // legitimately hidden
        const r = i.getBoundingClientRect();
        return r.width < 6 || r.height < 6;
      }).length,
      // and no button label may still carry an emoji glyph
      emojiLabels: buttons.filter(b => emojiRe.test(b.textContent || "")).map(b => b.id || b.className),
    };
  });
  check("every toolbar icon is an SVG from the sprite",
    icons.total >= 12 && icons.notSvg === 0, `${icons.total} icons, ${icons.notSvg} non-svg`);
  check("no icon points at a missing symbol", icons.dangling.length === 0, icons.dangling.join(", "));
  check("every visible icon actually paints", icons.unpainted === 0, `${icons.unpainted} zero-size`);
  check("no emoji left in any toolbar label", icons.emojiLabels.length === 0, icons.emojiLabels.join(", "));

  // The two toggles rebuild their own labels — with innerHTML, or the icon dies.
  const toggles = await page.evaluate(async () => {
    const read = () => {
      const h = document.querySelector(".ac-hide"), c = document.getElementById("adminToggleChoices");
      return { hide: !!h.querySelector("svg.af-ico"), choices: !!c.querySelector("svg.af-ico") };
    };
    const before = read();
    document.querySelector(".ac-hide").click();          // flips to «إظهار الفئة»
    await new Promise(r => setTimeout(r, 250));
    const after = read();
    document.querySelector(".ac-hide").click();          // back
    await new Promise(r => setTimeout(r, 250));
    return { before, after };
  });
  check("the hide/show toggle keeps its icon through a flip",
    toggles.before.hide && toggles.after.hide);
  check("the «أربعة خيارات» switch keeps its icon too",
    toggles.before.choices && toggles.after.choices);

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
