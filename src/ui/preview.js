// preview.js - "what would this do?", by clone-and-apply.
//
// The UI never re-derives a rule. To hint at a card it copies the state, applies the action with
// the engine, and reads what happened: the card-played event says what the card IS (lead / follow /
// trade / discard), the sailed event where the ship would go; if the trick completed (the engine plays
// forced moves on its own) the trick-won event says who won; if the trick is still open, the engine's
// trickWinner() names who leads it right now. The real state is never touched.

import { applyAction, getActionBlockReason, trickWinner, cloneState } from '../engine/index.js';

/**
 * @param {object} state  the live state; the seat to act is state.toAct (phase 'play')
 * @param {string} card
 * @returns {null | object}  null if the card may not be played now. Otherwise
 *   { kind: 'lead'|'follow', mode: 'lead'|'follow'|'trade'|'discard', seat, card, ledSuit,
 *     wins, final (the trick is decided), remaining (plays still to come when not final),
 *     winnerSeat, winnerCard, serpents (in the trick when final), sails, sailTo, sailToCargo }
 */
export function previewCard(state, card) {
  const seat = state.toAct;
  if (seat === null || state.phase !== 'play') return null;
  const action = { type: 'play', card };
  if (getActionBlockReason(state, action) !== null) return null;
  const sim = cloneState(state);
  const events = applyAction(sim, action);
  const played = events.find((e) => e.type === 'card-played');
  const trickN = state.trick ? state.trick.n : state.trickNo + 1;
  const won = events.find((e) => e.type === 'trick-won' && e.handNo === state.handNo && e.trickNo === trickN);
  const sailed = events.find((e) => e.type === 'sailed' && e.handNo === state.handNo && e.trickNo === trickN && e.seat === seat);
  const base = {
    seat, card, mode: played.mode, ledSuit: played.ledSuit, wins: false, final: !!won, remaining: 0, winnerSeat: null, winnerCard: null,
    serpents: won ? won.serpents : 0, sails: played.mode === 'trade' || played.mode === 'discard',
    sailTo: sailed ? sailed.to : (state.ships[seat] + state.params.sailStep) % state.params.islands,
    sailToCargo: sailed ? sailed.toCargo : state.ring[(state.ships[seat] + state.params.sailStep) % state.params.islands],
  };
  if (won) {
    Object.assign(base, { wins: won.winner === seat, winnerSeat: won.winner, winnerCard: won.card });
  } else {
    const win = trickWinner(sim.trick.plays, state.rules.TIE);
    base.remaining = sim.trick.seats.length - sim.trick.plays.length;
    if (win) Object.assign(base, { wins: win.seat === seat, winnerSeat: win.seat, winnerCard: win.card });
  }
  return { ...base, kind: !won && played.setsSuit ? 'lead' : 'follow' };
}
