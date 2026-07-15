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

## Agent toolkit (connected — .claude/agents + .claude/workflows)

Repo-level agents and named workflows exist for the content pipeline. HARD
RULE from the owner: **never change existing questions or pictures** — every
audit/review is REPORT-ONLY (findings go to the owner), and the authoring
pipeline only drafts NEW banks; publishing anything remains a separate,
explicit owner-approved step.

- Workflow `author-category` — draft → adversarial fact-check panel →
  curate, for ONE new/empty category. args: `{name, guidance?, perTier?,
  strict?}` (strict auto-enables for religious topics: 3 refuters,
  zero-tolerance). Invoke when the user says e.g. "generate questions for
  مواقع في عمان".
- Workflow `audit-content` — one `content-auditor` per published category,
  every flagged issue confirmed by two `fact-checker` agents. args:
  `{categories?: [ids]}`, omit = whole catalog.
- Workflow `review-images` — one `image-reviewer` (vision) per category over
  the stored question/answer photos; returns a flagged list only.
- Agent `community-reviewer` — pre-screens ONE pending community submission
  (caller passes the data in); recommendation only, the admin approves in-game.
- Agent `insights-analyst` — turns stats/codes/usage data (caller passes it
  in) into ranked, zero-cost content/business actions.
- Agents `question-writer` / `fact-checker` — the building blocks the
  workflows use; also usable standalone for one-off questions.

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
