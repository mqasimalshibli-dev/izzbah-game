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

// ---- static: tooltip delegation ----
check("icon-only tooltip sweep mirrors aria-label into title (wordless only)",
  /const wordless = el => !\/\[\\p\{L\}\\p\{N\}\]\/u\.test/.test(html)
  && /document\.addEventListener\("pointerover", e => addHint\(e\.target\), true\)/.test(html));

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

  // Tooltip sweep: an icon-only button (aria-label + only an <svg>) gets a title
  // on hover; a button WITH a real word does not.
  const tips = await page.evaluate(() => {
    const mk = (label, inner) => {
      const b = document.createElement("button");
      b.setAttribute("aria-label", label); b.innerHTML = inner;
      document.body.appendChild(b);
      b.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      const t = b.getAttribute("title");
      b.remove();
      return t;
    };
    return {
      icon: mk("تبديل الدور", '<svg viewBox="0 0 1 1"></svg>'),
      symbol: mk("إغلاق", "✕"),
      worded: mk("حفظ الفئة", "حفظ")
    };
  });
  check("a wordless icon button gets its aria-label as a hover title", tips.icon === "تبديل الدور");
  check("a symbol-only button gets a hover title too", tips.symbol === "إغلاق");
  check("a button with real words is left alone (no auto title)", tips.worded === null);

  // A skeleton actually renders: open the admin feedback thread (no sign-in
  // needed for the admin view) and confirm the shimmer placeholder is injected
  // synchronously, before the (empty, offline) loader resolves.
  const sk = await page.evaluate(() => {
    try { openFeedback("tester-uid", "لاعب"); } catch (e) { return "throw:" + e.message; }
    const box = document.getElementById("feedbackThread");
    return box ? box.querySelector(".sk-wrap") ? "skeleton" : box.innerHTML.slice(0, 40) : "no-box";
  });
  check("opening a loader paints a skeleton (not bare text)", sk === "skeleton");

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
