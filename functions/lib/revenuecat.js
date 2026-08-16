// RevenueCat webhook: reading the notification, and deciding whether it grants.
//
// Kept away from the IO for the same reason as lib/grant.js — this is the code
// that decides whether somebody receives paid content, so it is pure and tested
// on its own.
//
// ⚠️ THE PAYLOAD SHAPE IS THE ONE THING NOT VERIFIED AGAINST A REAL REQUEST.
// RevenueCat's docs were unreachable from this environment, so the field names
// below come from their published description of the format: `api_version` at
// the root of the POST body with everything else inside `event`, the type
// `NON_RENEWING_PURCHASE` for consumables and non-subscriptions, and their
// instruction to look the customer up by BOTH `original_app_user_id` and the
// `aliases` array. Before going live, fire the dashboard's "send test webhook"
// once and compare — see PAYMENT_SETUP.md.
//
// The design assumes that check might not have happened yet, so every path
// FAILS CLOSED: an unrecognised shape, event type, product or user grants
// nothing at all. The worst outcome is then a purchase that does not deliver —
// visible, reversible, refundable — rather than games handed out for free.

// Store product id -> our pack id. Mirrors STORE_PRODUCTS in index.html; the
// pack itself (how many games, what it costs) is looked up in lib/packs.js,
// which stays the single source of truth. A product we do not recognise grants
// nothing rather than defaulting to the smallest pack.
const PRODUCT_PACKS = {
  "com.izzbah.game.games2": "g2",
  "com.izzbah.game.games5": "g5",
  "com.izzbah.game.games15": "g15",
};

// The events that mean "money changed hands for a consumable". Our packs are
// one-off purchases, so NON_RENEWING_PURCHASE is the one that matters;
// INITIAL_PURCHASE is accepted too in case a pack is ever modelled as a
// non-consumable. Everything else — cancellations, billing issues, transfers,
// and TEST — is acknowledged and ignored.
const GRANTING_TYPES = ["NON_RENEWING_PURCHASE", "INITIAL_PURCHASE"];

// Refunds and chargebacks. Not acted on automatically: our games are consumed,
// so clawing back a balance someone has already played is a judgement call, not
// arithmetic. They are recorded for the admin to see and decide.
const REVERSING_TYPES = ["CANCELLATION", "REFUND", "SUBSCRIPTION_PAUSED"];

/* Verify the request came from RevenueCat.
   Their mechanism is a fixed Authorization header value that YOU choose in the
   dashboard and they send back verbatim — not a computed signature, so there is
   nothing here to get subtly wrong. Compared in constant time anyway: a plain
   !== leaks the length and the common prefix through timing, and this header is
   the only thing standing between an open endpoint and free games. */
function rcAuthorised(sent, expected) {
  const a = String(sent || "");
  const b = String(expected || "");
  if (!b) return false;              // no secret configured = refuse everything
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* Pull the notification apart. Returns { ok: false, reason } for anything it
   does not fully understand — never a partially-filled result a caller might
   act on by accident. */
function parseRcEvent(body) {
  const ev = body && body.event;
  if (!ev || typeof ev !== "object") return { ok: false, reason: "no-event" };

  const type = String(ev.type || "");
  if (!type) return { ok: false, reason: "no-type" };

  // Idempotency key. RevenueCat retries until it gets a 2xx, so without this a
  // slow response or a transient error grants the same pack twice.
  const eventId = String(ev.id || "");
  if (!eventId) return { ok: false, reason: "no-event-id" };

  // Who. RevenueCat's own guidance is to search BOTH original_app_user_id and
  // the aliases array, because a customer can carry more than one id. We take
  // all of them, in order of preference, and the caller picks the one that is
  // really ours.
  const candidates = [];
  [ev.app_user_id, ev.original_app_user_id].forEach(v => {
    const s = String(v || "").trim();
    if (s && candidates.indexOf(s) === -1) candidates.push(s);
  });
  (Array.isArray(ev.aliases) ? ev.aliases : []).forEach(v => {
    const s = String(v || "").trim();
    if (s && candidates.indexOf(s) === -1) candidates.push(s);
  });

  // What. Only a product we sell.
  const productId = String(ev.product_id || "");
  const packId = PRODUCT_PACKS[productId] || "";

  // Sandbox purchases are free to make — anyone can create an Apple sandbox
  // account. Flagged here; the caller refuses to grant on them except for staff,
  // so testing works without opening a hole that mints unlimited games.
  const sandbox = String(ev.environment || "").toUpperCase() === "SANDBOX";

  return {
    ok: true, type, eventId, candidates, productId, packId, sandbox,
    grants: GRANTING_TYPES.indexOf(type) !== -1,
    reverses: REVERSING_TYPES.indexOf(type) !== -1,
  };
}

/* The whole decision, in one place, so the handler has no judgement of its own.
   `isStaff` says whether the resolved uid is an admin or editor — the only
   accounts allowed to receive a sandbox grant. */
function rcDecision(parsed, uid, isStaff) {
  if (!parsed || !parsed.ok) return { grant: false, reason: "unparsed" };
  if (!parsed.grants) return { grant: false, reason: parsed.reverses ? "reversal" : "ignored-type" };
  if (!uid) return { grant: false, reason: "unknown-user" };
  if (!parsed.packId) return { grant: false, reason: "unknown-product" };
  if (parsed.sandbox && !isStaff) return { grant: false, reason: "sandbox" };
  return { grant: true, packId: parsed.packId, sandbox: !!parsed.sandbox };
}

module.exports = {
  PRODUCT_PACKS, GRANTING_TYPES, REVERSING_TYPES,
  rcAuthorised, parseRcEvent, rcDecision,
};
