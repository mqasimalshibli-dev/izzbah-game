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

// The fonts are self-hosted (assets/fonts). Nothing may reach a font CDN, and
// the CSP must not even permit it — that is the difference between "does not
// happen to" and "cannot".
check("no reference to a third-party font host anywhere in the page",
  !/(?:href=|url\()\s*["']?https:\/\/fonts\.(?:googleapis|gstatic)\.com/.test(html));
check("CSP does not allow third-party font/style hosts",
  !/(?:style-src|font-src)[^;]*fonts\.(?:googleapis|gstatic)\.com/.test(html));
check("the self-hosted faces are declared with @font-face",
  (html.match(/@font-face/g) || []).length >= 12);
check("...and keep unicode-range, so only the needed subsets download",
  (html.match(/unicode-range:/g) || []).length >= 12);

const boot = async (label, fontBehaviour) => {
  const page = await browser.newPage({ viewport: { width: 844, height: 390 } });
  page.__cdn = [];
  page.on("request", r => { if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) page.__cdn.push(r.url()); });
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
  const cdn = page.__cdn.length;
  await page.close();
  return { alive, cdn, ...m };
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
check("the page never even asks a font CDN (fonts are self-hosted)",
  dead.cdn === 0 && slow.cdn === 0);

// Non-blocking is worthless if the fonts never actually arrive. document.fonts
// .check() is useless here — it returns true for a FALLBACK match — so this is
// a width probe: render each family and a nonsense family and compare advances.
const page = await browser.newPage({ viewport: { width: 844, height: 390 } });
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
await page.route("**/firebasejs/**", r => r.abort());
await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load" });
const probe = await page.evaluate(async () => {
  // A face only downloads when something needs it, so ask explicitly.
  await Promise.all([
    document.fonts.load("900 48px 'Cairo'", "عزبة"),
    document.fonts.load("400 48px 'Lalezar'", "12345"),
    document.fonts.load("700 48px 'Aref Ruqaa'", "عزبة"),
  ]).catch(() => {});
  await document.fonts.ready;
  const w = (fam, weight, text) => {
    const cv = document.createElement("canvas").getContext("2d");
    cv.font = `${weight} 48px ${fam}`;
    return cv.measureText(text).width;
  };
  return {
    cairo:   w("'Cairo'", 900, "عِزبة لعبة أسئلة") !== w("'NoSuchFontXY'", 900, "عِزبة لعبة أسئلة"),
    lalezar: w("'Lalezar'", 400, "١٢٣٤٥ 12345")   !== w("'NoSuchFontXY'", 400, "١٢٣٤٥ 12345"),
    aref:    w("'Aref Ruqaa'", 700, "عزبة")        !== w("'NoSuchFontXY'", 700, "عزبة"),
    sameOrigin: performance.getEntriesByType("resource")
      .filter(r => /\.woff2?$/.test(r.name)).every(r => r.name.startsWith(location.origin)),
    fetched: performance.getEntriesByType("resource").filter(r => /\.woff2?$/.test(r.name)).length,
  };
});
check("Cairo renders from the self-hosted file, not a fallback", probe.cairo);
check("Lalezar renders from the self-hosted file", probe.lalezar);
check("Aref Ruqaa renders from the self-hosted file", probe.aref);
check("every font actually fetched came from our own origin", probe.sameOrigin);
check("only the needed subsets download, not all 28", probe.fetched > 0 && probe.fetched < 20);
await page.close();

await browser.close();
server.kill();

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
