// legality.js - legal actions, block reasons, the play mode (lead / follow / trade / discard) and the
// trick-winner rule.
//
// ONE implementation of "which cards may this seat play": playableCards(). It reads only the
// actor's own hand, the led cargo, the cargo of the actor's island and the rules, so getValidActions
// (full state) and legalActionsFromView (a bot's view, view.js) both call it and cannot disagree.
// applyAction refuses through getActionBlockReason, which asks the same function.
//
// Actions (the acting seat is always state.toAct; actions carry no seat):
//   { type: 'moor', island }  phase 'moor': moor this seat's ship at island index 0..7 (R3.5, R3.6)
//   { type: 'play', card }    phase 'play': a card to the trick (R4.1, R4.3). The engine infers the
//                             mode; the trade and the sail are consequences, never separate actions.

import { SUIT_NAMES } from './rules.js';
import { cardSuit, cardValue, cardName, listCardNames } from './cards.js';

/**
 * R4.3 the ladder (and R13.3 under TRADE=optional). Every card of `hand` that may be played now.
 * @param {string[]} hand
 * @param {string|null} ledSuit      the led cargo, or null in a lead position (anything may be led)
 * @param {string|null} islandCargo  the cargo of the island the actor's ship stands on (R4.15)
 * @param {object} [rules]           resolved rules (TRADE)
 */
export function playableCards(hand, ledSuit, islandCargo, rules) {
  if (ledSuit === null || ledSuit === undefined) return [...hand]; // R4.1 lead anything
  const follow = hand.filter((c) => cardSuit(c) === ledSuit);
  if (follow.length) return follow; // rung 1: must follow
  const trades = islandCargo ? hand.filter((c) => cardSuit(c) === islandCargo) : [];
  if (trades.length && !(rules && rules.TRADE === 'optional')) return trades; // rung 2: must trade (R4.4)
  return [...hand]; // rung 3: discard anything (or, TRADE=optional, trade or discard: R13.3)
}

/** No interchangeable cards in Sinbad: the legal cards are the playable cards. */
export function legalCards(hand, ledSuit, islandCargo, rules) {
  return playableCards(hand, ledSuit, islandCargo, rules);
}

/**
 * R4.16 what a legal card IS when played from `hand` (which still holds it):
 * 'lead' | 'follow' | 'trade' | 'discard'. A card of the island's cargo played while void in the
 * led cargo is always a trade (R4.3 rung 2; R13.3 reading under TRADE=optional).
 */
export function playMode(hand, card, ledSuit, islandCargo) {
  if (ledSuit === null || ledSuit === undefined) return 'lead';
  const s = cardSuit(card);
  if (s === ledSuit) return 'follow';
  if (islandCargo && s === islandCargo && !hand.some((c) => cardSuit(c) === ledSuit)) return 'trade';
  return 'discard';
}

/** True for a play that counts as the led cargo (R4.7): the lead, a follow or a trade. */
export const countsAsLed = (mode) => mode !== 'discard';
/** True for a play that sails the ship afterwards (R4.10): a trade or a discard. */
export const sails = (mode) => mode === 'trade' || mode === 'discard';

/**
 * R4.7, R4.8, R4.12, R13.2 the winner of a (possibly partial) trick: the highest-numbered card that
 * counts as led; on a tie the card played first, except under TIE=real a real card (lead / follow)
 * beats a trade of the same number. Discards never win. Null when no plays yet.
 * @param {{seat:number, card:string, mode:string}[]} plays in play order
 * @param {string} [tieRule]  rules.TIE: 'first' (default) | 'real'
 * @returns {{ index:number, seat:number, card:string, mode:string, value:number, tie:boolean,
 *   tieBrokenBy:'first'|'real'|null } | null}
 */
