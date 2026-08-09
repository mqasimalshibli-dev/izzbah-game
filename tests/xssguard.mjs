// XSS guard for a player-supplied category name reaching the DOM.
//
// Found by audit and confirmed exploitable: renderCatPlaysStat() built the
// «الأكثر لعباً» pill with `«${name}»` interpolated raw into innerHTML. A
// COMMUNITY category name is player-supplied (rules validate only "string,
// ≤80 chars"), and once approved anyone who played it enough executed whatever
// was in that name. The page's CSP allows 'unsafe-inline', so an inline handler
// runs, and the payload gets window.IZZBAH — which on an admin's device can
// mint codes or write categories.
//
// That pill was removed in .284, taking the bug's original site with it. The
// CLASS of bug did not go anywhere: a community name is still player-supplied
// and still has to be rendered. So this now aims at the two places that draw
// one today — the picker's category cards, and the counter ring's peek panel
// (.283), which is the newest and therefore the least-proven.
//
// It drives the real render paths rather than grepping for escapeHtml, so it
// fails if the escaping is removed OR routed around.
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
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH && window.IZZBAH.applyCommunity, { timeout: 15000 });
  await page.waitForTimeout(300);

  for (const payload of PAYLOADS) {
    const res = await page.evaluate(async (payload) => {
      window.__PWNED = 0;
      window.IZZBAH.applyCommunity([{ id: "evil1", name: payload, image: "", color: "#333",
        questions: [{ points: 100, q: "س", a: "ج" }], approved: true }]);
      window.IZZBAH.applyAuth(true, "u");
      showScreen("categories");
      state.categoryMode = "community";
      state.selected = new Set(["evil1"]);
      renderCategories();
      await new Promise(r => setTimeout(r, 200));
      // and again through the peek panel, which renders the name a second time
      document.getElementById("catRing").click();
      await new Promise(r => setTimeout(r, 350));
      const peek = document.getElementById("catPeek");
      const grid = document.getElementById("categoryGrid");
      const bad = "img,svg,script,b[onmouseover]";
      return {
        pwned: !!window.__PWNED,
        // the payload must survive as TEXT, not as elements, in BOTH places
        injectedPeek: peek ? peek.querySelectorAll(bad).length : -1,
        // the cards legitimately contain an <svg> of their own, so count only
        // what the payload would have added
        injectedGrid: grid ? [...grid.querySelectorAll(bad)]
          .filter(el => el.getAttribute("onerror") || el.getAttribute("onload") || el.getAttribute("onmouseover")).length : -1,
        shown: peek ? (peek.textContent || "").includes(payload.slice(0, 12)) : false,
      };
    }, payload);
    const label = payload.slice(0, 26).replace(/\s+/g, " ");
    check(`«${label}…» does not execute`, !res.pwned);
    check(`«${label}…» renders as text in the peek panel`, res.injectedPeek === 0);
    check(`«${label}…» renders as text on the card`, res.injectedGrid === 0);
  }

  // The name must still be READABLE — escaping, not stripping.
  const readable = await page.evaluate(async () => {
    window.IZZBAH.applyCommunity([{ id: "ok1", name: "فئة <ودّية>", image: "", color: "#333",
      questions: [{ points: 100, q: "س", a: "ج" }], approved: true }]);
    state.categoryMode = "community";
    state.selected = new Set(["ok1"]);
    renderCategories();
    await new Promise(r => setTimeout(r, 250));
    const peek = document.getElementById("catPeek");
    // the previous payload may have left the panel shut — reopen deliberately
    if (!peek.classList.contains("show")) {
      document.getElementById("catRing").click();
      await new Promise(r => setTimeout(r, 350));
    }
    return { ok: (peek.textContent || "").includes("فئة <ودّية>"), text: peek.textContent.trim().slice(0, 80) };
  });
  check("a name containing angle brackets is still shown to the player", readable.ok);
  if (!readable.ok) console.log("  saw:", readable.text);

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
