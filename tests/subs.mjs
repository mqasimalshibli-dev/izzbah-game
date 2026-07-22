// Subscription-panel optimizations:
//   1) a search box filters the ALREADY-LOADED code / player / order lists in
//      place (no extra Firestore reads), matching codes by code or redeemer-uid,
//      orders by email/uid/pack, and players by uid.
//   2) pending orders update LIVE via an onSnapshot listener while the panel is
//      open (watchOrders), and the listener is torn down when the panel closes.
//
// Runs OFFLINE (Firebase SDK aborted); the cloud bridges are stubbed, so the
// same client render/filter/subscribe code paths run as in production.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8392;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

// ---- static: the real-time bridge tears down (returns an unsubscribe) ----
const html = readFileSync(join(ROOT, "game-mobile.html"), "utf8");
check("watchOrders is an admin-gated onSnapshot listener that returns an unsubscribe",
  /IZZBAH\.watchOrders = function/.test(html) && /\.onSnapshot\(/.test(html)
  && /if \(!cloudIsAdmin \|\| typeof cb !== "function"\) return function \(\) \{\};/.test(html));

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // Seed the panel with codes, usage, and orders through the stubbed bridges,
  // and a fake watchOrders that captures the callback + counts unsubscribes.
  const opened = await page.evaluate(async () => {
    window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true);
    window.__unsubCount = 0;
    window.__pushOrders = null;
    window.IZZBAH.watchOrders = (cb) => { window.__pushOrders = cb; return () => { window.__unsubCount++; }; };
    window.IZZBAH.listCodes = () => Promise.resolve([
      { code: "AAAA-1111", gamesAllowed: 5, premium: false, used: true,  usedBy: "userALICE", usedAt: 1750000000000 },
      { code: "BBBB-2222", gamesAllowed: 3, premium: false, used: true,  usedBy: "userBOB",   usedAt: 1750000000000 },
      { code: "ZZZZ-9999", gamesAllowed: 9, premium: false, used: false, usedBy: "" },
    ]);
    // Players derive from the usage mirror (uid -> {used, granted, premium}).
    window.IZZBAH.listUsage = () => Promise.resolve({
      userALICE: { used: 1, granted: 5, premium: false },
      userBOB: { used: 0, granted: 3, premium: false },
    });
    window.IZZBAH.listOrders = () => Promise.resolve([
      { uid: "userALICE", email: "alice@example.com", pack: "باقة ٥ ألعاب", games: 5, premium: false, createdAt: 1750000000000 },
    ]);
    openPremiumModal();
    await new Promise(r => setTimeout(r, 300));
    return {
      liveBadge: !!document.getElementById("premOrdersLive"),
      hasSearch: !!document.getElementById("premSearch"),
      subscribed: typeof window.__pushOrders === "function",
      orders: document.getElementById("premOrders").textContent,
      codes: document.getElementById("premList").textContent,
      players: document.getElementById("premPlayers").textContent,
    };
  });
  check("the panel shows a «مباشر» live badge + a search box", opened.liveBadge && opened.hasSearch);
  check("opening the panel subscribes to live orders (watchOrders)", opened.subscribed);
  check("initial orders/codes/players all render", /alice@example\.com/.test(opened.orders)
    && /AAAA-1111/.test(opened.codes) && /userALICE/.test(opened.players) && /userBOB/.test(opened.players));

  // ---- live push: a new order arrives with the panel open ----
  const live = await page.evaluate(async () => {
    window.__pushOrders([
      { uid: "userNEW", email: "newbuyer@example.com", pack: "باقة ١٥ لعبة", games: 15, premium: false, createdAt: 1760000000000 },
      { uid: "userALICE", email: "alice@example.com", pack: "باقة ٥ ألعاب", games: 5, premium: false, createdAt: 1750000000000 },
    ]);
    await new Promise(r => setTimeout(r, 80));
    return document.getElementById("premOrders").textContent;
  });
  check("a live-pushed order appears in the panel with no manual refresh",
    /newbuyer@example\.com/.test(live) && /alice@example\.com/.test(live));

  // ---- search: filters the loaded lists in place ----
  const byEmail = await page.evaluate(async () => {
    const s = document.getElementById("premSearch");
    s.value = "newbuyer"; s.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    return document.getElementById("premOrders").textContent;
  });
  check("searching an email filters the orders list to the match",
    /newbuyer@example\.com/.test(byEmail) && !/alice@example\.com/.test(byEmail));

  const byCode = await page.evaluate(async () => {
    const s = document.getElementById("premSearch");
    s.value = "bbbb"; s.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    return document.getElementById("premList").textContent;
  });
  check("searching a code substring filters the codes list (case-insensitive)",
    /BBBB-2222/.test(byCode) && !/AAAA-1111/.test(byCode));

  const byUid = await page.evaluate(async () => {
    const s = document.getElementById("premSearch");
    s.value = "userALICE"; s.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    return {
      players: document.getElementById("premPlayers").textContent,
      codes: document.getElementById("premList").textContent,
    };
  });
  check("searching a uid filters players to that account",
    /userALICE/.test(byUid.players) && !/userBOB/.test(byUid.players));
  check("the same uid search filters the codes list by redeemer",
    /AAAA-1111/.test(byUid.codes) && !/BBBB-2222/.test(byUid.codes));

  const cleared = await page.evaluate(async () => {
    const s = document.getElementById("premSearch");
    s.value = ""; s.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    return document.getElementById("premPlayers").textContent;
  });
  check("clearing the search restores every player row", /userALICE/.test(cleared) && /userBOB/.test(cleared));

  // ---- closing the panel tears the live listener down ----
  const closed = await page.evaluate(async () => {
    closePremiumModal();
    await new Promise(r => setTimeout(r, 50));
    return window.__unsubCount;
  });
  check("closing the panel unsubscribes the live orders listener (no leaked reads)", closed === 1);

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
