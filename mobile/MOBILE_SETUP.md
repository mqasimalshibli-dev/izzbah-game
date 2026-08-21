# عزبة (Izzbah) — iOS & Android app build (Capacitor)

This folder wraps the existing web game (`../index.html`) into a native
app for the **Apple App Store** and **Google Play** using
[Capacitor](https://capacitorjs.com/). Nothing about the game is rewritten —
the same HTML/JS runs inside the app's webview.

> The native `ios/` and `android/` folders and `www/` are **git-ignored** —
> you generate them locally (and need them only to build/submit). Everything
> committed here is the reusable config.

---

## Prerequisites
| Target | You need |
|---|---|
| **Android** | [Android Studio](https://developer.android.com/studio) (any OS). Google Play dev account — **$25 one-time**. |
| **iOS** | A **Mac** with **Xcode**. Apple Developer Program — **$99/year**. (iOS cannot be built on Windows/Linux.) |
| Both | Node.js 18+ |

---

## First-time setup
```bash
cd mobile
npm install                 # install Capacitor
npm run copy:web            # ../index.html -> www/index.html
npx cap init Izzbah com.izzbah.game --web-dir=www   # only if capacitor.config.ts is missing
npm run add:android         # creates android/   (needs Android Studio SDK)
npm run add:ios             # creates ios/        (Mac + Xcode only)
npm run sync                # copy web + sync native projects
```

## Every time you change the game
The game lives in `../index.html`. After editing it:
```bash
cd mobile && npm run sync
```
Then rebuild in Xcode / Android Studio.

## Open the native projects to build & submit
```bash
npm run open:android   # -> Android Studio (build AAB for Play)
npm run open:ios       # -> Xcode (archive for App Store)
```

---

## ⚠️ Before you submit — required changes (not optional)

These are **store requirements / known webview issues**, in priority order:

### 1. Native sign-in (the current Google popup won't work in the app)
`signInWithPopup` does **not** work inside an iOS/Android webview. Replace it
with native auth:
```bash
npm install @capacitor-firebase/authentication
```
- Wire Google sign-in through the native plugin.
- **Apple requires** that any app offering Google login **also** offers
  **Sign in with Apple** (Guideline 4.8) — add it via the same plugin.

### 2. In-app account deletion (Apple 5.1.1(v) + Google)
Any app with login must let users **delete their account from inside the app**.
Add a "حذف الحساب / Delete account" button that deletes the user's Firestore
doc **and** their Firebase auth user.

### 3. Payments = store billing, NOT Stripe (if you add the paywall)
Selling digital content **inside the app** must use **Apple In-App Purchase** /
**Google Play Billing** (15–30% cut) — Stripe is **not allowed** for in-app
digital goods. Cross-platform option that also handles server-side receipt
validation: [RevenueCat](https://www.revenuecat.com/)
(`@revenuecat/purchases-capacitor`). The web (browser) version can still use
Stripe.

### 4. Icons & splash screen
```bash
npm install -D @capacitor/assets
# put a 1024x1024 icon.png + splash in mobile/assets-source/, then:
npx capacitor-assets generate
```

### 5. Store listing essentials
- **Privacy policy URL** + data-safety/privacy labels (you collect email).
- Age rating, screenshots, description (Arabic + English).
- Confirm you **own or are licensed** for all category images & trivia content.

### 6. Native polish (recommended)
```bash
npm install @capacitor/status-bar @capacitor/splash-screen
```
- Handle notch/safe-areas with CSS `env(safe-area-inset-*)` (the page already
  sets `viewport-fit=cover`).
- Consider bundling the Firebase SDK & fonts locally for offline launch.

---

## Security note
The XSS fix and the Content-Security-Policy already in `index.html` carry
over — they protect the webview too. The only **new** security work is
**server-side receipt validation** for in-app purchases (RevenueCat does this
for you), so a user can't fake "I paid".

## Bundle ID
`com.izzbah.game` (matches the desktop build's appId). Use the **same** ID in
the Apple Developer portal and Google Play Console.

---

## The two native bridges (added 2026-08-20)

The game is deliberately ignorant of Capacitor, Firebase-native and RevenueCat.
It calls two small globals and owns every decision around them. Both files live
here, are NOT referenced by the web build, and must be loaded by the app before
the first sign-in tap or the first opening of the packs box.

| File | Installs | Contract |
|---|---|---|
| `native-auth.js` | `window.IZZBAH_AUTH` | `signIn(providerId) -> {idToken, accessToken?, rawNonce?}` |
| `native-store.js` | `window.IZZBAH_STORE` | `identify(uid)`, `purchase(productId)`, `priceOf(productId)` |

Each file carries its own wiring steps and traps at the top. The four worth
repeating here, because each one fails **silently**:

1. **`skipNativeAuth: true`** in `native-auth.js`. Without it the app holds two
   independent Firebase sessions — the native SDK's and the JS one the game
   actually reads — which drift apart on sign-out and leave a player looking
   signed in while every Firestore read is denied.
2. **Apple needs the RAW nonce**, not the hashed one. Firebase re-hashes ours to
   compare. Passing the hashed value, or omitting it, is rejected and the error
   names neither.
3. **Register the RELEASE signing SHA-1** with Firebase on Android, not just the
   debug one. Missing it is the classic works-in-testing, fails-for-every-real-
   user bug.
4. **`identify()` is the whole ballgame for purchases.** RevenueCat grants
   against `app_user_id` and `functions/lib/revenuecat.js` reads it as a Firebase
   uid. A purchase completed while the SDK still holds its own anonymous id
   cannot be matched to an account: the payment succeeds, the games never
   arrive, and nothing anywhere raises an error. The game calls `identify()` on
   every auth change and again just before the sheet opens; `configure()`
   deliberately passes no `appUserID` so the SDK is only ever named by us.

### What is NOT done yet

- `cap add ios` / `cap add android` have never been run — there are no native
  projects, so neither bridge has ever executed.
- `RC_API_KEY` in `native-store.js` is empty. Public SDK keys are meant to ship
  in the client; the **secret** key never leaves the server.
- `revenuecatWebhook` exists in `functions/index.js` and is unit-tested in CI,
  but needs deploying and the RevenueCat dashboard pointing at it.
- Products do not exist in App Store Connect, so `priceOf()` returns `""` and
  the packs render with **no price**. That is correct: Apple bills in its own
  tiers per storefront, so printing the hardcoded `٠٫٩٠٠ ر.ع` would show one
  number and charge another.
- Sign in with Apple stays `enabled: false` in `index.html` until the Apple
  Developer Program provides the App ID, Services ID and key. Both the provider
  and the account-linking flow are already written, so that day is a flag flip.

---

## `cap add android` — run once, 2026-08-20, and what it found

The Android project was generated successfully and both plugins were detected:

```
[info] Found 2 Capacitor plugins for android:
       @capacitor-firebase/authentication@6.3.1
       @revenuecat/purchases-capacitor@9.2.2
[success] android platform added!
```

`mobile/android/` is **not committed** — `.gitignore` treats it as generated,
so run `npm install && npm run copy:web && npx cap add android` on the machine
that will build it. Three things had to be fixed first, and all three would have
stopped you on your own machine:

1. **TypeScript was missing entirely.** `capacitor.config.ts` is read through
   TypeScript, so `cap add` fails with *"Could not find installation of
   TypeScript"* before doing anything.
2. **TypeScript 7 breaks Capacitor 6.** `npm install -D typescript` now resolves
   to 7.x, and the CLI reaches for `ts.ModuleKind.CommonJS`, which 7 no longer
   exposes: `TypeError: Cannot read properties of undefined (reading
   'CommonJS')`. The message names neither TypeScript nor the version. Pinned to
   `^5.6.3`.
3. **The bridges had no path into the app.** `copy-web.js` packaged index.html
   and assets/ only — `native-auth.js` and `native-store.js` were never in
   `www/`, so sign-in and buying would both have been dead in the wrapper with
   nothing to point at. They also cannot ship raw: both import BARE specifiers,
   which no browser resolves. `copy-web.js` now bundles them with esbuild into
   `www/native.js` (~168 KB) and injects a deferred `<script>` tag, throwing
   loudly if either step fails.

Verified in a real browser against the packaged `www/`: `IZZBAH_AUTH.signIn`,
`IZZBAH_STORE.purchase`, `.identify` and `.priceOf` all attach, and the game's
own `nativeAuthBridge()` sees them. `tests/nativebridge.mjs` pins the contract
in CI without needing the 175-package install.

### Still needed to BUILD it

`cap add` only generates the project. Compiling needs the **Android SDK** and a
JDK (Java 21 is fine), neither of which this repo carries — install Android
Studio, then `npx cap open android`. Nothing here has been compiled or run on a
device.

### iOS

`cap add ios` will work the same way, but building it needs **macOS and Xcode**.
That is a hard requirement no amount of setup here removes.
