// Question media must not accumulate — on the heap, or off the disk cache.
//
// Build .209 exists because loading every category's pictures at boot put
// 541 MB of base64 on the JS heap and iOS Safari killed the tab ("A problem
// repeatedly occurred"). Two paths had quietly rebuilt the same pile:
//
//   1. catCache.all() walked an object store holding BOTH the tiny lite
//      category entries and the "media:<id>" entries — arrays of base64
//      question images — so every picture the device had ever cached was
//      deserialised into memory before the picker painted, and again for the
//      community load. Measured with the real catalogue cached: 226 MB in the
//      store, 1258 ms, +228 MB of heap, on the cold-boot critical path, with
//      no eviction except when a category is deleted in the cloud.
//   2. hydrateMediaInto() merged pictures into the live category objects and
//      nothing on the gameplay path ever released them. Measured ~34 MB per
//      six-category game, never freed: four games ≈ +137 MB.
//
// And clearing the accumulation exposed a bug that was hiding behind it: a
// mid-session publish replaces every category with a fresh stripped object
// while hydratedCats still claimed they were hydrated, so the next board drew
// with NO PICTURES. That one is pinned here too.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8422;
const checks = [];
const check = (n, ok, note) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${note ? `  — ${note}` : ""}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
await page.route("**/firebasejs/**", r => r.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => !!window.IZZBAH, { timeout: 15000 });

  /* ── 1. the disk cache never hands media back through all() ───────────── */
  /* ⚠️ CHECKED AT SOURCE, and not by choice. catCache is declared inside the
     .then() chain that only runs once the Firebase SDK has loaded, and every
     test here blocks firebasejs to stay offline — so the real all() cannot be
     called in CI at all. Same reasoning as tests/nativebridge.mjs: check the
     source for the handful of facts that break it, rather than not checking.
     The property that matters: all() must read KEYS in bulk and values ONE AT
     A TIME, skipping "media:" — a bulk getAll() of values is precisely the
     regression, because it deserialises every cached picture into the heap. */
  const src = readFileSync(join(ROOT, "index.html"), "utf8");
  const allFn = (/all\(\)\s*\{[\s\S]*?\n              \},/.exec(src) || [""])[0];
  check("catCache.all() is present and readable", allFn.length > 200, `${allFn.length} chars`);
  check("…it enumerates KEYS in bulk", /getAllKeys\(\)/.test(allFn));
  /* The regression, named: store.getAll() pulls every value — including the
     "media:<id>" arrays of base64 — into memory in one go. */
  check("…and never bulk-reads VALUES (that is what loaded the media)",
    !/\.getAll\(\)/.test(allFn.replace(/getAllKeys\(\)/g, "")));
  check("…skipping media keys explicitly", /media:/.test(allFn));
  // Eviction walks this map and needs the key to spot a dead category's media.
  check("…while still listing media keys so eviction can find them",
    /m\.set\(k,\s*null\)/.test(allFn));
  // The community load wanted exactly one key and used to walk the whole store.
  check("the community load reads its one key with get(), not all()",
    /catCache\.get\("__community__"\)/.test(src) &&
    !/catCache\.all\(\)\.then\(cache => \{\s*\n\s*const saved = cache && cache\.get\("__community__"\)/.test(src));

  /* ── 2. playing releases the previous game's pictures ─────────────────── */
  const play = await page.evaluate(async () => {
    const T = window.IZZBAH_TEST;
    const big = "data:image/jpeg;base64," + "Y".repeat(120 * 1024);
    // Six categories per board, two boards in a row — the shape of an evening.
    const mk = (id) => ({
      id, name: id, __lite: true, updatedAtMs: 1, order: 0, image: "",
      questions: [100, 200, 300].map(p => ({ points: p, q: "س", a: "ج", image: "", answerImage: "" })),
    });
    const cats = [];
    for (let i = 0; i < 12; i++) cats.push(mk("c" + i));
    window.IZZBAH.applyPublished(cats);
    // Stub the media fetch so no network is involved; it just hands back bytes.
    window.IZZBAH.hydrateCategoryMedia = (ids) => Promise.resolve(new Map(
      ids.map(id => [id, [{ image: big, answerImage: big }, { image: big, answerImage: big }, { image: big, answerImage: big }]])));

    const loaded = () => (state.publishedCategories || [])
      .reduce((n, c) => n + (c.questions || []).reduce((m, q) => m + ((q.image || "").length + (q.answerImage || "").length), 0), 0);

    // First board: categories 0-5.
    state.selected = new Set(["c0", "c1", "c2", "c3", "c4", "c5"]);
    await T.ensureBoardMedia();
    const afterFirst = loaded();
    // Second board: a completely different six.
    state.selected = new Set(["c6", "c7", "c8", "c9", "c10", "c11"]);
    await T.ensureBoardMedia();
    const afterSecond = loaded();
    return { afterFirst, afterSecond, hydratedCount: T.hydratedCount() };
  });
  check("a board's pictures do load", play.afterFirst > 6 * 3 * 120 * 1024,
    `${Math.round(play.afterFirst / 1048576)} MB after game 1`);
  /* ⚠️ The point of the whole change. Without the release this is 2× and keeps
     climbing every game until the tab dies. */
  check("…and the previous game's are released when the next board is built",
    play.afterSecond <= play.afterFirst * 1.1,
    `${Math.round(play.afterSecond / 1048576)} MB after game 2 (not ${Math.round(play.afterFirst * 2 / 1048576)})`);
  check("…so only the categories in play stay hydrated",
    play.hydratedCount === 6, `${play.hydratedCount} hydrated`);

  /* ── 3. a mid-session publish must not leave a board picture-less ─────── */
  /* ⚠️ This bug was INVISIBLE while media accumulated, because the pictures
     merged into the old objects happened to still be reachable. It bites an
     admin or editor who publishes while a game is open. */
  const republish = await page.evaluate(async () => {
    const T = window.IZZBAH_TEST;
    const big = "data:image/jpeg;base64," + "X".repeat(60 * 1024);
    const mk = (id) => ({
      id, name: id, __lite: true, updatedAtMs: 1, order: 0, image: "",
      questions: [100, 200].map(p => ({ points: p, q: "س", a: "ج", image: "", answerImage: "" })),
    });
    window.IZZBAH.hydrateCategoryMedia = (ids) => Promise.resolve(new Map(
      ids.map(id => [id, [{ image: big, answerImage: big }, { image: big, answerImage: big }]])));
    window.IZZBAH.applyPublished([mk("z0"), mk("z1")]);
    state.selected = new Set(["z0", "z1"]);
    await T.ensureBoardMedia();
    const before = (state.publishedCategories.find(c => c.id === "z0").questions[0].image || "").length;
    // An admin publishes: the catalogue reloads and every object is replaced.
    window.IZZBAH.applyPublished([mk("z0"), mk("z1")]);
    const strippedByReload = (state.publishedCategories.find(c => c.id === "z0").questions[0].image || "").length;
    await T.ensureBoardMedia();   // the board redraws
    const after = (state.publishedCategories.find(c => c.id === "z0").questions[0].image || "").length;
    return { before, strippedByReload, after };
  });
  check("a reload really does strip the pictures (the setup is honest)",
    republish.before > 60000 && republish.strippedByReload === 0);
  check("…and the next board re-fetches them instead of drawing blank",
    republish.after > 60000, `${republish.after} chars restored`);

  check("no uncaught JS errors" + (errs.length ? ": " + errs[0] : ""), errs.length === 0);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
