// What "delete my account" actually means, stated as data rather than as code
// buried in a Cloud Function.
//
// App Store guideline 5.1.1(v) requires an app with account creation to offer
// account DELETION from inside the app — not a support email, not a deactivate
// switch. It permits keeping what law or legitimate business requires, provided
// the person is no longer identifiable by it. That is the whole design here:
//
//   ERASE      — the record IS the person's data. It goes.
//   ANONYMISE  — the record is a business fact we must keep (a sale happened,
//                a code was redeemed, a category is in the public catalogue),
//                but nothing in it should still point at a human. The fact
//                stays, the identity is overwritten.
//
// Keeping this table separate from the IO makes it reviewable at a glance and
// unit-testable without Firebase. Adding a new per-user collection to
// firestore.rules and forgetting it here is the failure mode this file exists
// to make obvious — ACCOUNT_SCOPES is meant to be read next to the rules file.

// The tombstone written over an identity. Not an empty string: a blank uid
// reads as "we never knew" and would silently match other blank-uid rows in an
// admin panel that groups by uid. This value is unmistakable in a console.
const ERASED_UID = "deleted-account";

// Top-level documents whose id IS the uid, and which are purely this person's.
const ERASE_DOCS = [
  "users",        // the saved-game blob: games, teams, play history
  "entitlements", // paid games. Deleting the account destroys them — see below.
  "usage",        // billing counter + the self-asserted email stamp
  "orders",       // a pending manual purchase request
  "players",      // new-vs-returning play counters
  "commThrottle", // community submission rate-limit stamp
  "admins",       // staff flags: an account that no longer exists is not staff
  "editors",
];

// Subcollections under a per-uid parent. The parent doc may not exist (Firestore
// lets a subcollection hang off a missing document), so these are listed
// separately and enumerated rather than assumed.
const ERASE_SUBCOLLECTIONS = [
  { parent: "inbox", sub: "msgs" },        // developer announcements + reward messages
  { parent: "feedback", sub: "messages" }, // the player↔dev conversation
];

// community/{catId}/votes/{uid} — the person's up-votes, one doc per category
// they backed. It does not fit the shape above: the uid is the LEAF, not the
// parent, so there is no single path to delete. A collection-group query cannot
// filter on document id either (that comparison needs full paths), so the only
// way is to walk the categories and delete the one doc that may be under each.
// The community collection is tens of documents, so walking it is cheap.
// ⚠️ Removing a vote must also decrement the parent's `votes` counter, or the
// public tally keeps counting a person who no longer exists. Same batch, so the
// doc and the count can never disagree.
const VOTES_SUB = "votes";
const VOTES_PARENT = "community";
const VOTES_COUNTER = "votes";

// Records we keep, with the identity overwritten. `match` names the field that
// holds the uid; `clear` names fields that carry personal data and are set to
// the tombstone or removed outright.
const ANONYMISE = [
  // A sale is an accounting record. It must survive — the revenue happened —
  // but it should not name a customer who asked to be forgotten.
  { collection: "sales", match: "uid", clearFields: ["email"] },
  // A redeemed activation code records that a grant was made. Same reasoning.
  { collection: "codes", match: "redeemedBy", clearFields: ["redeemedEmail"] },
  // A community category that has been APPROVED is public content other people
  // play. Removing it would punish everyone else for one author's departure, so
  // the category stays and stops carrying their name. An UNAPPROVED submission
  // is not in anyone's catalogue and is erased instead — see communityAction().
  { collection: "community", match: "authorUid", clearFields: ["authorName"] },
];

// Every uid-keyed place in firestore.rules, and what happens to each. Anything
// listed in the rules and missing here is a leak; the unit test compares the
// two lists so the omission fails CI rather than review.
const ACCOUNT_SCOPES = ERASE_DOCS.map(c => ({ collection: c, action: "erase" }))
  .concat(ERASE_SUBCOLLECTIONS.map(s => ({ collection: s.parent, action: "erase" })))
  .concat([{ collection: VOTES_SUB, action: "erase" }])
  .concat(ANONYMISE.map(a => ({ collection: a.collection, action: "anonymise" })));

/* An approved community category survives with its author scrubbed; a pending
   or rejected one is erased outright. Stated as a function because "is this
   content anyone else can see" is the question, and reading it off `approved`
   directly at the call site is how that intent gets lost. */
function communityAction(doc) {
  return doc && doc.approved === true ? "anonymise" : "erase";
}

/* The replacement values for an anonymised doc. Returns a patch, never a whole
   document — a full overwrite would drop fields this file has never heard of,
   which for a sales row means losing the amount. */
function anonymisePatch(rule) {
  const patch = { [rule.match]: ERASED_UID };
  (rule.clearFields || []).forEach(f => { patch[f] = ""; });
  return patch;
}

/* Guard for the callable. Deleting an account is irreversible and destroys paid
   entitlements, so the request must be an authenticated user asking about
   THEMSELVES — never an admin passing someone else's uid, which would turn one
   compromised staff account into a way to wipe customers. Admin removal, if it
   is ever wanted, should be its own deliberate tool. */
function mayErase(authUid, requestedUid) {
  if (!authUid) return { ok: false, reason: "unauthenticated" };
  if (requestedUid && requestedUid !== authUid) return { ok: false, reason: "self-only" };
  return { ok: true, uid: authUid };
}

module.exports = {
  ERASED_UID, ERASE_DOCS, ERASE_SUBCOLLECTIONS, ANONYMISE, ACCOUNT_SCOPES,
  VOTES_SUB, VOTES_PARENT, VOTES_COUNTER,
  communityAction, anonymisePatch, mayErase,
};
