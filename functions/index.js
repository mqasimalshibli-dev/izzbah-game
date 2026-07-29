// عِزبة — Cloud Functions
// ---------------------------------------------------------------------------
// mintUploadUrl: hands the (admin-only) game client a short-lived, presigned
// PUT URL for the Cloudflare R2 bucket, so a video/audio file uploads
// browser → R2 directly (never through this function — no size/time limit) and
// the game just stores the resulting public URL on the question.
//
// Why a function at all: R2 credentials must never live in the browser. This
// function holds them (as deploy secrets), checks the caller is a signed-in
// admin (admins/{uid} in Firestore, the same gate the game + rules use), then
// signs one upload URL scoped to a single object key. Nothing else can write.
// ---------------------------------------------------------------------------
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

admin.initializeApp();

// Set once with:  firebase functions:secrets:set R2_ACCOUNT_ID   (etc.)
const R2_ACCOUNT_ID = defineSecret("R2_ACCOUNT_ID");
const R2_ACCESS_KEY_ID = defineSecret("R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = defineSecret("R2_SECRET_ACCESS_KEY");
const R2_BUCKET = defineSecret("R2_BUCKET");
const R2_PUBLIC_BASE = defineSecret("R2_PUBLIC_BASE"); // e.g. https://pub-xxxx.r2.dev  (no trailing slash needed)

// The only extensions the game plays. Keeps the bucket to media, mirrors the
// client-side MEDIA_URL_RE so a signed URL can never mint a non-media object.
const ALLOWED = /\.(mp4|webm|ogg|ogv|mov|m4v|mp3|wav|m4a|oga)$/i;

// The Content-Type is derived HERE from the (whitelisted) extension and the
// upload is signed with it — the caller's claimed type is never trusted. R2
// serves objects with their stored type on a public domain, so echoing an
// arbitrary client string would let an upload be served as, say, text/html.
const EXT_TYPES = {
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm",
  ogv: "video/ogg", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  oga: "audio/ogg", m4a: "audio/mp4",
};

exports.mintUploadUrl = onCall(
  {
    secrets: [R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE],
    // App Check is enforced by the game elsewhere; we gate on admin identity
    // here. Flip to enforceAppCheck: true once you've confirmed uploads work.
    cors: true,
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    // Same source of truth as the game and the Firestore rules.
    const adminDoc = await admin.firestore().collection("admins").doc(uid).get();
    if (!adminDoc.exists) throw new HttpsError("permission-denied", "Admins only.");

    const rawName = String((request.data && request.data.filename) || "").trim();

    // Slugify to a safe object key tail; keep the extension so the public URL
    // still ends in .mp4/.mp3/… (the game validates media by extension).
    let safe = rawName.toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(-80) || "clip";
    if (!ALLOWED.test(safe)) throw new HttpsError("invalid-argument", "Unsupported file type.");
    // A fully non-ASCII name (e.g. Arabic) slugs away to just ".m4a" — give it
    // a readable base so the object key isn't a bare extension.
    if (safe.charAt(0) === ".") safe = "clip" + safe;

    const ext = safe.slice(safe.lastIndexOf(".") + 1).toLowerCase();
    const contentType = EXT_TYPES[ext];
    if (!contentType) throw new HttpsError("invalid-argument", "Unsupported file type.");

    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const key = `game-media/${ts}-${rand}-${safe}`;

    const client = new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID.value()}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID.value(),
        secretAccessKey: R2_SECRET_ACCESS_KEY.value(),
      },
    });

    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: R2_BUCKET.value(), Key: key, ContentType: contentType }),
      { expiresIn: 600 } // 10 minutes to complete the upload
    );

    const base = R2_PUBLIC_BASE.value().replace(/\/+$/, "");
    return { uploadUrl, publicUrl: `${base}/${key}`, key, contentType };
  }
);
