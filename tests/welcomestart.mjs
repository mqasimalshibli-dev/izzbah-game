// The welcome screen's primary button: its wording, and how much of the screen
// it takes.
//
// It read «ابدأ لعبة جديدة» at 19.5px with 55px of horizontal padding, which
// came to 240×60 on an iPhone — 62% of the screen width, and 68% on a small
// phone. The owner's word was "very big". It is now «ابدأ اللعب» at a smaller
// step, and the shorter label does as much of the work as the padding does.
//
// The wording is asserted against the HOW-TO text as well as the button. That
// pairing is the point: «كيف تلعب؟» tells the player to press a button BY NAME,
// so a rename that touches only the button leaves the instructions quoting a
// label that no longer exists anywhere on screen.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8489;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const LABEL = "ابدأ اللعب";
const OLD = "ابدأ لعبة جديدة";

// Static guard: no user-visible copy may still quote the old wording. Comments
// and test files legitimately mention it as history, so only look at markup.
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const visibleOld = [...html.matchAll(new RegExp(`[^\\n]*${OLD}[^\\n]*`, "g"))]
  .map(m => m[0].trim())
  .filter(line => !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*")
    && !line.startsWith("<!--"));
check(`no visible copy still says «${OLD}» (${visibleOld.length} line(s))`, visibleOld.length === 0);
if (visibleOld.length) console.log("   still there:", visibleOld[0].slice(0, 110));

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

// maxPct: the button must not dominate the screen at this width.
const VIEWPORTS = [
  { w: 320, h: 700, n: "tiny phone", maxPct: 50 },
  { w: 390, h: 844, n: "iPhone 14", maxPct: 46 },
  { w: 430, h: 932, n: "Pro Max", maxPct: 46 },
  { w: 820, h: 1180, n: "iPad portrait", maxPct: 30 },
];

try {
  for (const v of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: v.w, height: v.h } });
    await page.route("**/firebasejs/**", r => r.abort());
    page.on("pageerror", e => errs.push(e.message));
    await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1000);

    const m = await page.evaluate(() => {
      const el = document.querySelector(".wlc-start");
      if (!el) return { missing: true };
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        text: el.textContent.trim(),
        font: parseFloat(s.fontSize),
        w: Math.round(r.width), h: Math.round(r.height),
        pct: r.width / window.innerWidth * 100,
        // one line, never wrapped or clipped by the shrink
        clipped: el.scrollWidth > el.clientWidth + 1,
        offscreen: r.left < 0 || r.right > window.innerWidth + 1,
      };
    });

    check(`${v.n}: the start button exists`, !m.missing);
    if (m.missing) { await page.close(); continue; }
    check(`${v.n}: it reads «${LABEL}»`, m.text === LABEL);
    check(`${v.n}: it no longer dominates the screen (${Math.round(m.pct)}%, was 62-68%)`,
      m.pct <= v.maxPct);
    // Shrinking a primary control is only safe down to the point where it is
    // still comfortably tappable — 44px is the platform minimum, and this is
    // the one control every session starts with.
    check(`${v.n}: it stays a comfortable tap target (${m.h}px ≥ 44px)`, m.h >= 44);
    check(`${v.n}: the label still fits on one line, unclipped (${m.w}px)`,
      !m.clipped && !m.offscreen);
    check(`${v.n}: the type stays readable (${Math.round(m.font)}px)`, m.font >= 15);
    await page.close();
  }

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
