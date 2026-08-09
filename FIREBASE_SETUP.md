# Cloud sign-in & progress sync — setup (≈10 minutes)

The game now has a **"تسجيل الدخول بحساب Google"** button on the main menu and a
cloud-sync layer. They stay dormant until you paste your own Firebase config,
so the game keeps working with on-device saving until you finish these steps.

Once configured: a player signs in with Google, and their saved games /
settings are stored in the cloud under their account and restored automatically
on any device.

## What only you can do (I can't create accounts for you)

### 1. Create a free Firebase project
- Go to <https://console.firebase.google.com> → **Add project** → name it (e.g. `izzbah`).
- Google Analytics is optional; you can skip it.

### 2. Enable Google sign-in
- Left menu → **Build → Authentication → Get started**.
- **Sign-in method** tab → enable **Google** → save.

### 3. Create the database
- Left menu → **Build → Firestore Database → Create database**.
- Start in **production mode** (we set rules below) → pick a region → enable.

### 4. Add the security rules
- Firestore → **Rules** tab → paste the contents of [`firestore.rules`](./firestore.rules) → **Publish**.
- These rules ensure each user can only read/write their own data.

### 5. Register a Web app and copy the config
- Project **⚙ Settings → General → Your apps → Web (`</>`)** → register an app.
- Copy the `firebaseConfig` object it shows you.

### 6. Paste the config into the game
- Open `index.html` (the game — it is the site root).
- Near the top, inside `<head>`, find `window.IZZBAH_FIREBASE_CONFIG = { ... }`
  and replace the `PASTE_YOUR_*` values with the ones from step 5.

### 7. Authorize your domain
- Authentication → **Settings → Authorized domains → Add domain**.
- Add your live domain (e.g. `mqasimalshibli-dev.github.io`).
- `localhost` is already allowed for local testing.

That's it. The sign-in button appears automatically once the config is real,
and progress syncs to the signed-in user's account.

## Notes
- The Firebase web config (apiKey etc.) is **meant to be public** — it is not a
  secret. Security is enforced by the Firestore rules in step 4, so don't skip them.
- Free tier (Spark plan) is generous for a game like this. Watch usage in the
  console if you get very popular.
- Signed-out players still play; their data stays on-device (localStorage) as before.
- Data stored per user: the three `izzbah-trivia-*` blobs (settings, saved games,
  preview choices) plus their email — nothing else.
