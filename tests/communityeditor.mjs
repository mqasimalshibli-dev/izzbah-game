// Community/custom category editor overhaul + private-category monetization:
//  • the random button on the category screen is an icon-only dice
//  • the maker/editor uses an admin-style question TABLE with add-modal + import
//    and supports MORE than 5 questions
//  • a public/private toggle; only public ones are the reward path
//  • a PRIVATE (personal/custom) category can be played ONLY with paid access —
//    the free first game does NOT unlock it.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8371;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1000, height: 950 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.IZZBAH.applyAuth(true); openNewGameCategories(); });
  await page.waitForTimeout(300);

  // ---- 1) the random button is a labeled dice pill (🎲 + «اختيار عشوائي») ----
  const dice = await page.evaluate(() => {
    const b = document.getElementById("randomCategories");
    return {
      exists: !!b,
      hasDie: b ? /🎲/.test(b.textContent) : false,
      hasLabel: b ? /عشوائي/.test(b.textContent) : false,
      aria: b ? (b.getAttribute("aria-label") || "") : "",
      pill: b ? b.classList.contains("rand-btn--pill") : false,
    };
  });
  check("the random button is a labeled dice pill (🎲 + «اختيار عشوائي»)", dice.exists && dice.hasDie && dice.hasLabel && dice.pill);
  check("the dice button keeps an accessible «اختيار عشوائي» label", /عشوائي/.test(dice.aria));

  // ---- 2) the community editor is an admin-style TABLE with a public/private toggle ----
  const editor = await page.evaluate(() => {
    state.editorTarget = "community";
    editCustomCategory(blankCustomCategory());
    const panel = document.getElementById("editorPanel");
    return {
      onEditor: document.getElementById("customEditor").classList.contains("active"),
      hasToggle: !!panel.querySelector(".ce-vis"),
      toggleOptions: [...panel.querySelectorAll(".ce-vis button")].map(b => b.textContent),
      hasTable: !!panel.querySelector(".ce-table"),
      hasAdd: [...panel.querySelectorAll(".ce-toolbar button")].some(b => /إضافة سؤال/.test(b.textContent)),
      hasImport: [...panel.querySelectorAll(".ce-toolbar button")].some(b => /استيراد/.test(b.textContent)),
      defaultPublic: state.editingCategory.visibility === "public",
    };
  });
  check("editing a community category opens the editor", editor.onEditor);
  check("the editor uses an admin-style question table", editor.hasTable);
  check("the editor has «إضافة سؤال» and «استيراد أسئلة» tools", editor.hasAdd && editor.hasImport);
  check("a public/private toggle is present, defaulting to public for the community maker",
    editor.hasToggle && editor.defaultPublic && editor.toggleOptions.some(t => /عامة/.test(t)) && editor.toggleOptions.some(t => /خاصة/.test(t)));

  // ---- 2b) the editor exposes a «وصف الفئة» field that feeds the category description ----
  const descField = await page.evaluate(() => {
    const panel = document.getElementById("editorPanel");
    const label = [...panel.querySelectorAll("label.field-label")].find(l => /وصف الفئة/.test(l.textContent));
    const box = label ? label.querySelector("textarea") : null;
    if (!box) return { has: false };
    box.value = "وصف كتبته بنفسي";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    return { has: true, catDesc: state.editingCategory.description, shown: categoryDescription(state.editingCategory) };
  });
  check("the editor exposes a «وصف الفئة» field", descField.has);
  check("typing a description saves it on the category and the (!) info uses it",
    descField.catDesc === "وصف كتبته بنفسي" && descField.shown === "وصف كتبته بنفسي");

  // ---- 3) it supports MORE than 5 questions (add via modal) ----
  const rowsBefore = await page.evaluate(() => document.querySelectorAll("#editorPanel .ce-table tbody tr").length);
  for (let i = 0; i < 4; i++) {
    await page.evaluate((n) => {
      openCeQuestion(-1);
      document.getElementById("ceQText").value = "سؤال إضافي " + n;
      document.getElementById("ceQAnswer").value = "إجابة " + n;
      document.getElementById("ceQPoints").value = String(600 + n * 100);
      saveCeQuestion();
    }, i);
    await page.waitForTimeout(60);
  }
  const rowsAfter = await page.evaluate(() => document.querySelectorAll("#editorPanel .ce-table tbody tr").length);
  check(`adding questions via the modal grows the table beyond 5 (${rowsBefore} → ${rowsAfter})`, rowsAfter > 5 && rowsAfter === rowsBefore + 4);

  // ---- 4) bulk import appends many questions at once ----
  const afterImport = await page.evaluate(() => {
    openImportModal("community");
    const lines = [];
    for (let i = 1; i <= 8; i++) lines.push(`سؤال مستورد ${i} | جواب ${i} | خطأ | خطأ٢ | خطأ٣ | ${i * 100}`);
    document.getElementById("importText").value = lines.join("\n");
    runImport();
    return document.querySelectorAll("#editorPanel .ce-table tbody tr").length;
  });
  check(`bulk import appends the parsed questions (now ${afterImport})`, afterImport === rowsAfter + 8);

  // ---- 5) PRIVATE categories need PAID access — the free game does NOT unlock ----
  const gate = await page.evaluate(() => {
    // A personal (private) custom category, selected and ready to play.
    const cat = {
      id: "custom-priv-1", name: "فئتي الخاصة", image: "", custom: true, community: false, published: false,
      visibility: "private",
      questions: [
        { points: 100, q: "س١", a: "ج١", image: "", answerImage: "" },
        { points: 200, q: "س٢", a: "ج٢", image: "", answerImage: "" },
      ],
    };
    state.customCategories = [cat];
    state.selected = new Set([cat.id]);
    state.editingSavedGameId = null;
    // No paid access at all, but the FREE game is still available.
    state.isAdmin = false; state.isPremium = false; state.codePremium = false;
    state.freeGamePlayed = false;
    state.gamesAllowed = 0; state.codeGamesAllowed = 0; state.gamesUsed = 0;
    const priv = selectionHasPrivate();
    startGame();
    const blocked = document.getElementById("plansModal").classList.contains("open") && !state.gameActive;
    return { priv, blocked };
  });
  check("a selected custom category is recognized as private", gate.priv);
  check("starting a game with a private category on the FREE game hits the paywall (not started)", gate.blocked);

  // ---- 6) …but WITH purchased games it plays ----
  const withPacks = await page.evaluate(() => {
    // close the paywall, grant purchased games, retry
    const m = document.getElementById("plansModal"); m.classList.remove("open");
    state.gamesAllowed = 5; // bought a pack
    startGame();
    return { started: state.gameActive, onGame: document.getElementById("game").classList.contains("active") };
  });
  check("with purchased games remaining, the private category plays", withPacks.started && withPacks.onGame);

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
