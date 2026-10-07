// One-off repair for «العاب» (pub-1783510423551-6465): every picture from q43
// to q147 sits ONE ROW LATE.
//
// Found 2026-10-07. "ماريو" shows Big Boss, "لويجي" shows Mario, "باوزر" shows
// Luigi, … for ~105 questions. A question was removed at q42 — almost certainly
// by the duplicate remover, which republishes a media-LITE copy — and
// cloudPublish then paired each later question with the stored picture of its
// OLD slot instead of its own (fixed in the app the same day: pairStoredMedia).
// The pictures themselves are all still here, one row too far down.
//
// How the diagnosis was made — by looking, not by guessing:
//   • all 148 stored pictures were viewed against their answers; q0–q41 are
//     correct, q42 holds an orphan (the removed question's picture) and every
//     doc from q43 on shows the subject of the answer ABOVE it;
//   • two independent checks agree: the duplicated questions «Aerondight»
//     (q48, q96) and «Dragonlord Placidusax» (q52, q75) hold byte-identical
//     pictures at q49/q97 and q53/q76 — i.e. at row+1 in BOTH copies.
//   • the empty slots (q75, q76, q106, q107, q111–q113) are questions that had
//     no picture before the shift; they simply move up with the rest.
//
// The fix: row N receives the picture currently on row N+1, for N = 42 … 146.
// q147 (Parade Master) has nothing below it — its own picture was lost when
// the last doc was removed — so it is CLEARED, and needs a new one.
//
//   cd ~/izzbah-game && git pull
//   npm install @google-cloud/firestore            # once
//   node tools/fix-games-shift.mjs                 # dry run: prints the plan
//   node tools/fix-games-shift.mjs --apply         # writes (saves a backup first)
//   node tools/fix-games-shift.mjs --undo tools/games-shift-backup-<time>.json
//   node tools/touch-categories.mjs --only pub-1783510423551-6465 --apply
//
// Safety, in order of importance:
//   1. All-or-nothing PRECONDITION. EXPECTED below records, for q42–q147, the
//      answer AND a fingerprint of both pictures as audited. If ANY doc differs
//      — someone already fixed it, or edited a question — nothing is written.
//      That also makes a second run harmless: after a successful apply the
//      fingerprints no longer match, so it refuses.
//   2. The original value of every field it overwrites is written to a backup
//      file BEFORE the first write; --undo puts them back.
//   3. update() on image/answerImage only — q / a / points / idx cannot change.
//   4. Scoped to one hardcoded category id, not a flag.
//   5. Dry run unless --apply.
import { Firestore } from "@google-cloud/firestore";
import crypto from "crypto";
import { readFileSync, writeFileSync } from "fs";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const UNDO = argv.includes("--undo") ? argv[argv.indexOf("--undo") + 1] : null;
const CATEGORY = "pub-1783510423551-6465"; // العاب — the ONLY category this touches
const FIRST = 42, LAST = 147;               // rows whose pictures move / get cleared
const db = new Firestore({ projectId: "izzbahgame" });
const col = db.collection("categories").doc(CATEGORY).collection("questions");

