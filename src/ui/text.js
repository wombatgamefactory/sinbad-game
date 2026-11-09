// text.js - the sentences the UI shows: trick log lines, turn prompts, hover hints, tiebreak
// explanations. Pure functions of data (no DOM), so they run in Node tests.
//
// `names` is the per-seat label array from the controller ('You', 'Mia', 'Easy bot 2' ...).
// A seat called "You" gets second-person verbs ("You led", "your hand"). Islands are numbered 1 to 8
// for players. Plain English: a player should never need the rule book to read the log.
// the table UI work owns the voice and the look; these are the generic UI's sentences.

import { SUIT_NAMES, cardSuit, cardName, legalActionsFromView, playMode } from '../engine/index.js';

const isYou = (name) => name === 'You';

/** A score part with its sign: +3, 0 and the typographic minus for -2. */
export const signed = (x) => (x > 0 ? `+${x}` : (x < 0 ? `−${-x}` : '0'));

/** 'Sam' -> "Sam's", 'You' -> 'your'. */
export function poss(name) {
  return isYou(name) ? 'your' : `${name}'s`;
}

/** Third-person verb to the form that agrees with the name ('wins' -> 'win' for You). */
function v(name, third, second) {
  return isYou(name) ? (second || third.replace(/s$/, '')) : third;
}

const cargoName = (s) => SUIT_NAMES[s];

/** "Spice was led". */
export function ledText(suit) {
  return `${cargoName(suit)} was led`;
}

/** 'island 3 (Pearls)'. */
export function islandText(index, ring) {
  return `island ${index + 1} (${cargoName(ring[index])})`;
}

/**
 * One plain-English line for a finished trick, e.g.
 * "Mia led Spice 4; Sam followed with Spice 7 and wins; Ann discarded Amber 10; Bo traded Silk 5 (counts as Spice)."
 * @param {{leader:number, ledSuit:string|null, plays:{seat:number, card:string, mode:string}[]}} trick
 * @param {object} ev  the trick-won event
 */
export function trickSentence(trick, ev, names) {
  const led = trick.ledSuit;
  const parts = trick.plays.map((p) => {
    const who = names[p.seat];
    const win = p.seat === ev.winner;
    let clause;
    if (p.mode === 'lead') clause = `${who} led ${cardName(p.card)}`;
    else if (p.mode === 'follow') clause = `${who} followed with ${cardName(p.card)}`;
    else if (p.mode === 'trade') clause = `${who} traded ${cardName(p.card)} (counts as ${cargoName(led)})`;
    else clause = `${who} discarded ${cardName(p.card)}`;
    if (win) clause += ` and ${v(who, 'wins')}`;
    return clause;
  });
  const tail = ev.serpents ? ` ${names[ev.winner]} ${v(names[ev.winner], 'takes')} ${ev.serpents} serpent${ev.serpents === 1 ? '' : 's'}.` : '';
  return `${parts.join('; ')}.${tail}`;
}

/** The short banner under the trick: "Sam wins with Silk 9 (a trade, counts as Spice)". */
export function winnerBanner(banner, names) {
  const who = names[banner.winner];
  const how = banner.mode === 'trade' ? ' (a trade)' : '';
  const tie = banner.tie ? (banner.tieBrokenBy === 'real' ? ', the real card beats the trade' : ', a tie: first played wins') : '';
  const serp = banner.serpents ? `, taking ${banner.serpents} serpent${banner.serpents === 1 ? '' : 's'}` : '';
  return `${who} ${v(who, 'wins')} with ${cardName(banner.card)}${how}${tie}${serp}`;
}

