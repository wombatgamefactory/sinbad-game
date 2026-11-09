// archetypes.js - simulator-only reference bots (offered: false, never in the UI menus).
//
// They give balance runs something to measure the real levels against (the ledger's five). Each differs
// from Medium in one habit, so a run says what that habit is worth. All of them read only the view, all
// of them handle every variant value (they choose from the legal set the view gives, and the rule
// switches change that set, not their habit).
//
//   always-duck      Medium, but it never takes a trick it can duck, even a clean one. Tests "is winning
//                    tricks worth anything" (the +1 per trick against the serpents that come with them).
//   win-trades       Medium, except that when it has to trade it plays the LOWEST trade card that wins the
//                    trick, whatever the serpents; if no trade card can win it plays as Medium does.
//                    Tests the mandatory trade's "duck low or win high" choice.
//   random-moor      Medium's card play, but it moors at a uniformly random island instead of its
//                    longest cargo. Tests how much the mooring policy is worth.
//   serpent-hoarder  Medium, but it never plays a serpent card (a 1 or a 10) while it holds any other
//                    legal card: it keeps them, as a player who treats 10s as "high cards" does, and
//                    sheds them only when forced. Tests the shed-serpents-first habit.
//   high / low       Two plain reference bots, kept because tests/sim-check.mjs and the simulator
//                    flags use them: always the highest / lowest legal card; moors at the first / last island.
//   naive            Moors at island 1 (index 0). Leads its highest card. Otherwise plays the LOWEST card
//                    that wins the trick so far, else its lowest legal card. Knows nothing of serpents
//                    or cargo length: the "win if you can" beginner.

import { legalActionsFromView, rngPick } from '../engine/index.js';
import { cardValue, cardSerpents } from '../engine/cards.js';
import { playMode, islandCargoOf } from '../engine/legality.js';
import { mediumChoose, contextFromView } from './medium.js';

const isMoor = (legal) => legal[0].type === 'moor';

/** The best number among the cards in the trick so far that count as led (0 if none). */
function bestCounting(trick) {
  let best = 0;
  if (trick) for (const p of trick.plays) if (p.mode !== 'discard' && cardValue(p.card) > best) best = cardValue(p.card);
  return best;
}

const lowest = (cards) => cards.reduce((a, b) => (cardValue(b) < cardValue(a) ? b : a));
const highest = (cards) => cards.reduce((a, b) => (cardValue(b) > cardValue(a) ? b : a));

function archetype(id, label, choose) {
  return {
    id,
    label,
    offered: false,
    chooseAction(view, rng) {
      const legal = legalActionsFromView(view);
      if (legal.length === 1) return legal[0];
      return choose(view, legal, rng);
    },
  };
}

export const alwaysDuckBot = archetype('always-duck', 'Always duck', (view, legal, rng) => mediumChoose(contextFromView(view), legal, rng, { duckAlways: true }));

export const winTradesBot = archetype('win-trades', 'Always win trades', (view, legal, rng) => {
  const ctx = contextFromView(view);
  if (!isMoor(legal) && view.trick && view.trick.plays.length) {
    const island = islandCargoOf(view, view.seat);
    const best = bestCounting(view.trick);
    const trades = legal.filter((a) => playMode(view.hand, a.card, view.trick.ledSuit, island) === 'trade');
    const winners = trades.filter((a) => cardValue(a.card) > best);
    if (winners.length) return winners.reduce((a, b) => (cardValue(b.card) < cardValue(a.card) ? b : a));
  }
  return mediumChoose(ctx, legal, rng);
});

export const randomMoorBot = archetype('random-moor', 'Random mooring', (view, legal, rng) => (isMoor(legal) ? rngPick(rng, legal) : mediumChoose(contextFromView(view), legal, rng)));

export const serpentHoarderBot = archetype('serpent-hoarder', 'Serpent hoarder', (view, legal, rng) => {
  if (isMoor(legal)) return mediumChoose(contextFromView(view), legal, rng);
  const quiet = legal.filter((a) => cardSerpents(a.card, view.params) === 0);
  return mediumChoose(contextFromView(view), quiet.length ? quiet : legal, rng);
});

export const naiveBot = archetype('naive', 'Naive', (view, legal) => {
  if (isMoor(legal)) return legal[0];
  const cards = legal.map((a) => a.card);
  const pick = (c) => legal.find((a) => a.card === c);
  const t = view.trick;
  if (!t || t.plays.length === 0) return pick(highest(cards));
  const island = islandCargoOf(view, view.seat);
  const best = bestCounting(t);
  const winners = cards.filter((c) => playMode(view.hand, c, t.ledSuit, island) !== 'discard' && cardValue(c) > best);
  return pick(winners.length ? lowest(winners) : lowest(cards));
});

function byValue(id, label, pick) {
  return archetype(id, label, (view, legal) => {
    if (isMoor(legal)) return legal[pick === 'high' ? 0 : legal.length - 1];
    return [...legal].sort((a, b) => cardValue(a.card) - cardValue(b.card))[pick === 'high' ? legal.length - 1 : 0];
  });
}

export const highBot = byValue('high', 'Always high', 'high');
export const lowBot = byValue('low', 'Always low', 'low');

/** The five archetypes of the build plan. */
export const ARCHETYPES = [alwaysDuckBot, winTradesBot, randomMoorBot, serpentHoarderBot, naiveBot];
/** The plain reference bots (not part of the five). */
export const KIT_REFERENCES = [highBot, lowBot];
