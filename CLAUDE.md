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

- **Online / remote multiplayer — PARKED for v2 (owner-requested 2026-07-21).**
  Turn عِزبة from single-device pass-and-play into each player on their own
  phone, synced in real time. RECOMMENDED architecture = **host-authoritative
  rooms** (NOT server-authoritative, NOT peer): one player hosts (their device
  runs the existing game + holds the ANSWERS + judges); others join a room by
  short code and get a companion screen (board, scores, turn, buzzer/answer
  box) that NEVER receives the answer — so no one can peek in dev tools, and no
  Cloud Function/server is needed. Build pieces: (1) a `rooms/{code}` Firestore
  doc all devices listen to via onSnapshot (RTDB optional for snappier buzzers
  + onDisconnect presence); (2) enable **Anonymous auth** so friends join with
  just a name + code; (3) lobby (create room → share code → start); (4) host
  publishes PUBLIC state each action (board, scores, turn, question prompt/image
  only — never the answer); (5) player companion view; (6) buzzer/judging flow +
  disconnect/heartbeat handling; (7) Firestore rules so a player can only join
  and write their OWN input doc, never edit scores or read answers. Effort: the
  biggest feature discussed — days-to-weeks. Owner's confirmed sequencing: SHIP
  the local party game first, then build this as v2; let launch traffic confirm
  demand before investing. Open decision to confirm when starting: "friends in
  different places" vs "same room, own phones" (same tech, different networking
  assumptions).

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
  compat SDK, project `izzbahgame`, BLAZE plan. One Cloud Function is deployed:
  `mintUploadUrl` (in `functions/`) mints a presigned R2 upload URL so admins
  upload video/voice straight from the game to the `izzbah-media` R2 bucket
  (`VIDEO_UPLOAD_SETUP.md` has the runbook). The rest runs client-side.
- Develop on the designated feature branch, merge `--no-ff` into `root`
  (the GitHub Pages branch), push, and verify the smoke workflow is green.
- Bump `IZZBAH_BUILD` on every deploy.
- Tests live in `tests/*.mjs` (Playwright, offline — Firebase aborted); every
  new feature gets a test registered as a step in
  `.github/workflows/smoke.yml`.
- Whenever `firestore.rules` changes, paste the FULL updated rules file in the
  chat reply — the user publishes it manually in the Firebase console.
- Saved-game policy (owner REVERSED the old rule on 2026-07-20 — do not
  restore it): a saved game keeps only its SETUP (name/categories/teams).
  EVERY run — including re-runs of a saved game — draws fresh questions and
  costs a game credit (gated at start, charged on finish; abandoning a run
  never charges). Questions are pinned (`record.frozen`) only WITHIN a run so
  a resume serves the same board; `startGame` clears the pins and `charged`
  per run. The old model (frozen-forever questions + free replays) is gone.
