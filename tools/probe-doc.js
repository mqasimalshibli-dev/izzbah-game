// Time a SINGLE question-document read, like for like across both databases.
//
// listDocuments() on the restored database returns in ~1.7s, but getAll() of
// five question docs never comes back. Category parent docs read fine. So the
// question is whether it is the restored database that is slow, or documents
// carrying ~50 KB of base64 — and the only way to tell is to read one of each.
const { Firestore } = require("@google-cloud/firestore");
const CASES = [
  ["restore-aug5", "culture", "q0"],   // has an image in the backup
  ["(default)",    "cars",    "q0"],   // still has its image, same shape
  ["(default)",    "culture", "q0"],   // wiped, so tiny — a size control
];
(async () => {
  for (const [databaseId, cat, id] of CASES) {
    const db = new Firestore({ projectId: "izzbahgame", databaseId });
    const t = Date.now();
    const res = await Promise.race([
      db.collection("categories").doc(cat).collection("questions").doc(id).get()
        .then(d => {
          const v = d.data() || {};
          const n = (v.image || "").length + (v.answerImage || "").length;
          return `OK  ${Date.now() - t}ms  ${d.exists ? (n ? (n / 1024).toFixed(0) + " KB img" : "no img") : "MISSING"}`;
        })
        .catch(e => `ERR ${e.code} ${String(e.message).slice(0, 45)}`),
      new Promise(r => setTimeout(() => r("TIMEOUT >45s"), 45000)),
    ]);
    console.log(`${databaseId.padEnd(13)} ${cat.padEnd(8)}/${id}  ${res}`);
    try { await db.terminate(); } catch (e) {}
  }
})();
