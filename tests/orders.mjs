// E2E for the game-pack purchase flow: the packs in the plans sheet (reached
// from settings) are PRESSABLE — tapping one places an order; the admin sees
// the order in subscription management and fulfils it with one button that
// mints the pack's code and opens a prefilled confirmation email to the buyer
// (payment line + the activation code).
//
// Runs OFFLINE (Firebase SDK aborted); cloud bridges are stubbed.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8337;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

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
  await page.waitForTimeout(1500);

  // ---- 1) the settings sheet leads to the plans, and packs are pressable ----
  await page.evaluate(() => { document.getElementById("userSettingsBtn").click(); });
  await page.waitForTimeout(200);
  await page.evaluate(() => { document.getElementById("settingsBuy").click(); });
  await page.waitForTimeout(250);
  const plansInfo = await page.evaluate(() => ({
    open: document.getElementById("plansModal").classList.contains("open"),
    count: document.querySelectorAll("#plansGrid .plan-card").length,
    pressable: [...document.querySelectorAll("#plansGrid .plan-card")].every(c => c.tagName === "BUTTON"),
    cta: document.getElementById("plansGrid").textContent.includes("اطلب هذه الباقة"),
  }));
  check("settings «شراء ألعاب» opens the plans sheet", plansInfo.open);
  check("all pack cards are pressable buttons with an order CTA", plansInfo.count >= 3 && plansInfo.pressable && plansInfo.cta);

  // ---- 2) signed OUT: tapping a pack asks to sign in, places nothing ----
  const signedOut = await page.evaluate(async () => {
    const calls = [];
    window.IZZBAH.placeOrder = (o) => { calls.push(o); return Promise.resolve(true); };
    window.IZZBAH.applyAuth(false, "");
    document.querySelectorAll("#plansGrid .plan-card")[0].click();
    await new Promise(r => setTimeout(r, 150));
    return { calls: calls.length };
  });
  check("signed-out tap places no order (asks to sign in)", signedOut.calls === 0);

  // ---- 3) signed IN: tapping the 5-games pack places the right order ----
  const order = await page.evaluate(async () => {
    const calls = [];
    window.IZZBAH.placeOrder = (o) => { calls.push(o); return Promise.resolve(true); };
    window.IZZBAH.applyAuth(true, "buyer1");
    document.querySelectorAll("#plansGrid .plan-card")[0].click();
    await new Promise(r => setTimeout(r, 200));
    return { calls, closed: !document.getElementById("plansModal").classList.contains("open") };
  });
  check("tapping the 5-games pack places an order with the pack details",
    order.calls.length === 1 && order.calls[0].games === 5 && order.calls[0].premium === false
    && /٥|5/.test(order.calls[0].pack));
  check("a placed order closes the plans sheet (confirmation shown)", order.closed);

  // the unlimited pack orders premium
  const unl = await page.evaluate(async () => {
    const calls = [];
    window.IZZBAH.placeOrder = (o) => { calls.push(o); return Promise.resolve(true); };
    openPlans();
    const cards = [...document.querySelectorAll("#plansGrid .plan-card")];
    cards.find(c => c.textContent.includes("اشتراك مفتوح")).click();
    await new Promise(r => setTimeout(r, 200));
    return calls[0];
  });
  check("the unlimited pack orders a premium subscription", unl && unl.premium === true && unl.games === 0);

  // ---- 4) admin: orders appear in subscription management ----
  await page.evaluate(() => { window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true); });
  const adminView = await page.evaluate(async () => {
    window.IZZBAH.listCodes = () => Promise.resolve([]);
    window.IZZBAH.listUsage = () => Promise.resolve({});
    window.IZZBAH.listOrders = () => Promise.resolve([
      { uid: "buyer1", email: "buyer@example.com", pack: "باقة ٥ ألعاب", games: 5, premium: false, createdAt: 1750000000000 },
    ]);
    openPremiumModal();
    await new Promise(r => setTimeout(r, 250));
    const box = document.getElementById("premOrders");
    return {
      text: box.textContent,
      hasFulfil: !!box.querySelector(".prem-fulfil"),
      hasDelete: !!box.querySelector(".prem-revoke"),
    };
  });
  check("the admin sees the order (buyer email + pack) in the subscription panel",
    /buyer@example\.com/.test(adminView.text) && /باقة ٥ ألعاب/.test(adminView.text));
  check("the order row offers fulfil (code+email) and delete options", adminView.hasFulfil && adminView.hasDelete);

  // ---- 5) fulfil: mints the pack's code + opens Gmail compose FROM izzbah ----
  const fulfil = await page.evaluate(async () => {
    const created = [], deleted = [];
    window.__gmail = "";
    window.open = (url) => { window.__gmail = url; return { closed: false }; }; // capture the compose window
    window.IZZBAH.createCode = (opts) => { created.push(opts); return Promise.resolve("PACK-CODE"); };
    window.IZZBAH.deleteOrder = (uid) => { deleted.push(uid); return Promise.resolve(true); };
    window.IZZBAH.listOrders = () => Promise.resolve([]); // queue empties after fulfil
    document.querySelector("#premOrders .prem-fulfil").click();
    await new Promise(r => setTimeout(r, 300));
    return {
      created, deleted,
      gmail: window.__gmail,
      status: document.getElementById("premStatus").textContent,
      ordersNow: document.getElementById("premOrders").textContent,
    };
  });
  check("fulfil mints a code matching the ordered pack (5 games, not premium)",
    fulfil.created.length === 1 && fulfil.created[0].gamesAllowed === 5 && fulfil.created[0].premium === false);
  const mail = decodeURIComponent(fulfil.gmail || "");
  check("the email opens in Gmail compose pinned to the izzbah account",
    mail.startsWith("https://mail.google.com/mail/") && mail.includes("authuser=izzbahgame@gmail.com"));
  check("the confirmation email goes TO the buyer", mail.includes("to=buyer@example.com"));
  check("the email is organized: order summary, payment section, code, steps",
    /ملخص الطلب/.test(mail) && /طريقة الدفع/.test(mail) && /كود التفعيل/.test(mail)
    && /PACK-CODE/.test(mail) && /خطوات التفعيل/.test(mail)
    && /الباقة: باقة ٥ ألعاب/.test(mail) && /izzbah-game\//.test(mail));
  check("the fulfilled order is removed from the queue",
    fulfil.deleted.length === 1 && fulfil.deleted[0] === "buyer1" && /لا توجد طلبات/.test(fulfil.ordersNow));
  check("the admin sees a clear next step (complete price/payment, send)",
    /من حساب izzbah/.test(fulfil.status) && /أكمل السعر/.test(fulfil.status));

  // ---- 6) popup blocked -> falls back to a plain mail draft ----
  const fallback = await page.evaluate(async () => {
    window.__mailto = "";
    window.open = () => null; // popup blocked
    document.addEventListener("click", e => {
      const a = e.target.closest && e.target.closest('a[href^="mailto:"]');
      if (a) { window.__mailto = a.getAttribute("href"); e.preventDefault(); }
    }, true);
    window.IZZBAH.createCode = () => Promise.resolve("FB-CODE");
    window.IZZBAH.deleteOrder = () => Promise.resolve(true);
    window.IZZBAH.listOrders = () => Promise.resolve([]);
    fulfilOrderFromAdmin({ uid: "buyer2", email: "fb@example.com", pack: "باقة ١٠ ألعاب", games: 10, premium: false });
    await new Promise(r => setTimeout(r, 250));
    return decodeURIComponent(window.__mailto || "");
  });
  check("a blocked popup falls back to a mail draft with the same content",
    fallback.startsWith("mailto:fb@example.com") && /FB-CODE/.test(fallback) && /ملخص الطلب/.test(fallback));

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
