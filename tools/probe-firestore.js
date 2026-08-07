// Which database, and which transport, can actually be read from here.
// gRPC keeps a long-lived HTTP/2 connection; some environments (and some
// proxies) stall it silently, which looks exactly like DEADLINE_EXCEEDED.
// preferRest uses plain HTTPS instead, so comparing the two separates a
// database problem from a transport problem.
const { Firestore } = require("@google-cloud/firestore");
const CASES = [
  ["(default)",    false], ["(default)",    true],
  ["restore-aug5", false], ["restore-aug5", true],
];
(async () => {
  console.log("lib", require("@google-cloud/firestore/package.json").version, "\n");
  for (const [databaseId, preferRest] of CASES) {
    const db = new Firestore({ projectId: "izzbahgame", databaseId, preferRest });
    const label = `${databaseId.padEnd(13)} ${preferRest ? "REST" : "gRPC"}`;
    const t = Date.now();
    const res = await Promise.race([
      db.collection("categories").limit(1).get()
        .then(s => `OK   ${s.size} doc   ${Date.now() - t}ms`)
        .catch(e => `ERR  ${e.code} ${String(e.message).slice(0, 50)}`),
      new Promise(r => setTimeout(() => r("TIMEOUT  >25s"), 25000)),
    ]);
    console.log(label, " ", res);
    try { await db.terminate(); } catch (e) {}
  }
})();