// index -> [answer, fingerprint(image), fingerprint(answerImage)] as audited.
// A fingerprint is the first 10 hex chars of sha1 of the stored string; "" = empty.
const EXPECTED = {
  42: ["Irithyll of the Boreal Valley", "28fd5fc997", "28fd5fc997"],
  43: ["Eileen the Crow", "befb3139cd", "62eeac6855"],
  44: ["Orphan of Kos", "c0dc60f52f", "02daee4786"],
  45: ["Grappling Hook", "e24b5e53a4", "9f601d4a01"],
  46: ["Owl (Father)", "1bee0a028c", "da659913f0"],
  47: ["Erlang Shen", "14a358dc7f", "14a358dc7f"],
  48: ["Aerondight", "7b1e7979c5", "930f6c45d9"],
  49: ["Regis", "951ecf4600", "951ecf4600"],
  50: ["Blackreach", "2d3f95482a", "2d3f95482a"],
  51: ["Sandevistan", "aaf060d240", "ba63301d28"],
  52: ["Dragonlord Placidusax", "f256564cb8", "f256564cb8"],
  53: ["Consecrated Snowfield", "e226f95eda", "e226f95eda"],
  54: ["Millicent", "94c51ab01f", "94c51ab01f"],
  55: ["Slave Knight Gael", "612ec0ffd6", "612ec0ffd6"],
  56: ["Painted World of Ariandel", "9f9ee8b597", "6bb13641a5"],
  57: ["Ludwig", "88adfac963", "67da18b329"],
  58: ["dark Moon Greatword", "ac466165e8", "008a6f9c63"],
  59: ["Demon of Hatred", "45ea345de2", "45ea345de2"],
  60: ["Emma", "9701aba95e", "20ec92c20e"],
  61: ["Yellowbrow", "c8d0ec37f3", "c8d0ec37f3"],
  62: ["Pagoda Realm", "db7e253870", "83a5c201d7"],
  63: ["Vesemir", "b1375b714c", "83094beec8"],
  64: ["Iris", "c43b700744", "d345e0b3f1"],
  65: ["Serana", "7011659dfb", "e75e7f7e61"],
  66: ["Dawnbreaker", "21353af651", "21353af651"],
  67: ["Militech", "48c59162cc", "48c59162cc"],
  68: ["Sir Hans Capon", "8039f0317d", "fe738f3034"],
  69: ["Brok", "027eb81731", "8b91956043"],
  70: ["King Hrolf Kraki", "d5b7c6191d", "d5b7c6191d"],
  71: ["Yuna", "9e819d0624", "a2fa23f3ab"],
  72: ["Skull Face", "78b43b81a6", "78b43b81a6"],
  73: ["Gravity Hammer", "de4b7c76fe", "de4b7c76fe"],
  74: ["Godfrey", "06687fa5f8", "06687fa5f8"],
  75: ["Dragonlord Placidusax", "", "5ff6b252c3"],
  76: ["Goldmask", "", "e226f95eda"],
  77: ["Great Rune of the Unborn", "0c6108b15d", "0c6108b15d"],
  78: ["(Midra, Lord of Frenzied Flame)", "a244c30ff3", "f716280861"],
  79: ["Darkeater Midir", "81260eb0c9", "81260eb0c9"],
  80: ["Sister Friede", "c9e09a4695", "c9e09a4695"],
  81: ["Executioner's Greatsword", "7012c8905b", "7012c8905b"],
  82: ["Yuria of Londor", "4387728544", "4387728544"],
  83: ["The Ringed City", "d39f3d4ec3", "d39f3d4ec3"],
  84: ["(Laurence, the First Vicar)", "c4ba199151", "c4ba199151"],
  85: ["Djura", "a98eaa1b47", "e4f541078b"],
  86: ["Burial Blade", "9404abab35", "b55e1f74c2"],
  87: ["Living Failures", "9586e25a1c", "9586e25a1c"],
  88: ["Fishing Hamlet", "7faba86df0", "50aec06374"],
  89: ["(Divine Child of Rejuvenation)", "a995f7871d", "a995f7871d"],
  90: ["Inner Isshin", "13b7ed7ff4", "13b7ed7ff4"],
  91: ["Black Mortal Blade", "42a40c9d5a", "42a40c9d5a"],
  92: ["Sculptor", "8c9d7584dd", "da5d15a5aa"],
  93: ["Return Ending", "06562b5270", "06562b5270"],
  94: ["Gaunter O'Dimm", "5d8ef8beb2", "5d8ef8beb2"],
  95: ["(Dettlaff van der Eretein)", "4f5bf01104", "4f5bf01104"],
  96: ["Aerondight", "7ce8335a4d", "17458cbd2e"],
  97: ["(Emiel Regis)", "951ecf4600", "951ecf4600"],
  98: ["Toussaint", "6aaa055b53", "6aaa055b53"],
  99: ["Blackwall", "1f0beeeb4d", "1f0beeeb4d"],
  100: ["M'aiq the Liar", "86e821f47e", "86e821f47e"],
  101: ["Strange Man", "592642bdc4", "592642bdc4"],
  102: ["(The G-Man)", "19856271fd", "19856271fd"],
  103: ["(Big Boss)", "bc6cd2e23a", "bc6cd2e23a"],
  104: ["ماريو", "0bbf718557", "0bbf718557"],
  105: ["لويجي", "3cb66248d5", "3cb66248d5"],
  106: ["باوزر", "", "9173fa8ba7"],
  107: ["سونيك", "", "203e8884a7"],
  108: ["ميمير", "b13151195a", "d5a5095e8c"],
  109: ["ريوزو", "dc1866a5ae", "dc1866a5ae"],
  110: ["ناثان دريك", "982f799eee", "982f799eee"],
  111: ["ديموس", "", "7dd6943440"],
  112: ["سارة", "", "22e26185b7"],
  113: ["ألوي", "", "990a3b2f97"],
  114: ["Focus", "50a627ae58", "50a627ae58"],
  115: ["بينوكيو", "de612094ea", "de612094ea"],
  116: ["أوجيني", "0d552856df", "0d552856df"],
  117: ["وولف", "8004c68c37", "8004c68c37"],
  118: ["كورو", "bf920f3756", "bf920f3756"],
  119: ["Kliff", "2e03e9c68c", "2e03e9c68c"],
  120: ["Torrent", "e93ba172a3", "5bdb28e851"],
  121: ["Melina", "8992aa951f", "8992aa951f"],
  122: ["Roundtable Hold", "70f9cee1ce", "70f9cee1ce"],
  123: ["Margit, the Fell Omen", "78e5440618", "a823cf278a"],
  124: ["Yura", "e72c8b7880", "263fbce85e"],
  125: ["Shinobi Prosthetic", "635236e693", "635236e693"],
  126: ["Ashina Castle", "9b02736795", "9b02736795"],
  127: ["Chained Ogre", "3b93f46892", "c8275e2496"],
  128: ["Greymanes", "e899c78b14", "e3803fe5af"],
  129: ["Pywel", "21f9ba21df", "9fbf89ade6"],
  130: ["Godrick the Grafted", "251feef331", "251feef331"],
  131: ["Leyndell", "cb1c7c8c6c", "ae2a6801d7"],
  132: ["Fia", "78323b0edc", "e42567a3fb"],
  133: ["Blaidd", "bbc5cd1b4e", "bbc5cd1b4e"],
  134: ["Maliketh’s Black Blade", "c7defefe4a", "c7defefe4a"],
  135: ["Genichiro Ashina", "008b75893e", "24f56c0042"],
  136: ["Guardian Ape", "c8d40eba03", "7f6997d6bf"],
  137: ["Oongka", "d3d5c71ab3", "d93a63168c"],
  138: ["Nokron, Eternal City", "2365302a36", "2365302a36"],
  139: ["Mohg, the Omen", "46f73ce596", "90a901b20e"],
  140: ["Forlorn Hound Evergaol", "3dba7e6a86", "747f9d06cf"],
  141: ["Miquella’s Haligtree", "b157426357", "b157426357"],
  142: ["Ranni’s Dark Moon", "e41d1905da", ""],
  143: ["Isshin Ashina", "83117d3e70", "83117d3e70"],
  144: ["Divine Realm", "76d5316fbf", "c71b879b0d"],
  145: ["Bloodsmoke Ninjutsu", "535d5c4542", "642619e8ad"],
  146: ["Damiane", "6f2d8b3470", "6f2d8b3470"],
  147: ["Parade Master", "682e883cec", "682e883cec"],
};

