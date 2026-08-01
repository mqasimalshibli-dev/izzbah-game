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

- **Sign in with Apple — PARKED until the App Store build is real (owner,
  2026-07-31).** Only required by App Store guideline 4.8, i.e. for a NATIVE
  app that offers third-party login. The web app / PWA never needs it. Wiring
  it is the easy half (Apple Developer Program → App ID + Services ID +
  Sign-in key; Firebase → Authentication → Apple; then an OAuthProvider
  "apple.com" beside the existing Google provider around line 22577, a second
  button, and `https://appleid.apple.com` in the CSP `frame-src`/`connect-src`).
  The hard half — DO NOT ship Apple sign-in without it:
  - `entitlements/{uid}` is keyed by uid, so a player who bought packs with
    Google and later taps Apple lands in a NEW, empty account and loses their
    paid games. Account linking has to land in the SAME change, not after.
  - Apple Private Relay ("Hide My Email") means `token.email` becomes
    `…@privaterelay.appleid.com`, which breaks recognising a customer by email
    in the manual activation-code flow.
  - `admins/{uid}` is uid-keyed too: signing in with Apple on the owner's own
    device drops admin until that uid is added.
  - Apple returns the display name ONCE, on first sign-in only. Persist it then
    or it is gone.

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

- **Cover-shrink migration — BUILT (.205) but NOT RUN (owner deferred,
  2026-08-01).** Published category covers are still the old ~600 KB base64
  blobs inside the parent docs, so the picker's cold load still downloads
  ~10 MB; the admin button «⚡ ضغط صور الفئات» (next to the backup button)
  rewrites them to 480px/~95 KB in place. Owner should press «⬇ نسخة
  احتياطية» first. Optional: raise the cap to 576px (~+30 KB each) for zero
  softness on 3× screens. New publishes are already capped automatically.

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

## Landing page (`preview/`, live at izzbah.com/preview/)

Single self-contained page, same palette and type system as the game. Marked
`noindex` and nothing links to it — it is a draft the owner opens directly.

- **`preview/sync.mjs` is the source of truth for anything factual.** Run
  `node preview/sync.mjs` after ANY change in the admin panel: it pulls every
  category, its real question count and the totals from Firestore and rewrites
  `preview/data.js`. Names, counts and the counters all read from it, so the
  page cannot drift from the game. Only each category's one-line description
  and tag are hand-written (the `COPY` map in index.html, keyed by category
  id); a newly published category still appears with a neutral fallback.
- Covers live in `preview/cat/` (`-t` grid, `-l` showcase, `-s` board header),
  resized from the Firestore originals. Regenerate them when artwork changes.
- `preview/shots/` are REAL screenshots of the game. Capturing them has THREE
  silent failure modes, all of which produce a plausible-looking but wrong
  screenshot:
  1. Firebase blocked → the game falls back to the old bundled
     `assets/img/cat-*.webp` covers and shows only the 20 built-in categories.
     Inject the published categories first.
  2. Google Fonts unreachable → the game renders in Tahoma fallback instead of
     Cairo. Serve the woff2 files SAME-ORIGIN and inject `@font-face` pointing
     at them; a `data:` URI is refused because the game's CSP says
     `font-src 'self' https://fonts.gstatic.com`. Neither
     `document.fonts.check()` (true for a fallback match) nor
     `document.fonts.size` (counts registered, not loaded) proves anything —
     the only honest test is a WIDTH PROBE: render a string in Cairo 900 and
     in a nonsense family, and fail the capture if the advances match.
  3. Forcing `data-theme=dark` → the game's default is LIGHT; that is what
     players see. Don't set it.
  Question images live only in the CLOUD copy of a question, so a question
  screenshot taken offline has no photo.
- Type system is the game's, verbatim: Cairo for all text, Lalezar for display
  numbers only, Aref Ruqaa for the عِزبة wordmark only. The faces are
  SELF-HOSTED in `preview/fonts/`, subset to the glyphs the page uses (212 KB,
  no request leaves the site). If you add copy in a NEW script or language,
  re-subset — a missing glyph renders as .notdef. The check is in
  `scratchpad/glyphs.mjs`: walk every visible text node and diff against the
  subset's character set.
- Category tiles deep-link into the game with that category preselected, using
  the same `#g=` payload the in-game share button builds.
- `#admin` opens an authoring mode for the copy. It is LOCAL only — no auth, no
  backend; it hands you JSON to paste back. Visitors are unaffected.

## Standing conventions in this repo

- Single self-contained game file: `game-mobile.html` (Arabic, RTL). Firebase
  compat SDK, project `izzbahgame`, BLAZE plan. One Cloud Function is deployed:
  `mintUploadUrl` (in `functions/`) mints a presigned R2 upload URL so admins
  upload video/voice straight from the game to the `izzbah-media` R2 bucket
  (`VIDEO_UPLOAD_SETUP.md` has the runbook). The rest runs client-side.
- Develop on the designated feature branch, merge `--no-ff` into `root`
  (the GitHub Pages branch), push, and verify the smoke workflow is green.
- Bump `IZZBAH_BUILD` on every deploy — **and the `CACHE` name in `sw.js`
  with it** (they must match exactly; `tests/swsync.mjs` fails CI otherwise).
  This drifted once (.204–.207 shipped with a .203 cache name) and phones kept
  launching the stale shell a deploy behind.
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
