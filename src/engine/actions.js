// actions.js - applyAction (returns events).
//
// applyAction(state, action) mutates `state` and RETURNS the events it produced; nothing is
// logged into the state. It throws, before changing anything, if getActionBlockReason refuses.
//
// One choice per turn (the cross-game one-choice rule, R4.16): the action is the island (mooring)
// or the card. Everything after it is mechanical and happens inside the same call: the mode of the
// card (lead / follow / trade / discard), the trick's winner, taking the cards (serpent cards face
// up), every sail, the next lead, the end of the voyage, the next voyage's ring and deal, the result.
//
// After the action, every decision that has exactly ONE legal option is applied at once and its
// events carry `auto: true` (R4.16, R15.2): the only card of the led cargo, a trade with one legal
// rank, the last card of a voyage. A mooring is never single (8 islands), so never auto.
//
// Events, in order (R8.1 - R8.3; kebab-case):
//   game-started, voyage-started, ring-laid, ship-moored x n, ships-moored,
//   card-played x n, trick-won, serpent-taken (if any), sailed (one per sailing seat, trick order),
//   ... voyage-ended, then the next voyage-started ... or game-over.
//
// A completed trick (state.tricks, and handLog[h].tricks) is:
//   { n, leader, seats, ledSuit, plays: [{ seat, card, mode, island, islandCargo, countsAs, sideways }],
//     winner, winningCard, winningMode, tie, tieBrokenBy, serpents, serpentCards,
//     sails: [{ seat, from, to, cause }] }

import { cardSuit, cardValue, cardSerpents } from './cards.js';
import { getActionBlockReason, getValidActions, trickWinner, playMode, sails, islandCargoOf } from './legality.js';
import { dealHand } from './state.js';
import { reckonHand, gameResult } from './scoring.js';

/**
 * Applies one action by state.toAct, then any forced (single-option) decisions.
 * @param {object} state
 * @param {object} action
 * @param {{silent?: boolean}} [opts]  silent: skip building events (search / simulator speed)
 * @returns {object[]} events (empty array when silent)
 */
export function applyAction(state, action, opts = {}) {
  const reason = getActionBlockReason(state, action);
  if (reason !== null) throw new Error(reason);
  const events = opts.silent ? null : [];
  doAction(state, action, events, false);
  runForced(state, events);
  return events || [];
}

/**
 * Applies single-option decisions until a real choice or the end. A card play by one of
 * state.manualSeats is left for that seat to make, even when it is the only legal card.
 */
function runForced(state, events) {
  const manual = state.manualSeats || [];
  while (state.toAct !== null) {
    if (state.phase === 'play' && manual.includes(state.toAct)) return;
    const acts = getValidActions(state);
    if (acts.length !== 1) return;
    doAction(state, acts[0], events, true);
  }
}

function doAction(state, action, events, auto) {
  if (action.type === 'moor') moorShip(state, action.island, events, auto);
  else if (action.type === 'play') playCard(state, action.card, events, auto);
}

// ---------- mooring (R3.5, R3.6) ----------

function moorShip(state, island, events, auto) {
  const seat = state.toAct;
  const sharedWith = state.ships.map((x, s) => (x === island ? s : -1)).filter((s) => s >= 0); // R7.10 sharing allowed
  state.ships[seat] = island;
  state.startIslands[seat] = island;
  if (events) events.push({ type: 'ship-moored', handNo: state.handNo, seat, island, cargo: state.ring[island], sharedWith, auto });
  const i = state.mooringOrder.indexOf(seat);
  if (i < state.mooringOrder.length - 1) {
    state.toAct = state.mooringOrder[i + 1];
    return;
  }
  // R3.7 every ship is moored: the player on the dealer's left leads (whatever the mooring order).
  state.phase = 'play';
  state.leader = (state.dealer + 1) % state.n;
  state.toAct = state.leader;
  if (events) events.push({ type: 'ships-moored', handNo: state.handNo, ships: [...state.ships], leader: state.leader });
}

// ---------- a trick (R4) ----------

