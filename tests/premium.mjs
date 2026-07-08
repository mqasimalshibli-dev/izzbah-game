// E2E for the admin "player subscriptions" feature: an admin can grant a
// player either an unlimited subscription or a finite games allowance, and the
// client-side play gate consumes the free game, then the allowance, then blocks.
//
// Runs OFFLINE (Firebase SDK aborted) so it never touches production Firestore.
// The cloud bridges (grantEntitlement/listEntitlements) only exist once the SDK
// loads, so here we drive the same code paths through the local bridges
// (applyPremium) and the gate functions the game exposes globally.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8306;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

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

  // ---- Entitlement application: unlimited vs finite allowance ----
  const unlimited = await page.evaluate(() => {
    window.IZZBAH.applyPremium(true, {});
    return { premium: state.isPremium, canStart: canStartNewGame() };
  });
  check("unlimited grant sets premium and allows play", unlimited.premium && unlimited.canStart);

  const allowance = await page.evaluate(() => {
    window.IZZBAH.applyPremium(false, { gamesAllowed: 3 });
    return { premium: state.isPremium, allowed: state.gamesAllowed, remaining: gamesRemaining() };
  });
  check("finite grant sets a 3-game allowance (not unlimited)", !allowance.premium && allowance.allowed === 3 && allowance.remaining === 3);

  // ---- The play gate consumes free game, then allowance, then blocks ----
  const gate = await page.evaluate(() => {
    // fresh non-admin player with a 2-game allowance
    state.isAdmin = false;
    window.IZZBAH.applyPremium(false, { gamesAllowed: 2 });
    state.freeGamePlayed = false; state.gamesUsed = 0;
    const steps = [];
    steps.push(canStartNewGame());          // free game available -> true
    spendGameCredit();                       // spends the free game
    steps.push(state.freeGamePlayed, canStartNewGame()); // true, allowance(2) -> true
    spendGameCredit();                       // spends allowance #1
    steps.push(state.gamesUsed, canStartNewGame());      // 1, remaining 1 -> true
    spendGameCredit();                       // spends allowance #2
    steps.push(state.gamesUsed, canStartNewGame());      // 2, remaining 0 -> false
    return steps;
  });
  check("free game is available before anything is spent", gate[0] === true);
  check("after the free game, the 2-game allowance keeps play open", gate[1] === true && gate[2] === true);
  check("one allowance game consumed, still one left", gate[3] === 1 && gate[4] === true);
  check("allowance exhausted -> new games are blocked", gate[5] === 2 && gate[6] === false);

  // expired grant yields no allowance
  const expired = await page.evaluate(() => {
    state.isAdmin = false; state.freeGamePlayed = true; state.gamesUsed = 0;
    window.IZZBAH.applyPremium(false, { gamesAllowed: 0 }); // watch would zero it when expired
    return canStartNewGame();
  });
  check("expired/zero allowance after the free game blocks play", expired === false);

  // admins always play
  const admin = await page.evaluate(() => {
    state.isAdmin = true; state.freeGamePlayed = true; state.gamesUsed = 99; state.gamesAllowed = 0;
    return canStartNewGame();
  });
  check("admins always bypass the gate", admin === true);

  // redeemed one-time codes feed the same gate
  const codes = await page.evaluate(() => {
    state.isAdmin = false; state.freeGamePlayed = true; state.gamesUsed = 0; state.gamesAllowed = 0;
    window.IZZBAH.applyCodes({ gamesAllowed: 2 });
    const withGamesCode = canStartNewGame() && gamesRemaining() === 2;
    window.IZZBAH.applyCodes({ gamesAllowed: 0, premium: true });
    const withUnlimitedCode = canStartNewGame() && premiumActive();
    window.IZZBAH.applyCodes({});
    return { withGamesCode, withUnlimitedCode, cleared: !canStartNewGame() };
  });
  check("a redeemed 2-games code opens the gate", codes.withGamesCode);
  check("a redeemed unlimited code gives premium play", codes.withUnlimitedCode);
  check("clearing codes (sign-out) closes the gate again", codes.cleared);

  // ---- Admin UI: the gear opens a chooser with the two managers ----
  await page.evaluate(() => { window.IZZBAH.applyAuth(true, "u1"); window.IZZBAH.applyAdmin(true); });
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById("adminEntry").click());
  await page.waitForTimeout(200);
  const chooser = await page.evaluate(() => ({
    open: document.getElementById("adminChoiceModal").classList.contains("open"),
    content: !!document.getElementById("adminChoiceContent"),
    subs: !!document.getElementById("adminChoiceSubs"),
  }));
  check("gear icon opens the chooser with both options", chooser.open && chooser.content && chooser.subs);

  // "content management" -> the admin panel (subscriptions live ONLY in the chooser)
  await page.evaluate(() => document.getElementById("adminChoiceContent").click());
  await page.waitForTimeout(300);
  const toPanel = await page.evaluate(() => ({
    chooserClosed: !document.getElementById("adminChoiceModal").classList.contains("open"),
    onAdmin: document.getElementById("adminPanel").classList.contains("active"),
    noBtn: !document.getElementById("adminPremiumBtn"),
  }));
  check("content management opens the admin panel (no subscriptions button inside)", toPanel.chooserClosed && toPanel.onAdmin && toPanel.noBtn);

  // "subscription management" from the chooser -> the premium modal directly
  await page.evaluate(() => document.getElementById("adminEntry").click());
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById("adminChoiceSubs").click());
  await page.waitForTimeout(250);
  const opened = await page.evaluate(() =>
    document.getElementById("premiumModal").classList.contains("open")
    && !document.getElementById("adminChoiceModal").classList.contains("open"));
  check("subscription management opens the subscriptions modal", opened);

  const toggle = await page.evaluate(() => {
    const mode = document.getElementById("premMode");
    mode.value = "unlimited"; mode.dispatchEvent(new Event("change", { bubbles: true }));
    const hidden = getComputedStyle(document.getElementById("premGamesWrap")).display === "none";
    mode.value = "games"; mode.dispatchEvent(new Event("change", { bubbles: true }));
    const shown = getComputedStyle(document.getElementById("premGamesWrap")).display !== "none";
    return hidden && shown;
  });
  check("choosing 'unlimited' hides the games count; 'games' shows it", toggle);

  // Generating without a signed-in admin bridge surfaces a helpful status (offline)
  const noBridge = await page.evaluate(() => {
    document.getElementById("premGenerate").click();
    return document.getElementById("premStatus").textContent;
  });
  check("generate without cloud bridge reports it needs admin sign-in", /مشرف/.test(noBridge));

  // With a (stubbed) bridge, generating shows the code and passes the games count
  const gen = await page.evaluate(async () => {
    const calls = [];
    window.IZZBAH.createCode = (opts) => { calls.push(opts); return Promise.resolve("AB2D-EF4H"); };
    window.IZZBAH.listCodes = () => Promise.resolve([{ code: "AB2D-EF4H", gamesAllowed: 7, premium: false, used: false, usedBy: "" }]);
    document.getElementById("premMode").value = "games";
    document.getElementById("premMode").dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("premGames").value = "7";
    document.getElementById("premGenerate").click();
    await new Promise(r => setTimeout(r, 250));
    return {
      calls,
      shown: getComputedStyle(document.getElementById("codeResult")).display !== "none",
      code: document.getElementById("codeResultCode").textContent,
      listHasCode: document.getElementById("premList").textContent.includes("AB2D-EF4H"),
      listUnused: /غير مستخدم/.test(document.getElementById("premList").textContent),
    };
  });
  check("generating a 7-games code calls the bridge and displays the code",
    gen.calls.length === 1 && gen.calls[0].gamesAllowed === 7 && !gen.calls[0].premium
    && gen.shown && gen.code === "AB2D-EF4H");
  check("the codes list shows the new unused code", gen.listHasCode && gen.listUnused);

  // A redeemed code shows the redeeming player's account id in the list
  const redeemedList = await page.evaluate(async () => {
    window.IZZBAH.listCodes = () => Promise.resolve([{ code: "AB2D-EF4H", gamesAllowed: 7, premium: false, used: true, usedBy: "qka67ZMefQXfitti2BJ2SVVCKYU2", usedAt: 1750000000000 }]);
    document.getElementById("premRefresh").click();
    await new Promise(r => setTimeout(r, 200));
    return document.getElementById("premList").textContent;
  });
  check("a redeemed code shows the player's id in the admin list", /qka67ZMefQXfitti2BJ2SVVCKYU2/.test(redeemedList));

  // ---- Player side: redeem boxes on the game library + new-game screens ----
  const boxes = await page.evaluate(() => ({
    lib: !!document.getElementById("redeemInputLib") && !!document.getElementById("redeemBtnLib"),
    cats: !!document.getElementById("redeemInputCats") && !!document.getElementById("redeemBtnCats"),
  }));
  check("redeem boxes exist on the game library AND the new-game screens", boxes.lib && boxes.cats);

  const redeem = await page.evaluate(async () => {
    const calls = [];
    window.IZZBAH.redeemCode = (raw) => { calls.push(raw); return Promise.resolve({ gamesAllowed: 5, premium: false }); };
    document.getElementById("redeemInputLib").value = "ab2d ef4h";
    document.getElementById("redeemBtnLib").click();
    await new Promise(r => setTimeout(r, 200));
    return { calls, cleared: document.getElementById("redeemInputLib").value === "" };
  });
  check("redeeming from the library calls the bridge and clears the input",
    redeem.calls.length === 1 && redeem.calls[0] === "ab2d ef4h" && redeem.cleared);

  const badRedeem = await page.evaluate(async () => {
    window.IZZBAH.redeemCode = () => Promise.reject(new Error("used"));
    document.getElementById("redeemInputCats").value = "AB2D-EF4H";
    document.getElementById("redeemBtnCats").click();
    await new Promise(r => setTimeout(r, 250));
    const toast = document.querySelector(".toast, #toast");
    return { kept: document.getElementById("redeemInputCats").value !== "", toast: toast ? toast.textContent : "" };
  });
  check("an already-used code keeps the input (player can fix a typo)", badRedeem.kept);

  // "my account id" shows for a signed-in player so they can share it
  const uidShown = await page.evaluate(() => {
    const el = document.getElementById("myAccountId");
    return el && getComputedStyle(el).display !== "none" && /u1/.test(el.textContent);
  });
  check("signed-in player sees their account id to share with the admin", uidShown);

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
