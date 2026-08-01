// Community categories hold no question media in memory.
//
// The second half of the iOS Safari crash. A community category is ONE
// Firestore doc with its questions — and their base64 images — inline, and an
// ADMIN loads the approved pool, their own submissions, AND every pending
// submission. Measured on the deployed build: 39 MB retained for 20 pending
// submissions alone, on top of the official catalogue. That is why the crash
// hit admin accounts specifically.
//
// Nothing in the pool list, the approval queue or the picker shows question
// pictures — only the cover and a count — so media is stripped at the state
// boundary (normalizeCommunityCategory, which all three apply* paths funnel
// through) and fetched back on demand.
//
// The dangerous half is EDITING: saving republishes the whole doc, so opening
// an editor over a stripped copy would wipe the author's own pictures. That is
// the main thing this file guards.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8385;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
await page.route("**/firebasejs/**", route => route.abort());
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));

const IMG = "data:image/jpeg;base64,QQQQ";
const mkCat = (id, approved) => ({
  id, name: "مجتمع " + id, image: "data:image/jpeg;base64,COVER", color: "#333",
  approved, community: true, custom: true, authorUid: "me", authorName: "أنا", votes: 0,
  questions: [0, 1, 2].map(i => ({ points: (i + 1) * 100, q: "س" + i, a: "ج" + i,
    image: i === 1 ? IMG : "", answerImage: i === 1 ? IMG : "" })),
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH && window.IZZBAH.applyCommunity, { timeout: 15000 });
  await page.waitForTimeout(300);

  // ---- 1) none of the three pools keeps question media ----
  const held = await page.evaluate(({ mk, IMG }) => {
    const make = (id, ap) => JSON.parse(mk.replace(/__ID__/g, id).replace(/__AP__/g, String(ap)));
    window.IZZBAH.applyCommunity([make("a1", true), make("a2", true)]);
    window.IZZBAH.applyPendingCommunity([make("p1", false), make("p2", false)]);
    window.IZZBAH.applyMyCommunity([make("m1", true)]);
    const count = list => (list || []).reduce((n, c) =>
      n + (c.questions || []).filter(q => q.image || q.answerImage).length, 0);
    return {
      approved: count(state.communityCategories), pending: count(state.pendingCommunity),
      mine: count(state.myCommunity),
      covers: (state.communityCategories || []).filter(c => c.image).length, // covers ARE kept
      lite: (state.pendingCommunity || []).every(c => c.__lite === true),
      counts: (state.communityCategories || []).every(c => (c.questions || []).length === 3),
    };
  }, { mk: JSON.stringify(mkCat("__ID__", true)).replace('"__AP__"', "true"), IMG });

  check("the approved pool holds no question media", held.approved === 0);
  check("the admin approval queue holds no question media", held.pending === 0);
  check("the member's own submissions hold no question media", held.mine === 0);
  check("covers are still kept (the list needs them)", held.covers === 2);
  check("question COUNTS are intact — only the pictures went", held.counts);
  check("community categories are marked __lite for hydration", held.lite);

  // ---- 2) editing must NOT open over a stripped copy ----
  // Saving republishes the whole doc, so this is the difference between an edit
  // and silently deleting the author's pictures.
  const edit = await page.evaluate(async ({ IMG }) => {
    let asked = null;
    window.IZZBAH.hydrateCommunityMedia = (ids) => {
      asked = ids.slice();
      const m = new Map();
      ids.forEach(id => m.set(id, [{ image: "", answerImage: "" },
                                    { image: IMG, answerImage: IMG },
                                    { image: "", answerImage: "" }]));
      return Promise.resolve(m);
    };
    const cat = state.myCommunity.find(c => c.id === "m1");
    editCustomCategory(cat);
    for (let i = 0; i < 60 && !(state.editingCategory && state.editingCategory.id === "m1"); i++)
      await new Promise(r => setTimeout(r, 100));
    const ed = state.editingCategory || {};
    return { asked, withMedia: (ed.questions || []).filter(q => q.image || q.answerImage).length,
             onQ2: (ed.questions || [])[1] ? (ed.questions[1].image === IMG) : false };
  }, { IMG });

  check("opening the editor fetches the category's media first",
    Array.isArray(edit.asked) && edit.asked.length === 1 && edit.asked[0] === "m1");
  check("the editor opens WITH the pictures (a save can't wipe them)", edit.withMedia === 1);
  check("...and they land on the right question", edit.onQ2);

  // ---- 3) if the media can't be fetched, refuse to open the editor ----
  const refused = await page.evaluate(async () => {
    // Leave the editor first — the previous case opened it, and "did the
    // refusal navigate?" is only meaningful from somewhere else.
    showScreen("customManager");
    await new Promise(r => setTimeout(r, 150));
    window.IZZBAH.hydrateCommunityMedia = () => Promise.reject(new Error("offline"));
    window.IZZBAH.applyMyCommunity([]);   // reset
    const fresh = { id: "m9", name: "أخرى", image: "", color: "#333", approved: true,
      community: true, custom: true, authorUid: "me", votes: 0,
      questions: [{ points: 100, q: "س", a: "ج", image: "data:image/jpeg;base64,X", answerImage: "" }] };
    window.IZZBAH.applyMyCommunity([fresh]);
    state.editingCategory = null;
    editCustomCategory(state.myCommunity.find(c => c.id === "m9"));
    await new Promise(r => setTimeout(r, 700));
    return { opened: !!(state.editingCategory && state.editingCategory.id === "m9"),
             screen: document.body.dataset.screen };
  });
  check("a failed media fetch does NOT open the editor over a stripped copy", !refused.opened);
  check("...and leaves the user where they were, not on the editor",
    refused.screen === "customManager");

  check("no uncaught JS errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 3));
} catch (e) {
  check(`threw: ${e && e.message}`, false);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
