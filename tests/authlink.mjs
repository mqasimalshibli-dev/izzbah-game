// Two sign-in methods, ONE account.
//
// Firebase issues a different uid per sign-in method, and entitlements/{uid} is
// keyed by uid. So a player who buys packs with Google and later taps Sign in
// with Apple opens a different, EMPTY account — their paid games are still
// there, in the other uid, but nothing in the app can reach them and they will
// read it as theft. Apple's guideline 4.8 makes that second button mandatory,
// which is why linking has to exist BEFORE Apple ships, not after.
//
// Firebase is aborted here, so the real popups cannot run. What this file owns
// is the decision layer: who is offered a link, when the row appears at all, and
// that the one genuinely dangerous failure — the method already belongs to a
// different account — is never resolved silently.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8525;
const checks = [];
const check = (n, ok, extra) => {
  checks.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`);
};

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 420, height: 880 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

// Stand in for the Firebase bridge. Real linking needs an OAuth popup; the
// decisions around it do not, and those are what break silently.
const fakeBridge = (providers, linked, onLink) => page.evaluate(([providers, linked, onLink]) => {
  window.__linkCalls = [];
  window.IZZBAH.authProviders = () => providers;
  window.IZZBAH.linkedProviders = () => window.__linked || linked;
  window.IZZBAH.linkProvider = (id) => {
    window.__linkCalls.push(id);
    if (onLink === "ok") { window.__linked = (window.__linked || linked).concat([id]); return Promise.resolve(window.__linked); }
    if (onLink === "taken") return Promise.reject({ code: "auth/credential-already-in-use" });
    if (onLink === "cancel") return Promise.reject({ code: "auth/popup-closed-by-user" });
    return Promise.reject({ code: "auth/network-request-failed" });
  };
}, [providers, linked, onLink]);

const GOOGLE = { id: "google.com", label: "Google" };
const APPLE = { id: "apple.com", label: "Apple" };
const openSettings = () => page.evaluate(async () => {
  openSettings(); await new Promise(r => setTimeout(r, 200));
  const b = document.getElementById("settingsLinkProvider");
  return b ? { text: b.textContent.trim(), provider: b.dataset.provider, disabled: b.disabled } : null;
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ---- signed out: nothing to link ----------------------------------------
  await page.evaluate(() => window.IZZBAH.applyAuth(false));
  await fakeBridge([GOOGLE, APPLE], [], "ok");
  check("signed OUT, no link is offered",
    (await page.evaluate(() => window.IZZBAH_TEST.pendingLinkProviders().length)) === 0);

  // ---- TODAY: Apple is off, so there is nothing to attach ------------------
  await page.evaluate(() => window.IZZBAH.applyAuth(true, "u-1"));
  await fakeBridge([GOOGLE], ["google.com"], "ok");
  await page.evaluate(() => renderSettingsSheet());
  const noneToday = await openSettings();
  check("with only Google enabled, the row does not appear at all", noneToday === null);
  check("...because nothing is pending",
    (await page.evaluate(() => window.IZZBAH_TEST.pendingLinkProviders().length)) === 0);
  await page.evaluate(() => closeSettings());

  // ---- the day Apple is switched on ----------------------------------------
  await fakeBridge([GOOGLE, APPLE], ["google.com"], "ok");
  await page.evaluate(() => renderSettingsSheet());
  const offered = await openSettings();
  check("a Google-only account is offered the Apple link", !!offered);
  check("...naming the method it will attach", offered && /Apple/.test(offered.text), offered && offered.text);
  check("...and pointing at the right provider", offered && offered.provider === "apple.com");

  // The row must sit ABOVE «حذف الحساب» — a destructive button belongs last,
  // and a link button rendered after it pushes deletion into the middle of the
  // block where it is easier to hit by accident.
  const order = await page.evaluate(() => {
    const kids = [...document.getElementById("settingsAccount").children].map(e => e.className);
    return { link: kids.findIndex(c => /sa-link/.test(c)), del: kids.findIndex(c => /sa-danger/.test(c)) };
  });
  check("the link button sits before «حذف الحساب», which stays last",
    order.link > -1 && order.del > -1 && order.link < order.del, `link ${order.link}, delete ${order.del}`);

  // ---- linking succeeds -----------------------------------------------------
  await page.evaluate(async () => {
    document.getElementById("settingsLinkProvider").click();
    await new Promise(r => setTimeout(r, 350));
  });
  const after = await page.evaluate(() => ({
    calls: window.__linkCalls,
    linked: window.__linked,
    stillOffered: !!document.getElementById("settingsLinkProvider"),
    pending: window.IZZBAH_TEST.pendingLinkProviders().length,
  }));
  check("pressing it links the offered method", after.calls.join(",") === "apple.com", after.calls.join(","));
  check("...and both methods now sit on the one account",
    (after.linked || []).length === 2, (after.linked || []).join(","));
  // providerData does not refresh on its own; without the reload the row would
  // keep offering to attach what was just attached.
  check("...so the row stops offering it", !after.stillOffered && after.pending === 0);

  // ---- the dangerous failure ------------------------------------------------
  // The method already belongs to a DIFFERENT account, which probably holds its
  // own purchases. Merging two paid accounts is not a decision the app may make
  // on its own, so it must say so rather than fail quietly or guess.
  await page.evaluate(() => { window.__linked = null; document.getElementById("notePop").classList.remove("open"); });
  await fakeBridge([GOOGLE, APPLE], ["google.com"], "taken");
  await page.evaluate(() => renderSettingsSheet());
  await page.evaluate(async () => {
    openSettings(); await new Promise(r => setTimeout(r, 150));
    document.getElementById("settingsLinkProvider").click();
    await new Promise(r => setTimeout(r, 350));
  });
  const taken = await page.evaluate(() => ({
    open: document.getElementById("notePop").classList.contains("open"),
    title: (document.getElementById("notePopTitle") || {}).textContent || "",
    msg: (document.getElementById("notePopMsg") || {}).textContent || "",
    btnBack: !document.getElementById("settingsLinkProvider").disabled,
  }));
  check("a method owned by another account is reported, not swallowed", taken.open);
  check("...saying so plainly", /حساب آخر/.test(taken.title + taken.msg), taken.title);
  check("...and pointing at a human, since merging two paid accounts is not automatic",
    /izzbahgame@gmail\.com/.test(taken.msg));
  check("...leaving the button usable again", taken.btnBack);

  // ---- cancelling is not a failure ------------------------------------------
  await page.evaluate(() => document.getElementById("notePop").classList.remove("open"));
  await fakeBridge([GOOGLE, APPLE], ["google.com"], "cancel");
  await page.evaluate(() => renderSettingsSheet());
  await page.evaluate(async () => {
    openSettings(); await new Promise(r => setTimeout(r, 150));
    document.getElementById("settingsLinkProvider").click();
    await new Promise(r => setTimeout(r, 350));
  });
  const cancelled = await page.evaluate(() => ({
    note: document.getElementById("notePop").classList.contains("open"),
    label: document.getElementById("settingsLinkProvider").textContent.trim(),
    usable: !document.getElementById("settingsLinkProvider").disabled,
  }));
  check("closing the popup shows no error", !cancelled.note);
  check("...and the button goes back to its label, not «جارٍ»",
    cancelled.usable && !/جارٍ/.test(cancelled.label), cancelled.label);

  // ---- it works in BOTH directions ------------------------------------------
  // Easy to build the Google→Apple case and assume the reverse follows. It only
  // does because the row is computed as «every enabled method this account does
  // not yet have» rather than being hardcoded to offer Apple. Someone
  // simplifying that later would break Apple-first players — who, once Apple
  // ships, are the NEW ones, i.e. the ones most likely to buy.
  await page.evaluate(() => { window.__linked = null; });
  await fakeBridge([GOOGLE, APPLE], ["apple.com"], "ok");
  await page.evaluate(() => renderSettingsSheet());
  const reverse = await openSettings();
  check("an APPLE-only account is offered the Google link", !!reverse);
  check("...naming Google, not Apple", reverse && reverse.provider === "google.com",
    reverse && reverse.text);
  await page.evaluate(() => closeSettings());

  // ---- an already-linked account is offered nothing -------------------------
  await fakeBridge([GOOGLE, APPLE], ["google.com", "apple.com"], "ok");
  await page.evaluate(() => renderSettingsSheet());
  check("an account with BOTH methods sees no row",
    (await page.evaluate(() => !document.getElementById("settingsLinkProvider"))));

  // ---- and the SHIPPED configuration is the safe one ------------------------
  // Read from the source, because the real bridge only exists once Firebase
  // loads and this harness deliberately aborts it — asking the page would prove
  // nothing. Apple must stay OFF until its Services ID exists: a provider that
  // is enabled but not configured at Apple's end fails at the popup with an
  // unreadable OAuth error, which to a player is simply a broken app.
  const shipped = readFileSync(join(ROOT, "index.html"), "utf8");
  const block = shipped.slice(shipped.indexOf('"apple.com": {'));
  const appleSpec = block.slice(0, block.indexOf("},"));
  check("Apple is declared, ready for the day the Services ID exists",
    /"apple\.com"/.test(shipped) && /OAuthProvider\("apple\.com"\)/.test(shipped));
  check("...but still DISABLED, so nobody meets an OAuth error we cannot fix",
    /enabled:\s*false/.test(appleSpec), appleSpec.split("\n")[1] || "");
  check("Google is enabled", /"google\.com":\s*\{[^}]*enabled:\s*true/s.test(shipped));

  check("no uncaught JS errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 4));
} catch (e) {
  check("harness completed", false);
  console.log("  harness error:", e.message);
} finally {
  await browser.close();
  server.kill();
}
const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
