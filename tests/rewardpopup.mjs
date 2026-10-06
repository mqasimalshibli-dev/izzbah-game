// The launch popup (tests/annpopup.mjs) used to fire for PUBLIC announcements
// only. A personal reward message (e.g. the 5-game code sent when a community
// category is approved) landed silently in state.inbox with nothing beyond
// the gear's unread dot — easy to miss for a player who submitted weeks ago
// and forgot. maybePopAnnouncement now merges state.inbox in too, so a fresh
// reward pops the same way a fresh announcement does, on first sign-in.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8417;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  " + extra : ""}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];
const page = await browser.newPage({ viewport: { width: 1000, height: 950 } });
await page.route("**/firebasejs/**", route => route.abort());
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ---- 1) a fresh reward, with NO announcements at all, still pops ----
  const rewardOnly = await page.evaluate(() => {
    try { localStorage.removeItem("izzbah-ann-popped-v1"); localStorage.removeItem("izzbah-inbox-redeemed-v1"); } catch (e) {}
    state.signedIn = true;
    state.announcements = [];
    state.inbox = [{ id: "catreward-1", type: "reward", title: "مبروك! فئتكم أصبحت رسمية 🎉",
      body: "هديتكم: كود ٥ ألعاب 🎁", icon: "🎁", code: "ABCD-1234", games: 5, createdAt: 5000 }];
    maybePopAnnouncement();
    return true;
  });
  await page.waitForTimeout(900);
  const s1 = await page.evaluate(() => ({
    open: document.getElementById("annPopModal").classList.contains("open"),
    body: document.getElementById("annPopBody").textContent,
    code: document.getElementById("annPopBody").querySelector(".reward-code")?.textContent || "",
    hasRedeem: !!document.getElementById("annPopBody").querySelector(".reward-redeem"),
    hasCopy: !!document.getElementById("annPopBody").querySelector(".reward-copy"),
  }));
  check("a reward-only inbox (no announcements) still pops", rewardOnly && s1.open);
  check("it renders the congratulation text", /أصبحت رسمية/.test(s1.body));
  check("it shows the code itself", s1.code === "ABCD-1234");
  check("it offers activate + copy, same as the announcement center", s1.hasRedeem && s1.hasCopy);

  // ---- 2) activating from the POPUP calls the same redeem bridge ----
  const redeemed = await page.evaluate(() => new Promise(resolve => {
    window.IZZBAH = window.IZZBAH || {};
    window.IZZBAH.redeemCode = (code) => { resolve(code); return Promise.resolve(); };
    document.getElementById("annPopBody").querySelector(".reward-redeem").click();
  }));
  check("activating the code from the popup calls redeemCode with it", redeemed === "ABCD-1234");

  // ---- 3) reload: a fresh REWARD that is OLDER than a fresh ANNOUNCEMENT —
  //         the announcement is the hero card, the reward is folded into "+N" ----
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    try { localStorage.removeItem("izzbah-ann-popped-v1"); } catch (e) {}
    state.signedIn = true;
    state.announcements = [{ id: "a1", title: "ميزة جديدة", body: "أضفنا فئات جديدة!", createdAt: 9000, icon: "🎉" }];
    state.inbox = [{ id: "catreward-2", type: "reward", title: "مبروك!", body: "…", icon: "🎁", code: "WXYZ-9999", games: 5, createdAt: 4000 }];
    maybePopAnnouncement();
  });
  await page.waitForTimeout(900);
  const s2 = await page.evaluate(() => ({
    body: document.getElementById("annPopBody").textContent,
    more: document.getElementById("annPopMore").hidden ? "" : document.getElementById("annPopMore").textContent,
    popped: Number(localStorage.getItem("izzbah-ann-popped-v1")) || 0,
  }));
  check("the newer announcement wins the hero slot over an older reward", /ميزة جديدة/.test(s2.body));
  check("the older reward is folded into the «+N أخرى» count, not dropped", /في مركز الإعلانات/.test(s2.more));
  check("popping records the LATER of the two timestamps (announcement here)", s2.popped >= 9000);

  // ---- 4) reload: a fresh REWARD newer than a fresh announcement wins the hero slot ----
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    try { localStorage.removeItem("izzbah-ann-popped-v1"); } catch (e) {}
    state.signedIn = true;
    state.announcements = [{ id: "a1", title: "ميزة قديمة نسبياً", body: "…", createdAt: 3000, icon: "📢" }];
    state.inbox = [{ id: "catreward-3", type: "reward", title: "مبروك!", body: "فئتكم اعتُمدت", icon: "🎁", code: "NEWR-0001", games: 5, createdAt: 8000 }];
    maybePopAnnouncement();
  });
  await page.waitForTimeout(900);
  const s3 = await page.evaluate(() => ({
    code: document.getElementById("annPopBody").querySelector(".reward-code")?.textContent || "",
    popped: Number(localStorage.getItem("izzbah-ann-popped-v1")) || 0,
  }));
  check("a newer reward wins the hero slot over an older announcement", s3.code === "NEWR-0001");
  check("popping still records the later timestamp (the reward here)", s3.popped >= 8000);

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
