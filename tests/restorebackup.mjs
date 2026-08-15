// «استعادة من نسخة» — replaying a backup file over the live catalogue.
//
// This is the most destructive button in the app, so the test is about what it
// REFUSES to do. The rules it must never break:
//   • only ever ADDS — never deletes a category or question, never rewrites the
//     text of one that exists;
//   • matches questions on CONTENT, never on index — question docs are keyed
//     positionally (q0..qN), so an index match restores over an unrelated
//     question;
//   • never writes an image from the file. Every backup ever exported is
//     media-LITE (build .209 strips question images at the state boundary), so
//     trusting it would blank the catalogue — the .268 disaster, replayed.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8412;
const checks = [];
const check = (n, ok, note) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${note ? `  — ${note}` : ""}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.route("**/firebasejs/**", r => r.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH_TEST && window.IZZBAH_TEST.restorePlan, { timeout: 15000 });

  const r = await page.evaluate(() => {
    const plan = window.IZZBAH_TEST.restorePlan;
    const q = (points, text, ans, extra) => Object.assign({ points, q: text, a: ans, image: "", answerImage: "" }, extra || {});
    const backup = (cats) => ({ kind: "izzbah-catalog-backup", version: 1, build: "test", exportedAt: "2026-08-01T00:00:00.000Z", published: cats });

    const live = [{
      id: "cat-a", name: "فئة أ",
      questions: [q(100, "سؤال ١", "جواب ١"), q(200, "سؤال ٢", "جواب ٢")],
    }];

    return {
      // A question in the file that is gone live gets added back.
      missing: plan(backup([{ id: "cat-a", name: "فئة أ", questions: [
        q(100, "سؤال ١", "جواب ١"), q(200, "سؤال ٢", "جواب ٢"), q(300, "سؤال ٣", "جواب ٣")] }]), live),
      // Nothing missing → nothing to do.
      noop: plan(backup([{ id: "cat-a", name: "فئة أ", questions: [q(100, "سؤال ١", "جواب ١"), q(200, "سؤال ٢", "جواب ٢")] }]), live),
      // Live has moved on: an extra question the file predates is NOT removed,
      // and the plan proposes no deletions at all.
      liveAhead: plan(backup([{ id: "cat-a", name: "فئة أ", questions: [q(100, "سؤال ١", "جواب ١")] }]),
        [{ id: "cat-a", name: "فئة أ", questions: [q(100, "سؤال ١", "جواب ١"), q(500, "سؤال جديد", "جواب جديد")] }]),
      // Same content at a DIFFERENT index must not be treated as missing —
      // question docs are positional, so an index match is a data-loss bug.
      reordered: plan(backup([{ id: "cat-a", name: "فئة أ", questions: [q(200, "سؤال ٢", "جواب ٢"), q(100, "سؤال ١", "جواب ١")] }]), live),
      // Whitespace differences are not new questions.
      whitespace: plan(backup([{ id: "cat-a", name: "فئة أ", questions: [q(100, "  سؤال   ١ ", "جواب ١")] }]), live),
      // Same text at a different TIER is a different board cell, so it is new.
      otherTier: plan(backup([{ id: "cat-a", name: "فئة أ", questions: [q(400, "سؤال ١", "جواب ١")] }]), live),
      // A whole category that no longer exists comes back.
      goneCat: plan(backup([{ id: "cat-z", name: "فئة مفقودة", questions: [q(100, "س", "ج"), q(200, "س٢", "ج٢")] }]), live),
      // A category live but absent from the file is untouched and unlisted.
      extraLive: plan(backup([]), live),
      // Duplicates inside the file are collapsed.
      dupeInFile: plan(backup([{ id: "cat-a", name: "فئة أ", questions: [q(300, "س٣", "ج٣"), q(300, "س٣", "ج٣")] }]), live),
      // Blank rows in the file are not restored as questions.
      blanks: plan(backup([{ id: "cat-a", name: "فئة أ", questions: [q(300, "", ""), q(400, "س٤", "ج٤")] }]), live),
      // Rejections.
      notBackup: plan({ kind: "something-else", published: [] }, live),
      garbage: plan({ hello: 1 }, live),
      nullish: plan(null, live),
      // The media flag: absent (old file) must read as false, never true.
      flagAbsent: plan(backup([{ id: "cat-a", questions: [q(300, "س", "ج")] }]), live).meta.mediaIncluded,
      flagTrue: plan(Object.assign(backup([{ id: "cat-a", questions: [q(300, "س", "ج")] }]), { mediaIncluded: true }), live).meta.mediaIncluded,
    };
  });

  check("a question missing from live is planned for restore", r.missing.ok && r.missing.totals.questions === 1, `${r.missing.totals.questions}`);
  check("...and it is the right one", r.missing.cats[0] && r.missing.cats[0].questions[0].q === "سؤال ٣");
  check("a backup that matches live proposes nothing", r.noop.ok && r.noop.totals.questions === 0);
  check("a live question absent from the backup is NOT deleted",
    r.liveAhead.totals.questions === 0 && !JSON.stringify(r.liveAhead).includes("سؤال جديد"));
  check("REORDERED questions are matched by content, not index", r.reordered.totals.questions === 0, `${r.reordered.totals.questions}`);
  check("whitespace-only differences are not new questions", r.whitespace.totals.questions === 0);
  check("the same text at another TIER is a genuinely new question", r.otherTier.totals.questions === 1);
  check("a category missing from live is restored whole", r.goneCat.newCats.length === 1 && r.goneCat.newCats[0].add === 2);
  check("a live category absent from the file is left alone", r.extraLive.totals.cats === 0 && r.extraLive.totals.questions === 0);
  check("duplicates inside the file are collapsed", r.dupeInFile.totals.questions === 1, `${r.dupeInFile.totals.questions}`);
  check("blank rows in the file are not restored", r.blanks.totals.questions === 1, `${r.blanks.totals.questions}`);
  check("a file that is not an izzbah backup is refused", !r.notBackup.ok && !!r.notBackup.error);
  check("garbage is refused", !r.garbage.ok);
  check("null is refused without throwing", !r.nullish.ok);
  check("a backup with NO media flag is treated as media-less", r.flagAbsent === false);
  check("...and only an explicit true reads as true", r.flagTrue === true);

  // The export must stamp itself media-less, or a future restore could believe
  // the empty images in it are real and blank the catalogue.
  const exported = await page.evaluate(() => {
    const b = window.IZZBAH_TEST.buildCatalogBackup();
    return { kind: b.kind, media: b.mediaIncluded, hasPublished: Array.isArray(b.published) };
  });
  check("the export stamps mediaIncluded:false", exported.media === false, String(exported.media));
  check("...and still carries its kind + categories", exported.kind === "izzbah-catalog-backup" && exported.hasPublished);

  // Editor lock: the button is listed, and the handler re-checks isAdmin rather
  // than trusting a hidden button.
  const locked = await page.evaluate(() => ({
    listed: (window.IZZBAH_TEST.EDITOR_LOCKED_IDS || []).includes("adminRestoreAll"),
    exists: !!document.getElementById("adminRestoreAll"),
  }));
  check("«استعادة من نسخة» is locked away from content editors", locked.listed && locked.exists);

  // An editor pressing it anyway (e.g. via devtools) is refused by the handler.
  const refused = await page.evaluate(async () => {
    const before = state.isAdmin;
    state.isAdmin = false; state.isEditor = true;
    let opened = false;
    const inp = document.getElementById("adminRestoreFile");
    const orig = inp.click.bind(inp);
    inp.click = () => { opened = true; };
    document.getElementById("adminRestoreAll").click();
    inp.click = orig;
    state.isAdmin = before; state.isEditor = false;
    return opened;
  });
  check("...and the handler refuses even if the button is reached directly", refused === false);

  // ---- the modal: a preview must write NOTHING ---------------------------
  const ui = await page.evaluate(async () => {
    const sleep = ms => new Promise(z => setTimeout(z, ms));
    state.isAdmin = true;
    state.publishedCategories = [{ id: "cat-a", name: "فئة أ", custom: true,
      questions: [{ points: 100, q: "سؤال ١", a: "جواب ١", image: "", answerImage: "" }] }];
    // Count every publish attempt. A preview that writes even once is a bug.
    let writes = 0;
    window.IZZBAH = window.IZZBAH || {};
    const prev = window.IZZBAH.cloudPublish;
    window.IZZBAH.cloudPublish = function () { writes++; return Promise.resolve(); };

    const file = new File([JSON.stringify({
      kind: "izzbah-catalog-backup", version: 1, build: "t", exportedAt: "2026-08-01T00:00:00.000Z",
      published: [{ id: "cat-a", name: "فئة أ", questions: [
        { points: 100, q: "سؤال ١", a: "جواب ١" },
        { points: 300, q: "سؤال مفقود", a: "جواب مفقود" }] }],
    })], "b.json", { type: "application/json" });
    const dt = new DataTransfer(); dt.items.add(file);
    const inp = document.getElementById("adminRestoreFile");
    inp.files = dt.files;
    inp.dispatchEvent(new Event("change"));
    await sleep(400);

    const modal = document.getElementById("restoreModal");
    const txt = document.getElementById("restorePreview").textContent || "";
    const out = {
      open: modal.classList.contains("open"),
      writesDuringPreview: writes,
      runEnabled: !document.getElementById("restoreRun").disabled,
      saysOne: /١|1/.test(txt),
      warnsNoMedia: !!document.querySelector("#restorePreview .imp-auto"),
      names: /سؤال مفقود/.test(txt) || /فئة أ/.test(txt),
    };
    document.getElementById("restoreCancel").click();
    out.closed = !modal.classList.contains("open");
    window.IZZBAH.cloudPublish = prev;
    return out;
  });

  check("picking a file opens the plan", ui.open);
  check("PREVIEWING WRITES NOTHING", ui.writesDuringPreview === 0, `${ui.writesDuringPreview} writes`);
  check("...and the confirm button is armed only once there is work", ui.runEnabled);
  check("the plan names the affected category", ui.names);
  check("the plan warns the file has no question images", ui.warnsNoMedia);
  check("cancelling closes without writing", ui.closed);

  check("no page errors", errs.length === 0, errs[0] || "");
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(`\n${failed ? `${failed} FAILED` : `all ${checks.length} checks passed`}`);
process.exit(failed ? 1 : 0);
