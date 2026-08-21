// WHO SELLS WHAT, WHERE — the store build sells; the website does not.
//
// Two owner decisions meet in this file, and they pull in opposite directions,
// which is exactly why both surfaces are checked in one place:
//
//   • THE STORE BUILD SELLS (2026-08-16). Ship on the App Store, take Apple's
//     cut, payment happens in the app. So the packs must be BUYABLE — an app
//     showing a paywall with no way through it is its own rejection — and no
//     OTHER route to paying may appear: no activation-code box and no
//     buy-by-email line, that being the anti-steering rule, Play as much as
//     Apple.
//   • THE WEBSITE DOES NOT SELL (2026-08-20). *"you cant buy from the site"* —
//     izzbah.com tells people about the game; buying happens in the app. So the
//     packs, their prices and the buy-by-email line are all gone here, while the
//     activation-code box STAYS, because that is how the owner gifts games and
//     fixes a bad order.
//
// ⚠️ The inversion is the point and is easy to "tidy" into a bug: the redeem box
// is hidden in the STORE build and kept on the WEB; the packs are shown in the
// STORE build and hidden on the WEB. Anything that makes these two agree has
// broken one of them.
//
// Every check runs twice: once as a normal browser and once with ?store=1.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8524;
const checks = [];
const check = (n, ok, extra) => {
  checks.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`);
};

/* Real UA strings for the two shapes a Capacitor build takes. */
const UAS_WK = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const UAS_WV = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.0.0 Mobile Safari/537.36";

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 420, height: 880 } });
  await page.route("**/firebasejs/**", route => route.abort());
  page.on("pageerror", e => errs.push(e.message));
  await page.addInitScript(() => {
    try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {}
    /* ⚠️ Record the REGISTRATION CALL, not its effects.
       `navigator.serviceWorker.controller` is null on a first load even when
       registration succeeded — asserting on it would report "not registered"
       for BOTH builds and the store-side check would pass vacuously. */
    try {
      const real = navigator.serviceWorker.register.bind(navigator.serviceWorker);
      navigator.serviceWorker.register = (...a) => { window.__swAsked = true; return real(...a); };
    } catch (e) {}
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html${query}`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.IZZBAH.applyAuth(true, "buyer-1"));
  return page;
}

// Read the packs box in whichever build we are in.
const survey = (page) => page.evaluate(() => {
  openPlans();
  const modal = document.getElementById("plansModal");
  const vis = (el) => !!el && el.getBoundingClientRect().height > 0
    && getComputedStyle(el).display !== "none" && !el.hidden;
  return {
    storeBuild: window.IZZBAH_TEST.isStoreBuild(),
    plansOpen: modal.classList.contains("open"),
    packs: document.querySelectorAll("#plansGrid .plan-card").length,
    cta: (document.querySelector("#plansGrid .plan-cta") || {}).textContent || "",
    prices: [...document.querySelectorAll("#plansGrid .plan-price")].map(e => e.textContent),
    redeemBox: vis(document.querySelector(".plans-redeem")),
    mailto: vis(document.querySelector(".plans-contact")),
    appNote: vis(document.getElementById("plansAppNote")),
    appNoteText: (document.getElementById("plansAppNote") || {}).textContent || "",
    sub: vis(document.getElementById("plansSub")),
    sellingOff: window.IZZBAH_TEST.webSellingOff(),
    fineprint: vis(document.querySelector(".plans-fineprint")),
    fineText: (document.querySelector(".plans-fineprint") || {}).textContent || "",
    termsLink: !!document.querySelector(".plans-fineprint .wlc-legal-link"),
    buyRow: vis(document.getElementById("settingsBuy")),
    installRow: vis(document.getElementById("settingsInstall")),
    swAsked: window.__swAsked === true,
  };
});

