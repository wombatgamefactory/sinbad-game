// describe.js - plain-English text for actions and events (log lines, button labels).
//
// Pure: takes data, returns strings. `names` is an optional per-seat label array supplied by
// the UI (e.g. ['You', 'Mia', 'Easy bot 2']); without it seats are 'Seat 1', 'Seat 2', ...
// A seat called "You" gets second-person verbs. Every line is safe to show to the whole table:
// nothing here names a card in a hand or in the set-aside. Islands are numbered 1 to 8 for players
// (engine index + 1), clockwise.

import { SUIT_NAMES } from './rules.js';
import { cardName } from './cards.js';

export function seatName(seat, names) {
  return names && names[seat] ? names[seat] : `Seat ${seat + 1}`;
}

/** 'wins' -> 'win' when the subject is "You". */
function verb(subject, v) {
  if (!/^You\b/.test(subject)) return v;
  if (v === 'has') return 'have';
  if (v === 'is') return 'are';
  if (v === 'takes') return 'take';
  return v.replace(/s$/, ''); // every other verb used here takes a plain -s
}

function plural(k, one, many) {
  return `${k} ${k === 1 ? one : many}`;
}

/** 'island 3 (Pearls)' for island index 2 of a ring. */
export function islandName(index, ring) {
  return `island ${index + 1}${ring && ring[index] ? ` (${SUIT_NAMES[ring[index]]})` : ''}`;
}

const signed = (x) => (x > 0 ? `+${x}` : `${x}`);

export function describeAction(action, ring) {
  if (!action) return '';
  switch (action.type) {
    case 'play': return `Play ${cardName(action.card)}`;
    case 'moor': return `Moor at ${islandName(action.island, ring)}`;
    default: return JSON.stringify(action);
  }
}

/**
 * One log line per event, or null for events not worth a line.
 * @param {object} ev
 * @param {string[]} [names]
 */
export function describeEvent(ev, names) {
  const who = (s) => seatName(s, names);
  switch (ev.type) {
    case 'game-started':
      return `New game for ${ev.players} players, ${plural(ev.handsPerGame, 'voyage', 'voyages')} (${ev.rulesCode === 'std' ? 'standard rules' : `playtest rules: ${ev.rulesCode}`}).`;
    case 'voyage-started': {
      const d = who(ev.dealer);
      const l = who(ev.leader);
      const aside = ev.setAsideCount ? ` ${plural(ev.setAsideCount, 'card is', 'cards are')} set aside unseen.` : '';
      return `Voyage ${ev.voyage} of ${ev.handsPerGame}: ${d} ${verb(d, 'deals')} ${ev.handSize} cards each.${aside} ${l} ${verb(l, 'leads')} the first trick.`;
    }
    case 'ring-laid':
      return `A fresh ring of islands: ${ev.ring.map((c, i) => `${i + 1} ${SUIT_NAMES[c]}`).join(', ')}.`;
    case 'ship-moored': {
      const s = who(ev.seat);
      const shared = ev.sharedWith && ev.sharedWith.length ? `, beside ${ev.sharedWith.map(who).join(' and ')}` : '';
      return `${s} ${verb(s, 'moors')} at island ${ev.island + 1} (${SUIT_NAMES[ev.cargo]})${shared}.`;
    }
    case 'ships-moored':
      return null;
    case 'card-played': {
      const s = who(ev.seat);
      const c = cardName(ev.card);
      if (ev.mode === 'lead') return `${s} ${verb(s, 'leads')} ${c}.`;
      if (ev.mode === 'follow') return `${s} ${verb(s, 'follows')} with ${c}.`;
      if (ev.mode === 'trade') return `${s} ${verb(s, 'has')} no ${SUIT_NAMES[ev.ledSuit]} and ${verb(s, 'trades')} ${c} sideways: it counts as ${SUIT_NAMES[ev.countsAs]}.`;
      return `${s} ${verb(s, 'has')} no ${SUIT_NAMES[ev.ledSuit]} and no ${SUIT_NAMES[ev.islandCargo]} and ${verb(s, 'discards')} ${c}: it cannot win.`;
    }
    case 'trick-won': {
      const s = who(ev.winner);
      const how = ev.mode === 'trade' ? ' (a trade)' : '';
      const tie = ev.tie ? (ev.tieBrokenBy === 'real' ? ', a tie: the real card beats the trade' : ', a tie: the first played wins') : '';
      const serp = ev.serpents ? ` and ${plural(ev.serpents, 'serpent', 'serpents')}` : '';
      return `${s} ${verb(s, 'wins')} trick ${ev.trickNo} with ${cardName(ev.card)}${how}${tie}: 1 trick${serp}.`;
    }
    case 'serpent-taken': {
      const s = who(ev.seat);
      return `${s} ${verb(s, 'takes')} ${plural(ev.serpents, 'serpent', 'serpents')} face up (${ev.cards.map(cardName).join(', ')}); ${plural(ev.totalSerpents, 'serpent', 'serpents')} this voyage.`;
    }
    case 'sailed': {
      const s = who(ev.seat);
      return `${s} ${verb(s, 'sails')} from island ${ev.from + 1} (${SUIT_NAMES[ev.fromCargo]}) to island ${ev.to + 1} (${SUIT_NAMES[ev.toCargo]}).`;
    }
    case 'voyage-ended': {
      const parts = ev.lines.map((l, s) => `${who(s)} ${signed(l.trickScore)} tricks ${signed(l.serpentScore)} serpents = ${l.score}`);
      return `Voyage ${ev.voyage} is over. ${parts.join('; ')}.`;
    }
    case 'game-over': {
      const names2 = ev.winners.map(who);
      if (ev.shared) return `Shared win: ${names2.join(' and ')} on ${ev.winningScore}${ev.tiedOnTotal.length > 1 ? `, level on the final voyage too (${plural(ev.lastHand[ev.winners[0]], 'point', 'points')} each)` : ''}.`;
      const w = names2[0];
      if (ev.tiebreakUsed) {
        const others = ev.tiedOnTotal.filter((s) => s !== ev.winners[0]).map((s) => ev.lastHand[s]);
        return `${w} ${verb(w, 'wins')} on ${ev.winningScore}, by the tiebreak: most points in the final voyage (${ev.lastHand[ev.winners[0]]} against ${others.join(', ')}).`;
      }
      return `${w} ${verb(w, 'wins')} with ${plural(ev.winningScore, 'point', 'points')}, ${ev.margin} ahead.`;
    }
    default:
      return null;
  }
}
