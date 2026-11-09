// hard.js - Hard bot: determinised Monte Carlo search with Medium rollouts. Level id 'hard'.
//
// At each real decision (a card to play, or the island to moor at):
//   1. Sample worlds consistent with what this seat can see (engine determinise()): the cards it cannot
//      place (the other hands and the set-aside) are dealt to the other hands honouring every cargo a
//      seat has SHOWN it lacks (shownVoids: every trade and every discard shows a void in the led cargo,
//      and a discard also shows no card of that seat's island cargo, because the trade would have been
//      forced). The leftover cards are the set-aside.
//   2. In EACH world, play every candidate action, then finish the voyage with the Medium policy for
//      EVERY seat (this one included), using the real engine (applyAction): later moorings, the sail
//      step, the serpents taken and the reckoning are all played out, and every variant is honoured.
//      When the decision is a mooring, the rollout also moors every seat still to moor, so the island
//      is scored by the whole voyage it leads to.
//   3. Score a rollout by the final-score margin: my running total minus the best rival's when the voyage
//      ends ("expected game margin, given the totals so far"). An action's score is the mean over worlds.
//      The same worlds serve every candidate (common random numbers), so the comparison is paired and
//      much less noisy.
//   4. On the last voyage of the game the end-of-game result (totals, then the final-voyage tiebreak,
//      then shared wins, taken from the engine's gameResult) is a minor term: HARD_WIN_BONUS for a sole
//      win, half of it for a shared win, minus it for a loss.
//
// It reads only its view. It draws from the rng it is given (so a game is reproducible from a seed) and
// never reads a clock: the cost of a decision is bounded by a fixed budget of rollouts. A CALLER that
// wants a wall-clock limit passes `ctx.expired` (a function returning true once the time is up): the
// search then stops between worlds and uses the worlds done so far, or, with fewer than
// HARD_MIN_WORLDS_ON_TIMEOUT done, Medium's choice. The UI's Web Worker supplies it (see HARD_TIME_BUDGET_MS).

import { applyAction, determinise, legalActionsFromView } from '../engine/index.js';
import { mediumActionFromState, chooseMediumFromView } from './medium.js';

// ---- tuning constants ------------------------------------------------------------------------------------
/** Worlds sampled per decision when there are few candidates (the nominal sample count). */
export const HARD_SAMPLES = 48;
/** Fewest worlds per decision, however many candidates there are. */
export const HARD_MIN_SAMPLES = 8;
/**
 * Cap on rollouts per decision (worlds x candidates). Measured (tests/bots.mjs --timing): p95 about 30 ms at 5
 * players in Node, far inside the ~250 ms target. Strength stops growing between 16 and 64 worlds (a Hard seat
 * against three Medium at 4p wins 67-68% of games at 16, 32 and 64 worlds, 60% at 8, 56% at 4), so the extra
 * headroom is spent on steadiness, not strength.
 */
export const HARD_MAX_ROLLOUTS = 512;
/** Margin points added to the score of the action Medium would choose (a prior that damps sampling noise). */
export const HARD_MEDIUM_PRIOR = 0.15;
/** Margin points for winning the whole game outright (half if shared, negative if lost); last voyage only. */
export const HARD_WIN_BONUS = 0.25;
/**
 * Wall-clock budget for one decision in the browser worker, in milliseconds. The worker builds `ctx.expired`
 * from it; this file never reads a clock. The normal budget of rollouts finishes far inside it on a laptop;
 * it is the guard for a slow phone.
 */
export const HARD_TIME_BUDGET_MS = 1500;
/** If the budget runs out with fewer worlds than this done, Hard returns Medium's choice instead. */
export const HARD_MIN_WORLDS_ON_TIMEOUT = 3;

/**
 * A copy of a determinised world that applyAction can mutate without touching the original, much cheaper
 * than a deep copy. The copy's game is cut to end with the current voyage (params.handsPerGame = handNo + 1),
 * so the engine scores the voyage and stops instead of dealing the next one. The face-down piles become empty
 * (nothing in the engine reads them back; they exist for the conservation checks). Arrays the engine
 * changes in place are copied; everything it only reads is shared.
 */
function cloneWorld(s) {
  const measures = { ...s.measures };
  for (const k of Object.keys(measures)) if (Array.isArray(measures[k])) measures[k] = measures[k].slice();
  const v = s.voyageStats;
  return {
    ...s,
    params: { ...s.params, handsPerGame: s.handNo + 1 },
    hands: s.hands.map((h) => h.slice()),
    ships: s.ships.slice(),
    startIslands: s.startIslands.slice(),
    serpentRows: s.serpentRows.map((r) => r.slice()),
    wonPiles: s.wonPiles.map(() => []),
    tricksWon: s.tricksWon.slice(),
    serpentsTaken: s.serpentsTaken.slice(),
    voyageStats: { trades: v.trades.slice(), tradesWon: v.tradesWon.slice(), forcedTens: v.forcedTens.slice(), discards: v.discards.slice(), sails: v.sails.slice(), ties: v.ties },
    trick: s.trick ? { ...s.trick, plays: s.trick.plays.slice() } : null,
    tricks: s.tricks.slice(),
    handLog: s.handLog.slice(),
    totals: s.totals.slice(),
    measures,
  };
}