try {
  // ---- the WEBSITE, unchanged ---------------------------------------------
  const web = await open("");
  const w = await survey(web);
  check("web: this is not a store build", w.storeBuild === false);
  check("web: selling is off here", w.sellingOff === true);
  // The box still OPENS — it is where the balance and the code field live.
  check("web: the games box still opens", w.plansOpen);
  /* ⚠️ ZERO cards, not hidden cards. renderPlans() returns before building any,
     so there is no click handler to resurrect. Asserting only that they are
     invisible would pass against a CSS-only fix that one regression undoes. */
  check("web: NO packs are built at all", w.packs === 0, `${w.packs} packs`);
  check("web: ...and therefore no prices", w.prices.length === 0, w.prices.join(" / "));
  check("web: no «choose your pack» lead-in", !w.sub);
  check("web: NO buy-by-email line", !w.mailto);
  // The one thing that must SURVIVE: gifting and fixing runs through codes.
  check("web: the activation-code box is still there", w.redeemBox);
  check("web: one line points at the app instead", w.appNote && w.appNote !== "",
    w.appNoteText.slice(0, 40));
  /* ⚠️ It must name no store and carry no link while neither listing exists —
     a button to nowhere is worse than a sentence. */
  check("web: ...and it does not link to a store that does not exist yet",
    !/https?:\/\//.test(w.appNoteText));
  check("web: the fineprint no longer promises prices",
    !/ر\.ع/.test(w.fineText) && w.termsLink, w.fineText.slice(0, 60));
  check("web: the games box is still reachable from settings", w.buyRow);
  check("web: «أضف اللعبة إلى شاشتك» is offered — this IS the PWA", w.installRow);
  check("web: the service worker IS registered", w.swAsked);
  // The web refund policy is OURS — codes, our inbox — and must be untouched.
  const webRefund = await web.evaluate(async () => {
    openLegal("terms", "review");
    await new Promise(r => setTimeout(r, 250));
    const vis = (el) => !!el && getComputedStyle(el).display !== "none";
    return { web: vis(document.querySelector(".legal-web-only")),
             store: vis(document.querySelector(".legal-store-only")),
             apple: vis(document.querySelector("p.legal-store-extra")),
             appleHead: vis(document.querySelector("h5.legal-store-extra")) };
  });
  check("web: the activation-code refund policy is the one shown", webRefund.web && !webRefund.store);
  /* ⚠️ Apple's EULA terms are for the app, and in a browser they are plainly
     false — there is no Apple here. The HEADING is checked too: hiding the
     paragraph but leaving its <h5> gives a section title with nothing under
     it, which is the shape this most easily regresses into. */
  check("web: Apple's App Store terms are NOT shown", !webRefund.apple && !webRefund.appleHead);
  /* ⚠️ The choke-point guard, tested through the REAL entry point. renderPlans()
     drawing nothing is the first defence; this is the one that survives a caller
     which forgets. If the guard were removed this places a live order. */
  const inert = await web.evaluate(async () => {
    let ordered = false;
    window.IZZBAH = window.IZZBAH || {};
    window.IZZBAH.placeOrder = () => { ordered = true; return Promise.resolve(); };
    window.IZZBAH_TEST.purchasePack({ id: "g5", name: "باقة ٥ ألعاب", games: 5 });
    await new Promise(r => setTimeout(r, 250));
    return ordered;
  });
  check("web: purchasePack() places no order even if something calls it", inert === false);
  await web.close();

  // ---- the STORE build ------------------------------------------------------
  const app = await open("?store=1");
  const s = await survey(app);
  check("store: the override puts us in a store build", s.storeBuild === true);

  // The rule the earlier plan got wrong: the packs must still be sellable.
  check("store: the packs box still OPENS — a dead paywall is a rejection", s.plansOpen);
  check("store: all three packs are offered", s.packs === 3, `${s.packs} packs`);
  check("store: «اشترِ الألعاب» still reaches it from settings", s.buyRow);
  check("store: the wording is BUY, not «place an order»",
    /اشتر/.test(s.cta) && !/اطلب/.test(s.cta), s.cta);

  // The rules Apple and Google both enforce.
  check("store: NO activation-code box", !s.redeemBox);
  check("store: NO buy-by-email line (anti-steering)", !s.mailto);
  /* ⚠️ The web's «buy it in the app» line must NOT appear inside the app — it
     would be telling a player standing in the store to go to the store. */
  check("store: the web's «buy in the app» line is absent", !s.appNote);
  check("store: selling is NOT off here", s.sellingOff === false);
  /* ⚠️ installAppFlow() falls back to iOS-Safari «add to home screen» steps when
     no beforeinstallprompt has fired — precisely a native webview's state — so
     this row would tell an App Store customer to go and install the website. */
  check("store: NO «add to home screen» row", !s.installRow);
  /* sw.js is not in the Capacitor bundle at all (copy-web.js ships index.html
     and assets/ only), so registering it 404s on every launch — and a worker
     buys nothing when every asset is already local. */
  check("store: the service worker is NOT registered", !s.swAsked);

  // Terms have to stay reachable from the point of purchase — but the web
  // wording is about activation codes, which do not exist in this build.
  check("store: the terms link survives", s.fineprint && s.termsLink);
  check("store: ...and the fineprint no longer talks about codes",
    !/الأكواد/.test(s.fineText), s.fineText.slice(0, 70));

  // ⚠️ Apple bills in its own tiers, per storefront, in the viewer's currency.
  // Printing the hardcoded ٠٫٩٠٠ ر.ع would show one number and charge another,
  // so with no store bridge attached there must be NO price at all.
  check("store: no hardcoded price is shown when the store has not answered",
    s.prices.length === 0, s.prices.join(" / "));

  // ---- product ids ----------------------------------------------------------
  const ids = await app.evaluate(() => {
    const T = window.IZZBAH_TEST;
    return { map: T.STORE_PRODUCTS(), g5: T.productIdFor("g5"), junk: T.productIdFor("nope") };
  });
  check("every pack maps to a product id", Object.keys(ids.map).sort().join(",") === "g15,g2,g5",
    Object.keys(ids.map).join(","));
  check("the ids are reverse-DNS, as the stores require",
    Object.values(ids.map).every(v => /^com\.izzbah\.game\.[a-z0-9]+$/.test(v)));
  check("...and distinct (two packs sharing one id would sell the wrong size)",
    new Set(Object.values(ids.map)).size === 3);
  check("an unknown pack maps to nothing, never a default", ids.junk === "");

  // ⚠️ The SERVER is what actually grants games — RevenueCat's webhook looks the
  // pack up in functions/lib/packs.js. A product id here whose pack key does not
  // exist there is a payment that takes money and delivers nothing, and neither
  // side would notice on its own. This is the only place the two are compared.
  const { PACKS } = require("../functions/lib/packs.js");
  const serverPacks = Object.keys(PACKS).sort().join(",");
  check(`client product ids cover exactly the server's packs (${serverPacks})`,
    Object.keys(ids.map).sort().join(",") === serverPacks,
    Object.keys(ids.map).sort().join(","));

  // ---- signed OUT: the store sheet must never open --------------------------
  // ⚠️ The findings audit turned this up, and it is the worst kind of bug: the
  // player pays and receives nothing. Games are granted by the webhook against
  // app_user_id, which is the Firebase uid. Buy while signed out and RevenueCat
  // reports one of its OWN anonymous ids, the webhook cannot match it to any
  // account, and the money is gone with no delivery and no error anywhere.
  const signedOut = await app.evaluate(async () => {
    window.IZZBAH_STORE = { purchase: () => { window.__bought = true; return Promise.resolve({}); }, priceOf: () => "" };
    window.__bought = false;
    window.IZZBAH.applyAuth(false);
    document.getElementById("notePop").classList.remove("open");
    await window.IZZBAH_TEST.purchasePack({ id: "g5", name: "باقة ٥ ألعاب", games: 5 });
    await new Promise(r => setTimeout(r, 250));
    return {
      bought: window.__bought,
      note: document.getElementById("notePop").classList.contains("open"),
      msg: (document.getElementById("notePopMsg") || {}).textContent || "",
    };
  });
  check("store: a signed-OUT tap never reaches the store", !signedOut.bought);
  check("...it asks them to sign in first", signedOut.note && /سجّل الدخول/.test(signedOut.msg),
    signedOut.msg.slice(0, 50));
  await app.evaluate(() => { window.IZZBAH.applyAuth(true, "buyer-1"); document.getElementById("notePop").classList.remove("open"); });

  // ---- the refund text a reviewer will actually read ------------------------
  // The terms link sits beside the buy button on purpose, so this paragraph is
  // in front of App Review. Ours talks about activation codes and emailing us
  // for refunds — wrong in a store build, and steering money off-store.
  const refund = await app.evaluate(async () => {
    openLegal("terms", "review");
    await new Promise(r => setTimeout(r, 250));
    const vis = (el) => !!el && getComputedStyle(el).display !== "none";
    return {
      web: vis(document.querySelector(".legal-web-only")),
      store: vis(document.querySelector(".legal-store-only")),
      text: (document.querySelector(".legal-store-only") || {}).textContent || "",
      apple: vis(document.querySelector("p.legal-store-extra")),
      appleHead: vis(document.querySelector("h5.legal-store-extra")),
      appleText: (document.querySelector("p.legal-store-extra") || {}).textContent || "",
    };
  });
  check("store: the activation-code refund paragraph is gone", !refund.web);
  check("...replaced by one that names the STORE as the payer", refund.store);
  check("...sending refunds to the store, not to our inbox",
    /استرداد/.test(refund.text) && /المتجر/.test(refund.text));
  /* ⚠️ Apple's MINIMUM EULA terms, item by item. An app that links its own EULA
     must carry all of them, and a reviewer checks — so "the block is present"
     is not the assertion; each clause is. Trimming one while editing the
     paragraph is exactly how this breaks, and it breaks silently. */
  check("store: Apple's App Store terms are shown, heading and all",
    refund.apple && refund.appleHead);
  for (const [name, needle] of [
    ["Apple is not a party", "ليست شركة Apple طرفاً"],
    ["licence scope / Usage Rules", "قواعد الاستخدام"],
    ["we provide support, not Apple", "مسؤولون عن الدعم والصيانة"],
    ["Apple's only warranty duty is the refund", "لتردّ لك ثمن الشراء"],
    ["we answer product claims", "حماية المستهلك"],
    ["we answer IP claims", "انتهاك حقوق ملكية فكرية"],
    ["the US export representation", "قائمة أطراف محظورة"],
    ["Apple is a third-party beneficiary", "مستفيداً من الغير"],
  ]) check(`store: EULA carries — ${name}`, refund.appleText.includes(needle));

  check("...and not claiming we can refund a card we never see",
    !/سنُصحّح|ردّ المبلغ/.test(refund.text));
  await app.evaluate(() => closeLegal());

  // ---- the bridge is missing, which is today's reality ----------------------
  // Tapping buy in a build whose store bridge never loaded must SAY so. Silence
  // is the worst outcome: the player taps, nothing happens, and assumes they
  // have been charged.
  const tapped = await app.evaluate(async () => {
    document.querySelector("#plansGrid .plan-card").click();
    await new Promise(r => setTimeout(r, 300));
    const note = document.getElementById("notePop");
    return { open: note.classList.contains("open"), msg: (document.getElementById("notePopMsg") || {}).textContent || "" };
  });
  check("store: buying with no bridge says so rather than doing nothing", tapped.open, tapped.msg.slice(0, 50));

  // ---- and it never grants anything itself ---------------------------------
  // The entitlement arrives via RevenueCat's webhook and the Admin SDK. A client
  // that credits itself on a "successful" purchase is a client that can credit
  // itself for free, so a stubbed success must move no balance.
  const granted = await app.evaluate(async () => {
    window.IZZBAH_STORE = { purchase: () => Promise.resolve({ ok: true }), priceOf: () => "" };
    const before = JSON.stringify([state.codeGamesAllowed || 0, state.gamesUsed || 0,
      localStorage.getItem("izzbah-code-balance-v1")]);
    await window.IZZBAH_TEST.purchasePack({ id: "g15", name: "باقة ١٥ لعبة", games: 15 });
    await new Promise(r => setTimeout(r, 250));
    const after = JSON.stringify([state.codeGamesAllowed || 0, state.gamesUsed || 0,
      localStorage.getItem("izzbah-code-balance-v1")]);
    return { same: before === after, before, after };
  });
  check("store: a successful purchase grants NOTHING client-side", granted.same,
    granted.same ? "" : `${granted.before} -> ${granted.after}`);

  // A cancelled purchase is not a failure; Apple's sheet closing is a normal
  // thing a person does and must not raise an error popup.
  const cancelled = await app.evaluate(async () => {
    document.getElementById("notePop").classList.remove("open");
    window.IZZBAH_STORE = { purchase: () => Promise.reject({ code: "purchaseCancelledError" }), priceOf: () => "" };
    await window.IZZBAH_TEST.purchasePack({ id: "g2", name: "باقة لعبتين", games: 2 });
    await new Promise(r => setTimeout(r, 250));
    return document.getElementById("notePop").classList.contains("open");
  });
  check("store: cancelling shows no error", !cancelled);

  // ---- the store's price wins ----------------------------------------------
  const priced = await app.evaluate(async () => {
    window.IZZBAH_STORE = { purchase: () => Promise.resolve({}), priceOf: (id) => id.endsWith("games5") ? "OMR 1.49" : "OMR 0.99" };
    renderPlans();
    await new Promise(r => setTimeout(r, 120));
    return [...document.querySelectorAll("#plansGrid .plan-price")].map(e => e.textContent);
  });
  check("store: prices come from the STORE, not the hardcoded table",
    priced.length === 3 && priced.some(p => /OMR 1\.49/.test(p)) && !priced.some(p => /ر\.ع/.test(p)),
    priced.join(" / "));

  await app.close();

  /* ── the native sign-in seam ─────────────────────────────────────────────
     A REAL native sign-in cannot be exercised here — it needs the Capacitor
     project, the plugin and a device — so this pins the parts that live in the
     game and would otherwise break silently in the wrapper.
     ⚠️ The first one is the bug that would have hurt most. Every in-app-browser
     heuristic in isInAppBrowser() fires on a Capacitor build: iOS is a WKWebView
     with no "Safari" token, Android's WebView marks itself "; wv)". Unguarded, a
     player tapping sign-in inside the App Store app is shown «افتح اللعبة في
     المتصفح» and sent to Safari — a dead end, and a paying customer pointed at
     the website. */
  for (const [label, ua, store, want] of [
    ["iOS WKWebView, store build", UAS_WK, true, false],
    ["iOS WKWebView, plain web", UAS_WK, false, true],
    ["Android wv, store build", UAS_WV, true, false],
    ["Android wv, plain web", UAS_WV, false, true],
  ]) {
    const c = await browser.newContext({ userAgent: ua, viewport: { width: 390, height: 844 } });
    const pg = await c.newPage();
    await pg.route("**/firebasejs/**", r => r.abort());
    await pg.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
    await pg.goto(`http://127.0.0.1:${PORT}/index.html${store ? "?store=1" : ""}`,
                  { waitUntil: "load", timeout: 30000 });
    await pg.waitForTimeout(900);
    const got = await pg.evaluate(() => window.IZZBAH_TEST.isInAppBrowser());
    check(`in-app-browser help — ${label}: ${want ? "shown" : "NOT shown"}`, got === want);
    await c.close();
  }

  /* The bridge contract. A store build with no native side attached must fail
     with a code of OURS, thrown before anything Firebase-shaped is touched —
     an OAuth error would describe a flow the app never entered. */
  const bridge = await open("?store=1");
  const noBridge = await bridge.evaluate(async () => {
    try { await window.IZZBAH_TEST.nativeAuthToken("google.com"); return "resolved"; }
    catch (e) { return (e && e.code) || "no-code"; }
  });
  check("store: no bridge attached fails with our own code, not an OAuth one",
    noBridge === "izzbah/no-auth-bridge", noBridge);
  const withBridge = await bridge.evaluate(async () => {
    let asked = null;
    window.IZZBAH_AUTH = { signIn: (id) => { asked = id; return Promise.resolve({ idToken: "tok-1" }); } };
    const out = await window.IZZBAH_TEST.nativeAuthToken("google.com");
    return { asked, idToken: out.idToken, seen: window.IZZBAH_TEST.nativeAuthBridge() };
  });
  check("store: an attached bridge is used, and asked for the right provider",
    withBridge.asked === "google.com" && withBridge.idToken === "tok-1" && withBridge.seen === true,
    JSON.stringify(withBridge));
  /* ⚠️ A bridge that returns nothing usable must be an ERROR, not a credential
     built from nulls — signInWithCredential would reject with an opaque OAuth
     message and the real fault (a broken native side) would never surface. */
  const emptyTok = await bridge.evaluate(async () => {
    window.IZZBAH_AUTH = { signIn: () => Promise.resolve({}) };
    try { await window.IZZBAH_TEST.nativeAuthToken("google.com"); return "resolved"; }
    catch (e) { return (e && e.code) || "no-code"; }
  });
  check("store: a bridge that returns no token is an error, not a null credential",
    emptyTok === "izzbah/no-id-token", emptyTok);
  await bridge.close();

  check("no uncaught JS errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 4));
} catch (e) {
  check("harness completed", false);
  console.log("  harness error:", e.message);
} finally {
  await browser.close();
  server.kill();
}
const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
