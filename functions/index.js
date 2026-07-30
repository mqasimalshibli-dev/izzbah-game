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
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { getPack, toBaisa } = require("./lib/packs");
const { grantDecision, entitlementUpdate, GRANTED, FAILED, PENDING } = require("./lib/grant");

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

// ---------------------------------------------------------------------------
// PURCHASES — pay, and the games land in your account instantly.
//
// Flow: createCheckout (callable, signed-in) writes a PENDING purchase and
// returns its id → the client sends the player to the provider → the provider
// calls paymentWebhook → the webhook grants entitlements/{uid} → the game's
// existing onSnapshot listener unlocks the packs live, on screen.
//
// No code is minted and no email is sent anywhere in here. Activation codes
// stay what they are: a manual, admin-only tool for gifts and fixes.
//
// The security model already existed — firestore.rules lets NO user write
// their own entitlements, and the Admin SDK used here bypasses rules — so this
// is the only path by which paid content can be granted.
// ---------------------------------------------------------------------------

// Shared secret the provider sends back with its callback. Set once with:
//   firebase functions:secrets:set PAYMENT_WEBHOOK_SECRET
const PAYMENT_WEBHOOK_SECRET = defineSecret("PAYMENT_WEBHOOK_SECRET");

// ⚠️ PROVIDER-SPECIFIC — THE ONE PIECE STILL TO WRITE. ⚠️
// Returns { ok, reference, paid } for a callback, or ok:false to reject it.
// Today it accepts only a shared-secret header, which is enough for a sandbox
// but is NOT Thawani's real scheme. Before going live, replace the body with
// Thawani's documented verification (checking their signature over the raw
// body) — an endpoint that grants paid content on an unverified POST is an
// endpoint anyone can use to give themselves unlimited games.
function verifyProviderCallback(req, secret) {
  const sent = req.get("x-izzbah-signature") || "";
  if (!secret || sent !== secret) return { ok: false, reason: "bad-signature" };
  const body = req.body || {};
  const reference = String(body.client_reference_id || body.reference || "");
  if (!reference) return { ok: false, reason: "no-reference" };
  // Thawani reports success as payment_status "paid"; keep both spellings so a
  // sandbox that says {success:true} also works while testing.
  const paid = body.payment_status === "paid" || body.status === "paid" || body.success === true;
  return { ok: true, reference, paid };
}

// Start a purchase. The client sends ONLY a pack id — never a price, never a
// games count — and the server resolves the rest from its own table.
exports.createCheckout = onCall({ cors: true }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

  const pack = getPack(request.data && request.data.packId);
  if (!pack) throw new HttpsError("invalid-argument", "Unknown pack.");

  const db = admin.firestore();
  const ref = db.collection("purchases").doc();
  await ref.set({
    uid,
    packId: pack.id,
    packName: pack.name,
    games: pack.games,
    premium: pack.premium,
    amountOMR: pack.amountOMR,
    amountBaisa: toBaisa(pack.amountOMR),
    status: PENDING,
    email: (request.auth.token && request.auth.token.email) || "",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // checkoutUrl stays null until the provider is wired: the client shows
  // "payment isn't available yet" rather than pretending a purchase started.
  return { purchaseId: ref.id, amountBaisa: toBaisa(pack.amountOMR), checkoutUrl: null };
});

// The provider calls this when a payment settles. Everything that decides
// whether someone gets paid content happens inside one transaction, so two
// concurrent deliveries of the same callback cannot both grant.
exports.paymentWebhook = onRequest(
  { secrets: [PAYMENT_WEBHOOK_SECRET], cors: false },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).send("method-not-allowed"); return; }

    const check = verifyProviderCallback(req, PAYMENT_WEBHOOK_SECRET.value());
    if (!check.ok) { console.warn("payment webhook rejected:", check.reason); res.status(403).send(check.reason); return; }

    const db = admin.firestore();
    const purchaseRef = db.collection("purchases").doc(check.reference);

    try {
      const outcome = await db.runTransaction(async (tx) => {
        const snap = await tx.get(purchaseRef);
        const purchase = snap.exists ? snap.data() : null;
        const decision = grantDecision(purchase, check.paid);

        if (!decision.grant) {
          // A failed payment is recorded so the client can stop waiting; an
          // already-granted one is left exactly as it is (the retry case).
          if (purchase && !check.paid && purchase.status === PENDING) {
            tx.update(purchaseRef, { status: FAILED, failedAt: admin.firestore.FieldValue.serverTimestamp() });
          }
          return decision.reason;
        }

        const pack = getPack(purchase.packId);
        if (!pack) return "unknown-pack";

        const entRef = db.collection("entitlements").doc(purchase.uid);
        const entSnap = await tx.get(entRef);
        const update = entitlementUpdate(entSnap.exists ? entSnap.data() : {}, pack);

        tx.set(entRef, update, { merge: true }); // merge: never clobber admin-set fields
        tx.update(purchaseRef, {
          status: GRANTED,
          grantedAt: admin.firestore.FieldValue.serverTimestamp(),
          granted: update,
        });
        return "granted";
      });

      // Always 200 on a handled callback — a non-2xx makes the provider retry,
      // and there is nothing to retry for "already granted" or "not paid".
      console.log("payment webhook:", check.reference, "->", outcome);
      res.status(200).json({ ok: true, outcome });
    } catch (err) {
      // A real failure (Firestore down mid-transaction) SHOULD be retried, so
      // this one deliberately returns 500.
      console.error("payment webhook failed", err);
      res.status(500).json({ ok: false });
    }
  }
);
