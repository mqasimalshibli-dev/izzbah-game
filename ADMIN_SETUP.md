# Admin content manager (CMS) — setup

The game has an **admin page** (a small ⚙ button on the welcome screen, visible
only to admins) where admins can create/edit/delete official categories and
their questions, answers, points, and images. Published content is stored in
Firestore and loaded by **all players** under the **ألعابنا** (Our Games) tab.

Access is enforced by **Firestore security rules** — not just the UI — so a
non-admin cannot write content even if they poke at the page in devtools.

## One-time setup

### 1. Deploy the security rules
The rules in `firestore.rules` add two collections: `admins/{uid}` and
`categories/{catId}`. Deploy them:

```bash
firebase deploy --only firestore:rules
```
(or paste `firestore.rules` into Firebase Console → Firestore → Rules → Publish).

### 2. Bootstrap the first admin (manual, one time)
Admins are listed in the `admins` collection, keyed by the user's Firebase Auth
UID. The first admin must be added by hand (the rules only let existing admins
add new ones).

1. Sign in to the game once with the Google account that should be the admin.
2. Find that account's **UID**: Firebase Console → Authentication → Users → copy
   the User UID.
3. Firebase Console → Firestore → start collection `admins` → add a document
   whose **Document ID is that UID**, with one field:
   - `email` (string) — the admin's email (for your reference).

That's it. Reload the game while signed in with that account and the ⚙ admin
button appears on the welcome screen.

### 3. Add more admins (optional)
Once you're an admin you can add others from the admin page, or repeat step 2 in
the console for each new UID.

## Notes
- **Images** are auto-compressed to small embedded data-URLs (same as team
  photos) so each category stays well under Firestore's 1 MiB/document limit.
- Each published category lives in its own `categories/{id}` document, so the
  whole library can grow without hitting the per-document size limit.
- Keep **App Check** in Monitoring until you've confirmed admin writes work,
  then switch to Enforce.
