# Firebase Storage — full-quality question images (optional)

By default the game stores question/answer pictures **inside the Firestore
document** as base64 text. That works, but Firestore documents are capped at
**1 MiB**, so image-heavy categories get auto-compressed to fit.

Turning on **Firebase Storage** makes the game upload each picture as a real
file and store only a short URL in Firestore — so images keep **full quality**
with **no size limit**, and category documents stay tiny.

The game already supports this: **once Storage is enabled, publishing
automatically uploads images and uses URLs.** If Storage is off, it silently
falls back to the old base64-in-Firestore behavior — nothing breaks either way.

## One-time setup

### 1. Upgrade to the Blaze (pay-as-you-go) plan
New Firebase projects require the **Blaze** plan to use Storage. Blaze still
includes a free monthly allowance (~5 GB stored, ~1 GB/day downloads), so at a
trivia game's scale you'll almost certainly stay at **$0** — but a card is
required and usage above the free tier is billed.

- Firebase Console → ⚙ **Settings** / bottom-left **Upgrade** → **Blaze**.
- **Recommended:** Google Cloud Console → **Billing → Budgets & alerts** → set a
  small budget (e.g. $1) so you're emailed if anything is ever charged.

### 2. Enable Storage
- Firebase Console → **Build → Storage → Get started**.
- Pick a location (any; closest to your players is fine). This creates the
  default storage bucket.

### 3. Deploy the Storage security rules
Use the rules in **`storage.rules`** (public read; only admins may upload
image files under `categories/`, gated by the same `admins/{uid}` doc as
Firestore):

```bash
firebase deploy --only storage
```
(or paste `storage.rules` into Firebase Console → **Storage → Rules → Publish**.)

That's it. Reload the game while signed in as an admin and publish a category
with images — the pictures upload to Storage and the category document now holds
URLs instead of base64.

## Notes
- **Existing images** stay as base64 until you re-upload them: edit the
  question, pick the image again, and publish. New uploads use Storage
  automatically.
- Images are uploaded to `categories/<categoryId>/...`. Re-publishing overwrites
  the same paths, so it won't pile up duplicates.
- App Check (if enforced) also covers Storage — keep it in Monitoring until
  you've confirmed uploads work, then switch to Enforce.
