// E2E for shareable custom-game links.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8291;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();
  // Never hit the real Firebase from tests: abort the SDK load so the game
  // runs offline on built-in content (no production Firestore reads/quota).
  await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
const clickText = t => page.evaluate(txt => { const el = [...document.querySelectorAll("button, .btn, a, .wlc-start")].find(x => x.textContent.trim().includes(txt)); if (el) { el.click(); return true; } return false; }, t);
const url = `http://127.0.0.1:${PORT}/game-mobile.html`;

try {
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.IZZBAH.applyAuth && window.IZZBAH.applyAuth(true); });
  await clickText("ابدأ"); await page.waitForTimeout(300);
  await clickText("إنشاء لعبة جديدة"); await page.waitForTimeout(500);

  // share button disabled with no selection
  const disabled0 = await page.evaluate(() => document.getElementById("shareGameBtn").disabled);
  check("share button disabled before any category is picked", disabled0);

  // pick two built-in categories + name the game
  await page.fill("#gameNameInput", "سهرة الجمعة");
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#categoryGrid .category")];
    const pick = ["تاريخ", "علوم"];
    pick.forEach(nm => { const c = cards.find(x => x.textContent.includes(nm)); if (c) c.click(); });
  });
  await page.waitForTimeout(300);
  const enabled = await page.evaluate(() => !document.getElementById("shareGameBtn").disabled);
  check("share button enabled after selecting categories", enabled);

  // capture the link the app would share (intercept clipboard; navigator.share is absent in headless)
  const link = await page.evaluate(async () => {
    let captured = null;
    if (navigator.clipboard) navigator.clipboard.writeText = t => { captured = t; return Promise.resolve(); };
    document.getElementById("shareGameBtn").click();
    await new Promise(r => setTimeout(r, 150));
    return captured;
  });
  check(`share produced a link with a #g= payload (${link ? link.slice(0, 48) : "null"}…)`, !!link && /#g=/.test(link));

  // decode the payload to confirm it carries the name + 2 category ids
  const decoded = await page.evaluate((lnk) => {
    const m = lnk.match(/#g=([^&]+)/); if (!m) return null;
    let s = decodeURIComponent(m[1]).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
    const bin = atob(s); const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }, link);
  check("payload carries game name + 2 category ids", decoded && decoded.n === "سهرة الجمعة" && Array.isArray(decoded.c) && decoded.c.length === 2);

  // OPEN the link in a fresh page → categories pre-selected, on the categories screen
  const page2 = await ctx.newPage();
  page2.on("pageerror", e => errs.push("p2:" + e.message));
  page2.on("dialog", d => d.accept().catch(() => {}));
  await page2.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
  await page2.goto(link.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${PORT}`), { waitUntil: "load", timeout: 30000 });
  await page2.waitForTimeout(1800);
  const opened = await page2.evaluate(() => ({
    onCategories: document.getElementById("categories").classList.contains("active"),
    selectedCount: document.querySelectorAll("#categoryGrid .category.selected").length,
    name: document.getElementById("gameNameInput") ? document.getElementById("gameNameInput").value : "",
    hashCleared: location.hash === "",
    goTeamsEnabled: !document.getElementById("goTeams").disabled,
  }));
  check("opening the link lands on the categories screen", opened.onCategories);
  check(`the two shared categories are pre-selected (got ${opened.selectedCount})`, opened.selectedCount === 2);
  check("the shared game name is restored", opened.name === "سهرة الجمعة");
  check("start-teams button is enabled (ready to play)", opened.goTeamsEnabled);
  check("URL hash is cleaned after applying", opened.hashCleared);

  // Regression: a late cloud reload (loadGameSettings) must NOT wipe the shared
  // pre-selection while it's still pending.
  const afterReload = await page2.evaluate(() => {
    loadGameSettings();      // what the signed-in cloud sync fires on snapshot
    renderCategories();
    return document.querySelectorAll("#categoryGrid .category.selected").length;
  });
  check(`shared selection survives a cloud reload (got ${afterReload})`, afterReload === 2);
  // …and once the host touches the selection, the shared-preset lock releases
  // (so it won't be re-forced), while the host's own edit is respected.
  const afterTakeover = await page2.evaluate(() => {
    const c = [...document.querySelectorAll("#categoryGrid .category.selected")][0];
    if (c) c.click();        // deselect one → host has taken over
    renderCategories();
    return { selected: document.querySelectorAll("#categoryGrid .category.selected").length, pending: state.pendingSharedGame };
  });
  check(`host edit respected (${afterTakeover.selected}) and the shared lock releases`, afterTakeover.selected === 1 && afterTakeover.pending === false);

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
