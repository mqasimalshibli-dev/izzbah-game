# عِزبة (Izzbah) — notes for future sessions

## ⛔ Publishing a category can DESTROY its pictures — read this first

**823 question images across 8 categories were wiped on 5–6 August 2026 and
recovered from backup on the 7th.** Everything below is the lesson; the guard is
in at build .268 but the invariant is easy to break again.

- **The invariant.** A category sitting in memory is media-LITE: build .209
  replaces every question `image` with `""` at the state boundary and sets
  `__lite`; only `hydrateMediaInto()` puts pictures back, and only for a
  category about to be played or opened in the editor. So **an empty image on
  an unhydrated category means "not loaded", NEVER "delete".**
- **How it broke.** The duplicate remover and the smart-scan distractor editor
  save by republishing the WHOLE category from that in-memory copy. `cloudPublish`
  wrote `image: ""` over each stored photo, and its diff loop read
  "big base64 → empty" as a change worth committing. One distractor edit
  destroyed a category's entire media. Nothing warned; nothing was reversible.
- **The guard (.268).** `cloudPublish` computes
  `mediaTrusted = !cat.__lite || hydratedCats.has(cat.id)` and routes both
  images through `keepImg()`, which falls back to the STORED value when an
  untrusted incoming one is empty — so the diff then writes nothing at all.
  `adminSetCommunityQuestions` takes a `mediaTrusted` argument and, on the
  untrusted path, reads the doc first and merges. Fixed at the choke point on
  purpose, so a future caller cannot reintroduce it. `tests/mediawipe.mjs`
  pins it, including that a DELIBERATE clear on a hydrated category still
  works — a fix that made deletion impossible would be its own bug.
- ⚠️ The hazard was already documented for the community editor (see «COMMUNITY
  question media is LAZY too» below) and simply was not carried across to a new
  write path. Any NEW code that publishes a category must state which of the
  two it is: hydrated-and-authoritative, or lite-and-must-not-blank.

**Recovery runbook, if it ever happens again.** All of it is in `tools/`:

1. **Backups are what saved this — not PITR, which was disabled.** Daily
   scheduled backups with 98-day retention existed in Cloud console →
   Firestore → **Disaster Recovery**. Check there BEFORE concluding anything is
   unrecoverable; the first pass of this incident wrongly wrote the data off.
2. Restore the chosen backup to a **new** database (`restore-aug5`). Firestore
   cannot restore over `(default)`, which is what you want: the live database
   holds legitimate changes made after the snapshot.
3. `node tools/restore-media.mjs --source <db>` — dry run, then `--apply`.
   It fills blanks only, never overwrites a live image, and skips any question
   whose text or answer differs from the backup (doc ids are positional, so id
   alone could put a photo on the wrong question). `tests/restoretool.mjs`
   executes it end-to-end against a stubbed Firestore.
4. `node tools/touch-categories.mjs --apply` — **without this the pictures stay
   invisible however good the data is.** A restore needs THREE writes to reach
   a device: the question docs, each category's `updatedAt` (the media cache
   key in `loadCategoryMedia`), and **`meta/catalog.rev`** — the client
   short-circuits the entire catalogue on that one number
   (`if (freshRev === cachedRev && haveCats) return;`) and otherwise never
   re-reads the category docs at all. This last one cost an hour of "still no
   pictures" after a fully successful restore.
5. Delete the restored database afterwards — it is billed as a second database.

**Performance note for any bulk Firestore job from Cloud Shell:** reads cost
~1.5–2s each in round-trip latency, on the LIVE database as much as a restored
one. Sequentially that projected 302 minutes for ~1900 reads; at 12 concurrent
readers it took 12. A job that looks hung is usually just serial — measure with
`--time` before assuming it is broken, and never use queries where point
lookups will do (`orderBy(__name__).limit(20)` burned the full 300s deadline
and returned nothing, while `getAll()` of the same docs worked fine).

## Two roles now, not one: `admins/{uid}` and `editors/{uid}` (build .304)

There used to be exactly ONE flag, and it granted content, credits,
announcements, community moderation and the power to appoint more admins. The
owner wanted to hand a helper question-authoring alone. `editors/{uid}` is that,
and it is **NOT a weaker grade of admin** — it is an independent flag.

- **Why independent.** Making it `isAdmin || isEditor` anywhere general would
  have handed an editor everything the ~23 `state.isAdmin` checks grant, the
  first of which is unlimited free play. `state.isAdmin` stays **false** for an
  editor; each capability is opted in BY NAME. There are exactly five gates in
  the client, all spelled `canEditContent()`: the R2 media upload path, opening
  the content panel, opening the panel chooser, and the entry button from
  either role. `tests/editorrole.mjs` counts them.
- **What an editor may do:** add a question, change one, delete one, upload its
  media, publish. That is the whole list.
- **The boundary is `firestore.rules`, not the UI.** `isEditor()` grants inside
  exactly TWO collections — `categories/{catId}` (its `questions` list plus the
  `/questions` subcollection) and `meta/{doc}` (the rev bump). The test slices
  the rules into match blocks and fails if it appears anywhere else; a stray
  `|| isEditor()` in `/codes` or `/entitlements` would hand out money and would
  read like a one-word typo in review.
- ⚠️ **`editors/{uid}` is admin-write.** An editor must never appoint an editor.
- ⚠️ **The rev bump is not optional.** Every publish ends in `bumpCatalogRev()`,
  and the client short-circuits the whole catalogue on that number — so without
  `meta/{doc}` an editor's questions would save and reach nobody. Worse, that
  call is `.catch(() => {})`, so it would fail SILENTLY and the publish would
  still look successful.
- ⚠️ **Category identity is pinned field-by-field, not with `affectedKeys()`.**
  `cloudPublish` uses a plain `set()`, so a field the in-memory copy does not
  carry gets DELETED; equality-with-a-default (`get('color','')`) catches that
  and is far easier to reason about. `description` is deliberately NOT pinned —
  `normalizePublishedCategory` never carried it, so every publish already drops
  it and pinning it would reject an editor on any category that still has one.
- **"He can't delete all the questions"**: the parent rule refuses to let an
  editor leave a category empty AND caps one publish at 5 removals (the app
  deletes one at a time and auto-publishes, so that is generous). ⚠️ Residual,
  accepted: `cloudPublish` commits the `/questions` subcollection in EARLIER
  batches than the parent, so these rules stop a category being *emptied*, not
  someone driving Firestore directly to delete its media docs. Catalogue text
  always survives; images are covered by the backup runbook above.
- ⚠️ **`mintUploadUrl` needed a Cloud Function change** (it gated on
  `admins/{uid}`), so **media upload for editors does not work until that
  function is redeployed** — and the deploy traps in the `resolveEmails` note
  below apply verbatim (pull in Cloud Shell first; the masked secret prompt
  crashes there). Text and pasted images work without it.
- **UI locks are ergonomic only.** `applyEditorLocks()` hides 12 buttons by id;
  the category head, the صيانة strip and the select column are hidden by CSS on
  `body.is-editor-only` instead — those regions are rebuilt on every keystroke,
  sort and delete, and a lock applied per-node is only as good as the last
  render that remembered it.
