// Unit test for planCommitChunks — the helper that splits a category's writes
// into commit-sized groups so an image-heavy category (past ~10 MiB total)
// still publishes under Firestore's ~10 MiB / 500-writes per-commit limits.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8327;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage();
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1200);

  const r = await page.evaluate(() => {
    const MiB = 1024 * 1024;
    const sum = a => a.reduce((s, o) => s + (o.bytes || 0), 0);
    const out = {};

    // 1) operation-count cap
    const many = Array.from({ length: 1000 }, (_, i) => ({ id: i, bytes: 10 }));
    const c1 = planCommitChunks(many, 8 * MiB, 400);
    out.opCap = c1.length === 3 && c1.every(ch => ch.length <= 400)
      && c1.reduce((s, ch) => s + ch.length, 0) === 1000;

    // 2) byte budget: 103 image docs ~300KB + a small meta, 8 MiB budget
    const cat = Array.from({ length: 103 }, (_, i) => ({ id: "q" + i, bytes: 300 * 1024 }));
    cat.push({ id: "meta", bytes: 68 * 1024 });
    const c2 = planCommitChunks(cat, 8 * MiB, 400);
    out.total = 103 * 300 * 1024 + 68 * 1024; // ~30.9 MB
    out.byteCap = c2.every(ch => sum(ch) <= 8 * MiB) && c2.length >= 4;
    out.covers = c2.reduce((s, ch) => s + ch.length, 0) === 104;
    // order preserved and nothing dropped
    const flat = c2.flat().map(o => o.id);
    out.order = flat.length === 104 && flat[0] === "q0" && flat[103] === "meta";

    // 3) a single op larger than the budget still gets its own (solo) chunk
    const huge = [{ id: "a", bytes: 1000 }, { id: "big", bytes: 12 * MiB }, { id: "b", bytes: 1000 }];
    const c3 = planCommitChunks(huge, 8 * MiB, 400);
    out.solo = c3.some(ch => ch.length === 1 && ch[0].id === "big")
      && c3.flat().map(o => o.id).join(",") === "a,big,b";

    // 4) the realistic ثقافة عامة size (10.75 MB) splits into 2 commits
    const culture = Array.from({ length: 103 }, () => ({ bytes: 11268405 / 103 }));
    const c4 = planCommitChunks(culture, 8 * MiB, 400);
    out.cultureChunks = c4.length;
    out.cultureUnderLimit = c4.every(ch => sum(ch) <= 8 * MiB);

    // 5) a tiny publish (distractors-only: just the meta) is a single commit
    const c5 = planCommitChunks([{ id: "meta", bytes: 70 * 1024 }], 8 * MiB, 400);
    out.tiny = c5.length === 1 && c5[0].length === 1;

    return out;
  });

  check("splits on the 500-write cap (1000 ops → 3 groups ≤400 each)", r.opCap);
  check("no commit group exceeds the byte budget", r.byteCap);
  check("every op is covered exactly once", r.covers);
  check("op order is preserved (q0 first, meta last)", r.order);
  check("a single over-budget op gets its own group (order kept)", r.solo);
  check("the real ثقافة عامة size (10.75 MB) splits into 2 commits under the limit",
    r.cultureChunks === 2 && r.cultureUnderLimit);
  check("a distractors-only publish stays a single commit", r.tiny);
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
