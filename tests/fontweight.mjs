// Cairo ships as ONE variable file covering the whole 400–900 weight axis.
//
// It used to ship as six per-weight faces — and those six files were
// byte-identical, so a boot that painted four weights downloaded the same
// 30 KB Arabic subset four times (and the same 33 KB Latin subset four times).
// Collapsing them to one file per unicode-range took ~190 KB off every cold
// boot.
//
// The danger in that change is silent: if the file were NOT variable — if one
// static weight had simply been copied six times — collapsing the faces would
// look identical in the diff while making every weight render the same, so
// bold would stop being bold across the whole game. `document.fonts.check()`
// cannot tell you (it returns true for a fallback match). The only honest test
// is a WIDTH PROBE: render the same string at 400 and at 900 and demand that
// the advances differ.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8379;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const html = readFileSync(join(ROOT, "game-mobile.html"), "utf8");

// ── static: one Cairo face per unicode-range, spanning the whole axis ────────
const cairoFaces = (html.match(/@font-face \{ font-family: 'Cairo';[\s\S]*?\n    \}/g) || []);
check("Cairo is declared once per unicode-range, not once per weight",
  cairoFaces.length === 3);
check("...each spanning the full 400–900 variable axis",
  cairoFaces.every(f => /font-weight: 400 900/.test(f)));
check("...and all pointing at the one shared file",
  cairoFaces.every(f => /Cairo-var-(ar|lat|latx)\.woff2/.test(f)));

// The per-weight files must be GONE, or a stale reference silently costs the
// bytes this change removed.
const fonts = readdirSync(join(ROOT, "assets/fonts"));
check("the per-weight Cairo files are deleted from the repo",
  !fonts.some(f => /^Cairo-(400|500|600|700|800|900)-/.test(f)));
check("nothing still references a per-weight Cairo file",
  !/Cairo-(400|500|600|700|800|900)-/.test(html));

// No font file is a duplicate of another under a second name — the exact
// waste this test exists to prevent, in whatever font it reappears.
const seen = new Map();
const dupes = [];
for (const f of fonts) {
  const key = readFileSync(join(ROOT, "assets/fonts", f)).toString("base64");
  if (seen.has(key)) dupes.push(`${f} == ${seen.get(key)}`); else seen.set(key, f);
}
check(`no font file is shipped twice under two names${dupes.length ? " (" + dupes.join(", ") + ")" : ""}`,
  dupes.length === 0);

// ── live: the weights are real ──────────────────────────────────────────────
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
try {
  const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
  await page.route("**/firebasejs/**", r => r.abort());
  await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });

  const probe = await page.evaluate(async () => {
    const S = "عِزبة لعبة المعرفة والتحدي";
    const WEIGHTS = [400, 500, 600, 700, 800, 900];
    for (const w of WEIGHTS) { try { await document.fonts.load(`${w} 40px Cairo`, S); } catch (e) {} }
    await document.fonts.ready;
    const c = document.createElement("canvas").getContext("2d");
    const width = (w, fam) => { c.font = `${w} 40px ${fam}`; return +c.measureText(S).width.toFixed(2); };
    const out = {};
    for (const w of WEIGHTS) out[w] = width(w, "'Cairo'");
    out.fallback = width(400, "'NoSuchFamilyQq'");
    return out;
  });

  check("Cairo actually loaded (it does not measure as the fallback face)",
    probe[400] !== probe.fallback);
  check("400 and 900 are different weights, not the same file rendered twice",
    probe[900] > probe[400]);
  check("every declared weight is distinct — the axis really is interpolating",
    new Set([400, 500, 600, 700, 800, 900].map(w => probe[w])).size === 6);
  check("weight increases monotonically with the requested value",
    [500, 600, 700, 800, 900].every((w, i) => probe[w] >= probe[[400, 500, 600, 700, 800][i]]));
  console.log("      widths: " + [400, 500, 600, 700, 800, 900].map(w => `${w}:${probe[w]}`).join("  "));
  await page.close();
} catch (e) {
  check(`threw: ${e && e.message}`, false);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