- **Appointing one is IN THE APP (build .305):** admin panel → «الصلاحيات» →
  «المحرّرون». Lists the current editors with a remove button, and adds by
  searching the players the admin can already read. Adding by EMAIL is the
  whole point — a 28-character uid tells the owner nothing about whose row it
  is, the same problem .220 fixed for the subscriptions panel — so it reuses
  `emailIndex()` (sales → orders → the usage stamp) plus `resolveEmails` and
  the SAME `authEmailCache`, so opening both panels only asks Auth once.
  - The person must have SIGNED IN once or their uid does not exist; the empty
    state says so instead of leaving the owner hunting for a name.
  - A pasted raw uid is accepted, but only offered when the search finds
    nothing, so it never competes with the by-email flow.
  - ⚠️ `editors/{uid}` now splits its read rule: `get` for any signed-in user
    (each account reads its OWN role at sign-in), `list` for **admins only** —
    the panel enumerates the collection, and an open list would hand every
    signed-in user the set of staff uids. Do NOT collapse them back into
    `allow read`.
  - The `email` stored on the doc is only so the list can NAME the row. The
    permission is the document EXISTING, exactly as with `admins/{uid}`;
    nothing reads that field for access.
  - ⚠️ `tests/adminorg.mjs` asserts every panel group holds ≥2 entries.
    «الصلاحيات» is a deliberate group of ONE (so it reads as its own concern
    and `applyAdminGroups` can hide it from an editor in one move), so it is
    listed in that test's `SOLO_GROUPS`.
- **The old manual route still works:** the person signs in once, you read
  their uid from the
  admin centre's players list, and you add `editors/<uid>` in the Firebase
  console — same as `admins/{uid}`. There is no in-app UI for it.

## Cold boot paints from `meta/index` (build .309)

The catalogue read was the single biggest item in a cold boot — ~1.6 MB gzipped
across 39 parent docs, **88% of it cover images**. Firestore's web SDK has no
field projection, so there is no way to read a parent doc WITHOUT its cover;
that is why the projection is a separate document.

- **What changed:** on a cold boot ONLY (no device cache, not an admin), the
  client reads `meta/index` first and paints the picker from it, then the full
  `categories.get()` runs exactly as before and replaces those entries.
  Measured on a throttled harness at the real catalogue size: **picker at 4240ms
  → 268ms**. `tests/catboot2.mjs`.
- ⚠️ **The index is a PAINTING aid, never the authority.** Entries carry no
  questions — only a `count` — and are marked `__idx`. If `meta/index` is
  missing, stale or denied, the read fails to `false` and nothing changes.
- ⚠️ **Three choke points had to learn about it**, and missing any one empties
  the picker on a first visit:
  - `categoryHasQuestions()` — an `__idx` entry is playable if `count > 0`.
    Without this every tile reads "coming soon" and `activeCategories()`
    filters them all out.
  - `normalizePublishedCategory()` returns a FIXED shape, so `__idx` and
    `count` have to be named there or they are silently dropped by
    `applyPublished`.
  - `startGame()` refuses to build a board from an `__idx` entry and waits for
    the real read (20s ceiling). It returns BEFORE anything is charged and
    re-enters once, so a credit cannot be spent twice.
- **The write side already existed** (.294): `lqipFor()` at `LQIP_DIM = 32`,
  WebP q0.6, ~1.3 KB each, ~60 KB for 40 categories, behind
  «🗂️ بناء فهرس الفئات».
- **The publish path rebuilds it automatically (build .310).** A successful
  `cloudPublish`, and either category-delete path, calls
  `scheduleIndexRebuild()`. The button stays for bulk maintenance.
  - ⚠️ **DEBOUNCED (4s), and that is not a nicety.** `autoPublishAdmin` fires on
    every question add/edit/delete, so an immediate rebuild would write a
    ~60 KB document on every keystroke-driven save. `tests/catindex.mjs` pins
    that a burst of six publishes produces exactly ONE write.
  - ⚠️ **Placeholders are memoised by (id, cover)** in `lqipMemo`. Without it
    each rebuild re-encodes all 39 covers through a canvas — a decode storm in
    the middle of typing. Changing artwork still recomputes exactly one.
  - ⚠️ **Silent on failure.** It is derived, cosmetic data and the full read is
    always the authority, so a failed rebuild must never surface as a publish
    error. Note `meta/index` is admin-write, so a content EDITOR's publish is
    denied here — all that goes stale is a question COUNT (editors cannot
    change a name, cover, colour or order), for the moment before the full read
    corrects it.
- **What is still on the table:** this removes the covers from the *critical
  path*, not from the *bill* — the full read still transfers 1.6 MB, just
  behind the paint. Making it a true saving means question text going lazy per
  category too, which is the same shape as the .209 media change and a much
  bigger job.

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

- **Cover-shrink migration — no longer needed (verified 2026-08-02).** The note
  that used to sit here said published covers were still ~600 KB blobs totalling
  ~10 MB. That is now WRONG and was left stale: reading all 39 parent docs
  straight from the Firestore REST API shows the largest cover is **92 KB**, the
  median **53 KB**, and **not one is over 150 KB** — every category is already
  inside the 95 KB `COVER_BUDGET`. Covers total **1.87 MB** stored (~1.4 MB
  gzipped on the wire). Pressing «⚡ ضغط صور الفئات» would re-encode them for no
  gain. Before quoting any figure like this again, re-measure — the public
  `categories` collection is readable unauthenticated over REST, so it takes one
  script.

- **«⚡ ضغط صور الأسئلة» is BUILT but not worth running either (verified
  2026-08-02).** Scanned all 4401 published questions over REST: 3060 stored
  images, 160 MB in total, **average 54 KB, and exactly ONE over the 300 KB cap**
  (`cars/q81 answerImage`, 318 KB). The button still works and is safe to press,
  but it would rewrite one image. It also never affected boot — question images
  are lazy-loaded (.209) and only cost bytes once a game actually starts on that
  category.

- **Boot weight — measured, and where it now goes (build .217, 2026-08-02).**
  Measured with a throttled Playwright harness (CDP network emulation + 4× CPU)
  against the REAL 39 Firestore parent docs. Cold first visit, time until the
  category list is ready: **3G 13.0s → 7.7s, slow 4G 4.8s → 3.1s**, fast 4G and
  wifi unchanged at ~1.6s (those are CPU-bound on parsing the shell, not
  network-bound). Warm repeat visits were already ~0.9s on every connection and
  download nothing. Two things caused the drop:
  - `izzbah-logo.png` (892 KB) was the splash AND welcome logo and
    `izzbah-mark.png` (372 KB) the top-bar mark — **1.24 MB of PNG on the first
    paint of every cold boot**, more than the shell and the Firebase SDK
    combined. Now WebP at q95, 149 KB for both, SSIM 0.993/0.997 composited on
    the app background. The master PNGs stay in the repo (never fetched).
  - Cairo shipped as six per-weight faces whose files were **byte-identical** —
    a boot painting four weights downloaded the same 30 KB Arabic subset four
    times. It is a VARIABLE font, so it is now one face per unicode-range across
    `font-weight: 400 900`; the 15 duplicate files are gone (~190 KB/boot).
  - `tests/bootweight.mjs` holds a byte budget for every asset the shell
    references (and bans PNGs on the boot path); `tests/fontweight.mjs`
    width-probes that the six weights still render differently, which is the
    only way to catch a variable font silently collapsing to one weight.
  - What is LEFT: the catalogue read is ~1.6 MB gzipped, ~88% of it the 39
    covers, and it is now the single biggest item in a cold boot. Shrinking the
    covers further is NOT the answer (they are already at the cap). The fix, if
    the owner wants it, is to stop putting covers in the boot read at all: a
    `meta/index` doc carrying id/name/order/colour/count plus a ~7 KB thumbnail
    per category (≈250 KB for all 39, measured by re-encoding the real covers),
    with the full 92 KB cover hydrated lazily like question media already is.
    Needs a publish-path change, a backfill button, and a rules entry.

