// conformance.mjs - replays the Python fixtures (tests/fixtures/python-conformance.json, made by
// a generator script kept OUTSIDE the repo, which drives the original
// sim/sinbad-sim-v1.py unchanged over fixed deals, rings and moorings with random legal play) through
// the JS engine, one voyage each , and requires identical results:
//   * the seat to play and the legal set at every card (its size, and for a follow / trade that every
//     legal card is of the played card's cargo, for a lead / discard that it is the whole hand: with
//     identical hands this is set equality, R4.3), and the mode of every play (lead / follow / trade /
//     discard, R4.16);
//   * every trick's winner (R4.7, R4.8, R4.12) and therefore every next leader (R4.11);
//   * every ship's island after every trick (the sail step, R4.10, R4.2);
//   * the voyage score per seat (R5.2), sails per seat, and the voyage's counters: trades, tricks
//     won by a trade, ties, discards, clean tricks, no-duck trades, trades of a 10, parked ships.
// Every voyage is replayed twice: learner style (every card an explicit action, legal sets compared at
// every play) and with forced cards auto-played (the recorded plays must match the auto events).
// Mapping (spec D3, D4): JS seat (d + 1 + s) mod n is Python seat s; Python cargo id i = CARGOES[i].
// Coverage of the corner cases (forced 10, ties, shared islands, twins, discards ...) is counted and
// each must be reached. Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import { readFileSync } from 'node:fs';
import { startGame, applyAction, getValidActions, fullDeck, cardSuit, cardValue, CARGOES } from '../src/engine/index.js';
import { suite } from './lib.mjs';

const { check, done } = suite('conformance');
const FX = JSON.parse(readFileSync(new URL('./fixtures/python-conformance.json', import.meta.url), 'utf8'));
const DECK = fullDeck(); // fixture alphabet index = fullDeck() index (cargo id x 10 + rank - 1)
const card = (c) => DECK[FX.alphabet.indexOf(c)];
const MODE = { L: 'lead', F: 'follow', T: 'trade', D: 'discard' };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let mismatches = 0;
const firstFew = [];
function bad(id, what) {
  mismatches++;
  if (firstFew.length < 12) firstFew.push(`${id}: ${what}`);
}

const cover = { forcedTens: 0, tradeTens: 0, ties: 0, tieTradeFirst: 0, tradeWins: 0, discards: 0, sharedStart: 0, twinStart: 0, setAside14: 0, setAside1: 0, autoPlays: 0, negative: 0, wrapSail: 0 };

