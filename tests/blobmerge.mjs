// Two devices, one account.
//
// The cloud push used to write the whole blob with set(), and the only merge in
// the system ran at SIGN-IN — so two devices signed into one account each
// overwrote the other and whoever saved last won. Friends sharing an account is
// normal for a party game, and one person with a phone and a laptop hits the
// same thing, so games and question history were being lost silently.
//
// Every push is now a read-modify-write in a transaction, combining each key by
// a rule that suits it. This pins those rules, because getting one wrong loses
// player data with no error anywhere.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8404;
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
  await page.waitForFunction(() => window.IZZBAH_TEST && window.IZZBAH_TEST.mergeBlob, { timeout: 15000 });

  const r = await page.evaluate(() => {
    const m = window.IZZBAH_TEST.mergeBlob;
    const J = JSON.stringify;
    // Phone and laptop, both signed into one account, both played.
    const phone = {
      "izzbah-trivia-saved-games-v1": J([
        { id: "g1", title: "لعبة الجمعة", createdAt: "2026-08-10T20:00:00Z", categoryIds: ["a"], frozen: { a: [1] }, charged: true },
        { id: "g2", title: "لعبة الهاتف", createdAt: "2026-08-12T20:00:00Z", categoryIds: ["b"], frozen: {}, charged: true },
      ]),
      "izzbah-seen-v1": J({ tarikh: ["s1", "s2"], deen: ["d1"] }),
      "izzbah-progress-v1": J({ tarikh: ["p1", "p2"] }),
      "izzbah-games-used-v1": "7",
      "izzbah-free-game-v1": "1",
      "izzbah-code-balance-v1": J({ g: 5, p: false }),
      "izzbah-trivia-settings-v1": J({ sound: false }),
    };
    const laptop = {
      "izzbah-trivia-saved-games-v1": J([
        // same game, but this copy never learned it was charged and lost the board
        { id: "g1", title: "لعبة الجمعة", createdAt: "2026-08-10T20:00:00Z", categoryIds: ["a"], frozen: {}, charged: false },
        { id: "g3", title: "لعبة الحاسوب", createdAt: "2026-08-11T20:00:00Z", categoryIds: ["c"], frozen: {}, charged: true },
      ]),
      "izzbah-seen-v1": J({ tarikh: ["s0", "s1"], memes: ["m1"] }),
      "izzbah-progress-v1": J({ tarikh: ["p2", "p3"], deen: ["p9"] }),
      "izzbah-games-used-v1": "4",
      "izzbah-free-game-v1": "0",
      "izzbah-code-balance-v1": J({ g: 2, p: true }),
      "izzbah-trivia-settings-v1": J({ sound: true }),
    };
    const out = m(phone, laptop);
    const games = JSON.parse(out["izzbah-trivia-saved-games-v1"]);
    const seen = JSON.parse(out["izzbah-seen-v1"]);
    const prog = JSON.parse(out["izzbah-progress-v1"]);
    const bal = JSON.parse(out["izzbah-code-balance-v1"]);
    // …and the reverse direction must agree, or the result depends on who pushed last.
    const rev = m(laptop, phone);
    const revGames = JSON.parse(rev["izzbah-trivia-saved-games-v1"]).map(g => g.id).sort();
    return {
      ids: games.map(g => g.id).sort(),
      g1charged: (games.find(g => g.id === "g1") || {}).charged,
      g1frozen: Object.keys((games.find(g => g.id === "g1") || {}).frozen || {}).length,
      newestFirst: games[0] && games[0].id,
      seenTarikh: seen.tarikh, seenCats: Object.keys(seen).sort(),
      progTarikh: (prog.tarikh || []).slice().sort(), progCats: Object.keys(prog).sort(),
      used: out["izzbah-games-used-v1"],
      free: out["izzbah-free-game-v1"],
      bal,
      settings: out["izzbah-trivia-settings-v1"],
      revIds: revGames,
      revUsed: rev["izzbah-games-used-v1"],
      // a device with nothing yet must not wipe the other
      emptySide: JSON.parse(m({}, phone)["izzbah-trivia-saved-games-v1"]).map(g => g.id).sort(),
      // and corrupt JSON must not throw or lose the write
      corrupt: m({ "izzbah-seen-v1": "{not json" }, { "izzbah-seen-v1": JSON.stringify({ a: ["x"] }) })["izzbah-seen-v1"],
    };
  });

  check("no saved game is lost from either device", JSON.stringify(r.ids) === JSON.stringify(["g1","g2","g3"]), r.ids.join(","));
  // The one that costs money if it goes the wrong way.
  check("a game already CHARGED stays charged", r.g1charged === true);
  check("...and keeps whichever copy still has its frozen board", r.g1frozen === 1);
  check("saved games come back newest-first", r.newestFirst === "g2", r.newestFirst);
  check("question history is unioned across devices",
    JSON.stringify(r.seenTarikh) === JSON.stringify(["s0","s1","s2"]), r.seenTarikh.join(","));
  check("...including categories only one device played",
    JSON.stringify(r.seenCats) === JSON.stringify(["deen","memes","tarikh"]), r.seenCats.join(","));
  check("progress is unioned, not replaced",
    JSON.stringify(r.progTarikh) === JSON.stringify(["p1","p2","p3"]) && r.progCats.length === 2,
    r.progTarikh.join(","));
  // Counters and flags that only move one way.
  check("the spent counter takes the HIGHER value, never the lower", r.used === "7", r.used);
  check("a used free game cannot be un-used", r.free === "1");
  check("the balance mirror keeps the better grant and premium-on",
    r.bal.g === 5 && r.bal.p === true, JSON.stringify(r.bal));
  check("per-device settings still take the local value", JSON.parse(r.settings).sound === false);
  // Order-independence: whoever pushes last must not change the outcome.
  check("merging the other way round gives the same games",
    JSON.stringify(r.revIds) === JSON.stringify(["g1","g2","g3"]), r.revIds.join(","));
  check("...and the same counter", r.revUsed === "7");
  check("a device with no data yet does not wipe the other",
    JSON.stringify(r.emptySide) === JSON.stringify(["g1","g2"]), r.emptySide.join(","));
  check("corrupt stored JSON neither throws nor loses the write", typeof r.corrupt === "string");

  // ---- the write-back must not revert what the player just did ------------
  // Reported live: picking categories cleared itself a second after every tap,
  // and pressing play in that window said «لا توجد فئات صالحة للّعب». A push is
  // a network round-trip and the player keeps playing during it; writing the
  // merged snapshot back over a key they have since changed reverts it on
  // screen, and reloadFromStorage() then pushes that revert into state.
  const wb = await page.evaluate(() => {
    const f = window.IZZBAH_TEST.writeBackKeys;
    const K = "izzbah-trivia-settings-v1";
    const G = "izzbah-trivia-saved-games-v1";
    const sent = {}; sent[K] = '{"selected":["a"]}'; sent[G] = "[]";
    const now1 = {}; now1[K] = '{"selected":["a","b","c"]}'; now1[G] = "[]";
    const mg1 = {}; mg1[K] = '{"selected":["a"]}'; mg1[G] = "[]";
    const now2 = {}; now2[K] = '{"selected":["a"]}'; now2[G] = "[]";
    const mg2 = {}; mg2[K] = '{"selected":["a"]}'; mg2[G] = '[{"id":"g1"}]';
    return { changed: f(sent, now1, mg1), untouched: f(sent, now2, mg2), noop: f(sent, sent, sent) };
  });
  check("A KEY CHANGED MID-FLIGHT IS NOT OVERWRITTEN — the picker keeps the new pick",
    wb.changed.apply.indexOf("izzbah-trivia-settings-v1") === -1, JSON.stringify(wb.changed.apply));
  check("...and it is reported stale so the change still gets pushed",
    wb.changed.stale.indexOf("izzbah-trivia-settings-v1") !== -1, JSON.stringify(wb.changed.stale));
  check("...while an untouched key still receives the other device's games",
    wb.untouched.apply.indexOf("izzbah-trivia-saved-games-v1") !== -1, JSON.stringify(wb.untouched.apply));
  check("an unchanged blob writes nothing at all (no needless re-render)",
    wb.noop.apply.length === 0 && wb.noop.stale.length === 0);

  check("no page errors", errs.length === 0, errs.slice(0, 2).join(" | "));
} catch (e) {
  check(`threw: ${e && e.message}`, false);
} finally {
  await browser.close();
  server.kill();
}
const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
