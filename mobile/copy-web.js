// Copies the live web game into Capacitor's webDir as index.html.
// Run via `npm run copy:web` (or `npm run sync`, which also runs `cap sync`).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.join(__dirname, 'www');

fs.mkdirSync(outDir, { recursive: true });

// 1) the self-contained game -> index.html (the app's entry point)
fs.copyFileSync(path.join(root, 'game-mobile.html'), path.join(outDir, 'index.html'));

// 2) copy the assets/ folder too (harmless; covers any future local references)
const assetsSrc = path.join(root, 'assets');
if (fs.existsSync(assetsSrc)) {
  // recursive: assets/ now contains subdirectories (e.g. assets/brand/)
  fs.cpSync(assetsSrc, path.join(outDir, 'assets'), { recursive: true });
}

console.log('Copied game-mobile.html -> mobile/www/index.html (+ assets/)');
