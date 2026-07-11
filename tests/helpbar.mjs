// Regression: a long question on the question screen must not render BEHIND any
// of the overlaid controls — the lifeline (helper) bar on the right, the reveal
// ("continue") button at the bottom, or the category/points badges at the top.
// The card reserves horizontal room for the bar and bounds the text to the safe
// vertical area (it scrolls within its own box only in the extreme case).
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
const errs = [];

// Drive the question screen with an extreme-length question and return the
// overlap (in px) between the question text and each overlaid control.
async function probe(page, helpers, repeat) {
  return page.evaluate(({ helpers, repeat }) => {
    state.teamCount = 2;
    state.teams = [
      { name: "أ", helpers: helpers.slice(), helpUsed: {}, score: 0, helpBanned: false, doubleArmed: false },
      { name: "ب", helpers: helpers.slice(), helpUsed: {}, score: 0, helpBanned: false, doubleArmed: false },
    ];
    state.activeTeam = 0;
    const cat = { id: "pub-x", name: "تاريخ" };
    const q = { q: "ما هو السؤال ".repeat(repeat) + "؟", a: "جواب", points: 100 };
    state.activeQuestion = { cat, q, key: "t", team: 0 };
    fillQuestionContent(cat, q);
    showScreen("questionPage", { keepQuestion: true });
    renderTeamHelpBar(document.getElementById("questionHelpBar"), 0, "question");
    const R = id => document.getElementById(id).getBoundingClientRect();
    const t = R("modalQuestion");
    const overlap = r => {
      const h = Math.min(t.right, r.right) - Math.max(t.left, r.left);
      const v = Math.min(t.bottom, r.bottom) - Math.max(t.top, r.top);
      return (h > 1 && v > 1) ? Math.round(Math.min(h, v)) : 0;
    };
    const card = document.querySelector("#questionPage .question-main-card");
    return {
      hasClass: card.classList.contains("has-helpbar"),
      slots: document.getElementById("questionHelpBar").children.length,
      bar: overlap(R("questionHelpBar")),
      reveal: overlap(R("revealAnswer")),
      category: overlap(R("modalCategory")),
      points: overlap(R("modalPoints")),
    };
  }, { helpers, repeat });
}

try {
  // ---- phone-landscape ----
  const phone = await browser.newPage({ viewport: { width: 820, height: 460 } });
  await phone.route("**/firebasejs/**", r => r.abort());
  phone.on("pageerror", e => errs.push(e.message));
  await phone.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
  await phone.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await phone.waitForTimeout(1400);

  const p = await probe(phone, ["fourChoices", "firstLetter", "doublePoints"], 28);
  check("the lifeline bar renders with slots and the card reserves room", p.slots >= 1 && p.hasClass);
  check(`phone: long question clears the lifeline bar (${p.bar}px)`, p.bar === 0);
  check(`phone: long question clears the reveal button (${p.reveal}px)`, p.reveal === 0);
  check(`phone: long question clears the top badges (${p.category}/${p.points}px)`, p.category === 0 && p.points === 0);

  // proof the guard works: without the horizontal reservation the text overlaps the bar
  const wouldOverlap = await phone.evaluate(() => {
    const card = document.querySelector("#questionPage .question-main-card");
    card.classList.remove("has-helpbar");
    const t = document.getElementById("modalQuestion").getBoundingClientRect();
    const b = document.getElementById("questionHelpBar").getBoundingClientRect();
    const h = Math.min(t.right, b.right) - Math.max(t.left, b.left);
    const v = Math.min(t.bottom, b.bottom) - Math.max(t.top, b.top);
    card.classList.add("has-helpbar");
    return h > 1 && v > 1;
  });
  check("without the reservation the text overlaps the bar (guard is doing work)", wouldOverlap);
  await phone.close();

  // ---- iPad-landscape (where the card isn't height-locked the same way) ----
  const ipad = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  await ipad.route("**/firebasejs/**", r => r.abort());
  ipad.on("pageerror", e => errs.push(e.message));
  await ipad.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
  await ipad.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await ipad.waitForTimeout(1400);

  const i = await probe(ipad, ["fourChoices", "firstLetter", "doublePoints"], 60); // extreme length
  check(`iPad: extreme question clears the reveal button (${i.reveal}px)`, i.reveal === 0);
  check(`iPad: extreme question clears the bar + badges (${i.bar}/${i.category}/${i.points}px)`,
    i.bar === 0 && i.category === 0 && i.points === 0);
  await ipad.close();

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
