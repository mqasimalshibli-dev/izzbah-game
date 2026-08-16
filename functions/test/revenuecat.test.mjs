// Unit tests for the RevenueCat webhook decision. No Firebase, no network.
//
// This endpoint is the ONLY path by which paid content can be granted, so the
// tests are written from the attacker's side first: what does it take to get
// free games out of it, and does every one of those attempts fail closed?
//
// Run: node functions/test/revenuecat.test.mjs
import { createRequire } from "module";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const require = createRequire(import.meta.url);
const { PRODUCT_PACKS, GRANTING_TYPES, rcAuthorised, parseRcEvent, rcDecision } =
  require("../lib/revenuecat.js");
const { PACKS } = require("../lib/packs.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const checks = [];
const check = (n, ok, extra) => {
  checks.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`);
};

const SECRET = "s3cret-header-value";
const purchase = (over) => ({
  api_version: "1.0",
  event: Object.assign({
    id: "evt-1", type: "NON_RENEWING_PURCHASE",
    app_user_id: "firebase-uid-1", product_id: "com.izzbah.game.games5",
    environment: "PRODUCTION",
  }, over || {}),
});
const parsedOK = (over) => parseRcEvent(purchase(over));

// ---- the header is the whole security boundary -----------------------------
check("the right header is accepted", rcAuthorised(SECRET, SECRET));
check("a wrong header is refused", !rcAuthorised("nope", SECRET));
check("an empty header is refused", !rcAuthorised("", SECRET));
check("a missing header is refused", !rcAuthorised(undefined, SECRET));
// The dangerous one: if the secret is unset in the environment, a naive compare
// of "" === "" would let an UNAUTHENTICATED caller grant themselves games.
check("NO configured secret refuses everything (never fails open)",
  !rcAuthorised("", "") && !rcAuthorised("anything", "") && !rcAuthorised("", undefined));
check("a prefix of the secret is refused", !rcAuthorised(SECRET.slice(0, -1), SECRET));
check("the secret plus a suffix is refused", !rcAuthorised(SECRET + "x", SECRET));

// ---- reading the notification ----------------------------------------------
const p = parsedOK();
check("a purchase parses", p.ok === true);
check("...and is recognised as granting", p.grants === true);
check("...with the pack resolved from the product id", p.packId === "g5", p.packId);
check("...and the event id kept for de-duplication", p.eventId === "evt-1");
check("a body with no event is refused", parseRcEvent({}).ok === false);
check("...and so is junk", parseRcEvent(null).ok === false && parseRcEvent({ event: "x" }).ok === false);
check("an event with no id is refused — without one, a retry double-grants",
  parseRcEvent(purchase({ id: "" })).ok === false);

// RevenueCat's own guidance: look the customer up by app_user_id,
// original_app_user_id AND the aliases array.
const aliased = parsedOK({ app_user_id: "rc-anon", original_app_user_id: "firebase-uid-1", aliases: ["rc-anon", "other"] });
check("every id RevenueCat offers is collected", aliased.candidates.length === 3, aliased.candidates.join(","));
check("...in preference order, app_user_id first", aliased.candidates[0] === "rc-anon");
check("...with duplicates removed", new Set(aliased.candidates).size === aliased.candidates.length);
check("blank ids are dropped rather than becoming an empty-uid grant",
  parsedOK({ app_user_id: "", original_app_user_id: "  ", aliases: [""] }).candidates.length === 0);

// ---- the decision ----------------------------------------------------------
check("a real purchase by a known user grants", rcDecision(p, "firebase-uid-1", false).grant === true);
check("...the right pack", rcDecision(p, "u", false).packId === "g5");

// Every way this could hand out something for nothing:
check("an unknown PRODUCT grants nothing (not a default pack)",
  rcDecision(parsedOK({ product_id: "com.someone.else.pro" }), "u", false).grant === false);
check("an unknown USER grants nothing", rcDecision(p, "", false).grant === false);
check("an unparsed body grants nothing", rcDecision({ ok: false }, "u", true).grant === false);
check("a null decision input grants nothing", rcDecision(null, "u", true).grant === false);
check("a TEST event grants nothing",
  rcDecision(parsedOK({ type: "TEST" }), "u", false).grant === false);
check("a CANCELLATION grants nothing",
  rcDecision(parsedOK({ type: "CANCELLATION" }), "u", false).grant === false);
check("...and is reported as a reversal, not silently ignored",
  rcDecision(parsedOK({ type: "CANCELLATION" }), "u", false).reason === "reversal");
check("an unrecognised event type grants nothing",
  rcDecision(parsedOK({ type: "SOMETHING_NEW" }), "u", false).grant === false);

// Sandbox purchases are free to make and anyone can create a sandbox account,
// so they must not mint real games for the public.
const sb = parsedOK({ environment: "SANDBOX" });
check("a SANDBOX purchase is flagged", sb.sandbox === true);
check("...and grants nothing to an ordinary player", rcDecision(sb, "u", false).grant === false);
check("...with the reason named, so the log says why", rcDecision(sb, "u", false).reason === "sandbox");
check("...but DOES grant to staff, so the flow can be tested end to end",
  rcDecision(sb, "u", true).grant === true);
check("environment is matched case-insensitively",
  parsedOK({ environment: "sandbox" }).sandbox === true);
check("production is not mistaken for sandbox", p.sandbox === false);

// ---- the two ends have to agree --------------------------------------------
// The client sends a product id; this file turns it back into a pack; packs.js
// says how many games that is. A break anywhere along there is a payment that
// takes money and delivers nothing.
check("every product maps to a pack that really exists in packs.js",
  Object.values(PRODUCT_PACKS).every(id => !!PACKS[id]),
  Object.values(PRODUCT_PACKS).join(","));
check("every pack is purchasable — one with no product could never be sold",
  Object.keys(PACKS).every(id => Object.values(PRODUCT_PACKS).indexOf(id) !== -1));
check("no two products map to the same pack",
  new Set(Object.values(PRODUCT_PACKS)).size === Object.values(PRODUCT_PACKS).length);

// And the CLIENT's map, read straight out of the game, must match this one —
// they are edited in different files and nothing else compares them.
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const block = html.slice(html.indexOf("const STORE_PRODUCTS = {"));
const clientIds = [...block.slice(0, block.indexOf("};")).matchAll(/"(com\.izzbah\.[^"]+)"/g)].map(m => m[1]);
check(`the client's product ids are exactly the server's (${clientIds.length} found)`,
  clientIds.length === Object.keys(PRODUCT_PACKS).length
  && clientIds.every(id => !!PRODUCT_PACKS[id]),
  clientIds.join(", "));

// ---- consumables are the shape we actually sell ----------------------------
check("NON_RENEWING_PURCHASE — the consumable event — is a granting type",
  GRANTING_TYPES.indexOf("NON_RENEWING_PURCHASE") !== -1);

const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