- **Fonts are SELF-HOSTED in `assets/fonts/` (build .216).** 13 woff2 files
  (Cairo variable, Lalezar, Aref Ruqaa × arabic/latin/latin-ext), pulled from
  Google Fonts with their `unicode-range` splits kept verbatim, so a browser
  fetches only the ranges it renders (~5 files for an Arabic session). The
  `@font-face` block is inlined in `<head>`; CSP is now `font-src 'self'` /
  `style-src 'self' 'unsafe-inline'` with no font CDN allowed at all.
  `tests/bootblock.mjs` fails CI if a third-party font reference or CSP
  allowance reappears, and width-probes that each family really renders
  (`document.fonts.check()` is useless — it returns true for a fallback).
  These are FULL faces, not the landing page's 212 KB subsets: the game shows
  cloud and player-typed Arabic, so a subset would render .notdef.

- **NEVER add a render-blocking third-party `<link rel=stylesheet>` to
  `<head>` (build .215).** The Google Fonts sheet was one, and with
  fonts.googleapis.com unreachable first-contentful-paint and DOMContentLoaded
  never fired at all — blank screen, game never started, until the browser gave
  up (~13s) or forever if the request hung. It now loads `media="print"` and is
  promoted to `all` onload. `tests/bootblock.mjs` fails CI if a blocking
  third-party stylesheet reappears (`<noscript>` is exempt).

- **COMMUNITY question media is LAZY too (build .213).** A community category
  is ONE doc with its questions and their base64 images inline, and an ADMIN
  loads the approved pool + their own + EVERY pending submission — 39 MB
  retained for 20 pending, which is why the Safari crash hit admin accounts
  hardest. `normalizeCommunityCategory` strips question media at the state
  boundary (all three apply* paths funnel through it) and marks `__lite`;
  `hydrateMediaInto()` fetches it back for a game or the editor. ⚠️ Opening the
  community EDITOR must hydrate first and VERIFY it worked — saving
  republishes the whole doc, so an editor opened over a stripped copy wipes the
  author's pictures.

- **Question media is LAZY (build .209).** Boot reads ONLY the parent category
  docs — which already carry a text-only copy of every question — so the
  picker and board run on ~5 MB. Question/answer images live in the
  `/questions` subcollection and are fetched per game by
  `hydrateCategoryMedia()` just before the board draws, then merged into the
  question objects IN PLACE (so every `q.image` reader downstream is
  unchanged). Loading them all at boot measured **541 MB** of JS heap at the
  real catalogue size and was killing the tab on iOS Safari ("A problem
  repeatedly occurred"). Do NOT reintroduce an eager read of `/questions`.
  A failed media read must resolve to `null` = "unknown" and cache NOTHING —
  returning an empty list would re-create the old "no pictures" bug.
  ⚠️ This laziness is also what made the 5–6 August wipe possible: it is why a
  category in memory has empty images that a publish must never write back.
  See the ⛔ section at the top before touching any code that publishes.

- **The question font is CAPPED AT THE ANSWER's (build .289).** The owner asked
  for this repeatedly; before .289 the fitter GREW a short clue toward a 220px
  ceiling, so a three-word question rendered several times the size of the
  answer and, in landscape, was clipped. `--answer-size` is now published as a
  variable (one clamp, in `:root`, re-declared in the short-landscape media
  query) and `fitQuestionText` resolves it through a hidden probe — reading the
  custom property gives back the clamp TEXT, not the px it computes to.
  ⚠️ `FILL` (the share of the card the text may occupy) was 0.25, the owner's
  own value from 2026-08-04, chosen when nothing else bounded the size. With
  the cap in place 0.25 became the BINDING limit and pulled a short question
  BELOW the answer — the opposite of the request. It is 0.36 for worded cards
  (0.30 with a picture, which is reserving room for the photo).
  ⚠️ Several tests asserted the OLD contract — "a short question is bigger than
  a long one", "≥ 30px", "≥ 40px". Those are now non-strict / measured against
  the answer size, because two questions that both fit legitimately share the
  cap. Do not re-tighten them to absolutes: the answer is only ~20px on a short
  landscape phone.

- **The board card must be a FLEX COLUMN (build .289).** `#game
  .board-category-card` is `display: flex; flex-direction: column;
  justify-content: flex-end`. The points grid is its only in-flow child, so as
  a BLOCK it sits at the top — directly over the absolutely-positioned
  `.board-card-title`, which shares its z-index and loses on DOM order. The
  visible symptom is "the category names are gone and the cells are on top".
  ⚠️ It shipped broken in .287 because a `sed -i` used to TEMPORARILY revert an
  unrelated library rule also matched this line, and the restore pattern was
  anchored (`$`) so it did not match back. Never verify a temporary revert by
  grepping the rule you meant to change — `git diff` the whole file.
  `tests/boardpill.mjs` pins it by hit-testing the title, and skips in portrait
  where the game's own rotate-to-landscape overlay covers the board.

- **The turn pill (build .289; WHOLE-PILL press in .292).** Maroon lozenge, team
  PHOTO in a ring, label, swap icon; `renderTurnBoxes` builds it and replays a
  hand-over animation.
  **The whole pill hands over the turn, not just the arrows** (owner, .292): a
  40px circle at the end of a 230px lozenge is a poor target on a phone being
  passed round a room, and people tapped the name and got nothing. So
  `data-turn-switch` sits on the CONTAINER — the delegated handler finds it with
  `closest()` from wherever you tapped — and the icon is a decorative `<span>`.
  ⚠️ It must NOT stay a `<button>`: a button inside a `role="button"` is invalid,
  gives one action two tab stops, and browsers may reparent it out of the pill.
  ⚠️ A `role="button"` DIV gets NO Enter/Space for free, so there is an explicit
  `keydown` handler; Space must `preventDefault()` or the page scrolls.
  ⚠️ `aria-label` but deliberately **no `title`** — the styled-bubble helper only
  adopts controls whose visible text is wordless, and this pill has words, so a
  title escapes it and shows the raw native tooltip the app was cleaned of.
  ⚠️ Testing it: hit-test with `elementFromPoint` rather than dispatching
  straight at the node — "the click never reaches the pill" is the whole failure
  mode. In PORTRAIT the game's own rotate-to-landscape overlay legitimately
  covers the board, so `tests/boardpill.mjs` detects that and checks only the
  keyboard path there.
  ⚠️ Three later rules (`#game .turn-box`, `#questionPage/#answerPage
  .turn-box`) used to repaint its background translucent-white, silently
  undoing the design on the board — the one screen it matters on.
  ⚠️ The short-landscape rule used to place `.turn-photo` and `.turn-switch` at
  explicit GRID coordinates. Wrapping the photo in `.turn-avatar` left those
  coordinates addressing nothing and the pieces spilled out of the pill. It is
  one flex row now, at every size, so markup and layout are not coupled.

- **`#globalBack` clears the safe area with MARGIN, not padding (.289).**
  `padding-bottom: calc(11px + env(safe-area-inset-bottom))` kept the pill's
  width but grew its height by the home indicator, so on those phones «رجوع»
  rendered as a circle rather than an oval.

- **Sketch filter, current tuning (.299 → .301) — this SUPERSEDES the
  thickness numbers in the .288 note below.** Constants today:
  `SKETCH_LINE_PX = 1.15`, `SKETCH_THICKNESS = 1.0`, `SKETCH_DETAIL = 1.0`,
  ramp `SKETCH_INK_START/FULL/GAMMA = 1.8 / 8.0 / 0.8`.
  ⚠️ The real fault behind "too heavy" was never the ink threshold. Sigma was a
  FRACTION OF THE FRAME WIDTH, so a 1280px clip blurred at ~15.5px and drew fat
  blobs. .299 made it an absolute line weight in output pixels
  (`sigma = SKETCH_LINE_PX * thickness * SS`), which is stable because the
  working size always lands between ~1150 and 1280px (MAXW 1280, SS doubles
  anything under 800).
  ⚠️ .300 then chased the same complaint with the ink ramp (5 / 15 / 1.3) and
  went too far — 1.9% ink on a real clip, players reduced to specks. The owner's
  words were "too white and it has less details". .301 put it back: γ **below 1
  lifts** weak edges towards ink, and 1.8 / 8 / 0.8 gives ~5.2% while the
  strokes stay thin. Keep the two knobs separate — `SKETCH_LINE_PX` is stroke
  WEIGHT, the ramp is how MUCH is drawn.
  ⚠️ **Ink percentage is a useless metric here.** Swept across sigma 0.45 → 4.8
  on real footage it stays 2–4% throughout. It cannot tell a pencil drawing from
  a handful of blobs. Judge line CHARACTER.
  ⚠️ **.303 — "make it just a tad bit lighter", γ 0.80 → 0.95.** That is the ONE
  constant that changed. There are two ways to lighten this filter and only one
  of them is safe; measured against a 12-step contrast ramp, comparing total ink
  against FULL BLACK (which is where the detail lives):
  γ 0.80 → 10.17% ink / 4.44% black; **γ 0.95 → 9.43% / 4.37%**; γ 1.10 →
  9.16% / 4.36%; γ 0.80 with the ramp slid up → 9.18% / **3.88%**.
  Only the last row loses full black — sliding `lo`/`hi` up DELETES the faintest
  strokes, which is precisely how .300 became "too white and it has less
  details". γ just presses each surviving stroke less hard.
  ⚠️ γ SATURATES — 1.10 buys almost nothing over 0.95. If lighter is asked for
  again, this lever is spent: go to `hi` next, never `lo`.

- **"There is flashing while the filter runs" — it was the PAGE, not the video
  (build .306).** ⚠️ Read this before chasing a flicker in this filter again.
  None of `sketchifyVideo`'s canvases (`grey`, `blurA`, `blurB`, `glCanvas`,
  `out`) or its `<video>` are ever appended to the DOM, so nothing of the clip
  is on screen during an encode. What pulsed was the app: measured at the real
  1280×720 working size, the encode starved the main thread to **6 rAF ticks a
  second with blocks up to 309ms**, and a page that cannot paint for a third of
  a second reads as the whole screen juddering.
  Three things I RULED OUT first, all measured, so nobody re-measures them:
  codec-noise sensitivity (a static source drifts 2.11→2.34% ink, no jumps), a
  blank opening frame (t=0 is identical to t=1.0), and per-pixel boiling of the
  line work (zero pixels flip between consecutive frames on a static scene at
  HD). ⚠️ Note the first two probes measured a 480px source and proved nothing:
  at ≤800px wide `SS = 2`, and the downsample averages exactly the flicker you
  are looking for. Probe this filter at ≥900px or not at all.
  The fix is all load, no look — `tests/sketchvideo.mjs` re-checks ink grading
  and the hard-edge test to prove the output did not move:
  - **The render is capped to 30fps**, the rate `out.captureStream(30)`
    actually samples. Measured on a 61Hz display: **117 renders → 60** for the
    same clip, i.e. half the work was being thrown away by the recorder.
  - **One video decode per rendered frame, not two.** `cg.drawImage(video)`
    into a grayscale canvas, then both blurs are taken from THAT. Also removes
    a real one-frame glitch: two separate `drawImage(video)` calls could
    straddle different source frames and hand the shader a difference between
    two DIFFERENT pictures. Moving `grayscale(1)` off the blur passes is exact,
    not an approximation — both are linear ops in the same colour space.
  - **Progress text throttled to 5/s** from up to 60/s; each write rebuilt an
    Arabic-digit string and forced a layout inside the hot loop.
    `finishRecording()` sends a final reading so the bar still lands on ٩٩٪.
  ⚠️ CI's software GL is already below 30fps, so the cap is invisible in a
  wall-clock measurement there. The render-rate test skips itself under 45Hz
  rather than passing on a vacuous comparison. What is LEFT, if this is ever
  not enough: one render still costs ~150ms in software because the two
  `blur()` passes are CPU canvas filters at full size. Moving the blur into the
  existing WebGL pass is the real fix, and it is a rewrite of the shader.

