# In-game video upload (direct to R2) — one-time setup

Goal: inside the admin question editor, tap **⬆️ ارفع فيديو/صوت**, pick a file,
watch the progress bar, done. The file uploads **browser → R2 directly**; a tiny
Cloud Function only hands out a short-lived, admin-only upload link. Your R2
free-bandwidth is unchanged.

Do these **once**. After that, adding a video is just pick-file-and-wait.

---

## 0. Prerequisites (~2 min)

You need the Firebase CLI on your computer, signed in to the `izzbahgame`
project:

```bash
npm install -g firebase-tools
firebase login
cd /path/to/izzbah-game     # the repo folder (has firebase.json)
firebase use izzbahgame
```

## 1. Create an R2 API token (~3 min)

Cloudflare dashboard → **R2** → **Manage R2 API Tokens** → **Create API token**:

- **Permission:** Object Read & Write
- **Bucket:** scope it to the bucket your videos live in (recommended)
- Create, then copy the two values it shows **once**:
  - **Access Key ID**
  - **Secret Access Key**

Also note, from the R2 overview page:
- **Account ID** (the hex string; it's also the start of your S3 endpoint
  `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`)
- **Bucket name**
- **Public base URL** — the address players already load videos from, e.g.
  `https://pub-xxxxxxxx.r2.dev` **or** your custom domain like
  `https://media.izzbah.com` (no trailing slash needed).
  *(If the bucket isn't public yet: R2 → your bucket → Settings → enable the
  Public Development URL, or connect a custom domain. Players must be able to
  read the files to watch the videos.)*

## 2. Store the 5 secrets (~3 min)

Run each and paste the value when prompted:

```bash
firebase functions:secrets:set R2_ACCOUNT_ID
firebase functions:secrets:set R2_ACCESS_KEY_ID
firebase functions:secrets:set R2_SECRET_ACCESS_KEY
firebase functions:secrets:set R2_BUCKET
firebase functions:secrets:set R2_PUBLIC_BASE
```

- `R2_ACCOUNT_ID` → your account id (hex)
- `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` → from step 1
- `R2_BUCKET` → the bucket name
- `R2_PUBLIC_BASE` → the public base URL (e.g. `https://pub-xxxxxxxx.r2.dev`)

## 3. Allow browser uploads (CORS on the bucket) (~2 min)

Cloudflare → R2 → your bucket → **Settings → CORS Policy** → paste:

```json
[
  {
    "AllowedOrigins": [
      "https://izzbah.com",
      "https://www.izzbah.com",
      "https://mqasimalshibli-dev.github.io",
      "http://localhost:8000"
    ],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

Without this, the browser blocks the upload (you'd see a CORS error). Playback
is unaffected — this only governs the upload PUT.

## 4. Deploy the function (~2 min)

```bash
firebase deploy --only functions
```

First deploy also enables the required Google Cloud APIs — approve if asked.
The function is `mintUploadUrl`, region **us-central1** (the game's default —
don't change it, or the client won't find it).

## 5. Verify (~1 min)

1. Open the game at https://izzbah.com, sign in with your **admin** Google
   account, open the ⚙ admin area.
2. Edit any category question → in a media slot tap **⬆️ ارفع فيديو/صوت**.
3. Pick a **small** test clip. The button should show `⏳ جارٍ الرفع… NN%`
   then `✅ تم الرفع`, and the video attaches.
4. Save, then play that question to confirm it plays for a normal (non-admin)
   viewer.

Done — from now on, adding a video is just steps 2–3 of "Verify."

---

## Notes & troubleshooting

- **Who can upload:** only accounts in the Firestore `admins` collection. The
  button is hidden for everyone else, and the function rejects them even if they
  poke at it. Non-admins keep the old inline (small files) + paste-a-link path.
- **The paste-a-link button still works** for everyone — nothing was removed. If
  the function is ever down, you can always fall back to a direct R2 link.
- **"خدمة الرفع غير جاهزة"** → the Functions SDK didn't load or the function
  isn't deployed yet. Re-run step 4.
- **"الرفع متاح للمشرفين فقط"** → your signed-in account isn't in `admins/{uid}`
  (see `ADMIN_SETUP.md`).
- **Upload starts then fails (CORS in the console)** → step 3 not applied, or the
  live domain isn't in `AllowedOrigins`.
- **Costs:** the function is tiny (a signed-URL mint per upload). The video bytes
  never pass through it — they go straight to R2 — so bandwidth stays on R2's
  free egress.
- **Extra hardening (optional):** in `functions/index.js`, set
  `enforceAppCheck: true` on the callable once you've confirmed uploads work, so
  only the real game app can call it.
