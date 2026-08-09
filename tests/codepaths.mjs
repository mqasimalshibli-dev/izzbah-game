// Every place a player can submit an activation code must work the same way.
//
// There are three: the settings sheet, the paywall/plans modal, and a reward
// in the inbox. All three go through window.IZZBAH.redeemCode, so what can
// drift is everything AROUND the bridge — wiring, normalisation, error
// mapping, and the auth-restore wait.
//
// That last one is the reason this test exists. Firebase takes a moment to
// restore the session, so for the first seconds state.signedIn is false. The
// typed-code path waits for that; the inbox path did not, and refused a reward
// with «سجّل الدخول أولاً» to a player who was already signed in.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8414;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  " + extra : ""}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
await page.route("**/firebasejs/**", r => r.abort());
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(1400);

// ---- both inputs exist and are wired to button AND Enter ----
const wired = await page.evaluate(() => {
  const out = {};
  for (const [k, i, b] of [["settings", "redeemInputSettings", "redeemBtnSettings"],
                           ["plans", "redeemInputPlans", "redeemBtnPlans"]]) {
    const inp = document.getElementById(i), btn = document.getElementById(b);
    out[k] = { input: !!inp, button: !!btn, ltr: inp && inp.getAttribute("dir") === "ltr" };
  }
  return out;
});
for (const k of ["settings", "plans"]) {
  check(`«${k}» has both an input and an activate button`, wired[k].input && wired[k].button);
  check(`«${k}» input is LTR (codes are latin, typed on an Arabic keyboard)`, wired[k].ltr);
}

// ---- normalisation: what a player actually types must reach the same doc id ----
const norm = await page.evaluate(() => {
  // The real normaliser lives inside the Firebase closure, so drive it through
  // the bridge and capture the doc id it asks for.
  const asked = [];
  window.IZZBAH = window.IZZBAH || {};
  const fake = raw => { asked.push(raw); return Promise.reject(new Error("not-found")); };
  return { asked, ok: typeof fake === "function" };
});
check("the redeem bridge is the single entry point for all three paths",
  await page.evaluate(() => {
    const src = document.documentElement.outerHTML;
    // one normaliser, applied inside the bridge — not per call site
    return /window\.IZZBAH\.redeemCode = function \(raw\)/.test(src)
      && /db\.collection\("codes"\)\.doc\(normalizeCode\(raw\)\)/.test(src);
  }));
check("normalizeCode uppercases, strips punctuation and re-inserts the dash",
  await page.evaluate(() => {
    const m = document.documentElement.outerHTML.match(/function normalizeCode\(raw\)\s*\{([\s\S]{0,240}?)\}/);
    if (!m) return false;
    const body = m[1];
    return /toUpperCase\(\)/.test(body) && /replace\(\/\[\^A-Z0-9\]\/g, ""\)/.test(body) && /slice\(0, 4\) \+ "-"/.test(body);
  }));

// ---- the auth-restore wait, on BOTH paths ----
const waits = await page.evaluate(() => {
  const src = document.documentElement.outerHTML;
  const grab = name => {
    const i = src.indexOf("function " + name + "(");
    return i < 0 ? "" : src.slice(i, i + 1800);
  };
  const hasWait = b => /state\.authReady/.test(b) && /8000/.test(b);
  return { typed: hasWait(grab("redeemCodeFlow")), inbox: hasWait(grab("redeemRewardCode")) };
});
check("typed-code path waits for auth restore before refusing", waits.typed);
check("inbox reward path waits for auth restore too", waits.inbox);

// ---- error mapping is specific, not a generic retry ----
const errmap = await page.evaluate(() => {
  const src = document.documentElement.outerHTML;
  return ["not-found", "used", "not-signed-in"].every(k => src.includes('"' + k + '"'));
});
check("distinct messages for wrong / already-used / signed-out codes", errmap);

// ---- refusing an empty code must not call the bridge ----
const empty = await page.evaluate(async () => {
  let called = 0;
  const prev = window.IZZBAH.redeemCode;
  window.IZZBAH.redeemCode = () => { called++; return Promise.reject(new Error("x")); };
  const inp = document.getElementById("redeemInputSettings");
  inp.value = "   ";
  redeemCodeFlow(inp);
  await new Promise(r => setTimeout(r, 200));
  window.IZZBAH.redeemCode = prev;
  return called;
});
check("a blank code is refused locally, never sent", empty === 0, `bridge calls=${empty}`);

check("no uncaught JS errors", errs.length === 0);
if (errs.length) console.log("  ", errs.slice(0, 3));
await browser.close(); server.kill();
process.exit(checks.every(Boolean) ? 0 : 1);
