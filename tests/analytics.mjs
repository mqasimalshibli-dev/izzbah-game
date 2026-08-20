// Measurement on the landing page.
//
// The game has had Firebase Analytics for a long time; the site had none, so a
// launch would have produced no answer to the only three questions worth asking
// of a marketing page — did anyone arrive, did they press play, did the taster
// do anything. Traffic you do not measure is gone for good, which is why this
// went in before launch rather than after.
//
// ⚠️ THE SAME GA4 PROPERTY AS THE GAME. The site and the game are one funnel —
// arrive, press play, finish a game — and a second property would cut it in
// half exactly where the interesting question is.
//
// ⚠️ AND MEASUREMENT MUST NEVER COST THE PAGE ANYTHING. gtag is a third-party
// script; ad blockers are common and googletagmanager has bad days. Every call
// goes through a `track()` that no-ops when it is missing, and the test that
// matters most here is the one where the script never loads at all.
//
// ⚠️ Deliberately THREE events. A page instrumented everywhere produces numbers
// nobody reads; each of these maps to a decision — is the traffic real, does
// the hero convert, is the taster worth the section it occupies.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8783;
const PROP = "G-FBSCK70M8C";
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`); };

/* ── the snippet ─────────────────────────────────────────────── */
const src = readFileSync(join(ROOT, "preview", "index.html"), "utf8");
const game = readFileSync(join(ROOT, "index.html"), "utf8");

check("the site measures at all", src.includes("googletagmanager.com/gtag/js"));
check("it is the same property the game uses",
  src.includes(PROP) && game.includes(PROP), PROP);
/* ⚠️ `async`. A synchronous third-party script in <head> blocks the parser, and
   this repo has already lost a first paint to exactly that (the Google Fonts
   stylesheet — see the .215 note). */
check("the tag is async, so it cannot block the paint",
  /<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js/.test(src));
// This measures whether the page works, not who is reading it.
check("ad signals are off", /allow_google_signals:\s*false/.test(src));
check("and the IP is anonymised", /anonymize_ip:\s*true/.test(src));
/* The privacy policy is published at legal.html and generated from the game's
   own text — so if the site starts measuring, the disclosure has to already
   cover it. */
const legal = readFileSync(join(ROOT, "preview", "legal.html"), "utf8");
check("analytics is disclosed in the published privacy policy",
  legal.includes("Google Analytics"), "legal.html#privacy");

/* ⚠️ Every call must go through the guard. A bare `gtag(...)` anywhere in the
   page is an uncaught ReferenceError the moment a blocker removes the script. */
const bare = [...src.matchAll(/(?<![.\w])gtag\s*\(/g)].length;
const inHead = [...src.matchAll(/gtag\("(?:js|config)"/g)].length + 2;   // the snippet's own
check("no unguarded gtag call outside the snippet", bare <= inHead + 1,
  `${bare} calls, ${inHead} expected in the snippet`);

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const url = `http://127.0.0.1:${PORT}/preview/index.html`;

try {
  /* ── the events ───────────────────────────────────────────────
     Read off `dataLayer` rather than a stubbed `gtag`: the page defines its own
     `function gtag()` in the head, which replaces any stub an init script
     installs — the first version of this probe reported zero events for that
     reason and would have "passed" a page that sent none. */
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await ctx.route("**/googletagmanager.com/**", r => r.fulfill({ status: 200, body: "" }));
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(900);

  const events = async () => page.evaluate(() =>
    (window.dataLayer || []).map(a => Array.from(a)).filter(e => e[0] === "event"));

  check("nothing is reported before the reader does anything",
    (await events()).length === 0, JSON.stringify(await events()));

  // the taster
  await page.evaluate(() => document.querySelectorAll(".try-choice")[0].click());
  await page.waitForTimeout(250);
  const t = (await events()).find(e => e[1] === "taster_answer");
  check("answering the taster is reported", !!t, t && JSON.stringify(t[2]));
  check("…with whether it was right, and which question",
    t && typeof t[2].correct === "boolean" && t[2].step === 1 && !!t[2].category,
    t && `${t[2].category} · step ${t[2].step}`);

  /* Which BUTTON, not just that one was pressed — the hero, the taster's CTA
     and the closing button are three different arguments about the page. */
  const press = async sel => page.evaluate(s => {
    const a = s === "hero" ? [...document.querySelectorAll("[data-game]")].find(x => x.closest(".hero"))
            : [...document.querySelectorAll("[data-game]")].find(x => x.closest(s));
    a.addEventListener("click", e => e.preventDefault(), { once: true });
    a.click();
  }, sel);
  await press("hero");
  await press("#try");
  await page.waitForTimeout(200);
  const plays = (await events()).filter(e => e[1] === "play_click");
  check("pressing play is reported", plays.length === 2, `${plays.length} events`);
  check("…and says which button it was",
    plays.map(p => p[2].where).sort().join(",") === "hero,taster",
    plays.map(p => p[2].where).join(","));
  /* Where it SENT them, too. The router points at a store or at the web build
     depending on the platform and the STORE constants, and "play was pressed"
     means a different thing in each case. */
  check("…and where it sent them", plays.every(p => p[2].destination === "web"),
    plays[0] && plays[0].destination);

  await page.evaluate(() => {
    const g = document.querySelector(".gcard");
    g.addEventListener("click", e => e.preventDefault(), { once: true });
    g.click();
  });
  await page.waitForTimeout(200);
  /* ⚠️ `category_open`, not `category_click` — the tiles used to deep-link into
     the game and now open the category's own page, which is a different thing
     to count. The name changed with the behaviour so a year of one event does
     not get averaged with a year of the other. */
  const cat = (await events()).find(e => e[1] === "category_open");
  check("opening a category page is reported, with which category",
    !!cat && !!cat[2].category, cat && cat[2].category);

  check("no page errors while measuring" + (errs.length ? ": " + errs[0] : ""), errs.length === 0);
  await ctx.close();

  /* ── THE ONE THAT MATTERS: the script never loads ─────────────
     An ad blocker, a data-saver, a corporate proxy, or a bad night for
     googletagmanager. The page is a marketing page whose job is to load. */
  const blocked = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await blocked.route("**/googletagmanager.com/**", r => r.abort());
  const bp = await blocked.newPage();
  const bad = [];
  bp.on("pageerror", e => bad.push(e.message));
  await bp.goto(url, { waitUntil: "load", timeout: 30000 });
  await bp.waitForTimeout(1200);
  await bp.evaluate(() => document.querySelectorAll(".try-choice")[0].click());
  await bp.waitForTimeout(250);
  await bp.evaluate(() => {
    const g = document.querySelector(".gcard");
    g.addEventListener("click", e => e.preventDefault(), { once: true });
    g.click();
  });
  await bp.waitForTimeout(200);
  const alive = await bp.evaluate(() => ({
    taster: !document.getElementById("tryAfter").hidden,
    rail: !!document.querySelector(".c3.is-active"),
    tiles: document.querySelectorAll(".gcard").length,
  }));
  await blocked.close();
  check("a blocked tag raises no error at all", bad.length === 0, bad[0] || "");
  check("and the page still works entirely",
    alive.taster && alive.rail && alive.tiles === 40,
    `taster ${alive.taster}, rail ${alive.rail}, ${alive.tiles} tiles`);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
