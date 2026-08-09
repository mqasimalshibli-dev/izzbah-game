// New-announcement launch popup: after the player signs in, a brand-NEW
// announcement pops up once over whatever screen they land on. It fires only
// for announcements newer than the last one already popped on this device, and
// never for a signed-out user.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8373;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1000, height: 950 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

const popOpen = () => page.evaluate(() => document.getElementById("annPopModal").classList.contains("open"));

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ---- 1) signed-OUT: never pops ----
  await page.evaluate(() => {
    try { localStorage.removeItem("izzbah-ann-popped-v1"); } catch (e) {}
    state.signedIn = false;
    state.announcements = [{ id: "a1", title: "تجربة مجانية", body: "اللعبة في مرحلة تجربة", createdAt: 5000, icon: "📢" }];
    maybePopAnnouncement();
  });
  await page.waitForTimeout(850);
  check("a signed-out player never sees the launch popup", !(await popOpen()));

  // ---- 2) signed in, but the announcement is NOT newer than what was popped ----
  await page.evaluate(() => {
    try { localStorage.setItem("izzbah-ann-popped-v1", "9000"); } catch (e) {}
    state.signedIn = true;
    state.announcements = [{ id: "a1", title: "قديم", body: "…", createdAt: 5000, icon: "📢" }];
    maybePopAnnouncement();
  });
  await page.waitForTimeout(850);
  check("an already-seen (not newer) announcement does NOT pop", !(await popOpen()));

  // ---- 3) signed in + a genuinely NEW announcement → pops with its content ----
  await page.evaluate(() => {
    try { localStorage.setItem("izzbah-ann-popped-v1", "1000"); } catch (e) {}
    state.signedIn = true;
    state.announcements = [
      { id: "a1", title: "إعلان آخر", body: "نص آخر", createdAt: 1500, icon: "📢" },
      { id: "a2", title: "ميزة جديدة", body: "أضفنا فئات جديدة!", createdAt: 6000, icon: "🎉" },
    ];
    maybePopAnnouncement();
  });
  await page.waitForTimeout(900);
  const shown = await page.evaluate(() => ({
    open: document.getElementById("annPopModal").classList.contains("open"),
    body: document.getElementById("annPopBody").textContent,
    more: document.getElementById("annPopMore").hidden ? "" : document.getElementById("annPopMore").textContent,
    popped: Number(localStorage.getItem("izzbah-ann-popped-v1")) || 0,
  }));
  check("a new announcement pops up on launch after sign-in", shown.open);
  check("the popup shows the NEWEST announcement's content", /ميزة جديدة/.test(shown.body) && /فئات جديدة/.test(shown.body));
  check("with several new, it notes the rest are in the center", /في مركز الإعلانات/.test(shown.more));
  check("popping marks these announcements as handled (won't re-pop)", shown.popped >= 6000);

  // ---- 4) it fires at most once per launch ----
  const stillOne = await page.evaluate(() => {
    // Even if a new load event fires, the same session won't stack a second pop.
    maybePopAnnouncement();
    return document.querySelectorAll("#annPopModal.open").length;
  });
  check("the popup fires at most once per launch", stillOne === 1);

  // ---- 5) «كل الإعلانات» opens the full announcement center ----
  const toCenter = await page.evaluate(() => {
    document.getElementById("annPopAll").click();
    return {
      popClosed: !document.getElementById("annPopModal").classList.contains("open"),
      centerOpen: document.getElementById("announceModal").classList.contains("open"),
    };
  });
  check("«كل الإعلانات» closes the popup and opens the center", toCenter.popClosed && toCenter.centerOpen);

  // ---- 6) closing the center, the popup does not reappear this session ----
  const noReappear = await page.evaluate(() => {
    closeAnnouncements();
    maybePopAnnouncement();
    return document.getElementById("annPopModal").classList.contains("open");
  });
  check("the popup does not reappear later in the same session", !noReappear);

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
