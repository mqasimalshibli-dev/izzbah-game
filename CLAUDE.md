# عِزبة (Izzbah) — notes for future sessions

## Pending TODOs (user-requested)

- **Web Push notifications — PARKED until after release (owner's call,
  2026-07-19).** Today announcements + personal reward messages are in-app
  only (badge on the settings gear → «إعلانات المطوّر»); nothing reaches the
  phone's tray. Post-release, build Web Push: a Cloud Function (Blaze is
  active) that sends FCM pushes when an announcement is published, plus
  client-side opt-in (friendly button, not an ambush prompt), FCM token
  storage, and a push handler in sw.js. Start with announcements; wire the
  personal approval-reward messages second. iOS caveat: Web Push needs the
  PWA installed to the home screen (16.4+). If the App Store app ships,
  revisit with native push.

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

## Agent toolkit (connected — .claude/agents + .claude/workflows)

Deliberately minimal, per the owner: ONLY the pictures and safety agents are
kept. The question-authoring/fact-check/audit/insights agents were removed on
purpose — do NOT re-add or use agents to write, curate, verify, or audit
questions. HARD RULE: every agent here is REPORT-ONLY and never changes
existing questions or pictures; findings go to the owner, who acts.

- Workflow `review-images` — one `image-reviewer` (vision) per category over
  the stored question/answer photos; returns a flagged list only.
- Agent `image-reviewer` — the pictures agent; decodes and LOOKS at stored
  images, flags mismatches/spoilers. Report-only.
- Agent `community-reviewer` — the safety agent; pre-screens ONE pending
  community submission (caller passes the data in) for safety/quality/dupes.
  Recommendation only — the admin approves in-game.

## Standing conventions in this repo

- Single self-contained game file: `game-mobile.html` (Arabic, RTL). Firebase
  compat SDK, project `izzbahgame`, BLAZE plan (Cloud Functions available but
  none deployed yet — the game still runs fully client-side).
- Develop on the designated feature branch, merge `--no-ff` into `root`
  (the GitHub Pages branch), push, and verify the smoke workflow is green.
- Bump `IZZBAH_BUILD` on every deploy.
- Tests live in `tests/*.mjs` (Playwright, offline — Firebase aborted); every
  new feature gets a test registered as a step in
  `.github/workflows/smoke.yml`.
- Whenever `firestore.rules` changes, paste the FULL updated rules file in the
  chat reply — the user publishes it manually in the Firebase console.
