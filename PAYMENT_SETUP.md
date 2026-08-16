# Automatic purchases (Thawani) — what's built and what's left

Goal: a player pays and **the games land in their account instantly** — no
activation code, no email. Codes stay an admin-only tool for gifts and fixes.

## Why this is safe by construction

`firestore.rules` already forbids every user from writing their own
entitlement:

```
match /entitlements/{uid} {
  allow read:  if isSignedIn() && (request.auth.uid == uid || isAdmin());
  allow write: if isAdmin();      // a player can NEVER grant themselves
}
```

Cloud Functions use the Admin SDK, which **bypasses rules entirely**, so the
webhook is the only path by which paid content reaches an account. No rules
change was needed. `purchases/*` is covered by the deny-all catch-all at the
end of the rules, so no client can read or forge one.

## Built and tested (provider-agnostic)

| Piece | Where |
|---|---|
| Authoritative pack table (games, price) | `functions/lib/packs.js` |
| Grant + idempotency logic (pure) | `functions/lib/grant.js` |
| `createCheckout` callable | `functions/index.js` |
| `paymentWebhook` HTTP endpoint | `functions/index.js` |
| 26 unit tests, in CI | `functions/test/fulfilment.test.mjs` |

Properties the tests pin down:

- **A repeated webhook never grants twice.** Providers retry on timeouts; the
  decision is keyed off the stored purchase status inside a transaction.
- **A pack ADDS to the balance**, never overwrites it — buying 5 on top of 3
  gives 8, and a games pack never switches off premium the player already has.
- **The client cannot say what it bought.** It sends only a pack id; games,
  premium and amount are resolved server-side.
- **Client and server prices can't drift** — a test compares `PLAY_PLANS` in
  `index.html` (the game) against the server table and fails on any mismatch.
- **Money converts by rounding**, so 3.5 OMR is 3500 baisa, not 3499.

## Still to do — needs the merchant account

1. **Replace `verifyProviderCallback()`** in `functions/index.js` with
   Thawani's documented signature check over the raw body. It currently accepts
   a shared-secret header, which is fine for a sandbox and **not fine for
   production** — an unverified endpoint that grants paid content is an endpoint
   anyone can call to give themselves unlimited games. This is the one piece
   deliberately left stubbed rather than guessed at.
2. **Return a real `checkoutUrl`** from `createCheckout` (create the Thawani
   session there, passing the purchase id as the client reference — that is what
   lets the webhook know whose account to credit).
3. **Wire the client**: swap `orderPlan()` to call `createCheckout`, redirect to
   the returned URL, and show a pending state. The live unlock already works —
   the game listens to `entitlements/{uid}` via `onSnapshot`.
4. **Set the secret** and deploy:
   ```bash
   firebase functions:secrets:set PAYMENT_WEBHOOK_SECRET
   firebase deploy --only functions
   ```
5. **Register the webhook URL** with Thawani:
   `https://us-central1-izzbahgame.cloudfunctions.net/paymentWebhook`
6. **Test the failure paths before going live**: double delivery, failed
   payment, abandoned checkout, and a refund.

## Note on reading purchases from the client

If a "payment pending / failed" screen is added later, `purchases/{id}` will
need a read rule (owner-only, never writable). Until then it stays server-only.

---

## App Store / Play: RevenueCat (build .329)

The web flow above (Thawani) is unchanged and still frozen. This section is the
NATIVE path, which is a separate channel end to end: the store takes the money,
RevenueCat tells us, and `revenuecatWebhook` grants the games.

### Wiring it up

1. **Create the products in App Store Connect** as **consumables**, with these
   exact ids — they are hardcoded in two places that a test compares
   (`STORE_PRODUCTS` in `index.html`, `PRODUCT_PACKS` in
   `functions/lib/revenuecat.js`):

   | pack | product id | games |
   |---|---|---|
   | `g2`  | `com.izzbah.game.games2`  | 2 |
   | `g5`  | `com.izzbah.game.games5`  | 5 |
   | `g15` | `com.izzbah.game.games15` | 15 |

   ⚠️ Products cannot be created — or tested — until the **Paid Applications
   agreement** shows Active. Sandbox purchases fail with unhelpful errors
   before that.

2. **Pick the shared header value** (any long random string) and set it in both
   places, identically:

   ```
   firebase functions:secrets:set REVENUECAT_WEBHOOK_SECRET
   ```
   RevenueCat dashboard → Integrations → Webhooks → *Authorization header*.

   ⚠️ With no secret configured the endpoint refuses **everything** — it never
   falls open. That is deliberate; a missing secret must not mean "allow all".

3. **Deploy:** `firebase deploy --only functions:revenuecatWebhook --project izzbahgame`,
   then paste the function URL into the RevenueCat webhook config.

4. ⚠️ **`app_user_id` MUST be the Firebase uid.** The app has to call
   RevenueCat's `logIn(uid)` right after sign-in. With RevenueCat's own
   anonymous ids the webhook cannot tell whose account to credit and every
   purchase lands in the `unknown-user` branch — money taken, nothing
   delivered. This is the single most likely way to get the integration wrong.

### Confirm the payload before going live

⚠️ **The one piece not verified against a real request.** RevenueCat's docs were
unreachable from the build environment, so the field names in
`functions/lib/revenuecat.js` (`event.id`, `event.type`, `event.app_user_id`,
`event.original_app_user_id`, `event.aliases`, `event.product_id`,
`event.environment`) come from their published description of the format rather
than from a captured request.

Everything fails **closed**, so a wrong guess means a purchase that does not
deliver — visible and refundable — never a free grant. Still: press **"Send test
webhook"** in the RevenueCat dashboard once, read the function log, and compare.
`parseRcEvent()` is the only place to correct.

### What the webhook does and does not do

- Grants on `NON_RENEWING_PURCHASE` and `INITIAL_PURCHASE`. Every other event
  type is acknowledged and ignored.
- **De-duplicates on `event.id`**, in the same transaction as the grant.
  RevenueCat retries until it gets a 2xx, so a response lost on the wire is
  normal — without this it would credit the same pack twice.
- Returns **200 even when it grants nothing**. A refused event is handled;
  retrying will not change the answer. Only a real failure (Firestore down)
  returns 500, because that one might succeed next time.
- **Sandbox purchases grant only to staff** (`admins/{uid}` or `editors/{uid}`).
  Anyone can create an Apple sandbox account, so a sandbox grant open to the
  public is unlimited free games. Test with the owner's own account.
- **Refunds and chargebacks are recorded, not acted on.** Our games are
  consumed; clawing back a balance someone has already played is a judgement
  call, not arithmetic. They land in `rcEvents` for the admin to see.
- **Books a sale**, so the admin revenue panel does not silently under-report
  everything sold through the stores. ⚠️ `priceOMR` is our LIST price, not what
  Apple charged — the store bills its own tier in the buyer's currency and takes
  its cut. Treat store rows as gross-at-list, never as a payout figure.

No `firestore.rules` change is needed: `entitlements` and the new `rcEvents`
collection are denied to every client, and the Admin SDK bypasses rules.
