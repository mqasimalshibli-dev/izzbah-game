// Bump updatedAt on the restored categories, so every client refetches media.
//
// The images were written back into the /questions subcollection, but the
// PARENT doc was left untouched — and its updatedAt is what the client uses as
// the media cache key:
//
//   loadCategoryMedia(catId, ver):
//     if (hit && ver > 0 && hit.ver === ver) return hit.qs;   // cached
//
// So a device that cached the blanked media under the old updatedAt keeps
// serving blanks forever, however good the data in Firestore now is. Bumping
// updatedAt changes the key, every cache entry misses, and the pictures are
// refetched once per device.
//
// But bumping updatedAt ALONE is not enough, which is the trap: the client
// short-circuits the whole catalogue on a single revision doc —
//
//   if (freshRev === cachedRev && haveCats) { applyCachedCategories(cache); return; }
//
// — and never reads the category documents at all, so it never sees the new
// updatedAt. meta/catalog.rev has to move too, exactly as the app's own
// bumpCatalogRev() does on publish. Both, or neither works.
//
//   node tools/touch-categories.mjs                # dry run
//   node tools/touch-categories.mjs --apply
import { Firestore } from "@google-cloud/firestore";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const PROJECT = "izzbahgame";

// The categories the restore wrote to.
const IDS = [
  "culture", "history",
  "pub-1783170059396-601", "pub-1783170356019-2501", "pub-1783189666048-7547",
  "pub-1783453062866-1028", "pub-1783510423551-6465", "pub-1784240484235-8039",
];

const db = new Firestore({ projectId: PROJECT });

const main = async () => {
  console.log(APPLY ? "*** APPLY — bumping updatedAt ***\n" : "--- DRY RUN (add --apply) ---\n");
  for (const id of IDS) {
    const ref = db.collection("categories").doc(id);
    const snap = await ref.get();
    if (!snap.exists) { console.log(`${id.padEnd(26)} MISSING`); continue; }
    const before = (snap.data() || {}).updatedAt;
    const was = before && before.toDate ? before.toDate().toISOString() : String(before);
    if (APPLY) {
      // update(), not set(): only this one field moves. The parent doc also
      // carries the cover image and the text-only question list, and the
      // deployed rules field-lock its key set.
      await ref.update({ updatedAt: Firestore.FieldValue.serverTimestamp() });
      console.log(`${id.padEnd(26)} ${was}  ->  now`);
    } else {
      console.log(`${id.padEnd(26)} ${was}  ->  would bump`);
    }
  }
  // The catalogue revision, without which none of the above is ever read.
  const meta = db.collection("meta").doc("catalog");
  const cur = await meta.get();
  const rev = ((cur.data() || {}).rev) || 0;
  if (APPLY) {
    await meta.set({ rev: Firestore.FieldValue.increment(1),
                     updatedAt: Firestore.FieldValue.serverTimestamp() }, { merge: true });
    console.log(`\nmeta/catalog rev ${rev} -> ${rev + 1}`);
  } else {
    console.log(`\nmeta/catalog rev ${rev} -> would bump to ${rev + 1}`);
  }
  console.log(APPLY
    ? "\nDone. Hard-refresh the game; each device refetches that category's media once."
    : "\nDry run. Re-run with --apply.");
};

main().catch(e => { console.error("FAILED:", e && e.message ? e.message : e); process.exit(1); });
