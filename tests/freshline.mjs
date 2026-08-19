// «آخر تحديث للمحتوى … أحدث فئة …» — the line that says the game is alive.
//
// The page had no freshness signal at all, so a catalogue published last week
// and one abandoned two years ago read identically to someone deciding whether
// to install it.
//
// ⚠️ IT IS A CLAIM, SO IT HAS TO BE DERIVED. Both halves come from Firestore's
// own document timestamps via `preview/sync.mjs` — `updateTime` (which moves on
// any publish, including one question edit, which is exactly what "last
// updated" should mean) and `createTime` (which is the honest answer to "what
// is new"). A hand-typed date on a marketing page is a lie with a timer on it,
// so this test compares what is on screen against `preview/data.js` rather than
// against a fixture, and fails if the page starts inventing either half.
//
// ⚠️ AND IT MUST DISAPPEAR RATHER THAN GO BLANK. If the sync has not emitted
// the dates, an empty «آخر تحديث للمحتوى:» is worse than no line at all — it
// reads as broken, which is the opposite of what it is for.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8781;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`); };

const raw = readFileSync(join(ROOT, "preview", "data.js"), "utf8");
const DATA = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
const F = DATA.fresh || {};

check("the sync emitted a freshness block", !!DATA.fresh);
check("with a last-updated date", !!F.updated && !!F.updatedISO, F.updated);
check("and the newest category's name", !!F.newest, F.newest);

/* The date is formatted in `sync.mjs`, not in the page, because
   `Intl.DateTimeFormat('ar', …)` output is engine-dependent in both month names
   and digit shape — a poor thing to assert on and a poor thing to ship. So the
   shape is pinned here: Arabic-Indic digits and an Arabic month, matching the
   game's own legal pages («آخر تحديث: يوليو ٢٠٢٦»). */
check("the date is written in Arabic, digits and month alike",
  /^[٠-٩]{1,2} [؀-ۿ]+ [٠-٩]{4}$/.test(F.updated || ""), F.updated);
// ⚠️ It has to be the SAME day the ISO stamp names. The two are produced by
// different code paths and a formatter bug would show up here and nowhere else.
{
  const d = new Date(F.updatedISO);
  const west = (F.updated || "").replace(/[٠-٩]/g, c => "٠١٢٣٤٥٦٧٨٩".indexOf(c));
  check("and it is the same day the ISO stamp names",
    west.startsWith(String(d.getUTCDate()) + " ") && west.endsWith(" " + d.getUTCFullYear()),
    `${F.updatedISO} → ${F.updated}`);
}
/* A date in the future would mean the clock or the parse is wrong; one from
   before the game existed would mean the sort picked the wrong end. */
{
  const t = new Date(F.updatedISO).getTime();
  check("the date is a real, plausible one",
    t > Date.parse("2026-01-01") && t < Date.now() + 864e5, F.updatedISO);
}
// The newest category has to be one that is actually on the page.
check("the newest category is one the page lists",
  (DATA.cats || []).some(c => c.name === F.newest), F.newest);
/* ⚠️ The timestamps are working data, not page data. Leaving them on every
   entry would ship 40 extra strings to every visitor for one line of copy. */
check("the per-category timestamps are not shipped to the browser",
  (DATA.cats || []).every(c => !("created" in c) && !("updated" in c)));

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];
const url = `http://127.0.0.1:${PORT}/preview/index.html`;

try {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", e => errs.push(e.message));
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(900);

  const shown = await page.evaluate(() => {
    const el = document.getElementById("fresh");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      hidden: el.hidden, text: el.innerText.replace(/\s+/g, " ").trim(),
      h: Math.round(r.height), size: parseFloat(getComputedStyle(el).fontSize),
      // Values are bolded so the eye lands on the date, not the label.
      strong: [...el.querySelectorAll("b")].map(b => b.textContent.trim()),
      // …and built from nodes, so no markup arrived from the data file.
      tags: [...el.children].map(c => c.tagName).join(","),
      // It belongs with the counters — the same "here are the numbers" beat.
      afterStats: !!el.previousElementSibling && el.previousElementSibling.classList.contains("stats"),
    };
  });
  check("the line is on the page", !!shown && !shown.hidden);
  check("and it has a rendered box", shown && shown.h > 0, shown && `${shown.h}px`);
  check("it sits with the counters", shown && shown.afterStats);
  check("it is quiet, not a headline", shown && shown.size <= 16, shown && `${shown.size}px`);

  check("it names the last update, verbatim from the data file",
    shown && shown.text.includes(F.updated) && shown.text.includes("آخر تحديث"), shown && shown.text);
  check("and the newest category, verbatim",
    shown && shown.text.includes(F.newest) && shown.text.includes("أحدث فئة"));
  check("both values are the emphasised part", shown
    && shown.strong.includes(F.updated) && shown.strong.includes(F.newest),
    shown && shown.strong.join(" · "));
  check("the line is built from elements, not interpolated markup",
    shown && /^(B|SPAN)(,(B|SPAN))*$/.test(shown.tags), shown && shown.tags);

  /* ── no data: the line removes itself ─────────────────────────────
     Not "renders empty" — an empty «آخر تحديث للمحتوى:» reads as a broken
     page, which is the opposite of the reassurance this exists to give. */
  {
    const bare = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const bp = await bare.newPage();
    const bad = [];
    bp.on("pageerror", e => bad.push(e.message));
    await bp.route("**/preview/data.js", async r => {
      const res = await r.fetch();
      const body = (await res.text()).replace(/"fresh": \{[\s\S]*?\},/, "");
      await r.fulfill({ response: res, body });
    });
    await bp.goto(url, { waitUntil: "load", timeout: 30000 });
    await bp.waitForTimeout(900);
    const gone = await bp.evaluate(() => ({
      el: !!document.getElementById("fresh"),
      stray: document.body.innerText.includes("آخر تحديث للمحتوى"),
    }));
    await bare.close();
    check("with no dates in the data, the line is removed", !gone.el && !gone.stray);
    check("and nothing throws on the way", bad.length === 0, bad[0] || "");
  }

  /* Phone: two facts on one line is a wrap risk, and the separator has to go
     with it or a wrapped line starts with a dot. */
  {
    const ph = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });
    const pp = await ph.newPage();
    await pp.goto(url, { waitUntil: "load", timeout: 30000 });
    await pp.waitForTimeout(800);
    const small = await pp.evaluate(() => {
      const el = document.getElementById("fresh");
      const sep = el.querySelector(".sep");
      return {
        wide: el.scrollWidth > el.clientWidth + 1,
        sepShown: sep ? sep.getBoundingClientRect().height > 0 : false,
        lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
      };
    });
    await ph.close();
    check("it does not overflow on a phone", !small.wide);
    check("the middle dot is dropped once it stacks", !small.sepShown, `${small.lines} lines`);
  }

  check("no page errors" + (errs.length ? ": " + errs[0] : ""), errs.length === 0);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
