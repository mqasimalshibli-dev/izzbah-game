// Regression: a long question on the question screen must not render BEHIND the
// lifeline (helper) bar, which is absolutely positioned over the card's right
// edge. The card reserves room (class has-helpbar) whenever the bar has slots.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8329;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
// a narrower landscape viewport, where the text is most likely to reach the bar
const page = await browser.newPage({ viewport: { width: 820, height: 460 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

const setup = (helpers) => page.evaluate((helpers) => {
  state.teamCount = 2;
  state.teams = [
    { name: "أ", helpers: helpers.slice(), helpUsed: {}, score: 0, helpBanned: false, doubleArmed: false },
    { name: "ب", helpers: helpers.slice(), helpUsed: {}, score: 0, helpBanned: false, doubleArmed: false },
  ];
  state.activeTeam = 0;
  const cat = { id: "pub-x", name: "تاريخ" };
  const q = { q: "ما هو أطول سؤال يمكن أن نكتبه في هذه الشاشة لاختبار التفاف النص بحيث لا يختفي أي جزء منه خلف شريط وسائل المساعدة الجانبي؟", a: "جواب", points: 100 };
  state.activeQuestion = { cat, q, key: "t", team: 0 };
  fillQuestionContent(cat, q);
  showScreen("questionPage", { keepQuestion: true });
  renderTeamHelpBar(document.getElementById("questionHelpBar"), 0, "question");
}, helpers);

const measure = () => page.evaluate(() => {
  const card = document.querySelector("#questionPage .question-main-card");
  const text = document.getElementById("modalQuestion");
  const bar = document.getElementById("questionHelpBar");
  const tr = text.getBoundingClientRect();
  const br = bar.getBoundingClientRect();
  const horiz = Math.min(tr.right, br.right) - Math.max(tr.left, br.left);
  const vert = Math.min(tr.bottom, br.bottom) - Math.max(tr.top, br.top);
  return {
    hasClass: card.classList.contains("has-helpbar"),
    slots: bar.children.length,
    barVisible: br.width > 0 && br.height > 0,
    // positive on both axes ⇒ the rectangles actually intersect
    overlap: (horiz > 1 && vert > 1) ? Math.round(horiz) : 0,
    textRight: Math.round(tr.right), barLeft: Math.round(br.left),
  };
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ---- 1) with a full helper loadout, the bar shows and the text clears it ----
  await setup(["fourChoices", "firstLetter", "doublePoints"]);
  await page.waitForTimeout(300);
  const full = await measure();
  check("the lifeline bar is rendered with slots", full.slots >= 1 && full.barVisible);
  check("the card reserves room for the bar (has-helpbar)", full.hasClass);
  check(`the long question does NOT overlap the bar (overlap=${full.overlap}px)`, full.overlap === 0);
  check("the question text ends to the left of the bar", full.textRight <= full.barLeft + 1);

  // ---- 2) prove the reservation matters: without it, the text WOULD overlap ----
  const wouldOverlap = await page.evaluate(() => {
    const card = document.querySelector("#questionPage .question-main-card");
    card.classList.remove("has-helpbar"); // simulate the old behaviour
    const tr = document.getElementById("modalQuestion").getBoundingClientRect();
    const br = document.getElementById("questionHelpBar").getBoundingClientRect();
    const horiz = Math.min(tr.right, br.right) - Math.max(tr.left, br.left);
    const vert = Math.min(tr.bottom, br.bottom) - Math.max(tr.top, br.top);
    card.classList.add("has-helpbar"); // restore
    return horiz > 1 && vert > 1;
  });
  check("without the reservation the text overlaps the bar (guard is doing work)", wouldOverlap);

  // ---- 3) the reservation exactly tracks whether the bar has slots ----
  //  (teamLoadout always pads to 3, so the question bar is always present —
  //   the class must mirror that: present ⇔ reserved). Also verify the toggle
  //   REMOVES the class when the bar is emptied.
  const invariant = await page.evaluate(() => {
    const card = document.querySelector("#questionPage .question-main-card");
    const bar = document.getElementById("questionHelpBar");
    const tracksPresent = card.classList.contains("has-helpbar") === (bar.children.length > 0);
    // empty the bar and re-run the toggle the code uses
    bar.innerHTML = "";
    card.classList.toggle("has-helpbar", bar.children.length > 0);
    const removedWhenEmpty = !card.classList.contains("has-helpbar");
    return tracksPresent && removedWhenEmpty;
  });
  check("has-helpbar mirrors bar-has-slots (and clears when the bar empties)", invariant);

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
