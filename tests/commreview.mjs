// The admin's community-category REVIEW modal: «عرض الأسئلة» in the pending
// queue — the actual questions, who submitted them, and when.
//
// mapCommunityDoc/normalizeCommunityCategory carry createdAt/updatedAt into
// state as millis (they used to be dropped entirely — the timestamp existed
// in Firestore but was invisible to the running app). This is pure client
// rendering of already-loaded state; no Firebase bridge is attached, same as
// commflows.mjs, because an admin reviewing offline must not see a crash.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8416;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  " + extra : ""}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];
const page = await browser.newPage({ viewport: { width: 1000, height: 950 } });
await page.route("**/firebasejs/**", r => r.abort());
page.on("pageerror", e => errs.push("JS: " + e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
page.on("dialog", d => d.accept().catch(() => {}));
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(1400);

const CREATED_MS = Date.UTC(2026, 8, 20, 14, 5); // 2026-09-20 14:05 UTC

const seed = async () => page.evaluate((createdMs) => {
  state.isAdmin = true; if (window.IZZBAH.applyAdmin) window.IZZBAH.applyAdmin(true);
  state.editorTarget = "community";
  window.IZZBAH.applyPendingCommunity([
    { id: "pend-1", name: "فئة معلّقة", authorName: "سالم", authorUid: "uid-abc123",
      approved: false, createdAt: createdMs, updatedAt: createdMs,
      questions: [
        { points: 100, q: "س١", a: "ج١", distractors: ["خطأ١", "خطأ٢"] },
        { points: 200, q: "س٢", a: "ج٢" },
      ] },
  ]);
  renderCustomManager(); showScreen("customManager");
}, CREATED_MS);

await seed();
await page.waitForTimeout(400);

// ---- the row itself: button present, short date shown ----
const row = await page.evaluate(() => {
  const btns = [...document.querySelectorAll("#customManager button")].map(b => b.textContent.trim());
  return { hasDetailBtn: btns.includes("عرض الأسئلة"),
           rowText: document.getElementById("customManager").textContent };
});
check("the pending row offers «عرض الأسئلة»", row.hasDetailBtn);
check("the row itself already shows a submission date", /2026-09-20/.test(row.rowText));

// ---- open the modal ----
await page.evaluate(() => {
  const b = [...document.querySelectorAll("#customManager button")].find(x => x.textContent.trim() === "عرض الأسئلة");
  b.click();
});
await page.waitForTimeout(300);

const modal = await page.evaluate(() => {
  const m = document.getElementById("commReviewModal");
  const meta = document.getElementById("commReviewMeta").textContent;
  const rows = document.getElementById("commReviewRows").textContent;
  const uid = document.getElementById("commReviewUid");
  return {
    open: m.classList.contains("open"),
    ariaHidden: m.getAttribute("aria-hidden"),
    showsAuthor: /سالم/.test(meta),
    showsUid: !!uid && /uid-abc123/.test(uid.textContent),
    showsSubmitted: /2026-09-20 14:05/.test(meta),
    noEditedLine: !/آخر تعديل/.test(meta), // createdAt === updatedAt here
    showsCount: /2/.test(meta) || /٢/.test(meta),
    showsQ1: /س١/.test(rows), showsA1: /ج١/.test(rows),
    showsQ2: /س٢/.test(rows),
    showsDistractors: /خطأ١/.test(rows) && /خطأ٢/.test(rows),
    approveShown: !document.getElementById("commReviewApprove").hidden,
    rejectShown: !document.getElementById("commReviewReject").hidden,
  };
});
check("the modal opens", modal.open && modal.ariaHidden === "false");
check("it shows who submitted it", modal.showsAuthor);
check("…and their uid, copyable", modal.showsUid);
check("it shows WHEN it was submitted, to the minute", modal.showsSubmitted);
check("no «آخر تعديل» line when nothing was edited after submission", modal.noEditedLine);
check("it shows the question count", modal.showsCount);
check("both questions render — text and answer", modal.showsQ1 && modal.showsA1 && modal.showsQ2);
check("curated wrong answers show up under the answer", modal.showsDistractors);
check("a PENDING category offers موافقة/رفض from the modal", modal.approveShown && modal.rejectShown);

// ---- uid copy-to-clipboard doesn't throw even without clipboard permission ----
{
  const before = errs.length;
  await page.evaluate(() => document.getElementById("commReviewUid").click());
  await page.waitForTimeout(150);
  check("clicking the uid does not throw", errs.length === before);
}

// ---- approve with NO bridge attached: fails cleanly, same contract as the queue row ----
{
  const before = errs.length;
  await page.evaluate(() => {
    delete window.IZZBAH.communityApprove;
    document.getElementById("commReviewApprove").click();
  });
  await page.waitForTimeout(300);
  const toast = await page.evaluate(() => {
    const t = document.getElementById("appToast");
    return t && t.classList.contains("show") ? (t.textContent || "").trim().slice(0, 40) : "";
  });
  check("«موافقة» inside the modal with no bridge fails cleanly, with a message",
    errs.length === before && !!toast, `toast="${toast}"`);
}

// ---- close ----
await page.evaluate(() => document.getElementById("commReviewClose").click());
await page.waitForTimeout(150);
check("closing the modal works", await page.evaluate(() =>
  !document.getElementById("commReviewModal").classList.contains("open")));

// ---- an APPROVED category (e.g. opened from elsewhere) hides approve/reject ----
const approvedCheck = await page.evaluate(() => {
  openCommunityReview({ id: "appr-1", name: "فئة معتمدة", authorName: "هند", authorUid: "uid-xyz",
    approved: true, createdAt: 0, updatedAt: 0, questions: [{ points: 100, q: "س", a: "ج" }] });
  return { approveHidden: document.getElementById("commReviewApprove").hidden,
           rejectHidden: document.getElementById("commReviewReject").hidden,
           dateFallback: /—/.test(document.getElementById("commReviewMeta").textContent) };
});
check("an already-approved category hides موافقة/رفض in the modal",
  approvedCheck.approveHidden && approvedCheck.rejectHidden);
check("a missing timestamp renders as «—», never a bogus date", approvedCheck.dateFallback);
await page.evaluate(() => document.getElementById("commReviewClose").click());

check("no uncaught JS errors across the review modal", errs.length === 0);
if (errs.length) errs.slice(0, 4).forEach(e => console.log("   " + e));
await browser.close(); server.kill();
process.exit(checks.every(Boolean) ? 0 : 1);