/**
 * Plays the rest of the voyage with the rollout policy for every seat; returns the margin of seat `me`.
 * `lastVoyage`: this is the real game's last voyage, so the game result (the tiebreak) counts a little.
 */
function rollout(st, me, lastVoyage, policy) {
  while (st.toAct !== null) applyAction(st, policy(st), { silent: true });
  let best = -Infinity;
  for (let s = 0; s < st.n; s++) if (s !== me && st.totals[s] > best) best = st.totals[s];
  let value = st.totals[me] - best;
  if (lastVoyage && st.result) {
    const r = st.result;
    if (r.winners.includes(me)) value += r.winners.length === 1 ? HARD_WIN_BONUS : HARD_WIN_BONUS / 2;
    else value -= HARD_WIN_BONUS;
  }
  return value;
}

/** How many worlds to sample for this many candidate actions. */
export function samplesFor(candidates, maxRollouts = HARD_MAX_ROLLOUTS) {
  return Math.max(HARD_MIN_SAMPLES, Math.min(HARD_SAMPLES, Math.floor(maxRollouts / candidates)));
}

/**
 * The view as the sampler needs it: the earlier voyages' trick detail is dropped (the sampler copies it
 * every world; the scores are all a rollout needs). Voids come from the engine's shownVoids, which under
 * TRADE=optional records only the led-cargo void for a discard (R9.9, R13.3).
 */
export function samplingView(view) {
  return { ...view, handLog: view.handLog.map((h) => ({ ...h, tricks: [] })) };
}

const sameAction = (a, b) => a.type === b.type && a.card === b.card && a.island === b.island;

/**
 * The best action by mean margin; exposes the scores for tests and tuning.
 * @param {object} view
 * @param {{s:number}} rng
 * @param {{ samples?:number|null, prior?:number, policy?:(state:object)=>object, priorAction?:(view:object)=>object,
 *   expired?:(()=>boolean)|null }} [opts]
 *   policy: the rollout policy (state -> action), default Medium; priorAction: the choice that gets the prior;
 *   expired: the caller's clock (see the file header).
 * @returns {{ action:object, scores:number[], worlds:number }}
 */
export function searchAction(view, rng, { samples = null, prior = HARD_MEDIUM_PRIOR, policy = mediumActionFromState, priorAction = chooseMediumFromView, expired = null } = {}) {
  const legal = legalActionsFromView(view);
  if (legal.length === 1) return { action: legal[0], scores: [0], worlds: 0 };
  const me = view.seat;
  const nWorlds = samples === null ? samplesFor(legal.length) : samples;
  const sums = legal.map(() => 0);
  const light = samplingView(view);
  const lastVoyage = view.handNo + 1 >= view.params.handsPerGame;
  let done = 0;
  for (let w = 0; w < nWorlds; w++) {
    if (expired && expired()) break;
    const world = determinise(light, rng);
    for (let i = 0; i < legal.length; i++) {
      const st = cloneWorld(world);
      applyAction(st, legal[i], { silent: true });
      sums[i] += rollout(st, me, lastVoyage, policy);
    }
    done++;
  }
  const priorChoice = priorAction(view);
  if (done < (expired ? HARD_MIN_WORLDS_ON_TIMEOUT : 1)) {
    return { action: legal.find((a) => sameAction(a, priorChoice)) || legal[0], scores: sums.map(() => 0), worlds: done };
  }
  let bestIndex = 0;
  let bestScore = -Infinity;
  const scores = sums.map((sum, i) => sum / done + (sameAction(legal[i], priorChoice) ? prior : 0));
  for (let i = 0; i < legal.length; i++) {
    if (scores[i] > bestScore) { bestScore = scores[i]; bestIndex = i; }
  }
  return { action: legal[bestIndex], scores, worlds: done };
}

export const hardBot = {
  id: 'hard',
  label: 'Hard',
  /** When Hard runs out of time or fails, the UI falls back to this level (index.js getFallbackBot). */
  fallback: 'medium',
  /**
   * @param {object} view
   * @param {{s:number}} rng
   * @param {{ expired?: () => boolean }} [ctx] the caller's clock (the worker supplies one)
   */
  chooseAction(view, rng, ctx) {
    return searchAction(view, rng, { expired: (ctx && ctx.expired) || null }).action;
  },
};
