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

- **Automatic purchases via Thawani — backend BUILT, client flow FROZEN
  (owner, 2026-07-30).** Decided model: the player pays and **the games are
  granted to their account directly** — no code, no email. Activation codes
  stay a MANUAL, ADMIN-ONLY tool for gifts and fixes and are never part of a
  purchase.
  - Already built and tested (`functions/lib/packs.js`, `functions/lib/grant.js`,
    `createCheckout` + `paymentWebhook` in `functions/index.js`, 26 unit tests
    in CI via `functions/test/fulfilment.test.mjs`). No firestore.rules change
    was needed: entitlements are write-denied to every user and the Admin SDK
    bypasses rules, so the webhook is the only path to paid content.
  - Still to do when the merchant account exists — see `PAYMENT_SETUP.md`:
    replace the deliberately-stubbed `verifyProviderCallback()` with Thawani's
    real signature check (do NOT guess at it), return a real `checkoutUrl`, and
    only then wire the client.
  - ⚠️ **DO NOT change what happens when a player taps a pack** (`orderPlan`)
    until the owner says so. It must keep the CURRENT manual behaviour: write
    `orders/{uid}`, show «تم استلام طلبك…», and wait for the admin to press
    «كود + بريد التأكيد». The new Cloud Functions are deployed-ready but
    deliberately NOT connected to the UI.
  - Known gaps in the manual flow the owner has accepted for now: the code is
    emailed together with the payment instructions (so it goes out before the
    money arrives), and `recordSale` books revenue at that moment rather than on
    payment. Both disappear once Thawani is wired.

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
- Saved-game policy (owner reversed AGAIN on 2026-07-29 — PERMANENT GAMES;
  this supersedes the 2026-07-20 fresh-every-run rule): creating a NEW game
  spends one credit AT START (`spendGameCredit` in `startGame`) and marks the
  record `charged: true` forever. Its questions are pinned permanently in
  `record.frozen` (never cleared) so every replay serves the same board, and
  REPLAYS ARE FREE — finishing (`renderResults`), exiting ✕, discarding, and
  pausing never charge anything. All games stay in «ألعابك» (cap 200).
  Cross-game freshness: every question that APPEARS on a board is recorded in
  the `izzbah-seen-v1` tracker (`state.seen`, catId → [sig,…], LRU-ordered,
  cloud-synced); `pickUnseen` refuses to serve seen questions to a NEW game
  until the category is exhausted, then falls back least-recently-seen first.
