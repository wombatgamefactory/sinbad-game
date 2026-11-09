// controller.js - game flow and the bot driver, with no DOM. Game-agnostic: keep as it is.
//
// The UI layer owns rendering and timing; this module owns everything else: creating the game
// from the setup choices, applying human and bot actions, the bot failure cap, the event log,
// and the pass-and-play rule (with two or more humans, a hand is shown only after its owner
// has taken the device). It runs unchanged in Node (tests/controller.mjs).

import {
  startGame, applyAction, getValidActions, getPlayBlockReason, getActionBlockReason, viewFor,
  legalActionsFromView, describeEvent, makeRng, deriveSeed,
} from '../engine/index.js';
import { getBot } from '../bots/index.js';

/** Bot proposals refused in a row before the driver plays the first legal action instead. */
export const MAX_BOT_FAILURES = 3;

/**
 * @param {object} cfg
 * @param {{type: string, name?: string}[]} cfg.seats  seats: type 'human' or a bot level ('easy', ...)
 * @param {number|string} cfg.seed                    the UI picks it (e.g. from the clock); required
 * @param {object} [cfg.rules]                        variant overrides (the Playtest rules panel)
 * @param {number|null} [cfg.firstDealer]             default: drawn from the seed
 * @param {boolean} [cfg.autoPlayForced]              default true: a human's only legal card plays itself;
 *                                                     false: humans click it (the setup screen's learner option)
 */
export function createController(cfg) {
  const seats = cfg.seats.map((s) => ({ type: s.type, name: s.name || '' }));
  for (const s of seats) if (s.type !== 'human') getBot(s.type); // throws on an unknown level
  if (cfg.seed === undefined || cfg.seed === null) throw new Error('createController needs a seed');
  const seed = cfg.seed;
  const n = seats.length;
  const humanSeats = seats.map((s, i) => (s.type === 'human' ? i : -1)).filter((i) => i >= 0);
  const names = seats.map((s, i) => s.name || (s.type === 'human' ? (humanSeats.length === 1 ? 'You' : `Player ${i + 1}`) : `${getBot(s.type).label} bot ${i + 1}`));
  const autoPlayForced = cfg.autoPlayForced !== false;
  const started = startGame({ seed, players: n, rules: cfg.rules || {}, firstDealer: cfg.firstDealer ?? null, manualSeats: autoPlayForced ? [] : humanSeats });
  const state = started.state;
  const botRngs = seats.map((_, seat) => makeRng(deriveSeed(seed, 'bot', seat)));
  const log = []; // { text, event }
  const listeners = new Set();
  let revealedSeat = null; // pass-and-play: whose hand is on show
  let lastEvents = [];
  let botRefusals = 0; // total refused bot proposals (should stay 0)
  let workerFailures = 0; // consecutive refused answers through applyBotResult()

  function record(events) {
    for (const ev of events) {
      const text = describeEvent(ev, names);
      if (text) log.push({ text, event: ev });
    }
  }
  function emit(events) {
    lastEvents = events;
    record(events);
    for (const fn of listeners) fn(api);
  }
  function apply(action) {
    const events = applyAction(state, action);
    emit(events);
    return events;
  }

  record(started.events);
  lastEvents = started.events;

  const api = {
    seed,
    seats,
    names,
    humanSeats,
    autoPlayForced,
    startEvents: started.events,
    get state() { return state; },
    get log() { return log; },
    get lastEvents() { return lastEvents; },
    get botRefusals() { return botRefusals; },
    toAct() { return state.toAct; },
    isBotTurn() { return state.toAct !== null && seats[state.toAct].type !== 'human'; },
    isHumanTurn() { return state.toAct !== null && seats[state.toAct].type === 'human'; },
    isFinished() { return state.phase === 'over'; },
    /** Legal actions for the seat to act (whoever it is). */
    legalActions() { return getValidActions(state); },
    /** Why `seat` (default: the seat to act) may not play `card` now, or null. */
    blockReason(card, seat = state.toAct) { return getPlayBlockReason(state, seat === null ? -1 : seat, card); },
    view(seat) { return viewFor(state, seat); },

    /** A human action by the seat to act. Returns { ok: true, events } or { ok: false, error } (never throws for a refusal). */
    play(action) {
      if (!api.isHumanTurn()) return { ok: false, error: 'It is not a human player\'s turn.' };
      const reason = getActionBlockReason(state, action);
      if (reason) return { ok: false, error: reason };
      return { ok: true, events: apply(action) };
    },

    /** Plays one bot action if a bot is to act. Returns the events, or null if no bot was to act. */
    stepBot() {
      if (!api.isBotTurn()) return null;
      const seat = state.toAct;
      const bot = getBot(seats[seat].type);
      for (let attempt = 0; attempt < MAX_BOT_FAILURES; attempt++) {
        let action = null;
        try { action = bot.chooseAction(viewFor(state, seat), botRngs[seat]); } catch { action = null; }
        if (action && getActionBlockReason(state, action) === null) return apply(action);
        botRefusals += 1;
      }
      // Failure cap tripped: play the first legal action so the game can never hang.
      return apply(legalActionsFromView(viewFor(state, seat))[0]);
    },

    /**
     * For a bot that thinks elsewhere (a Web Worker): everything it needs, as plain JSON.
     * `stamp` names the decision, so a late answer for an old position can be recognised.
     * Returns null if no bot is to act. Pair it with applyBotResult().
     */
    botTask() {
      if (!api.isBotTurn()) return null;
      const seat = state.toAct;
      const inTrick = state.trick ? state.trick.plays.length : 0;
      return {
        seat,
        level: seats[seat].type,
        view: viewFor(state, seat),
        rng: { s: botRngs[seat].s },
        stamp: `${state.handNo}:${state.phase}:${state.trickNo}:${inTrick}:${seat}`,
      };
    },

    /**
     * Applies an answer to a botTask(): result = { action, rng } or null if the bot failed.
     * Same failure cap as stepBot(). Returns the events, 'stale' if the position has moved on,
     * or null if the answer was refused (the caller asks again; the cap guarantees that ends).
     */
    applyBotResult(task, result) {
      const now = api.botTask();
      if (!now || now.stamp !== task.stamp) return 'stale';
      const seat = task.seat;
      if (result && result.rng && Number.isInteger(result.rng.s)) botRngs[seat].s = result.rng.s;
      const action = result && result.action;
      if (action && getActionBlockReason(state, action) === null) { workerFailures = 0; return apply(action); }
      botRefusals += 1;
      workerFailures += 1;
      if (workerFailures >= MAX_BOT_FAILURES) {
        workerFailures = 0;
        return apply(legalActionsFromView(viewFor(state, seat))[0]);
      }
      return null;
    },

    /** Plays bot turns until a human must act or the game ends (for tests and instant play). */
    runBots(limit = 10000) {
      let k = 0;
      while (api.isBotTurn() && k < limit) { api.stepBot(); k++; }
      return k;
    },

    /** Pass-and-play (2+ humans): true when the screen must hide hands until the next human confirms. */
    needsHandoff() {
      if (humanSeats.length < 2) return false;
      return api.isHumanTurn() && state.toAct !== revealedSeat;
    },
    /** The human at `seat` has the device: their hand may be shown. */
    reveal(seat) {
      revealedSeat = seat;
      for (const fn of listeners) fn(api);
    },
    /** The seat whose hand the screen may show now (null = none). */
    shownSeat() {
      if (humanSeats.length === 0) return null;
      if (humanSeats.length === 1) return humanSeats[0];
      return revealedSeat;
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return api;
}
