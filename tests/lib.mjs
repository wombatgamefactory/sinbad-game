// lib.mjs - a tiny check harness shared by the suites (no framework), plus game helpers.

import { createGame, applyAction, fullDeck, sortCards, CARGOES } from '../src/engine/index.js';

export function suite(name) {
  let pass = 0;
  const failures = [];
  function check(label, cond, detail = '') {
    if (cond) pass++;
    else failures.push(`${label}${detail ? ` -- ${detail}` : ''}`);
  }
  function done() {
    for (const f of failures) console.log(`  FAIL ${f}`);
    console.log(`${name}: ${pass} passed, ${failures.length} failed`);
    if (failures.length) process.exitCode = 1;
    return failures.length === 0;
  }
  return { check, done };
}

export const roundTrip = (x) => JSON.parse(JSON.stringify(x));
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

/** The worked-example ring: Spice, Silk, Pearls, Amber, Spice, Pearls, Silk, Amber (islands 1-8). */
export const RING6 = ['spice', 'silk', 'pearls', 'amber', 'spice', 'pearls', 'silk', 'amber'];

/**
 * A hand-built position in the middle of a voyage, phase 'play', no trick started, every ship moored.
 * Cards not placed anywhere go to the set-aside, so card conservation holds.
 * @param {object} o
 * @param {number} [o.players]       default 4
 * @param {string[][]} o.hands       cards in hand by seat (all the same length in real play)
 * @param {number} [o.leader]        seat to lead (default 0); the dealer is the seat on its right
 * @param {object} [o.rules]
 * @param {string[]} [o.ring]        8 cargo ids (default RING6)
 * @param {number[]} [o.ships]       island index per seat (default all 0)
 * @param {number[]} [o.totals]      running totals (default 0)
 * @param {number} [o.handNo]        voyage index (default 0)
 */
export function position({ players = 4, hands, leader = 0, rules = {}, ring = RING6, ships = null, totals = null, handNo = 0 }) {
  const g = createGame({ seed: 1, players, rules, firstDealer: (leader - 1 - handNo + 2 * players * 4) % players });
  g.handNo = handNo;
  g.dealer = (g.firstDealer + handNo) % players;
  g.ring = [...ring];
  const used = new Map();
  g.islandFaces = ring.map((c) => { const k = used.get(c) || 0; used.set(c, k + 1); return `island-${c}-${'ab'[k]}`; });
  g.ships = ships ? [...ships] : hands.map(() => 0);
  g.startIslands = [...g.ships];
  g.hands = hands.map((h) => sortCards(h));
  const placed = new Set(g.hands.flat());
  g.setAside = fullDeck().filter((c) => !placed.has(c));
  g.serpentRows = hands.map(() => []);
  g.wonPiles = hands.map(() => []);
  g.tricksWon = hands.map(() => 0);
  g.serpentsTaken = hands.map(() => 0);
  g.handSize = hands[0].length;
  if (totals) g.totals = [...totals];
  g.phase = 'play';
  g.leader = leader;
  g.toAct = leader;
  g.trick = null;
  g.tricks = [];
  g.trickNo = 0;
  return g;
}

/**
 * Plays actions in order, each by whoever is to act. A string is a card ('spice-7'); a number is a
 * mooring (island index); objects are passed as they are. A card that the engine already auto-played
 * (single legal option) is skipped. Returns all events.
 */
export function play(state, ...moves) {
  let events = [];
  for (const m of moves) {
    if (typeof m === 'string') {
      const auto = events.find((e) => e.type === 'card-played' && e.auto && !e._used && e.card === m);
      if (auto) { auto._used = true; continue; }
      events = events.concat(applyAction(state, { type: 'play', card: m }));
    } else if (typeof m === 'number') {
      events = events.concat(applyAction(state, { type: 'moor', island: m }));
    } else {
      events = events.concat(applyAction(state, m));
    }
  }
  return events;
}

/**
 * R10 every card's location: returns { ok, problem }. Each of the 40 cards is in exactly one of:
 * a hand, the current trick, a seat's face-up serpent row, a seat's face-down won pile, the set-aside.
 * Also R10.4: a serpent row holds only serpent cards, a face-down pile none, and
 * tricksWon x n = face-down + face-up for every seat; R10.3 every moored ship is on an island.
 */
const DECK = new Set(fullDeck());
const SERPENT_NUMBERS = new Set(['1', '10']);

export function conservation(state) {
  const seen = new Map();
  const places = [];
  state.hands.forEach((h, s) => h.forEach((c) => places.push([c, `hand ${s}`])));
  if (state.trick) state.trick.plays.forEach((p) => places.push([p.card, 'trick']));
  state.serpentRows.forEach((w, s) => w.forEach((c) => places.push([c, `serpents ${s}`])));
  state.wonPiles.forEach((w, s) => w.forEach((c) => places.push([c, `pile ${s}`])));
  state.setAside.forEach((c) => places.push([c, 'set aside']));
  for (const [c, w] of places) {
    if (seen.has(c)) return { ok: false, problem: `${c} in ${seen.get(c)} and ${w}` };
    seen.set(c, w);
  }
  if (seen.size !== DECK.size) {
    const missing = [...DECK].filter((c) => !seen.has(c));
    return { ok: false, problem: `${seen.size} cards placed, deck has ${DECK.size}; missing ${missing.slice(0, 5).join(' ')}` };
  }
  for (const c of seen.keys()) if (!DECK.has(c)) return { ok: false, problem: `${c} is not in the deck` };
  const std = JSON.stringify(state.params.serpentsByNumber) === JSON.stringify({ 1: 1, 10: 2 });
  for (let s = 0; s < state.n; s++) {
    if (std && state.serpentRows[s].some((c) => !SERPENT_NUMBERS.has(c.split('-')[1]))) return { ok: false, problem: `seat ${s} has a non-serpent card face up` };
    if (std && state.wonPiles[s].some((c) => SERPENT_NUMBERS.has(c.split('-')[1]))) return { ok: false, problem: `seat ${s} has a serpent card face down` };
    if (state.tricksWon[s] * state.n !== state.serpentRows[s].length + state.wonPiles[s].length) return { ok: false, problem: `seat ${s}: ${state.tricksWon[s]} tricks but ${state.serpentRows[s].length + state.wonPiles[s].length} won cards` };
    const ship = state.ships[s];
    if (ship !== null && !(Number.isInteger(ship) && ship >= 0 && ship < state.ring.length)) return { ok: false, problem: `seat ${s} ship at ${ship}` };
  }
  if (state.ring.length !== 8 || CARGOES.some((c) => state.ring.filter((x) => x === c).length !== 2)) return { ok: false, problem: `ring ${state.ring}` };
  return { ok: true, problem: '' };
}