function playCard(state, card, events, auto) {
  const seat = state.toAct;
  const n = state.n;
  const m = state.measures;
  const vs = state.voyageStats;
  if (state.trick === null) {
    state.trick = { n: state.trickNo + 1, leader: seat, seats: Array.from({ length: n }, (_, k) => (seat + k) % n), ledSuit: null, plays: [] };
  }
  const t = state.trick;
  const hand = state.hands[seat];
  const island = state.ships[seat];
  const islandCargo = islandCargoOf(state, seat); // R4.15 read at the moment of play
  const mode = playMode(hand, card, t.ledSuit, islandCargo);
  if (mode === 'trade') {
    const tradeCards = hand.filter((c) => cardSuit(c) === islandCargo);
    const best = bestCountingValue(t.plays);
    m.trades++;
    m.tradesBySeat[seat]++;
    vs.trades[seat]++;
    if (tradeCards.every((c) => cardValue(c) > best)) m.noDuckTrades++; // D10 noduck
    if (cardValue(card) === 10) {
      m.tradeTens++;
      if (tradeCards.length === 1) { m.forcedTens++; vs.forcedTens[seat]++; } // R5.6 strict forced 10
    }
  } else if (mode === 'discard') {
    m.discards++;
    vs.discards[seat]++;
  }
  state.hands[seat] = hand.filter((c) => c !== card);
  const lead = t.ledSuit === null;
  if (lead) t.ledSuit = cardSuit(card);
  const play = { seat, card, mode, island, islandCargo, countsAs: mode === 'trade' ? t.ledSuit : null, sideways: mode === 'trade' };
  t.plays.push(play);
  if (events) {
    events.push({
      type: 'card-played', handNo: state.handNo, trickNo: t.n, seat, card, mode, asLeader: lead, setsSuit: lead,
      ledSuit: t.ledSuit, island, islandCargo, countsAs: play.countsAs, sideways: play.sideways, serpents: cardSerpents(card, state.params), auto,
    });
  }
  const i = t.seats.indexOf(seat);
  if (i < t.seats.length - 1) {
    state.toAct = t.seats[i + 1];
    return;
  }
  resolveTrick(state, events);
}

/** The best number among the cards so far that count as led (0 if none), as the Python's best_rank. */
function bestCountingValue(plays) {
  let best = 0;
  for (const p of plays) if (p.mode !== 'discard' && cardValue(p.card) > best) best = cardValue(p.card);
  return best;
}

function resolveTrick(state, events) {
  const t = state.trick;
  const m = state.measures;
  const vs = state.voyageStats;
  const params = state.params;
  // R8.1 step 2: the winner (R4.7, R4.8, R13.2).
  const win = trickWinner(t.plays, state.rules.TIE);
  const w = win.seat;
  const serpentCards = t.plays.map((p) => p.card).filter((c) => cardSerpents(c, params) > 0);
  const serpents = serpentCards.reduce((a, c) => a + cardSerpents(c, params), 0);
  if (events) {
    events.push({
      type: 'trick-won', handNo: state.handNo, trickNo: t.n, winner: w, card: win.card, mode: win.mode, ledSuit: t.ledSuit,
      tie: win.tie, tieBrokenBy: win.tieBrokenBy, cards: t.plays.map((p) => p.card), serpents,
    });
  }
  // R8.1 step 3: take the cards; serpent cards face up in front of the winner (R4.9), the rest face down.
  for (const p of t.plays) {
    if (cardSerpents(p.card, params) > 0) state.serpentRows[w].push(p.card);
    else state.wonPiles[w].push(p.card);
  }
  state.tricksWon[w]++;
  state.serpentsTaken[w] += serpents;
  m.tricks++;
  m.tricksWon[w]++;
  m.serpentsTaken[w] += serpents;
  if (serpents === 0) m.cleanTricks++;
  if (win.tie) { m.ties++; vs.ties++; }
  if (w === t.leader) m.leaderWins++;
  if (win.mode === 'trade') {
    m.tradesWon++;
    vs.tradesWon[w]++;
    if (serpents > 0) m.tradeSerpentWins++;
  }
  if (serpents > 0 && events) {
    events.push({ type: 'serpent-taken', handNo: state.handNo, trickNo: t.n, seat: w, cards: serpentCards, serpents, totalSerpents: state.serpentsTaken[w] });
  }
  // R8.1 step 4: every seat that did not follow sails one island clockwise (R4.10), in trick order.
  const sailList = [];
  for (const p of t.plays) {
    if (!sails(p.mode)) continue;
    const from = state.ships[p.seat];
    const to = (from + params.sailStep) % params.islands;
    state.ships[p.seat] = to;
    vs.sails[p.seat]++;
    m.sails++;
    m.sailsBySeat[p.seat]++;
    sailList.push({ seat: p.seat, from, to, cause: p.mode });
    if (events) {
      events.push({ type: 'sailed', handNo: state.handNo, trickNo: t.n, seat: p.seat, from, to, cause: p.mode, fromCargo: state.ring[from], toCargo: state.ring[to] });
    }
  }
  const record = {
    n: t.n, leader: t.leader, seats: [...t.seats], ledSuit: t.ledSuit,
    plays: t.plays.map((p) => ({ ...p })),
    winner: w, winningCard: win.card, winningMode: win.mode, tie: win.tie, tieBrokenBy: win.tieBrokenBy,
    serpents, serpentCards, sails: sailList,
  };
  state.tricks.push(record);
  state.trick = null;
  state.trickNo++;
  afterTrick(state, events);
}

