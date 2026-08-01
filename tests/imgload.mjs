// Guards the fix for "some players see no pictures on question/answer screens".
//
// Original root-cause chain: the /questions subcollection (which carries the
// images) was read with a plain get(); a flaky connection could "succeed" with
// an EMPTY snapshot from the SDK cache; that imageless result was served AND
// cached against the unchanged publish timestamp — freezing "no pictures" on
// that device forever, with the catalog-rev fast path serving the frozen copy.
//
// The media path has since been rewritten (see tests/lazymedia.mjs — question
// images are fetched per game instead of for the whole catalogue at boot,
// because loading all of them measured 541 MB of heap and got the tab killed by
// iOS Safari). The MECHANISM moved; the HAZARD did not. These are the same four
// properties, enforced against the new code:
//
//   1) the subcollection read is server-sourced, so a flaky connection cannot
//      pass an empty SDK-cache snapshot off as "this category has no images";
//   2) a read failure resolves to null — "unknown" — never to an empty list
//      that would read as "there are none";
//   3) nothing is written to the device cache on the failure path, so a failure
//      can never be frozen against an unchanged publish timestamp;
//   4) media cache entries are keyed by that timestamp, so a republish
//      invalidates them and a failure simply retries on the next game.
//
// tests/lazymedia.mjs covers the runtime half (a failed read IS retried rather
// than remembered as "none"); this file is the static guard on the source.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

const html = readFileSync(join(ROOT, "game-mobile.html"), "utf8");

// Isolate the media loader, so none of the checks below can be satisfied by an
// unrelated part of this very large file that happens to contain the tokens.
const fnStart = html.indexOf("function loadCategoryMedia(");
check("loadCategoryMedia() exists (the per-game media reader)", fnStart > 0);
const body = fnStart > 0 ? html.slice(fnStart, fnStart + 2200) : "";

// 1) server-sourced read — no empty snapshot from the SDK's own cache
check('the questions subcollection is read with source:"server"',
  /collection\("questions"\)[\s\S]{0,40}\.get\(\{ source: "server" \}\)/.test(body));

// 2) a failure resolves to null ("unknown"), never to an empty list ("none")
check("a read failure resolves to null, not to an empty image list",
  /\.catch\(\(\) => null\)/.test(body));

// 3) the cache write lives in the SUCCESS branch, ahead of the catch
const putIdx = body.indexOf("catCache.put(");
const catchIdx = body.lastIndexOf(".catch(");
check("the media cache is written only on success, never on failure",
  putIdx > 0 && catchIdx > putIdx);

// 4) keyed by the publish version, and only reused while it matches
check("media cache entries are keyed by the publish version",
  /catCache\.put\(key, \{ ver: ver, qs: qs \}\)/.test(body));
check("a cached entry is only reused when its version still matches",
  /hit\.ver === ver/.test(body));

// An empty subcollection means "legacy inline-only category", NOT "no images":
// it must fall through to the parent doc rather than be accepted as empty.
check("an empty subcollection falls back to the legacy inline copy",
  /if \(qsnap\.empty\) return null;/.test(body) && /function loadInlineMedia\(/.test(html));

// Boot must not read media at all — that is what put 541 MB on the heap.
const bootStart = html.indexOf("function liteCategoryFromDoc(");
const bootFn = bootStart > 0 ? html.slice(bootStart, fnStart) : "";
check("boot builds categories WITHOUT reading any media",
  bootFn.length > 0 && !/collection\("questions"\)/.test(bootFn));
check("boot marks its categories __lite so hydration knows to run",
  /__lite: true/.test(bootFn));

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