- **The filter lives in `createSketchRenderer()` now (build .308).** Extracted
  from `sketchifyVideo` so the ENCODE and the on-screen PREVIEW are ONE
  implementation. ⚠️ Never inline the pipeline into a caller again — a preview
  that drifts from the encode is worse than no preview, and the whole reason
  the owner asked for one was to stop guessing before a realtime encode and an
  upload. The factory owns the working size, both blur canvases, the WebGL pass
  and the mask stamp; `render(video)` paints one frame into `out` and schedules
  nothing. `tests/sketchvideo.mjs` compares the two paths on ink statistics
  (not bytes — the encoded clip has been through a codec): measured 5.9% vs
  5.9% ink and 2.0% vs 1.9% solid.
- **«🎨 معاينة بالفلتر» in the trim modal (build .308).** Plays the CHOSEN
  RANGE through the filter with the masks applied, by appending the renderer's
  own output canvas over the picture — literally the frames the encoder would
  write, not a copy. Capped at 30fps for the same reason the encode is.
  ⚠️ It REFUSES to start before `videoWidth` is known rather than guessing a
  size, which would preview a different crop than the encode makes.
  ⚠️ `stopFilterPreview()` must run BEFORE `trimCtx` is dropped in
  `closeMediaTrim` — otherwise the rAF loop keeps a WebGL context and a decoded
  video alive for the rest of the session. Entering mask mode stops it too;
  drawing boxes and watching the result at once makes no sense, and the preview
  already shows the masks.