/** What the human should do now, as a sentence. `view` = the seat's view. */
export function turnPrompt(view) {
  if (view.phase === 'moor') {
    const moored = view.ships.filter((x) => x !== null).length;
    return `Moor your ship: choose any island${moored ? ' (ships may share)' : ''}. Each card you cannot follow will sail it one island clockwise.`;
  }
  const t = view.trick;
  const hand = view.hand;
  const acts = legalActionsFromView(view);
  const led = t ? t.ledSuit : null;
  const island = view.ships[view.seat] === null ? null : view.ring[view.ships[view.seat]];
  if (led === null) return 'You lead. Play any card: its cargo is the cargo led. Leading never sails your ship.';
  const follow = hand.filter((c) => cardSuit(c) === led);
  if (follow.length) {
    if (acts.length === 1) return `${ledText(led)}. ${cardName(acts[0].card)} is the only card you can play.`;
    return `${ledText(led)}. You hold ${cargoName(led)}, so you must follow.`;
  }
  const trades = hand.filter((c) => cardSuit(c) === island);
  if (trades.length) {
    if (view.rules.TRADE === 'optional') return `${ledText(led)} and you have none. You may trade ${cargoName(island)} sideways (it counts as ${cargoName(led)} and can win) or discard another card (it cannot win). Either way your ship sails on.`;
    if (acts.length === 1) return `${ledText(led)} and you have none. The island demands its cargo: you must trade ${cardName(acts[0].card)}. It counts as ${cargoName(led)} and can win; then your ship sails on.`;
    return `${ledText(led)} and you have none. The island demands its cargo: you must trade ${cargoName(island)}. Choose which: it counts as ${cargoName(led)} and can win; then your ship sails on.`;
  }
  if (acts.length === 1) return `${ledText(led)} and you have no ${cargoName(led)} or ${cargoName(island)}. ${cardName(acts[0].card)} is your last card: it cannot win, and your ship sails on.`;
  return `${ledText(led)} and you have no ${cargoName(led)} and no ${cargoName(island)} (your island's cargo). Discard any card: it cannot win, and your ship sails on.`;
}

/**
 * What kind of play the human is facing, worked out from the engine's own ladder (legalActionsFromView and
 * playMode, never re-derived here): { kind: 'lead' | 'follow' | 'trade' | 'trade-optional' | 'discard', led,
 * islandCargo, island, sailTo, sailToCargo, ranks (the island-cargo cards that may be traded), count }.
 * null when it is not a play decision.
 */
export function playSituation(view) {
  if (!view || view.phase !== 'play') return null;
  const led = view.trick ? view.trick.ledSuit : null;
  if (led === null || led === undefined) return { kind: 'lead' };
  const island = view.ships[view.seat];
  if (island === null || island === undefined) return null;
  const islandCargo = view.ring[island];
  const cards = legalActionsFromView(view).map((a) => a.card);
  const modes = cards.map((c) => playMode(view.hand, c, led, islandCargo));
  const sailTo = (island + 1) % view.ring.length;
  const base = { led, islandCargo, island, sailTo, sailToCargo: view.ring[sailTo] };
  const follows = cards.filter((c, i) => modes[i] === 'follow');
  const trades = cards.filter((c, i) => modes[i] === 'trade');
  if (follows.length) return { kind: 'follow', ...base, count: follows.length, ranks: follows };
  if (trades.length) return { kind: view.rules.TRADE === 'optional' ? 'trade-optional' : 'trade', ...base, count: trades.length, ranks: trades };
  return { kind: 'discard', ...base, count: cards.length, ranks: [] };
}

/** The callout above the hand: { title, body, tip } for a situation from playSituation(), or null for a lead. */
export function situationText(sit) {
  if (!sit || sit.kind === 'lead') return null;
  const led = cargoName(sit.led);
  const isl = cargoName(sit.islandCargo);
  const sail = `Then your ship sails on to island ${sit.sailTo + 1} (${cargoName(sit.sailToCargo)}).`;
  if (sit.kind === 'follow') {
    return {
      title: `Follow ${led}`,
      body: sit.count === 1 ? `${led} was led and you hold it, so you must play your ${cardName(sit.ranks[0])}.` : `${led} was led and you hold it, so you must play one of your ${led} cards.`,
      tip: sit.count === 1 ? '' : 'A tick on a card means it would win the trick as it stands; a cross means it would not.',
    };
  }
  if (sit.kind === 'trade') {
    return {
      title: `The island demands its cargo: you must trade ${isl}`,
      body: `${led} was led and you hold none. Your island is ${isl}, so one of your ${isl} cards goes sideways: it counts as ${led} and can win. ${sail}`,
      tip: sit.count === 1 ? `${cardName(sit.ranks[0])} is the only ${isl} card you hold, so that is the one to trade.` : 'Choose the rank to trade. A tick means it would win the trick as it stands; a cross means it would not.',
    };
  }
  if (sit.kind === 'trade-optional') {
    return {
      title: `The island offers its cargo: you may trade ${isl}`,
      body: `${led} was led and you hold none. Trade one ${isl} card sideways (it counts as ${led} and can win) or discard any other card (it cannot win). Either way your ship sails on to island ${sit.sailTo + 1} (${cargoName(sit.sailToCargo)}).`,
      tip: 'A tick means a trade would win the trick as it stands; a cross means it would not.',
    };
  }
  return {
    title: 'Nothing to follow or trade: discard',
    body: `${led} was led and you hold none, and you hold no ${isl} (your island's cargo) either. Discard any card: it cannot win. ${sail}`,
    tip: '',
  };
}

