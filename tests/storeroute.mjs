// Where the landing page sends someone who wants to play.
//
// The owner's instruction: *"the site only way to take to the game is to the
// store correspondent to the users phone or to the users game if its
// downloaded."*
//
// ⚠️ NEITHER STORE LISTING EXISTS YET. Both badges on the page read «قريباً»,
// and App Store enrolment has not happened. A gateway whose every button leads
// to a 404 is worse than one that opens the web build, so the two URLs live in
// a `STORE` constant and every route falls back to the web game while a slot is
// empty. This test covers BOTH states — today's fallback, and the store routing
// that switches on the moment a URL is filled in — by rewriting the constant on
// the wire and reloading. The day the owner has real URLs, the only change is
// two strings.
//
// What is being pinned:
//
// ⚠️ ONE ROUTER, NO SECOND PLACE TO CHANGE. Every way into the game — the header
// button, the hero, the taster's CTA, the closing button, the footer link, and
// all forty category tiles — resolves through `gameUrl()`. A hard-coded `../`
// left behind somewhere is a button that keeps opening the web game after the
// owner has switched the site to the stores, and nobody would notice it.
//
// ⚠️ THE PHONE DECIDES, AND A DESKTOP IS NOT A PHONE. An iPhone gets the App
// Store, an Android phone Google Play, a laptop neither — the app is not for
// their machine. iPadOS reports itself as a Mac, so that case is exercised
// explicitly rather than assumed.
//
// ⚠️ AND THE HERO MUST NOT CONTRADICT THE ROUTE. The page currently promises a
// full free game «بدون حساب ولا تنزيل». That is true while the fallback is the
// web build and false the moment a store is the only way in, so this fails if a
// store URL is set while the promise is still on the page.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8771;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`); };

const IOS = "https://apps.apple.com/om/app/izzbah/id0000000000";
const PLAY = "https://play.google.com/store/apps/details?id=com.izzbah.game";

/* ── the source itself ────────────────────────────────────────────
   Read before a browser is involved: "is there a hard-coded `../` left in the
   markup" is a question about the file, and a browser would only answer it for
   the links that happen to be rendered. */
