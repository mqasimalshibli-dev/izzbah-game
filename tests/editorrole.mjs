// Content-editor role (editors/{uid}) — build .304.
//
// The owner wanted to hand a helper the ability to add and delete QUESTIONS and
// nothing else: no unlimited play, no emptying a category, no announcements,
// no credits, no appointing anyone. Until now there was exactly one flag —
// admins/{uid} — and it granted all of that at once.
//
// Two layers, and only one of them is real:
//   • firestore.rules is the boundary. An editor may write a category's
//     `questions` list and its /questions docs, bump meta/catalog, and nothing
//     else. Most of this file checks THAT, statically, because the deployed
//     rules are what actually stop a bad write.
//   • the UI locks are ergonomics. They keep an editor off screens that would
//     only reject them. Anyone with a console can un-hide a button, which is
//     exactly why the rules are checked separately here.
//
// The trap being pinned: isEditor() must NOT be reachable from any rule that
// says isAdmin(). A single misplaced `|| isEditor()` in, say, /codes or
// /entitlements would hand out money, and it would look like a one-word typo
// in review.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8396;
const checks = [];
const check = (n, ok, note) => {
  checks.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${note ? `  — ${note}` : ""}`);
};

const html = readFileSync(join(ROOT, "index.html"), "utf8");
const rules = readFileSync(join(ROOT, "firestore.rules"), "utf8");
const fns = readFileSync(join(ROOT, "functions/index.js"), "utf8");

// ── 1) the rules: the registry ──────────────────────────────────────────────
check("there is an isEditor() helper keyed on editors/{uid}",
  /function isEditor\(\)[\s\S]{0,200}?documents\/editors\/\$\(request\.auth\.uid\)/.test(rules));
// A single get() stays open, so any account can read its OWN role at sign-in…
check("editors/{uid} — one doc is gettable by any signed-in user",
  /match \/editors\/\{uid\} \{[\s\S]{0,240}?allow get: if isSignedIn\(\);/.test(rules));
// …but ENUMERATING the collection is the owner's «المحرّرون» panel only. An
// open list would hand every signed-in user the set of staff uids.
check("...but LISTING it is admin-only",
  /match \/editors\/\{uid\} \{[\s\S]{0,280}?allow list: if isAdmin\(\);/.test(rules));
check("...and `allow read` was not left behind as a wildcard",
  !/match \/editors\/\{uid\} \{[\s\S]{0,280}?allow read:/.test(rules));
// The one that matters most: an editor must never be able to appoint anyone,
// least of all themselves, and never touch the admin registry.
check("...and it is WRITABLE ONLY BY AN ADMIN — an editor cannot appoint an editor",
  /match \/editors\/\{uid\} \{[\s\S]{0,320}?allow write: if isAdmin\(\);/.test(rules));

// ── 2) the rules: isEditor() must appear ONLY where it is meant to ──────────
// Slice the file into top-level match blocks and record which ones mention it.
// COMMENTS ARE STRIPPED FIRST. Without that, the prose above match /editors/
// explaining that isEditor() stays away from admins/{uid} lands inside the
// admins block and reports the exact leak it is warning about. (It did.)
const rulesCode = rules.split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
const blocks = [];
{
  const re = /^    match (\/[^\s]+) \{$/gm;
  let m, prev = null;
  while ((m = re.exec(rulesCode))) {
    if (prev) blocks.push({ path: prev.path, body: rulesCode.slice(prev.at, m.index) });
    prev = { path: m[1], at: m.index };
  }
  if (prev) blocks.push({ path: prev.path, body: rulesCode.slice(prev.at) });
}
const touched = blocks.filter(b => /isEditor\(\)/.test(b.body)).map(b => b.path).sort();
/* Exactly three: the categories block (which carries the /questions
   subcollection inside it), the catalogue rev marker, and the audit log.
   NOT /editors/{uid} itself — that block grants on isAdmin(), which is the
   point: the registry of editors is written by the owner alone.
   ⚠️ /logs/{logId} was added deliberately in .321 and this guard is what forced
   the decision. An editor must be able to CREATE its own audit entry, or an
   editor's publishes would be invisible in the log — and editors writing is
   the main reason the log exists. It is create-only, the uid is pinned to the
   caller so nobody can log as someone else, the shape is closed with hasOnly,
   and reading stays admin-only because the log carries staff emails.
   Do NOT widen this list again without the same argument. */
const EXPECTED = ["/categories/{catId}", "/logs/{logId}", "/meta/{doc}"].sort();
check(`isEditor() grants inside exactly three collections`,
  JSON.stringify(touched) === JSON.stringify(EXPECTED),
  touched.join(", ") || "none");
// Named individually so a failure says WHICH one leaked.
["/codes/{codeId}", "/entitlements/{uid}", "/announcements/{id}", "/sales/{id}",
 "/admins/{uid}", "/usage/{uid}", "/community/{catId}", "/inbox/{uid}/msgs/{msgId}",
 "/config/{doc}", "/stats/{doc}"].forEach(path => {
  const b = blocks.find(x => x.path === path);
  check(`${path} stays admin-only`, !!b && !/isEditor\(\)/.test(b.body));
});

// ── 3) the rules: what an editor may do to a category ───────────────────────
const catBlock = (blocks.find(b => b.path === "/categories/{catId}") || {}).body || "";
// Everything before the nested `match /questions/` is the parent-doc rule.
const parentRule = catBlock.split("match /questions/")[0];
const qRule = catBlock.slice(catBlock.indexOf("match /questions/"));
check("an editor may UPDATE a category, never create or delete one",
  /allow update: if isEditor\(\)/.test(parentRule)
  && !/allow create: if isEditor/.test(parentRule)
  && !/allow delete: if isEditor/.test(parentRule));
// The identity pins: renaming or re-covering a category is not "add a question".
["name", "image"].forEach(f => {
  check(`...and cannot change the category's ${f}`,
    new RegExp(`request\\.resource\\.data\\.${f} == resource\\.data\\.${f}`).test(parentRule));
});
["color", "order"].forEach(f => {
  check(`...nor its ${f} (compared with a default, since publish uses set())`,
    new RegExp(`get\\('${f}', ?[^)]+\\) == resource\\.data\\.get\\('${f}'`).test(parentRule));
});
// The owner's line: "he cant delete all the question in a category".
check("an editor can never EMPTY a category",
  /request\.resource\.data\.questions\.size\(\) > 0/.test(parentRule));
