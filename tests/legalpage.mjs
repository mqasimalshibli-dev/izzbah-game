// The site's privacy policy and terms — the real ones, at a real URL.
//
// The footer used to link both to `../` with a title reading «تفتح داخل اللعبة
// من الإعدادات → الخصوصية والشروط». That is not a policy anyone can read before
// deciding whether to install the game, and it is not a URL an app store can be
// given. `preview/legal.html` is a page; `preview/legal.mjs` builds it.
//
// ⚠️ THE PAGE IS GENERATED, AND THIS TEST IS WHY THAT MATTERS. Two copies of a
// privacy policy maintained by hand WILL diverge, and the moment they do, one of
// them is a false statement about what the product does with a player's data.
// So the test compares the published page against the game's own text, sentence
// for sentence, rather than against a fixture of its own — a fixture would just
// be a third copy to keep in step.
//
// ⚠️ AND THE FONTS ARE NOT THE LANDING PAGE'S. `preview/fonts/` is subset to the
// 59 Arabic codepoints that page uses; the legal text needs four more. A missing
// glyph is a .notdef box in the middle of a legal document, and it is invisible
// to every structural check — so the glyphs are probed by rendering.
import { chromium } from "playwright-core";
import { spawn, execFileSync } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8767;
const checks = [];
const check = (n, ok, extra) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`); };

/* ── the page is in step with the game ──────────────────────────────
   Run the generator's own --check. It rebuilds from `index.html` and compares
   byte for byte, so an edit to the game's legal text that was never carried
   across fails HERE rather than shipping a stale policy. */
let inStep = true, why = "";
try { execFileSync("node", [join(ROOT, "preview", "legal.mjs"), "--check"], { cwd: ROOT }); }
catch (e) { inStep = false; why = (e.stdout || e.stderr || "").toString().trim().split("\n")[0]; }
check("preview/legal.html is in step with the game's legal text", inStep, why);

/* The three documents, read straight out of the game, so the comparison below
   is against the SOURCE and not against the generator's idea of it. */
const game = readFileSync(join(ROOT, "index.html"), "utf8");
const plain = s => s.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const docOf = key => {
  const m = new RegExp(`<div class="legal-doc[^"]*" data-legal-doc="${key}">([\\s\\S]*?)\\n\\s*</div>`).exec(game);
  return m ? plain(m[1]) : "";
};
const DOCS = ["privacy", "terms", "notices"];
const source = Object.fromEntries(DOCS.map(k => [k, docOf(k)]));
// Every `<p>` and `<li>` in the game's copy, individually — the unit the
// comparison below works in.
const rawOf = key => {
  const m = new RegExp(`<div class="legal-doc[^"]*" data-legal-doc="${key}">([\\s\\S]*?)\\n\\s*</div>`).exec(game);
  return [...(m ? m[1] : "").matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/g)].map(x => plain(x[2]));
};
const blocks = Object.fromEntries(DOCS.map(k => [k, rawOf(k)]));
check("the game still carries all three documents",
  DOCS.every(k => source[k].length > 400), DOCS.map(k => `${k} ${source[k].length}`).join(", "));
check("and they break into paragraphs the comparison can work in",
  DOCS.every(k => blocks[k].length >= 5), DOCS.map(k => `${k} ${blocks[k].length}`).join(", "));

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: process.env.IZZBAH_CHROMIUM });
const errs = [], http = [];

