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

    // Same source of truth as the game and the Firestore rules. Content
    // EDITORS mint upload URLs too: their whole job is authoring questions, and
    // a question in «من الي سجل؟» or any voice round IS a media clip — without
    // this they could add text and pasted images and nothing else. Uploading is
    // the narrowest privilege here (it writes an object to R2 under a generated
    // key), and the clip only becomes visible once it is attached to a question
    // through the Firestore rules, which police editors separately.
    const db = admin.firestore();
    const [adminDoc, editorDoc] = await Promise.all([
      db.collection("admins").doc(uid).get(),
      db.collection("editors").doc(uid).get(),
    ]);
    if (!adminDoc.exists && !editorDoc.exists) {
      throw new HttpsError("permission-denied", "Admins only.");
    }

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

// ---------------------------------------------------------------------------
// resolveEmails — admin-only: uid -> email, read straight from Firebase Auth.
//
// The admin centre names players by email. It can assemble most of them from
// Firestore (sales/{id} for past buyers, and each player's own stamp on their
// usage doc), but neither covers a player who was GIFTED a code and never
// bought anything: nothing they can write holds their address, and the one doc
// that does — users/{uid} — is owner-read-only by rules, deliberately, because
// it also holds their entire saved-game blob.
//
// Firebase AUTH holds the address for every account, and the Admin SDK can read
// it without touching any of that private data. So this returns exactly one
// field per uid and nothing else. It is the only way to name players
// retroactively; every other route needs the player to open the game again.
//
// Gated on admins/{uid}, the same source of truth as the game and the rules.
exports.resolveEmails = onCall({ cors: true }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");
  const adminDoc = await admin.firestore().collection("admins").doc(uid).get();
  if (!adminDoc.exists) throw new HttpsError("permission-denied", "Admins only.");

  const raw = (request.data && request.data.uids) || [];
  if (!Array.isArray(raw)) throw new HttpsError("invalid-argument", "uids must be an array.");
  // De-duplicate and bound the work: getUsers takes 100 identifiers per call,
  // and the admin panel only ever asks about the rows it is showing.
  const uids = [...new Set(raw.map(u => String(u || "").trim()).filter(Boolean))].slice(0, 1000);
  if (!uids.length) return { emails: {} };

  const emails = {};
  for (let i = 0; i < uids.length; i += 100) {
    const batch = uids.slice(i, i + 100).map(u => ({ uid: u }));
    // getUsers does NOT throw on unknown uids — they come back in notFound,
    // which we simply skip (a deleted account stays unnamed rather than
    // failing the whole panel).
    const res = await admin.auth().getUsers(batch);
    res.users.forEach(u => { if (u.email) emails[u.uid] = u.email; });
  }
  return { emails };
});

// ---------------------------------------------------------------------------
// deleteAccount — the player erases themselves, from inside the app.
//
// App Store guideline 5.1.1(v): an app that lets you create an account must let
// you delete it in-app. A support email does not satisfy it and a "deactivate"
// switch does not either. Review checks this by hand, so it is a hard blocker
// for the iOS build.
//
// It has to be a Cloud Function rather than a batch of client writes for a
// reason that is easy to miss: entitlements/{uid} is write-DENIED to every user
// (that is what stops a player granting themselves games), so the browser
// physically cannot remove it. A half-deleted account that keeps its paid
// balance is worse than none — the uid is gone from Auth but the record is
// still there, and if that uid were ever reissued it would inherit the games.
// The Admin SDK bypasses rules, so NO firestore.rules change is needed here.
//
// ⚠️ Order matters. Firestore first, Auth LAST: if the data pass throws, the
// account still exists and the player can try again. Delete the Auth user first
// and a failure halfway through leaves orphaned data nobody can reach or clean.
// ---------------------------------------------------------------------------
const {
  ERASE_DOCS, ERASE_SUBCOLLECTIONS, ANONYMISE,
  VOTES_SUB, VOTES_PARENT, VOTES_COUNTER,
  communityAction, anonymisePatch, mayErase,
} = require("./lib/erasure");

