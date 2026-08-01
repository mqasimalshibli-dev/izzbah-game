// XSS guard for user-supplied text reaching innerHTML.
//
// Found by audit and confirmed exploitable: renderCatPlaysStat() built the
// «الأكثر لعباً» pill with `«${name}»` interpolated raw into innerHTML. A
// COMMUNITY category name is player-supplied (rules validate only "string,
// ≤80 chars"), and once approved anyone who plays it enough for it to become
// their most-played category executes whatever is in that name. The page's CSP
// allows 'unsafe-inline', so an inline handler runs, and the payload gets
// window.IZZBAH — which on an admin's device can mint codes or write
// categories. One escapeHtml() closes it.
//
// This file drives the real render path rather than grepping for escapeHtml,
// so it fails if the escaping is removed OR routed around.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8383;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
await page.route("**/firebasejs/**", route => route.abort());
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
const errs = [];
page.on("pageerror", e => errs.push(e.message));

// Payloads that all fit inside the 80-char name limit the rules enforce.
const PAYLOADS = [
  '<img src=x onerror="window.__PWNED=1">',
  '<svg onload="window.__PWNED=1">',
  '"><script>window.__PWNED=1</script>',
  '<b onmouseover="window.__PWNED=1">hover</b>',
];

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH && window.IZZBAH.applyCommunity, { timeout: 15000 });
  await page.waitForTimeout(300);

  for (const payload of PAYLOADS) {
    const res = await page.evaluate(async (payload) => {
      window.__PWNED = 0;
      window.IZZBAH.applyCommunity([{ id: "evil1", name: payload, image: "", color: "#333",
        questions: [{ points: 100, q: "س", a: "ج" }], approved: true }]);
      // make it this device's most-played, then draw the pill
      try { localStorage.setItem("izzbah-cat-plays-v1", JSON.stringify({ evil1: 99 })); } catch (e) {}
      renderCatPlaysStat();
      await new Promise(r => setTimeout(r, 250));
      const pill = document.getElementById("catPlaysStat");
      return {
        pwned: !!window.__PWNED,
        // the payload must survive as TEXT, not as elements
        injected: pill ? pill.querySelectorAll("img,svg,script,b[onmouseover]").length : -1,
        shown: pill ? (pill.textContent || "").includes(payload.slice(0, 12)) : false,
      };
    }, payload);
    const label = payload.slice(0, 26).replace(/\s+/g, " ");
    check(`«${label}…» does not execute`, !res.pwned);
    check(`«${label}…» renders as text, not markup`, res.injected === 0);
  }

  // The name must still be READABLE — escaping, not stripping.
  const readable = await page.evaluate(async () => {
    window.IZZBAH.applyCommunity([{ id: "ok1", name: "فئة <ودّية>", image: "", color: "#333",
      questions: [{ points: 100, q: "س", a: "ج" }], approved: true }]);
    try { localStorage.setItem("izzbah-cat-plays-v1", JSON.stringify({ ok1: 99 })); } catch (e) {}
    renderCatPlaysStat();
    await new Promise(r => setTimeout(r, 200));
    const pill = document.getElementById("catPlaysStat");
    return (pill.textContent || "").includes("فئة <ودّية>");
  });
  check("a name containing angle brackets is still shown to the player", readable);

  check("no uncaught JS errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 3));
} catch (e) {
  check(`threw: ${e && e.message}`, false);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
