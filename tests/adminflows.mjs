// Open every admin panel and drive the content editor, watching for errors.
//
// The admin surface is the least-covered part of the app by tests, because it
// is gated behind state.isAdmin and most of it talks to Firestore. But the
// OPENING of each panel is pure client rendering, and that is where a
// null-deref on an empty collection or a stale element id actually shows up —
// exactly the kind of break an owner hits on a fresh device with no data yet.
//
// Deliberately offline: Firebase is aborted, so every panel renders its EMPTY
// state. That is the harshest case for render code and the one least likely to
// have been clicked through by hand.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8408;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  " + extra : ""}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
await page.route("**/firebasejs/**", r => r.abort());
page.on("pageerror", e => errs.push("JS: " + e.message));
page.on("console", m => {
  const t = m.text();
  if (m.type() === "error" && !/ERR_FAILED|firebasejs|net::|Failed to load resource/.test(t)) errs.push("console: " + t.slice(0, 140));
});
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(1500);

await page.evaluate(() => { state.isAdmin = true; if (window.IZZBAH.applyAdmin) window.IZZBAH.applyAdmin(true); });
await page.waitForTimeout(300);

// «Text» is deliberately excluded here and asserted separately below: it does
// not open a modal, it enters an in-place editing MODE — and offline it must
// refuse rather than half-enter it.
const SECTIONS = ["Content", "Dupes", "Dist", "QHealth", "Stats", "Featured",
                  "Announce", "Feedback", "Filters", "Subs", "Coach"];
const dialogs = [];
page.on("dialog", d => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });

// A section "opens" only if something that was HIDDEN becomes VISIBLE and
// carries real content. Asserting merely that no error was thrown would pass
// just as happily if the button did nothing at all — which is the shape of
// vacuous assertion that already bit this repo once (tests/helpbar.mjs
// compared two values that were both sitting on the same floor).
const visibleIds = () => page.evaluate(() => {
  const out = {};
  document.querySelectorAll("[id]").forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || el.hidden) return;
    if (!el.getBoundingClientRect().width) return;
    out[el.id] = (el.textContent || "").trim().length;
  });
  return out;
});

for (const s of SECTIONS) {
  const before = errs.length;
  await page.evaluate(() => {
    document.querySelectorAll(".modal.open").forEach(m => { m.classList.remove("open"); m.setAttribute("aria-hidden", "true"); });
    showScreen("menu");
  });
  await page.waitForTimeout(200);
  const vBefore = await visibleIds();

  const found = await page.evaluate(async (id) => {
    const sleep = ms => new Promise(z => setTimeout(z, ms));
    const entry = document.getElementById("adminEntry");
    if (entry) entry.click();
    await sleep(150);
    const btn = document.getElementById("adminChoice" + id);
    if (!btn) return false;
    btn.click();
    await sleep(500);
    return true;
  }, s);

  const vAfter = await visibleIds();
  // newly visible, and actually carrying text
  const fresh = Object.keys(vAfter).filter(k => !(k in vBefore) && vAfter[k] > 20);
  const newErrs = errs.slice(before);
  check(`«${s}» opens and renders`, found && fresh.length > 0 && newErrs.length === 0,
    found ? `${fresh.slice(0, 2).join(",") || "NOTHING NEW APPEARED"}${newErrs.length ? "  " + newErrs[0] : ""}` : "BUTTON MISSING");
}

// ---- «تحرير النصوص» must REFUSE offline, not half-enter ----
// It needs IZZBAH.saveTextConfig (Firebase + signed-in admin). Without it the
// only safe behaviour is to say so and stay out of the mode: silently entering
// would let an admin edit copy that could never be saved.
{
  const before = dialogs.length;
  await page.evaluate(async () => {
    document.querySelectorAll(".modal.open").forEach(m => { m.classList.remove("open"); m.setAttribute("aria-hidden", "true"); });
    showScreen("menu");
    await new Promise(z => setTimeout(z, 150));
    const e = document.getElementById("adminEntry"); if (e) e.click();
    await new Promise(z => setTimeout(z, 150));
    const b = document.getElementById("adminChoiceText"); if (b) b.click();
    await new Promise(z => setTimeout(z, 300));
  });
  const st = await page.evaluate(() => ({
    mode: document.body.classList.contains("text-edit-on"),
    bar: !!document.querySelector(".text-edit-bar"),
  }));
  check("«Text» refuses offline instead of half-entering the mode",
    !st.mode && !st.bar && dialogs.length > before,
    `mode=${st.mode} bar=${st.bar} alerted=${dialogs.length > before}`);
}

// ---- the content editor: open a category, edit a question, save ----
const edit = await page.evaluate(async () => {
  const sleep = ms => new Promise(z => setTimeout(z, ms));
  state.publishedCategories = (state.publishedCategories || []).filter(c => c.id !== "flowtest");
  state.publishedCategories.push({
    id: "flowtest", name: "اختبار", custom: true, __lite: true,
    questions: [{ points: 100, q: "سؤال", a: "جواب", image: "", answerImage: "" }],
  });
  if (window.IZZBAH.applyPublished) window.IZZBAH.applyPublished(state.publishedCategories);
  await sleep(200);
  if (typeof openAdminCategory === "function") openAdminCategory(categoryById("flowtest"));
  else if (typeof adminOpenCategory === "function") adminOpenCategory(categoryById("flowtest"));
  await sleep(300);
  const rows = document.querySelectorAll("#adminRows tr, #adminRows .admin-row").length;
  return { rows, hasHead: !!document.getElementById("adminCatHead") };
});
check("the content editor lists a category's questions", edit.rows >= 1, `(${edit.rows} rows)`);

// ---- an edit made WHILE media downloads must not be discarded ----
// selectAdminCategory clones the LITE category at once so the editor is usable,
// then re-clones when the pictures arrive. That re-clone replaces state.adminCat
// wholesale. Selecting is supposed to load fresh — but anything the admin types
// AFTER selecting, while the download is still in flight, must survive. On a
// big category that window is seconds.
{
  const r = await page.evaluate(async () => {
    const sleep = ms => new Promise(z => setTimeout(z, ms));
    if (typeof selectAdminCategory !== "function") return { skip: true };
    // Offline, hydrateOneCategory resolves FALSE and the re-clone never runs,
    // so the race is unreachable and the assertion would be vacuous — it passed
    // with the fix reverted until this stub was added. Stubbing the BRIDGE (not
    // the logic) makes the real hydrate -> re-clone path execute.
    window.IZZBAH.hydrateCategoryMedia = ids =>
      Promise.resolve(new Map(ids.map(id => [id, [{ image: "IMG", answerImage: "" }]])));
    selectAdminCategory("flowtest");          // sync clone lands, adminDirty=false
    // the admin now types, before hydration resolves
    state.adminCat.questions[0].q = "تعديل جارٍ";
    state.adminDirty = true;
    await sleep(800);                          // let the async re-clone land
    return { q: state.adminCat && state.adminCat.questions[0] && state.adminCat.questions[0].q };
  });
  check("an edit typed while media downloads is not discarded",
    r.skip || r.q === "تعديل جارٍ", `q=${JSON.stringify(r.q)}`);
}

check("no uncaught errors anywhere in the admin surface", errs.length === 0);
if (errs.length) errs.slice(0, 6).forEach(e => console.log("   " + e));

await browser.close(); server.kill();
process.exit(checks.every(Boolean) ? 0 : 1);
