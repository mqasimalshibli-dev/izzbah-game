// The game is served at the SITE ROOT (build .291). Before that, izzbah.com
// was a redirect stub that bounced every visitor to /game-mobile.html — which
// cost a round trip on every cold boot and had Google indexing the long URL.
//
// This test pins the whole move, and in particular the three things that would
// break QUIETLY if someone undid part of it:
//   1. the legacy URLs must forward the HASH — it is the payload of a shared
//      «#g=» game, and a plain redirect drops it,
//   2. the manifest `id` must NOT change with `start_url`, or every phone that
//      already installed the PWA gets a SECOND icon instead of an update,
//   3. nothing may point at game-mobile.html as if it were still the game.
import { chromium } from "playwright-core";
import { spawn, execFileSync } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8352;
const checks = [];
const check = (n, ok, info) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${info ? "  — " + info : ""}`); };

const read = p => readFileSync(join(ROOT, p), "utf8");

// ---------- static facts (no browser needed) ----------
const game = read("index.html");
check("index.html IS the game (not a redirect stub)",
  /const IZZBAH_BUILD = "/.test(game) && game.length > 1_000_000, `${Math.round(game.length / 1024)} KB`);
check("the game's canonical is the bare root",
  /<link rel="canonical" href="https:\/\/izzbah\.com\/">/.test(game));
check("og:url is the bare root too",
  /<meta property="og:url" content="https:\/\/izzbah\.com\/">/.test(game));
check("the game is NOT noindex", !/name="robots"[^>]*noindex/.test(game));

for (const stub of ["game-mobile.html", "game.html"]) {
  const s = read(stub);
  check(`${stub} is a small redirect stub`, s.length < 4000 && !/IZZBAH_BUILD/.test(s), `${s.length} B`);
  check(`${stub} is noindex, follow`, /<meta name="robots" content="noindex, follow">/.test(s));
  check(`${stub} canonicalises to the root`, /<link rel="canonical" href="https:\/\/izzbah\.com\/">/.test(s));
  // The script must come BEFORE the meta refresh, or the refresh can win the
  // race and take the visitor to the root WITHOUT their #g= payload.
  const iScript = s.indexOf("location.replace");
  const iMeta = s.indexOf("http-equiv=\"refresh\"");
  check(`${stub} redirects by script first, meta refresh only as fallback`,
    iScript > -1 && iMeta > -1 && iScript < iMeta);
  check(`${stub} forwards the hash`, /location\.hash/.test(s));
}

const manifest = JSON.parse(read("assets/brand/manifest.webmanifest"));
check("manifest start_url is the root", manifest.start_url === "../../", manifest.start_url);
// ⚠️ Do NOT "tidy" this to match start_url. `id` is the PWA's identity: change
// it and an already-installed app is treated as a different app entirely.
check("manifest id is UNCHANGED (installed apps keep their identity)",
  manifest.id === "../../game-mobile.html", manifest.id);
check("manifest scope still covers the whole site", manifest.scope === "../../");

// A returning player has the OLD path cached and nothing for the root, so the
// service worker warms "/" on activate. Without it, an offline launch goes
// cached stub → "/" → no cache, no network → dead.
const sw = read("sw.js");
check("the service worker warms the root navigation on activate",
  /addEventListener\("activate"[\s\S]*?c\.add\("\.\/"\)/.test(sw));

const sitemap = read("sitemap.xml");
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
/* ⚠️ This used to read "the root and nothing else", from the days when the
   sitemap held one URL. It now lists the landing page and forty category pages
   as well, and tests/findable.mjs owns their completeness — so asserting a
   count here would go red every time a category is published, for nothing.
   What belongs to THIS file is narrower and permanent: the root is the game's
   address, and the two stubs that used to be it are never offered to Google.
   Listing a redirect is precisely what invited "Page with redirect". */
check("the sitemap gives the root as the game's address", locs.includes("https://izzbah.com/"));
check("…and never the stubs that used to be it",
  !locs.some(u => /game-mobile\.html|\/game\.html/.test(u)),
  locs.filter(u => /game-mobile|\/game\.html/.test(u)).join(", "));

// Nothing may still READ or LOAD game-mobile.html as if it were the game.
// Swept across every tracked file rather than a hand-written list: the first
// pass of this move missed `functions/test/fulfilment.test.mjs`, which opens
// the game to compare pack prices, and CI went red on the deploy commit.
// Comments and history notes may name the old path; code and links may not.
/* ⚠️ SO STRIP THE COMMENTS, rather than keeping a list of files allowed to
   mention it. The allowlist version went red three times on commits that only
   ADDED a note explaining the move — the fix each time was to name one more
   file, which makes the check weaker every time it fires. Prose files are
   skipped outright; everything else is read as code. */
const ALLOWED = new Set([
  "game-mobile.html",                    // the stub itself
  "game.html",                           // its twin, whose comment cites it
  "assets/brand/manifest.webmanifest",   // `id` — deliberately frozen, see above
  ".github/workflows/smoke.yml",         // path filter, so a stub edit still runs CI
  "tests/roothome.mjs",                  // this file — it asserts that frozen `id`
]);
const strip = (f, s) => {
  if (/\.(md|txt)$/.test(f)) return "";                       // prose: all of it is a note
  if (/\.(html?|xml|svg)$/.test(f)) return s.replace(/<!--[\s\S]*?-->/g, " ");
  return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
};
const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n");
const strays = tracked.filter(f => !ALLOWED.has(f) && (() => {
  try { return strip(f, readFileSync(join(ROOT, f), "utf8")).includes("game-mobile.html"); }
  catch (e) { return false; }
})());
check("nothing in the repo still points at game-mobile.html as the game",
  strays.length === 0, strays.join(", "));

// ---------- the redirects, in a real browser ----------
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
await page.route("**/firebasejs/**", route => route.abort());
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1200);
  const atRoot = await page.evaluate(() => ({
    path: location.pathname,
    screens: document.querySelectorAll(".screen, .game-screen").length,
    build: (document.getElementById("buildTag") || {}).textContent || "",
  }));
  check("visiting / serves the game itself, no redirect",
    atRoot.path === "/" && atRoot.screens > 5, `${atRoot.path} ${atRoot.screens} screens ${atRoot.build}`);

  // A real shared-game payload. Note the game CONSUMES the hash on load
  // (history.replaceState clears it), so the honest end-to-end proof that it
  // survived the hop is that the shared categories arrived — not the URL.
  const b64url = s => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const HASH = "#g=" + b64url(JSON.stringify({ n: "لعبة مشتركة", c: ["history", "science"] }));
  for (const legacy of ["game-mobile.html", "game.html"]) {
    await page.goto(`http://127.0.0.1:${PORT}/${legacy}${HASH}`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1800);
    const landed = await page.evaluate(() => ({
      path: location.pathname,
      shared: (typeof state !== "undefined" && state.selected) ? [...state.selected] : [],
      name: (typeof state !== "undefined" && state.currentGameName) || "",
      screen: document.body.dataset.screen || "",
    }));
    check(`/${legacy} lands on the root`, landed.path === "/", landed.path);
    check(`/${legacy} carries the #g= payload through`,
      landed.shared.join(",") === "history,science" && landed.name === "لعبة مشتركة"
      && landed.screen === "categories",
      `${landed.shared.join(",")} | ${landed.name} | ${landed.screen}`);
  }

  // A query string must survive too (?utm_… on a shared link, for instance).
  // Unlike the hash the game leaves this one alone, so it is readable after.
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html?utm_source=x${HASH}`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1800);
  const withQuery = await page.evaluate(() => ({
    search: location.search,
    shared: (typeof state !== "undefined" && state.selected) ? [...state.selected] : [],
  }));
  check("the legacy hop keeps the query string as well as the hash",
    withQuery.search === "?utm_source=x" && withQuery.shared.length === 2,
    `${withQuery.search} + ${withQuery.shared.length} categories`);

  // Shared links built FROM /index.html must still read as the clean root, so
  // the long spelling cannot spread through the people players share with.
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1200);
  const built = await page.evaluate(() => {
    // buildSharedGameLink is module-scoped; reach it the way the UI does.
    try { state.selected = new Set(["history"]); } catch (e) {}
    return typeof buildSharedGameLink === "function" ? buildSharedGameLink() : null;
  });
  check("a share link built from /index.html points at the clean root",
    !!built && /\/#g=/.test(built) && !/index\.html/.test(built), built ? built.slice(0, 60) : "(no link built)");
} catch (e) {
  check("harness completed", false);
  console.log("  harness error:", e.message);
} finally {
  await browser.close();
  server.kill();
}

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