/** The sentence for the status line when a bot or another human is to act. */
export function waitingText(board, names, seatTypes) {
  if (board.phase === 'over') return 'Game over.';
  if (board.toAct === null) return '';
  const who = names[board.toAct];
  const bot = seatTypes && seatTypes[board.toAct] !== 'human';
  if (board.phase === 'moor') return `${who} ${isYou(who) ? 'are' : 'is'} ${bot ? 'choosing an island' : 'to moor'}.`;
  return `${who} ${isYou(who) ? 'are' : 'is'} ${bot ? 'thinking' : 'to play'}.`;
}

/** "1 point" / "3 points". */
export const points = (k) => `${k} point${k === 1 ? '' : 's'}`;

/** Hover / tap hint for a card the human may play, from previewCard(). */
export function previewText(pv, names) {
  if (!pv) return '';
  const name = cardName(pv.card);
  if (pv.kind === 'lead') {
    return `${name}: you would lead ${cargoName(cardSuit(pv.card))}. Everyone else must follow it if they can.`;
  }
  const how = pv.mode === 'trade' ? ` It is a trade: it counts as ${cargoName(pv.ledSuit)}.` : (pv.mode === 'discard' ? ' It is a discard: it cannot win.' : '');
  const sail = pv.sails ? ` Your ship would sail to island ${pv.sailTo + 1}${pv.sailToCargo ? ` (${cargoName(pv.sailToCargo)})` : ''}.` : '';
  if (pv.wins) {
    if (pv.final) return `${name} wins the trick${pv.serpents ? ` and ${pv.serpents} serpent${pv.serpents === 1 ? '' : 's'}` : ''}.${how}${sail}`;
    return `${name} would win the trick as it stands; ${pv.remaining} still to play.${how}${sail}`;
  }
  const w = names[pv.winnerSeat];
  if (pv.final) return `${name} loses: ${w} ${v(w, 'wins')} with ${cardName(pv.winnerCard)}.${how}${sail}`;
  return `${name} would not win as it stands (${w} ${isYou(w) ? 'are' : 'is'} ahead with ${cardName(pv.winnerCard)}; ${pv.remaining} still to play).${how}${sail}`;
}

/** Players who share a total, grouped: [[seat, seat], ...] only groups of two or more. */
export function tiedGroups(result) {
  const byTotal = new Map();
  for (const r of result.ranking) {
    if (!byTotal.has(r.total)) byTotal.set(r.total, []);
    byTotal.get(r.total).push(r.seat);
  }
  return [...byTotal.values()].filter((g) => g.length > 1);
}

/**
 * The tiebreak explanation for the end screen (R6.2): only players tied on the top total, most points
 * in the final voyage, else shared. '' when nobody was tied at the top.
 */
export function tiebreakText(result, names) {
  const tied = result.tiedOnTotal;
  if (tied.length < 2) return '';
  const label = (s) => names[s];
  const join = (seats) => (seats.length === 1 ? label(seats[0]) : seats.length === 2 ? `${label(seats[0])} and ${label(seats[1])}` : `${seats.slice(0, -1).map(label).join(', ')} and ${label(seats[seats.length - 1])}`);
  const head = `${join(tied)} tied on ${result.winningScore}.`;
  const counts = `Points in the final voyage: ${tied.map((s) => `${label(s)} ${result.lastHand[s]}`).join(', ')}.`;
  if (result.shared && !result.tiebreakUsed) return `${head} ${counts} Still level, so the win is shared.`;
  if (result.tiebreakUsed) {
    const w = result.winners;
    return `${head} Tiebreak: most points in the final voyage. ${counts} ${join(w)} ${w.length > 1 ? 'share the win' : (isYou(label(w[0])) ? 'win' : 'wins')}.`;
  }
  return head;
}

/** One-line summary of the voyage for the log: "Voyage 1: Ann +3 -2 = 1, ...". */
export function handEndText(ev, names) {
  const sgn = (x) => (x >= 0 ? `+${x}` : `${x}`); // plain ASCII: this is a log line
  const scores = ev.scores.map((x, s) => (ev.lines ? `${names[s]} ${sgn(ev.lines[s].trickScore)} ${sgn(ev.lines[s].serpentScore)} = ${x}` : `${names[s]} ${x}`)).join(', ');
  return `Voyage ${ev.handNo + 1} scores: ${scores}.`;
}
