// Verifies the PWA layer: a valid linked manifest with icons, and a service
// worker that launches INSTANTLY (cache-first navigation) yet never traps a
// stale build — the cache is versioned per deploy, refreshed in the background,
// and the page auto-reloads onto a new build (deferred out of a live game).
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8316;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));

// ---- static checks ----
const html = readFileSync(join(ROOT, "game-mobile.html"), "utf8");
check("the page links a web app manifest", /<link rel="manifest" href="assets\/brand\/manifest\.webmanifest">/.test(html));
check("the page registers the service worker", /serviceWorker\.register\("sw\.js"/.test(html));

const manifest = JSON.parse(readFileSync(join(ROOT, "assets/brand/manifest.webmanifest"), "utf8"));
check("manifest: standalone display + start_url + id",
  manifest.display === "standalone" && !!manifest.start_url && !!manifest.id);
check("manifest: has 192/512 + maskable icons",
  manifest.icons.some(i => i.sizes === "192x192") && manifest.icons.some(i => i.sizes === "512x512")
  && manifest.icons.some(i => i.purpose === "maskable"));
// every icon file actually exists
const iconsExist = manifest.icons.every(i => { try { readFileSync(join(ROOT, "assets/brand", i.src)); return true; } catch (e) { return false; } });
check("manifest: every icon file exists on disk", iconsExist);

const sw = readFileSync(join(ROOT, "sw.js"), "utf8");
check("service worker: navigations are CACHE-FIRST for an instant launch (cache looked up before the network)",
  /mode === "navigate"/.test(sw)
  && sw.indexOf("caches.match(req)") < sw.indexOf('cache: "reload"')   // cache lookup precedes the network fetch
  && /return hit \|\| net/.test(sw));
check("service worker: the shell is still refreshed in the background (cache:reload keeps it self-healing)",
  /fetch\(req,\s*\{\s*cache:\s*["']reload["']\s*\}\)/.test(sw));
check("service worker: the cache is versioned per build so a new deploy invalidates it",
  /const CACHE = "izzbah-/.test(sw) && /k !== CACHE/.test(sw));
check("the page auto-updates onto a new build (controllerchange → reload)",
  /controllerchange/.test(html) && /location\.reload\(\)/.test(html) && /updateViaCache:\s*"none"/.test(html));
check("the auto-reload never interrupts a live game (deferred via pendingSwReload)",
  /pendingSwReload/.test(html) && /state\.gameActive/.test(html));
check("service worker: cross-origin (Firebase/CDN) requests pass through untouched",
  /origin !== self\.location\.origin\) return/.test(sw));

// ---- live: the SW registers on localhost ----
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage();
await page.route("**/firebasejs/**", r => r.abort());
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
const errs = [];
page.on("pageerror", e => errs.push(e.message));
try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  const reg = await page.evaluate(() => Promise.race([
    navigator.serviceWorker.ready.then(r => !!r.active || !!r.installing || !!r.waiting),
    new Promise(res => setTimeout(() => res(false), 8000)),
  ]));
  check("the service worker registers and activates", reg === true);
  check("no uncaught JS errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 3));
} catch (e) {
  check("harness completed", false);
  console.log("  harness error:", e.message);
} finally {
  await browser.close();
  server.kill();
}
process.exit(checks.every(Boolean) ? 0 : 1);
