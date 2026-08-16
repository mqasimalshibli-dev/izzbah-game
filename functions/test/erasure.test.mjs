// Unit tests for account erasure. No Firebase, no network.
//
// This is the code that decides what survives when somebody asks to be deleted,
// so the two failure directions are both real and both bad: leaving personal
// data behind (a privacy failure and an App Store rejection), or deleting a
// financial record that has to be kept.
//
// Run: node functions/test/erasure.test.mjs
import { createRequire } from "module";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const require = createRequire(import.meta.url);
const {
  ERASED_UID, ERASE_DOCS, ERASE_SUBCOLLECTIONS, ANONYMISE, ACCOUNT_SCOPES,
  communityAction, anonymisePatch, mayErase,
} = require("../lib/erasure.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const checks = [];
const check = (n, ok, extra) => {
  checks.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`);
};

// ---- the authorisation gate ------------------------------------------------
// The one that matters most: this endpoint destroys paid content, so it must be
// self-service only. An admin able to pass someone else's uid would turn one
// compromised staff account into a customer-wiping tool.
check("a signed-out caller is refused", mayErase(null).ok === false);
check("...as unauthenticated, not permission-denied", mayErase(null).reason === "unauthenticated");
check("a signed-in caller may erase themselves", mayErase("u1").ok === true);
check("...and passing their OWN uid explicitly is fine", mayErase("u1", "u1").ok === true);
check("nobody may erase somebody else — not even an admin", mayErase("u1", "u2").ok === false);
check("...and that refusal is permission-denied", mayErase("u1", "u2").reason === "self-only");
check("the uid acted on is the AUTHENTICATED one, never the request body",
  mayErase("real-uid", "real-uid").uid === "real-uid" && mayErase("real-uid").uid === "real-uid");

// ---- what goes, and what stays ---------------------------------------------
check("the paid balance is ERASED, not kept (a dead uid must not hold games)",
  ERASE_DOCS.includes("entitlements"));
check("the saved-game blob is erased", ERASE_DOCS.includes("users"));
check("staff flags go with the account", ERASE_DOCS.includes("admins") && ERASE_DOCS.includes("editors"));
check("the developer conversation is erased, not anonymised",
  ERASE_SUBCOLLECTIONS.some(s => s.parent === "feedback"));

// A sale is an accounting record: the revenue happened whether or not the
// customer still exists. Deleting it would quietly rewrite the books.
const sales = ANONYMISE.find(r => r.collection === "sales");
check("a SALE survives the deletion", !!sales && !ERASE_DOCS.includes("sales"));
check("...with the customer's uid replaced by a tombstone",
  anonymisePatch(sales).uid === ERASED_UID);
check("...and their email cleared", anonymisePatch(sales).email === "");
check("the tombstone is recognisable, not an empty string (blank uids collide)",
  ERASED_UID.length > 0 && ERASED_UID !== "-" && /[a-z]/.test(ERASED_UID));

check("an anonymise patch touches ONLY the identity fields — a full overwrite "
  + "of a sales row would lose the amount",
  Object.keys(anonymisePatch(sales)).sort().join(",") === "email,uid");

// ---- community content -----------------------------------------------------
check("an APPROVED community category stays, with its author scrubbed",
  communityAction({ approved: true }) === "anonymise");
check("a PENDING submission is erased — nobody else can see it anyway",
  communityAction({ approved: false }) === "erase");
check("a missing/garbage doc erases rather than surviving un-scrubbed",
  communityAction(null) === "erase" && communityAction({}) === "erase");
check("approval is checked strictly — a truthy string must not keep the author's name",
  communityAction({ approved: "yes" }) === "erase");

// ---- the leak check --------------------------------------------------------
// Every uid-keyed collection in firestore.rules has to appear here. Adding a new
// per-user collection and forgetting the erasure path is the failure this test
// exists for: it leaves personal data behind silently, and no other test in the
// suite would notice.
const rules = readFileSync(join(ROOT, "firestore.rules"), "utf8");
const uidKeyed = [...rules.matchAll(/match \/([A-Za-z]+)\/\{(uid|userId)\}/g)].map(m => m[1]);
const covered = new Set(ACCOUNT_SCOPES.map(s => s.collection));
// commThrottle-style helpers included; these are the ones deliberately NOT
// erased, each for a stated reason.
const EXEMPT = {};
const missed = [...new Set(uidKeyed)].filter(c => !covered.has(c) && !EXEMPT[c]);
check(`every uid-keyed collection in firestore.rules has an erasure path (${uidKeyed.length} found)`,
  missed.length === 0, missed.length ? "not handled: " + missed.join(", ") : "none missed");

check("no collection is both erased and anonymised (the two would race)",
  !ANONYMISE.some(a => ERASE_DOCS.includes(a.collection)));

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
