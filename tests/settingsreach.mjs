// The account/settings button must be reachable from every screen except the
// board of point cells and the two takeovers a cell opens.
//
// It used to be hidden on category-pick, team-setup AND results as well, so a
// player who wanted their account, theme or announcements from any of those
// three had to back out first. Owner asked for it everywhere but the cells.
//
// It also has to be reachable, not merely present: a button painted under
// another element, or off-screen, is hidden in every way that matters.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8413;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  " + extra : ""}`); };

const VISIBLE = ["menu", "gameLibrary", "setup", "categories", "customManager", "customEditor", "results"];
const HIDDEN  = ["game", "questionPage", "answerPage"];

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];
const page = await browser.newPage({ viewport: { width: 420, height: 880 } });
await page.route("**/firebasejs/**", r => r.abort());
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(1400);

const probe = (screen) => page.evaluate(async (s) => {
  document.body.setAttribute("data-screen", s);
  await new Promise(r => setTimeout(r, 90));
  const el = document.getElementById("userSettingsBtn");
  if (!el) return { present: false };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const shown = cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity > .05 && r.width > 0;
  // Reachable = the topmost element at its centre is the button itself (or
  // inside it). A control covered by an overlay is not reachable.
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { present: true, shown, reachable: shown && !!hit && (hit === el || el.contains(hit)),
           w: Math.round(r.width), inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth };
}, screen);

for (const s of VISIBLE) {
  const r = await probe(s);
  check(`«${s}» — settings is visible and reachable`, r.present && r.shown && r.reachable && r.inView,
    r.present ? `shown=${r.shown} reachable=${r.reachable} inView=${r.inView}` : "BUTTON MISSING");
}
for (const s of HIDDEN) {
  const r = await probe(s);
  check(`«${s}» — settings stays hidden`, r.present && !r.shown, `shown=${r.shown}`);
}

check("no uncaught JS errors", errs.length === 0);
if (errs.length) console.log("  ", errs.slice(0, 3));
await browser.close(); server.kill();
process.exit(checks.every(Boolean) ? 0 : 1);
