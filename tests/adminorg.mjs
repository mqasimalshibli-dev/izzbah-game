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
  ["adminChoiceStats", "statsModal"],
  ["adminChoiceQHealth", "qHealthModal"],
  ["adminChoiceSubs", "premiumModal"],
  ["adminChoiceFeedback", "feedbackAdminModal"],
  ["adminChoiceAnnounce", "announceAdminModal"],
  ["adminChoiceText", null],
  ["adminChoiceCoach", "coachAdminModal"],
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
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
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

  check(`the panel is organised into groups (${shape.groups.length})`, shape.groups.length === 5);
  check(`every entry lives in one (${shape.loose.length} loose)`, shape.loose.length === 0);
  check(`no entry was lost in the move (${shape.total} of ${ENTRIES.length})`,
    shape.total === ENTRIES.length);
  const flat = shape.groups.flatMap(g => g.items);
  check("…and none is duplicated", new Set(flat).size === flat.length);
  const missing = ENTRIES.map(([id]) => id).filter(id => !flat.includes(id));
  check(`every known entry is present (${missing.join(", ") || "none missing"})`, missing.length === 0);
  check("groups start expanded, so nothing is hidden from someone used to the flat list",
    shape.groups.every(g => g.open === "1"));
  shape.groups.forEach(g => {
    check(`«${g.name}» holds ${g.items.length} entries`, g.items.length >= 2);
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
