// Device diagnostics stapled to a player's feedback message.
//
// A player writes «اللعبة ما تشتغل» and that sentence is ALL the developer
// gets — no build, no idea whether the catalogue loaded, no device. This
// attaches the few facts that make a report actionable.
//
// Three properties matter and each is a way this could go wrong:
//   • it must NOT be a fingerprint — platform family, never a raw user-agent;
//   • it must NEVER break the send, including against un-published rules;
//   • it renders to the ADMIN only. A player seeing build numbers stapled to
//     their own message reads as the app malfunctioning.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8418;
const checks = [];
const check = (n, ok, note) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${note ? `  — ${note}` : ""}`); };

// ---- rules ----------------------------------------------------------------
const rules = readFileSync(join(ROOT, "firestore.rules"), "utf8");
const fb = rules.slice(rules.indexOf("match /feedback/{uid}/messages"), rules.indexOf("Collection-group query support"));
check("`diag` is allowed on a feedback message", /'diag'/.test(fb));
check("...as an OPTIONAL field", /!\('diag' in request\.resource\.data\)/.test(fb));
check("...type- and size-checked", /diag is string[\s\S]*diag\.size\(\) <= 400/.test(fb));
check("...and the key set stays closed", /hasOnly\(\['from', 'text', 'name', 'createdAt', 'diag'\]\)/.test(fb));

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 430, height: 880 } });
await page.route("**/firebasejs/**", r => r.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  const d = await page.evaluate(() => {
    const s = buildDiagnostics();
    return { s, len: s.length };
  });
  check("a diagnostic is produced", !!d.s, d.s);
  check("it names the build", /b2026-/.test(d.s));
  check("it reports the connection", /\bon\b|\boff\b/.test(d.s));
  check("it reports how many categories arrived", /cat:\d/.test(d.s), d.s);
  check("it reports the screen shape", /\d+x\d+/.test(d.s));
  check("it fits the 400-char rules cap", d.len <= 400, `${d.len} chars`);

  // NOT a fingerprint.
  const priv = await page.evaluate(() => {
    const s = buildDiagnostics();
    const ua = String(navigator.userAgent || "");
    return {
      s,
      leaksUA: s.includes(ua) || /Mozilla|AppleWebKit|Chrome\/\d/.test(s),
      leaksEmail: /@/.test(s),
      // Platform FAMILY only.
      family: /(ios|android|mac|win|other)/.test(s),
    };
  });
  check("IT IS NOT A FINGERPRINT — no raw user-agent", !priv.leaksUA, priv.s);
  check("...and carries no email", !priv.leaksEmail);
  check("...only a platform family", priv.family);

  // It must never break the send, whatever the page state.
  const robust = await page.evaluate(() => {
    const out = {};
    const savedState = state.publishedCategories;
    try {
      state.publishedCategories = null;           // mid-boot
      out.nullCats = typeof buildDiagnostics() === "string";
      state.publishedCategories = [{ id: "x", __idx: true }];
      out.idxFlagged = /idx/.test(buildDiagnostics());
    } catch (e) { out.threw = String(e && e.message); }
    state.publishedCategories = savedState;
    return out;
  });
  check("IT NEVER THROWS, even mid-boot with no catalogue", robust.nullCats === true && !robust.threw, robust.threw || "");
  check("it distinguishes the cold-boot index path", robust.idxFlagged === true);

  // The send must survive rules that do not know `diag` yet.
  const src = readFileSync(join(ROOT, "index.html"), "utf8");
  // ⚠️ Slice FORWARD from the assignment — `window.IZZBAH.deleteFeedback`
  // appears earlier as a call site, and indexOf would give an empty slice that
  // silently passes nothing.
  const at = src.indexOf("window.IZZBAH.sendFeedback = function");
  const sender = src.slice(at, src.indexOf("window.IZZBAH.deleteFeedback", at));
  check("the field is omitted when it cannot be built", /if \(d\) msg\.diag = d;/.test(sender));
  check("A PERMISSION ERROR RETRIES WITHOUT IT — a bug report is never lost to a diagnostic",
    /permission-denied/.test(sender) && /delete msg\.diag/.test(sender));

  // Admin-only rendering.
  const view = await page.evaluate(async () => {
    const sleep = ms => new Promise(z => setTimeout(z, ms));
    const msgs = [{ id: "m1", from: "user", text: "اللعبة ما تشتغل", name: "لاعب",
                    diag: "b2026-08-15.322 · on · cat:0 · web", createdAt: Date.now() }];
    // renderFeedbackThread is what draws the bubbles; applyFeedback only
    // updates the unread badge.
    state.feedbackAdminUid = null;
    renderFeedbackThread(msgs);
    await sleep(120);
    const asPlayer = document.querySelectorAll("#feedbackThread .fb-diag").length;
    // As the ADMIN reading that player's thread.
    state.feedbackAdminUid = "someplayer";
    renderFeedbackThread(msgs);
    await sleep(120);
    const asAdmin = document.querySelectorAll("#feedbackThread .fb-diag").length;
    const text = (document.querySelector("#feedbackThread .fb-diag") || {}).textContent || "";
    state.feedbackAdminUid = null;
    return { asPlayer, asAdmin, text };
  });
  check("THE PLAYER NEVER SEES IT in their own thread", view.asPlayer === 0, String(view.asPlayer));
  check("...but the admin does", view.asAdmin === 1, String(view.asAdmin));
  check("...showing the device state", /b2026-/.test(view.text), view.text);

  check("no page errors", errs.length === 0, errs[0] || "");
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(`\n${failed ? `${failed} FAILED` : `all ${checks.length} checks passed`}`);
process.exit(failed ? 1 : 0);
