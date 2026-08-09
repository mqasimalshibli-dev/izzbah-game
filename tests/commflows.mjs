// The community moderation queue: approve, reject, preview.
//
// Driven with NO Firebase bridge attached, which is the state an admin is in
// when offline or before the session restores. A moderation button that throws
// in that state looks to the admin exactly like a button that does nothing —
// and the category stays in the queue with no explanation.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8415;
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

const seed = async () => page.evaluate(() => {
  state.isAdmin = true; if (window.IZZBAH.applyAdmin) window.IZZBAH.applyAdmin(true);
  state.editorTarget = "community";
  window.IZZBAH.applyPendingCommunity([
    { id: "pend-1", name: "فئة معلّقة", authorName: "<img src=x onerror=alert(1)>", approved: false,
      questions: [{ points: 100, q: "س", a: "ج" }, { points: 200, q: "س٢", a: "ج٢" }] },
  ]);
  renderCustomManager(); showScreen("customManager");
});

await seed();
await page.waitForTimeout(400);

const ui = await page.evaluate(() => {
  const txt = document.getElementById("customManager").textContent;
  const btns = [...document.querySelectorAll("#customManager button")].map(b => b.textContent.trim());
  return { queueHead: /بانتظار الموافقة/.test(txt), count: /\(1\)|\(١\)/.test(txt),
           approve: btns.includes("موافقة"), reject: btns.includes("رفض"), preview: btns.includes("معاينة"),
           authorEscaped: !document.querySelector("#customManager img[src='x']"), qCount: /2|٢/.test(txt) };
});
check("the pending queue renders with its count", ui.queueHead && ui.count);
check("each row offers preview, approve and reject", ui.preview && ui.approve && ui.reject);
check("the author name is escaped, not injected", ui.authorEscaped);

// ---- approve / reject with NO bridge attached ----
for (const [label, text] of [["approve", "موافقة"], ["reject", "رفض"]]) {
  const before = errs.length;
  await page.evaluate(t => {
    delete window.IZZBAH.communityApprove; delete window.IZZBAH.communityDelete;
    const b = [...document.querySelectorAll("#customManager button")].find(x => x.textContent.trim() === t);
    if (b) b.click();
  }, text);
  await page.waitForTimeout(300);
  const thrown = errs.slice(before);
  const toast = await page.evaluate(() => {
    const t = document.getElementById("appToast");
    return t && t.classList.contains("show") ? (t.textContent || "").trim().slice(0, 40) : "";
  });
  check(`«${text}» with no bridge fails cleanly, with a message`,
    thrown.length === 0 && !!toast, thrown.length ? thrown[0].slice(0, 70) : `toast="${toast}"`);
}

// ---- preview must work offline (it is pure client rendering) ----
{
  const before = errs.length;
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("#customManager button")].find(x => x.textContent.trim() === "معاينة");
    if (b) b.click();
  });
  await page.waitForTimeout(400);
  check("«معاينة» opens without error", errs.length === before);
}

check("no uncaught JS errors across moderation", errs.length === 0);
if (errs.length) errs.slice(0, 4).forEach(e => console.log("   " + e));
await browser.close(); server.kill();
process.exit(checks.every(Boolean) ? 0 : 1);
