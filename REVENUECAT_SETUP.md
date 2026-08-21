# Deploying `revenuecatWebhook`

The function is written, unit-tested (39 checks in CI via
`functions/test/revenuecat.test.mjs`) and needs **no `firestore.rules` change** —
`entitlements/{uid}` is already write-denied to every client, `rcEvents` has no
rule at all, and the Admin SDK bypasses rules entirely. So this is a deploy and
a dashboard setting, not a code change.

> **This has NOT been run.** Nothing in this document has been executed against
> the live project. The deploy happens in **Cloud Shell**, which is where the
> credentials are.

---

## 1. Pull first — this is the trap that wastes an afternoon

Cloud Shell has a **separate clone** at `~/izzbah-game` that does not follow
GitHub on its own.

```bash
cd ~/izzbah-game && git pull
```

Skip it and `firebase deploy` packages stale source, reports
**`Skipped (No changes detected)`**, and looks completely successful while
deploying nothing. This has already cost four failed attempts once.

---

## 2. Create the secret OUT OF BAND

`revenuecatWebhook` declares `defineSecret("REVENUECAT_WEBHOOK_SECRET")`.

⚠️ **`firebase functions:secrets:set` crashes in Cloud Shell** — it cannot read
masked stdin and dies with `Error: An unexpected error has occurred`. Create it
with `gcloud` instead, generating the value in the same pipeline so it never
appears on screen, in scrollback, or in shell history:

```bash
openssl rand -base64 32 | tr -d '\n' \
  | gcloud secrets create REVENUECAT_WEBHOOK_SECRET --data-file=- --project=izzbahgame
```

If it already exists, add a version instead:

```bash
openssl rand -base64 32 | tr -d '\n' \
  | gcloud secrets versions add REVENUECAT_WEBHOOK_SECRET --data-file=- --project=izzbahgame
```

---

## 3. Deploy

```bash
firebase deploy --only functions:revenuecatWebhook --project izzbahgame
```

⚠️ **`--only` does not narrow which secrets are resolved.** `defineSecret` runs
for the WHOLE codebase before the filter applies, so this deploy still wants
`PAYMENT_WEBHOOK_SECRET` and the five `R2_*` values. The R2 ones exist already
(`mintUploadUrl` is live) and `PAYMENT_WEBHOOK_SECRET` was created out of band
with a throwaway value. If any of them prompts, create it the same way as step 2
rather than answering the prompt.

Copy the function URL from the output — something like
`https://revenuecatwebhook-<hash>-uc.a.run.app`.

---

## 4. Point RevenueCat at it

**Dashboard → Integrations → Webhooks:**

| Field | Value |
|---|---|
| URL | the URL from step 3 |
| Authorization header | the secret value |

Read the value back for pasting — in the terminal, not into any chat or ticket:

```bash
gcloud secrets versions access latest --secret=REVENUECAT_WEBHOOK_SECRET --project=izzbahgame
```

⚠️ **The header is compared RAW.** `rcAuthorised()` does a constant-time
comparison of the entire `Authorization` value against the secret — there is no
`Bearer ` prefix and no parsing. Paste the value alone. A `Bearer ` in front is
a 401 with a correct secret, and the log line just says `bad authorization`.

---

## 5. Verify

Use RevenueCat's **Send test event**, then:

```bash
firebase functions:log --only revenuecatWebhook --project izzbahgame
```

What each outcome means:

| Log line | Meaning |
|---|---|
| `bad authorization` | Header mismatch — check for a `Bearer ` prefix or trailing newline |
| `revenuecat webhook unparsed: <reason>` | Shape not understood; returns 400 deliberately so RevenueCat stops retrying something that will never parse |
| `no grant — unknown-user` | **The important one.** See below |
| `no grant — unknown-product` | The product id in the event is not in `PRODUCT_PACKS` |
| `granted <pack> to <uid>` | Working |
| `duplicate` | Idempotency held; RevenueCat retried and nothing was granted twice |

---

## ⚠️ `unknown-user` is the failure that costs money

`app_user_id` **must** be the Firebase uid. If RevenueCat is still holding one
of its own anonymous ids when a purchase completes, this function has no idea
whose account to credit — and the payment has already succeeded. The player is
charged and the games never arrive, with no error on the device, in the webhook,
or in the console.

The client side of this is already built (`identifyStoreUser()` in
`index.html`, called from `applyAuth` on every auth change and again just before
the store sheet opens, backed by `IZZBAH_STORE.identify()` in
`mobile/native-store.js`). It has never run against a real device, so this is
the first thing to confirm once the app builds: buy in sandbox, and check the log
says `granted`, not `unknown-user`.

---

## What still blocks a REAL purchase after this

Deploying the webhook does not make anything buyable. Also needed:

- products created in App Store Connect / Play Console with the ids in
  `functions/lib/revenuecat.js` and `STORE_PRODUCTS` in `index.html`;
- `RC_API_KEY` filled in in `mobile/native-store.js` (public SDK keys — the
  secret key never leaves the server);
- a native project that has actually been built and run.