exports.deleteAccount = onCall({ cors: true }, async (request) => {
  const gate = mayErase(request.auth && request.auth.uid, request.data && request.data.uid);
  if (!gate.ok) {
    throw new HttpsError(
      gate.reason === "unauthenticated" ? "unauthenticated" : "permission-denied",
      gate.reason === "unauthenticated" ? "Sign in required." : "You can only delete your own account.");
  }
  const uid = gate.uid;
  const db = admin.firestore();
  const report = { erased: [], anonymised: [], messages: 0 };

  // 1. Documents whose id is the uid.
  for (const collection of ERASE_DOCS) {
    const ref = db.collection(collection).doc(uid);
    const snap = await ref.get();
    if (!snap.exists) continue;
    await ref.delete();
    report.erased.push(collection);
  }

  // 2. Per-uid subcollections. These can exist under a parent doc that does
  //    not — Firestore allows it — so they are enumerated, never inferred.
  for (const { parent, sub } of ERASE_SUBCOLLECTIONS) {
    let cleared = 0;
    // Page it: a chatty feedback thread or a long announcement history can run
    // past the 500-write batch limit, and one oversized batch throws and takes
    // the whole deletion with it.
    for (;;) {
      const page = await db.collection(parent).doc(uid).collection(sub).limit(400).get();
      if (page.empty) break;
      const batch = db.batch();
      page.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      cleared += page.size;
      if (page.size < 400) break;
    }
    if (cleared) { report.erased.push(`${parent}/${sub}`); report.messages += cleared; }
    // The parent may hold nothing itself, but delete it so the console is clean.
    await db.collection(parent).doc(uid).delete().catch(() => {});
  }

  // 3. Community up-votes. The uid is the LEAF here (community/{cat}/votes/{uid}),
  //    so there is no one path to delete and a collection-group query cannot
  //    filter on document id. Walk the categories instead — there are tens.
  const cats = await db.collection(VOTES_PARENT).get();
  let votes = 0;
  for (const cat of cats.docs) {
    const voteRef = cat.ref.collection(VOTES_SUB).doc(uid);
    const vote = await voteRef.get();
    if (!vote.exists) continue;
    // One batch, so the vote doc and the public tally can never disagree.
    const batch = db.batch();
    batch.delete(voteRef);
    batch.update(cat.ref, { [VOTES_COUNTER]: admin.firestore.FieldValue.increment(-1) });
    await batch.commit();
    votes++;
  }
  if (votes) { report.erased.push(`${VOTES_PARENT}/${VOTES_SUB}`); report.votes = votes; }

  // 4. Records that survive with the identity overwritten.
  for (const rule of ANONYMISE) {
    const rows = await db.collection(rule.collection).where(rule.match, "==", uid).get();
    if (rows.empty) continue;
    const batch = db.batch();
    let touched = 0;
    rows.docs.forEach(d => {
      // A community submission nobody has approved is not public content, so it
      // is erased rather than kept with a blank author.
      if (rule.collection === "community" && communityAction(d.data()) === "erase") {
        batch.delete(d.ref);
      } else {
        batch.update(d.ref, anonymisePatch(rule));
      }
      touched++;
    });
    await batch.commit();
    report.anonymised.push(`${rule.collection}:${touched}`);
  }

  // 5. The identity itself, last.
  await admin.auth().deleteUser(uid);
  return { ok: true, report };
});

// ---------------------------------------------------------------------------
// revenuecatWebhook — an App Store / Play purchase becomes games in an account.
//
// The client NEVER grants. A player taps buy, Apple takes the money, RevenueCat
// tells us here, and this function — the only thing with Admin SDK rights —
// writes entitlements/{uid}. The game's existing onSnapshot puts the games on
// screen. firestore.rules already denies every user write to entitlements, so
// this endpoint is the sole path to paid content and is guarded accordingly.
//
// Set the shared header value once, in both places:
//   firebase functions:secrets:set REVENUECAT_WEBHOOK_SECRET
//   RevenueCat dashboard -> Integrations -> Webhooks -> Authorization header
//
// ⚠️ app_user_id MUST be the Firebase uid. The client has to call RevenueCat's
// logIn(uid) after sign-in; with RevenueCat's own anonymous ids this function
// has no idea whose account to credit and every purchase lands in the
// unknown-user branch. That is the single most likely way to get this wrong.
// ---------------------------------------------------------------------------
const REVENUECAT_WEBHOOK_SECRET = defineSecret("REVENUECAT_WEBHOOK_SECRET");
const { rcAuthorised, parseRcEvent, rcDecision } = require("./lib/revenuecat");

