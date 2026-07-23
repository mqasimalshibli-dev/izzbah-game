// Guards the fix for "some players see no pictures on question/answer screens".
// Root cause chain (all four layers must stay fixed):
//   1) the /questions subcollection (which carries the images) was read with a
//      plain get() — a flaky connection can "succeed" with an EMPTY snapshot
//      from the SDK cache, silently serving the parent doc's TEXT-ONLY copy;
//   2) any read error hit the same text-only fallback;
//   3) the imageless result was then CACHED keyed by the unchanged publish
//      timestamp — freezing "no pictures" on that device forever;
//   4) the catalog-rev fast path kept serving the frozen copy without ever
//      re-reading.
// The fix: server-sourced subcollection reads, degraded results marked and
// never cached, imgN stamped on cache entries, suspect legacy entries re-read
// (self-heal), and the fast path skipped while any suspect entry remains.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const html = readFileSync(join(ROOT, "game-mobile.html"), "utf8");

// 1) subcollection read is server-sourced (no SDK-cache empty snapshot)
check("question subcollection is read with source:\"server\"",
  /collection\("questions"\)\.get\(\{ source: "server" \}\)/.test(html));

// 2) the failure fallback is MARKED degraded
check("text-only fallback is marked __degraded",
  /__degraded: true \}, data, \{ questions: inline \}/.test(html));

// 3) degraded results are never cached; good entries carry imgN
check("a degraded category is never written to the device cache",
  /if \(!cat\.__degraded\) \{[\s\S]{0,400}catCache\.put\(d\.id, \{ ver, imgN: questionMediaCount\(cat\.questions\), cat: plain \}\)/.test(html));

// 4) legacy zero-media entries are re-read (self-heal) …
check("legacy cache entries with zero media are treated as suspect (re-read)",
  /const suspect = hit && hit\.imgN == null[\s\S]{0,200}questionMediaCount\(hit\.cat\.questions\) === 0/.test(html)
  && /if \(hit && !suspect && ver > 0/.test(html));

// … and the rev fast path won't serve them
check("the catalog-rev fast path is skipped while any suspect entry remains",
  /const cacheSuspect = cache && \[\.\.\.cache\.entries\(\)\]/.test(html)
  && /freshRev === cachedRev && haveCats && !cacheSuspect/.test(html));

// helper present exactly once
check("questionMediaCount helper is defined",
  (html.match(/function questionMediaCount\(qs\)/g) || []).length === 1);

process.exit(checks.every(Boolean) ? 0 : 1);
