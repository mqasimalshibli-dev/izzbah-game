# Sign in with Apple — runbook

App Store guideline **4.8**: an app that offers third-party login must also
offer Sign in with Apple. عِزبة offers Google, so the native build needs it.
The website and PWA never do.

The code is written and Apple is **declared but disabled** — see
`AUTH_PROVIDERS` in `index.html`. Flipping `enabled: true` is the last step, not
the first: a provider switched on before Apple's end is configured fails at the
popup with an OAuth error the player cannot act on and you cannot explain.

---

## Why linking had to be built first

Firebase issues a **different uid per sign-in method**, and `entitlements/{uid}`
is keyed by uid. A player who buys packs with Google and later taps Apple opens
a new, empty account. Their games still exist under the old uid, but nothing in
the app can reach them — and from where they are standing, you took their money
and deleted their purchase.

That is why account linking shipped in the same change as the Apple provider,
and not afterwards.

### The two cases, and why one cannot be automated

| | What happens | How it is handled |
|---|---|---|
| **Emails match** | Firebase raises `auth/account-exists-with-different-credential` | Caught at sign-in: sign in with the method the account already has, then `linkWithCredential`. The player sees one ordinary sign-in. |
| **Emails differ** (Apple "Hide My Email") | The relay address matches nothing. Firebase sees a stranger and makes the second account. **No error is raised.** | Cannot be detected. The only fix is attaching from INSIDE the account — the «اربط حساب Apple بحسابك» row in settings. |

⚠️ **The automatic case depends on a console setting.** Firebase console →
Authentication → Settings → **User account linking** must be
**"Link accounts that use the same email"**. On "Create multiple accounts for
each identity provider" Firebase silently creates the second account, no error
is raised, the catch never runs, and the player quietly loses their balance.
**Confirmed set correctly on 2026-08-16.** It cannot be read or set from the
app, so re-check it if the project is ever recreated or migrated.

---

## Turning Apple on

1. **Apple Developer Program** — needed for all of the below. Organisation
   enrolment shows «IZZBAH» as the seller and needs a D-U-N-S number, which
   takes days; individual enrolment is same-day but lists your personal name.
2. **App ID** with the *Sign In with Apple* capability.
3. **Services ID** — this is the OAuth client id. Add
   `https://izzbahgame.firebaseapp.com/__/auth/handler` as the return URL.
4. **Sign-in key** (.p8) — note the Key ID and your Team ID. The .p8 downloads
   **once**; there is no second chance.
5. **Firebase console** → Authentication → Sign-in method → **Apple**: paste the
   Services ID, Team ID, Key ID and the .p8 contents.
6. **In `index.html`**, set `enabled: true` on the `apple.com` entry of
   `AUTH_PROVIDERS`, and add a second sign-in button.
   ⚠️ `tests/authlink.mjs` asserts Apple is DISABLED. That assertion is the
   reminder — flip it in the same commit, deliberately.
7. **CSP** — add `https://appleid.apple.com` to `frame-src` and `connect-src`.

---

## Two things that will bite

**Private Relay breaks naming customers.** With "Hide My Email" the token's
email is `…@privaterelay.appleid.com`. The admin centre names players by email
(sales rows, the `usage` stamp, `resolveEmails`), so those players become
unidentifiable in your own tooling and the manual activation-code flow cannot
reach them at all. The uid still works; the email does not.

**Apple returns the display name exactly ONCE**, on first sign-in. Persist it in
that callback or it is gone permanently — later sign-ins carry nothing and there
is no API to ask again.

---

## What is deliberately NOT automatic

If the Apple credential already belongs to a **different** account, linking is
refused and the player is pointed at support. Both accounts may hold purchases,
and merging two paid balances is not a decision the app should make on its own.
There is no admin merge tool yet; today it is a manual `entitlements` edit.
