// Welcome-screen boot gate — nobody advances onto a half-loaded game.
//
// On slow phones the catalogue (and the restored sign-in session) can still be
// in flight when the player taps «ابدأ لعبة جديدة». Before this gate the tap
// either bounced with a sign-in toast (session restore not resolved yet) or,
// worse, walked into a picker showing last release's bundled categories.
//
// Now: tapping start before boot completes raises #bootVeil — a full-screen
// spinner that blocks every press — and the navigation finishes by itself the
// moment boot is done. If nothing arrives in 20s it steps aside with a toast
// so the player is never permanently trapped; the load keeps running and a
// retry press resumes the wait.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8377;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

// Firebase that loads fine and then never answers — the slow-phone case. The
// boot gate must hold, because neither markCatalogReady nor applyAuth fires.
const HANGING_SDK = `
window.firebase = {
  apps: [], initializeApp(){ return {}; },
  auth(){ return { setPersistence(){return Promise.resolve();},
                   getRedirectResult(){return Promise.resolve();}, onAuthStateChanged(){} }; },
  firestore(){ const hang = () => new Promise(function(){});
    // Chainable like the real thing — applyAuth fans out into announcement /
    // config reads that call limit/orderBy/where before get().
    const ref = { get: hang, onSnapshot(){ return function(){}; },
      collection(){ return ref; }, doc(){ return ref; },
      limit(){ return ref; }, orderBy(){ return ref; }, where(){ return ref; } };
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

const newPage = async (routeSDK) => {
  const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
  await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
  await routeSDK(page);
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH && window.IZZBAH.hideBootVeil, { timeout: 15000 });
  return page;
};
const pressStart = (page) => page.evaluate(() => {
  const b = document.querySelector(".wlc-start");
  if (b) b.click();
  return !!b;
});
const snap = (page) => page.evaluate(() => ({
  veil: !document.getElementById("bootVeil").hidden,
  veilText: (document.querySelector("#bootVeil .veil-text") || {}).textContent || "",
  screen: document.body.dataset.screen || "",
  authReady: undefined, // filled below where state is reachable via IZZBAH
}));

try {
  // ── 1) boot still in flight → veil holds, then finishes the navigation ──
  {
    const page = await newPage(p => p.route("**/firebasejs/**",
      r => r.fulfill({ status: 200, contentType: "application/javascript", body: HANGING_SDK })));
    await pressStart(page);
    await page.waitForTimeout(400);
    let s = await snap(page);
    check("start during boot raises the blocking veil", s.veil);
    check("...and does NOT navigate off the welcome screen", s.screen !== "gameLibrary");

    // Everything under the veil must be unpressable. elementFromPoint at the
    // start button's own coordinates must resolve to the veil, not the button.
    const blocked = await page.evaluate(() => {
      const b = document.querySelector(".wlc-start");
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!(hit && hit.closest("#bootVeil"));
    });
    check("the veil intercepts presses on everything underneath", blocked);

    await page.waitForTimeout(2000);
    s = await snap(page);
    check("2s of slow cloud later, the veil is still holding", s.veil && s.screen !== "gameLibrary");

    // Boot completes (signed-in session + real catalogue) → veil clears and
    // the ORIGINAL tap's navigation happens by itself.
    await page.evaluate(() => {
      window.IZZBAH.applyAuth(true, "gate-tester");
      window.IZZBAH.applyPublished([{
        id: "gateCat", name: "فئة الاختبار", image: "", color: "#8b1c1f",
        questions: [100, 200, 300, 400, 500].map(p => ({ points: p, q: "س" + p, a: "ج" + p, image: "", answerImage: "" })),
      }]);
    });
    await page.waitForTimeout(700);
    s = await snap(page);
    check("boot completing releases the veil", !s.veil);
    check("...and finishes the tap's navigation into «ألعابك»", s.screen === "gameLibrary");
    await page.close();
  }

  // ── 2) boot completes signed OUT → veil clears, no navigation, no popup ──
  {
    const page = await newPage(p => p.route("**/firebasejs/**",
      r => r.fulfill({ status: 200, contentType: "application/javascript", body: HANGING_SDK })));
    await pressStart(page);
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      window.IZZBAH.applyAuth(false, "");
      window.IZZBAH.markCatalogReady();
    });
    await page.waitForTimeout(700);
    const s = await snap(page);
    check("signed-out boot completion releases the veil without navigating",
      !s.veil && s.screen !== "gameLibrary");
    await page.close();
  }

  // ── 3) no cloud at all (SDK aborted) → gate is a no-op, exactly as today ──
  {
    const page = await newPage(p => p.route("**/firebasejs/**", r => r.abort()));
    await page.waitForTimeout(600); // let the SDK .catch settle auth + catalog
    await pressStart(page);
    await page.waitForTimeout(400);
    const s = await snap(page);
    check("with no cloud ever coming, the veil never appears", !s.veil);
    check("...and the sign-in requirement still blocks navigation", s.screen !== "gameLibrary");
    await page.close();
  }

  // ── 4) the 20s give-up: the player is never permanently trapped ──────────
  {
    const page = await newPage(p => p.route("**/firebasejs/**",
      r => r.fulfill({ status: 200, contentType: "application/javascript", body: HANGING_SDK })));
    await pressStart(page);
    await page.waitForTimeout(9000);
    let s = await snap(page);
    check("at 9s the veil is still up and has switched to the slow-connection text",
      s.veil && /بطيء/.test(s.veilText));
    await page.waitForTimeout(12500); // past the 20s mark
    s = await snap(page);
    check("after 20s the veil steps aside instead of trapping the player", !s.veil);
    check("...still on the welcome screen, free to retry", s.screen !== "gameLibrary");
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
