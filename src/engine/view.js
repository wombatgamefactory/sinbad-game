// view.js - what one seat may know (rules list section 9), and the helpers a search bot builds worlds from.
//
// viewFor(state, seat) is the ONLY thing a bot receives. It holds the seat's own hand and everything
// public: every seat's card count, the ring, every ship (moorings are public as they are made, R3.6,
// R9.3) and its next island, the current trick (trades flagged sideways with the cargo they count as),
// this voyage's completed tricks (the public trick log, R9.8), the face-up serpent rows (R9.5), trick
// counts and face-down pile sizes (R9.6), the set-aside COUNT (R9.7), the pad. Never: another seat's
// cards, the set-aside cards (not even after the voyage or the game).
//
// Voids are not announced (R9.9): shownVoids() derives them from the trick history, and
// determinise() honours them when it guesses the other hands. In Sinbad every non-follow shows a
// void in the led cargo, and a DISCARD also shows no card of the player's island cargo (else R4.3
// would have forced a trade). Cards are never drawn, so a void lasts the voyage.
//
//   viewFor(state, seat)                the view
//   legalActionsFromView(view)          the seat's legal actions, from the view alone
//   shownVoids(view)                    cargoes each seat has shown it lacks
//   unknownCards(view)                  cards the viewer cannot place (other hands + the set-aside)
//   dealRespectingVoids(...)            GENERIC: deals a pool of unknown cards to seats, honouring voids
//   determinise(view, rng)              a complete state consistent with the view, for search bots

import { SUIT_ORDER } from './rules.js';
import { cardSuit, fullDeck, sortCards, cardSerpents } from './cards.js';
import { legalActionsFor } from './legality.js';
import { forkRng, shuffle } from './rng.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

// Fast copies of the history records (viewFor runs at every bot decision).
const copyPlays = (plays) => plays.map((p) => ({ ...p }));
const copyTrick = (t) => {
  const c = { ...t, seats: [...t.seats], plays: copyPlays(t.plays) };
  if (t.serpentCards) c.serpentCards = [...t.serpentCards];
  if (t.sails) c.sails = t.sails.map((x) => ({ ...x }));
  return c;
};

function copyMeasures(m) {
  const out = { ...m };
  for (const k of Object.keys(m)) if (Array.isArray(m[k])) out[k] = [...m[k]];
  return out;
}

function copyHandRecord(h) {
  const out = { ...h };
  for (const k of Object.keys(h)) if (Array.isArray(h[k]) && k !== 'tricks') out[k] = [...h[k]];
  out.tricks = h.tricks.map(copyTrick);
  return out;
}

const copyVoyageStats = (v) => ({ trades: [...v.trades], tradesWon: [...v.tradesWon], forcedTens: [...v.forcedTens], discards: [...v.discards], sails: [...v.sails], ties: v.ties });

/** R3.8 each ship's next island (one clockwise), or null if unmoored. */
export function nextIslands(st) {
  return st.ships.map((i) => (i === null ? null : (i + st.params.sailStep) % st.params.islands));
}

/** The view of `seat` (0..n-1). Plain JSON; a fresh copy each call. */
export function viewFor(state, seat) {
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.n) throw new Error(`viewFor needs a seat 0..${state.n - 1}, got ${seat}`);
  return {
    kind: 'view',
    seat,
    n: state.n,
    rules: { ...state.rules },
    params: { ...state.params, serpentsByNumber: { ...state.params.serpentsByNumber } },
    rulesCode: state.rulesCode,
    phase: state.phase, // 'moor' | 'play' | 'over'
    toAct: state.toAct,
    hand: [...state.hands[seat]], // R9.1 own hand only
    handCounts: state.hands.map((h) => h.length), // R9.2
    setAsideCount: state.setAside.length, // R9.7 the count only
    firstDealer: state.firstDealer,
    dealer: state.dealer,
    leader: state.leader,
    handNo: state.handNo,
    handSize: state.handSize,
    ring: [...state.ring], // R9.3
    islandFaces: [...state.islandFaces],
    ships: [...state.ships], // R9.3 public as made
    nextIslands: nextIslands(state),
    startIslands: [...state.startIslands],
    mooringOrder: [...state.mooringOrder],
    serpentRows: state.serpentRows.map((r) => [...r]), // R9.5 face up, public
    wonPileCounts: state.wonPiles.map((p) => p.length), // R9.6 face-down: counts only
    tricksWon: [...state.tricksWon], // R9.6
    serpentsTaken: [...state.serpentsTaken],
    voyageStats: copyVoyageStats(state.voyageStats),
    trickNo: state.trickNo,
    trick: state.trick ? copyTrick(state.trick) : null, // R9.4
    tricks: state.tricks.map(copyTrick), // R9.8 this voyage's trick log
    handLog: state.handLog.map(copyHandRecord), // R9.10 the pad (finished voyages)
    totals: [...state.totals],
    measures: copyMeasures(state.measures),
    result: state.result ? clone(state.result) : null,
  };
}

/** The legal actions for the viewing seat, computed from the view alone (empty if not its turn). */
export function legalActionsFromView(view) {
  if (view.toAct !== view.seat || view.phase === 'over' || view.phase === 'voyageEnd') return [];
  return legalActionsFor(view, view.hand);
}

/**
 * R9.9 cargoes each seat has SHOWN it lacks this voyage: a trade or a discard shows a void in the led
 * cargo; a discard also shows a void in the player's island cargo at that moment (not under
 * TRADE=optional, where a player may discard while holding it: R13.3). Voids last the voyage (cards are
 * never drawn).
 * @returns {string[][]} by seat, in cargo order
 */
