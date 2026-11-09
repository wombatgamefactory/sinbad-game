// bot-worker.js - runs bot decisions off the main thread (module worker). Game-agnostic.
//
// In:  { id, level, view, rng }   (plain JSON, from controller.botTask())
// Out: { id, action, rng }        the chosen action and the bot's advanced RNG state
//   or { id, error }              the bot threw; the driver treats that as a failed answer
//
// The registry import pulls in every registered level, so Medium and Hard need no change here.

import { getBot } from '../bots/index.js';
import { HARD_TIME_BUDGET_MS } from '../bots/hard.js';

self.onmessage = (e) => {
  const { id, level, view, rng } = e.data;
  try {
    const r = { s: rng.s };
    // Hard never reads a clock itself: the worker hands it an `expired` test so its time budget can cut a search short.
    const t0 = performance.now();
    const action = getBot(level).chooseAction(view, r, { expired: () => performance.now() - t0 > HARD_TIME_BUDGET_MS });
    self.postMessage({ id, action, rng: r });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
