// Unit tests for the purchase fulfilment logic. No Firebase, no network — this
// is the code that decides whether someone receives paid content, so it is
// deliberately pure and tested on its own.
//
// Run: node functions/test/fulfilment.test.mjs
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { PACKS, getPack, toBaisa } = require("../lib/packs.js");
const { grantDecision, entitlementUpdate, GRANTED, FAILED, PENDING } = require("../lib/grant.js");

const checks = [];
const check = (n, ok) => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };

// ---- the pack table is the source of truth for what was bought -------------
check("every pack has an id, games count and price",
  Object.values(PACKS).every(p => p.id && Number.isInteger(p.games) && p.games > 0 && typeof p.amountOMR === "number"));
check("pack ids match their keys (a typo here would sell the wrong pack)",
  Object.entries(PACKS).every(([k, p]) => k === p.id));
check("an unknown pack id resolves to null, never a default", getPack("g999") === null && getPack("") === null);
check("getPack returns a COPY (a caller can't mutate the price table)", (() => {
  const a = getPack("g5"); a.games = 9999;
  return getPack("g5").games === 5;
})());

// ---- money conversion ------------------------------------------------------
check("OMR converts to baisa by rounding, not truncation (1.5 → 1500)", toBaisa(1.5) === 1500);
check("every pack's price converts to a whole number of baisa",
  Object.values(PACKS).every(p => Number.isInteger(toBaisa(p.amountOMR))));
check("the 3.5 rial pack is 3500 baisa (float truncation would give 3499)", toBaisa(3.5) === 3500);

// ---- idempotency: the single most important property here -------------------
const pending = { uid: "u1", packId: "g5", status: PENDING };
check("a paid, pending purchase grants", grantDecision(pending, true).grant === true);
check("a REPEAT callback for an already-granted purchase does NOT grant again",
  grantDecision({ ...pending, status: GRANTED }, true).grant === false);
check("…and says why, so the retry is visible in the logs",
  grantDecision({ ...pending, status: GRANTED }, true).reason === "already-granted");
check("an unpaid callback never grants", grantDecision(pending, false).grant === false);
check("a failed purchase never grants, even if a later callback claims paid",
  grantDecision({ ...pending, status: FAILED }, true).grant === false);
check("an unknown purchase reference never grants", grantDecision(null, true).grant === false);
check("a purchase with no uid never grants (nothing to credit)",
  grantDecision({ packId: "g5", status: PENDING }, true).grant === false);

// ---- accumulation: a pack ADDS, it must never overwrite --------------------
check("buying 5 games on top of 3 gives 8, not 5",
  entitlementUpdate({ gamesAllowed: 3 }, getPack("g5")).gamesAllowed === 8);
check("buying with no prior entitlement starts the balance",
  entitlementUpdate({}, getPack("g2")).gamesAllowed === 2);
check("a games pack does NOT touch premium",
  entitlementUpdate({ premium: true }, getPack("g15")).premium === undefined);
check("…so a premium subscriber buying a games pack keeps premium", (() => {
  const current = { premium: true, gamesAllowed: 0 };
  const merged = { ...current, ...entitlementUpdate(current, getPack("g15")) };
  return merged.premium === true && merged.gamesAllowed === 15;
})());
check("the update never includes fields it shouldn't (no expiresAt clobber)",
  Object.keys(entitlementUpdate({ expiresAt: "x", gamesAllowed: 1 }, getPack("g2"))).join(",") === "gamesAllowed");

// ---- a premium pack, if one is ever added, turns premium on ----------------
check("a premium pack sets premium true",
  entitlementUpdate({}, { games: 0, premium: true }).premium === true);
check("a premium pack with no games doesn't write gamesAllowed",
  entitlementUpdate({}, { games: 0, premium: true }).gamesAllowed === undefined);

// ---- the client's shown price must equal the server's charged price --------
// These live in two files. If they drift, the game advertises one price and the
// gateway bills another — the kind of bug you find out about from a customer.
{
  const fs = require("fs");
  const path = new URL("../../game-mobile.html", import.meta.url);
  const html = fs.readFileSync(path, "utf8");
  const block = (html.match(/const PLAY_PLANS = \[([\s\S]*?)\n    \];/) || [, ""])[1];
  const client = [...block.matchAll(/id: "([^"]+)"[\s\S]*?priceOMR: ([\d.]+), games: (\d+), premium: (true|false)/g)]
    .map(m => ({ id: m[1], priceOMR: +m[2], games: +m[3], premium: m[4] === "true" }));

  check(`the client advertises ${client.length} packs and the server knows all of them`,
    client.length > 0 && client.every(c => !!PACKS[c.id]));
  check("no pack exists on the server that the client never shows",
    Object.keys(PACKS).every(id => client.some(c => c.id === id)));
  check("every pack's games count matches between client and server",
    client.every(c => PACKS[c.id] && PACKS[c.id].games === c.games));
  check("every pack's PRICE matches between client and server",
    client.every(c => PACKS[c.id] && PACKS[c.id].amountOMR === c.priceOMR));
  check("every pack's premium flag matches between client and server",
    client.every(c => PACKS[c.id] && PACKS[c.id].premium === c.premium));
}

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
