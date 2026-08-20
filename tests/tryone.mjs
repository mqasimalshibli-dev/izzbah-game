// «جرّب بنفسك» — one real question from the game, playable on the landing page.
//
// The page could describe the game or let someone play a turn of it. This is
// the turn: a real question, its four real choices, and the free-game CTA at
// the moment the visitor is most engaged — right after they have answered.
//
// ⚠️ NOTHING HERE IS HAND-WRITTEN. The question, the choices and the points all
// come from `preview/data.js`, which `preview/sync.mjs` fills from Firestore. A
// taster typed by hand drifts from the game and ends up promising content that
// is not there, so the test compares what is on screen against the data file
// rather than against a fixture of its own.
//
// ⚠️ THE CHOICES MUST BE SHUFFLED. They arrive answer-first out of Firestore. A
// taster whose first button is always correct teaches the visitor the wrong
// thing about the game and looks rigged the second time they meet it.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8751;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`); };

// The data the page is supposed to be showing, read independently.
const src = readFileSync(join(ROOT, "preview", "data.js"), "utf8");
const DATA = JSON.parse(src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1));
const samples = DATA.samples || [];
check("sync emitted taster questions", samples.length >= 3, `${samples.length}`);
check("each carries four real choices and its own answer",
  samples.every(s => s.q && s.a && s.choices && s.choices.length === 4 && s.choices.includes(s.a)));
// A question whose subject is a picture reads as a riddle with the point
// missing, because the taster only ever shows text.
check("none of them needs a picture to make sense",
  samples.every(s => !s.image), `${samples.length} checked`);

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

