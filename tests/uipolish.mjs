// Guards the "UI polish pack" (2026-07-24): skeleton loaders, optimistic
// rendering with rollback, and hover/focus tooltips for icon-only buttons —
// all behind ONE reversible flag (UI_POLISH). Splits into static source
// assertions (the wiring is present) + live browser checks (it actually works
// offline: the ui-polish class, a skeleton renders, and the tooltip sweep
// mirrors aria-label → title only for wordless controls).
import { readFileSync } from "fs";
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8321;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const html = readFileSync(join(ROOT, "game-mobile.html"), "utf8");

// ---- static: the flag, helpers and CSS exist ----
check("single reversible UI_POLISH flag is declared",
  /const UI_POLISH = true;/.test(html) && /classList\.toggle\("ui-polish"/.test(html));
check("skeleton() helper falls back to plain text when the flag is off",
  /function skeleton\(variant, n, legacy\)/.test(html)
  && /if \(!UI_POLISH\) return `<div class="prem-empty">/.test(html));
check("skeleton + shimmer CSS is present",
  /@keyframes skShimmer/.test(html) && /\.sk-wrap \{/.test(html) && /\.sk::after/.test(html));

// ---- static: skeletons replaced the «جارٍ التحميل…» placeholders ----
check("premium panel uses skeletons (list/players/orders)",
  /list\.innerHTML = skeleton\("prem", 5\)/.test(html)
  && /players\.innerHTML = skeleton\("prem", 4\)/.test(html)
  && /orders\.innerHTML = skeleton\("line", 3\)/.test(html));
check("admin feedback list uses a skeleton",
  /box\.innerHTML = skeleton\("line", 4\)/.test(html));
check("feedback thread shows a skeleton while loading",
  /if \(UI_POLISH\) \$\("#feedbackThread"\)\.innerHTML = skeleton\("line", 3\)/.test(html));

// ---- static: optimistic rendering with rollback ----
check("community vote rolls back on a failed write",
  /const prevVotes = cat\.votes \|\| 0;/.test(html)
  && /if \(UI_POLISH\) \{ \/\/ reconcile: undo the optimistic change on failure/.test(html));
check("community delete removes the card at once and restores on failure",
  /if \(UI_POLISH\) card\.style\.display = "none";/.test(html)
  && /catch\(\(\) => \{ if \(UI_POLISH\) card\.style\.display = ""; showToast\("تعذّر الحذف"\); \}\)/.test(html));
check("feedback send shows an optimistic bubble and rolls it back on failure",
  /pending = feedbackBubble\(\{ from: isAdminView \? "admin" : "user"/.test(html)
  && /if \(pending\) \{ pending\.remove\(\); inp\.value = text; \}/.test(html));

// ---- static: custom tooltip bubble ----
check("icon-only tooltips use the custom styled bubble (izz-tip), not a native title",
  /const wordless = el => !\/\[\\p\{L\}\\p\{N\}\]\/u\.test/.test(html)
  && /\.izz-tip \{ position: fixed;/.test(html)
  && /tipEl\.className = "izz-tip"/.test(html)
  && /el\.removeAttribute\("title"\)/.test(html));

// ---- static: early-redeem fix (code entered before auth restore is queued, not refused) ----
check("redeeming right after app open waits for the auth restore instead of refusing",
  /state\.authReady = true; \/\/ first fire = the session restore has resolved/.test(html)
  && /if \(!ready\(\) && !state\.authReady\) \{/.test(html)
  && /جارٍ استئناف تسجيل الدخول/.test(html));

// ---- static: game-count badge opens the my-games box ----
check("the game-count badge opens the packs box with a live balance header",
  /openPlans\(\);\s*\n\s*const bridge = window\.IZZBAH && window\.IZZBAH\.refreshMyCodes;\s*\n\s*if \(bridge\) bridge\(\)\.then\(\(\) => \{ renderPlayBalance\(\); renderPlansBalance\(\); \}\);/.test(html)
  && /function renderPlansBalance\(\)/.test(html)
  && /id="plansBalance"/.test(html));

// ---- live: the flag actually wires things up offline ----
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1600);

  check("the <html> element carries the ui-polish class",
    await page.evaluate(() => document.documentElement.classList.contains("ui-polish")));

  // Tooltips: hovering an icon-only button shows the STYLED floating bubble
  // (.izz-tip) with the label, strips the native title (no double tooltip),
  // and leaves worded buttons alone.
  const tips = await page.evaluate(() => {
    const probe = (label, inner, useTitle) => {
      const b = document.createElement("button");
      if (useTitle) b.setAttribute("title", label); else b.setAttribute("aria-label", label);
      b.innerHTML = inner;
      document.body.appendChild(b);
      b.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      const tip = document.querySelector(".izz-tip");
      const out = {
        shown: !!tip && tip.classList.contains("show"),
        text: tip ? tip.textContent : "",
        titleGone: !b.hasAttribute("title"),
        ariaKept: b.getAttribute("aria-label") === label
      };
      b.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
      b.remove();
      return out;
    };
    return {
      icon: probe("تبديل الدور", '<svg viewBox="0 0 1 1"></svg>', false),
      titled: probe("إغلاق", "✕", true),
      worded: probe("حفظ الفئة", "حفظ", false)
    };
  });
  check("hovering a wordless icon button shows the styled bubble with its label",
    tips.icon.shown && tips.icon.text === "تبديل الدور");
  check("a title-only icon button works too: bubble shown, native title stripped, aria-label kept",
    tips.titled.shown && tips.titled.text === "إغلاق" && tips.titled.titleGone && tips.titled.ariaKept);
  check("a button with real words is left alone (no bubble)", !tips.worded.shown);

  // Early redeem: BEFORE auth restore (authReady false) a code isn't refused —
  // it waits, then proceeds once the session lands.
  const earlyRedeem = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const toasts = [];
    const orig = window.showToast; window.showToast = m => toasts.push(m);
    const calls = [];
    state.authReady = false; state.signedIn = false;
    delete window.IZZBAH.redeemCode; // bridge not attached yet either
    const inp = document.getElementById("redeemInputSettings");
    inp.value = "AB2D-EF4H";
    document.getElementById("redeemBtnSettings").click();
    const waitingMsg = toasts[toasts.length - 1] || "";
    await sleep(400); // still waiting…
    const refusedTooEarly = toasts.some(m => /سجّل الدخول/.test(m));
    // …now the session restores and the bridge attaches
    window.IZZBAH.redeemCode = raw => { calls.push(raw); return Promise.resolve({ gamesAllowed: 2, premium: false }); };
    window.IZZBAH.applyAuth(true, "late-u");
    await sleep(700);
    window.showToast = orig;
    return { waitingMsg, refusedTooEarly, calls };
  });
  check("a code entered before the session restores is queued (waiting toast, no refusal)",
    /جارٍ استئناف/.test(earlyRedeem.waitingMsg) && !earlyRedeem.refusedTooEarly);
  check("once the session lands, the queued code is redeemed automatically",
    earlyRedeem.calls.length === 1 && earlyRedeem.calls[0] === "AB2D-EF4H");

  // A skeleton actually renders: open the admin feedback thread (no sign-in
  // needed for the admin view) and confirm the shimmer placeholder is injected
  // synchronously, before the (empty, offline) loader resolves.
  const sk = await page.evaluate(() => {
    try { openFeedback("tester-uid", "لاعب"); } catch (e) { return "throw:" + e.message; }
    const box = document.getElementById("feedbackThread");
    return box ? box.querySelector(".sk-wrap") ? "skeleton" : box.innerHTML.slice(0, 40) : "no-box";
  });
  check("opening a loader paints a skeleton (not bare text)", sk === "skeleton");

  // Welcome screen on a SHORT laptop window: the old justify-content:center
  // pushed the overflowing top (tent + logo) above the scroll origin — cut off
  // and unreachable, and the page "wouldn't scroll". With the auto-margin fix
  // the column pins to a reachable top and the whole screen scrolls.
  const shortPage = await browser.newPage({ viewport: { width: 1100, height: 420 } });
  await shortPage.route("**/firebasejs/**", route => route.abort());
  await shortPage.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
  await shortPage.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await shortPage.waitForTimeout(1600);
  const wlc = await shortPage.evaluate(() => {
    const box = document.querySelector(".wlc");
    const center = document.querySelector(".wlc-center");
    if (!box || !center) return { ok: false };
    box.scrollTop = 0;
    const topReachable = center.getBoundingClientRect().top >= box.getBoundingClientRect().top - 1;
    const overflowing = box.scrollHeight > box.clientHeight + 4;
    box.scrollTop = 99999;
    const canScrollToBottom = !overflowing || box.scrollTop > 0;
    return { ok: true, topReachable, overflowing, canScrollToBottom,
             centersWhenRoom: getComputedStyle(center).marginTop !== "0px" || overflowing };
  });
  check("short-window welcome: the logo/top is reachable (not clipped above the fold)",
    wlc.ok && wlc.topReachable);
  check("short-window welcome: the screen scrolls when it overflows",
    wlc.ok && wlc.canScrollToBottom);
  await shortPage.close();

  check("no uncaught JS errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 4));
} catch (e) {
  check("harness completed", false);
  console.log("  harness error:", e.message);
} finally {
  await browser.close();
  server.kill();
}
process.exit(checks.every(Boolean) ? 0 : 1);
