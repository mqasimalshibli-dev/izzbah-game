// A byte budget for the cold boot, enforced in CI.
//
// The reason this exists: the splash screen and the welcome screen both showed
// `izzbah-logo.png` — a 892 KB PNG rendered at 188–300 CSS px — and the top bar
// pulled `izzbah-mark.png`, another 372 KB. That was 1.24 MB of brand art on
// the critical path of every first visit, more than the game's own HTML and the
// Firebase SDK combined. On an emulated 3G phone it was several seconds of the
// wait before any category could appear. As WebP the same two images are 149 KB.
//
// Nothing in the code stops that regressing — someone re-exports the logo from
// the master PNG, drops it in, and the boot quietly gets a megabyte heavier
// again. So: every asset the boot path actually references gets weighed, with a
// budget, offline, on every push.
import { readFileSync, statSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };
const KB = (n) => (n / 1024).toFixed(0) + " KB";

const html = readFileSync(join(ROOT, "game-mobile.html"), "utf8");

// Every same-origin asset the shell references — src="…", url(…) in CSS, and
// the handful assigned to .src in JS.
const refs = new Set();
for (const re of [/src="(assets\/[^"]+)"/g, /url\("?(assets\/[^")]+)"?\)/g, /\.src = "(assets\/[^"]+)"/g]) {
  let m; while ((m = re.exec(html))) refs.add(m[1]);
}
const missing = [...refs].filter(p => !existsSync(join(ROOT, p)));
check(`every referenced asset exists${missing.length ? " (missing: " + missing.join(", ") + ")" : ""}`,
  missing.length === 0);

// The brand art, specifically. These two are on the FIRST paint — splash and
// welcome — so they are the ones that hurt most.
const brand = [...refs].filter(p => p.startsWith("assets/brand/"));
const brandBytes = brand.reduce((t, p) => t + statSync(join(ROOT, p)).size, 0);
console.log("      brand art on the boot path:");
for (const p of brand.sort()) console.log(`        ${KB(statSync(join(ROOT, p)).size).padStart(8)}  ${p}`);
check(`brand art totals under 200 KB (it is ${KB(brandBytes)})`, brandBytes < 200 * 1024);
check("no PNG is referenced from the boot path — the logo regressed to one once",
  !brand.some(p => p.endsWith(".png")));

// Fonts: only the faces the page declares, and only once each.
const fontRefs = [...refs].filter(p => p.startsWith("assets/fonts/"));
const fontBytes = fontRefs.reduce((t, p) => t + statSync(join(ROOT, p)).size, 0);
check(`declared font files total under 340 KB (they are ${KB(fontBytes)})`, fontBytes < 340 * 1024);

// The shell itself. It is a single self-contained file by design, so it will
// always be large — but it should not drift upward unnoticed either.
const shell = statSync(join(ROOT, "game-mobile.html")).size;
check(`game-mobile.html is under 1.9 MB (it is ${KB(shell)})`, shell < 1.9 * 1024 * 1024);

// Whole-boot budget: shell + everything it references. The catalogue and the
// Firebase SDK come from the cloud and are not counted here.
const assetBytes = [...refs].filter(p => existsSync(join(ROOT, p)))
  .reduce((t, p) => t + statSync(join(ROOT, p)).size, 0);
console.log(`      shell ${KB(shell)} + referenced assets ${KB(assetBytes)} = ${KB(shell + assetBytes)}`);
check(`shell + its assets stay under 2.6 MB (they are ${KB(shell + assetBytes)})`,
  shell + assetBytes < 2.6 * 1024 * 1024);

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
