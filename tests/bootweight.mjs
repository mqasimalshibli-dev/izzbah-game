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

const html = readFileSync(join(ROOT, "index.html"), "utf8");

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

// No SINGLE referenced asset may be large, whatever it is. This is the check
// that actually catches the regression the file exists for: the 892 KB logo was
// one file, and it would trip this the moment it was dropped in — the type and
// the extension are irrelevant, only the weight is. The biggest today is the
// 94 KB logo, so 150 KB leaves room to re-export without hiding a blunder.
const heavy = [...refs].filter(p => existsSync(join(ROOT, p)))
  .map(p => [p, statSync(join(ROOT, p)).size])
  .filter(([, s]) => s > 150 * 1024);
check(`no single boot asset is over 150 KB${heavy.length ? " (" + heavy.map(([p, s]) => `${p} ${KB(s)}`).join(", ") + ")" : ""}`,
  heavy.length === 0);

// The shell itself. It is a single self-contained file by design, so it will
// always be large — but it should not drift upward unnoticed either.
//
// ⚠️ This number is DRIFT DETECTION, not the real guard — the asset checks above
// are. Raising it is legitimate when the growth is code; it is NOT the answer if
// this ever fails because something binary landed inside the HTML.
// History: 1.9 MB until .326. The shell crossed it at .320 and CI stayed red for
// seven builds without anyone noticing, because the failure is silent-looking
// (44 KB over on a file that gzips to 555 KB) while the steps AFTER it were
// being skipped — see the `if: !cancelled()` on every step in smoke.yml, added
// at the same time so one budget miss can never hide 39 real tests again.
// The growth from .316–.326 is admin-only tooling: restore, health board, audit
// log, diagnostics. Players download it and never run it, which is the true cost
// of a single-file app and the thing to fix if this needs raising again.
const shell = statSync(join(ROOT, "index.html")).size;
const SHELL_MAX = 2.1 * 1024 * 1024;
check(`index.html is under 2.1 MB (it is ${KB(shell)}, ${KB(SHELL_MAX - shell)} spare)`,
  shell < SHELL_MAX);

// Whole-boot budget: shell + everything it references. The catalogue and the
// Firebase SDK come from the cloud and are not counted here.
const assetBytes = [...refs].filter(p => existsSync(join(ROOT, p)))
  .reduce((t, p) => t + statSync(join(ROOT, p)).size, 0);
console.log(`      shell ${KB(shell)} + referenced assets ${KB(assetBytes)} = ${KB(shell + assetBytes)}`);
const TOTAL_MAX = 2.8 * 1024 * 1024;
check(`shell + its assets stay under 2.8 MB (they are ${KB(shell + assetBytes)}, ${KB(TOTAL_MAX - shell - assetBytes)} spare)`,
  shell + assetBytes < TOTAL_MAX);

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
