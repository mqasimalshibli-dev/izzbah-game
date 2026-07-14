# عِزبة (Izzbah) — notes for future sessions

## Pending TODOs (user-requested)

- **Automate the pack-order confirmation email, gated on payment.** Today the
  flow is manual: a player taps a pack → order lands in the admin's
  subscription panel → the admin presses «كود + بريد التأكيد», which mints the
  code and opens a prefilled Gmail compose (from izzbahgame@gmail.com) that the
  admin completes and sends. The user wants this upgraded so the email is sent
  to the buyer **automatically after the payment is made** — i.e. the code
  email goes out only once payment is confirmed, with no manual compose step.
  This needs a payment signal + a server-side email sender (e.g. a real payment
  provider webhook + Cloud Functions on the Blaze plan, or an email API), since
  the game is a static page on GitHub Pages and Firebase is on the free Spark
  plan (no Cloud Functions, no server). Design the payment-confirmation step
  first; never send the code before payment.

## Standing conventions in this repo

- Single self-contained game file: `game-mobile.html` (Arabic, RTL). Firebase
  compat SDK, project `izzbahgame`, FREE Spark plan — no backend/functions.
- Develop on the designated feature branch, merge `--no-ff` into `root`
  (the GitHub Pages branch), push, and verify the smoke workflow is green.
- Bump `IZZBAH_BUILD` on every deploy.
- Tests live in `tests/*.mjs` (Playwright, offline — Firebase aborted); every
  new feature gets a test registered as a step in
  `.github/workflows/smoke.yml`.
- Whenever `firestore.rules` changes, paste the FULL updated rules file in the
  chat reply — the user publishes it manually in the Firebase console.
