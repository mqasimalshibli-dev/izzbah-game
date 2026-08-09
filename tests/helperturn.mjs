// Who may press a lifeline, and who gets paid for it.
//
// Two rules the owner asked to have pinned:
//   1. ×2 pays ONLY the team that armed it (already covered end-to-end by
//      tests/x2rule.mjs — this file checks the button-level gate for every
//      helper, not just ×2).
//   2. The team whose turn it is can activate its helpers.
//
// The second rule is not "only the active team", and that distinction is the
// whole point of this file. «سرقة الدور» and «حظر المساعدات» exist precisely to
// be played by a team that does NOT hold the turn — gating them on the active
// team would make stealing the turn a no-op. So each helper is asserted
// individually: the turn-holder can always play, and off-turn access is pinned
// per helper rather than assumed uniform.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8484;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

// phase: which screen the helper lives on.
// offTurn: may a team WITHOUT the turn press it?
const HELPERS = [
  { id: "doublePoints", label: "مضاعفة النقاط", phase: "board", offTurn: false },
  { id: "changeTurn", label: "سؤال عشوائي", phase: "board", offTurn: false },
  { id: "steal", label: "سرقة الدور", phase: "board", offTurn: true },
  { id: "banHelp", label: "حظر المساعدات", phase: "board", offTurn: true },
  { id: "fourChoices", label: "أربعة خيارات", phase: "question", offTurn: false },
  { id: "firstLetter", label: "كشف أول حرف", phase: "question", offTurn: false },
];

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.route("**/firebasejs/**", r => r.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => {
  try {
    localStorage.setItem("izzbah-legal-consent-v1", "1");
    localStorage.setItem("izzbah-coach-v1", JSON.stringify({ __all: 1 }));
  } catch (e) {}
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1300);

  await page.evaluate(() => {
    window.IZZBAH.applyAuth(true, "adm");
    window.IZZBAH.applyAdmin(true);
    window.IZZBAH.applyPublished([{
      id: "pub-help", name: "تاريخ", image: "", order: 1,
      questions: [100, 200, 300].map(pt => ({ points: pt, q: "سؤال " + pt, a: "جواب", image: "", answerImage: "" })),
    }]);
    // Drive the bar directly with a chosen loadout, so every helper can be
    // examined without replaying a whole game to hand it out.
    window.__setup = (loadout, activeTeam) => {
      state.teamCount = 2;
      state.teams = [0, 1].map(i => ({
        name: "فريق " + (i + 1), score: 0, image: "",
        helpers: loadout.slice(), helpUsed: {}, doubleArmed: false,
        stealArmed: false, helpBanned: false,
      }));
      state.activeTeam = activeTeam;
    };
    // Is `id` pressable on the BOARD bar belonging to `teamIndex`?
    window.__boardSlot = (loadout, activeTeam, teamIndex, id) => {
      window.__setup(loadout, activeTeam);
      const bar = document.createElement("div");
      document.body.appendChild(bar);
      renderTeamHelpBar(bar, teamIndex, "board");
      const idx = loadout.indexOf(id);
      // The BOARD bar wraps each slot in a cell so the lifeline can carry its
      // name underneath, so the buttons are no longer the bar's direct
      // children. Select the slots themselves — that is what is under test.
      const btn = bar.querySelectorAll(".qhelp-slot")[idx];
      const out = btn ? { present: true, disabled: btn.disabled, label: btn.getAttribute("aria-label") } : { present: false };
      bar.remove();
      return out;
    };
    // The QUESTION bar is only ever rendered for one team — whoever holds the
    // turn (see updateHelpBars). Report who that is, and whether the slot works.
    window.__questionSlot = (loadout, activeTeam, id) => {
      window.__setup(loadout, activeTeam);
      const cat = { id: "pub-help", name: "تاريخ" };
      const q = { q: "سؤال", a: "جواب", points: 100 };
      state.activeQuestion = { cat, q, key: "k", team: activeTeam };
      fillQuestionContent(cat, q);
      showScreen("questionPage", { keepQuestion: true });
      updateHelpBars();
      const bar = document.getElementById("questionHelpBar");
      const idx = loadout.indexOf(id);
      const btn = bar.children[idx];
      return {
        renderedForTeam: +bar.dataset.team === activeTeam || bar.dataset.team === undefined,
        disabled: btn ? btn.disabled : null,
        present: !!btn,
      };
    };
  });

  // ---- 1) the team WITH the turn can press every helper it holds ----
  for (const h of HELPERS) {
    const loadout = [h.id, "fourChoices", "firstLetter"].filter((v, i, a) => a.indexOf(v) === i).slice(0, 3);
    const r = h.phase === "board"
      ? await page.evaluate(([l, id]) => window.__boardSlot(l, 0, 0, id), [loadout, h.id])
      : await page.evaluate(([l, id]) => window.__questionSlot(l, 0, id), [loadout, h.id]);
    check(`the team whose turn it is can activate «${h.label}»`, r.present && r.disabled === false);
  }

  // ---- 2) off-turn access is exactly as designed, helper by helper ----
  for (const h of HELPERS.filter(x => x.phase === "board")) {
    const loadout = [h.id, "fourChoices", "firstLetter"].filter((v, i, a) => a.indexOf(v) === i).slice(0, 3);
    // team 1 holds the turn; look at TEAM 0's bar
    const r = await page.evaluate(([l, id]) => window.__boardSlot(l, 1, 0, id), [loadout, h.id]);
    if (h.offTurn) {
      check(`«${h.label}» stays available off-turn (that is what it is for)`, r.disabled === false);
    } else {
      check(`«${h.label}» cannot be activated by a team without the turn`, r.disabled === true);
    }
  }

  // ---- 3) the question bar belongs to the turn-holder only ----
  const qBar = await page.evaluate(() => {
    window.__setup(["fourChoices", "firstLetter", "doublePoints"], 1);
    const cat = { id: "pub-help", name: "تاريخ" };
    const q = { q: "سؤال", a: "جواب", points: 100 };
    state.activeQuestion = { cat, q, key: "k", team: 1 };
    fillQuestionContent(cat, q);
    showScreen("questionPage", { keepQuestion: true });
    updateHelpBars();
    // Team 1 is active. The single question bar must be team 1's — team 0 must
    // have no lifeline UI on this screen at all.
    const bars = [...document.querySelectorAll("#questionPage .qhelp-bar")];
    return { count: bars.length, activeTeam: state.activeTeam };
  });
  check("only one lifeline bar exists on the question screen", qBar.count === 1);

  // ---- 4) a banned team cannot press anything, turn or no turn ----
  const banned = await page.evaluate(() => {
    window.__setup(["doublePoints", "fourChoices", "firstLetter"], 0);
    state.teams[0].helpBanned = true;
    const bar = document.createElement("div");
    document.body.appendChild(bar);
    renderTeamHelpBar(bar, 0, "board");
    const out = [...bar.querySelectorAll(".qhelp-slot")].map(b => b.disabled);
    bar.remove();
    return out;
  });
  check("«حظر المساعدات» disables the whole bar for the banned team", banned.every(Boolean));

  // ---- 5) ×2 is consumed by the arming team however the question ends ----
  // x2rule.mjs pins the payout; this pins that the flag never survives the
  // question, which is what would let it pay out on a LATER question.
  const consumed = await page.evaluate(() => {
    window.__setup(["doublePoints", "fourChoices", "firstLetter"], 0);
    state.selected = new Set(["pub-help"]);
    state.gameActive = true;
    const cat = categoryById("pub-help");
    const q = (cat.questions || [])[0];
    const out = {};
    // (a) nobody answers
    state.teams[0].doubleArmed = true;
    state.activeQuestion = { cat, q, key: "pub-help-100", team: 0 };
    finishQuestion(null);
    out.afterNobody = state.teams[0].doubleArmed;
    // (b) the OTHER team answers
    state.activeTeam = 0;
    state.teams[0].doubleArmed = true;
    state.teams[0].score = 0; state.teams[1].score = 0;
    state.activeQuestion = { cat, q, key: "pub-help-200", team: 0 };
    finishQuestion(1);
    out.afterOther = state.teams[0].doubleArmed;
    out.otherPaid = state.teams[1].score;
    out.reward = questionReward(cat, q);
    return out;
  });
  check("×2 is consumed when nobody answers (cannot leak forward)", consumed.afterNobody === false);
  check("×2 is consumed when another team answers", consumed.afterOther === false);
  check(`…and that other team is paid the plain value (${consumed.otherPaid} = ${consumed.reward}, not doubled)`,
    consumed.otherPaid === consumed.reward);

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
