// Every activation-code box, driven END TO END.
//
// tests/codepaths.mjs already pins the STRUCTURE — that the inputs exist, are
// wired, normalise, map errors and wait for auth restore. This one asks the
// blunter question the owner asked: when a player actually types a code and
// presses the thing, does the credit land?
//
// There are three ways in and they must behave identically:
//   1. the settings sheet   (#redeemInputSettings)
//   2. the paywall / plans  (#redeemInputPlans)
//   3. a reward in the inbox (no typing — a button carrying the code)
//
// For the two typed boxes each of these must hold, and each has a distinct way
// of failing silently:
//   • the box is REACHABLE — hit-tested, not merely present in the DOM. A modal
//     that opens under an overlay, or an input covered by the sticky actions
//     row, is invisible to querySelector and fatal to a player.
//   • the BUTTON submits, and so does ENTER. Enter is the reflex on a phone
//     keyboard, and it is a document-level keydown — build .292 added another
//     document keydown for the turn pill, which is exactly the kind of thing
//     that quietly eats a key.
//   • the code reaches the bridge VERBATIM after trimming, whitespace and case
//     included, because normalisation lives on the far side.
//   • on success the input CLEARS and the surface CLOSES, or the player types
//     the same code twice and gets «مستخدم من قبل» for their trouble.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8421;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.route("**/firebasejs/**", r => r.abort());
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // Signed in, with a bridge that records what it was handed and grants credit.
  await page.evaluate(() => {
    window.__redeemed = [];
    state.signedIn = true;
    state.authReady = true;
    window.IZZBAH = window.IZZBAH || {};
    window.IZZBAH.redeemCode = code => {
      window.__redeemed.push(code);
      state.gamesAllowed = (state.gamesAllowed || 0) + 5;
      return Promise.resolve({ games: 5 });
    };
  });

  for (const box of [
    { key: "settings", open: "openSettings", modal: "settingsModal", input: "redeemInputSettings", btn: "redeemBtnSettings" },
    { key: "plans", open: "openPlans", modal: "plansModal", input: "redeemInputPlans", btn: "redeemBtnPlans" },
  ]) {
    // ---- reachable: opened, on screen, and the top element at its own centre
    const reach = await page.evaluate(async o => {
      window[o.open]();
      await new Promise(r => setTimeout(r, 350));
      const inp = document.getElementById(o.input);
      const btn = document.getElementById(o.btn);
      // Modals scroll; bring the row into view exactly as a player would.
      inp.scrollIntoView({ block: "center" });
      await new Promise(r => setTimeout(r, 250));
      const hit = el => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return "zero-size";
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return "offscreen";
        const top = document.elementFromPoint(cx, cy);
        return top === el || el.contains(top) ? "ok" : "covered by " + (top ? top.className || top.tagName : "nothing");
      };
      return {
        modalOpen: document.getElementById(o.modal).classList.contains("open"),
        input: hit(inp), button: hit(btn),
        enabled: !inp.disabled && !btn.disabled,
        cleared: inp.value === "",
      };
    }, box);
    check(`«${box.key}»: the box opens and the input is actually tappable`,
      reach.modalOpen && reach.input === "ok" && reach.enabled, reach.input);
    check(`«${box.key}»: the activate button is tappable too`, reach.button === "ok", reach.button);
    check(`«${box.key}»: opening the surface clears any previous code`, reach.cleared);

    // ---- the BUTTON submits, the code arrives verbatim, the surface closes
    const viaBtn = await page.evaluate(async o => {
      window.__redeemed = [];
      const inp = document.getElementById(o.input);
      const before = (typeof gamesRemaining === "function") ? gamesRemaining() : null;
      inp.value = "  ab12-cd34  ";           // stray spaces: trimmed, case kept
      document.getElementById(o.btn).click();
      await new Promise(r => setTimeout(r, 500));
      return {
        sent: window.__redeemed.slice(),
        cleared: inp.value === "",
        closed: !document.getElementById(o.modal).classList.contains("open"),
        toast: (document.getElementById("appToast") || {}).textContent || "",
        before, after: (typeof gamesRemaining === "function") ? gamesRemaining() : null,
      };
    }, box);
    check(`«${box.key}»: the button sends the code, trimmed and verbatim`,
      viaBtn.sent.length === 1 && viaBtn.sent[0] === "ab12-cd34", JSON.stringify(viaBtn.sent));
    check(`«${box.key}»: it confirms with the new balance`,
      /تم التفعيل/.test(viaBtn.toast) && viaBtn.after > viaBtn.before,
      `${viaBtn.before}→${viaBtn.after} · ${viaBtn.toast}`);
    check(`«${box.key}»: the input clears and the surface closes on success`,
      viaBtn.cleared && viaBtn.closed);

    // ---- ENTER submits as well (the phone-keyboard reflex)
    const viaEnter = await page.evaluate(async o => {
      window[o.open]();
      await new Promise(r => setTimeout(r, 300));
      window.__redeemed = [];
      const inp = document.getElementById(o.input);
      inp.focus();
      inp.value = "ZZ99-YY88";
      inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      return { sent: window.__redeemed.slice(), closed: !document.getElementById(o.modal).classList.contains("open") };
    }, box);
    check(`«${box.key}»: Enter submits too`,
      viaEnter.sent.length === 1 && viaEnter.sent[0] === "ZZ99-YY88" && viaEnter.closed,
      JSON.stringify(viaEnter.sent));

    // ---- an empty box must not call the bridge, and must not close either
    const blank = await page.evaluate(async o => {
      window[o.open]();
      await new Promise(r => setTimeout(r, 300));
      window.__redeemed = [];
      document.getElementById(o.input).value = "   ";
      document.getElementById(o.btn).click();
      await new Promise(r => setTimeout(r, 300));
      const out = { sent: window.__redeemed.length,
                    stillOpen: document.getElementById(o.modal).classList.contains("open"),
                    toast: (document.getElementById("appToast") || {}).textContent || "" };
      window[o.key === "settings" ? "closeSettings" : "closePlans"]();
      return out;
    }, box);
    check(`«${box.key}»: whitespace alone is refused locally and stays open`,
      blank.sent === 0 && blank.stillOpen && /أدخل الكود/.test(blank.toast), blank.toast);
  }

  // ---- 3) the inbox reward: a button carrying the code, no typing ----
  const reward = await page.evaluate(async () => {
    window.__redeemed = [];
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    const before = gamesRemaining();
    redeemRewardCode("GIFT-0001", btn);
    await new Promise(r => setTimeout(r, 500));
    const out = { sent: window.__redeemed.slice(), label: btn.textContent, disabled: btn.disabled,
                  granted: gamesRemaining() > before };
    btn.remove();
    return out;
  });
  check("the inbox reward redeems its own code without any typing",
    reward.sent.length === 1 && reward.sent[0] === "GIFT-0001" && reward.granted,
    JSON.stringify(reward.sent));
  check("the reward button becomes its own receipt (spent, not re-pressable)",
    reward.disabled || /تم|✓/.test(reward.label), `«${reward.label.trim()}» disabled=${reward.disabled}`);

  // ---- a real rejection still reaches the player, from both boxes ----
  for (const box of [
    { key: "settings", open: "openSettings", input: "redeemInputSettings", btn: "redeemBtnSettings", modal: "settingsModal" },
    { key: "plans", open: "openPlans", input: "redeemInputPlans", btn: "redeemBtnPlans", modal: "plansModal" },
  ]) {
    const bad = await page.evaluate(async o => {
      window.IZZBAH.redeemCode = () => Promise.reject({ code: "used" });
      window[o.open]();
      await new Promise(r => setTimeout(r, 300));
      const inp = document.getElementById(o.input);
      inp.value = "USED-CODE";
      document.getElementById(o.btn).click();
      await new Promise(r => setTimeout(r, 400));
      const out = { toast: (document.getElementById("appToast") || {}).textContent || "",
                    stillOpen: document.getElementById(o.modal).classList.contains("open"),
                    kept: inp.value };
      window[o.key === "settings" ? "closeSettings" : "closePlans"]();
      window.IZZBAH.redeemCode = code => { window.__redeemed.push(code); return Promise.resolve({ games: 5 }); };
      return out;
    }, box);
    // Staying open matters: a rejected code the player wants to retype is
    // useless if the sheet has already shut behind the message.
    check(`«${box.key}»: a used code says so and leaves the box open to retry`,
      /مستخدم من قبل/.test(bad.toast) && bad.stillOpen, bad.toast);
  }

  /* LANDSCAPE. The board forces landscape, so a player topping up mid-game
     opens the settings gear on a short, wide screen — where a sticky actions
     row or a scroll trap is far likelier to sit on top of the input than it is
     in portrait. Reachability only; submitting is already proven above. */
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(400);
  for (const box of [
    { key: "settings", open: "openSettings", close: "closeSettings", input: "redeemInputSettings", btn: "redeemBtnSettings" },
    { key: "plans", open: "openPlans", close: "closePlans", input: "redeemInputPlans", btn: "redeemBtnPlans" },
  ]) {
    const land = await page.evaluate(async o => {
      window[o.open]();
      await new Promise(r => setTimeout(r, 350));
      const inp = document.getElementById(o.input);
      inp.scrollIntoView({ block: "center" });
      await new Promise(r => setTimeout(r, 300));
      const hit = el => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return "zero-size";
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return "offscreen";
        const top = document.elementFromPoint(cx, cy);
        return top === el || el.contains(top) ? "ok" : "covered by " + (top ? top.className || top.tagName : "nothing");
      };
      const out = { input: hit(inp), button: hit(document.getElementById(o.btn)) };
      window[o.close]();
      return out;
    }, box);
    check(`«${box.key}»: still reachable in LANDSCAPE (topping up mid-game)`,
      land.input === "ok" && land.button === "ok", `input ${land.input}, button ${land.button}`);
  }

  check("no uncaught JS errors anywhere in the redeem paths", errs.length === 0, errs.slice(0, 2).join(" | "));
} catch (e) {
  check(`harness completed`, false, e && e.message);
} finally {
  await browser.close();
  server.kill();
}

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
