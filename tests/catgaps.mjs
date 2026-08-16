// «ما الناقص؟» — turning the health numbers into a worklist.
//
// The health board already says a category is thin. That is a diagnosis, and it
// is not actionable: you cannot write «more questions», you write ten at the
// 100 tier. This view answers WHERE and HOW MANY.
//
// The arithmetic is the whole feature, so most of this file tests the pure
// functions. A wrong number here sends the owner to write questions in the
// wrong place, and they would not find out until the board failed to move.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8526;
const checks = [];
const check = (n, ok, extra) => {
  checks.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`);
};

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1000, height: 950 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

// n questions at a tier, plus optional blanks
const qs = (spec, blanks) => {
  const out = [];
  Object.entries(spec).forEach(([p, n]) => {
    for (let i = 0; i < n; i++) out.push({ points: Number(p), q: `س${p}-${i}`, a: `ج${i}` });
  });
  (blanks || []).forEach(p => out.push({ points: p, q: "", a: "   " }));
  return out;
};

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.IZZBAH.applyAuth(true, "adm"); window.IZZBAH.applyAdmin(true); });

  const T = (fn, ...args) => page.evaluate(([fn, args]) => window.IZZBAH_TEST[fn](...args), [fn, args]);

  // ---- counting per tier ----------------------------------------------------
  const counts = await T("tierCounts", qs({ 100: 3, 300: 1 }));
  check("tiers with questions are counted", counts["100"] === 3 && counts["300"] === 1,
    JSON.stringify(counts));
  check("...and empty tiers report ZERO, not missing — a gap must be visible",
    counts["200"] === 0 && counts["400"] === 0 && counts["500"] === 0);
  const withBlanks = await T("tierCounts", qs({ 500: 2 }, [500, 500, 500]));
  check("a BLANK question is not counted — padding must never look like progress",
    withBlanks["500"] === 2, String(withBlanks["500"]));
  const junk = await T("tierCounts", [{ points: 250, q: "x", a: "y" }, { points: 0, q: "x", a: "y" }, null]);
  check("off-scale points and nulls are ignored rather than inventing a tier",
    Object.values(junk).every(v => v === 0), JSON.stringify(junk));

  // ---- the gap for one category ---------------------------------------------
  // «حنكة عمانية» in real life: 107 questions and still repeats after 6,
  // because only 6 sit at the 100 tier. The total is the misleading number.
  const hanka = await T("tierGaps", qs({ 100: 6, 200: 10, 300: 43, 400: 36, 500: 12 }), 10);
  check("a 107-question category still reports a gap — the TOTAL is not the measure",
    hanka.length === 1, JSON.stringify(hanka));
  check("...naming the one tier that is short", hanka[0].tier === 100);
  check("...and how many to write", hanka[0].need === 4, String(hanka[0].need));

  const thin = await T("tierGaps", qs({ 100: 2, 200: 2, 300: 2, 400: 2, 500: 1 }), 10);
  check("a thin category lists every short tier", thin.length === 5);
  check("...thinnest FIRST, so the tier capping the category leads",
    thin[0].tier === 500 && thin[0].need === 9, `${thin[0].tier}/+${thin[0].need}`);

  check("a category already at target reports nothing",
    (await T("tierGaps", qs({ 100: 10, 200: 10, 300: 10, 400: 10, 500: 10 }), 10)).length === 0);
  check("...and being OVER target is not a negative gap",
    (await T("tierGaps", qs({ 100: 40, 200: 40, 300: 40, 400: 40, 500: 40 }), 10)).length === 0);

  // The target is the knob; the same category must answer differently for it,
  // or the control is decorative.
  const at5 = await T("tierGaps", qs({ 100: 6, 500: 6 }), 5);
  const at20 = await T("tierGaps", qs({ 100: 6, 500: 6 }), 20);
  check("a lower target forgives tiers a higher one flags",
    at5.length === 3 && at20.length === 5, `${at5.length} vs ${at20.length}`);
  check("...and asks for fewer at the tiers it still flags",
    at20.find(g => g.tier === 100).need === 14, JSON.stringify(at20.find(g => g.tier === 100)));
  check("a nonsense target falls back rather than dividing by nothing",
    (await T("tierGaps", qs({ 100: 1 }), 0)).length > 0
    && (await T("tierGaps", qs({ 100: 1 }), -5)).length > 0);

  // ---- the whole catalogue ---------------------------------------------------
  const all = await T("catalogueGaps", 10);
  check("the catalogue view returns a worklist", Array.isArray(all.items));
  check("...with a total to write", typeof all.write === "number" && all.write >= 0,
    `${all.write} questions across ${all.items.length} categories`);
  check("...the total equals the sum of the parts — the headline cannot drift",
    all.write === all.items.reduce((s, r) => s + r.gaps.reduce((t, g) => t + g.need, 0), 0));
  check("...worst-first, so the top of the list is the most urgent",
    all.items.every((r, i) => i === 0 || all.items[i - 1].games <= r.games),
    all.items.slice(0, 3).map(r => `${r.name}:${r.games}`).join(" "));
  check("...and nothing already at target is listed", all.items.every(r => r.gaps.length > 0));

  // ⚠️ Exclusions are REPORTED, never silent. A worklist that quietly drops
  // rows reads as «that is everything», which is how work gets missed.
  check("empty and hidden categories are counted separately, not silently dropped",
    typeof all.skippedEmpty === "number" && typeof all.skippedHidden === "number",
    `empty ${all.skippedEmpty}, hidden ${all.skippedHidden}`);
  const emptyListed = await page.evaluate(() =>
    window.IZZBAH_TEST.catalogueGaps(10).items.some(r => r.total === 0));
  check("...and an empty category is never a task (there is no tier to top up)", !emptyListed);

  // ---- the rendered view -----------------------------------------------------
  await page.evaluate(() => { openAdminChoice(); });
  await page.waitForTimeout(120);
  await page.evaluate(() => document.getElementById("adminChoiceHealth").click());
  await page.waitForTimeout(300);

  // ⚠️ Measure PAINTED visibility, never el.hidden. `.health-sort` sets
  // display:flex, which beats the UA's [hidden] rule — so the property read
  // "hidden" while the picker sat on screen under every view, and the first
  // version of this test passed the entire time the bug was live.
  const seen = (id) => page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return getComputedStyle(el).display !== "none" && r.height > 0;
  }, id);
  const before = await page.evaluate(() => ({
    tblHead: (document.querySelector("#healthBody thead") || {}).textContent || "",
  }));
  before.targetShown = await seen("healthTarget");
  check("the board opens on the normal view", /تدوم/.test(before.tblHead));
  check("...with the target picker hidden until it is relevant", !before.targetShown);

  await page.evaluate(() => document.querySelector('#healthSort button[data-sort="gaps"]').click());
  await page.waitForTimeout(300);
  const gapView = await page.evaluate(() => ({
    head: (document.querySelector("#healthBody thead") || {}).textContent || "",
    chips: document.querySelectorAll("#healthBody .gap-chip").length,
    headline: (document.querySelector("#healthBody .health-top") || {}).textContent || "",
    onChips: Array.from(document.querySelectorAll('#healthSort button')).filter(b => b.classList.contains("is-on")).length,
  }));
  check("«ما الناقص؟» switches the view", /اكتب/.test(gapView.head), gapView.head);
  check("...the target picker appears with it", await seen("healthTarget"));
  check("...it names a number of questions to write", /سؤالاً للكتابة/.test(gapView.headline));
  check("...tiers are shown as per-tier amounts, not a lump sum", gapView.chips > 0,
    `${gapView.chips} chips`);
  // The copy button lives in the toolbar now, so it must APPEAR with the view —
  // and be a quiet control, not a second big red button arguing with «إغلاق».
  // ⚠️ Assert PLACEMENT and class, not colour. The app's buttons are painted
  // with gradients, so comparing backgroundColor returns rgba(0,0,0,0) for both
  // a red primary and a ghost — a check that passes on anything.
  const copyLook = await page.evaluate(() => {
    const b = document.getElementById("healthCopyGaps");
    if (!b) return null;
    return {
      shown: getComputedStyle(b).display !== "none" && b.getBoundingClientRect().height > 0,
      ghost: b.classList.contains("ghost"),
      inToolbar: !!b.closest("#healthTarget"),
      inFooter: !!b.closest(".actions"),
      sameFamilyAsChips: getComputedStyle(b).borderRadius
        === getComputedStyle(document.querySelector('#healthSort button')).borderRadius,
    };
  });
  check("...with a way to take the list away", copyLook && copyLook.shown);
  check("...as a quiet ghost in the TOOLBAR, not a second big button in the footer",
    copyLook && copyLook.ghost && copyLook.inToolbar && !copyLook.inFooter);
  check("...matching the view chips, so the two rows read as one toolbar",
    copyLook && copyLook.sameFamilyAsChips);
  check("...and exactly one view stays selected", gapView.onChips === 1);

  // Changing the target has to change the answer on screen, not just in memory.
  const t5 = await page.evaluate(async () => {
    document.querySelector('#healthTarget button[data-target="5"]').click();
    await new Promise(r => setTimeout(r, 200));
    return (document.querySelector("#healthBody .health-top") || {}).textContent || "";
  });
  const t20 = await page.evaluate(async () => {
    document.querySelector('#healthTarget button[data-target="20"]').click();
    await new Promise(r => setTimeout(r, 200));
    return (document.querySelector("#healthBody .health-top") || {}).textContent || "";
  });
  check("changing the target changes the worklist on screen", t5 !== t20, `${t5.slice(0, 22)} / ${t20.slice(0, 22)}`);

  // And back — the gap view must not be a one-way door.
  await page.evaluate(() => document.querySelector('#healthSort button[data-sort="depth"]').click());
  await page.waitForTimeout(250);
  const back = await page.evaluate(() => ({
    head: (document.querySelector("#healthBody thead") || {}).textContent || "",
  }));
  check("switching back restores the board", /أقل مستوى/.test(back.head));
  check("...taking the copy button with it", !(await seen("healthCopyGaps")));
  check("...and the target picker really LEAVES THE SCREEN, not just el.hidden",
    !(await seen("healthTarget")));

  // ---- the summary chips must look like chips -------------------------------
  // Reported from a screenshot: «40 فئة4656 سؤالاً1 حرجة…» — one run-on string.
  // The chip CSS was scoped to .import-preview and the health board is not
  // inside one, so the chips had no pill, no border and no gap between them.
  const chipLook = await page.evaluate(() => {
    const c = document.querySelectorAll("#healthBody .health-top .imp-tier");
    if (!c.length) return null;
    const a = getComputedStyle(c[0]);
    const row = getComputedStyle(c[0].parentElement);
    const gap = parseFloat(row.columnGap || row.gap || "0");
    return {
      n: c.length, radius: parseFloat(a.borderRadius), pad: parseFloat(a.paddingInlineStart || a.paddingLeft),
      bordered: parseFloat(a.borderTopWidth) > 0, flex: row.display, gap,
      touching: c.length > 1 && Math.abs(c[0].getBoundingClientRect().left - c[1].getBoundingClientRect().right) < 2,
    };
  });
  check("the summary renders chips at all", !!chipLook && chipLook.n > 0, chipLook && `${chipLook.n}`);
  check("...each a rounded pill, not bare text", chipLook && chipLook.radius > 4 && chipLook.pad > 2,
    chipLook && `r${chipLook.radius} p${chipLook.pad}`);
  check("...with a border, so it reads as a chip", chipLook && chipLook.bordered);
  check("...laid out with a gap, so the words cannot run together",
    chipLook && chipLook.flex === "flex" && chipLook.gap > 0, chipLook && `${chipLook.flex} gap:${chipLook.gap}`);
  check("...and no two chips are touching", chipLook && !chipLook.touching);

  // One digit system per sentence. toArabicDigits is an identity function, so
  // everything else on this panel is Latin; hand-written ٥/١٠/٢٠ put both in
  // the same line.
  const digits = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#healthTarget button[data-target]")).map(b => b.textContent.trim()));
  check("the target buttons use the same digits as the rest of the app",
    digits.join(",") === "5,10,20", digits.join(","));
  const anyArabicIndic = await page.evaluate(() =>
    /[٠-٩]/.test((document.getElementById("healthBody") || {}).textContent || ""));
  check("...and no Arabic-Indic digit sneaks into the board beside them", !anyArabicIndic);

  check("no page errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 4));
} catch (e) {
  check("harness completed", false);
  console.log("  harness error:", e.message);
} finally {
  await browser.close();
  server.kill();
}
const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
