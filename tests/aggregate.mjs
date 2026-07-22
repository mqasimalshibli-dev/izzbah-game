// Per-player balance aggregate (removes the 2000-code read ceiling):
//   • The player mirrors their authoritative code balance (games + unlimited)
//     into their own usage doc via pushUsage(used, {granted, premium}); the
//     admin players view then reads that mirror — ONE query, no per-code scan.
//   • The player's REAL entitlement is unchanged (authoritative code docs), so
//     the mirror is a cache only.
//   • The admin can «rebuild» the mirror from codes (migration / repair).
//   • The codes list is a capped audit view whose truncation no longer affects
//     any balance.
//
// Runs OFFLINE (Firebase SDK aborted); the mirror WRITE path (transaction) lives
// in the Firebase bridge, so it's asserted statically; the client CALL shape and
// the admin render/rebuild paths run live against stubs.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8394;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

// ---- static: the bridge + rules carry the mirror ----
const html = readFileSync(join(ROOT, "game-mobile.html"), "utf8");
const rules = readFileSync(join(ROOT, "firestore.rules"), "utf8");
check("pushUsage mirrors granted+premium and preserves them when absent",
  /pushUsage = function \(n, grant\)/.test(html) && /gamesGranted:/.test(html)
  && /g === null \? \(Number\(d\.gamesGranted\) \|\| 0\) : g/.test(html));
check("pushUsage skips an all-zero record (no empty docs for pure free-players)",
  /v === 0 && \(g === null \|\| g === 0\) && \(prem === null \|\| prem === false\)/.test(html));
check("listUsage returns the {used, granted, premium} mirror per player",
  /granted: Number\(d\.gamesGranted\) \|\| 0/.test(html) && /premium: !!d\.premium/.test(html));
check("a rebuildBalances bridge scans codes and rewrites each player's mirror",
  /IZZBAH\.rebuildBalances = function/.test(html) && /scanPage/.test(html) && /startAfter/.test(html));
check("revoking a used code re-syncs that player's mirror",
  /function resyncPlayerMirror/.test(html) && /usedBy \? resyncPlayerMirror\(usedBy\)/.test(html));
check("rules: a player OR an admin may write the usage doc, with the mirror fields",
  /\(request\.auth\.uid == uid \|\| isAdmin\(\)\)[\s\S]*gamesGranted/.test(rules)
  && /request\.resource\.data\.gamesGranted is int/.test(rules)
  && /request\.resource\.data\.premium is bool/.test(rules));

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

  // ---- client: applying the code balance mirrors granted+premium ----
  const mirror = await page.evaluate(async () => {
    window.IZZBAH.applyAuth(true, "playerX");
    const calls = [];
    window.IZZBAH.pushUsage = (n, grant) => { calls.push({ n, grant }); return Promise.resolve(true); };
    state.gamesUsed = 2; state.gamesAllowed = 0;
    window.IZZBAH.applyCodes({ gamesAllowed: 8, premium: false }); // 8 games from codes
    const games = calls.pop();
    window.IZZBAH.applyCodes({ gamesAllowed: 0, premium: true });  // unlimited code
    const unlimited = calls.pop();
    return { games, unlimited };
  });
  check("applying a games balance mirrors {granted, premium:false} alongside used",
    mirror.games && mirror.games.n === 2 && mirror.games.grant && mirror.games.grant.granted === 8 && mirror.games.grant.premium === false);
  check("applying an unlimited balance mirrors premium:true",
    mirror.unlimited && mirror.unlimited.grant && mirror.unlimited.grant.premium === true);

  // consuming an allowance game re-publishes the mirror (used goes up, grant kept)
  const consumed = await page.evaluate(async () => {
    const calls = [];
    window.IZZBAH.pushUsage = (n, grant) => { calls.push({ n, grant }); return Promise.resolve(true); };
    state.gamesUsed = 0; state.codeGamesAllowed = 5; state.codePremium = false; state.isPremium = false; state.gamesAllowed = 0;
    consumeAllowanceGame();
    return calls.pop();
  });
  check("consuming an allowance game mirrors the new used count with the grant",
    consumed && consumed.n === 1 && consumed.grant && consumed.grant.granted === 5);

  // ---- admin: players view derives balance from the mirror (granted − used) ----
  const view = await page.evaluate(async () => {
    window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true);
    window.IZZBAH.listCodes = () => Promise.resolve([]); // players view no longer needs codes
    window.IZZBAH.listOrders = () => Promise.resolve([]);
    window.IZZBAH.listUsage = () => Promise.resolve({
      pA: { used: 4, granted: 10, premium: false }, // 6 left
      pB: { used: 3, granted: 0,  premium: true  }, // ∞
      pFree: { used: 0, granted: 0, premium: false }, // no grant -> not shown
    });
    openPremiumModal();
    await new Promise(r => setTimeout(r, 300));
    const rowFor = uid => ([...document.querySelectorAll("#premPlayers .prem-row")].find(r => r.textContent.includes(uid)) || {}).textContent || "";
    return { a: rowFor("pA"), b: rowFor("pB"), all: document.getElementById("premPlayers").textContent };
  });
  check("a player's remaining is granted − used from the mirror (10−4=6)",
    view.a.includes("متبقٍ") && view.a.includes("6") && view.a.includes("10"));
  check("an unlimited mirror shows ∞", view.b.includes("∞"));
  check("a player with no grant (free-only) is not listed", !view.all.includes("pFree"));

  // ---- admin: the «rebuild» button rebuilds the mirror from codes ----
  const rebuilt = await page.evaluate(async () => {
    let called = 0;
    window.IZZBAH.rebuildBalances = () => { called++; return Promise.resolve(7); };
    window.IZZBAH.listCodes = () => Promise.resolve([]);
    window.IZZBAH.listUsage = () => Promise.resolve({});
    window.IZZBAH.listOrders = () => Promise.resolve([]);
    document.getElementById("premRebuild").click();
    await new Promise(r => setTimeout(r, 250));
    return { called, status: document.getElementById("premStatus").textContent };
  });
  check("the «rebuild» button exists and calls rebuildBalances", rebuilt.called === 1);
  check("rebuild reports how many player balances it rebuilt (7)", /7/.test(rebuilt.status));

  // ---- codes audit list shows a truncation note at the cap (balances unaffected) ----
  const trunc = await page.evaluate(async () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({ code: "C-" + i, gamesAllowed: 1, premium: false, used: false, usedBy: "" }));
    window.IZZBAH.listCodes = () => Promise.resolve(many);
    window.IZZBAH.listUsage = () => Promise.resolve({ pA: { used: 0, granted: 3, premium: false } });
    window.IZZBAH.listOrders = () => Promise.resolve([]);
    document.getElementById("premRefresh").click();
    await new Promise(r => setTimeout(r, 350));
    return {
      note: document.getElementById("premList").textContent,
      playerStillOk: document.getElementById("premPlayers").textContent.includes("pA"),
    };
  });
  check("a capped codes list shows a truncation note", /أحدث ٢٠٠٠|٢٠٠٠ كود/.test(trunc.note));
  check("balances stay correct even when the codes list is capped", trunc.playerStillOk);

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
