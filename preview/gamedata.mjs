// Shared plumbing for the two scripts that drive the REAL game to produce
// artwork for the landing page — `preview/shots.mjs` (stills) and
// `preview/clip.mjs` (the hero's motion clip).
//
// ⚠️ THIS EXISTS SO THERE IS ONE COPY. Both scripts have to read the published
// catalogue, hydrate question media, and clear the same four traps before they
// capture anything. When that was inlined in `shots.mjs` and about to be pasted
// into `clip.mjs`, the second copy would have been a set of guards nobody
// maintains — and every one of these traps produces a picture that LOOKS fine
// and is not the game.
//
// The four traps, kept here with the code that clears them:
//
// 1. NO CATALOGUE. Firebase is fetched from gstatic, which is not reachable
//    from every network (it is not from CI), and the game then falls back to
//    the 20 BUNDLED categories with their old artwork. The published catalogue
//    is read over Firestore's REST API — public, because every player's browser
//    reads the same data — and injected. `catalogue()` refuses a short read.
// 2. NO FONTS. The faces are self-hosted in `assets/fonts/` since build .216,
//    so serving the repo is enough — but that is a property of the build, not a
//    law. `document.fonts.check()` is useless (it returns true for a fallback),
//    so `assertFonts` WIDTH-PROBES Cairo against a nonsense family.
// 3. THE WRONG THEME. The game's default is LIGHT. Never set `data-theme`;
//    `assertLightTheme` fails if something did.
// 4. NO QUESTION PHOTOS. Question media lives only in the `/questions`
//    subcollection, not in the parent doc's text-only copy, so a capture taken
//    without it is a bare sentence on a card.
import { readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";

export const REST =
  "https://firestore.googleapis.com/v1/projects/izzbahgame/databases/(default)/documents";

/** Firestore REST typed value → plain JS. */
export const V = v => {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(V);
  if ("mapValue" in v) { const o = {}; for (const k in (v.mapValue.fields || {})) o[k] = V(v.mapValue.fields[k]); return o; }
  return null;
};

/** Every published category, text-only (TRAP 1). Throws on a short read. */
export async function catalogue({ min = 20 } = {}) {
  let docs = [], tok = null;
  do {
    const u = new URL(REST + "/categories");
    u.searchParams.set("pageSize", "50");
    if (tok) u.searchParams.set("pageToken", tok);
    const r = await fetch(u);
    if (!r.ok) throw new Error("catalogue " + r.status);
    const j = await r.json();
    docs.push(...(j.documents || []));
    tok = j.nextPageToken;
  } while (tok);
  const cats = docs.map(d => {
    const f = d.fields || {}, o = { id: d.name.split("/").pop() };
    for (const k in f) o[k] = V(f[k]);
    return o;
  });
  if (cats.length < min)
    throw new Error(`only ${cats.length} categories came back — refusing to capture the bundled fallback`);
  return cats;
}

/* Question media for ONE category, capped (TRAP 4).
   ⚠️ These are base64 JPEGs on the question documents — the whole catalogue is
   about 160 MB of them. Fetching eighteen categories' worth and handing it to
   `page.evaluate` in one go killed the renderer outright ("Target page, context
   or browser has been closed"), which is a confusing way to learn that a
   serialized argument has a practical size limit. Only questions that actually
   carry a picture are kept, only the first `cap` of them, and only for the
   categories of the scene being captured. */
export async function media(id, { cap = 10 } = {}) {
  let out = [], tok = null;
  do {
    const u = new URL(`${REST}/categories/${encodeURIComponent(id)}/questions`);
    u.searchParams.set("pageSize", "300");
    if (tok) u.searchParams.set("pageToken", tok);
    const r = await fetch(u);
    if (!r.ok) return out;
    const j = await r.json();
    for (const d of (j.documents || [])) {
      const f = d.fields || {};
      const image = V(f.image) || "", answerImage = V(f.answerImage) || "";
      if (!image && !answerImage) continue;
      out.push({ idx: V(f.idx), image, answerImage });
      if (out.length >= cap) return out;
    }
    tok = j.nextPageToken;
  } while (tok);
  return out;
}

/** Merge media onto the text-only copy by position, as hydrateCategoryMedia
    does at play time — one category at a time, for the size reason above. */
export async function hydrate(page, ids, opts) {
  for (const id of ids) {
    const rows = await media(id, opts);
    if (!rows.length) continue;
    await page.evaluate(({ id, rows }) => {
      const c = (state.publishedCategories || []).find(x => x.id === id);
      if (!c || !c.questions) return;
      for (const row of rows) {
        const q = c.questions[row.idx];
        if (!q) continue;
        if (row.image) q.image = row.image;
        if (row.answerImage) q.answerImage = row.answerImage;
      }
    }, { id, rows });
  }
}

/** TRAP 2 — a width probe. `document.fonts.check()` returns true for a
    fallback and would wave a Tahoma render straight through. */
export async function assertFonts(page) {
  const f = await page.evaluate(async () => {
    await document.fonts.ready;
    const probe = (fam, w) => {
      const s = document.createElement("span");
      s.textContent = "عِزبة اختبار الخط";
      s.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${w} 40px ${fam}`;
      document.body.appendChild(s); const x = s.offsetWidth; s.remove(); return x;
    };
    return { cairo: probe("'Cairo',sans-serif", 900), fake: probe("'NoSuchFace123',sans-serif", 900) };
  });
  if (f.cairo === f.fake)
    throw new Error("Cairo did not render — the capture would be in the fallback face");
  return f;
}

/** TRAP 3 — the game's default is LIGHT; that is what players see. */
export async function assertLightTheme(page) {
  const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  if (theme === "dark") throw new Error("the page is in dark mode — the game's default is light");
}

/** Push the published catalogue into a loaded game page (TRAP 1). */
export async function injectCatalogue(page, cats) {
  await page.evaluate(cats => {
    state.publishedCategories = cats;
    if (typeof applyPublished === "function") applyPublished(cats);
  }, cats);
}

/** Seat a scene: six categories, named teams, a clean board. Returns the ids
    actually used — a scene is topped up rather than drawn short, because a
    five-column board is a different picture from the six the copy promises. */
export async function seatScene(page, scene) {
  return page.evaluate(({ scene }) => {
    const all = (typeof allCategories === "function" ? allCategories() : state.publishedCategories) || [];
    const has = id => all.find(c => c.id === id && (typeof categoryHasQuestions !== "function" || categoryHasQuestions(c)));
    let ids = scene.cats.filter(has);
    if (ids.length < 6) {
      const extra = all.filter(c => !ids.includes(c.id) && (typeof categoryHasQuestions !== "function" || categoryHasQuestions(c)));
      ids = ids.concat(extra.slice(0, 6 - ids.length).map(c => c.id));
    }
    ids = ids.slice(0, 6);
    state.selected = new Set(ids);
    state.teamCount = scene.teams.length;
    state.teams = scene.teams.map(name => ({
      name, helpers: ["fourChoices", "firstLetter", "doublePoints"], helpUsed: {}, score: 0,
    }));
    state.activeTeam = 0;
    state.used = new Set();
    if (typeof coachMarkAll === "function") coachMarkAll();
    return ids;
  }, { scene });
}

/* Stamp a content-addressed version into `preview/index.html`.
   ⚠️ A re-capture reuses the same FILENAMES, so a browser holding the old ones
   keeps showing them until its cache expires — the site serves the new files
   and the reader sees the old ones, which is indistinguishable from a deploy
   that did not happen. Content-addressed, so an unchanged capture does not
   churn the URL and throw away a warm cache for nothing. */
export function stampVersion(pagePath, files, { constant, srcPattern }) {
  const h = createHash("sha256");
  for (const f of files) h.update(readFileSync(f));
  const v = "v" + h.digest("hex").slice(0, 8);
  let html = readFileSync(pagePath, "utf8");
  const before = html;
  html = html.replace(new RegExp(`const ${constant} = "[^"]*";`), `const ${constant} = "${v}";`);
  if (srcPattern) html = html.replace(srcPattern, (m, head) => `${head}?${v}"`);
  if (html !== before) { writeFileSync(pagePath, html); return { v, changed: true }; }
  return { v, changed: false };
}
