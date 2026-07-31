// Category boot — what the picker shows BEFORE the cloud catalogue arrives.
//
// The bug: while Firestore was still answering, the grid rendered the bundled
// built-in list. 17 of those 20 cards carry `assets/img/cat-*.webp` covers, so
// on a slow phone players saw last release's artwork and category names for
// seconds, then watched it all swap. The picker must never show that.
//
// The rules now:
//   • Cloud still coming  → shimmer skeletons, and NO bundled covers.
//   • Cloud can never come (SDK failed to load) → release immediately. Waiting
//     out a timer for a result that cannot arrive is the worst of both.
//   • Cloud loaded but Firestore silent → a backstop eventually shows the
//     built-ins, because stale art still beats a picker that never resolves.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8375;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

// A Firebase that loads fine and then never answers — the slow-phone case.
const HANGING_SDK = `
window.firebase = {
  apps: [], initializeApp(){ return {}; },
  auth(){ return { setPersistence(){return Promise.resolve();},
                   getRedirectResult(){return Promise.resolve();}, onAuthStateChanged(){} }; },
  firestore(){ const hang = () => new Promise(function(){});
    const ref = { get: hang, collection(){ return ref; }, doc(){ return ref; } };
    return { collection(){ return ref; }, enablePersistence(){ return Promise.resolve(); } }; },
  functions(){ return { httpsCallable(){ return function(){ return new Promise(function(){}); }; } }; },
  analytics(){}, appCheck(){ return { activate(){} }; }
};
firebase.auth.Auth = { Persistence: { LOCAL: 1 } };
firebase.auth.GoogleAuthProvider = function(){ this.setCustomParameters = function(){}; };
firebase.firestore.FieldValue = { serverTimestamp: function(){} };
`;

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });

// Reads the grid. Covers ride on a --cat-image custom property, NOT an <img>,
// so looking for <img src> here would silently pass while covers were showing.
const GRID = () => {
  const g = document.querySelector("#categoryGrid");
  if (!g) return { sk: -1, real: -1, bundled: -1 };
  const cards = [...g.querySelectorAll(".category:not(.cat-skeleton)")];
  const bundled = cards.filter(el => /assets\/img\/cat-/.test(
    el.style.getPropertyValue("--cat-image") || ""));
  return { sk: g.querySelectorAll(".cat-skeleton").length, real: cards.length, bundled: bundled.length };
};

const openPicker = async (page) => {
  await page.evaluate(() => [...document.querySelectorAll("button")]
    .find(b => b.textContent.trim().startsWith("ابدأ لعبة"))?.click());
};

try {
  // ── 1) cloud still coming: skeletons, and never the bundled covers ────────
  {
    const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
    await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
    await page.route("**/firebasejs/**", r => r.fulfill({ status: 200, contentType: "application/javascript", body: HANGING_SDK }));
    await page.route("**/firestore.googleapis.com/**", r => r.abort());
    await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(400);
    await openPicker(page);
    await page.waitForTimeout(300);

    const early = await page.evaluate(GRID);
    check("waiting on the cloud → shimmer skeletons are shown", early.sk >= 4);
    check("waiting on the cloud → NO real cards yet", early.real === 0);
    check("waiting on the cloud → ZERO bundled built-in covers", early.bundled === 0);

    await page.waitForTimeout(1600);
    const mid = await page.evaluate(GRID);
    check("still waiting a second later → still no stale covers", mid.bundled === 0);

    // the backstop must eventually resolve rather than shimmer forever
    await page.waitForTimeout(4000);
    const late = await page.evaluate(GRID);
    check("backstop eventually shows the built-ins rather than shimmering forever",
      late.sk === 0 && late.real > 0);
    await page.close();
  }

  // ── 2) SDK cannot load: no point waiting, show what we ship, at once ──────
  {
    const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
    await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
    await page.route("**/firebasejs/**", r => r.abort());
    await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(400);
    await openPicker(page);
    await page.waitForTimeout(500);

    const g = await page.evaluate(GRID);
    // Well inside the backstop: this must come from the SDK's error handler,
    // not from the timer, or a blocked-CDN player waits for nothing.
    check("SDK failure releases the picker immediately, without the backstop", g.real > 0 && g.sk === 0);
    await page.close();
  }

  // ── 3) the ready flag is one-way and idempotent ───────────────────────────
  {
    const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
    await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
    await page.route("**/firebasejs/**", r => r.abort());
    await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => window.IZZBAH && window.IZZBAH.markCatalogReady, { timeout: 15000 });
    const ok = await page.evaluate(() => {
      try {
        window.IZZBAH.markCatalogReady();
        window.IZZBAH.markCatalogReady();   // must not throw or re-render into a bad state
        return !!document.querySelector("#categoryGrid");
      } catch (e) { return false; }
    });
    check("markCatalogReady is safely repeatable", ok);
    await page.close();
  }
} catch (e) {
  check(`threw: ${e && e.message}`, false);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
