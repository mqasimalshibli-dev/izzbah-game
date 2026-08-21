// Installs window.IZZBAH_AUTH — the native half of the game's sign-in seam.
//
// WHY THIS FILE EXISTS. Firebase's `signInWithPopup` cannot work inside a
// Capacitor build: the page is served from `capacitor://localhost` (iOS) or
// `https://localhost` (Android), and neither is an authorised OAuth origin.
// `signInWithRedirect` fails for exactly the same reason, so there is no
// graceful degradation to fall back on — the web flow does not "mostly work"
// in the app, it does not work at all.
//
// So the NATIVE layer performs the sign-in and hands back an ID token, and the
// game exchanges it via `signInWithCredential`. The resulting session is the
// same one the website produces: same uid, therefore the same
// `entitlements/{uid}`, the same saved games and the same cloud sync.
//
// ⚠️ The game calls this and nothing else. Keep the contract exactly:
//        IZZBAH_AUTH.signIn(providerId) -> { idToken, accessToken?, rawNonce? }
//    `index.html` builds the Firebase credential from that shape and owns every
//    decision after it. Do NOT sign in to Firebase from here — two SDKs holding
//    their own idea of "who is signed in" is how an account silently forks.
//
// ⚠️ RAW NONCE, for Apple only. The plugin hashes a nonce into Apple's request
//    and Firebase re-hashes ours to compare, so the RAW value has to come back.
//    Passing the hashed one, or omitting it, is rejected — and the error names
//    neither. Google takes no nonce; leave it undefined there.
//
// WIRING (once `cap add ios` / `cap add android` have been run):
//   1. npm install                       (in mobile/)
//   2. Firebase console -> Project settings -> add an iOS and an Android app
//      with appId `com.izzbah.game`; download GoogleService-Info.plist into
//      ios/App/App/ and google-services.json into android/app/.
//   3. iOS: add the REVERSED_CLIENT_ID from that plist as a URL scheme in
//      Info.plist. Without it Google sign-in returns to a blank screen.
//   4. Android: register the signing certificate's SHA-1 in the Firebase
//      console — debug AND release. A missing release SHA-1 is the classic
//      "works in testing, fails for every real user" bug.
//   5. Include this file from index.html in the app bundle, or import it from
//      the wrapper's entry point, so IZZBAH_AUTH exists before the first tap.
//
// ⚠️ Apple sign-in stays `enabled: false` in the game until the Apple Developer
//    Program provides the App ID, Services ID and key. This file already
//    handles it so that day is a flag flip, not a rewrite.
import { FirebaseAuthentication } from "@capacitor-firebase/authentication";

const PROVIDERS = {
  "google.com": () => FirebaseAuthentication.signInWithGoogle({ skipNativeAuth: true }),
  "apple.com": () => FirebaseAuthentication.signInWithApple({ skipNativeAuth: true }),
};

window.IZZBAH_AUTH = {
  async signIn(providerId) {
    const run = PROVIDERS[providerId];
    if (!run) throw Object.assign(new Error("unknown provider " + providerId),
                                  { code: "izzbah/unknown-provider" });
    // ⚠️ `skipNativeAuth: true` is load-bearing. Without it the plugin ALSO
    // signs the native Firebase SDK in, and the app then has two independent
    // auth sessions — the native one and the JS one the game actually reads —
    // which drift apart on sign-out and leave a player looking signed in while
    // every Firestore read is denied.
    const res = await run();
    const cred = (res && res.credential) || {};
    return {
      idToken: cred.idToken || null,
      accessToken: cred.accessToken || null,
      // Present for Apple, undefined for Google. See the note above.
      rawNonce: cred.nonce || undefined,
    };
  },
};
