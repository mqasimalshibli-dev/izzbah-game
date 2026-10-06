// Admin tool: «مكافآت فئات المجتمع» — scans every APPROVED community category
// and sends the 5-game reward to any author who never got one (approved
// before the reward existed, or a reward write that silently failed). Plan,
// then confirm, then apply — same shape as the restore-backup modal.
//
// The SAME modal also rosters every community contributor (approved AND
// pending, reward owed or not) with a direct-message box per row, reusing the
// existing player↔dev feedback channel (adminReplyFeedback) rather than any
// new backend.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8418;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  " + extra : ""}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];
const page = await browser.newPage({ viewport: { width: 1000, height: 950 } });
await page.route("**/firebasejs/**", route => route.abort());
page.on("pageerror", e => errs.push("JS: " + e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(1400);

const openAsAdmin = () => page.evaluate(() => {
  state.isAdmin = true; if (window.IZZBAH.applyAdmin) window.IZZBAH.applyAdmin(true);
  openAdminChoice();
});

// ---- the button exists, is admin-only, and opens the modal ----
await openAsAdmin();
const btn = await page.evaluate(() => {
  const b = document.getElementById("adminChoiceCommRewards");
  return { exists: !!b, hidden: b ? b.hidden : null };
});
check("the admin panel offers «مكافآت فئات المجتمع»", btn.exists && !btn.hidden);

await page.evaluate(() => {
  window.IZZBAH.planCommunityRewardBackfill = () => Promise.resolve({
    eligible: [
      { id: "cat-1", name: "تاريخ عمان", authorUid: "uid-1", authorName: "سالم" },
      { id: "cat-2", name: "جغرافيا", authorUid: "uid-2", authorName: "هند" },
    ],
    alreadyRewarded: 3,
    noAuthor: 1,
  });
  document.getElementById("adminChoiceCommRewards").click();
});
await page.waitForTimeout(400);

const plan = await page.evaluate(() => {
  const m = document.getElementById("commRewardsModal");
  const box = document.getElementById("commRewardsPreview").textContent;
  return {
    open: m.classList.contains("open"),
    showsEligible: /2/.test(box),
    showsAlready: /3/.test(box),
    showsNoAuthor: /1/.test(box),
    showsNames: /تاريخ عمان/.test(box) && /جغرافيا/.test(box),
    runEnabled: !document.getElementById("commRewardsRun").disabled,
  };
});
check("the modal opens and shows a plan", plan.open);
check("it counts how many are eligible", plan.showsEligible);
check("it counts how many were already rewarded", plan.showsAlready);
check("it counts categories with no known author", plan.showsNoAuthor);
check("it lists the eligible categories by name + author", plan.showsNames);
check("the run button is enabled when something is eligible", plan.runEnabled);

// ---- running it calls the backfill bridge with the plan's eligible list ----
const ran = await page.evaluate(() => new Promise(resolve => {
  window.IZZBAH.runCommunityRewardBackfill = (cats) => {
    resolve(cats.map(c => c.id));
    return Promise.resolve({ sent: 2, failed: [] });
  };
  document.getElementById("commRewardsRun").click();
}));
check("running it passes exactly the planned categories to the backfill bridge",
  JSON.stringify(ran) === JSON.stringify(["cat-1", "cat-2"]));
await page.waitForTimeout(300);
const result = await page.evaluate(() => document.getElementById("commRewardsPreview").textContent);
check("the result reports how many rewards were sent", /2/.test(result));

// ---- partial failure is reported, not swallowed ----
await page.evaluate(() => {
  window.IZZBAH.planCommunityRewardBackfill = () => Promise.resolve({
    eligible: [{ id: "cat-3", name: "رياضة", authorUid: "uid-3", authorName: "فهد" }],
    alreadyRewarded: 0, noAuthor: 0,
  });
  document.getElementById("adminChoiceCommRewards").click();
});
await page.waitForTimeout(300);
await page.evaluate(() => {
  window.IZZBAH.runCommunityRewardBackfill = () => Promise.resolve({ sent: 0, failed: ["رياضة"] });
  document.getElementById("commRewardsRun").click();
});
await page.waitForTimeout(300);
const failBox = await page.evaluate(() => document.getElementById("commRewardsPreview").textContent);
check("a failed send is reported by name, not silently dropped", /رياضة/.test(failBox));

// ---- the author roster: everyone who has EVER added a category ----
await page.evaluate(() => {
  window.IZZBAH.planCommunityRewardBackfill = () => Promise.resolve({ eligible: [], alreadyRewarded: 0, noAuthor: 0 });
  window.IZZBAH.listCommunityAuthors = () => Promise.resolve([
    { authorUid: "uid-1", authorName: "سالم", total: 3, approved: 2, pending: 1, rewarded: 1 }, // owed a reward
    { authorUid: "uid-2", authorName: "هند", total: 1, approved: 1, pending: 0, rewarded: 1 },  // fully rewarded
    { authorUid: "uid-3", authorName: "فهد", total: 2, approved: 0, pending: 2, rewarded: 0 },  // nothing approved yet
  ]);
  document.getElementById("adminChoiceCommRewards").click();
});
await page.waitForTimeout(400);
const roster = await page.evaluate(() => {
  const box = document.getElementById("commAuthorsBody");
  const text = box.textContent;
  return {
    rows: box.querySelectorAll(".custom-row").length,
    showsAllNames: /سالم/.test(text) && /هند/.test(text) && /فهد/.test(text),
    showsUid: /uid-1/.test(text),
    showsTotals: /3/.test(text),
    showsOwed: /بلا مكافأة/.test(text),
    showsFullyRewarded: /حصل على مكافأته/.test(text),
    showsNothingApprovedYet: text.includes("—"),
  };
});
check("the roster lists every contributor, not just those owed a reward", roster.rows === 3);
check("…by name, approved/pending counts and all", roster.showsAllNames && roster.showsTotals);
check("…with their uid shown", roster.showsUid);
check("someone still owed a reward is flagged", roster.showsOwed);
check("someone already rewarded is marked done, not re-flagged", roster.showsFullyRewarded);
check("someone with nothing approved yet shows a dash, not a false warning", roster.showsNothingApprovedYet);

// ---- messaging a specific author reuses adminReplyFeedback ----
const firstRow = () => page.evaluate(() => {
  const row = document.getElementById("commAuthorsBody").querySelectorAll(".custom-row")[0];
  return !!row;
});
await firstRow();
const composeOpened = await page.evaluate(() => {
  const row = document.getElementById("commAuthorsBody").querySelectorAll(".custom-row")[0];
  row.querySelector("button").click(); // «رسالة»
  const compose = row.nextElementSibling;
  return !compose.hidden;
});
check("pressing «رسالة» reveals a compose box for that author", composeOpened);

const sent = await page.evaluate(() => new Promise(resolve => {
  window.IZZBAH.adminReplyFeedback = (uid, text) => { resolve({ uid, text }); return Promise.resolve(); };
  const row = document.getElementById("commAuthorsBody").querySelectorAll(".custom-row")[0];
  const compose = row.nextElementSibling;
  compose.querySelector("textarea").value = "شكراً على فئتك الرائعة!";
  compose.querySelector("button").click(); // «إرسال»
}));
check("sending calls adminReplyFeedback with THAT author's uid", sent.uid === "uid-1");
check("…and the typed text", sent.text === "شكراً على فئتك الرائعة!");
await page.waitForTimeout(250);
const afterSend = await page.evaluate(() => {
  const row = document.getElementById("commAuthorsBody").querySelectorAll(".custom-row")[0];
  const compose = row.nextElementSibling;
  return { cleared: compose.querySelector("textarea").value === "", hidden: compose.hidden };
});
check("after sending, the box clears and collapses", afterSend.cleared && afterSend.hidden);

// ---- an empty message never reaches the bridge ----
const emptyBlocked = await page.evaluate(() => new Promise(resolve => {
  let called = false;
  window.IZZBAH.adminReplyFeedback = () => { called = true; return Promise.resolve(); };
  const row = document.getElementById("commAuthorsBody").querySelectorAll(".custom-row")[1];
  row.querySelector("button").click();
  const compose = row.nextElementSibling;
  compose.querySelector("button").click(); // «إرسال» with an empty textarea
  setTimeout(() => resolve(called), 200);
}));
check("an empty message is refused locally, never sent", emptyBlocked === false);

// ---- messaging with no bridge at all fails cleanly, not silently ----
const noMsgBridge = await page.evaluate(() => new Promise(resolve => {
  delete window.IZZBAH.adminReplyFeedback;
  const row = document.getElementById("commAuthorsBody").querySelectorAll(".custom-row")[2];
  const compose = row.nextElementSibling;
  compose.querySelector("textarea").value = "مرحباً";
  compose.querySelector("button").click();
  setTimeout(() => resolve(document.getElementById("appToast").textContent), 200);
}));
check("messaging with no bridge shows a clear failure toast", /غير متاح/.test(noMsgBridge));

// ---- an empty roster says so, instead of a blank panel ----
await page.evaluate(() => {
  window.IZZBAH.listCommunityAuthors = () => Promise.resolve([]);
  document.getElementById("adminChoiceCommRewards").click();
});
await page.waitForTimeout(300);
check("an empty roster shows a friendly message",
  /لا توجد فئة/.test(await page.evaluate(() => document.getElementById("commAuthorsBody").textContent)));

// ---- nothing eligible disables the run button and explains why ----
await page.evaluate(() => {
  window.IZZBAH.planCommunityRewardBackfill = () => Promise.resolve({ eligible: [], alreadyRewarded: 9, noAuthor: 0 });
  document.getElementById("adminChoiceCommRewards").click();
});
await page.waitForTimeout(300);
const empty = await page.evaluate(() => ({
  disabled: document.getElementById("commRewardsRun").disabled,
  text: document.getElementById("commRewardsPreview").textContent,
}));
check("with nothing eligible, the run button stays disabled", empty.disabled);
check("…and it says so instead of an empty panel", /لا توجد فئة ناقصة/.test(empty.text));

// ---- the bridge missing entirely fails cleanly ----
await page.evaluate(() => { delete window.IZZBAH.planCommunityRewardBackfill; document.getElementById("adminChoiceCommRewards").click(); });
await page.waitForTimeout(300);
const noBridge = await page.evaluate(() => document.getElementById("commRewardsPreview").textContent);
check("with no bridge at all, it fails cleanly instead of throwing", /غير متاح/.test(noBridge));

// close + an editor never sees this button
await page.evaluate(() => document.getElementById("commRewardsCancel").click());
const editorSees = await page.evaluate(() => {
  state.isAdmin = false; state.isEditor = true;
  if (window.IZZBAH.applyEditor) window.IZZBAH.applyEditor(true);
  openAdminChoice();
  const b = document.getElementById("adminChoiceCommRewards");
  return b ? b.hidden : true;
});
check("an editor never sees «مكافآت فئات المجتمع»", editorSees);

check("no uncaught JS errors", errs.length === 0);
if (errs.length) errs.slice(0, 4).forEach(e => console.log("   " + e));
await browser.close(); server.kill();
process.exit(checks.every(Boolean) ? 0 : 1);
