// App-store build: the game must sell nothing, price nothing, redeem nothing.
// Apple 3.1.1 and Google Play both require digital goods to go through their
// billing. The chosen route is not to sell in the app at all — so anything a
// reviewer could read as an outside purchase channel has to be absent.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8420;
const checks = [];
const check = (n, ok, note) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${note ? `  — ${note}` : ""}`); };
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];
const shot = async (q) => {
  const p = await browser.newPage({ viewport: { width: 430, height: 900 } });
  await p.route("**/firebasejs/**", r => r.abort());
  p.on("pageerror", e => errs.push(e.message));
  await p.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
  await p.goto(`http://127.0.0.1:${PORT}/index.html${q}`, { waitUntil: "load", timeout: 30000 });
  await p.waitForTimeout(1600);
  const r = await p.evaluate(async () => {
    const sleep = ms => new Promise(z => setTimeout(z, ms));
    const vis = (sel) => { const e = document.querySelector(sel); return !!(e && e.offsetParent !== null); };
    // Out of credits: the gate that would normally open the packs modal.
    state.freeGamePlayed = true; state.gamesUsed = 999;
    openPlans();
    await sleep(300);
    return {
      store: window.IZZBAH_TEST.isStoreBuild(),
      buyRow: vis("#settingsBuy"),
      redeemSettings: vis("#redeemInputSettings"),
      plansOpen: document.getElementById("plansModal").classList.contains("open"),
      mailto: !!document.querySelector('#plansModal a[href^="mailto"]')
              && document.getElementById("plansModal").classList.contains("open"),
      bodyClass: document.body.classList.contains("is-store-build"),
    };
  });
  await p.close();
  return r;
};

try {
  const web = await shot("");
  check("the WEBSITE is untouched — it still sells", web.store === false && web.plansOpen === true);
  check("...with the buy row present", web.buyRow === true);
  check("...and the code box present", web.redeemSettings === true);

  const app = await shot("?store=1");
  check("the store build is detected", app.store === true);
  check("THE PACKS MODAL NEVER OPENS, even from the out-of-credits gate", app.plansOpen === false);
  check("...so its mailto purchase channel is unreachable", app.mailto === false);
  check("the buy row is hidden", app.buyRow === false);
  check("the code box is hidden", app.redeemSettings === false);
  check("the body carries the flag for any later CSS", app.bodyClass === true);
  check("no page errors", errs.length === 0, errs[0] || "");
} finally { await browser.close(); server.kill(); }
const failed = checks.filter(x => !x).length;
console.log(`\n${failed ? `${failed} FAILED` : `all ${checks.length} checks passed`}`);
process.exit(failed ? 1 : 0);
