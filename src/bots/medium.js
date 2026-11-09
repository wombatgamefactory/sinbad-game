// medium.js - Medium bot: the Python heuristic, ported decision for decision. Level id 'medium'.
//
// Source: the heuristic bot of the original Python simulator (its card choice and its mooring choice).
// What the Python does, and so what this does:
//
//   MOOR     tgt = a random pick among the cargoes the hand holds MOST of; then a random island of that
//            cargo. (It ignores every other ship and the mooring order.)
//   LEAD     a 1 if it holds one (random among them), else the LOWEST card of its LONGEST cargo.
//   FOLLOW / TRADE   `winners` = legal cards above the best card counting as led so far, `losers` = the rest.
//            - the trick so far holds NO serpent and a winner exists: the LOWEST winner (take a clean
//              trick cheaply);
//            - else if a loser exists: duck, shedding the loser with the most serpents (then the highest
//              number); no serpent loser: the HIGHEST loser;
//            - else (every card wins, forced): the LOWEST winner.
//            "Winning" is `number > best` strictly, so a tie counts as losing (first played wins, R4.8).
//            The serpent count is of the cards already in the trick, discards included; the choice never
//            looks at which cards are still to come, at voids, or at the player's own card's serpents.
//   DISCARD  a 10 (random among tens), else a 1 (random), else the highest card.
//
// Ties the Python leaves to chance or to its data order:
//   - `rng.choice` corners (moor cargo and island, which 1, which 10): drawn from the bot's rng when one is
//     given, the first in engine order otherwise;
//   - "longest cargo" ties and equal-number ties in `max(...)` (Python: the order of a set of tuples, which
//     is arbitrary): the same rule, rng draw or first in cargo order (pearls, silk, spice, amber, which is
//     the Python's id order and what `sorted(cands)` gives).
// Hard's rollouts call it with no rng, so a rollout is deterministic and cheap.
//
// Beyond the Python (it supports none of the five switches, spec D8), chosen so every variant plays sensibly:
//   TRADE=optional   a void player holding island cargo may play anything. Its island-cargo cards are
//                    trades (they count as led), every other card a discard (cannot win). The same
//                    follow/trade rule is run over the WHOLE legal set, discards counting as losers; so a
//                    spare 10 is shed as a discard on a dirty trick instead of being forced into a trade.
//   TIE=real         a real card equal to the best card, when only trade cards hold that number, wins.
//   SCORING=serpents tricks score nothing, so there is no "clean trick worth taking": it always ducks when
//                    it can, shedding serpents first.
//   MOOR=score       nothing to change: it moors by its own hand, in whatever order the engine asks.
// None of these paths is reached under the standard rules, so the Python decision-match is unaffected.
//
// Two rules hold whatever it plays:
//   1. The decision is a pure function of plain data (mediumChoose), so the SAME code serves the real bot
//      (from a view) and Hard's rollouts (from a full state, no viewFor per step).
//   2. It returns one of the legal actions it was given.

import { legalActionsFromView, getValidActions, SUITS, rngPick } from '../engine/index.js';
import { cardSuit, cardValue, cardSerpents } from '../engine/cards.js';

/** One of `items`: a draw from `rng` when it is given and there is a choice, else the first. */
function pickOne(items, rng) {
  return items.length > 1 && rng ? rngPick(rng, items) : items[0];
}

/**
 * The card with the greatest (or least) key; on a tie `rng` draws, else the first in `cards` order.
 * Strict comparisons keep the first of equals when there is no rng.
 */
function extreme(cards, key, wantMax, rng) {
  let best = null;
  let bestKey = wantMax ? -Infinity : Infinity;
  let ties = null;
  for (const c of cards) {
    const k = key(c);
    if (wantMax ? k > bestKey : k < bestKey) { best = c; bestKey = k; ties = null; } else if (k === bestKey && rng) {
      if (!ties) ties = [best];
      ties.push(c);
    }
  }
  return ties ? rngPick(rng, ties) : best;
}

const value = (c) => cardValue(c);

/** Cargoes with the greatest number of cards in a hand, in cargo order. */
function longestCargoes(hand) {
  let best = 0;
  const counts = SUITS.map((s) => {
    let k = 0;
    for (const c of hand) if (cardSuit(c) === s) k++;
    if (k > best) best = k;
    return k;
  });
  return SUITS.filter((_, i) => counts[i] === best);
}

/** The island to moor at: the Python's mooring policy (D5). */
export function chooseMooring(ctx, legal, rng) {
  const cargo = pickOne(longestCargoes(ctx.hand), rng);
  const islands = legal.filter((a) => ctx.ring[a.island] === cargo);
  return pickOne(islands.length ? islands : legal, rng);
}

/**
 * The Python `choose` for a lead.
 * @param {string[]} cards the hand (everything is legal)
 */
function chooseLead(cards, rng) {
  const ones = cards.filter((c) => cardValue(c) === 1);
  if (ones.length) return pickOne(ones, rng);
  const cargo = pickOne(longestCargoes(cards), rng);
  return extreme(cards.filter((c) => cardSuit(c) === cargo), value, false, rng);
}

