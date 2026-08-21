// Installs window.IZZBAH_STORE — the native half of the game's purchase seam.
//
// The game never talks to a store SDK. It calls exactly three things, and owns
// every decision around them:
//     IZZBAH_STORE.identify(uid)     -> Promise   (uid "" means sign out)
//     IZZBAH_STORE.purchase(id)      -> Promise   (rejects on cancel)
//     IZZBAH_STORE.priceOf(id)       -> string    (localized, "" if unknown)
//
// ⚠️ NOTHING IS GRANTED HERE, and nothing may ever be. A completed purchase is
//    confirmed by the store to RevenueCat, whose webhook writes
//    `entitlements/{uid}` with the Admin SDK; the game's existing onSnapshot
//    then unlocks the games on screen. A client that credited itself would be a
//    client that can credit itself for free — so this file deliberately has no
//    access to anything that could.
//
// ⚠️ IDENTIFY IS THE WHOLE BALLGAME. RevenueCat grants against `app_user_id`,
//    and `functions/lib/revenuecat.js` reads that as a Firebase uid. If a
//    purchase completes while the SDK still holds one of its own anonymous ids,
//    the webhook cannot match an account and the player has paid Apple for
//    nothing — with no error anywhere, because the payment itself succeeded.
//    The game calls identify() on every auth change and again immediately
//    before opening the sheet, and `configure()` below deliberately does NOT
//    pass an appUserID so the SDK starts anonymous and is only ever named by us.
//
// ⚠️ A CANCEL MUST REJECT WITH SOMETHING MATCHING /cancel/i. The game treats
//    that as "the player closed the sheet on purpose" and shows nothing; any
//    other rejection becomes «لم تتم عملية الشراء». Swallowing a cancel into a
//    resolve would tell a player who backed out that they had bought something.
//
// WIRING (once `cap add ios` / `cap add android` have been run):
//   1. npm install                         (in mobile/)
//   2. RevenueCat dashboard: create the app, add the three products from
//      App Store Connect / Play Console with the SAME ids as STORE_PRODUCTS in
//      index.html and PRODUCT_PACKS in functions/lib/revenuecat.js.
//   3. Set RC_API_KEY below per platform (public SDK keys — these are meant to
//      ship in the client; the SECRET key never leaves the server).
//   4. Point the RevenueCat webhook at the deployed `revenuecatWebhook` URL and
//      set its Authorization header to the value the function checks.
//   5. Include this file from the app bundle so IZZBAH_STORE exists before the
//      packs box can be opened.
//
// ⚠️ Until step 2 exists there are no products, so priceOf() returns "" and the
//    packs render with NO price — which is correct and deliberate: Apple bills
//    in its own tiers per storefront, so showing the hardcoded ٠٫٩٠٠ ر.ع would
//    display one number and charge another.
import { Purchases, LOG_LEVEL } from "@revenuecat/purchases-capacitor";
import { Capacitor } from "@capacitor/core";

const RC_API_KEY = {
  ios: "",      // appl_xxxxxxxx
  android: "",  // goog_xxxxxxxx
};

let ready = null;
let priceCache = new Map();

async function configure() {
  if (ready) return ready;
  const key = RC_API_KEY[Capacitor.getPlatform()] || "";
  if (!key) throw Object.assign(new Error("no RevenueCat key for this platform"),
                                { code: "izzbah/no-store-key" });
  ready = (async () => {
    await Purchases.setLogLevel({ level: LOG_LEVEL.WARN });
    // No appUserID: start anonymous, and let identify() name us. See the note
    // above — this is what keeps the uid the game's decision, not the SDK's.
    await Purchases.configure({ apiKey: key });
    await refreshPrices();
  })();
  return ready;
}

// Localized price strings, keyed by product id. Fetched once; cheap to redo if
// the fetch failed, which is why a failure clears rather than caches "".
async function refreshPrices() {
  try {
    const offerings = await Purchases.getOfferings();
    const all = (offerings && offerings.all) || {};
    const seen = new Map();
    for (const key of Object.keys(all)) {
      for (const pkg of (all[key].availablePackages || [])) {
        const p = pkg.product || {};
        if (p.identifier) seen.set(p.identifier, p.priceString || "");
      }
    }
    if (seen.size) priceCache = seen;
  } catch (e) {
    console.warn("store: could not read prices", e);
  }
}

window.IZZBAH_STORE = {
  async identify(uid) {
    await configure();
    // "" means the player signed out. logOut() drops back to a fresh anonymous
    // id, so the next person on a shared phone cannot buy into this account.
    if (!uid) { try { await Purchases.logOut(); } catch (e) {} return; }
    await Purchases.logIn({ appUserID: String(uid) });
  },

  async purchase(productId) {
    await configure();
    const { products } = await Purchases.getProducts({ productIdentifiers: [productId] });
    const product = (products || [])[0];
    if (!product) throw Object.assign(new Error("unknown product " + productId),
                                      { code: "izzbah/unknown-product" });
    // ⚠️ Let a cancel propagate. RevenueCat raises `userCancelled`, which the
    // game's /cancel/i test recognises and shows nothing for.
    await Purchases.purchaseStoreProduct({ product });
    // Deliberately returns nothing. The games arrive from the webhook.
  },

  priceOf(productId) {
    return priceCache.get(productId) || "";
  },
};
