// Nothing third-party may block the game from starting.
//
// The Google Fonts stylesheet was a plain <link rel="stylesheet"> in <head>,
// i.e. render-blocking on a request to a server we do not control. Measured
// with fonts.googleapis.com not answering: first-contentful-paint and
// DOMContentLoaded NEVER fired — a blank screen, and the game did not start
// until the browser gave up (~13s), or indefinitely if the request just hung.
// Captive-portal wifi, a censored network, or flaky mobile data all produce
// exactly that, and it matches the "takes forever to load" reports.
//
// It now loads via media="print" + onload promotion, so the page paints in the
// fallback stack immediately and swaps to Cairo when (if) it arrives. A slow
// font costs a font, not the whole app.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8389;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });

// Static guard first: no stylesheet may block render on a third-party host.
const html = readFileSync(join(ROOT, "game-mobile.html"), "utf8");
// <noscript> content is exempt: it only applies when JS is off, and the game
// does not run at all without JS — so a blocking link there costs nothing.
const head = html.slice(0, html.indexOf("</head>")).replace(/<noscript>[\s\S]*?<\/noscript>/gi, "");
const blocking = [...head.matchAll(/<link\b[^>]*\brel=(["'])stylesheet\1[^>]*>/gi)]
  .map(m => m[0])
  .filter(tag => /https?:\/\//.test(tag))               // third-party only
  .filter(tag => !/\bmedia=(["'])print\1/i.test(tag));  // media=print is non-blocking
check("no render-blocking third-party stylesheet in <head>", blocking.length === 0);
if (blocking.length) console.log("  offending:", blocking[0].slice(0, 120));

const boot = async (label, fontBehaviour) => {
  const page = await browser.newPage({ viewport: { width: 844, height: 390 } });
  await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
  await page.route("**/firebasejs/**", r => r.abort());
  await fontBehaviour(page);
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "commit" });
  // Wait for the app to actually be alive, not merely for bytes to arrive.
  const alive = await page.waitForFunction(
    () => typeof window.IZZBAH === "object" && !!document.querySelector(".wlc-start"),
    { timeout: 8000 }).then(() => true).catch(() => false);
  const m = await page.evaluate(() => {
    const f = performance.getEntriesByType("paint").find(x => x.name === "first-contentful-paint");
    const n = performance.getEntriesByType("navigation")[0] || {};
    return { fcp: Math.round(f ? f.startTime : 0), dcl: Math.round(n.domContentLoadedEventEnd || 0) };
  });
  await page.close();
  return { alive, ...m };
};

// The case that used to hang forever: the font host never answers.
const dead = await boot("dead", async p => { await p.route("**/fonts.googleapis.com/**", () => {}); });
check("the game starts even when the font host NEVER answers", dead.alive);
check("...and it actually paints (FCP fires)", dead.fcp > 0 && dead.fcp < 5000);
check("...and DOMContentLoaded fires promptly", dead.dcl > 0 && dead.dcl < 5000);

// A merely slow font host must not hold the app either.
const slow = await boot("slow", async p => {
  await p.route("**/fonts.googleapis.com/**", async r => {
    await new Promise(x => setTimeout(x, 4000));
    r.fulfill({ status: 200, contentType: "text/css", body: "" });
  });
});
check("a font host that takes 4s does not delay the start", slow.alive && slow.dcl < 5000);

// And when it IS reachable, the stylesheet must still be promoted and applied —
// non-blocking is worthless if the fonts never actually arrive.
const page = await browser.newPage({ viewport: { width: 844, height: 390 } });
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
await page.route("**/firebasejs/**", r => r.abort());
await page.route("**/fonts.googleapis.com/**", r =>
  r.fulfill({ status: 200, contentType: "text/css", body: ":root{--fontprobe:applied}" }));
await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load" });
await page.waitForTimeout(900);
const applied = await page.evaluate(() => ({
  probe: getComputedStyle(document.documentElement).getPropertyValue("--fontprobe").trim(),
  promoted: [...document.querySelectorAll('link[rel="stylesheet"][href*="fonts.googleapis.com"]')]
    .some(l => l.media === "all"),
}));
check("a reachable font stylesheet is promoted to media=all", applied.promoted);
check("...and its rules actually apply", applied.probe === "applied");
await page.close();

await browser.close();
server.kill();

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
