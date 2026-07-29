// Admin direct-to-R2 upload flow (offline). Firebase is aborted as in every
// test, so we inject a fake `firebase.functions().httpsCallable` (the Cloud
// Function that mints the presigned URL) and a fake XMLHttpRequest (the PUT to
// R2), then drive uploadMediaToCloud end-to-end and check the media picker
// surfaces the upload button for admins only.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8363;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => {
  try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {}
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH_TEST && typeof window.IZZBAH_TEST.uploadMediaToCloud === "function", { timeout: 15000 });
  await page.evaluate(() => { window.IZZBAH.applyAuth(true, "u1"); window.IZZBAH.applyAdmin(true); state.isAdmin = true; state.signedIn = true; });

  // ---- the helper: callable → presigned PUT → public URL, with progress -----
  const up = await page.evaluate(async () => {
    const PUBLIC = "https://pub-xxxx.r2.dev/game-media/1-abc-clip.mp4";
    let sentType = null, calledWith = null;
    // fake Cloud Function
    window.firebase = {
      functions: () => ({
        httpsCallable: (name) => (payload) => {
          calledWith = { name, payload };
          return Promise.resolve({ data: { uploadUrl: "https://up.example/put?sig=1", publicUrl: PUBLIC } });
        },
      }),
    };
    // fake R2 PUT
    const RealXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = class {
      constructor() { this.upload = {}; this.status = 0; }
      open() {}
      setRequestHeader(k, v) { if (/content-type/i.test(k)) sentType = v; }
      send() {
        if (this.upload.onprogress) {
          this.upload.onprogress({ lengthComputable: true, loaded: 40, total: 100 });
          this.upload.onprogress({ lengthComputable: true, loaded: 100, total: 100 });
        }
        this.status = 200;
        if (this.onload) this.onload();
      }
    };
    const file = new File([new Uint8Array(1234)], "My Clip.MP4", { type: "video/mp4" });
    const seen = [];
    let url = null, err = null;
    try { url = await window.IZZBAH_TEST.uploadMediaToCloud(file, p => seen.push(p)); }
    catch (e) { err = String(e && e.message || e); }
    window.XMLHttpRequest = RealXHR;
    return { url, err, seen, sentType, calledWith, expected: PUBLIC };
  });
  check("upload resolves to the public R2 URL", up.url === up.expected && !up.err);
  check("the callable is asked for 'mintUploadUrl' with filename + contentType",
    up.calledWith && up.calledWith.name === "mintUploadUrl"
    && up.calledWith.payload && up.calledWith.payload.filename === "My Clip.MP4"
    && up.calledWith.payload.contentType === "video/mp4");
  check("the PUT sends the file's Content-Type", up.sentType === "video/mp4");
  check("progress is reported and reaches 100%", up.seen.length >= 1 && up.seen[up.seen.length - 1] === 1);

  // ---- a failed PUT surfaces as a thrown error (paste-link fallback) --------
  const fail = await page.evaluate(async () => {
    window.firebase = { functions: () => ({ httpsCallable: () => () => Promise.resolve({ data: { uploadUrl: "x", publicUrl: "y" } }) }) };
    const RealXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = class {
      constructor() { this.upload = {}; this.status = 0; }
      open() {} setRequestHeader() {}
      send() { this.status = 403; if (this.onload) this.onload(); }
    };
    let err = null;
    try { await window.IZZBAH_TEST.uploadMediaToCloud(new File(["x"], "c.mp3", { type: "audio/mpeg" }), () => {}); }
    catch (e) { err = String(e && e.message || e); }
    window.XMLHttpRequest = RealXHR;
    return err;
  });
  check("a non-2xx PUT rejects", /upload-failed-403/.test(fail || ""));

  // ---- with no cloud SDK the helper reports 'cloud-not-ready' ---------------
  const notReady = await page.evaluate(async () => {
    const saved = window.firebase; window.firebase = undefined;
    let err = null;
    try { await window.IZZBAH_TEST.uploadMediaToCloud(new File(["x"], "c.mp4", { type: "video/mp4" }), () => {}); }
    catch (e) { err = String(e && e.message || e); }
    window.firebase = saved;
    return err;
  });
  check("missing Functions SDK yields a clean 'cloud-not-ready'", /cloud-not-ready/.test(notReady || ""));

  // ---- the box is now the uploader: no separate button; link button stays ---
  const btns = await page.evaluate(() => {
    state.isAdmin = true;
    const asAdmin = window.IZZBAH_TEST.mediaPicker(() => {});
    state.isAdmin = false;
    const asUser = window.IZZBAH_TEST.mediaPicker(() => {});
    return {
      adminHasUp: !!asAdmin.querySelector(".media-up-btn"),
      adminHasLink: !!asAdmin.querySelector(".media-link-btn"),
      userHasLink: !!asUser.querySelector(".media-link-btn"),
      accepts: (asAdmin.querySelector('input[type="file"]') || {}).accept || "",
    };
  });
  check("the redundant ⬆️ upload button is gone", !btns.adminHasUp);
  check("the box accepts audio + video files", /audio/.test(btns.accepts) && /video/.test(btns.accepts));
  check("the paste-a-link button stays available to everyone", btns.adminHasLink && btns.userHasLink);

  // ---- dropping a file in the box (admin) uploads to R2 and reports the URL --
  // and must NOT raise the old "too large" warning (that path is gone for admins)
  const drop = await page.evaluate(async () => {
    const PUBLIC = "https://pub-xxxx.r2.dev/game-media/9-zzz-voice.m4a";
    window.firebase = { functions: () => ({ httpsCallable: () => () => Promise.resolve({ data: { uploadUrl: "https://up/x", publicUrl: PUBLIC } }) }) };
    const RealXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = class {
      constructor() { this.upload = {}; this.status = 0; }
      open() {} setRequestHeader() {}
      send() { if (this.upload.onprogress) this.upload.onprogress({ lengthComputable: true, loaded: 100, total: 100 }); this.status = 200; if (this.onload) this.onload(); }
    };
    // count any warning popups raised during the drop
    let warned = 0; const realPop = window.popNote;
    window.popNote = (t) => { if (/كبير|الرفع/.test(String(t))) warned++; };
    state.isAdmin = true;
    let got = null;
    const picker = window.IZZBAH_TEST.mediaPicker((v) => { got = v; });
    const box = picker.querySelector(".image-picker");
    // a 3 MB "voice note" — would have tripped the 1 MB inline warning before
    const file = new File([new Uint8Array(3 * 1024 * 1024)], "voice.m4a", { type: "audio/mp4" });
    const dt = new DataTransfer(); dt.items.add(file);
    box.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    // wait for the async upload to resolve
    for (let i = 0; i < 50 && got === null; i++) await new Promise(r => setTimeout(r, 20));
    window.XMLHttpRequest = RealXHR; window.popNote = realPop;
    return { got, expected: PUBLIC, warned };
  });
  check("dropping audio in the admin box uploads to R2", drop.got === drop.expected);
  check("no bogus 'too large' warning on an admin cloud upload", drop.warned === 0);

  // ---- odd voice-note extensions get normalized to a playable one ----------
  const norm = await page.evaluate(() => {
    const f = window.IZZBAH_TEST.cloudSafeFilename;
    return {
      opus: f("WhatsApp-AUD-2026.opus", "audio/ogg"),
      noext: f("recording", "audio/mp4"),
      aac: f("clip", "audio/aac"),
      keepMp4: f("promo.mp4", "video/mp4"),
      keepM4a: f("note.m4a", "audio/mp4"),
    };
  });
  check("an .opus voice note becomes a playable .ogg", /\.ogg$/.test(norm.opus));
  check("an extension-less audio note gets .m4a from its type", /\.m4a$/.test(norm.noext));
  check("an .aac note maps to the playable .m4a container", /\.m4a$/.test(norm.aac));
  check("already-valid names are left untouched", norm.keepMp4 === "promo.mp4" && norm.keepM4a === "note.m4a");

  // ---- the CSP must allow the function call + the R2 upload PUT ------------
  const csp = await page.evaluate(() => {
    const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    return (m && m.getAttribute("content")) || "";
  });
  const connect = (csp.match(/connect-src([^;]*)/) || [, ""])[1];
  check("CSP connect-src allows the Cloud Function domain", /cloudfunctions\.net/.test(connect));
  check("CSP connect-src allows the R2 upload endpoint", /r2\.cloudflarestorage\.com/.test(connect));

  check("no uncaught JS errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 4));
} catch (e) {
  check("harness completed", false);
  console.log("  harness error:", e.message, e.stack);
} finally {
  await browser.close();
  server.kill();
}
process.exit(checks.every(Boolean) ? 0 : 1);