export function shownVoids(view) {
  const out = Array.from({ length: view.n }, () => new Set());
  const scan = (t) => {
    for (const p of t.plays) {
      if (p.mode === 'trade') out[p.seat].add(t.ledSuit);
      else if (p.mode === 'discard') {
        out[p.seat].add(t.ledSuit);
        // R9.9: a discard also shows no island cargo, because R4.3 would have forced a trade. Under
        // TRADE=optional (R13.3) the trade is not forced, so a discard shows only the led-cargo void.
        if (p.islandCargo && view.rules.TRADE !== 'optional') out[p.seat].add(p.islandCargo);
      }
    }
  };
  for (const t of view.tricks) scan(t);
  if (view.trick) scan(view.trick);
  return out.map((set) => SUIT_ORDER.filter((s) => set.has(s)));
}

/** Every card the viewer can place this voyage: own hand and every card played this voyage. */
function knownCards(view) {
  const known = new Set(view.hand);
  for (const t of view.tricks) for (const p of t.plays) known.add(p.card);
  if (view.trick) for (const p of view.trick.plays) known.add(p.card);
  return known;
}

/** Cards the viewer cannot place: other seats' hands plus the set-aside. Sorted. */
export function unknownCards(view) {
  const known = knownCards(view);
  return sortCards(fullDeck().filter((c) => !known.has(c)));
}

/**
 * GENERIC. Deals `pool` (cards nobody can place) to `seats`, `need[s]` cards each, giving no seat
 * a card of a suit it has shown it lacks. Retries with fresh shuffles (the most constrained seat
 * first on the later attempts); if no deal honours every void it ignores them (should not happen
 * for a consistent view). Returns { hands, leftover }: hands by seat (arrays, empty for seats not
 * in `seats`) and the cards nobody got (the set-aside).
 * @param {string[]} pool
 * @param {number[]} need   cards wanted per seat (index = seat)
 * @param {Set<string>[]} voids   per seat, suits it lacks
 * @param {{s:number}} rng
 * @param {number[]} seats  seats to deal to
 * @param {(card:string)=>string} [suitOf]
 */
export function dealRespectingVoids(pool, need, voids, rng, seats, suitOf = cardSuit) {
  const n = need.length;
  for (let attempt = 0; attempt < 40; attempt++) {
    const cards = shuffle(rng, [...pool]);
    const hands = Array.from({ length: n }, () => []);
    const order = attempt < 20 ? seats : [...seats].sort((a, b) => voids[b].size - voids[a].size);
    let ok = true;
    for (const s of order) {
      for (let i = 0; i < cards.length && hands[s].length < need[s];) {
        if (voids[s].has(suitOf(cards[i]))) { i++; continue; }
        hands[s].push(cards[i]);
        cards.splice(i, 1);
      }
      if (hands[s].length < need[s]) { ok = false; break; }
    }
    if (ok) return { hands, leftover: cards };
  }
  const cards = shuffle(rng, [...pool]);
  const hands = Array.from({ length: n }, () => []);
  for (const s of seats) hands[s].push(...cards.splice(0, need[s]));
  return { hands, leftover: cards };
}

/**
 * A complete game state consistent with the view, for search bots (clone it and play on with
 * applyAction). The other seats' hands are dealt uniformly from the unknown cards, respecting shown
 * voids; the cards left over are the set-aside. Everything public is copied; the face-down piles are
 * rebuilt from the trick log (every card was played face up).
 */
export function determinise(view, rng) {
  const n = view.n;
  const me = view.seat;
  const unknown = unknownCards(view);
  const voids = shownVoids(view).map((v) => new Set(v));
  const others = Array.from({ length: n }, (_, s) => s).filter((s) => s !== me);
  const need = Array.from({ length: n }, (_, s) => (s === me ? 0 : view.handCounts[s]));
  const dealt = dealRespectingVoids(unknown, need, voids, rng, others);
  const hands = dealt.hands;
  hands[me] = [...view.hand];

  const tricks = clone(view.tricks);
  const wonPiles = Array.from({ length: n }, () => []);
  for (const t of tricks) for (const p of t.plays) if (cardSerpents(p.card, view.params) === 0) wonPiles[t.winner].push(p.card);
  return {
    kind: 'game',
    schema: 1,
    seed: 'determinised',
    n,
    rules: { ...view.rules },
    params: clone(view.params),
    rulesCode: view.rulesCode,
    rng: forkRng(rng),
    deals: null,
    manualSeats: [],
    firstDealer: view.firstDealer,
    dealer: view.dealer,
    handNo: view.handNo,
    handSize: view.handSize,
    phase: view.phase,
    toAct: view.toAct,
    leader: view.leader,
    ring: [...view.ring],
    islandFaces: [...view.islandFaces],
    ships: [...view.ships],
    startIslands: [...view.startIslands],
    mooringOrder: [...view.mooringOrder],
    hands: hands.map((h) => sortCards(h)),
    setAside: sortCards(dealt.leftover),
    serpentRows: view.serpentRows.map((r) => [...r]),
    wonPiles,
    tricksWon: [...view.tricksWon],
    serpentsTaken: [...view.serpentsTaken],
    voyageStats: copyVoyageStats(view.voyageStats),
    trickNo: view.trickNo,
    trick: view.trick ? clone(view.trick) : null,
    tricks,
    handLog: clone(view.handLog),
    totals: [...view.totals],
    measures: clone(view.measures),
    result: view.result ? clone(view.result) : null,
  };
}
