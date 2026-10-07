// A media-LITE category republished after a question MOVES must keep every
// picture on its own question.
//
// Found 2026-10-07 in «العاب»: roughly eighty pictures sat one row late —
// "ماريو" showed Big Boss, "لويجي" showed Mario, "باوزر" showed Luigi, and so
// on down the category. Not a blanking (the August bug, which mediawipe.mjs
// pins) but a RE-PAIRING. Question docs are keyed q0..qN by position, and the
// untrusted path of cloudPublish fell back to the stored image "of slot i". The
// duplicate remover splices a question out of a lite copy and republishes, so
// every later question moved up one slot while its picture stayed put — and
// each took the previous occupant's photo.
//
// The fix is pairStoredMedia(): a stored entry is matched by what the question
// says (q + a), not by where it sits. This pins the function, and that both
// publishers actually use it.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8419;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  " + extra : ""}`); };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [];
const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
await page.route("**/firebasejs/**", r => r.abort());
page.on("pageerror", e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem("izzbah-legal-consent-v1", "1"); } catch (e) {} });
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(1300);

const r = await page.evaluate(() => {
  const S = (q, a, img) => ({ q, a, image: img, answerImage: img + "-ans" });
  const L = (q, a) => ({ q, a, image: "", answerImage: "" });          // lite: pictures not loaded
  const imgs = (list, stored) => pairStoredMedia(list, stored).map(x => x ? x.image : null);
  const out = {};

  // the exact failure: one question removed from the middle
  const stored = [S("س0", "A", "iA"), S("س1", "B", "iB"), S("س2", "C", "iC"), S("س3", "D", "iD")];
  out.deleteMiddle = imgs([L("س0", "A"), L("س2", "C"), L("س3", "D")], stored);
  // the old positional lookup, for contrast — this is what shipped
  out.oldPositional = [0, 1, 2].map(i => stored[i].image);

  // an insert must not hand the newcomer its neighbour's photo
  out.insert = imgs([L("س0", "A"), L("جديد", "N"), L("س1", "B"), L("س2", "C")], stored);
  // a reorder
  out.reorder = imgs([L("س2", "C"), L("س0", "A"), L("س1", "B")], stored);
  // the text edited in place keeps its own slot's picture
  out.editInPlace = imgs([L("س0", "A"), L("س1 معدّل", "B"), L("س2", "C")], stored);
  // same QUESTION text, different answers (photo categories: «وش اسم المطعم؟»)
  const rest = [S("وش اسم المطعم؟", "X", "iX"), S("وش اسم المطعم؟", "Y", "iY"), S("وش اسم المطعم؟", "Z", "iZ")];
  out.sameQ = imgs([L("وش اسم المطعم؟", "Z"), L("وش اسم المطعم؟", "X")], rest);
  // two identical (q, a) rows, one removed
  out.identical = imgs([L("س", "X"), L("س", "Y")], [S("س", "X", "i1"), S("س", "X", "i2"), S("س", "Y", "iY")]);
  // a long category with one removal near the start — every later pair intact
  const big = Array.from({ length: 120 }, (_, i) => S("س" + i, "ج" + i, "img" + i));
  const bigList = big.filter((_, i) => i !== 7).map(x => L(x.q, x.a));
  const bigOut = pairStoredMedia(bigList, big);
  out.bigAllOwn = bigOut.every((s, i) => s && s.q === bigList[i].q && s.a === bigList[i].a);
  // robustness
  out.nulls = (() => { try { pairStoredMedia(null, null); pairStoredMedia([], []); pairStoredMedia([L("x", "y")], [undefined, null]); return true; } catch (e) { return false; } })();
  return out;
});

check("removing a question keeps each remaining picture on its OWN question", JSON.stringify(r.deleteMiddle) === JSON.stringify(["iA", "iC", "iD"]), JSON.stringify(r.deleteMiddle));
check("…which the old by-position lookup got wrong (iA, iB, iC)", JSON.stringify(r.oldPositional) === JSON.stringify(["iA", "iB", "iC"]));
check("a new question gets NO picture, not its neighbour's", JSON.stringify(r.insert) === JSON.stringify(["iA", null, "iB", "iC"]), JSON.stringify(r.insert));
check("a reorder moves the pictures with the questions", JSON.stringify(r.reorder) === JSON.stringify(["iC", "iA", "iB"]), JSON.stringify(r.reorder));
check("a question edited in place keeps the picture in its slot", JSON.stringify(r.editInPlace) === JSON.stringify(["iA", "iB", "iC"]), JSON.stringify(r.editInPlace));
check("same question text with different answers is not conflated", JSON.stringify(r.sameQ) === JSON.stringify(["iZ", "iX"]), JSON.stringify(r.sameQ));
check("a repeated identical row removed leaves the others paired", r.identical[1] === "iY", JSON.stringify(r.identical));
check("120 questions, one removed near the top: all 119 stay paired", r.bigAllOwn);
check("null / empty / sparse input never throws", r.nulls);

// Both publishers must actually use it — the function alone pins nothing.
const src = readFileSync(join(ROOT, "index.html"), "utf8");
const cpStart = src.indexOf("window.IZZBAH.cloudPublish = function");
const cp = src.slice(cpStart, src.indexOf("// ---- Audit log", cpStart));
check("cloudPublish pairs stored media by question", /pairStoredMedia\(list, storedByPos\)/.test(cp));
check("…and no longer falls back to the doc in the same slot", !/keepImg\(q\.image, prev && prev\.image\)/.test(cp));
const acStart = src.indexOf("window.IZZBAH.adminSetCommunityQuestions = function");
const ac = src.slice(acStart, src.indexOf("window.IZZBAH.adminListFeedback = function", acStart));
check("the community writer pairs by question too", /pairStoredMedia\(list, prev/.test(ac));
check("…and no longer indexes the stored questions by slot", !/prev\[i\]/.test(ac));

check("no page errors", errs.length === 0);
if (errs.length) errs.slice(0, 4).forEach(e => console.log("   " + e));
await browser.close(); server.kill();
process.exit(checks.every(Boolean) ? 0 : 1);