const src = readFileSync(join(ROOT, "preview", "index.html"), "utf8");
const rawLinks = [...src.matchAll(/<a\b[^>]*href="\.\.\/[^"]*"[^>]*>/g)].map(m => m[0]);
check("every hand-written link into the game is marked for the router",
  rawLinks.every(a => /\bdata-game\b/.test(a)),
  `${rawLinks.length} links, ${rawLinks.filter(a => !/\bdata-game\b/.test(a)).length} unmarked`);
check("the store URLs live in exactly one place",
  (src.match(/const STORE = \{/g) || []).length === 1);

const UAS = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  desktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

/* Loads the page with the store constants rewritten on the wire, so the real
   routing code runs against real URLs without either being committed. */
async function open(which, { stores = false, ipad = false } = {}) {
  const ctx = await browser.newContext({
    viewport: ipad ? { width: 834, height: 1112 } : { width: 1100, height: 900 },
    userAgent: UAS[which],
    // ⚠️ iPadOS 13+ sends a Mac user-agent. The only thing separating it from a
    // real Mac is that it reports touch points, which is exactly what the
    // router checks — so it has to be emulated, not asserted about.
    hasTouch: ipad || which !== "desktop",
    isMobile: which !== "desktop",
  });
  if (ipad) await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 });
  });
  const page = await ctx.newPage();
  page.on("pageerror", e => errs.push(which + ": " + e.message));
  if (stores) {
    await page.route("**/preview/index.html", async route => {
      const res = await route.fetch();
      let body = await res.text();
      const before = body;
      body = body.replace('ios: "",', `ios: "${IOS}",`).replace('android: "",', `android: "${PLAY}",`);
      // ⚠️ If the constants are ever renamed this rewrite silently does nothing
      // and every "store" assertion below would then be testing the fallback
      // and passing for the wrong reason.
      if (body === before) throw new Error("storeroute.mjs: could not inject the store URLs — has `STORE` been renamed?");
      await route.fulfill({ response: res, body });
    });
  }
  await page.goto(`http://127.0.0.1:${PORT}/preview/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(800);
  return { ctx, page };
}

const readRoutes = page => page.evaluate(() => ({
  buttons: [...document.querySelectorAll("[data-game]")].map(a => ({
    text: a.textContent.trim().slice(0, 24),
    href: a.getAttribute("href"),
    target: a.getAttribute("target") || "",
  })),
  // ⚠️ The grid tiles route to a category PAGE now, not into the game — the
  // routing they have to obey is checked in tests/catpages.mjs, and the page's
  // own play button carries the same rule (inlined from these constants by
  // preview/cats.mjs). What is left here is the showcase's play button.
  tiles: [...document.querySelectorAll(".gcard")].map(a => a.getAttribute("href")),
  play: (document.getElementById("cdPlay") || {}).getAttribute?.("href") || "",
  badges: [...document.querySelectorAll("[data-store]")].map(e => ({
    which: e.dataset.store, tag: e.tagName, href: e.getAttribute("href") || "",
    label: e.textContent.replace(/\s+/g, " ").trim(),
  })),
  // ⚠️ `innerText`, not `textContent`. textContent includes the contents of
  // <script>, and the comment explaining this very guard quotes the promise —
  // so the check failed on its own documentation.
  promisesNoDownload: document.body.innerText.includes("بدون حساب ولا تنزيل"),
}));

try {
  /* ── today: no store listing exists ───────────────────────────── */
  for (const which of ["iphone", "android", "desktop"]) {
    const { ctx, page } = await open(which);
    const r = await readRoutes(page);
    await ctx.close();
    check(`${which}: with no store URL set, every button opens the web game`,
      r.buttons.length >= 5 && r.buttons.every(b => b.href === "../"),
      `${r.buttons.length} buttons`);
    check(`${which}: the category tiles open their pages, not the game`,
      r.tiles.length === 40 && r.tiles.every(h => /^c\/[A-Za-z0-9-]+\.html$/.test(h)),
      `${r.tiles.length} tiles, e.g. ${r.tiles[0]}`);
    check(`${which}: the badges stay disabled while there is nothing to link to`,
      r.badges.length === 4 && r.badges.every(b => b.tag === "SPAN" && !b.href
        && b.label.includes("قريباً")));
    check(`${which}: nothing opens in a new tab while the route stays on-site`,
      r.buttons.every(b => !b.target));
  }

  /* ── the day the apps ship ────────────────────────────────────── */
  const expect = { iphone: IOS, android: PLAY, desktop: "../" };
  for (const which of ["iphone", "android", "desktop"]) {
    const { ctx, page } = await open(which, { stores: true });
    const r = await readRoutes(page);
    await ctx.close();
    const want = expect[which];
    check(`${which}: every route goes to ${which === "desktop" ? "the web game" : "its own store"}`,
      r.buttons.length >= 5 && r.buttons.every(b => b.href === want),
      r.buttons.map(b => b.href).filter((v, i, a) => a.indexOf(v) === i).join(" · "));
    /* ⚠️ The tiles are deliberately NOT part of this any more: they open a
       category page on the site, which then carries its own play button with
       these same constants inlined into it. Asserting the old contract here
       would demand the tiles skip the page the owner asked them to open. */
    check(`${which}: the tiles stay on the site, whatever the store says`,
      r.tiles.every(h => /^c\//.test(h)), r.tiles[0]);
    check(`${which}: the showcase's «العب هذي الفئة» too`,
      r.play === want || r.play.startsWith(want + "#g="), r.play.slice(0, 46));
    if (which === "desktop") {
      check("desktop: a laptop is never sent to a phone store", !r.buttons.some(b => /apple|google/.test(b.href)));
    } else {
      check(`${which}: a store link is marked as leaving the site`,
        r.buttons.every(b => b.target === "_blank"));
    }
    /* Both badges light up on every platform — someone reading on a laptop is
       often deciding what to install on a phone they are not holding. */
    check(`${which}: both store badges become real links`,
      r.badges.length === 4 && r.badges.every(b => b.tag === "A" && b.href)
      && r.badges.some(b => b.href === IOS) && r.badges.some(b => b.href === PLAY),
      r.badges.map(b => b.tag).join(","));
    check(`${which}: and none of them still says «قريباً»`,
      r.badges.every(b => !b.label.includes("قريباً")), r.badges[0] && r.badges[0].label);

    /* ⚠️ The contradiction guard. The hero sells a full free game with no
       download; a store-only route makes that false. This is deliberately a
       FAILURE rather than a warning — the copy and the routing are two halves
       of one decision and must move together. */
    if (which !== "desktop") {
      check(`${which}: the hero no longer promises «بدون تنزيل» once a store is the only way in`,
        !r.promisesNoDownload,
        r.promisesNoDownload ? "the free-web-game badge is still on the page" : "");
      // …and it says something in its place, rather than being blanked. A
      // swap that emptied the badge would satisfy the check above.
      check(`${which}: and the buttons say «نزّل» instead`,
        r.buttons.some(b => b.text.includes("نزّل")),
        r.buttons.map(b => b.text).join(" · ").slice(0, 70));
    } else {
      // ⚠️ Desktop keeps the WEB copy, because desktop keeps the web route.
      // Swapping the copy on a platform whose button still opens the browser
      // game would be the same lie in the other direction.
      check("desktop: the copy stays the web copy, because the route did", r.promisesNoDownload);
    }
  }

  /* ── an iPad, which claims to be a Mac ────────────────────────── */
  const { ctx: ipadCtx, page: ipad } = await open("desktop", { stores: true, ipad: true });
  const ipadRoutes = await readRoutes(ipad);
  await ipadCtx.close();
  check("an iPad is offered the App Store despite reporting itself as a Mac",
    ipadRoutes.buttons.every(b => b.href === IOS), ipadRoutes.buttons[0] && ipadRoutes.buttons[0].href);

  /* ── someone who already has the game ─────────────────────────────
     `getInstalledRelatedApps()` is Android Chrome only and resolves late, so it
     must never gate a route: the page renders with the store link and quietly
     re-points at the game once the answer arrives. Both halves are checked —
     that it settles on the game, and that it was usable before the promise
     resolved. */
  const installedCtx = await browser.newContext({ userAgent: UAS.android, isMobile: true, hasTouch: true,
    viewport: { width: 390, height: 844 } });
  await installedCtx.addInitScript(() => {
    navigator.getInstalledRelatedApps = () => new Promise(r => setTimeout(() => r([{ platform: "webapp" }]), 350));
  });
  const ip = await installedCtx.newPage();
  ip.on("pageerror", e => errs.push("installed: " + e.message));
  await ip.route("**/preview/index.html", async route => {
    const res = await route.fetch();
    const body = (await res.text()).replace('android: "",', `android: "${PLAY}",`);
    await route.fulfill({ response: res, body });
  });
  await ip.goto(`http://127.0.0.1:${PORT}/preview/index.html`, { waitUntil: "load", timeout: 30000 });
  const early = await ip.evaluate(() => document.querySelector("[data-game]").getAttribute("href"));
  await ip.waitForTimeout(900);
  const late = await ip.evaluate(() => document.querySelector("[data-game]").getAttribute("href"));
  await installedCtx.close();
  check("a route is usable before the installed-app question is answered", !!early, early);
  check("and once the app is known to be installed, it opens their own copy",
    late === "../", `${early} → ${late}`);

  /* ── it must survive the API being absent or throwing ───────────── */
  const brokenCtx = await browser.newContext({ userAgent: UAS.android, isMobile: true, hasTouch: true,
    viewport: { width: 390, height: 844 } });
  await brokenCtx.addInitScript(() => {
    navigator.getInstalledRelatedApps = () => Promise.reject(new Error("no"));
  });
  const bp = await brokenCtx.newPage();
  const bad = [];
  bp.on("pageerror", e => bad.push(e.message));
  await bp.goto(`http://127.0.0.1:${PORT}/preview/index.html`, { waitUntil: "load", timeout: 30000 });
  await bp.waitForTimeout(700);
  const stillRoutes = await bp.evaluate(() => document.querySelector("[data-game]").getAttribute("href"));
  await brokenCtx.close();
  check("a rejected installed-app check breaks nothing", stillRoutes === "../" && bad.length === 0,
    bad[0] || stillRoutes);

  check("no page errors" + (errs.length ? ": " + errs[0] : ""), errs.length === 0);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
