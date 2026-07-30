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
  `game-mobile.html` against the server table and fails on any mismatch.
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
