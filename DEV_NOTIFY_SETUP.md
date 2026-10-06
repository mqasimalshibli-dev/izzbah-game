# Deploying the developer-notification emails

Two Cloud Functions, `notifyNewCommunityCategory` and `notifyNewFeedback`,
email you (via your own Gmail account) the moment a player submits a new
community category or sends a new feedback message. They are written,
unit-tested (`functions/test/notify.test.mjs`, 16 checks in CI) and need
**no `firestore.rules` change** — they only READ with the Admin SDK, which
bypasses rules entirely.

> **This has NOT been run.** Nothing in this document has been executed
> against the live project. The deploy happens in **Cloud Shell**, which is
> where the credentials are.

These are the **first Firestore-triggered functions** in this codebase —
every other deployed function is HTTPS-only (`onCall`/`onRequest`). That
changes nothing about how you deploy them, but if something looks like it
"isn't firing," remember there is no webhook URL to test with curl — the
only way to trigger one is to actually write the document (submit a test
category, send a test feedback message).

---

## 1. Pull first — this is the trap that wastes an afternoon

Cloud Shell has a **separate clone** at `~/izzbah-game` that does not follow
GitHub on its own.

```bash
cd ~/izzbah-game && git pull
```

Skip it and `firebase deploy` packages stale source, reports
**`Skipped (No changes detected)`**, and looks completely successful while
deploying nothing.

---

## 2. Create a Gmail App Password

This sends mail AS your own `izzbahgame@gmail.com` account over SMTP — no
new third-party service, no new account. Gmail will not accept your normal
login password for this; you need an **app password**, which requires
**2-Step Verification to already be turned on** for the account.

1. Turn on 2-Step Verification if it isn't already: <https://myaccount.google.com/security>
2. Generate an app password: <https://myaccount.google.com/apppasswords>
   (sign in as `izzbahgame@gmail.com` first). Name it something like
   "izzbah notify function". Google shows you a 16-character password
   **once** — copy it immediately, you cannot view it again (only revoke
   and generate a new one).

---

## 3. Create the secrets OUT OF BAND

Two secrets this time: the Gmail address itself, and the app password.

⚠️ **`firebase functions:secrets:set` crashes in Cloud Shell** — it cannot
read masked stdin and dies with `Error: An unexpected error has occurred`.
Create both with `gcloud` instead.

```bash
printf 'izzbahgame@gmail.com' \
  | gcloud secrets create GMAIL_USER --data-file=- --project=izzbahgame
```

```bash
# Paste the 16-character app password from step 2 when prompted, or pipe it
# directly if you have it on the clipboard — either way, never type it into
# a chat, a ticket, or anywhere that gets logged.
gcloud secrets create GMAIL_APP_PASSWORD --data-file=- --project=izzbahgame
```

If either secret already exists (a second attempt at this), add a new
version instead of creating:

```bash
printf 'izzbahgame@gmail.com' \
  | gcloud secrets versions add GMAIL_USER --data-file=- --project=izzbahgame
gcloud secrets versions add GMAIL_APP_PASSWORD --data-file=- --project=izzbahgame
```

---

## 4. Deploy

```bash
firebase deploy --only functions:notifyNewCommunityCategory,functions:notifyNewFeedback --project izzbahgame
```

⚠️ **`--only` does not narrow which secrets are resolved.** `defineSecret`
runs for the WHOLE codebase before the filter applies, so this deploy will
still want the five `R2_*` values, `PAYMENT_WEBHOOK_SECRET`, and
`REVENUECAT_WEBHOOK_SECRET`. All of those already exist from previous
deploys — if any of them somehow prompts, create it out of band the same
way as step 3 rather than answering the masked prompt (which crashes here).

⚠️ No manual IAM step is needed afterward — creating secrets with `gcloud`
(rather than `firebase functions:secrets:set`) already grants
`roles/secretmanager.secretAccessor` to the compute service account, same
as every other secret in this project.

---

## 5. Verify

There's no webhook URL to curl — trigger it for real:

- **Community category:** sign in as a non-admin test account in the game,
  submit any throwaway community category, and check `izzbahgame@gmail.com`
  for a "فئة مجتمعية جديدة: …" email within a few seconds.
- **Feedback:** open «تواصل معنا» as a non-admin account and send a message.
  Check for a "رسالة جديدة من …" email. Then reply to that thread AS the
  admin from the game's own panel — **no** email should arrive for your own
  reply (`notifyNewFeedback` skips `from: "admin"` on purpose).

If nothing arrives, check the function's logs before suspecting the email
side — `firebase functions:log --only notifyNewCommunityCategory` (or
`notifyNewFeedback`) in Cloud Shell. A thrown error there (bad app password,
2-Step Verification not actually on, etc.) is swallowed on purpose — these
functions log and drop the email rather than retry forever — so the log is
the only place a failure shows up.

---

## 6. Rotating the app password later

Revoking an app password and generating a new one needs **both** a new
secret version **and** a redeploy — Firebase pins the secret version at
deploy time, so `gcloud secrets versions add` alone leaves the function
running on the old (now-revoked) password until you redeploy.

```bash
gcloud secrets versions add GMAIL_APP_PASSWORD --data-file=- --project=izzbahgame
firebase deploy --only functions:notifyNewCommunityCategory,functions:notifyNewFeedback --project izzbahgame
```