/** One fixture voyage; returns nothing, counts mismatches. */
function replay(fx, manual) {
  const { n, d } = fx;
  const tag = `${fx.id}${manual ? '' : ' (auto)'}`;
  const js = (py) => (d + 1 + py) % n;
  const py = (j) => (j - d - 1 + 2 * n) % n;
  const hands = Array.from({ length: n }, (_, j) => [...fx.h[py(j)]].map(card));
  const ring = [...fx.g].map((x) => CARGOES[Number(x)]);
  const { state, events: ev0 } = startGame({
    seed: `fx-${fx.id}`, players: n, firstDealer: d, deals: [{ hands, ring }],
    manualSeats: manual ? Array.from({ length: n }, (_, s) => s) : [],
  });
  let events = [...ev0];
  if (!same(state.ring, ring)) { bad(tag, 'ring not laid as fixed'); return; }
  if (state.setAside.length !== 40 - n * state.handSize) { bad(tag, `set-aside ${state.setAside.length}`); return; }
  // Mooring (R3.5): clockwise from the dealer's left = Python seats 0, 1, ...
  for (let k = 0; k < n; k++) {
    if (state.phase !== 'moor' || state.toAct !== js(k)) { bad(tag, `mooring ${k}: JS seat ${state.toAct} in ${state.phase}`); return; }
    events = events.concat(applyAction(state, { type: 'moor', island: Number(fx.m[k]) }));
  }
  if (state.phase !== 'play' || state.toAct !== js(0)) { bad(tag, `the first lead is JS seat ${state.toAct}, not Python seat 0`); return; }

  const plays = [...fx.p].map(card);
  const seats = [...fx.s].map(Number);
  const modes = [...fx.o].map((c) => MODE[c]);
  const legalN = [...fx.l].map((c) => parseInt(c, 36));
  const winners = [...fx.w].map(Number);
  const k = state.handSize;
  const ships = [...state.ships];
  let trick = 0;
  let consumed = 0; // auto card-played events already matched
  for (let i = 0; i < plays.length; i++) {
    const c = plays[i];
    const seat = js(seats[i]);
    // A forced card the engine already played (auto mode): match it against the recorded play.
    const autos = events.filter((e) => e.type === 'card-played' && e.auto);
    if (autos.length > consumed) {
      const e = autos[consumed++];
      cover.autoPlays++;
      if (e.card !== c || e.seat !== seat) { bad(tag, `play ${i}: engine auto-played ${e.card} by ${e.seat}, Python ${c} by ${seat}`); return; }
      if (legalN[i] !== 1) { bad(tag, `play ${i}: auto-played a card the Python had ${legalN[i]} options for`); return; }
      if (e.mode !== modes[i]) { bad(tag, `play ${i}: mode ${e.mode} v Python ${modes[i]}`); return; }
    } else {
      if (state.toAct !== seat) { bad(tag, `play ${i}: JS seat ${state.toAct} to act, Python seat ${seat}`); return; }
      const legal = getValidActions(state).map((a) => a.card);
      const hand = state.hands[seat];
      if (legal.length !== legalN[i]) { bad(tag, `play ${i}: ${legal.length} legal cards v Python ${legalN[i]}`); return; }
      if (!legal.includes(c)) { bad(tag, `play ${i}: ${c} not legal in JS`); return; }
      const m = modes[i];
      if ((m === 'follow' || m === 'trade') && !legal.every((x) => cardSuit(x) === cardSuit(c))) { bad(tag, `play ${i}: ${m} legal set is not one cargo`); return; }
      if ((m === 'lead' || m === 'discard') && legal.length !== hand.length) { bad(tag, `play ${i}: ${m} legal set is not the whole hand`); return; }
      const out = applyAction(state, { type: 'play', card: c });
      const e = out.find((x) => x.type === 'card-played' && !x.auto);
      if (!e || e.card !== c || e.mode !== m) { bad(tag, `play ${i}: mode ${e && e.mode} v Python ${m}`); return; }
      if (m === 'trade' && (!e.sideways || e.countsAs !== e.ledSuit)) { bad(tag, `play ${i}: a trade not sideways / not counting as led`); return; }
      events = events.concat(out);
    }
    // End of a trick: compare the winner and every ship.
    if ((i + 1) % n === 0) {
      const done2 = events.filter((e) => e.type === 'trick-won' && e.handNo === 0);
      const tw = done2[trick];
      if (!tw) { bad(tag, `trick ${trick + 1}: no trick-won event`); return; }
      if (tw.winner !== js(winners[trick])) { bad(tag, `trick ${trick + 1}: JS winner ${tw.winner}, Python ${js(winners[trick])}`); return; }
      if (tw.tie) { cover.ties++; if (tw.mode === 'trade') cover.tieTradeFirst++; }
      if (tw.mode === 'trade') cover.tradeWins++;
      // Ships after this trick, from the moorings and the sailed events (works whatever was auto-played).
      for (const e of events) if (e.type === 'sailed' && e.handNo === 0 && e.trickNo === trick + 1) {
        if (ships[e.seat] !== e.from) { bad(tag, `trick ${trick + 1}: seat ${e.seat} sails from ${e.from}, stood on ${ships[e.seat]}`); return; }
        ships[e.seat] = e.to;
      }
      const pyShips = [...fx.q.slice(trick * n, trick * n + n)].map(Number);
      const want = Array.from({ length: n }, (_, j) => pyShips[py(j)]);
      if (!same(ships, want)) { bad(tag, `trick ${trick + 1}: ships ${ships} v Python ${want}`); return; }
      if (events.some((e) => e.type === 'sailed' && e.trickNo === trick + 1 && e.to < e.from)) cover.wrapSail++;
      trick++;
    }
  }
  if (state.handLog.length < 1) { bad(tag, 'the voyage did not end'); return; }
  const rec = state.handLog[0];
  const wantScores = Array.from({ length: n }, (_, j) => fx.r[py(j)]);
  const wantSails = Array.from({ length: n }, (_, j) => fx.k[py(j)]);
  if (!same(rec.scores, wantScores)) { bad(tag, `scores ${rec.scores} v Python ${wantScores}`); return; }
  if (!same(rec.sails, wantSails)) { bad(tag, `sails ${rec.sails} v Python ${wantSails}`); return; }
  if (rec.tricksPlayed !== fx.x.tricks || rec.tricksPlayed !== k) { bad(tag, `tricks ${rec.tricksPlayed} v ${fx.x.tricks}`); return; }
  const m = state.measures; // only voyage 1 has been played (voyage 2 has just been dealt)
  const got = {
    tricks: m.tricks, clean: m.cleanTricks, trades: m.trades, tradeWins: m.tradesWon, tradeSerpWins: m.tradeSerpentWins,
    noDuck: m.noDuckTrades, tradeTens: m.tradeTens, discards: m.discards, ties: m.ties, sails: m.sails, parked: m.parked,
  };
  if (!same(got, fx.x)) { bad(tag, `counters ${JSON.stringify(got)} v Python ${JSON.stringify(fx.x)}`); return; }
  if (manual) {
    cover.forcedTens += m.forcedTens;
    cover.tradeTens += m.tradeTens;
    cover.discards += m.discards;
    if (new Set(rec.startIsland).size < n) cover.sharedStart++;
    if (rec.startIsland.some((x) => rec.ring[(x + 1) % 8] === rec.ring[x])) cover.twinStart++;
    if (rec.setAside === 14) cover.setAside14++;
    if (rec.setAside === 1) cover.setAside1++;
    if (rec.scores.some((x) => x < 0)) cover.negative++;
  }
}