exports.revenuecatWebhook = onRequest(
  { secrets: [REVENUECAT_WEBHOOK_SECRET], cors: false },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).send("method-not-allowed"); return; }
    if (!rcAuthorised(req.get("authorization"), REVENUECAT_WEBHOOK_SECRET.value())) {
      console.warn("revenuecat webhook: bad authorization");
      res.status(401).send("unauthorized");
      return;
    }

    const parsed = parseRcEvent(req.body);
    if (!parsed.ok) {
      // 400, not 500: a shape we cannot read will never become readable, so
      // there is nothing for RevenueCat to gain by retrying it.
      console.error("revenuecat webhook unparsed:", parsed.reason, JSON.stringify(req.body || {}).slice(0, 400));
      res.status(400).send(parsed.reason);
      return;
    }

    const db = admin.firestore();
    const eventRef = db.collection("rcEvents").doc(parsed.eventId);

    try {
      // Resolve the customer. RevenueCat's guidance is to try every id it gives
      // us, so we take the first that is a real account here.
      let uid = "";
      for (const candidate of parsed.candidates) {
        const ent = await db.collection("entitlements").doc(candidate).get();
        if (ent.exists) { uid = candidate; break; }
        try { await admin.auth().getUser(candidate); uid = candidate; break; } catch (e) { /* not ours */ }
      }

      // Sandbox purchases cost nothing and anyone can make one, so they only
      // grant to staff. That keeps end-to-end testing possible without leaving
      // a way to mint unlimited games in production.
      let isStaff = false;
      if (uid && parsed.sandbox) {
        const [a, e] = await Promise.all([
          db.collection("admins").doc(uid).get(),
          db.collection("editors").doc(uid).get(),
        ]);
        isStaff = a.exists || e.exists;
      }

      const decision = rcDecision(parsed, uid, isStaff);
      const pack = decision.grant ? getPack(decision.packId) : null;

      // One transaction covers the idempotency record AND the grant, so a retry
      // can never double-credit: RevenueCat resends until it sees a 2xx, and a
      // response lost on the wire is the normal case, not the rare one.
      const applied = await db.runTransaction(async (tx) => {
        const seen = await tx.get(eventRef);
        if (seen.exists) return { duplicate: true };

        let granted = null;
        if (decision.grant && pack) {
          const entRef = db.collection("entitlements").doc(uid);
          const cur = await tx.get(entRef);
          const patch = entitlementUpdate(cur.exists ? cur.data() : null, pack);
          patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
          tx.set(entRef, patch, { merge: true });
          granted = patch.gamesAllowed;

          // Book the revenue, or the admin's sales panel silently under-reports
          // everything sold through the stores.
          // ⚠️ priceOMR is our LIST price, not what Apple actually charged —
          // the store bills its own tier in the buyer's currency and takes its
          // cut. Treat store rows as gross-at-list, not as a payout figure.
          tx.set(db.collection("sales").doc(), {
            pack: pack.name, games: pack.games, premium: !!pack.premium,
            priceOMR: Number(pack.amountOMR) || 0,
            email: "", uid,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        tx.set(eventRef, {
          type: parsed.type, productId: parsed.productId, uid: uid || "",
          sandbox: !!parsed.sandbox,
          outcome: decision.grant ? "granted" : decision.reason,
          at: admin.firestore.FieldValue.serverTimestamp(),
        });
        return { duplicate: false, granted };
      });

      if (applied.duplicate) console.log("revenuecat webhook: duplicate", parsed.eventId);
      else if (decision.grant) console.log("revenuecat webhook: granted", decision.packId, "to", uid);
      else console.warn("revenuecat webhook: no grant —", decision.reason, parsed.type, parsed.productId);

      // 200 even when nothing was granted. A refused event is HANDLED — retrying
      // it would not change the answer, and a non-2xx makes RevenueCat resend
      // the same unusable notification for days.
      res.status(200).json({ ok: true, outcome: decision.grant ? "granted" : decision.reason });
    } catch (err) {
      // A real failure — Firestore unavailable, say. 500 so RevenueCat DOES
      // retry, because this one might succeed next time.
      console.error("revenuecat webhook failed", err);
      res.status(500).send("error");
    }
  }
);
