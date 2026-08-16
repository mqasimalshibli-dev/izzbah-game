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
8. **Register the sending address as an Email Source** — Apple Developer portal
   → Certificates, Identifiers & Profiles → **Sign in with Apple for Email
   Communication**. Add **izzbahgame@gmail.com**. Do this in the same sitting as
   step 3; see the trap below for why.

---

## Hide My Email — what it is, and three things it breaks

Every person who taps Sign in with Apple is offered a choice:

- **Share My Email** → you receive their real address, e.g. `ali@gmail.com`.
- **Hide My Email** → you receive `k7m2p9x4qz@privaterelay.appleid.com`.

The relay address is real and Apple forwards to their true inbox, but you never
learn the real one, and it is **unique per app**. It cannot be turned off or
opted out of by us — it is the player's choice, and a meaningful share take it.

### 1. It is why linking cannot be automatic

Google gave us `ali@gmail.com`; Apple gives us a relay address. The two strings
have nothing in common, so Firebase cannot tell it is the same human, raises no
error, and creates a second account. Nothing can detect this — which is the
entire reason the «اربط حساب…» row exists in settings, pressed from inside an
account the player is already signed in to, where no guessing is required.

### 2. It makes a customer unnameable in the admin centre

The players list, the sales rows and `resolveEmails` all name people by email.
A Hide-My-Email player shows as `k7m2p9x4qz@privaterelay.appleid.com`, which
identifies nobody. Their uid still works, so support is possible — just harder.

### 3. ⚠️ You cannot email a relay address from an unregistered sender

Apple **rejects** the forward unless the sending address is registered as an
Email Source (step 8 above). This is the trap, because it is silent:

Today every player is on Google, so the activation-code flow — which emails
codes and payment instructions from `izzbahgame@gmail.com` — works fine. The day
Apple sign-in ships, a Hide-My-Email player who needs a gift code or a fix
receives **nothing at all**, and it looks exactly like the email went missing.

Register the address before the first Apple sign-in reaches production, not
after the first complaint.

⚠️ Related: a player can later switch forwarding OFF in their Apple ID settings.
Mail to that address then bounces permanently. Nothing to build for it, but it
is worth recognising when an email to a relay address stops arriving.

**Apple returns the display name exactly ONCE**, on first sign-in. Persist it in
that callback or it is gone permanently — later sign-ins carry nothing and there
is no API to ask again.

---

## What is deliberately NOT automatic

If the Apple credential already belongs to a **different** account, linking is
refused and the player is pointed at support. Both accounts may hold purchases,
and merging two paid balances is not a decision the app should make on its own.
There is no admin merge tool yet; today it is a manual `entitlements` edit.