- **Sketch ink: `SKETCH_INK_FULL` 8.0 → 10.0 (build .308, "make it a bit
  lighter").** γ was spent — .303 measured 1.10 as buying almost nothing over
  0.95 — so this is the next lever, exactly as that note predicted. Raising
  `hi` means a stronger edge is needed to reach solid black, so black becomes
  grey WITHOUT deleting anything, because `lo` does not move. Swept on the same
  12-step contrast ramp: hi 8 → 9.65% ink / 4.57% black; **hi 10 → 9.13% /
  2.92%**; hi 12 → 8.17% / 2.08%; hi 14 → 7.15% / 1.58%. Note the shape at
  hi 10 — ink barely moves (−5%) while solid black falls by a third. That is
  "lighter", where the .300 mistake (raising `lo`) was "emptier". This lever
  has real authority and has room left: 12 and 14 are there if asked again.

- **Watermark mask in the trim modal (build .307).** «🩹 غطِّ العلامة المائية»
  — drag up to 3 boxes over the video, and they are painted as PAPER onto the
  finished line art. Offered on the SKETCH path only, and that is not a
  limitation to lift: every other upload is stored byte-for-byte as it arrived,
  so there is no pass in which a mask could be painted.
  - ⚠️ **Painted AFTER the shader, never onto the source before it.** Masking
    the source looks more thorough and is worse: a flat patch has a hard
    boundary, difference-of-Gaussians inks boundaries, and the result is a
    crisp rectangle drawn around the thing being hidden. Paper over the output
    can only remove. The edge is feathered (2% of the short side) so strokes
    fade instead of being guillotined along a straight line.
  - ⚠️ **Boxes are FRACTIONS of the frame, never pixels** — the encode
    downscales to `MAXW` 1280, so a box measured against a 1080p preview lands
    somewhere else entirely.
  - ⚠️ `videoPaintRect()` exists because a `<video>` LETTERBOXES: the element's
    box and the picture's box are different rectangles, and measuring against
    the element puts every mask off by the bars. Re-run on `loadedmetadata`,
    `loadeddata` and `resize`.
  - ⚠️ `openMediaTrim`/`closeMediaTrim` no longer do `stage.innerHTML = ""` —
    that would delete `#trimMaskLayer`, after which every lookup returns null
    and masking is silently dead for the session. They remove the media only.
  - The stamp is built ONCE per encode and composited each frame; the boxes do
    not move, so rebuilding the feather 30×/s would be waste in the one loop
    that must stay cheap (see the render cap in .306).
  - `addTrimMask()` holds the cap and the too-small rule so the pointer handler
    and the test share ONE implementation — a test cannot drag across a video
    that never decoded. `tests/mutevideo.mjs` covers the UI;
    `tests/sketchvideo.mjs` proves the pixels: an unmasked semi-transparent bug
    inks at 10.6% and a masked one at 0.0%, with no ink ring where it was and
    the action untouched at 9.6% either way.
  - Worth knowing: this filter makes watermarks MORE visible, not less. DoG
    answers to edges, not brightness, so it discards a bug's flat interior and
    keeps its outline — a faint ghost logo comes out as a confident drawing of
    that logo. Measured above.

- **The sketch path is the ONE place a trim really cuts the file (build .302).**
  Owner's question: "does the full clip get uploaded? even when cut?" It did.
  Everywhere else a trim is deliberately a `#t=start,end` fragment honoured at
  playback (`applyClipRange`) because nothing is re-encoded — but the sketch
  path re-encodes regardless, so `sketchifyVideo` now takes `{start, end}`,
  seeks before the recorder rolls, and stops at `end`. A six-second answer out
  of a sixty-second clip now uploads six seconds.
  ⚠️ `performUpload` must then DROP the `#t=` — `sketchFragAfterBake()` does it.
  The range is in the file; leaving it on the URL trims the already-trimmed clip
  a second time and the player seeks past its end and shows nothing. `#mute`
  is kept (redundant — no audio track is attached at all — but harmless).
  ⚠️ Progress is reported over the CHOSEN range. Computed over the whole
  duration it would stall at ~50٪ on a half-length trim and read as a crash.
  ⚠️ The seek has a 4s fallback that starts from wherever the element is: a
  source whose seek never reports back would otherwise hang the upload forever.
  Bitrate is no longer a flat 4.5 Mbps (a photographic-video number that made a
  64s clip 16 MB). `sketchBitrate()` budgets by area — `SKETCH_BITS_PER_PX =
  0.06` at 30fps, ~1.66 Mbps at 1280×720, floor 700 kbps, ceiling 3 Mbps. Don't
  push it much lower: thin hard-edged strokes are the worst case for a codec and
  starving it rings around every line.
  `tests/sketchvideo.mjs` builds a source with the SAME amount of detail
  throughout but moves it from the top of the frame to the bottom halfway
  through, so the size comparison measures duration rather than content while a
  single output frame says where the encode started. ⚠️ Take the «start» cut at
  70%, not 50% — the test's 33ms frame loop drifts, so seeking to exactly dur/2
  can land on the last frame of the first half and fail for nothing.

- **The «من الي سجل؟» sketch filter is TONAL (build .288 — read this before
  touching it).** The owner said "too heavy" TWICE. The first attempt (.286)
  only tuned the knobs of a BINARY filter and did not fix it, because a binary
  filter cannot draw a crowd lightly: `step()` makes every edge that clears the
  threshold pure black, and stadium crowd texture clears it everywhere. No
  threshold or stroke width tunes that out — measured, repeatedly.
  The shader now maps edge STRENGTH to ink strength (`smoothstep(lo,hi)` then a
  gamma), so fine crowd texture lands as pale grey while strong large-scale
  edges stay dark. `SKETCH_INK_START/FULL/GAMMA` are the ramp.
  ⚠️ **The thickness went UP (0.6 → 1.8), reversing .286.** With binary ink a
  wider blur merged speckle into fat black blobs, so thin strokes were the only
  lever; with tonal ink it is the opposite — a wider blur pushes fine texture
  below the detector's band where it reads as pale grey, and the surviving
  large edges get STRONGER. Measured on a crowd source: 0.6 → 1.8 lifts crowd
  luminance 184 → 241 while subject ink RISES 0.7% → 1.5%. The two levers only
  work together; changing one alone makes it worse.
  ⚠️ A wide blur also erases genuinely thin features — the pitch lines go with
  the crowd. That is a real trade, accepted for a category whose job is to show
  the play without naming the scorer.
  ⚠️ Tuning needs a source with REAL crowd statistics. A smooth mid-grey texture
  inks only 5% and would send you tuning against nothing; full-range
  high-contrast speckle reproduces the reported 35%.
  `tests/sketchvideo.mjs` no longer asserts "two-tone" — that would pin the very
  thing that caused this. It asserts mostly-paper, that ink is GRADED (mid-tones
  exist; collapse the ramp and it fails), and that a hard edge is still drawn.

- **Superseded: the .286 "tuned light" pass.** The first
  version shipped `thickness 1 / detail 1` and the owner's verdict on real
  footage was "too heavy": a stadium crowd came out as a solid black mass with
  the players lost in it — measured at 35% of the frame inked, peaking near 40%.
  Now `SKETCH_THICKNESS = 0.6, SKETCH_DETAIL = 0.4`.
  ⚠️ **Thicker is not the way to remove crowd noise** — raising thickness merges
  the speckle into fat blobs, which measures lower but LOOKS heavier. Thin
  strokes are what turn filled shapes into outlines. Lowering the threshold
  alone is no good either: it deletes the players faster than the crowd.
  ⚠️ A third lever — decimating the frame before edge detection so fine texture
  falls below the detector's scale — was built, measured and REMOVED. It only
  bites at extreme decimation, where it takes the subject with it (subject ink
  4.1% → 1.6% for a crowd drop of 32% → 19%). Don't rediscover it.
  `tests/sketchvideo.mjs` guards the weight by measuring the STROKE WIDTH over a
  known hard edge, not an ink percentage — percentages move by a tenth between
  the two tunings and are noisy, the band roughly halves. Two earlier probes
  (interior of a big block, then of a player-sized bar) passed against the old
  heavy defaults, i.e. measured nothing; always revert the constants and confirm
  the guard goes red.

- **Video mute is TWO different things behind one checkbox (build .286).**
  «كتم صوت المقطع» in the admin trim modal. For an ordinary video nothing is
  re-encoded (same reason trimming is a fragment): it writes **`#mute`** on the
  URL and `applyClipPlayback` honours it — the audio is still in the file, so
  this is PRESENTATION, not a secret. For a «من الي سجل؟» clip the sketch filter
  is already re-encoding, so the audio track is simply never attached and the
  sound never leaves the device — which matters, because the commentary names
  the scorer. The modal's sub-label says which one you are getting.
  ⚠️ `mediaFragment` matches `#t=start,end` at the END of the string, so the
  mute flag is written AHEAD of it (`#mute&t=1.5,4.0`) and the parser accepts
  `[#&]t=`. Append mute after the trim and every clipped question silently
  stops being clipped. `tests/mutevideo.mjs` pins the grammar, both mechanisms,
  and that the checkbox resets between clips.

- **The category counter is a RING, and it FLOATS (builds .281 / .282).**
  «اختر فئاتك» used to carry a text line reading «N / 6 مختارة». It is now
  `#catRing` (`.ccr`), and since .282 it lives in **`#catDock`** — a fixed
  cluster beside the floating «رجوع» holding the ring plus **«متابعة»**
  (`#catGoFloat`), which appears from the first pick and delegates to
  `#goTeams`. The in-page proceed button stays where it was, below forty
  cards; the floating one exists because that is off-screen for the whole pick.
  Pressing the ring slides up **`#catPeek`** (.283) — a small panel listing the
  chosen categories by cover + name, in selection order. Each row is a BUTTON
  that deselects its category (.284), via `deselectCategory(id)`, which does the
  same three things un-ticking the card does (drop from `randomizedCats`,
  `saveGameSettings`, `renderCategories`). It closes on an outside click,
  Escape, a second press, or leaving the screen; clicks INSIDE it are excluded,
  or scrolling the list would dismiss it.
  ⚠️ A row's handler MUST `stopPropagation()`. The row re-renders itself away,
  so by the time the click reaches the document's outside-click handler its
  target is detached — `closest("#catPeek")` returns null for an orphan node
  and the panel would close on every single removal.
  It is driven by the single entry point `setCategoryRing(count, overrideHint)`: an SVG arc
  around the digit, gold while choosing, GREEN with a tick at six (`is-done`),
  RED past six (`is-over`). `is-over` is unreachable by tapping — the picker
  refuses a seventh — but a shared `#g=` link or a restored game can carry one,
  so it must stay visually distinct from a completed six.
  ⚠️ The driver holds its OWN copy of the circumference (`CCR_CIRC = 150.8`,
  = 2πr for the `r="24"` circle) and fills the arc by shortening
  `stroke-dashoffset` against the `stroke-dasharray` in the markup. Edit the
  radius or the dash-array alone and the arc still animates smoothly, still
  looks plausible, and simply fills to the WRONG fraction while the digit keeps
  reading correctly. `tests/catring.mjs` pins the offset per count, in both
  themes, and asserts the three agree.
  ⚠️ `toArabicDigits` is an IDENTITY function (`value => String(value)`, around
  line 8845) — the game deliberately shows Western digits everywhere. Do not
  "fix" a counter that returns `0` instead of `٠`; do not hand-write `٦` in a
  string beside a `toArabicDigits()` call either, or the two disagree the day
  it stops being an identity.
  ⚠️ **The dock's chrome is DARK IN BOTH THEMES** (it matches `#globalBack`),
  so every colour inside the ring is chosen against a dark ground and must not
  be re-themed. The ring's first version inherited the light page's brown
  (`#a9772a`) and vanished the moment it left the cream header.
  ⚠️ `#catDock` is positioned from the **measured** `#globalBack` rect
  (`layoutCatDock`, called from `setCategoryRing`, on resize and on
  `document.fonts.ready`) — never a hard-coded offset. «رجوع» is one of the
  strings an admin can reword from the in-game text editor, and it is also
  wider once Cairo replaces the fallback; either would drop the ring on top of
  it. The RING is the dock's first child so that in RTL it lands against
  «رجوع» and «متابعة» grows away to its left — reversed, the ring would shift
  sideways every time the proceed button appeared.
  ⚠️ The ring deliberately has **no `title`**. The styled-bubble helper only
  adopts controls whose visible text is wordless, and the ring carries sr-only
  text, so a title would escape it and show the raw native tooltip the app was
  cleaned of. Tapping the ring toasts the same words instead.
  ⚠️ Traps in testing this, all of which produce a green-looking test that
  measures nothing: `page.evaluate` given a FUNCTION-AS-STRING with no argument
  returns the function rather than calling it (every field comes back
  `undefined`); `body` is transparent — the page colour is a
  `radial-gradient`, so `backgroundColor` reads `rgba(0,0,0,0)` and any contrast
  check against it silently compares with pure black; and a chrome colour
  checked for luminance ALONE passes when it is dark and fully transparent,
  i.e. when there is no chrome at all — assert the alpha too.

- **«أربعة خيارات» can be switched off per category (build .218).** The admin
  category head has «🚫 تعطيل «أربعة خيارات»» next to «إخفاء الفئة». It is
  GLOBAL and reversible, keyed by category id in **`config/noChoices`**
  (`{map:{catId:true}, updatedAt}` — public read, admin write, mirrored in
  `izzbah-nochoice-cats-v1` for offline). It fits the deployed `/config` rules,
  so **no firestore.rules change was needed**; do NOT move it onto the category
  doc, whose rule field-locks the key set. It hides the helper only — the
  authored wrong answers stay stored and come straight back when it is switched
  on again. Categories that are choice-free by their own nature (word guess,
  reactions, «من الي سجل؟», «الأقرب يفوز», emoji, «قول غيرها») show the button
  disabled and labelled, rather than a toggle that appears to do nothing.
  ⚠️ `hidesMultipleChoice()` was ALSO the gate for "don't fetch pictures for
  this category". Those are different facts, so the media question now has its
  own `usesSpecialAnswerMedia()` (word guess + reactions only) — folding the new
  switch into the image-fetch gate would silently disable image fetching on any
  ordinary picture category the moment multiple choice was turned off.
  `tests/nochoices.mjs`.

- **Question text was being cut off on EVERY question (fixed .218).** Reported
  as "some questions get clipped behind «إظهار الإجابة»" — the button was not
  the cause. Cairo's Arabic glyphs (ج ح ع م) draw below the line box, so
  `scrollHeight` sits ~**0.25em** above `clientHeight` at every font size.
  `fitQuestionText()` treated anything over 1px as overflow, so its shrink loop
  could never be satisfied and drove EVERY question — three words or thirty —
  to its 15px floor, where the card's `overflow: hidden` cut the tail off. The
  same effect was already documented and allowed for in the EMOJI branch; plain
  text never got the allowance. Three changes, all needed: `.question-text` now
  reserves `padding-block: .26em` for the ink (em, so it scales with whatever
  size the fitter picks); the fitter's own-box test tolerates 0.6em (between
  0.25em of glyph overhang and ~1.4em for a real extra line); and the box is
  `overflow-y: auto`, not `hidden`, so a question that genuinely cannot fit at
  the floor stays readable instead of being silently truncated. A 3-word
  question now renders at ~95–130px instead of 15px. `tests/qclip.mjs` measures
  the cut-off at four viewports × four question lengths.
  ⚠️ `tests/helpbar.mjs` asserted `short >= long` for the font size, which
  passed happily while BOTH sat on the floor — it is now pinned to an absolute
  minimum. Beware that shape of assertion.