try {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", e => errs.push(e.message));
  page.on("response", r => { if (r.status() >= 400) http.push(r.status() + " " + r.url().split("/").pop()); });

  /* ── reachable from the site ──────────────────────────────────── */
  await page.goto(`http://127.0.0.1:${PORT}/preview/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(700);
  const links = await page.evaluate(() => [...document.querySelectorAll(".foot-links a")]
    .map(a => ({ text: a.textContent.trim(), href: a.getAttribute("href"), title: a.getAttribute("title") })));
  const privacy = links.find(l => l.text.includes("الخصوصية"));
  const terms = links.find(l => l.text.includes("شروط"));
  check("the footer links to the privacy policy", !!privacy && /legal\.html#privacy$/.test(privacy.href || ""),
    privacy && privacy.href);
  check("and to the terms of use", !!terms && /legal\.html#terms$/.test(terms.href || ""), terms && terms.href);
  // ⚠️ The old links carried a title saying the documents open inside the game.
  // A stale one left on a link that now goes somewhere else is worse than none.
  check("neither still claims the documents live inside the game",
    !(privacy && privacy.title) && !(terms && terms.title));

  /* ── the page itself ──────────────────────────────────────────── */
  await page.goto(`http://127.0.0.1:${PORT}/preview/legal.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(900);

  const shown = await page.evaluate(() => {
    const text = el => (el ? el.innerText.replace(/\s+/g, " ").trim() : "");
    return {
      title: document.title,
      sections: ["privacy", "terms", "notices"].map(id => ({ id, text: text(document.getElementById(id)) })),
      headings: [...document.querySelectorAll("main h2")].map(h => h.textContent.trim()),
      nav: [...document.querySelectorAll("nav.docs a")].map(a => a.getAttribute("href")),
      back: [...document.querySelectorAll("a")].map(a => a.getAttribute("href")).filter(h => h === "./").length,
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      // No script at all: a legal document that needs JS to render is a legal
      // document that does not render for someone with JS off.
      scripts: document.querySelectorAll("script").length,
    };
  });

  check("the page carries all three documents", shown.sections.length === 3
    && shown.sections.every(s => s.text.length > 400),
    shown.sections.map(s => `${s.id} ${s.text.length}`).join(", "));
  check("each has its own heading", shown.headings.length === 3
    && shown.headings.join("|").includes("سياسة الخصوصية")
    && shown.headings.join("|").includes("شروط الاستخدام"), shown.headings.join(" · "));
  check("the anchors the footer points at exist",
    shown.nav.join(",") === "#privacy,#terms,#notices", shown.nav.join(","));
  check("there is a way back to the site", shown.back >= 1);
  check("it is Arabic and right-to-left", shown.lang === "ar" && shown.dir === "rtl");
  check("it needs no JavaScript to render", shown.scripts === 0, `${shown.scripts} scripts`);
  check("it does not scroll sideways", !shown.sideways);

  /* ── the same words as the game ───────────────────────────────────
     Sentence for sentence. A page that merely CONTAINS the right phrases would
     pass a keyword check while having dropped a clause — and the clause most
     likely to be dropped is the one a store reviewer is looking for. */
  for (const id of DOCS) {
    const { text } = shown.sections.find(s => s.id === id);
    /* ⚠️ Compare per PARAGRAPH, and with all whitespace removed.
       Splitting the document into sentences on punctuation looks tidier and
       fails for two reasons that have nothing to do with the content: a
       heading runs into the sentence after it, and this build inserts its own
       `<h6>` between the two payment paragraphs, so a "sentence" that spanned
       them can never match. Stripping whitespace covers the other artefact —
       `<b>من داخل التطبيق</b>:` loses its tags to a space on one side and not
       the other. */
    const flat = text.replace(/\s+/g, "");
    const paras = [...blocks[id]].filter(s => s.replace(/[^؀-ۿ]/g, "").length > 30);
    const missing = paras.filter(s => !flat.includes(s.replace(/\s+/g, "")));
    check(`${id}: every paragraph from the game is on the page (${paras.length} checked)`,
      missing.length === 0, missing[0] ? "missing: " + missing[0].slice(0, 60) : "");
  }

  /* ── BOTH payment paragraphs, each labelled ───────────────────────
     The game shows one or the other by build, and since 2026-08-20 they are no
     longer two ways of BUYING: the website sells nothing and only activates
     codes, a store build sells and the store handles the money. The site is the
     front door to both, so a visitor must be able to tell which is theirs. */
  const pay = shown.sections.find(s => s.id === "terms").text;
  check("the terms cover playing via the site, where nothing is sold",
    pay.includes("إذا لعبت عبر الموقع") && pay.includes("غير قابل للاسترجاع"));
  /* ⚠️ The site must not still promise a purchase it no longer offers. This is
     the assertion that would have caught the terms drifting behind the build. */
  check("...and no longer describe ordering a pack from the site",
    !pay.includes("عند طلب باقة يصلك بريد تأكيد"));
  check("and a purchase made in-app through a store",
    pay.includes("إذا اشتريت من داخل التطبيق عبر المتجر") && pay.includes("استرداد المبالغ"));
  /* ── the App Store's minimum EULA terms ──────────────────────────
     An app linking its OWN EULA must carry Apple's checklist. The site is the
     URL App Store Connect is given, so a reviewer reads THIS page — each item
     is checked separately, because "mentions Apple" would pass on one sentence
     while the rest had been trimmed. */
  for (const [name, needle] of [
    ["the agreement is with us, not Apple", "ليست شركة Apple طرفاً"],
    ["the licence scope", "قواعد الاستخدام"],
    ["who provides support", "مسؤولون عن الدعم والصيانة"],
    ["Apple's refund-only warranty obligation", "لتردّ لك ثمن الشراء"],
    ["who answers product claims", "حماية المستهلك"],
    ["who answers IP claims", "انتهاك حقوق ملكية فكرية"],
    ["the export representation", "قائمة أطراف محظورة"],
    ["Apple as third-party beneficiary", "مستفيداً من الغير"],
  ]) check(`App Store terms: ${name}`, pay.includes(needle));

  /* ⚠️ The site is the front door to BOTH stores, so a Play buyer must find
     terms describing THEIR purchase. Before the split, Apple's block was the
     only store text there was and an Android customer read about Apple being a
     third-party beneficiary. */
  for (const [name, needle] of [
    ["Google is not a party", "ليست Google طرفاً"],
    ["Play collects the payment", "Google Play"],
    ["refunds follow Google's policy", "سياسة Google Play"],
  ]) check(`Play terms: ${name}`, pay.includes(needle));

  /* ── the site's own analytics, which the GAME must not claim ─────
     izzbah.com runs a Google Analytics property; the game does not. Both halves
     are asserted, because either alone is the bug: the site failing to disclose
     it, and the game claiming something about a site the player is not on. */
  const privacyText = shown.sections.find(s => s.id === "privacy").text;
  check("the site discloses its OWN analytics", privacyText.includes("izzbah.com"));
  check("...and the game's policy does not mention the website's",
    !source.privacy.includes("izzbah.com"),
    source.privacy.includes("izzbah.com") ? "still in index.html" : "");

  // ⚠️ The class names are the game's build switch. Leaving one on the page
  // means one of the two paragraphs is styled for a build that is not this one.
  const leftovers = await page.evaluate(() =>
    document.querySelectorAll(".legal-web-only, .legal-store-only, .legal-apple-extra, .legal-play-extra").length);
  check("neither is left carrying the game's build-switch class", leftovers === 0);

  /* ── the glyphs actually render ───────────────────────────────────
     ⚠️ The only honest test. `document.fonts.check()` returns true for a
     fallback match, and a subset that is missing a character renders it as a
     .notdef box which no structural assertion can see. Measured against the
     advance width of U+FFFF, which no font has a real glyph for. */
  const tofu = await page.evaluate(() => {
    const c = document.createElement("canvas").getContext("2d");
    c.font = "400 40px Cairo";
    const box = c.measureText("￿").width;
    const bad = [];
    for (const ch of new Set(document.body.innerText)) {
      if (/\s/.test(ch) || ch === "￿") continue;
      if (Math.abs(c.measureText(ch).width - box) < 0.01) bad.push(ch + " U+" + ch.codePointAt(0).toString(16));
    }
    return { bad, chars: new Set(document.body.innerText).size };
  });
  check(`every character in the documents has a glyph (${tofu.chars} distinct)`,
    tofu.bad.length === 0, tofu.bad.join(", "));

  // The type is the game's, not a system fallback. Width-probe, for the same
  // reason as above: `document.fonts.check()` would say yes to Tahoma.
  const font = await page.evaluate(() => {
    const c = document.createElement("canvas").getContext("2d");
    const s = "الشروط والسياسات في عِزبة";
    c.font = "800 40px Cairo"; const real = c.measureText(s).width;
    c.font = "800 40px NoSuchFamilyAnywhere"; const fallback = c.measureText(s).width;
    return { real, fallback };
  });
  check("it renders in Cairo, not a fallback",
    Math.abs(font.real - font.fallback) > 1, `${font.real.toFixed(1)} vs ${font.fallback.toFixed(1)}`);

  /* ── contact and reading comfort ──────────────────────────────── */
  const detail = await page.evaluate(() => {
    const body = document.body.innerText;
    // ⚠️ Not `#privacy p` — the first paragraph is the «آخر تحديث» line, which
    // is deliberately small print. Measure a paragraph of the policy itself.
    const p = document.querySelector("#privacy p:not(.legal-updated)");
    const nav = document.querySelector("nav.docs a").getBoundingClientRect();
    return {
      email: (body.match(/izzbahgame@gmail\.com/g) || []).length,
      mailto: document.querySelectorAll('a[href^="mailto:"]').length,
      lineHeight: parseFloat(getComputedStyle(p).lineHeight) / parseFloat(getComputedStyle(p).fontSize),
      size: parseFloat(getComputedStyle(p).fontSize),
      navTap: Math.round(nav.height),
    };
  });
  check("a way to contact us is on the page", detail.email >= 2 && detail.mailto >= 1,
    `${detail.email} mentions`);
  check("the body text is readable, not fine print",
    detail.size >= 15 && detail.lineHeight >= 1.5,
    `${detail.size}px / ${detail.lineHeight.toFixed(2)}`);
  check("the document links are real tap targets", detail.navTap >= 44, `${detail.navTap}px`);

  /* ── phone ─────────────────────────────────────────────────────── */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await phone.newPage();
  pp.on("pageerror", e => errs.push("phone: " + e.message));
  await pp.goto(`http://127.0.0.1:${PORT}/preview/legal.html`, { waitUntil: "load", timeout: 30000 });
  await pp.waitForTimeout(700);
  const small = await pp.evaluate(() => ({
    sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    // A sticky header that eats the top of a jumped-to heading is the classic
    // anchor bug; `scroll-padding-top` is what prevents it.
    pad: parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0,
    headerH: Math.round(document.querySelector("header").getBoundingClientRect().height),
  }));
  await phone.close();
  check("no sideways scroll on a phone", !small.sideways);
  check("an anchor jump clears the sticky header",
    small.pad >= small.headerH, `padding ${small.pad}px vs header ${small.headerH}px`);

  check("no missing files" + (http.length ? ": " + http[0] : ""), http.length === 0);
  check("no page errors" + (errs.length ? ": " + errs[0] : ""), errs.length === 0);
} finally {
  await browser.close();
  server.kill();
}

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
