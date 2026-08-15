// «سجل التعديلات» — who published what, and when.
//
// There was no record of catalogue changes at all before this: `updatedAt` was
// the only trace, which is why the August media wipe took a day to understand.
// It matters more now that editors write too.
//
// The properties that matter: logging can NEVER fail a publish, the viewer is
// admin-only, and a publish that REMOVED questions is visually obvious.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8416;
const checks = [];
const check = (n, ok, note) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${note ? `  — ${note}` : ""}`); };

// ---- the rules, read statically -------------------------------------------
// A stray `isEditor()` in the wrong block is a one-word review miss, so the
// rules are sliced per match-block and checked directly.
const rules = readFileSync(join(ROOT, "firestore.rules"), "utf8")
  .split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
const block = (name) => {
  const i = rules.indexOf(`match /${name}`);
  if (i < 0) return "";
  // ⚠️ Start AFTER the path — `match /logs/{logId}` contains braces of its own,
  // and scanning from the first `{` returns the wildcard rather than the block.
  const start = rules.indexOf("{", rules.indexOf("}", i) + 1);
  let d = 0, out = "";
  for (let j = start; j < rules.length; j++) {
    out += rules[j];
    if (rules[j] === "{") d++;
    else if (rules[j] === "}") { d--; if (!d) break; }
  }
  return out;
};
const logs = block("logs/{logId}");
check("the rules define a /logs collection", !!logs);
check("only an admin may READ the log (it holds staff emails)", /allow read:\s*if isAdmin\(\)/.test(logs));
check("an editor may CREATE, since editors publish too", /allow create:[\s\S]*isEditor\(\)/.test(logs));
check("the entry's uid is pinned to the caller", /uid == request\.auth\.uid/.test(logs));
check("the shape is closed with hasOnly", /hasOnly\(\[/.test(logs));
check("an audit entry can never be EDITED", /allow update:\s*if false/.test(logs));
check("only an admin may clear it", /allow delete:\s*if isAdmin\(\)/.test(logs));

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.route("**/firebasejs/**", r => r.abort());
const errs = [];
page.on("pageerror", e => errs.push(e.message));
page.on("dialog", d => d.accept().catch(() => {}));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);

  const ui = await page.evaluate(async () => {
    const sleep = ms => new Promise(z => setTimeout(z, ms));
    window.IZZBAH.applyAdmin && window.IZZBAH.applyAdmin(true);
    const ts = (d) => ({ toDate: () => d });
    window.IZZBAH.loadAuditLog = () => Promise.resolve([
      { id: "1", email: "owner@x.com", name: "تاريخ", before: 120, after: 134, at: ts(new Date(2026, 7, 15, 9, 5)) },
      { id: "2", email: "editor@x.com", name: "سيارات", before: 40, after: 33, at: ts(new Date(2026, 7, 15, 8, 0)) },
      { id: "3", uid: "abc123", name: "علوم", before: 10, after: 10, at: ts(new Date(2026, 7, 14, 20, 0)) },
    ]);
    document.getElementById("adminEntry").click();
    await sleep(150);
    document.getElementById("adminChoiceLog").click();
    await sleep(400);
    const body = document.getElementById("auditBody");
    const rows = Array.from(body.querySelectorAll("tbody tr"));
    const out = {
      open: document.getElementById("auditModal").classList.contains("open"),
      count: rows.length,
      text: body.textContent || "",
      // A publish that REMOVED questions must stand out.
      shrinkMarked: rows.filter(r => r.classList.contains("crit")).length,
      shrinkIsTheRightRow: (rows.find(r => r.classList.contains("crit")) || {}).textContent || "",
      // Falls back to the uid when no email was captured.
      showsUid: /abc123/.test(body.textContent || ""),
      dated: /2026-08-15/.test(body.textContent || ""),
    };
    document.getElementById("auditClose").click();
    out.closed = !document.getElementById("auditModal").classList.contains("open");
    return out;
  });

  check("the log viewer opens from «فحص المحتوى»", ui.open);
  check("it lists the entries", ui.count === 3, String(ui.count));
  check("a publish that REMOVED questions is marked", ui.shrinkMarked === 1, String(ui.shrinkMarked));
  check("...and it is the right row", /سيارات/.test(ui.shrinkIsTheRightRow), ui.shrinkIsTheRightRow.slice(0, 40));
  check("an entry with no email falls back to the uid", ui.showsUid);
  check("entries are dated", ui.dated);
  check("closing works", ui.closed);

  // The property that matters most: logging must never break a publish. The
  // writer lives inside the Firebase bridge (absent offline), so this is
  // asserted on the SOURCE — that it is wrapped, swallows its own rejection,
  // and is called fire-and-forget rather than inside the publish chain.
  const src = readFileSync(join(ROOT, "index.html"), "utf8");
  const writer = src.slice(src.indexOf("window.IZZBAH.writeAuditLog = function"),
                           src.indexOf("function writeAuditLog(entry)"));
  check("the writer is wrapped in try/catch", /try\s*\{/.test(writer));
  check("...bails out with no db or no user", /if \(!db \|\| !currentUser\) return/.test(writer));
  check("...and swallows its own rejection", /\.catch\(\(\) => \{\}\)/.test(writer));
  const hook = src.slice(src.indexOf("catCache.remove(cat.id);"), src.indexOf("return bumpCatalogRev()"));
  check("A FAILED LOG CANNOT FAIL A PUBLISH — it is not in the promise chain",
    /writeAuditLog\(\{/.test(hook) && !/return writeAuditLog/.test(hook) && !/await writeAuditLog/.test(hook));

  // Admin-only viewer.
  const gated = await page.evaluate(async () => {
    const before = state.isAdmin;
    state.isAdmin = false; state.isEditor = true;
    let opened = false;
    try { openAuditLog(); opened = document.getElementById("auditModal").classList.contains("open"); } catch (e) {}
    state.isAdmin = before; state.isEditor = false;
    return opened;
  });
  check("an editor cannot open the log", gated === false);

  check("no page errors", errs.length === 0, errs[0] || "");
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(`\n${failed ? `${failed} FAILED` : `all ${checks.length} checks passed`}`);
process.exit(failed ? 1 : 0);