export function trickWinner(plays, tieRule = 'first') {
  let best = -1;
  let bestValue = -1;
  plays.forEach((p, i) => {
    if (!countsAsLed(p.mode)) return;
    const v = cardValue(p.card);
    if (v > bestValue) { best = i; bestValue = v; return; }
    if (v === bestValue && tieRule === 'real' && plays[best].mode === 'trade' && p.mode !== 'trade') best = i;
  });
  if (best < 0) return null;
  const tied = plays.filter((p) => countsAsLed(p.mode) && cardValue(p.card) === bestValue);
  const tie = tied.length > 1;
  let tieBrokenBy = null;
  if (tie) tieBrokenBy = tied[0] === plays[best] ? 'first' : 'real';
  return { index: best, seat: plays[best].seat, card: plays[best].card, mode: plays[best].mode, value: bestValue, tie, tieBrokenBy };
}

/** The cargo of the island seat `seat`'s ship stands on, or null if unmoored. Works on a state or a view. */
export function islandCargoOf(st, seat) {
  const i = st.ships[seat];
  return i === null || i === undefined ? null : st.ring[i];
}

/**
 * The legal actions of the seat to act in a state-like object (state or view).
 * @param {object} st  needs phase, toAct, trick, rules, ring, ships, params.islands, and `hand`
 * @param {string[]} hand  the actor's hand
 */
function actionsFor(st, hand) {
  if (st.phase === 'moor') {
    return Array.from({ length: st.params.islands }, (_, island) => ({ type: 'moor', island }));
  }
  if (st.phase === 'play') {
    const led = st.trick ? st.trick.ledSuit : null;
    return legalCards(hand, led, islandCargoOf(st, st.toAct), st.rules).map((card) => ({ type: 'play', card }));
  }
  return [];
}

/** Every legal action for state.toAct; empty when nobody may act. Complete and sound. */
export function getValidActions(state) {
  if (state.toAct === null || state.phase === 'over' || state.phase === 'voyageEnd') return [];
  return actionsFor(state, state.hands[state.toAct]);
}

/** Internal: shared with view.js. */
export { actionsFor as legalActionsFor };

/**
 * Why `seat` may not play `card` now, as a sentence addressed to that player, or null if it is
 * legal. For UI tooltips; checks in rule-book order (R9.12).
 */
export function getPlayBlockReason(state, seat, card) {
  if (state.phase === 'over') return 'The game is over.';
  if (seat !== state.toAct) return 'It is not your turn.';
  if (state.phase === 'moor') return 'Moor your ship first: choose an island.';
  if (state.phase !== 'play') return 'Wait for the next voyage.';
  const hand = state.hands[seat];
  if (!hand.includes(card)) return `You do not hold ${typeof card === 'string' && card.includes('-') ? cardName(card) : JSON.stringify(card)}.`;
  const led = state.trick ? state.trick.ledSuit : null;
  const island = islandCargoOf(state, seat);
  const ok = playableCards(hand, led, island, state.rules);
  if (ok.includes(card)) return null;
  const follow = hand.filter((c) => cardSuit(c) === led);
  if (follow.length) return `Follow ${SUIT_NAMES[led]}: ${SUIT_NAMES[led]} was led, and you hold ${listCardNames(follow)}.`;
  const trades = hand.filter((c) => cardSuit(c) === island);
  return `Your island demands ${SUIT_NAMES[island]}: you have no ${SUIT_NAMES[led]}, so you must trade ${trades.length === 1 ? cardName(trades[0]) : `one of ${listCardNames(trades)}`}.`;
}

/** Why an action object is refused, or null. */
export function getActionBlockReason(state, action) {
  const types = ['play', 'moor'];
  if (!action || !types.includes(action.type)
    || (action.type === 'play' && typeof action.card !== 'string')
    || (action.type === 'moor' && !Number.isInteger(action.island))) {
    return `Unknown action ${JSON.stringify(action)}; actions are { type: 'moor', island } and { type: 'play', card }.`;
  }
  if (state.phase === 'over' || state.toAct === null) return 'The game is over.';
  if (state.phase === 'moor') {
    if (action.type !== 'moor') return 'Moor your ship first: choose an island.';
    if (action.island < 0 || action.island >= state.params.islands) return `Choose an island 1 to ${state.params.islands}.`;
    return null;
  }
  if (state.phase === 'play') {
    if (action.type !== 'play') return 'Every ship is moored: play a card to the trick.';
    return getPlayBlockReason(state, state.toAct, action.card);
  }
  return 'Wait for the next voyage.';
}