const fp = s => s ? crypto.createHash("sha1").update(s).digest("hex").slice(0, 10) : "";
const norm = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const BATCH = 10, TIMEOUT_MS = 15000, RETRIES = 4;

// Single .get() calls, not getAll(): getAll() hung every time from Cloud Shell
// when fix-emoji-shift.mjs was first run (see the note there).
async function getOne(ref) {
  for (let a = 1; a <= RETRIES; a++) {
    try {
      return await Promise.race([ref.get(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS))]);
    } catch (e) {
      console.log(`  ! ${ref.id} attempt ${a}/${RETRIES}: ${e.message}`);
      if (a === RETRIES) throw new Error(`${ref.id} failed ${RETRIES} times — giving up`);
    }
  }
}
async function readRange() {
  const docs = new Map();
  const ids = []; for (let i = FIRST; i <= LAST; i++) ids.push("q" + i);
  for (let i = 0; i < ids.length; i += BATCH) {
    const snaps = await Promise.all(ids.slice(i, i + BATCH).map(id => getOne(col.doc(id))));
    snaps.forEach(s => { if (s.exists) docs.set(s.id, s.data() || {}); });
    process.stdout.write(`  read ${Math.min(i + BATCH, ids.length)}/${ids.length}\r`);
  }
  console.log("");
  return docs;
}