try {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", e => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/preview/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(900);

  const shown = await page.evaluate(() => ({
    exists: !!document.getElementById("try"),
    cat: document.getElementById("tryCat").textContent.trim(),
    q: document.getElementById("tryQ").textContent.trim(),
    pts: document.getElementById("tryPts").textContent.trim(),
    choices: [...document.querySelectorAll(".try-choice")].map(b => b.textContent.trim()),
    afterHidden: document.getElementById("tryAfter").hidden,
  }));
  check("the section is on the page", shown.exists);

  const match = samples.find(s => s.q === shown.q);
  check("the question shown is one from the data file, verbatim", !!match, shown.q.slice(0, 40));
  if (match) {
    check("its category label matches the data", shown.cat === match.cat, `${shown.cat}`);
    check("all four choices are shown, and they are the authored ones",
      shown.choices.length === 4 && match.choices.every(c => shown.choices.includes(c)),
      shown.choices.join(" · "));
  }
  check("nothing is revealed before the visitor answers", shown.afterHidden === true);

  /* ── answering ─────────────────────────────────────────────────
     Answer WRONG on purpose. Getting it right is the easy path; the one that
     matters is the visitor who does not know, because that is when the answer
     has to be shown and the CTA has to appear. */
  await page.evaluate(() => document.getElementById("try").scrollIntoView({ behavior: "instant" }));
  await page.waitForTimeout(300);
  const wrongText = shown.choices.find(c => c !== (match ? match.a : ""));
  await page.evaluate(t => [...document.querySelectorAll(".try-choice")]
    .find(b => b.textContent.trim() === t).click(), wrongText);
  await page.waitForTimeout(400);

  const after = await page.evaluate(() => ({
    revealed: !document.getElementById("tryAfter").hidden,
    verdict: document.getElementById("tryVerdict").textContent.trim(),
    right: [...document.querySelectorAll(".try-choice.right")].map(b => b.textContent.replace(/[✓✕]/g, "").trim()),
    wrong: [...document.querySelectorAll(".try-choice.wrong")].length,
    locked: [...document.querySelectorAll(".try-choice")].every(b => b.disabled),
    // right/wrong must not be carried by colour alone
    marks: [...document.querySelectorAll(".try-choice .mark")].length,
    cta: (document.querySelector("#tryAfter .btn") || {}).getAttribute?.("href"),
  }));
  check("answering reveals the result", after.revealed);
  check("the correct answer is marked, and it is the right one",
    after.right.length === 1 && (!match || after.right[0] === match.a), after.right.join(""));
  check("the wrong pick is marked too", after.wrong === 1);
  check("right and wrong are not carried by colour alone", after.marks === 2, `${after.marks} marks`);
  check("the choices lock once answered", after.locked);
  check("the answer is told to someone who got it wrong",
    !match || after.verdict.includes(match.a), after.verdict.slice(0, 46));
  check("and the free game is offered right there", after.cta === "../", after.cta);

  /* ── four questions, a new set every fortnight ─────────────────
     Asked of the page's own chooser rather than recomputed here: a test that
     repeats the implementation's arithmetic agrees with it by construction and
     would pass just as happily if both were wrong.

     ⚠️ THIS REPLACES A ONE-PER-DAY CONTRACT. The taster has been three things:
     random on every load (so reloading was a way to shop for an easy one, and
     nobody had a reason to come back), then one question per day (stable and
     returnable, but it removed the «سؤال ثاني» button, so a visitor who
     answered and wanted another had to come back TOMORROW for it). The owner's
     call is a SET OF FOUR fixed for a fortnight, stepped through at the
     reader's pace — which keeps both halves. */
  const rot = await page.evaluate(() => {
    const T = window.IZZBAH_TRY;
    if (!T) return null;
    const at = iso => T.setFor(new Date(iso + "T12:00:00")).join(",");
    // Fifteen fortnights of sets, to see the whole cycle and its wrap.
    const runs = [];
    for (let p = 0; p < 15; p++) {
      const dt = new Date("2026-08-19T12:00:00");
      dt.setDate(dt.getDate() + p * T.days);
      runs.push(T.setFor(dt).join(","));
    }
    return {
      pool: T.pool, size: T.size, days: T.days,
      sameTwice: at("2026-08-19") === at("2026-08-19"),
      // a DAY later must NOT change it — that is the whole point of a fortnight
      nextDaySame: at("2026-08-19") === at("2026-08-20"),
      midFortnightSame: at("2026-08-19") === at("2026-08-25"),
      runs,
    };
  });
  check("the page exposes its set chooser", !!rot);
  if (rot) {
    check(`it shows a set of four (${rot.size})`, rot.size === 4);
    check(`and the set turns over every fortnight (${rot.days} days)`, rot.days === 14);
    check("the same date always gives the same set", rot.sameTwice);
    /* ⚠️ Both directions. "The next fortnight differs" alone would pass on a
       chooser that changed every DAY, which is exactly the behaviour being
       replaced — so the day-after and mid-fortnight cases are pinned too. */
    check("the day after does not change it", rot.nextDaySame, `${rot.runs[0]}`);
    check("nor does the middle of the fortnight", rot.midFortnightSame);
    check("the next fortnight brings a different set", rot.runs[1] !== rot.runs[0],
      `${rot.runs[0]} → ${rot.runs[1]}`);
    /* Four DIFFERENT questions, not a reshuffle of last fortnight's — a
       returning reader has to meet something new. */
    const overlap = (x, y) => x.split(",").filter(v => y.split(",").includes(v)).length;
    check("and none of them is one of the four just shown",
      overlap(rot.runs[0], rot.runs[1]) === 0, `${overlap(rot.runs[0], rot.runs[1])} shared`);
    // No question is stranded: everything in the pool gets its fortnight.
    const seen = new Set(rot.runs.join(",").split(","));
    check("every question in the pool is reached", seen.size === rot.pool,
      `${seen.size}/${rot.pool}`);
    // …and no set repeats for months, so returning is worth it for a long time.
    const firstRepeat = rot.runs.findIndex((r, i) => i > 0 && r === rot.runs[0]);
    check("a set does not come round again for months",
      firstRepeat === -1 || firstRepeat >= 6,
      firstRepeat === -1 ? "not within 15 fortnights" : `repeats after ${firstRepeat} fortnights (${firstRepeat * 2} weeks)`);
    check("the pool holds enough for several sets", rot.pool >= rot.size * 3,
      `${rot.pool} questions = ${(rot.pool / rot.size).toFixed(1)} sets`);
  }

  /* ── stepping through the four ─────────────────────────────────
     The «سؤال ثاني ↻» button is the half the one-per-day version lost, and it
     is the reason the set is four rather than one. */
  {
    await page.reload({ waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(500);
    const state = () => page.evaluate(() => ({
      step: document.getElementById("tryStep").textContent.trim(),
      q: document.getElementById("tryQ").textContent.trim(),
      // ⚠️ Measured, not read off the attribute. An author `display` beats the
      // UA's `[hidden]{display:none}` whatever the specificity, and that is
      // exactly what happened here: the button stayed on screen through the
      // last question with `hidden` correctly set.
      nextShown: (() => { const b = document.getElementById("tryNext");
        return !!b && b.getBoundingClientRect().height > 0; })(),
    }));
    const answerOne = () => page.evaluate(() =>
      document.querySelectorAll(".try-choice")[0].click());

    const first = await state();
    check("it opens on the first of four", first.step === "١ / ٤", first.step);
    check("and offers no «سؤال ثاني» before anything is answered", !first.nextShown);

    const seenQ = [first.q];
    for (let k = 1; k <= 3; k++) {
      await answerOne();
      await page.waitForTimeout(300);
      const after = await state();
      check(`answering ${k} of 4 offers the next one`, after.nextShown, after.step);
      await page.click("#tryNext");
      await page.waitForTimeout(400);
      const next = await state();
      check(`  it moves to question ${k + 1}`, next.step === ["٢ / ٤", "٣ / ٤", "٤ / ٤"][k - 1],
        next.step);
      seenQ.push(next.q);
    }
    check("the four are four different questions", new Set(seenQ).size === 4,
      `${new Set(seenQ).size} distinct`);

    await answerOne();
    await page.waitForTimeout(300);
    const last = await state();
    /* ⚠️ Hidden on the LAST one rather than wrapping to the first. A «سؤال
       ثاني» that serves a question already answered reads as broken, and four
       being the set is the whole point of the fortnight. */
    check("the fourth offers no next — the set is finished", !last.nextShown, last.step);
    const cta = await page.evaluate(() =>
      (document.querySelector("#tryAfter .btn") || {}).getAttribute?.("href"));
    check("but the free game is still offered there", cta === "../", cta);
  }

  /* ── the shuffle ───────────────────────────────────────────────
     The QUESTION is fixed for the day; the ORDER of its choices is not, so a
     visitor cannot learn "it is always the second one". Eight reloads: if the
     answer were never moved it would sit at index 0 every time, which a healthy
     shuffle would produce about once in 65,000 runs. */
  const positions = [];
  for (let k = 0; k < 8; k++) {
    await page.reload({ waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(260);
    positions.push(await page.evaluate(() => {
      const q = document.getElementById("tryQ").textContent.trim();
      const s = (window.IZZBAH_DATA.samples || []).find(x => x.q === q);
      return [...document.querySelectorAll(".try-choice")].findIndex(b => b.textContent.trim() === s.a);
    }));
  }
  check("the answer is not always in the same position", new Set(positions).size > 1, positions.join(","));
  check("but the fortnight's first question does not change on reload",
    (await page.evaluate(() => document.getElementById("tryQ").textContent.trim())) === shown.q);

  // The hero's promise, which is what the taster is feeding.
  const hero = await page.evaluate(() => ({
    badge: (document.querySelector(".free-badge") || {}).textContent || "",
    cta: (document.querySelector(".cta-row .btn") || {}).textContent || "",
  }));
  check("the hero leads with the free game", hero.badge.includes("مجاناً") && hero.cta.includes("مجاناً"),
    hero.cta.trim());
  // It says no account and no download, and `canStartNewGame()` in the game
  // really does allow both — do not soften this without re-checking that.
  check("and says what it costs to try: nothing", hero.badge.includes("بدون حساب"), hero.badge.trim());

  // The placeholder reviews that used to ship.
  const quotes = await page.evaluate(() => document.body.textContent.includes("ضع هنا رأياً"));
  check("no placeholder review text is on the page", !quotes);

  /* ── LOCAL midnight, not UTC ───────────────────────────────────
     ⚠️ This needs a non-UTC timezone to mean anything. CI runs in UTC, where
     the local-time formula and a naive UTC one are IDENTICAL — reverting the
     offset subtraction failed zero checks until this context existed. Muscat is
     UTC+4, so 01:00 local is still 21:00 UTC the previous day: under a UTC
     formula the set would not have turned over yet, and a player in Oman would
     meet the new four at 4am.
     ⚠️ The probe has to sit on a real FORTNIGHT boundary, which is not every
     midnight — thirteen midnights in fourteen change nothing, so a date picked
     by hand would test the wrong thing and pass. The page is asked where its
     own boundary falls. */
  const muscat = await browser.newContext({ viewport: { width: 900, height: 800 }, timezoneId: "Asia/Muscat" });
  const mp = await muscat.newPage();
  await mp.goto(`http://127.0.0.1:${PORT}/preview/index.html`, { waitUntil: "load", timeout: 30000 });
  await mp.waitForTimeout(700);
  const tz = await mp.evaluate(() => {
    const T = window.IZZBAH_TRY;
    const noon = d => { const x = new Date("2026-08-19T12:00:00"); x.setDate(x.getDate() + d); return x; };
    let flip = -1;
    for (let d = 1; d <= 20 && flip < 0; d++)
      if (T.periodFor(noon(d)) !== T.periodFor(noon(d - 1))) flip = d;
    if (flip < 0) return { offset: new Date().getTimezoneOffset(), flip: -1 };
    const day = noon(flip);
    const at = (dayOffset, h, m) => {
      const x = new Date(day); x.setDate(x.getDate() + dayOffset); x.setHours(h, m, 0, 0);
      return T.setFor(x).join(",");
    };
    return {
      offset: new Date().getTimezoneOffset(),
      flip,
      flipDay: day.toDateString(),
      before: at(-1, 23, 0),   // 19:00 UTC the previous day
      after:  at(0, 1, 0),     // 21:00 UTC the PREVIOUS day — UTC has not flipped
      noonAfter: at(0, 12, 0),
    };
  });
  await muscat.close();
  check("the timezone is really emulated", tz.offset === -240, `offset ${tz.offset} min`);
  check("a fortnight boundary was found to probe", tz.flip > 0, `day +${tz.flip} (${tz.flipDay})`);
  check("just after LOCAL midnight it is already the next fortnight's set",
    tz.flip > 0 && tz.after !== tz.before && tz.after === tz.noonAfter,
    `23:00 the night before → ${tz.before}, 01:00 → ${tz.after}`);

  check("no page errors" + (errs.length ? ": " + errs[0] : ""), errs.length === 0);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
