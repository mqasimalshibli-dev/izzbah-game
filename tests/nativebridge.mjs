// The Capacitor wrapper's packaging contract.
//
// ⚠️ WHY THIS IS A STATIC TEST. Everything here could be proved properly by
// running `npm install` in mobile/ and building the bundle — 175 packages and
// two native plugins, on every CI run, for a wrapper CI never executes. So this
// checks the SOURCE instead: the handful of facts that, when they drift, break
// the app silently and are invisible from the website.
//
// Each check below is a bug that actually happened while adding the wrapper:
//
// ⚠️ THE BRIDGES HAD NO PATH INTO THE APP. `copy-web.js` packaged index.html and
// assets/ only. `native-auth.js` and `native-store.js` were written, documented
// and committed, and `www/` never contained either — so sign-in and purchasing
// would both have been dead in the wrapper, with nothing on screen to point at
// and nothing in the repo that looked wrong.
//
// ⚠️ THEY CANNOT SHIP RAW. Both use ESM imports of BARE specifiers, which no
// browser resolves. Copying them beside index.html attaches no globals and
// raises nothing the game can report — it just quietly does not work.
//
// ⚠️ TYPESCRIPT 7 BREAKS THE CAPACITOR CLI. `capacitor.config.ts` is read
// through TypeScript, and Capacitor 6 reaches for `ts.ModuleKind.CommonJS`,
// which TS 7 no longer exposes — `cap add android` dies with
// "Cannot read properties of undefined (reading 'CommonJS')". A caret range on
// ^5 is the fix; the failure names neither TypeScript nor the version.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const M = join(ROOT, "mobile");
const read = f => readFileSync(join(M, f), "utf8");
const checks = [];
const check = (n, ok, extra) => {
  checks.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`);
};

const pkg = JSON.parse(read("package.json"));
const deps = pkg.dependencies || {};
const dev = pkg.devDependencies || {};
const copy = read("copy-web.js");
const entry = read("native-entry.js");
const ignore = read(".gitignore");

/* ── the plugins the two bridges import ─────────────────────────── */
for (const [file, dep] of [
  ["native-auth.js", "@capacitor-firebase/authentication"],
  ["native-store.js", "@revenuecat/purchases-capacitor"],
]) {
  const src = read(file);
  check(`${file} imports ${dep}`, src.includes(dep));
  check(`…and ${dep} is a dependency`, !!deps[dep], deps[dep] || "MISSING");
}

/* ── TypeScript must stay on 5.x ────────────────────────────────── */
check("typescript is a devDependency at all", !!dev.typescript, dev.typescript || "MISSING");
check("…and pinned to 5.x — 7 breaks `cap add`", /^\^?5\./.test(String(dev.typescript || "")),
  dev.typescript);

/* ── the bundle: entry, tool, injection, and a loud failure ─────── */
check("the bundle entry pulls in BOTH bridges",
  entry.includes("native-auth.js") && entry.includes("native-store.js"));
check("esbuild is available to build it", !!dev.esbuild, dev.esbuild || "MISSING");
check("copy-web bundles rather than copying raw", copy.includes("esbuild") && copy.includes("--bundle"));
check("…and injects a tag for the result", /<script[^>]*src="native\.js"/.test(copy));
/* ⚠️ `defer`, not a plain script: it has to run before the first sign-in tap,
   before the packs box opens, AND before applyAuth's identifyStoreUser — while
   not blocking the first paint on 168 KB. */
check("…deferred, so it lands before applyAuth without blocking paint",
  /<script defer src="native\.js"/.test(copy));
/* ⚠️ The silent version of this bug is the whole reason for the test. */
check("copy-web THROWS if the injection did not take",
  /throw new Error\([^)]*inject/i.test(copy) || /could not inject/i.test(copy));
check("copy-web THROWS if the bundle could not be built",
  /could not bundle/i.test(copy));

/* ── generated things stay out of the repo ──────────────────────── */
// ⚠️ www/ holds a COPY of index.html. Committed, it would publish a second copy
// of the whole game on the Pages site — the duplicate-canonical problem the
// root move was made to fix.
for (const d of ["www/", "android/", "ios/", "node_modules/"]) {
  check(`mobile/.gitignore excludes ${d}`, ignore.includes(d));
}

/* ── the seam the game actually reads ───────────────────────────── */
const game = readFileSync(join(ROOT, "index.html"), "utf8");
check("the game reads IZZBAH_AUTH, and the bridge installs it",
  game.includes("window.IZZBAH_AUTH") && read("native-auth.js").includes("window.IZZBAH_AUTH ="));
check("the game reads IZZBAH_STORE, and the bridge installs it",
  game.includes("window.IZZBAH_STORE") && read("native-store.js").includes("window.IZZBAH_STORE ="));
/* ⚠️ identify() is the one that fails silently and expensively: a purchase
   completed under RevenueCat's own anonymous id cannot be matched to an
   account. The payment succeeds and the games never arrive. */
check("…including identify(), without which a purchase cannot be matched to a uid",
  game.includes("identifyStoreUser") && read("native-store.js").includes("async identify("));
/* ⚠️ Nothing native may grant games. The webhook is the only path to paid
   content; a client that could credit itself could credit itself for free.
   ⚠️ Strip comments FIRST. The file explains at length that the WEBHOOK writes
   `entitlements/{uid}` — matching the raw text flags the documentation that
   exists to prevent the very thing being checked for. */
const code = s => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
check("the store bridge grants nothing itself — the webhook is the only path",
  !/entitlements|gamesRemaining|addGames|firestore/i.test(code(read("native-store.js"))));
// Nor may it reach Firebase at all; the game owns that session.
check("…and holds no Firebase handle of its own",
  !/firebase\./i.test(code(read("native-store.js"))));

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