async function undo(file) {
  const saved = JSON.parse(readFileSync(file, "utf8"));
  console.log(`${APPLY ? "*** APPLY ***" : "--- DRY RUN (add --apply) ---"}  restoring ${Object.keys(saved.docs).length} docs from ${file}`);
  if (saved.category !== CATEGORY) throw new Error("backup is for a different category");
  if (!APPLY) { console.log("Dry run — nothing written."); return; }
  for (const [id, v] of Object.entries(saved.docs)) await col.doc(id).update({ image: v.image, answerImage: v.answerImage });
  console.log("✓ restored. Run touch-categories.mjs so devices refetch.");
}

async function main() {
  if (UNDO) return undo(UNDO);
  console.log(APPLY ? "*** APPLY — this will write ***" : "--- DRY RUN (pass --apply to write) ---");
  console.log(`category ${CATEGORY}  rows q${FIRST}–q${LAST}\n`);
  console.log("reading…");
  const docs = await readRange();

  // 1. PRECONDITION — everything or nothing.
  const bad = [];
  for (let i = FIRST; i <= LAST; i++) {
    const d = docs.get("q" + i), [a, fi, fa] = EXPECTED[i];
    if (!d) { bad.push(`q${i}: missing`); continue; }
    if (norm(d.a) !== a) bad.push(`q${i}: answer is "${norm(d.a)}", audited "${a}"`);
    else if (fp(d.image) !== fi || fp(d.answerImage) !== fa) bad.push(`q${i} (${a}): pictures differ from the audited ones`);
  }
  if (bad.length) {
    console.log(`REFUSING — ${bad.length} row(s) are not in the state this script was written against:`);
    bad.slice(0, 15).forEach(b => console.log("  • " + b));
    if (bad.length > 15) console.log(`  … and ${bad.length - 15} more`);
    console.log("\nIf the category was already repaired by hand, that is the likely reason. Nothing was written.");
    process.exit(1);
  }

  // 2. PLAN — row N takes the pictures of row N+1; the last row is cleared.
  const plan = [];
  for (let i = FIRST; i <= LAST; i++) {
    const src = docs.get("q" + (i + 1));
    plan.push({ id: "q" + i, answer: EXPECTED[i][0],
      image: src ? (src.image || "") : "", answerImage: src ? (src.answerImage || "") : "",
      from: i < LAST ? "q" + (i + 1) : "(cleared — its own picture was lost)" });
  }
  const changes = plan.filter(p => {
    const cur = docs.get(p.id); return (cur.image || "") !== p.image || (cur.answerImage || "") !== p.answerImage;
  });
  plan.forEach(p => console.log(`  ${p.id.padEnd(5)} ${p.answer.slice(0, 34).padEnd(36)} <- ${p.from}`));
  console.log(`\n${changes.length} of ${plan.length} documents change.`);
  if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); return; }

  // 3. BACKUP first, then write.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `tools/games-shift-backup-${stamp}.json`;
  const saved = { category: CATEGORY, at: new Date().toISOString(), docs: {} };
  changes.forEach(p => { const c = docs.get(p.id); saved.docs[p.id] = { image: c.image || "", answerImage: c.answerImage || "" }; });
  writeFileSync(file, JSON.stringify(saved));
  console.log(`\nbackup written: ${file}  (keep it until you have checked the game)`);
  for (const p of changes) await col.doc(p.id).update({ image: p.image, answerImage: p.answerImage });
  console.log(`\n✓ wrote ${changes.length} documents`);
  console.log("\nNEXT — without this, devices keep showing their cached pictures:");
  console.log("  node tools/touch-categories.mjs --only pub-1783510423551-6465 --apply");
  console.log("\nStill needs a NEW picture by hand: q147 (Parade Master).");
}
main().catch(e => { console.error("\nFAILED:", e && e.message ? e.message : e); process.exit(1); });
