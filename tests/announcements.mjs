// Announcement center: the developer publishes messages from the admin panel
// (compose + design + manage), and every player sees them in «إعلانات المطوّر»
// with an unread badge. Cloud writes are stubbed (Firebase is offline here);
// this drives the UI + the data shape handed to the bridge.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8342;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
await page.route("**/firebasejs/**", route => route.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  // ---- 1) ADMIN: compose + live preview + publish shape ----
  const compose = await page.evaluate(async () => {
    window.IZZBAH = window.IZZBAH || {};
    window.__pub = [];
    window.IZZBAH.publishAnnouncement = (a) => { window.__pub.push(a); return Promise.resolve("id1"); };
    window.IZZBAH.listAnnouncements = () => Promise.resolve([]);
    window.IZZBAH.deleteAnnouncement = (id) => { window.__del = id; return Promise.resolve(); };
    openAnnouncementsAdmin();
    const open = document.getElementById("announceAdminModal").classList.contains("open");
    // fill the form
    document.getElementById("annTitle").value = "تحديث جديد";
    document.getElementById("annTitle").dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("annBody").value = "أضفنا فئات جديدة!";
    document.getElementById("annBody").dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("annIcon").value = "🎉";
    document.getElementById("annIcon").dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("annPinned").checked = true;
    document.getElementById("annPinned").dispatchEvent(new Event("change", { bubbles: true }));
    // pick the 2nd colour swatch
    const swatches = [...document.querySelectorAll("#annSwatches .ann-swatch")];
    swatches[1].click();
    const prev = document.querySelector("#annPreview .ann-card");
    return {
      open,
      swatchCount: swatches.length,
      previewHasTitle: !!prev && /تحديث جديد/.test(prev.textContent),
      previewHasIcon: !!prev && /🎉/u.test(prev.textContent),
      previewAccent: prev ? prev.style.getPropertyValue("--ann-accent") : "",
      previewPinned: !!prev && prev.classList.contains("pinned"),
    };
  });
  check("the admin announcements composer opens", compose.open);
  check("it offers colour swatches to design the announcement", compose.swatchCount >= 3);
  check("the live preview reflects the title + icon as you type", compose.previewHasTitle && compose.previewHasIcon);
  check("choosing a swatch recolours the preview", /^#/.test(compose.previewAccent));
  check("the pinned toggle marks the preview as pinned", compose.previewPinned);

  const published = await page.evaluate(async () => {
    document.getElementById("annPublish").click();
    await new Promise(r => setTimeout(r, 150));
    return window.__pub[0];
  });
  check("publishing hands the bridge the composed announcement",
    published && published.title === "تحديث جديد" && /فئات جديدة/.test(published.body)
    && published.icon === "🎉" && published.pinned === true && published.active === true && /^#/.test(published.color));
  check("a brand-new announcement carries no id (create, not edit)", !published.id);

  // ---- 1b) MULTIPLE images: compose several, preview + publish carry them all ----
  const PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const multi = await page.evaluate(async (px) => {
    window.__pub = [];
    window.IZZBAH.publishAnnouncement = (a) => { window.__pub.push(a); return Promise.resolve("idm"); };
    resetAnnForm();
    annDraftImages = [px, px, px];
    renderAnnImageSlot(); renderAnnPreview();
    document.getElementById("annTitle").value = "عدة صور";
    document.getElementById("annTitle").dispatchEvent(new Event("input", { bubbles: true }));
    const previewImgs = document.querySelectorAll("#annPreview .ann-card .ann-card-img").length;
    const slotItems = document.querySelectorAll("#annImageSlot .ann-img-item").length; // 3 + 1 add
    document.getElementById("annPublish").click();
    await new Promise(r => setTimeout(r, 300));
    const pub = window.__pub[0] || {};
    return { previewImgs, slotItems, pubImages: (pub.images || []).length, hasCover: !!pub.image };
  }, PX);
  check("the composer previews every image you add", multi.previewImgs === 3);
  check("the composer shows an «add another» slot after the current images", multi.slotItems === 4);
  check("publishing carries all images (plus image[0] for older clients)", multi.pubImages === 3 && multi.hasCover);

  const render = await page.evaluate((px) => {
    const box = document.getElementById("annPreview");
    renderAnnouncementCards(box, [{ title: "معرض", body: "صور", images: [px, px, px], createdAt: 1 }]);
    return box.querySelectorAll(".ann-card .ann-card-img").length;
  }, PX);
  check("an announcement with several images renders all of them", render === 3);

  // ---- 2) ADMIN: existing list -> edit loads the form, delete calls bridge ----
  const manage = await page.evaluate(async () => {
    window.IZZBAH.listAnnouncements = () => Promise.resolve([
      { id: "a1", title: "قديم", body: "نص", icon: "📢", color: "#9a1c1c", image: "", active: true, pinned: false, createdAt: 1750000000000 },
      { id: "a2", title: "مخفي", body: "ن", icon: "📢", color: "#1d7a41", image: "", active: false, pinned: false, createdAt: 1750000100000 },
    ]);
    refreshAdminAnnouncements();
    await new Promise(r => setTimeout(r, 150));
    const rows = [...document.querySelectorAll("#annAdminList .ann-admin-row")];
    // edit the first
    rows[0].querySelector(".ann-edit-btn").click();
    const loadedTitle = document.getElementById("annTitle").value;
    const btnLabel = document.getElementById("annPublish").textContent;
    // delete the second
    rows[1].querySelector(".ann-del-btn").click();
    await new Promise(r => setTimeout(r, 150));
    return { rowCount: rows.length, hiddenTagged: rows[1].classList.contains("hidden-ann"), loadedTitle, btnLabel, deleted: window.__del };
  });
  check("published announcements list in the manager (hidden ones marked)", manage.rowCount === 2 && manage.hiddenTagged);
  check("editing an announcement loads it into the form", manage.loadedTitle === "قديم" && /حفظ التعديل/.test(manage.btnLabel));
  check("deleting an announcement calls the bridge with its id", manage.deleted === "a2");

  // an edit publishes WITH the id (update, not a new doc)
  const edited = await page.evaluate(async () => {
    window.__pub = [];
    document.getElementById("annPublish").click();
    await new Promise(r => setTimeout(r, 150));
    return window.__pub[0];
  });
  check("saving an edit sends the existing id (update, not a duplicate)", edited && edited.id === "a1");

  // ---- 3) PLAYER: the feed + the unread badge ----
  const player = await page.evaluate(async () => {
    try { localStorage.removeItem("izzbah-ann-seen-v1"); } catch (e) {}
    window.IZZBAH.listAnnouncements = () => Promise.resolve([
      { id: "n1", title: "مرحباً", body: "أهلاً بكم", icon: "👋", color: "#9a1c1c", image: "", active: true, pinned: true, createdAt: 1760000000000 },
      { id: "n2", title: "خبر", body: "جديدنا", icon: "📢", color: "#1d7a41", image: "", active: true, pinned: false, createdAt: 1759000000000 },
    ]);
    await loadAnnouncements();
    const badge = document.getElementById("settingsAnnounceBadge");
    const gear = document.getElementById("userSettingsBtn");
    return {
      badgeShown: !badge.hidden,
      badgeText: badge.textContent,
      gearDot: gear.classList.contains("has-unread"),
    };
  });
  check("unread announcements show a count badge on the settings row", player.badgeShown && /[2٢]/.test(player.badgeText));
  check("the settings gear shows an unread dot", player.gearDot);

  const opened = await page.evaluate(async () => {
    openAnnouncements();
    const cards = [...document.querySelectorAll("#announceList .ann-card")];
    const badge = document.getElementById("settingsAnnounceBadge");
    const gear = document.getElementById("userSettingsBtn");
    return {
      cardCount: cards.length,
      firstIsPinned: cards[0] && cards[0].classList.contains("pinned"),
      showsBody: cards.some(c => /أهلاً بكم/.test(c.textContent)),
      badgeGoneAfter: badge.hidden,
      gearDotGone: !gear.classList.contains("has-unread"),
    };
  });
  check("opening the center shows the announcement cards (pinned first)", opened.cardCount === 2 && opened.firstIsPinned && opened.showsBody);
  check("opening the center clears the unread badge + gear dot", opened.badgeGoneAfter && opened.gearDotGone);

  // ---- 4) empty state ----
  const empty = await page.evaluate(async () => {
    window.IZZBAH.listAnnouncements = () => Promise.resolve([]);
    await loadAnnouncements();
    openAnnouncements();
    return document.querySelector("#announceList .announce-empty") ? document.querySelector("#announceList .announce-empty").textContent : "";
  });
  check("with no announcements the center shows a friendly empty state", /لا توجد/.test(empty));

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
