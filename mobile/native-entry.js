// The bundle entry for the app's native bridges.
//
// `copy-web.js` runs esbuild over this file to produce `www/native.js` and
// injects a <script> tag for it into the packaged index.html. Both halves are
// needed: the two files below use ESM imports of BARE specifiers
// (`@capacitor-firebase/authentication`, `@revenuecat/purchases-capacitor`),
// which a browser cannot resolve on its own — dropping them into the app
// unbundled gives a silent 404-or-parse-error and a game whose bridges simply
// never attach.
//
// ⚠️ That is not a hypothetical. Before this existed, `www/` contained
// index.html and assets/ ONLY: both bridge files were written, documented and
// committed, and neither had any path into the app at all. Sign-in and
// purchasing would both have failed in the wrapper with nothing to point at.
//
// Import for SIDE EFFECTS only. Each file installs its global and exports
// nothing; the game reads `window.IZZBAH_AUTH` / `window.IZZBAH_STORE`.
import "./native-auth.js";
import "./native-store.js";
