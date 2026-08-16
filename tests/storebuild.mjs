// The app-store build: packs are SOLD, but only through the store.
//
// The owner's decision (2026-08-16) is to ship on the App Store and take
// Apple's cut, with payment happening in the app. Two rules follow, and this
// file pins both:
//
//   • the packs must be BUYABLE — an app that shows a paywall with no way
//     through it is its own rejection, which is why the earlier «sell nothing»
//     shape had to go;
//   • no OTHER route to paying may appear — no activation-code box, and no
//     buy-by-email line. Pointing at an outside purchase mechanism is the
//     anti-steering rule, and it applies to Google Play as much as to Apple.
//
// The website must be completely unaffected, so every check runs twice: once as
// a normal browser and once with ?store=1.
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

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 420, height: 880 } });
  await page.route("**/firebasejs/**", route => route.abort());
  page.on("pageerror", e => errs.push(e.message));
  await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
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
    fineprint: vis(document.querySelector(".plans-fineprint")),
    fineText: (document.querySelector(".plans-fineprint") || {}).textContent || "",
    termsLink: !!document.querySelector(".plans-fineprint .wlc-legal-link"),
    buyRow: vis(document.getElementById("settingsBuy")),
  };
});

try {
  // ---- the WEBSITE, unchanged ---------------------------------------------
  const web = await open("");
  const w = await survey(web);
  check("web: this is not a store build", w.storeBuild === false);
  check("web: the packs box opens", w.plansOpen && w.packs === 3, `${w.packs} packs`);
  check("web: the manual wording is untouched", /اطلب/.test(w.cta), w.cta);
  check("web: prices are the hardcoded OMR ones", w.prices.length === 3 && /ر\.ع/.test(w.prices[0]), w.prices.join(" / "));
  check("web: the activation-code box is still there", w.redeemBox);
  check("web: the buy-by-email line is still there", w.mailto);
  check("web: «اشترِ الألعاب» stays in settings", w.buyRow);
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
