// meta/index — the catalogue projection a cold boot will read (build .294).
//
// Boot currently reads every category's PARENT doc in one query: measured live
// on 2026-08-10, 4.27 MB across 40 categories, of which 2.78 MB is covers and
// 1.48 MB is question text. The picker paints a name, a colour, a count and a
// picture — nothing else. This doc is that, and only that.
//
// Two measured facts decided the shape, and both contradict the older plan in
// CLAUDE.md, so they are pinned here rather than left as prose:
//   • a "7 KB thumbnail" is 160×160, a THIRD of the 480 device px a tile
//     occupies on a 3× phone — visibly soft. So: an LQIP placeholder instead,
//     with the real cover arriving separately at full quality.
//   • WebP at the same 480 px saves only ~25% and costs quality, because the
//     stored covers are already re-compressed JPEGs. So: not a re-encode.
//
// This test covers the WRITE side. The doc is inert until a reader ships.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8437;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
await page.route("**/firebasejs/**", r => r.abort());
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // A realistic catalogue: covers at the real 480 px, plus one that cannot be
  // decoded and one with no cover at all.
  const built = await page.evaluate(async () => {
    const cover = (seed, dim) => {
      const c = document.createElement("canvas");
      c.width = c.height = dim;
      const ctx = c.getContext("2d");
      const g = ctx.createLinearGradient(0, 0, dim, dim);
      g.addColorStop(0, `hsl(${seed * 37 % 360} 70% 45%)`);
      g.addColorStop(1, `hsl(${(seed * 91 + 120) % 360} 60% 25%)`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, dim, dim);
      ctx.fillStyle = "#fff"; ctx.font = `${dim / 4}px sans-serif`;
      ctx.fillText("ع" + seed, dim / 8, dim / 2);
      return c.toDataURL("image/jpeg", 0.74);
    };
    const cats = [];
    for (let i = 0; i < 40; i++) {
      cats.push({ id: "c" + i, name: "فئة " + i, order: 40 - i, color: "#9e1322",
                  image: cover(i, 480),
                  questions: Array.from({ length: 5 + i }, (_, k) => ({ points: 100, q: "س" + k, a: "ج" + k })) });
    }
    cats.push({ id: "broken", name: "غلاف تالف", order: 99, color: "#123456",
                image: "data:image/jpeg;base64," + "A".repeat(4000), questions: [{ points: 100, q: "س", a: "ج" }] });
    cats.push({ id: "nocover", name: "بلا غلاف", order: 100, color: "#654321", image: "", questions: [] });

    const entries = await buildCategoryIndexEntries(cats);
    const bytes = JSON.stringify(entries).length;
    const lqipBytes = entries.map(e => (e.lqip || "").length);
    return {
      n: entries.length, bytes, ceiling: INDEX_DOC_CEILING,
      first: entries[0],
      ordered: entries.every((e, i) => i === 0 || e.order >= entries[i - 1].order),
      counts: entries.filter(e => e.id === "c0")[0].count,
      allWebp: entries.filter(e => e.lqip).every(e => e.lqip.indexOf("data:image/webp") === 0),
      brokenLqip: entries.find(e => e.id === "broken").lqip,
      nocoverLqip: entries.find(e => e.id === "nocover").lqip,
      maxLqip: Math.max(...lqipBytes),
      avgLqip: Math.round(lqipBytes.reduce((a, b) => a + b, 0) / lqipBytes.length),
      // No question text, no full cover — that is the entire point.
      keys: Object.keys(entries[0]).sort().join(","),
    };
  });

  check("one entry per category", built.n === 42, `${built.n} entries`);
  check("entries carry ONLY what the picker paints",
    built.keys === "color,count,id,lqip,name,order", built.keys);
  check("the question COUNT replaces the question array", built.counts === 5);
  check("entries are pre-sorted by display order", built.ordered);
  check("placeholders are WebP", built.allWebp);
  check("a placeholder is a placeholder, not a thumbnail",
    built.maxLqip < 4000, `avg ${built.avgLqip} B, max ${built.maxLqip} B`);
  check("an undecodable cover yields no placeholder rather than garbage",
    built.brokenLqip === "");
  check("a category with no cover is still indexed", built.nocoverLqip === "");
  // The whole point: this must be a fraction of the 4.27 MB boot read.
  check("the whole index is small enough to be the boot read",
    built.bytes < 150000 && built.bytes < built.ceiling,
    `${Math.round(built.bytes / 1024)} KB for 42 categories (ceiling ${Math.round(built.ceiling / 1024)} KB)`);

  // ---- the writer refuses rather than hand Firestore a doc it will reject --
  const ceiling = await page.evaluate(async () => {
    let wrote = false;
    window.IZZBAH.writeCategoryIndex = () => { wrote = true; return Promise.resolve(); };
    // A catalogue far past the cap: 300 categories, each with a real cover.
    const c = document.createElement("canvas");
    c.width = c.height = 480;
    const ctx = c.getContext("2d");
    const im = ctx.createImageData(480, 480);
    let seed = 7;
    for (let i = 0; i < im.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      im.data[i] = seed & 255; im.data[i+1] = (seed >> 8) & 255; im.data[i+2] = (seed >> 16) & 255; im.data[i+3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    const noisy = c.toDataURL("image/jpeg", 0.9);
    state.publishedCategories = Array.from({ length: 900 }, (_, i) =>
      ({ id: "x" + i, name: "فئة طويلة الاسم رقم " + i, order: i, color: "#9e1322",
         image: noisy, questions: [] }));
    const toast = document.getElementById("appToast");
    toast.classList.remove("show");
    await rebuildCategoryIndex();
    await new Promise(r => setTimeout(r, 200));
    return { wrote, toast: toast.textContent || "",
             hasCeiling: typeof INDEX_DOC_CEILING === "number" && INDEX_DOC_CEILING < 1048576 };
  });
  check("there is a ceiling below Firestore's 1 MiB per-document limit", ceiling.hasCeiling);
  check("an oversized catalogue is REFUSED locally, not sent to be rejected",
    !ceiling.wrote && /كبير/.test(ceiling.toast), ceiling.toast.trim());

  // ---- the button exists, is admin-only, and is wired ----
  const wiring = await page.evaluate(async () => {
    const btn = document.getElementById("adminBuildIndex");
    delete window.IZZBAH.writeCategoryIndex;         // signed out / not admin
    const toast = document.getElementById("appToast");
    toast.classList.remove("show");
    await rebuildCategoryIndex();
    await new Promise(r => setTimeout(r, 150));
    return { present: !!btn, signedOutToast: toast.textContent || "" };
  });
  check("the rebuild button exists in the admin toolbar", wiring.present);
  check("without the admin bridge it refuses instead of throwing",
    /سجّل الدخول/.test(wiring.signedOutToast), wiring.signedOutToast);

  // ---- the rules must actually permit this document ----
  const rules = readFileSync(join(ROOT, "firestore.rules"), "utf8");
  check("firestore.rules has a match for meta/index", /match \/meta\/index\b/.test(rules));
  check("…public read, admin write, shape-checked",
    /match \/meta\/index[\s\S]{0,400}allow read: if true;[\s\S]{0,400}isAdmin\(\)[\s\S]{0,200}hasOnly\(\['cats', 'updatedAt'\]\)/.test(rules));
  // The generic meta rule field-locks writes to rev/updatedAt, which would
  // REJECT this doc — the specific match above is what makes it possible.
  check("the stricter generic /meta rule is still there for everything else",
    /match \/meta\/\{doc\}[\s\S]{0,300}hasOnly\(\['rev', 'updatedAt'\]\)/.test(rules));

  check("no uncaught JS errors", errs.length === 0, errs.slice(0, 2).join(" | "));
} catch (e) {
  check("harness completed", false, e && e.message);
} finally {
  await browser.close();
  server.kill();
}

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
