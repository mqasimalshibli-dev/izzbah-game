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

  /* ── the shuffle ───────────────────────────────────────────────
     Eight draws. If the answer were never moved it would sit at index 0 every
     time; with four choices the chance of a healthy shuffle producing that is
     about 1 in 65,000, so this cannot fail by luck. */
  const positions = [];
  for (let k = 0; k < 8; k++) {
    await page.click("#tryNext");
    await page.waitForTimeout(160);
    positions.push(await page.evaluate(() => {
      const q = document.getElementById("tryQ").textContent.trim();
      const s = (window.IZZBAH_DATA.samples || []).find(x => x.q === q);
      return [...document.querySelectorAll(".try-choice")].findIndex(b => b.textContent.trim() === s.a);
    }));
  }
  check("the answer is not always the first button", new Set(positions).size > 1, positions.join(","));
  check("«سؤال ثاني» moves through more than one question",
    (await page.evaluate(() => document.getElementById("tryQ").textContent.trim())) !== shown.q
    || samples.length === 1);

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

  check("no page errors" + (errs.length ? ": " + errs[0] : ""), errs.length === 0);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
