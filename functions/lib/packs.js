// The AUTHORITATIVE pack table. It lives on the server precisely because the
// client must never get to say what it bought: a browser can call anything, so
// if price/size came from the request, a player could ask for the 15-game pack
// and pay for the 2-game one. The client sends only a pack id; everything that
// matters — how many games, whether it's premium, and the amount charged — is
// looked up HERE.
//
// Keep in sync with PLAY_PLANS in game-mobile.html (same ids, same numbers).
// The unit test asserts the shape so a typo can't ship a free 15-game pack.
const PACKS = {
  g2:  { id: "g2",  name: "باقة لعبتين",   games: 2,  premium: false, amountOMR: 0.9 },
  g5:  { id: "g5",  name: "باقة ٥ ألعاب",  games: 5,  premium: false, amountOMR: 1.5 },
  g15: { id: "g15", name: "باقة ١٥ لعبة",  games: 15, premium: false, amountOMR: 3.5 },
};

function getPack(packId) {
  const p = PACKS[String(packId || "")];
  return p ? Object.assign({}, p) : null;
}

// Thawani (and most gateways) bill in the smallest unit — baisa for OMR, 1000
// per rial. Rounding, not truncation: 1.5 * 1000 is 1499.9999… in float, and
// truncating would silently undercharge by a baisa on every single sale.
function toBaisa(amountOMR) {
  return Math.round((Number(amountOMR) || 0) * 1000);
}

module.exports = { PACKS, getPack, toBaisa };
