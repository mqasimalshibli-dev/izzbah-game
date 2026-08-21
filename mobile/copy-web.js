// Packages the live web game as the Capacitor app's web layer.
// Run via `npm run copy:web` (or `npm run sync`, which also runs `cap sync`).
//
// Three steps, and the last two exist because of a bug this script used to
// have: it copied index.html and assets/ and nothing else, so `native-auth.js`
// and `native-store.js` — both written, documented and committed — had NO path
// into the app. Sign-in and purchasing would have failed in the wrapper with
// nothing on screen to point at.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const outDir = path.join(__dirname, 'www');

fs.mkdirSync(outDir, { recursive: true });

// 1) the self-contained game (index.html at the repo root) -> the app's entry point
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// 2) copy the assets/ folder too (harmless; covers any future local references)
const assetsSrc = path.join(root, 'assets');
if (fs.existsSync(assetsSrc)) {
  // recursive: assets/ now contains subdirectories (e.g. assets/brand/)
  fs.cpSync(assetsSrc, path.join(outDir, 'assets'), { recursive: true });
}

/* 3) bundle the native bridges and give the packaged HTML a way to load them.
   ⚠️ They MUST be bundled. Both use ESM imports of bare specifiers, which a
   browser cannot resolve — shipping them raw attaches no globals and raises
   nothing the game can report. */
const bundle = path.join(outDir, 'native.js');
try {
  execFileSync(path.join(__dirname, 'node_modules', '.bin', 'esbuild'), [
    path.join(__dirname, 'native-entry.js'),
    '--bundle', '--format=iife', '--platform=browser', '--minify',
    '--outfile=' + bundle,
  ], { stdio: 'pipe' });
} catch (e) {
  throw new Error(
    'copy-web: could not bundle the native bridges.\n' +
    'Run `npm install` in mobile/ first (esbuild is a devDependency).\n' +
    (e.stderr ? e.stderr.toString() : e.message));
}

/* `defer`, in <head>. It must run BEFORE the first sign-in tap and before the
   packs box can open, and both are user actions — but `identifyStoreUser` also
   runs from applyAuth, on the first Firebase auth-state callback. A deferred
   script executes after parsing and before DOMContentLoaded, which is
   comfortably ahead of all three, without blocking the first paint on 165 KB. */
const tag = '<script defer src="native.js"></script>';
html = html.replace(/<\/head>/, `  ${tag}\n</head>`);

// ⚠️ FAIL LOUDLY. A silently un-injected tag is precisely the bug this step was
// added to fix, and its symptom in the app — sign-in and buying both dead — is
// nowhere near its cause.
if (!html.includes(tag)) {
  throw new Error('copy-web: could not inject the native bundle — no </head> in index.html?');
}
fs.writeFileSync(path.join(outDir, 'index.html'), html);

const kb = (fs.statSync(bundle).size / 1024).toFixed(0);
console.log(`Copied index.html -> mobile/www/index.html (+ assets/, + native.js ${kb} KB)`);
