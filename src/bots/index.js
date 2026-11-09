// index.js - the bot registry, by level name.
//
// A bot is { id, label, chooseAction(view, rng) -> action, offered? }.
//   - `view` is viewFor(state, seat): never the full state.
//   - `rng` is the bot's own RNG object; the driver derives it (deriveSeed(seed, 'bot', seat)).
//   - It must return one of legalActionsFromView(view). It may keep no memory between calls
//     except caches that do not change its answers.
//   - `offered: false` keeps a bot out of the UI's seat menus (simulator archetypes).
//
// Levels: 'easy' (random.js), 'medium' (medium.js, the Python heuristic ported decision for decision),
// 'hard' (hard.js, determinised Monte Carlo with Medium rollouts) and the simulator-only archetypes
// (archetypes.js, offered: false: always-duck, win-trades, random-moor, serpent-hoarder, naive, plus the plain
// high / low; import them with getBot(id) or list them with botLevels()).
//
// chooseAction(view, rng, ctx?): `ctx` is optional. Hard reads ctx.expired (a function the CALLER supplies,
// because a bot never reads a clock) to stop early; see hard.js and getFallbackBot below.

import { randomBot } from './random.js';
import { mediumBot } from './medium.js';
import { hardBot } from './hard.js';
import { ARCHETYPES, KIT_REFERENCES } from './archetypes.js';

const REGISTRY = new Map();

export function registerBot(bot) {
  if (!bot || typeof bot.id !== 'string' || typeof bot.chooseAction !== 'function') {
    throw new Error('A bot needs an id and a chooseAction(view, rng) function');
  }
  REGISTRY.set(bot.id, bot);
}

export function getBot(level) {
  const bot = REGISTRY.get(level);
  if (!bot) throw new Error(`Unknown bot level "${level}". Known: ${[...REGISTRY.keys()].join(', ')}`);
  return bot;
}

/**
 * The bot to use when `level` ran out of time or failed: its `fallback` bot (Hard -> Medium), else itself.
 * The UI's bot driver calls this for its synchronous main-thread fallback, so a stalled Hard worker never
 * freezes the page with a second Hard search.
 */
export function getFallbackBot(level) {
  const bot = getBot(level);
  return bot.fallback ? getBot(bot.fallback) : bot;
}

/** Every registered bot as { id, label, offered }. UI menus show those with offered !== false. */
export function botLevels() {
  return [...REGISTRY.values()].map((b) => ({ id: b.id, label: b.label, offered: b.offered !== false }));
}

registerBot(randomBot);
registerBot(mediumBot);
registerBot(hardBot);
for (const a of [...ARCHETYPES, ...KIT_REFERENCES]) registerBot(a);
