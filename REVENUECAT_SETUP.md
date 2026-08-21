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

## ⚠️ The "Send a Test Webhook" page reports failure when it SUCCEEDED

**Verified 2026-08-21, and it cost a long detour.** That page renders
*"It wasn't possible to connect, are you sure the URL is correct?"* and never
clears it. It went on saying that while the function log showed RevenueCat's
events arriving, passing the Authorization check and being handled correctly —
twice, nine minutes apart, both carrying RevenueCat's own `test_product`
payload.

⚠️ **Believe the function log, not that page.** Check with:

```bash
date -u; firebase functions:log --only revenuecatWebhook --project izzbahgame --lines 5
```

and compare the newest timestamp against the clock it prints. A line within the
last minute or two is a real delivery whatever the dashboard claims. The whole
detour was spent re-pasting a secret that had been correct all along.

⚠️ Related: the webhook settings page has a **Save** button at the bottom, and
the form shows your edits before they are persisted. A test run against "what is
on screen" can be exercising the PREVIOUS configuration. Save, confirm it, then
test.

---

## ⚠️ App Review will FAIL the purchase unless you prepare an account

`functions/lib/revenuecat.js` refuses sandbox grants to anyone who is not staff:

```js
if (parsed.sandbox && !isStaff) return { grant: false, reason: "sandbox" };
```

That rule is correct — Apple sandbox accounts are free to create, so without it
anybody could mint unlimited games. But **App Review tests in-app purchases in
the sandbox**, so a reviewer would tap buy, Apple's sheet would succeed, and the
webhook would refuse. From their side: paid, nothing happened. That is a
rejection for "in-app purchase does not work", with the code behaving exactly as
designed and the log reading `no grant — sandbox`.

**Prepare a review account BEFORE submitting.**

1. Create a Google account you control (e.g. `izzbah.review@gmail.com`).
2. Sign into the game with it **once** — this is what brings the uid into
   existence; there is nothing to add before that.
3. Read the uid from the admin centre's players list, or Firebase console →
   Authentication.
4. Firebase console → Firestore → `editors` → add a document whose **id is the
   uid**. The `email` field only names the row in the panel; the permission is
   the document EXISTING, exactly as with `admins/{uid}`.
5. Give those credentials to Apple in App Store Connect → App Review
   Information → Sign-In Required.
6. Remove the `editors/{uid}` document once the app is approved.

⚠️ **`editors`, NOT `admins`, and the obvious choice is the wrong one.** Both
satisfy `isStaff`, but `state.isAdmin` also grants **unlimited free play**
(`playBalanceSummary()` returns «مشرف — لعب غير محدود»). An admin reviewer never
runs out of games, so they would have no reason to buy and could not test the
purchase at all. An editor keeps `state.isAdmin` false and therefore normal play
limits — they hit the paywall like any player, buy, and the sandbox gate lets it
through. That is exactly what review needs.

⚠️ Accepted trade: an editor can also add, change and delete questions (bounded
by `firestore.rules` — they cannot empty a category, and one publish caps at
five removals). A reviewer will not do that, and step 6 closes it. If that is
ever not acceptable, the cleaner shape is a separate `reviewers/{uid}`
collection granting ONLY the sandbox exception — which is a rules change, a
functions change and a test, and has deliberately not been built for a
capability that is needed once.

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