/** The Python `choose` for a discard (every legal card is a discard). */
function chooseDiscard(cards, rng) {
  const tens = cards.filter((c) => cardValue(c) === 10);
  if (tens.length) return pickOne(tens, rng);
  const ones = cards.filter((c) => cardValue(c) === 1);
  if (ones.length) return pickOne(ones, rng);
  return extreme(cards, value, true, rng);
}

/**
 * What the trick so far is worth to a player about to follow or trade.
 * @returns {{ best:number, tradeOnly:boolean, serpents:number, island:string|null, led:string }}
 */
function trickSoFar(ctx, t) {
  let best = 0;
  let realAtBest = false;
  let serpents = 0;
  for (const p of t.plays) {
    serpents += cardSerpents(p.card, ctx.params);
    if (p.mode === 'discard') continue;
    const v = cardValue(p.card);
    if (v > best) { best = v; realAtBest = p.mode !== 'trade'; } else if (v === best && p.mode !== 'trade') realAtBest = true;
  }
  const i = ctx.ships[ctx.seat];
  return { best, tradeOnly: best > 0 && !realAtBest, serpents, island: i === null || i === undefined ? null : ctx.ring[i], led: t.ledSuit };
}

/**
 * The Python `choose` for a follow or a trade (and, under TRADE=optional, the mixed trade-or-discard set).
 * @param {{ duckAlways?:boolean }} [opts] duckAlways: never take a trick that can be ducked (an archetype)
 */
function chooseFollowOrTrade(ctx, cards, t, rng, opts) {
  const s = trickSoFar(ctx, t);
  const tieReal = ctx.rules && ctx.rules.TIE === 'real';
  const winners = [];
  const losers = [];
  let counting = false;
  for (const c of cards) {
    const suit = cardSuit(c);
    const follows = suit === s.led;
    const trades = !follows && suit === s.island; // legal + not led + island cargo = a trade (void in the led cargo)
    if (!follows && !trades) { losers.push(c); continue; } // a discard never counts as led
    counting = true;
    const v = cardValue(c);
    if (v > s.best || (tieReal && v === s.best && s.tradeOnly && follows)) winners.push(c); else losers.push(c);
  }
  if (!counting) return chooseDiscard(cards, rng);
  const tricksScore = ctx.params.trickPoints > 0;
  const clean = tricksScore && s.serpents === 0 && !(opts && opts.duckAlways);
  if (clean && winners.length) return extreme(winners, value, false, rng); // take a clean trick cheaply
  if (losers.length) {
    const serp = (c) => cardSerpents(c, ctx.params);
    const serpy = losers.filter((c) => serp(c) > 0);
    if (serpy.length) return extreme(serpy, (c) => serp(c) * 100 + cardValue(c), true, rng); // duck, shedding serpents first
    return extreme(losers, value, true, rng); // duck high
  }
  return extreme(winners, value, false, rng); // forced to win: as cheaply as it can
}

/**
 * The Medium decision from plain data.
 * @param {{ seat:number, hand:string[], trick:object|null, params:object, rules:object, ring:string[],
 *   ships:(number|null)[], phase:string }} ctx
 * @param {{type:string, card?:string, island?:number}[]} legal  the legal actions
 * @param {{s:number}|null} [rng] draws the Python's random corners; none = the first of equals
 * @param {{ duckAlways?:boolean }} [opts]
 */
export function mediumChoose(ctx, legal, rng = null, opts = null) {
  if (legal.length === 1) return legal[0];
  if (ctx.phase === 'moor') return chooseMooring(ctx, legal, rng);
  const cards = legal.map((a) => a.card);
  const t = ctx.trick;
  const card = !t || t.plays.length === 0 ? chooseLead(cards, rng) : chooseFollowOrTrade(ctx, cards, t, rng, opts);
  return legal.find((a) => a.card === card);
}

const ctxOf = (st, seat, hand) => ({ seat, hand, trick: st.trick, params: st.params, rules: st.rules, ring: st.ring, ships: st.ships, phase: st.phase });

/** The plain-data context mediumChoose needs, from a view (the archetypes share it). */
export const contextFromView = (view) => ctxOf(view, view.seat, view.hand);

/** The Medium choice from a view (what the real bot sees). `rng` draws the random corners. */
export function chooseMediumFromView(view, rng = null) {
  return mediumChoose(contextFromView(view), legalActionsFromView(view), rng);
}

/** The Medium choice for the seat to act in a full state (Hard's rollouts; no view is built, no rng). */
export function mediumActionFromState(st) {
  const seat = st.toAct;
  return mediumChoose(ctxOf(st, seat, st.hands[seat]), getValidActions(st), null);
}

export const mediumBot = {
  id: 'medium',
  label: 'Medium',
  chooseAction(view, rng) {
    return chooseMediumFromView(view, rng);
  },
};
