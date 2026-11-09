// state.js - createGame / startGame, starting a voyage (ring, deal, mooring order), and cloneState.
//
// SERIALISABILITY IS LOAD-BEARING: every state survives JSON.parse(JSON.stringify(state))
// unchanged. Plain JSON only, null never undefined, no functions or class instances.
//
// Seats are 0..n-1 clockwise; "left of X" is (X + 1) mod n. Who is human or bot is a UI
// concern and is NOT in the engine state. Everything "per player" is an array indexed by seat.
// Kit plumbing names are kept: a "hand" (handNo, handLog, params.handsPerGame) is a VOYAGE.
//
// The state shape (each field is described where it is created, in startGame below):
//   kind 'game', schema, seed, n, rules, params, rulesCode, rng, deals, manualSeats,
//   firstDealer, dealer, handNo, handSize,
//   phase 'moor' | 'play' | 'voyageEnd' | 'over', toAct, leader,
//   ring, islandFaces, ships, startIslands, mooringOrder,
//   hands, setAside, serpentRows, wonPiles, tricksWon, serpentsTaken, voyageStats,
//   trickNo, trick, tricks, handLog, totals, measures, result.
//
// 'voyageEnd' is a transient phase (R8.4): it is set while a voyage is reckoned inside applyAction.
// A state returned by applyAction is never in 'voyageEnd': it is the next voyage's 'moor', or 'over'.

import { SUITS, CONSTANTS, resolveVariants, rulesCode, deriveParams } from './rules.js';
import { makeRng, rngInt, shuffle } from './rng.js';
import { fullDeck, sortCards, isCard, allIslandFaces, islandFaceCargo } from './cards.js';

const filled = (n, f) => Array.from({ length: n }, f);

/** Counters kept for stats, analytics and balance work (over the whole game). */
export function emptyMeasures(n) {
  return {
    hands: 0, // completed voyages
    tricks: 0, // completed tricks
    leaderWins: 0, // tricks won by their leader
    cleanTricks: 0, // tricks with no serpent in them (D10 pos%)
    trades: 0, // trade cards played (R4.3 rung 2)
    tradesWon: 0, // tricks won by a trade card
    tradeSerpentWins: 0, // ... that held at least one serpent
    noDuckTrades: 0, // trades where every legal trade card beat the best so far (D10 noduck%)
    tradeTens: 0, // trades of a 10 (D10 t10, the loose count)
    forcedTens: 0, // trades of a 10 that was the only card of the island's cargo in hand (R5.6, strict)
    discards: 0, // discards (R4.3 rung 3)
    sails: 0, // ship moves
    ties: 0, // tricks with more than one counting card on the best number (D10 ties%)
    parked: 0, // player-voyages with no sail (R7.17 "never sailed")
    tricksWon: filled(n, () => 0), // over the game, by seat
    serpentsTaken: filled(n, () => 0),
    tradesBySeat: filled(n, () => 0),
    sailsBySeat: filled(n, () => 0),
  };
}

/** Per-voyage counters by seat (R5.6), reset at each deal. */
export function emptyVoyageStats(n) {
  return {
    trades: filled(n, () => 0),
    tradesWon: filled(n, () => 0),
    forcedTens: filled(n, () => 0),
    discards: filled(n, () => 0),
    sails: filled(n, () => 0),
    ties: 0,
  };
}

function checkDeal(deal, state) {
  const { n, params } = state;
  const k = params.handSize;
  if (!deal || !Array.isArray(deal.hands) || deal.hands.length !== n || deal.hands.some((h) => !Array.isArray(h) || h.length !== k)) {
    throw new Error(`A fixed deal needs ${n} hands of ${k} cards`);
  }
  const all = deal.hands.flat();
  if (all.some((c) => !isCard(c))) throw new Error('A fixed deal holds a card that is not in the deck');
  if (new Set(all).size !== all.length) throw new Error('A fixed deal contains a card twice');
  if (deal.ring !== undefined && deal.ring !== null) {
    if (!Array.isArray(deal.ring) || deal.ring.length !== params.islands) throw new Error(`A fixed ring needs ${params.islands} islands`);
    const cargoes = deal.ring.map((x) => (SUITS.includes(x) ? x : islandFaceCargo(String(x))));
    for (const s of SUITS) {
      if (cargoes.filter((c) => c === s).length !== CONSTANTS.ISLANDS_PER_CARGO) throw new Error(`A fixed ring needs ${CONSTANTS.ISLANDS_PER_CARGO} islands of each cargo`);
    }
  }
}

