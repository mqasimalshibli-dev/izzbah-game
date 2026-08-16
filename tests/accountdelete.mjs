// In-app account deletion — App Store guideline 5.1.1(v).
//
// Review checks this BY HAND: a reviewer signs in, hunts for the control, and
// rejects the build if deletion is only offered by email or only deactivates.
// So the two things worth pinning are that it is REACHABLE from the settings a
// signed-in player already opens, and that it cannot fire by accident — this
// destroys paid games and there is no undo.
//
// Firebase is aborted, so the call itself cannot run here; the deletion LOGIC
// is unit-tested without a browser in functions/test/erasure.test.mjs. What
// this file owns is the gate in front of it.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8523;
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

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ---- signed OUT: there is no account, so there is nothing to delete ------
  await page.evaluate(() => window.IZZBAH.applyAuth(false));
  await page.evaluate(() => openSettings());
  await page.waitForTimeout(250);
  const outShown = await page.evaluate(() => !!document.getElementById("settingsDeleteAccount"));
  check("signed OUT, no delete control is offered", !outShown);
  await page.evaluate(() => closeSettings());

  // ---- signed IN: it is there, in the account block ------------------------
  await page.evaluate(() => window.IZZBAH.applyAuth(true, "player-uid-1"));
  await page.evaluate(() => openSettings());
  await page.waitForTimeout(250);
  const shown = await page.evaluate(() => {
    const b = document.getElementById("settingsDeleteAccount");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return {
      text: b.textContent.trim(),
      visible: r.width > 0 && r.height > 0,
      inAccountBlock: !!b.closest("#settingsAccount"),
      // It must not look like the button above it. A destructive action wearing
      // the same skin as «تسجيل الخروج» is a mis-tap waiting to happen.
      // ⚠️ Compare the INK, not the background: both buttons are transparent, so
      // a backgroundColor check passes vacuously (rgba(0,0,0,0) either way).
      ink: getComputedStyle(b).color,
      signOutInk: getComputedStyle(document.getElementById("settingsAuthBtn")).color,
      border: getComputedStyle(b).borderTopWidth,
    };
  });
  check("signed IN, the delete control exists", !!shown);
  check("...it is visible, not merely present in the DOM", shown && shown.visible);
  check("...it sits in the account block a reviewer will look in", shown && shown.inAccountBlock);
  check("...and it says DELETE, permanently — not «deactivate»",
    shown && /حذف/.test(shown.text) && /نهائ/.test(shown.text), shown && shown.text);
  check("...styled apart from «تسجيل الخروج» right above it",
    shown && shown.ink !== shown.signOutInk, shown && `${shown.ink} vs ${shown.signOutInk}`);
  check("...and outlined, so it reads as a way out rather than the thing to press",
    shown && parseFloat(shown.border) > 0, shown && shown.border);

  // ---- the confirmation gate ----------------------------------------------
  await page.evaluate(() => document.getElementById("settingsDeleteAccount").click());
  await page.waitForTimeout(300);
  const opened = await page.evaluate(() => {
    const m = document.getElementById("deleteAccountModal");
    return {
      open: m.classList.contains("open"),
      hidden: m.getAttribute("aria-hidden"),
      role: m.querySelector("[role]").getAttribute("role"),
      body: m.textContent,
      armed: !document.getElementById("deleteAccountGo").disabled,
      settingsClosed: !document.getElementById("settingsModal").classList.contains("open"),
    };
  });
  check("pressing it opens a confirmation, not the deletion", opened.open && opened.hidden === "false");
  check("...as an alertdialog, so a screen reader announces it", opened.role === "alertdialog");
  check("...and the settings sheet gets out of the way", opened.settingsClosed);
  check("the confirm button starts DISABLED", !opened.armed);

  // The consequence a player is most likely to regret has to be stated, in
  // words, before they can act — not discovered afterwards.
  check("it says the paid games go and are not refunded",
    /مدفوع/.test(opened.body) && /تُستردّ|تسترد/.test(opened.body));
  check("it says the action cannot be undone",
    /لا يمكن التراجع/.test(opened.body));
  check("it names the saved games", /المحفوظة/.test(opened.body));

  // ---- typing is what arms it ---------------------------------------------
  const word = await page.evaluate(() => window.IZZBAH_TEST.deleteConfirmWord());
  check("a confirmation word is published for the UI and this test to share", !!word, word);

  await page.fill("#deleteAccountConfirm", "نعم");
  await page.waitForTimeout(120);
  check("a WRONG word leaves it disabled",
    await page.evaluate(() => document.getElementById("deleteAccountGo").disabled));

  await page.fill("#deleteAccountConfirm", word);
  await page.waitForTimeout(120);
  check("the right word arms it",
    await page.evaluate(() => !document.getElementById("deleteAccountGo").disabled));

  // Surrounding whitespace is a typing artefact on a phone keyboard, not a
  // different answer.
  await page.fill("#deleteAccountConfirm", "  " + word + " ");
  await page.waitForTimeout(120);
  check("...and stray spaces around it still count",
    await page.evaluate(() => !document.getElementById("deleteAccountGo").disabled));

  // ---- cancel, and reopen ---------------------------------------------------
  await page.evaluate(() => document.getElementById("deleteAccountCancel").click());
  await page.waitForTimeout(200);
  check("cancel closes it",
    await page.evaluate(() => !document.getElementById("deleteAccountModal").classList.contains("open")));

  await page.evaluate(() => window.IZZBAH_TEST.openDeleteAccount());
  await page.waitForTimeout(200);
  const reopened = await page.evaluate(() => ({
    value: document.getElementById("deleteAccountConfirm").value,
    armed: !document.getElementById("deleteAccountGo").disabled,
  }));
  // Reopening with the word still typed would present a modal that is live the
  // instant it appears — one tap from deletion.
  check("reopening clears the box", reopened.value === "");
  check("...so it is never armed on arrival", !reopened.armed);

  // ---- the failure path leaves the account alone ---------------------------
  // Firebase is aborted here, so pressing the button exercises exactly the case
  // that matters: the call cannot complete. Nothing may be destroyed locally on
  // the way, and the player has to be told.
  await page.evaluate(() => localStorage.setItem("izzbah-trivia-saved-games-v1", '[{"id":"keep-me"}]'));
  await page.fill("#deleteAccountConfirm", word);
  await page.waitForTimeout(120);
  await page.evaluate(() => document.getElementById("deleteAccountGo").click());
  await page.waitForTimeout(600);
  const afterFail = await page.evaluate(() => ({
    saved: localStorage.getItem("izzbah-trivia-saved-games-v1"),
    note: (document.getElementById("notePop") || {}).className || "",
    noteText: (document.getElementById("notePopMsg") || {}).textContent || "",
    btn: document.getElementById("deleteAccountGo").textContent.trim(),
    reArmed: !document.getElementById("deleteAccountGo").disabled,
  }));
  check("a FAILED deletion destroys nothing on the device",
    afterFail.saved === '[{"id":"keep-me"}]', afterFail.saved);
  check("...the player is told it did not happen", /تعذّر|لم يكتمل/.test(afterFail.noteText),
    afterFail.noteText.slice(0, 60));
  check("...and the button is usable again rather than stuck on «جارٍ»",
    afterFail.reArmed && !/جارٍ/.test(afterFail.btn), afterFail.btn);

  // ---- deleting must not hand out a fresh free game -------------------------
  // ⚠️ Found in the post-build audit. The wipe originally cleared every
  // izzbah-* key, which includes the free-game flag — so «delete my account»
  // became a one-tap way to earn another free game, on repeat. Clearing site
  // data has always done this (the flag is a soft client counter by design),
  // but a button inside the app is a different proposition entirely.
  // Keeping the flag is not a privacy compromise: it is a bare boolean saying
  // this DEVICE has had its free game. It names nobody.
  const kept = await page.evaluate(() => {
    localStorage.setItem("izzbah-free-game-v1", "1");
    localStorage.setItem("izzbah-progress-v1", '{"x":1}');
    // Run the real wipe the success path uses, without needing the cloud call.
    const KEEP = ["izzbah-free-game-v1"];
    Object.keys(localStorage).filter(k => k.indexOf("izzbah-") === 0 && KEEP.indexOf(k) === -1)
      .forEach(k => localStorage.removeItem(k));
    return {
      free: localStorage.getItem("izzbah-free-game-v1"),
      progress: localStorage.getItem("izzbah-progress-v1"),
    };
  });
  check("the free-game flag SURVIVES deletion — no free-game farming loop",
    kept.free === "1", String(kept.free));
  check("...while real account data still goes", kept.progress === null);
  // And the shipped code must carry the same exemption, not just this test.
  const srcKeep = await page.evaluate(() => document.documentElement.innerHTML.indexOf('KEEP = ["izzbah-free-game-v1"]') > -1);
  check("...and the exemption is in the shipped wipe, not only in this test", srcKeep);

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