- **The admin centre names players by EMAIL, not uid (build .220).** A
  28-character uid told the owner nothing about whose row it was. The obvious
  source — `users/{uid}.email` — is **owner-read-only by rules and stays that
  way**: an admin genuinely cannot read it, and it should not be opened up
  (that doc also holds the player's entire saved-game blob). Two sources the
  admin CAN read:
  - `sales/{id}` — the PERMANENT purchase record, carrying both `uid` and
    `email`. This is what actually names past customers, and needs **no rules
    change**. (`orders/{uid}` is also read, but it is only a QUEUE — fulfilling
    an order DELETES the doc — so on its own it names almost nobody. Getting
    that wrong is why .220 still showed uids.)
  - the `usage/{uid}` mirror, which each player now stamps with their own
    email. This needs `'email'` added to that rule's `hasOnly` list.
  `emailIndex(usage, orders)` merges the two (the player's own stamp wins) and
  feeds BOTH the players list and the codes list; search matches email or uid;
  the uid stays on the row as `title` + copy-on-click, since it is still what
  support and the Firestore console need. A row with no email anywhere falls
  back to the uid in a muted style (`.prem-row-id-uid`).
  - **`resolveEmails`, a Cloud Function (build .222)** — uid → email read
    straight from **Firebase Auth** via the Admin SDK, admin-gated on
    `admins/{uid}`. This is the ONLY way to name a player RETROACTIVELY: a
    gift-code redeemer has no sale, no order, and no stamp until they next open
    the game. The panel asks about just the rows still showing a raw uid,
    caches the answers for the session (including the empty ones, so a deleted
    account is not re-asked), and re-renders once. It returns ONE field per uid
    and never touches `users/{uid}`. **DEPLOYED and confirmed working
    2026-08-03** — the panel shows emails, including retroactive ones. If it is
    ever undeployed the call rejects and the panel falls back to uids.
    Deploying it took four failed attempts; the traps, for next time:
    - The owner deploys from **Cloud Shell** (`~/izzbah-game`), which is a
      SEPARATE clone. It does not follow GitHub — `git pull` there FIRST, or
      the deploy packages stale source and reports
      `Skipped (No changes detected)` while looking completely successful.
    - `defineSecret` is resolved for the WHOLE codebase before `--only` filters
      anything, so `--only functions:resolveEmails` still prompted for
      `PAYMENT_WEBHOOK_SECRET` (declared by the frozen `paymentWebhook`).
    - That masked prompt CRASHES in Cloud Shell (`Error: An unexpected error has
      occurred`) — it cannot read masked stdin. Create the secret out of band
      instead: `printf 'value' | gcloud secrets create PAYMENT_WEBHOOK_SECRET
      --data-file=- --project=izzbahgame`, then deploy. The value stored today
      is a throwaway random string; `paymentWebhook` itself is NOT deployed and
      the real Thawani secret replaces it when payments are wired.
  ⚠️ **Transition hazard, guarded:** a usage write also carries `gamesUsed`. If
  the new rules are not published yet, a write carrying `email` is rejected —
  which would silently stop the billing counter. `pushUsage` therefore drops the
  field and retries once on `permission-denied`, then sets `usageEmailAllowed =
  false` for the session. Emails simply fill in later, once the rules land.
  ⚠️ `rebuildBalances` REWRITES usage docs, so it now carries the email across.
  Without that, one press of «إعادة بناء الأرصدة» would blank the whole list.
  ⚠️ The codes list interpolates the redeemer into `innerHTML`. A uid was safe;
  an email from `orders` is PLAYER-written and only type-checked by the rules,
  so it is `escapeHtml`-ed. `tests/adminemail.mjs` covers all of it.

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
- **Covers: `python3 tools/covers.py` rebuilds them all** (`-t` grid tile,
  `-l` showcase; `-s` board headers belong to `preview/shots/` and are left
  alone). `--dry-run` prints the before/after table without writing.
  ⚠️ **The resolution ceiling is 480px and no script can lift it.** The masters
  are gone; a category's artwork now exists ONLY as the `image` field of its
  Firestore doc, which the publish path caps at a 95 KB JPEG. Measured
  2026-08-08 over all 40: the largest is **480×480**, nothing exceeds 480px on
  either side, and 4 categories (foreignMoviesOnly, khareef, omaniFootball,
  whoAmI) have no cloud artwork at all and fall back to `assets/img/cat-*.webp`.
  So "export the covers bigger" is not a thing that can be done — a real
  increase needs either the original artwork or a super-resolution model.
  What the rebuild DID fix (2026-08-08): the old files were re-encodes of
  already-resized WebPs, so every one carried two generations of loss; fourteen
  were blown up from a 480px source and left soft (up to 202 KB each); five
  were SMALLER than the source (252×315 from a 349px original), throwing away
  pixels that existed. They are now built from the original Firestore JPEG
  bytes with a scale-matched unsharp mask, WebP q95 (`-l`) / q90 (`-t`) — the
  owner asked for as high as it goes. 8.5 MB of showcase art, 2.1 MB of tiles;
  q92 would save ~20% for about 1 dB if that ever needs trimming.
  ⚠️ **Build the file for the BOX it is drawn into, not for its own aspect
  ratio.** The first rebuild preserved each source's proportions — a 480×480
  cover became 960×960 — and the covers got visibly WORSE, which the owner
  caught. The page draws them with `object-fit: cover` in a 4/5 frame, so the
  browser then had to crop AND stretch 960→1116; the files being replaced were
  already 4/5 (819×1024, 1000×1250) and needed no browser scaling at all. They
  are now pre-cropped to 4/5 at 1080×1350, except the wide ones the page shows
  whole, which keep their shape and are sized so the CONTAINED render is 1:1.
  ⚠️ And measure the comparison through the REAL render path. The A/B that
  green-lit the bad version fitted both files with `contain`, which is not how
  the page draws them, so it showed an improvement that did not exist on
  screen. Emulate `object-fit: cover` into the true device-pixel box.
- **The showcase is a PINNED, BOUNDED scroll carousel (2026-08-08).** It was
  scroll-driven with `sec.style.height = CATS.length * 34 + "svh"` — 1360svh at
  40 categories, i.e. fourteen screens of showcase before the rest of the page.
  The scroll drive is wanted; the fourteen screens are not. Now `.sc-stage` is
  `position: sticky` and the section's extra height is a budget of `SPOT` ×
  `STEP` svh.
  ⚠️ **`SPOT` is `CATS.length` — the scroll must reach EVERY category.** The
  first attempt capped it at 8 and the owner immediately caught it ("it scrolls
  only to 8"). What made the old showcase interminable was the RATE, not the
  count: 34svh per category is ~3 wheel notches each, forty times over. At
  `STEP = 10` one notch is one category and all forty pass in ~4.9 screens.
  Shorten the budget by lowering `STEP`, never by dropping categories.
  ⚠️ **A pinned section is a toll gate, so it needs a way out** — the owner's
  next report was "you can't bypass the scroller without scrolling all the
  categories". `STEP` is 6 (≈3.4 screens) AND `.sc-skip` («تخطّي الفئات ↓»,
  under the bar, inside the pinned stage) jumps straight to `#all`. Any future
  change that keeps the pin must keep an escape.
  The pin then releases and the page carries on; the arrows and ←/→/Home/End
  still work, and the moment the reader touches the track the scroll driver
  steps aside. Traps found the hard way, all pinned by `tests/showcase.mjs`:
  - `overscroll-behavior-x: contain` on the track, or a swipe off the end
    chains into the page and, on iOS, into the browser's back gesture.
  - RTL `scrollLeft` is negative in some engines and positive-reversed in
    others: the focused slide is read from bounding rects, and the scroll
    direction is *measured* once, never assumed.
  - The driver must set an ABSOLUTE scroll position. A relative `scrollBy` off
    live rects compounds against the smooth re-snap animation — the carousel
    settled on slide 4 when the scroll said 7.
  - `scroll-snap-stop: always` (right for a swipe) also clamps a PROGRAMMATIC
    jump to one snap point, so Home/End crawled. Far jumps turn snapping off
    for the one instant scroll.
  - Once the reader touches the carousel, the scroll driver must step aside for
    good, or the next scroll event yanks the track back and the two fight.
  - The ambient `::before` is inset -25% horizontally = 360px of overhang on a
    1440px window; unclipped it widened the DOCUMENT and knocked every centred
    `.wrap` sideways. `.showcase{overflow-x:clip}` — `clip` is the only value
    that leaves the other axis visible.
  - The stage needs `grid-template-columns: minmax(0,1fr)` and the wrap
    `min-width:0`: an auto grid track is sized from max-content, so `.wrap`'s
    1180px max-width kept the track 1140px wide on a 390px phone — and
    `overflow-x: clip` hid the damage from any page-width assertion.
  - `‹ ›` are Bidi_Mirrored; in an RTL run the browser flips them and both
    arrows point the wrong way. Geometric triangles are not mirrored.
  - Wide covers are shown whole over a blurred copy of themselves (`.cat-art.fit`)
    rather than cropped: a 480×270 in the 4/5 frame keeps only 45% of its width,
    and the subject is usually in the part that goes.
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

- Single self-contained game file: **`index.html`** (Arabic, RTL) — it is the
  SITE ROOT since build .291; it was `game-mobile.html` until then, and a great
  many notes above still say so. Firebase
  compat SDK, project `izzbahgame`, BLAZE plan. One Cloud Function is deployed:
  `mintUploadUrl` (in `functions/`) mints a presigned R2 upload URL so admins
  upload video/voice straight from the game to the `izzbah-media` R2 bucket
  (`VIDEO_UPLOAD_SETUP.md` has the runbook). The rest runs client-side.
- **The game moved to the site ROOT (build .291, 2026-08-09).** `izzbah.com`
  used to be a redirect stub that bounced every visitor to
  `/game-mobile.html` — a wasted round trip on every cold boot, and the reason
  Google indexed the long URL and filed both "Page with redirect" and
  "Duplicate, Google chose different canonical". `game-mobile.html` and
  `game.html` are now the stubs, pointing the other way. Four traps, all
  pinned by `tests/roothome.mjs`:
  - ⚠️ **The stubs must forward `location.hash`** — it is the entire payload of
    a shared `#g=` game. A `<meta http-equiv="refresh">` cannot carry a
    fragment, so the redirect is a `location.replace` in `<head>` (it runs
    during parsing and beats the refresh); the refresh stays only as the no-JS
    fallback. Test the payload END-TO-END, not the URL: the game consumes the
    hash on load (`history.replaceState`), so `location.hash` is empty by the
    time you look.
  - ⚠️ **The manifest `id` must NOT move with `start_url`.** `start_url` is now
    `../../`, but `id` stays `../../game-mobile.html` verbatim — it is the PWA's
    identity, and changing it makes every phone that already installed عِزبة
    treat this as a SECOND app rather than an update. `id` need not resolve to
    a real page.
  - Share links are built from `shareBaseUrl()`, which trims a trailing
    `index.html` over http(s) only — under `file://` (the Electron build) that
    would leave a bare directory.
  - The wrappers copy the game by name: `mobile/copy-web.js`,
    `desktop/electron-main.js` + `desktop/package.json`, and the
    `cp` in `.github/workflows/build-desktop.yml`. `sitemap.xml` lists the root
    and nothing else — listing a redirect is what invited the reports.
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
  until the category is exhausted, then recycles the least-recently-seen ones.
  Owner re-confirmed on 2026-08-02: only NEW games shuffle — a replay keeps its
  own board, because free replays plus a reshuffle would turn one purchase into
  unlimited fresh content.

- **Boards stopped being "locked in sets" (build .219, 2026-08-02).** Reported
  as "the questions should shuffle always… the same set is found exactly on
  another device". New games were already fine — measured: two fresh devices,
  and a device that had pulled another's cloud blob on sign-in, all produced
  boards with **0/15 shared tiles**. The break was at the far end.
  `pickUnseen`'s exhausted-category fallback returned the single strict
  least-recently-seen question, and serving one bumps it to the end of the
  recency list — a perfect round-robin. With N questions in a tier, game N+1
  came back **byte-identical** to game 1, N+2 to game 2, forever (verified 4/4
  before, 0/4 after). It now picks at RANDOM across the least-recently-seen
  HALF, which keeps the guarantee that mattered — a question just served sits
  in the recent half and cannot come straight back — while making recycled
  boards differ. `tests/qshuffle.mjs`.
  ⚠️ `tests/savedgamefreeze.mjs` asserted the strict-oldest pick; it now
  asserts the property (from the older half, never the recent half) instead.
  ⚠️ **`tests/qshuffle.mjs` was FLAKY and went red in CI on 2026-08-08, on a
  commit that did not touch the game at all.** Once selection is random, an
  assertion on one draw is a coin toss with extra steps: the cycle check used 4
  questions per tier (so 2 candidates, p = 1/32 per board) and demanded ZERO
  repeats in 4 comparisons — about a 12% false-failure rate — and the
  fresh-device check capped overlap at 4 of 15 when chance alone gives 0.75 on
  average and reaches 5 once in ~1,500 runs. Both are now sized so a healthy
  run effectively cannot fail (8 per tier / ≤1 repeat in 8 → ~3e-5; overlap ≤6
  → ~4e-6) while the bug they exist for still fails them outright — verified by
  reverting `pickUnseen` to the strict-oldest pick, which scores 8/8 repeats
  and 8 distinct boards against thresholds of ≤1 and ≥12. When adding an
  assertion over randomised output, work out the false-failure rate first.

- **Some categories are too thin to shuffle — a CONTENT gap, not a bug.**
  Measured against the live catalogue: «دين» and «ميمز» hold 5 questions each,
  one per tier, so every device gets a byte-identical board every single game
  and a repeat on game 2. «جلسة حريم» is [2,2,2,2,1] and «من الي سجل؟» is
  [5,3,3,4,2] — first repeat on game 2 and 3. No selection logic can fix this;
  the categories need more questions. 12 of 196 published tiers hold exactly
  one question. By contrast «تاريخ» ([20,29,29,27,27]) shows no repeat inside
  13 consecutive games.

- **`izzbah-seen-v1` is no longer silently dropped from the cloud sync.** When
  the `users/{uid}.data` blob crossed 700 KB, `cloudBlob()` deleted the whole
  play history — which resets question freshness for that account, so every
  category looks unplayed and questions start repeating. It now shaves the
  OLDEST signatures from the biggest categories until it fits, and only drops
  the key outright if nothing meaningful is left. (In practice the budget is
  not reached today: `seen` is trimmed to 120 KB, `progress` maxes near 80 KB
  at the current catalogue size, saved games ~100 KB.)

- **The cloud sync MERGES instead of overwriting (build .311, 2026-08-14).** Two
  devices signed into the same account used to be last-write-wins: `schedulePush`
  wrote this device's whole blob over whatever was there, so a phone that had
  been offline could erase games the tablet had just finished, and vice versa.
  `schedulePush` is now a `db.runTransaction` read-modify-write — it reads
  `users/{uid}.data`, runs `mergeBlob(mine, theirs)`, writes the result, and then
  applies the merged blob back into THIS device's localStorage (under
  `applying = true`, followed by `reloadFromStorage()`), so both devices converge
  on the same state without a reload. `tests/blobmerge.mjs` simulates two devices
  pushing out of order.
  - Per-key rules live in `MERGE_RULES`: saved games union by id (`charged` is
    sticky — once true it can never go false, or a replay would become free on
    the other device; the copy that still has a `frozen` board wins; newest-first;
    cap 200), `izzbah-seen-v1` and `izzbah-progress-v1` and `izzbah-coach-v1`
    union, `izzbah-games-used-v1` takes the MAX, `izzbah-free-game-v1` and the
    legal consent are true-wins, `izzbah-code-balance-v1` keeps the better grant.
    Anything with no rule keeps the LOCAL value (per-device settings — theme,
    sound — should not follow you across devices).
  - Rules of thumb for any key later added to `KEYS`: accumulating list → union;
    one-way counter → max; one-way flag → true wins; per-device preference →
    leave it out of `MERGE_RULES`.
  - ⚠️ `shaveBlob(o)` was split out of `cloudBlob()` **because shaving has to
    happen AFTER merging**. Shaving the local blob first and then merging can push
    the result back over `CLOUD_BUDGET` and the write fails outright.
  - ⚠️ `mergeBlob` is wrapped so a corrupt stored value can never throw away the
    write — any key whose merge throws falls back to the local value.
  - This fixes divergence, not simultaneity: two devices playing the SAME game at
    the same moment still interleave. The owner has accepted that (friends sharing
    an account is fine); a single-device lock was considered and rejected.