/** A fixed ring of cargo ids or island face ids -> { ring, faces }. Cargo ids get faces a, b in order. */
function fixedRing(list) {
  const used = new Map();
  const faces = list.map((x) => {
    if (!SUITS.includes(x)) return String(x);
    const k = used.get(x) || 0;
    used.set(x, k + 1);
    return `island-${x}-${'abcdefghij'[k]}`;
  });
  return { ring: faces.map(islandFaceCargo), faces };
}

/**
 * R3.5 / R13.1 the mooring order of voyage `state.handNo`: clockwise from the dealer's left; under
 * MOOR=score, highest running total first, equal totals clockwise from the dealer's left (so voyage 1
 * equals the standard order).
 */
export function mooringOrderFor(state) {
  const n = state.n;
  const clockwise = filled(n, (_, k) => (state.dealer + 1 + k) % n);
  if (state.rules.MOOR !== 'score') return clockwise;
  return clockwise
    .map((s, k) => ({ s, k }))
    .sort((a, b) => state.totals[b.s] - state.totals[a.s] || a.k - b.k)
    .map((x) => x.s);
}

/**
 * Starts voyage `state.handNo` (R2.3, R2.5, R2.6, R3, R8.3): sets the dealer and the first leader,
 * lays a fresh ring, gathers and shuffles all 40 cards, deals, sets the rest aside unseen, takes every
 * ship off the ring and opens the mooring phase. Scores carry over. Pushes events when `events` is an array.
 */
export function dealHand(state, events) {
  const { n, params } = state;
  const h = state.handNo;
  const k = params.handSize;
  state.dealer = (state.firstDealer + h) % n; // R2.3 the deal passes left
  state.leader = (state.dealer + 1) % n; // R2.3, R3.7 the player on the dealer's left leads

  const fixed = state.deals && state.deals[h] ? state.deals[h] : null;
  if (fixed) checkDeal(fixed, state);

  // R3.1 lay the ring: the 8 islands shuffled, in any order (twins may sit together).
  let ringFaces;
  if (fixed && fixed.ring) ringFaces = fixedRing(fixed.ring).faces;
  else ringFaces = shuffle(state.rng, allIslandFaces());
  state.islandFaces = ringFaces;
  state.ring = ringFaces.map(islandFaceCargo);

  // R3.2 / R3.3 deal by player count; the rest are set aside unseen.
  let packets;
  if (fixed) {
    packets = fixed.hands.map((x) => [...x]);
    const dealt = new Set(packets.flat());
    state.setAside = fullDeck().filter((c) => !dealt.has(c));
  } else {
    // R3.4 shuffle all 40, deal k each starting left of the dealer; the remainder is set aside.
    const deck = shuffle(state.rng, fullDeck());
    packets = filled(n, () => []);
    for (let i = 0; i < n; i++) packets[(state.dealer + 1 + i) % n] = deck.slice(i * k, (i + 1) * k);
    state.setAside = deck.slice(n * k);
  }
  state.setAside = sortCards(state.setAside);
  state.hands = packets.map((p) => sortCards(p));

  // R2.6 everything resets each voyage.
  state.ships = filled(n, () => null);
  state.startIslands = filled(n, () => null);
  state.serpentRows = filled(n, () => []);
  state.wonPiles = filled(n, () => []);
  state.tricksWon = filled(n, () => 0);
  state.serpentsTaken = filled(n, () => 0);
  state.voyageStats = emptyVoyageStats(n);
  state.trick = null;
  state.tricks = [];
  state.trickNo = 0;
  state.handSize = k;

  // R3.5, R3.6 mooring: one decision per seat in mooring order.
  state.mooringOrder = mooringOrderFor(state);
  state.phase = 'moor';
  state.toAct = state.mooringOrder[0];
  if (events) {
    events.push({
      type: 'voyage-started', handNo: h, voyage: h + 1, handsPerGame: params.handsPerGame, dealer: state.dealer, leader: state.leader,
      handSize: k, setAsideCount: state.setAside.length, mooringOrder: [...state.mooringOrder],
    });
    events.push({ type: 'ring-laid', handNo: h, ring: [...state.ring], islandFaces: [...state.islandFaces] });
  }
}

/**
 * A new game, its first voyage started (phase 'moor'), plus the events of the start.
 * @param {object} opts
 * @param {number|string} opts.seed       drives the first dealer (if random) and every shuffle
 * @param {number} opts.players           2 to 5
 * @param {object} [opts.rules]           variant overrides (rules.js VARIANTS)
 * @param {number|null} [opts.firstDealer] seat of the first dealer; default drawn from the seed (R2.2)
 * @param {Array<{hands: string[][], ring?: string[]}>|null} [opts.deals]
 *        fixed deals by voyage index (replays, tests, conformance): hands by seat, and optionally the
 *        ring (8 cargo ids or island face ids, clockwise from island 0). Voyages without an entry are
 *        shuffled from the seed. Cards not in a fixed deal are the set-aside.
 * @param {number[]} [opts.manualSeats] seats whose single-option card plays are NOT auto-applied
 *        (learners click even a forced card). Not a rule: never in `rules` or the rules code.
 * @returns {{ state: object, events: object[] }}
 */
