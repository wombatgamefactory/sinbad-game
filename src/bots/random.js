// random.js - Easy bot: a uniformly random legal action. Game-agnostic: keep as it is.
//
// Bot interface: chooseAction(view, rng) -> action. `view` is viewFor() output only;
// `rng` is the bot's own stream (rng.js). Pure: no clock, no global randomness, no I/O.
// If the game has interchangeable cards, legalCards() merges them into one action, so a hand
// holding three of them is not three times as likely to play one.

import { legalActionsFromView, rngPick } from '../engine/index.js';

export const randomBot = {
  id: 'easy',
  label: 'Easy',
  chooseAction(view, rng) {
    return rngPick(rng, legalActionsFromView(view));
  },
};