const t0 = process.hrtime.bigint();
for (const fx of FX.voyages) {
  replay(fx, true);
  replay(fx, false);
}
const byN = {};
for (const fx of FX.voyages) byN[fx.n] = (byN[fx.n] || 0) + 1;
check(`fixtures: ${FX.count} voyages at every player count (${JSON.stringify(byN)})`, FX.count === FX.voyages.length && [2, 3, 4, 5].every((n) => byN[n] >= 100));
check(`replay: ${FX.voyages.length * 2} replays (learner and auto) agree with the Python on legal sets, modes, winners, ships, scores, sails and counters`, mismatches === 0, `${mismatches} mismatches: ${firstFew.join(' | ')}`);
check('replay: the hand-designed deals are present (worked example, forced 10, ties, discard on a twin, one island)', ['design-example', 'design-forced-10', 'design-tie-trade-real', 'design-tie-two-trades', 'design-discard-twin', 'design-2p-one-island', 'design-5p-one-island'].every((id) => FX.voyages.some((v) => v.id === id)));
// The worked example (R11): Ben (Python 1) wins the first trick; Cleo and Dev sail to Amber islands 4 and 8.
{
  const ex = FX.voyages.find((v) => v.id === 'design-example');
  const bomb = FX.voyages.find((v) => v.id === 'design-forced-10');
  check('R11 the worked example: Ben wins trick 1, Cleo sails 3 -> 4, Dev 7 -> 8, Ava and Ben stay', ex.w[0] === '1' && ex.q.slice(0, 4) === '0137');
  check('R7.2 the forced-10 bomb: Dev trades the Silk 10 (one legal card) and wins trick 1', bomb.o.slice(0, 4) === 'LFDT' && bomb.l[3] === '1' && bomb.w[0] === '3');
}
for (const [k, v] of Object.entries(cover)) check(`coverage: ${k} reached (${v})`, v > 0);
console.log(`  coverage ${JSON.stringify(cover)}; ${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s`);
void cardValue;
done();
