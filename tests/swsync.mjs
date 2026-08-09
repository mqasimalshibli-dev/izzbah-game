// Service-worker cache name ↔ build id lockstep.
//
// sw.js names its cache "izzbah-<build>" and the update flow depends on that
// name CHANGING with every deploy: a new name makes the new SW install, wipe
// the old cache, claim the page, and trigger the controllerchange reload.
//
// This drifted once — IZZBAH_BUILD was bumped four times (.204 → .207) while
// sw.js stayed pinned at .203 — so phones kept launching the stale cached
// shell one deploy (or more) behind, and players reported seeing the OLD
// category list long after the fixes had shipped. The background shell
// refresh eventually heals it, but "eventually" is exactly the bug.
//
// No browser needed: this is a pure lockstep check, run in CI on every push.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const game = readFileSync(join(ROOT, "index.html"), "utf8");
const sw = readFileSync(join(ROOT, "sw.js"), "utf8");

const buildM = game.match(/const IZZBAH_BUILD = "([^"]+)";/);
const cacheM = sw.match(/const CACHE = "izzbah-([^"]+)";/);

check("index.html declares IZZBAH_BUILD", !!buildM);
check("sw.js declares an izzbah-<build> cache name", !!cacheM);
if (buildM && cacheM) {
  check(`sw.js cache tracks the build (build ${buildM[1]}, cache izzbah-${cacheM[1]})`,
    buildM[1] === cacheM[1]);
}
// The update flow the name-change feeds — if either half disappears, a bumped
// name no longer reaches players promptly and the lockstep above is moot.
check("sw.js still skipWaiting()s on install", /skipWaiting\(\)/.test(sw));
check("sw.js still claims clients on activate", /clients\.claim\(\)/.test(sw));
check("the page still reloads on controllerchange", /controllerchange/.test(game));
check("sw registration bypasses the HTTP cache for sw.js itself", /updateViaCache:\s*"none"/.test(game));

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