/** 'hands-empty' when the voyage is over (R5.1: every hand empties on the same trick), else null. */
export function handEndReason(state) {
  return state.hands.every((h) => h.length === 0) ? 'hands-empty' : null;
}

function afterTrick(state, events) {
  const reason = handEndReason(state);
  if (reason) { endHand(state, reason, events); return; }
  const last = state.tricks[state.tricks.length - 1];
  state.leader = last.winner; // R4.11 the winner leads the next trick, from the island they now stand on
  state.toAct = last.winner;
}

// ---------- the end of a voyage (R5, R8.2) and of the game (R6) ----------

function endHand(state, reason, events) {
  const n = state.n;
  const m = state.measures;
  const vs = state.voyageStats;
  state.phase = 'voyageEnd';
  state.toAct = null;
  const rk = reckonHand(state);
  const rec = {
    handNo: state.handNo,
    voyage: state.handNo + 1,
    dealer: state.dealer,
    firstLeader: (state.dealer + 1) % n,
    mooringOrder: [...state.mooringOrder],
    handSize: state.handSize,
    setAside: state.setAside.length, // R5.6: the count only, never the cards (R9.7)
    ring: [...state.ring],
    islandFaces: [...state.islandFaces],
    startIsland: [...state.startIslands],
    endIsland: [...state.ships],
    endReason: reason,
    tricksWon: [...state.tricksWon],
    serpentsTaken: [...state.serpentsTaken],
    trickPoints: rk.trickPoints,
    serpentPoints: rk.serpentPoints,
    scores: rk.scores,
    trades: [...vs.trades],
    tradesWon: [...vs.tradesWon],
    forcedTens: [...vs.forcedTens],
    discards: [...vs.discards],
    sails: [...vs.sails],
    ties: vs.ties,
    tricksPlayed: state.tricks.length,
    tricks: state.tricks,
  };
  for (let s = 0; s < n; s++) {
    state.totals[s] += rk.scores[s];
    if (vs.sails[s] === 0) m.parked++;
  }
  m.hands++;
  state.handLog.push(rec);
  state.tricks = [];
  if (events) {
    events.push({
      type: 'voyage-ended', handNo: state.handNo, voyage: state.handNo + 1, handsPerGame: state.params.handsPerGame, endReason: reason,
      tricksWon: [...rec.tricksWon], serpentsTaken: [...rec.serpentsTaken], trickPoints: rk.trickPoints, serpentPoints: rk.serpentPoints,
      scores: [...rk.scores], totals: [...state.totals],
      lines: rk.lines.map((l, s) => ({ ...l, total: state.totals[s] })),
    });
  }

  state.handNo++;
  if (state.handNo >= state.params.handsPerGame) {
    state.phase = 'over';
    state.toAct = null;
    state.result = gameResult(state);
    if (events) events.push({ type: 'game-over', ...JSON.parse(JSON.stringify(state.result)) });
    return;
  }
  dealHand(state, events); // R2.5 everything gathered, a fresh ring and a fresh deal
}
