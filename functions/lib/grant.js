// Pure fulfilment logic — no Firebase, no network, so it is unit-testable and
// so the rules that decide whether someone gets paid content can be reasoned
// about on their own.
//
// Two things here are the whole safety story:
//   1. IDEMPOTENCY. Payment providers retry webhooks — on timeout, on a 500, or
//      just because. A webhook that grants on every delivery hands out the pack
//      two or three times. Grant decisions are therefore keyed off the stored
//      purchase's own status, never off the fact that a callback arrived.
//   2. ACCUMULATION. A games pack ADDS to the balance; it never overwrites it.
//      Setting gamesAllowed = pack.games would erase whatever the player had
//      already bought or been granted by an admin.

// Terminal states — a purchase in one of these must never grant again.
const GRANTED = "granted";
const FAILED = "failed";
const PENDING = "pending";

// Should this callback actually grant? Returns a reason when it should not, so
// the caller can log WHY a webhook was ignored instead of failing silently.
function grantDecision(purchase, paid) {
  if (!purchase) return { grant: false, reason: "unknown-purchase" };
  if (purchase.status === GRANTED) return { grant: false, reason: "already-granted" };
  if (!paid) return { grant: false, reason: "not-paid" };
  if (purchase.status === FAILED) return { grant: false, reason: "purchase-failed" };
  if (purchase.status !== PENDING) return { grant: false, reason: "bad-status:" + purchase.status };
  if (!purchase.uid) return { grant: false, reason: "no-uid" };
  return { grant: true, reason: "ok" };
}

// What entitlements/{uid} becomes after this pack. `current` is the existing
// doc (or {}), `pack` comes from the server table — never from the request.
// Returns only the fields to merge, so unrelated fields (e.g. an admin-set
// expiresAt) survive untouched.
function entitlementUpdate(current, pack) {
  const now = current || {};
  const out = {};
  const add = Number(pack && pack.games) || 0;
  if (add > 0) {
    const have = Number(now.gamesAllowed) || 0;
    out.gamesAllowed = have + add; // ADD — never replace
  }
  // Premium is one-way here: a pack can turn it on, but a non-premium pack must
  // never switch off premium the player already has.
  if (pack && pack.premium) out.premium = true;
  return out;
}

module.exports = { grantDecision, entitlementUpdate, GRANTED, FAILED, PENDING };
