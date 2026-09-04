// The cloud blob cannot be blown up by one fat key.
//
// THE BUG THIS PINS. Team photos are capped at 180 KB each, five teams are
// allowed, and they were stored inside `izzbah-trivia-settings-v1` — which is
// the FIRST entry in `KEYS`, i.e. it rides the cloud blob. At five photos the
// document cleared Firestore's hard 1 MiB limit, the push was REJECTED, and
// schedulePush logged and carried on. The player's saved games and
// entitlements then silently stopped syncing, with nothing on screen to say
// so, and shaveBlob could not rescue it — shaving only ever touched the play
// history. `customCategories` rides the same key and carries question
// pictures, so a player's own photo category could do it too.
//
// Two independent guards, and this pins both, because either one alone leaves
// a way back to a silently unsyncable account:
//   1. photos live in their own key that is NOT in KEYS, so the common case
//      never gets near the budget;
//   2. shaveBlob drops the single fattest droppable key rather than letting
//      the whole write fail — losing one key beats losing the account's sync.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8421;
const checks = [];
const check = (n, ok, note) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${note ? `  — ${note}` : ""}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
await page.route("**/firebasejs/**", r => r.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.IZZBAH_TEST && window.IZZBAH_TEST.shaveBlob, { timeout: 15000 });

  const BUDGET = await page.evaluate(() => window.IZZBAH_TEST.cloudBudget());
  check("the cloud budget is well under Firestore's 1 MiB document limit",
    BUDGET > 0 && BUDGET < 1048576, `${BUDGET} bytes`);

  /* ── 1. five team photos at the cap must not reach the blob ───────────── */
  const withPhotos = await page.evaluate(() => {
    // A photo at the picker's own cap: { maxDim: 640, targetKB: 180 }.
    const photo = "data:image/jpeg;base64," + "A".repeat(180 * 1024);
    state.teamCount = 5;
    state.teams.slice(0, 5).forEach(t => { t.image = photo; });
    saveGameSettings();
    const settings = localStorage.getItem("izzbah-trivia-settings-v1") || "";
    const photos = localStorage.getItem("izzbah-team-photos-v1") || "";
    const blob = window.IZZBAH_TEST.cloudBlob();
    return {
      settingsLen: settings.length,
      photosLen: photos.length,
      settingsHasPhoto: settings.includes("A".repeat(1000)),
      blobLen: JSON.stringify(blob).length,
      blobHasSettings: !!blob["izzbah-trivia-settings-v1"],
    };
  });
  check("the photos really are stored (five at the 180 KB cap)",
    withPhotos.photosLen > 5 * 180 * 1024, `${withPhotos.photosLen} chars in izzbah-team-photos-v1`);
  /* ⚠️ The load-bearing one. Everything else here can pass while the account
     still cannot sync; this is the check that fails if a photo is ever put
     back into the settings object. */
  check("…but no photo bytes ride the synced settings key",
    !withPhotos.settingsHasPhoto && withPhotos.settingsLen < 20000,
    `settings is ${withPhotos.settingsLen} chars`);
  check("…so the whole cloud blob stays inside the budget",
    withPhotos.blobLen < BUDGET, `${withPhotos.blobLen} vs budget ${BUDGET}`);
  // Settings must still SYNC — the fix moves photos out, it does not stop
  // team names and custom categories from following the account.
  check("…and settings still syncs (names/custom categories are not collateral)",
    withPhotos.blobHasSettings);

  /* ── 2. photos survive a reload, and migrate from the old inline shape ── */
  const roundTrip = await page.evaluate(() => {
    loadGameSettings();
    return state.teams.slice(0, 5).map(t => (t.image || "").length);
  });
  check("photos load back after a reload of settings",
    roundTrip.every(n => n > 180 * 1024), roundTrip.map(n => n > 0 ? "ok" : "MISSING").join(","));

  /* ⚠️ MIGRATION. A settings blob written before the split still carries the
     photos inline. Without the fallback, updating the game would silently
     delete every team photo a player had set. */
  const migrated = await page.evaluate(() => {
    const photo = "data:image/jpeg;base64," + "B".repeat(50 * 1024);
    localStorage.removeItem("izzbah-team-photos-v1");
    localStorage.setItem("izzbah-trivia-settings-v1", JSON.stringify({
      teamCount: 2,
      teams: [{ name: "أ", image: photo, helpers: [] }, { name: "ب", image: photo, helpers: [] }],
      selected: [], customCategories: []
    }));
    loadGameSettings();
    return {
      loaded: state.teams.slice(0, 2).map(t => (t.image || "").length),
      // and the migration must WRITE THROUGH, not just read once
      movedToOwnKey: (localStorage.getItem("izzbah-team-photos-v1") || "").length,
    };
  });
  check("an old inline photo still loads (nobody loses a photo on update)",
    migrated.loaded.every(n => n > 50 * 1024), migrated.loaded.join(","));
  check("…and is written through to its own key, so it stops riding the blob",
    migrated.movedToOwnKey > 50 * 1024, `${migrated.movedToOwnKey} chars`);

  /* ── 3. shaveBlob drops one fat key rather than failing the whole write ── */
  const shaved = await page.evaluate(() => {
    const J = JSON.stringify;
    const fat = "x".repeat(900 * 1024);
    const before = {
      "izzbah-trivia-settings-v1": J({ blown: fat }),      // the offender
      "izzbah-trivia-saved-games-v1": J([{ id: "g1", charged: true }]),
      "izzbah-games-used-v1": "7",
      "izzbah-code-balance-v1": J({ g: 5 }),
      "izzbah-free-game-v1": "1",
      "izzbah-legal-consent-v1": "1",
    };
    const after = window.IZZBAH_TEST.shaveBlob(Object.assign({}, before));
    return {
      len: JSON.stringify(after).length,
      keptGames: !!after["izzbah-trivia-saved-games-v1"],
      keptUsed: after["izzbah-games-used-v1"],
      keptBalance: !!after["izzbah-code-balance-v1"],
      keptConsent: !!after["izzbah-legal-consent-v1"],
      droppedFat: !after["izzbah-trivia-settings-v1"],
    };
  });
  check("an oversized key is dropped so the write can still go through",
    shaved.droppedFat && shaved.len < BUDGET, `${shaved.len} bytes after shaving`);
  /* The whole point: what the player PAID for and what the law needs must
     survive. These are tiny, so they can never be the offender — naming them
     here stops a future edit from making one of them droppable. */
  check("…while the saved games survive", shaved.keptGames);
  check("…and the games-used counter survives", shaved.keptUsed === "7");
  check("…and the code balance survives", shaved.keptBalance);
  check("…and the legal consent survives", shaved.keptConsent);

  check("no uncaught JS errors" + (errs.length ? ": " + errs[0] : ""), errs.length === 0);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