check("...and can remove at most 5 questions in one publish",
  /questions\.size\(\) >= resource\.data\.questions\.size\(\) - 5/.test(parentRule));
// Delete on the subcollection is REQUIRED: docs are q0..qN by position, so
// removing one rewrites the tail and deletes the last id.
check("an editor may write and delete individual question docs",
  /allow write: if isEditor\(\)/.test(qRule) && /allow delete: if isEditor\(\);/.test(qRule));
check("...still field-locked to the same six keys as the admin path",
  /allow write: if isEditor\(\)[\s\S]{0,120}?hasOnly\(\['points', 'q', 'a', 'image', 'answerImage', 'idx'\]\)/.test(qRule));
// Without the rev bump a publish saves and then reaches nobody — and
// bumpCatalogRev() swallows its own errors, so it would fail silently.
check("an editor may bump meta/catalog, or their work would never ship",
  /allow write: if \(isAdmin\(\) \|\| isEditor\(\)\)[\s\S]{0,140}?hasOnly\(\['rev', 'updatedAt'\]\)/
    .test((blocks.find(b => b.path === "/meta/{doc}") || {}).body || ""));
// meta/index is derived data rebuilt by a maintenance button the editor cannot
// see; it must stay admin-only.
check("meta/index stays admin-write", /match \/meta\/index \{[\s\S]{0,300}?allow write: if isAdmin\(\)/.test(rules));

// ── 4) the Cloud Function: media upload ─────────────────────────────────────
// The owner said "he can upload media". mintUploadUrl gated on admins/{uid}
// only, so without this an editor could add text and pasted images and no clip.
check("mintUploadUrl accepts editors/{uid} as well as admins/{uid}",
  /collection\("editors"\)\.doc\(uid\)\.get\(\)/.test(fns)
  && /!adminDoc\.exists && !editorDoc\.exists/.test(fns));

// ── 5) the client: the role is SEPARATE from admin ──────────────────────────
check("state carries its own isEditor flag", /\n\s*isEditor: false,/.test(html));
// The whole point of a separate flag: every existing `state.isAdmin` check
// (free play, community approval, the money panels) must keep saying no.
{
  // Cut the function body out by hand. A lazy regex was tried and silently
  // ran PAST the closing brace into applyAdmin — which does assign
  // state.isAdmin — so the check failed while the code was correct.
  const at = html.indexOf("applyEditor = function (isEditor) {");
  const body = at < 0 ? "" : html.slice(at, html.indexOf("\n    };", at));
  check("applyEditor is present", !!body);
  check("...and never sets state.isAdmin", !!body && !/state\.isAdmin\s*=/.test(body));
  check("...and never grants games or premium",
    !!body && !/state\.(isPremium|gamesAllowed|codeGamesAllowed)\s*=/.test(body));
}
{
  /* Every place the editor role grants ANYTHING, counted, so a new grant has
     to be added here deliberately rather than slipping in. Comment lines are
     dropped first — the explanation beside the media-upload gate names the
     function and would otherwise inflate the count. */
  const code = html.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const grants = (code.match(/canEditContent\(\)/g) || []).length;
  check(`the editor role grants exactly five things (${grants} canEditContent uses)`,
    grants === 6, "5 gates + the definition");
}
// Each of the five, named, so a failure above says which one moved.
check("gate 1 — the R2 media upload path", /if \(canEditContent\(\) && window\.firebase/.test(html));
check("gate 2 — opening the content panel", /function openAdminPanel\(\) \{\s*\n\s*if \(!canEditContent\(\)\) return;/.test(html));
check("gate 3 — opening the panel chooser", /function openAdminChoice\(\) \{\s*\n\s*if \(!canEditContent\(\)\) return;/.test(html));
check("gates 4+5 — the entry button, from either role",
  (html.match(/btn\.style\.display = canEditContent\(\) \? "" : "none";/g) || []).length === 2);

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH && typeof window.IZZBAH.applyEditor === "function", { timeout: 15000 });

  // ── 6) no free play ───────────────────────────────────────────────────────
  // Firebase is aborted here, so the roles are set directly — which is also
  // the honest model of what the client knows: two booleans from two docs.
  // Read it off the DOM rather than a state bridge: #gameCountNum is the badge
  // the player actually sees, and it is «∞» for an admin and a number for
  // everyone else. #playBalance is hidden outright for an admin, so its
  // visibility is a second, independent read of the same fact.
  const play = await page.evaluate(() => {
    const num = () => (document.getElementById("gameCountNum") || {}).textContent || "";
    const balShown = () => {
      const el = document.getElementById("playBalance");
      return !!el && getComputedStyle(el).display !== "none";
    };
    const out = {};
    window.IZZBAH.applyAdmin(false);
    window.IZZBAH.applyEditor(true);
    out.editorCount = num();
    out.editorBalanceShown = balShown();
    window.IZZBAH.applyAdmin(true);
    out.adminCount = num();
    out.adminBalanceShown = balShown();
    window.IZZBAH.applyAdmin(false);
    window.IZZBAH.applyEditor(false);
    return out;
  });
  check("an editor does NOT get unlimited play", play.editorCount !== "∞",
    `game count badge reads "${play.editorCount}"`);
  check("...and still sees their own credit balance, like any player",
    play.editorBalanceShown);
  check("...while an admin still plays unlimited", play.adminCount === "∞");
  check("...and has no balance to show", !play.adminBalanceShown);

  // ── 7) the panel an editor sees ───────────────────────────────────────────
  const ui = await page.evaluate(() => {
    const vis = (el) => !!el && !el.hidden && getComputedStyle(el).display !== "none";
    window.IZZBAH.applyEditor(true);
    document.getElementById("adminPanel").classList.add("active");
    window.IZZBAH_TEST.applyEditorLocks();
    const locked = window.IZZBAH_TEST.EDITOR_LOCKED_IDS;
    const stillVisible = locked.filter(id => vis(document.getElementById(id)));
    const choiceShown = Array.prototype.filter
      .call(document.querySelectorAll(".admin-choice-btn"), b => !b.hidden)
      .map(b => b.id);
    const groupsShown = Array.prototype.filter
      .call(document.querySelectorAll(".admin-group"), g => !g.hidden)
      .map(g => g.dataset.group);
    const out = {
      entryShown: vis(document.getElementById("adminEntry")),
      stillVisible, choiceShown, groupsShown,
      addQuestion: vis(document.getElementById("adminAddQuestion")),
      publish: !!document.getElementById("adminPublishBtn"),
      maint: vis(document.querySelector(".af-group-maint")),
      selCol: vis(document.querySelector(".admin-table .col-sel")),
      bodyClass: document.body.classList.contains("is-editor-only"),
      lockedCount: locked.length,
    };
    // …and everything must come back for the owner.
    window.IZZBAH.applyEditor(false);
    window.IZZBAH.applyAdmin(true);
    out.adminSeesMaint = vis(document.querySelector(".af-group-maint"));
    out.adminSeesAll = window.IZZBAH_TEST.EDITOR_LOCKED_IDS
      .filter(id => id !== "adminDeleteSelected" && id !== "adminReseedBuiltin")
      .every(id => vis(document.getElementById(id)));
    out.adminChoices = Array.prototype.filter
      .call(document.querySelectorAll(".admin-choice-btn"), b => !b.hidden).length;
    window.IZZBAH.applyAdmin(false);
    return out;
  });

  check("the admin entry button appears for an editor", ui.entryShown);
  check(`all ${ui.lockedCount} owner-only buttons are hidden`, ui.stillVisible.length === 0,
    ui.stillVisible.join(", ") || "none visible");
  check("the صيانة strip is gone (its label would otherwise sit alone)", !ui.maint);
  check("the select column is gone — it only feeds «حذف المحدد»", !ui.selCol);
  check("«إضافة سؤال جديد» is still there", ui.addQuestion);
  check("the body carries the is-editor-only class", ui.bodyClass);
  check("the panel offers ONLY «إدارة المحتوى»",
    JSON.stringify(ui.choiceShown) === JSON.stringify(["adminChoiceContent"]),
    ui.choiceShown.join(", "));
  check("...and the empty groups are hidden with it",
    JSON.stringify(ui.groupsShown) === JSON.stringify(["content"]), ui.groupsShown.join(", "));
  // A lock that cannot be lifted would quietly cost the owner their own panel.
  check("the owner's buttons all come back", ui.adminSeesAll);
  check("...including the صيانة strip", ui.adminSeesMaint);
  check("...and every panel choice", ui.adminChoices > 8, String(ui.adminChoices));

  // ── 8) a re-render must not undo the locks ────────────────────────────────
  // The category head and the question table are rebuilt on every keystroke,
  // sort and delete. This is why those locks are CSS on a body class rather
  // than per-node JS — a redraw cannot delete a stylesheet rule.
  const afterRender = await page.evaluate(() => {
    window.IZZBAH.applyEditor(true);
    const head = document.getElementById("adminCatHead");
    head.innerHTML = '<div class="ac-row ac-row-id"><input class="ac-name"><label class="field-label">اللون</label></div>'
      + '<div class="ac-row ac-row-state"><button class="ac-hide">إخفاء</button></div>';
    const vis = (s) => { const el = document.querySelector(s); return !!el && getComputedStyle(el).display !== "none"; };
    const out = { name: vis(".admin-cathead .ac-name"), state: vis(".admin-cathead .ac-row-state") };
    window.IZZBAH.applyEditor(false);
    return out;
  });
  check("a rebuilt category head is still locked (name)", !afterRender.name);
  check("...and its state row (إخفاء / حذف الفئة) too", !afterRender.state);

  // ── 9) «المحرّرون» — appointing one from inside the app ───────────────────
  // The owner should not have to open the Firebase console to hand a friend
  // question-authoring, and should not have to know their uid to do it.
  const panel = await page.evaluate(() => {
    const rows = (sel) => Array.prototype.map.call(
      document.querySelectorAll(sel + " .prem-row"),
      r => ({
        id: r.querySelector(".prem-row-id").textContent,
        byUid: r.querySelector(".prem-row-id").classList.contains("prem-row-id-uid"),
        action: (r.querySelector("button") || {}).textContent || "",
      }));
    const search = document.getElementById("editorsSearch");
    const seed = () => window.IZZBAH_TEST.renderEditorsPanel({
      editors: [{ uid: "EDITORUID000000000000000001", email: "kholoud@example.com" }],
      // One player named by their own usage stamp, one only by a past sale,
      // and one nameless — the three cases the panel has to cope with.
      usage: {
        "PLAYERUID00000000000000000A": { email: "salim@example.com", granted: 5, used: 1 },
        "PLAYERUID00000000000000000B": { granted: 2, used: 0 },
        "PLAYERUID00000000000000000C": { granted: 0, used: 0 },
      },
      sales: [{ uid: "PLAYERUID00000000000000000B", email: "maryam@example.com" }],
      orders: [],
    });

    const out = {};
    seed();
    out.current = rows("#editorsList");
    out.emptySearch = (document.getElementById("editorsCandidates").textContent || "").trim();

    search.value = "salim"; search.dispatchEvent(new Event("input"));
    out.byEmail = rows("#editorsCandidates");

    // Named from a SALE, not from their own usage stamp.
    search.value = "maryam"; search.dispatchEvent(new Event("input"));
    out.bySale = rows("#editorsCandidates");

    // Someone already an editor must not be offered again.
    search.value = "kholoud"; search.dispatchEvent(new Event("input"));
    out.alreadyEditor = rows("#editorsCandidates");
    out.alreadyEditorText = (document.getElementById("editorsCandidates").textContent || "").trim();

    // The escape hatch: a raw uid pasted from the console.
    search.value = "ZZUNKNOWNUID0000000000000001"; search.dispatchEvent(new Event("input"));
    out.rawUidOffer = !!document.querySelector("#editorsCandidates .ed-grant-raw");

    // …which must NOT appear for an ordinary miss.
    search.value = "nobody@nowhere"; search.dispatchEvent(new Event("input"));
    out.missOffer = !!document.querySelector("#editorsCandidates .ed-grant-raw");
    out.missText = (document.getElementById("editorsCandidates").textContent || "").trim();

    // And an empty registry says so rather than rendering nothing.
    window.IZZBAH_TEST.renderEditorsPanel({ editors: [], usage: {}, sales: [], orders: [] });
    out.emptyList = (document.getElementById("editorsList").textContent || "").trim();
    return out;
  });

  check("the current editors are listed, named by email",
    panel.current.length === 1 && panel.current[0].id === "kholoud@example.com" && !panel.current[0].byUid);
  check("...with a remove action", panel.current[0] && panel.current[0].action === "إزالة");
  check("an empty registry says so", /لا يوجد محرّرون/.test(panel.emptyList));
  check("the candidate list waits for a search term", /اكتب جزءاً من البريد/.test(panel.emptySearch));
  check("a player is found by email and offered the role",
    panel.byEmail.length === 1 && panel.byEmail[0].id === "salim@example.com"
    && panel.byEmail[0].action === "اجعله محرراً");
  check("...including one named only by a past SALE",
    panel.bySale.length === 1 && panel.bySale[0].id === "maryam@example.com");
  check("someone who is ALREADY an editor is not offered again",
    panel.alreadyEditor.length === 0 && /لا يوجد لاعب مطابق/.test(panel.alreadyEditorText));
  check("a pasted raw uid gets an explicit «add this id» escape hatch", panel.rawUidOffer);
  check("...which does NOT appear for an ordinary miss", !panel.missOffer);
  check("...and the miss explains they must sign in once first",
    /سجّل دخوله باللعبة/.test(panel.missText));

  // Admin-only, and by two independent means: the rules refuse the write, and
  // the panel is not in the editor's allow-list so its whole group disappears.
  check("«المحرّرون» is NOT offered to an editor",
    !html.includes('EDITOR_CHOICE_IDS = ["adminChoiceContent", "adminChoiceEditors"]')
    && /EDITOR_CHOICE_IDS = \["adminChoiceContent"\]/.test(html));
  check("...and openEditorsAdmin refuses a non-admin outright",
    /function openEditorsAdmin\(\) \{\s*\n\s*if \(!state\.isAdmin\) return;/.test(html));
  const groupHidden = await page.evaluate(() => {
    window.IZZBAH.applyEditor(true);
    const g = document.querySelector('.admin-group[data-group="access"]');
    const hidden = !!g && g.hidden;
    window.IZZBAH.applyEditor(false);
    window.IZZBAH.applyAdmin(true);
    const backAgain = !!g && !g.hidden;
    window.IZZBAH.applyAdmin(false);
    return { hidden, backAgain };
  });
  check("the whole «الصلاحيات» group is hidden from an editor", groupHidden.hidden);
  check("...and comes back for the owner", groupHidden.backAgain);
  // The bridges are gated locally too — not security (the rules are), but it
  // turns a confusing permission error into a clear one.
  check("listEditors and setEditor check cloudIsAdmin before the round-trip",
    /IZZBAH\.listEditors = function \(\) \{\s*\n\s*if \(!cloudIsAdmin\)/.test(html)
    && /IZZBAH\.setEditor = function \(uid, on, email\) \{[\s\S]{0,80}?if \(!cloudIsAdmin\)/.test(html));

  check("no page errors", errs.length === 0);
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