export function startGame(opts = {}) {
  const { seed, players: n, firstDealer = null, deals = null } = opts;
  if (seed === undefined || seed === null) throw new Error('startGame needs a seed');
  const rules = resolveVariants(opts.rules || {});
  const params = deriveParams(rules, n);
  const rng = makeRng(seed);
  let dealer0;
  if (firstDealer === null || firstDealer === undefined) dealer0 = rngInt(rng, n); // R2.2
  else if (Number.isInteger(firstDealer) && firstDealer >= 0 && firstDealer < n) dealer0 = firstDealer;
  else throw new Error(`firstDealer must be a seat 0..${n - 1} or null, got ${firstDealer}`);
  const manualSeats = Array.isArray(opts.manualSeats) ? [...new Set(opts.manualSeats)].sort((a, b) => a - b) : [];
  if (manualSeats.some((s) => !Number.isInteger(s) || s < 0 || s >= n)) throw new Error(`manualSeats must be seats 0..${n - 1}`);

  const state = {
    kind: 'game',
    schema: 1,
    seed: String(seed),
    n,
    rules, // resolved Playtest switches (VARIANTS)
    params, // numbers implied by n and the rules (deriveParams)
    rulesCode: rulesCode(rules, n),
    rng, // { s } the game's own stream: ring and deck shuffles
    deals: deals ? JSON.parse(JSON.stringify(deals)) : null,
    manualSeats,
    firstDealer: dealer0,
    dealer: dealer0, // dealer of the current voyage
    handNo: 0, // current voyage index, 0-based (= voyages finished)
    handSize: 0, // cards dealt to each player this voyage
    phase: 'moor', // 'moor' | 'play' | 'voyageEnd' (transient) | 'over'
    toAct: null, // seat whose decision it is, or null
    leader: null, // leader of the current (or next) trick
    ring: [], // R3.1 the 8 islands clockwise: cargo id per island index 0..7 (public)
    islandFaces: [], // art per island index: 'island-<cargo>-<a|b>' (cosmetic)
    ships: filled(n, () => null), // island index per seat, null until moored (public)
    startIslands: filled(n, () => null), // where each ship moored this voyage
    mooringOrder: [], // seats in the order they moor this voyage (R3.5, R13.1)
    hands: filled(n, () => []), // HIDDEN: each seat's cards, sorted
    setAside: [], // HIDDEN from everyone: the cards not dealt (R3.3), sorted
    serpentRows: filled(n, () => []), // PUBLIC: face-up serpent cards won this voyage, in the order taken (R4.9)
    wonPiles: filled(n, () => []), // face-down won cards this voyage (contents hidden in the view; counts public)
    tricksWon: filled(n, () => 0), // tricks won this voyage (R5.4)
    serpentsTaken: filled(n, () => 0), // serpents on each seat's face-up cards this voyage
    voyageStats: emptyVoyageStats(n), // per-voyage counters by seat (R5.6)
    trickNo: 0, // completed tricks this voyage
    trick: null, // the trick being played (see actions.js)
    tricks: [], // completed tricks this voyage
    handLog: [], // finished voyages' records (R5.6), see actions.js endHand
    totals: filled(n, () => 0), // running totals over finished voyages (may be negative, R5.3)
    measures: emptyMeasures(n),
    result: null, // gameResult() once the game is over
  };
  const events = [{ type: 'game-started', players: n, firstDealer: dealer0, rules: { ...rules }, rulesCode: state.rulesCode, handsPerGame: params.handsPerGame }];
  dealHand(state, events);
  return { state, events };
}

/** startGame without the events. */
export function createGame(opts = {}) {
  return startGame(opts).state;
}

/**
 * A deep copy of a state (or of a determinised world) that applyAction can mutate without touching
 * the original. Plain JSON copied by recursion: faster than a JSON round trip.
 */
export function cloneState(x) {
  if (Array.isArray(x)) {
    const out = new Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = cloneState(x[i]);
    return out;
  }
  if (x && typeof x === 'object') {
    const out = {};
    for (const k of Object.keys(x)) out[k] = cloneState(x[k]);
    return out;
  }
  return x;
}

export { CONSTANTS };
