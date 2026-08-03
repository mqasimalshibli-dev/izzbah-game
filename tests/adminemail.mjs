// The admin centre names players by email instead of by uid.
//
// A 28-character Firebase uid tells the owner nothing about who a row belongs
// to. The email does — but the obvious source, users/{uid}, is owner-read-only
// by rules, so an admin genuinely cannot read it. Two sources they CAN read:
//
//   • orders/{uid}, which has always carried the buyer's email. Works with no
//     rules change at all, and covers everyone who ordered a pack.
//   • the usage mirror, which each player now stamps with their own email.
//     This needs the updated firestore.rules published; until then the write is
//     rejected and the client falls back (see the guard test below), so billing
//     keeps working either way.
//
// The row still knows the uid — title attribute and copy-on-click — because it
// is what support and the Firestore console need. It just isn't what's on
// screen any more.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8387;
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const html = readFileSync(join(ROOT, "game-mobile.html"), "utf8");
const rules = readFileSync(join(ROOT, "firestore.rules"), "utf8");

// ── static: the rules and the safe-transition guard ─────────────────────────
check("firestore.rules allows an optional email on the usage doc",
  /hasOnly\(\['gamesUsed', 'gamesGranted', 'premium', 'email', 'updatedAt'\]\)/.test(rules)
  && /!\('email' in request\.resource\.data\)[\s\S]{0,160}email\.size\(\) <= 320/.test(rules));
check("...and usage is still admin-readable, so the list can be built",
  /match \/usage\/\{uid\}[\s\S]{0,120}allow read: if isSignedIn\(\) && \(request\.auth\.uid == uid \|\| isAdmin\(\)\)/.test(rules));
check("users/{uid} stays owner-read-only — this change does NOT open it up",
  /match \/users\/\{userId\}[\s\S]{0,120}allow read: if isSignedIn\(\) && request\.auth\.uid == userId/.test(rules));
// The transition hazard: usage writes carry the games-used counter. If the
// email field is rejected before the rules are published and we do not retry,
// billing silently stops recording.
check("a rules rejection drops the email and retries, so usage keeps working",
  /usageEmailAllowed = false;[\s\S]{0,260}return window\.IZZBAH\.pushUsage\(v, g, prem\);/.test(html));
check("the redeemer email is escaped before going into innerHTML",
  /\$\{escapeHtml\(who\)\}/.test(html));

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];

try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  await page.route("**/firebasejs/**", r => r.abort());
  page.on("pageerror", e => errs.push(e.message));
  await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
  await page.goto(`http://127.0.0.1:${PORT}/game-mobile.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1400);

  const out = await page.evaluate(() => {
    const el = document.createElement("div");
    const usage = {
      "uidAAA111aaa222bbb333ccc4444": { used: 2, granted: 10, premium: false, email: "sara@gmail.com" },
      "uidBBB111aaa222bbb333ccc4444": { used: 0, granted: 5, premium: false },   // no stamp yet
      "uidCCC111aaa222bbb333ccc4444": { used: 1, granted: 0, premium: true },    // unknown entirely
    };
    // an order supplies the email for the player who never stamped their mirror
    const orders = [{ uid: "uidBBB111aaa222bbb333ccc4444", email: "khalid@gmail.com", pack: "٢٠ لعبة" }];
    renderPlayers(el, usage, "", emailIndex(usage, orders));
    const rows = [...el.querySelectorAll(".prem-row-id")];
    return {
      shown: rows.map(r => r.textContent),
      titles: rows.map(r => r.title),
      uidStyled: rows.map(r => r.className.includes("prem-row-id-uid")),
    };
  });

  check("a player who stamped their mirror shows as their email",
    out.shown.includes("sara@gmail.com"));
  check("a player who only ever ordered is named from the order (no rules change needed)",
    out.shown.includes("khalid@gmail.com"));
  check("a player with no email anywhere still shows their uid, not a blank row",
    out.shown.some(t => t.indexOf("uidCCC") === 0));
  check("...and that fallback row is visually marked as an unresolved uid",
    out.uidStyled[out.shown.findIndex(t => t.indexOf("uidCCC") === 0)] === true);
  check("no row shows a raw uid when an email is known",
    !out.shown.some(t => t.indexOf("uidAAA") === 0 || t.indexOf("uidBBB") === 0));
  check("the uid is still reachable on the row (title) for support",
    out.titles.some(t => t && t.includes("uidAAA111aaa222bbb333ccc4444")));

  // the search box has to find people by the thing now on screen
  const search = await page.evaluate(() => {
    const usage = {
      "uidAAA111aaa222bbb333ccc4444": { used: 0, granted: 10, premium: false, email: "sara@gmail.com" },
      "uidBBB111aaa222bbb333ccc4444": { used: 0, granted: 10, premium: false, email: "khalid@gmail.com" },
    };
    const byMail = document.createElement("div");
    renderPlayers(byMail, usage, "sara", emailIndex(usage, []));
    const byUid = document.createElement("div");
    renderPlayers(byUid, usage, "uidbbb", emailIndex(usage, []));
    return {
      mail: [...byMail.querySelectorAll(".prem-row-id")].map(r => r.textContent),
      uid: [...byUid.querySelectorAll(".prem-row-id")].map(r => r.textContent),
    };
  });
  check("searching by email finds the player", search.mail.length === 1 && search.mail[0] === "sara@gmail.com");
  check("searching by uid still works", search.uid.length === 1 && search.uid[0] === "khalid@gmail.com");

  // an email arriving from orders/{uid} is player-written, so it must not be
  // able to inject markup into the codes list
  const xss = await page.evaluate(() => {
    const el = document.createElement("div");
    const orders = [{ uid: "uidEVIL", email: "<img src=x onerror=window.__pwn=1>@gmail.com", pack: "p" }];
    renderCodeList(el, [{ code: "ABC123", gamesAllowed: 5, premium: false, used: true,
                          usedBy: "uidEVIL", usedAt: Date.now() }], false, emailIndex({}, orders));
    return { html: el.innerHTML, pwned: !!window.__pwn, imgs: el.querySelectorAll("img").length };
  });
  check("a hostile email in an order cannot inject an element", xss.imgs === 0 && !xss.pwned);
  check("...it is rendered as text instead", /&lt;img/.test(xss.html));

  check("no page errors", errs.length === 0);
  if (errs.length) console.log("  errors:", errs.slice(0, 3));
  await page.close();
} catch (e) {
  check(`threw: ${e && e.message}`, false);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
