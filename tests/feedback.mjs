// Private two-way player↔developer feedback:
//  • a player opens «اقتراحاتك وملاحظاتك», reads the thread, and sends a message
//  • signed-out players are asked to sign in
//  • a dev reply raises an unread badge that clears on open
//  • the admin sees every thread and can open one and reply
// The Firebase bridge is stubbed (tests run offline), so we drive the UI and
// assert it calls the right bridge functions with the right data.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8375;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1000, height: 950 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

const open = id => page.evaluate(i => document.getElementById(i).classList.contains("open"), id);

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // Install a fake bridge that records calls and returns a scripted thread.
  await page.evaluate(() => {
    window.__fb = { sent: [], adminReplies: [], thread: [
      { id: "m1", from: "user", text: "اقترح إضافة فئة رياضة", name: "سالم", createdAt: 1000 },
      { id: "m2", from: "admin", text: "فكرة رائعة، أضفناها!", name: "المطوّر", createdAt: 2000 },
    ] };
    window.IZZBAH.loadFeedback = () => Promise.resolve(window.__fb.thread.slice());
    window.IZZBAH.sendFeedback = (t) => { window.__fb.sent.push(t); window.__fb.thread.push({ id: "u" + Date.now(), from: "user", text: t, name: "سالم", createdAt: Date.now() }); return Promise.resolve(); };
    window.IZZBAH.adminListFeedback = () => Promise.resolve([
      { uid: "u_salem", name: "سالم", lastText: "شكراً على الرد", lastFrom: "user", updatedAt: 3000, count: 3 },
      { uid: "u_hind", name: "هند", lastText: "متى تنزل فئة جديدة؟", lastFrom: "user", updatedAt: 2500, count: 1 },
    ]);
    window.IZZBAH.adminLoadFeedback = (uid) => Promise.resolve([{ id: "a1", from: "user", text: "رسالة من " + uid, name: "سالم", createdAt: 1500 }]);
    window.IZZBAH.adminReplyFeedback = (uid, t) => { window.__fb.adminReplies.push({ uid, t }); return Promise.resolve(); };
    window.__fb.deleted = [];
    window.IZZBAH.deleteFeedback = (id) => { window.__fb.deleted.push(id); window.__fb.thread = window.__fb.thread.filter(m => m.id !== id); return Promise.resolve(); };
    window.IZZBAH.adminDeleteFeedback = (uid, id) => { window.__fb.deleted.push({ uid, id }); return Promise.resolve(); };
  });

  // ---- 1) signed-OUT player is prompted to sign in (modal stays closed) ----
  await page.evaluate(() => { state.signedIn = false; openFeedback(); });
  await page.waitForTimeout(150);
  check("a signed-out player is asked to sign in (feedback stays closed)", !(await open("feedbackModal")));

  // ---- 2) signed-in: the thread opens and shows both sides ----
  await page.evaluate(() => { state.signedIn = true; openFeedback(); });
  await page.waitForTimeout(300);
  const thread = await page.evaluate(() => ({
    open: document.getElementById("feedbackModal").classList.contains("open"),
    user: [...document.querySelectorAll("#feedbackThread .fb-user")].map(n => n.textContent),
    dev: [...document.querySelectorAll("#feedbackThread .fb-dev")].map(n => n.textContent),
    hasComposer: !!document.getElementById("feedbackInput") && !!document.getElementById("feedbackSend"),
    warnVisible: getComputedStyle(document.getElementById("feedbackWarn")).display !== "none" && /محترم/.test(document.getElementById("feedbackWarn").textContent),
  }));
  check("the feedback thread opens for a signed-in player", thread.open);
  check("it shows the player's own message and the dev reply as distinct bubbles",
    thread.user.some(t => /رياضة/.test(t)) && thread.dev.some(t => /أضفناها/.test(t)) && thread.hasComposer);
  check("an always-visible respectful-conduct reminder sits above the composer", thread.warnVisible);

  // ---- 3) first send shows a respect reminder that must be agreed to ----
  const gate = await page.evaluate(async () => {
    try { localStorage.removeItem("izzbah-feedback-guidelines-v1"); } catch (e) {}
    document.getElementById("feedbackInput").value = "أحب اللعبة كثيراً!";
    sendFeedbackMsg();
    await new Promise(r => setTimeout(r, 120));
    const shown = document.getElementById("fbGuidelinesModal").classList.contains("open");
    const privacy = /خاصة/.test(document.getElementById("fbGuidelinesModal").textContent) && /لا يراها/.test(document.getElementById("fbGuidelinesModal").textContent);
    const sentYet = window.__fb.sent.length;
    document.getElementById("fbGuidelinesAgree").click(); // agree & send
    await new Promise(r => setTimeout(r, 220));
    return {
      shown, privacy, sentYet, sent: window.__fb.sent.slice(),
      acked: localStorage.getItem("izzbah-feedback-guidelines-v1"),
      bubbles: document.querySelectorAll("#feedbackThread .fb-user").length,
      input: document.getElementById("feedbackInput").value,
      modalClosed: !document.getElementById("fbGuidelinesModal").classList.contains("open"),
    };
  });
  check("the FIRST send shows a respectful-conduct reminder and holds the message", gate.shown && gate.sentYet === 0);
  check("the reminder states the chat is private (only the player + devs see it)", gate.privacy);
  check("agreeing sends the message, records the acknowledgment, and appends it",
    gate.sent.length === 1 && gate.sent[0] === "أحب اللعبة كثيراً!" && gate.acked === "1" && gate.bubbles >= 2 && gate.input === "" && gate.modalClosed);

  // ---- 3a) after agreeing once, later sends skip the reminder ----
  const second = await page.evaluate(async () => {
    document.getElementById("feedbackInput").value = "رسالة ثانية";
    sendFeedbackMsg();
    await new Promise(r => setTimeout(r, 180));
    return { modal: document.getElementById("fbGuidelinesModal").classList.contains("open"), sent: window.__fb.sent.length };
  });
  check("after agreeing once, later sends skip the reminder", !second.modal && second.sent === 2);

  // ---- 3b) the player can DELETE their own message, but not the dev's ----
  const del = await page.evaluate(async () => {
    // reopen a fresh thread with a known user message + dev reply
    window.__fb.thread = [
      { id: "keep_dev", from: "admin", text: "رد المطوّر", name: "المطوّر", createdAt: 2000 },
      { id: "mine", from: "user", text: "رسالتي القابلة للحذف", name: "سالم", createdAt: 3000 },
    ];
    window.IZZBAH.loadFeedback = () => Promise.resolve(window.__fb.thread.slice());
    state.signedIn = true; state.feedbackAdminUid = null; openFeedback();
    await new Promise(r => setTimeout(r, 200));
    const userBubbles = [...document.querySelectorAll("#feedbackThread .fb-user")];
    const devBubbles = [...document.querySelectorAll("#feedbackThread .fb-dev")];
    const userHasDelete = userBubbles.every(b => !!b.querySelector(".fb-del"));
    const devHasDelete = devBubbles.some(b => !!b.querySelector(".fb-del"));
    // click delete on the user's own message
    userBubbles[0].querySelector(".fb-del").click();
    await new Promise(r => setTimeout(r, 200));
    return {
      userHasDelete, devHasDelete,
      deleted: window.__fb.deleted.slice(),
      remaining: document.querySelectorAll("#feedbackThread .fb-msg").length,
      stillHasDev: [...document.querySelectorAll("#feedbackThread .fb-dev")].length === 1,
    };
  });
  check("the player sees a delete control on their OWN messages only", del.userHasDelete && !del.devHasDelete);
  check("deleting removes the player's message via the bridge", del.deleted.length === 1 && del.deleted[0] === "mine" && del.stillHasDev);

  // ---- 4) a new dev reply raises an unread badge that clears on open ----
  const badge = await page.evaluate(async () => {
    document.getElementById("feedbackModal").classList.remove("open");
    try { localStorage.setItem("izzbah-feedback-read-v1", "1000"); } catch (e) {}
    window.IZZBAH.applyFeedback([{ from: "admin", text: "رد جديد", createdAt: 9999 }]);
    const b = document.getElementById("settingsFeedbackBadge");
    const before = !b.hidden;
    // opening the thread marks it read → badge clears
    window.IZZBAH.loadFeedback = () => Promise.resolve([{ from: "admin", text: "رد جديد", createdAt: 9999 }]);
    state.signedIn = true; openFeedback();
    await new Promise(r => setTimeout(r, 250));
    return { before, after: !document.getElementById("settingsFeedbackBadge").hidden };
  });
  check("a new dev reply shows an unread badge on the feedback row", badge.before);
  check("opening the thread clears the unread badge", !badge.after);

  // ---- 5) admin sees all threads and can open one + reply ----
  await page.evaluate(() => { document.getElementById("feedbackModal").classList.remove("open"); openFeedbackAdmin(); });
  await page.waitForTimeout(250);
  const adminList = await page.evaluate(() => ({
    open: document.getElementById("feedbackAdminModal").classList.contains("open"),
    rows: [...document.querySelectorAll("#feedbackAdminList .fb-thread-row")].map(r => r.textContent),
  }));
  check("the admin threads list opens with every player's thread", adminList.open && adminList.rows.length === 2 && adminList.rows.some(r => /سالم/.test(r)) && adminList.rows.some(r => /هند/.test(r)));

  const reply = await page.evaluate(async () => {
    document.querySelector("#feedbackAdminList .fb-thread-row").click(); // open the first thread
    await new Promise(r => setTimeout(r, 250));
    const title = document.getElementById("feedbackTitle").textContent;
    document.getElementById("feedbackInput").value = "شكراً لاقتراحك، سننظر فيه";
    sendFeedbackMsg();
    await new Promise(r => setTimeout(r, 200));
    return { title, replies: window.__fb.adminReplies };
  });
  check("opening a thread shows the player's name in the title", /سالم/.test(reply.title));
  check("the admin reply posts through adminReplyFeedback with the player's uid",
    reply.replies.length === 1 && reply.replies[0].uid === "u_salem" && /سننظر فيه/.test(reply.replies[0].t));

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
