// rules.js - constants and the VARIANTS table. Data only, plus resolveVariants(), rulesCode()
// and deriveParams().
//
// The Voyages of Sinbad (the numbered rules R1 - R15).
// 40 cargo cards: four cargoes x 1-10. Serpents on every 1 (one) and every 10 (two). A ring of 8
// islands (two per cargo); each player's ship stands on one. Follow the led cargo; else trade a card
// of your island's cargo (it counts as led and can win); else discard (cannot win). Every non-follow
// sails its ship one island clockwise after the trick. +1 per trick, -1 per serpent taken.
//
// Vocabulary in code: a "suit" is a CARGO (SUITS = CARGOES), a "hand" in the shared plumbing
// (state.handNo, state.handLog, params.handsPerGame) is a VOYAGE. Events use voyage names.
//
// Every playtest switch (the five Playtest switches) is a row of VARIANTS. A game stores its
// resolved switch values at `state.rules` (plain JSON) and the numbers they imply at
// `state.params`, both fixed at createGame. Logic reads `state.rules` / `state.params`, never these
// tables.
//
// CONSTANTS and DEFAULT_RULES are exported OBJECTS (not bare numbers) so a simulator probe
// can change a value at runtime (`--const.X=Y`) and every NEW game picks it up.
//
// A value that is declared but not in `implemented` makes resolveVariants throw, so nothing
// silently plays the default.

/** R1.8: the cargoes in code order (the print sheet order; also the sort order of a hand). */
export const SUITS = ['pearls', 'silk', 'spice', 'amber'];
/** The same list under the game's own word. */
export const CARGOES = SUITS;

/** Every card kind in display / sort order. */
export const SUIT_ORDER = [...SUITS];

export const SUIT_NAMES = { pearls: 'Pearls', silk: 'Silk', spice: 'Spice', amber: 'Amber' };

/** A shape per cargo, for colour-blind play and the text-chip card faces. */
export const SUIT_ICONS = { pearls: 'circle', silk: 'square', spice: 'triangle', amber: 'diamond' };

/** R1.1 the printed colours (Pearls blue, Silk green, Spice red, Amber yellow). */
export const SUIT_COLOURS = { pearls: 'blue', silk: 'green', spice: 'red', amber: 'yellow' };

/** Tunable numbers (R14). Mutable on purpose: see header. */
export const CONSTANTS = {
  RANK_MIN: 1,
  RANK_MAX: 10,
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 5,
  /** R3.2 cards dealt to each player. */
  HAND_SIZE_BY_COUNT: { 2: 13, 3: 13, 4: 10, 5: 8 },
  /** R2.1 voyages in a game (VOYAGES=four: 4 at every count). */
  VOYAGES_BY_COUNT: { 2: 4, 3: 3, 4: 4, 5: 5 },
  /** R1.2 serpents per card number (others carry none): 12 in the deck. Simulator-only override (R13.6). */
  SERPENTS_BY_NUMBER: { 1: 1, 10: 2 },
  /** R5.2 points per trick won (SCORING=serpents: 0). */
  TRICK_POINTS: 1,
  /** R5.2 points per serpent taken. */
  SERPENT_POINTS: -1,
  /** R1.4 islands per cargo in the ring (8 islands). */
  ISLANDS_PER_CARGO: 2,
  /** R4.10 islands a ship sails per non-follow. */
  SAIL_STEP: 1,
};

/**
 * @typedef {object} VariantDef
 * @property {string} id            V1 ... Vn
 * @property {string} name          constant name, used as the key in a rules object
 * @property {string} code          short code for rules_code
 * @property {string[]} values      every allowed value (strings)
 * @property {string[]} implemented values this engine plays; others throw
 * @property {string} default       the standard-rules value
 * @property {string} rule          rule numbers it touches
 * @property {string} label         short label for a settings panel
 * @property {object} valueLabels   value -> short label for a settings panel
 * @property {string} description   one-sentence rule text
 * @property {number[]} [onlyFor]   player counts at which the switch has any effect
 */

/**
 * The Playtest rules (the five Playtest switches). The panel on the setup page, the stats
 * filter, the CSV columns and rules_code are all generated from this table. Order is the fixed
 * rules code order: moor, tie, trade, voyages, scoring.
 * @type {VariantDef[]}
 */
export const VARIANTS = [
  { id: 'V1', name: 'MOOR', code: 'moor', values: ['clockwise', 'score'], implemented: ['clockwise', 'score'],
    default: 'clockwise', rule: 'R3.5, R13.1', label: 'Mooring order',
    valueLabels: { clockwise: 'Clockwise from the dealer\'s left', score: 'Leader first, last place last' },
    description: 'Score order: the player with the highest total moors first and the player in last place moors last (equal totals clockwise from the dealer\'s left). The dealer\'s left still leads.' },
  { id: 'V2', name: 'TIE', code: 'tie', values: ['first', 'real'], implemented: ['first', 'real'],
    default: 'first', rule: 'R4.8, R13.2', label: 'Tie rule',
    valueLabels: { first: 'First played wins', real: 'A real card beats a trade' },
    description: 'Real: on a tie, a card of the led cargo beats a trade card of the same number; two tied trades still go to the first played.' },
  { id: 'V3', name: 'TRADE', code: 'trade', values: ['mandatory', 'optional'], implemented: ['mandatory', 'optional'],
    default: 'mandatory', rule: 'R4.3, R13.3', label: 'Trade',
    valueLabels: { mandatory: 'Mandatory', optional: 'Optional' },
    description: 'Optional: void in the led cargo, you may play any card; a card of your island\'s cargo is still a trade (counts as led), any other card is a discard.' },
  { id: 'V4', name: 'VOYAGES', code: 'voyages', values: ['players', 'four'], implemented: ['players', 'four'],
    default: 'players', rule: 'R2.1, R13.4', label: 'Voyages',
    valueLabels: { players: 'One per player (4 at 2 players)', four: 'Four at every count' },
    description: 'Four: the game lasts four voyages at every player count; the deal still passes left each voyage.' },
  { id: 'V5', name: 'SCORING', code: 'scoring', values: ['tricks', 'serpents'], implemented: ['tricks', 'serpents'],
    default: 'tricks', rule: 'R5.2, R13.5', label: 'Scoring',
    valueLabels: { tricks: '+1 a trick, -1 a serpent', serpents: 'Serpents only' },
    description: 'Serpents only: a voyage scores -1 for each serpent on your face-up cards and nothing for tricks.' },
];

/** Standard-rules values by name. Mutable on purpose (runtime probes); see header. */
export const DEFAULT_RULES = Object.fromEntries(VARIANTS.map((v) => [v.name, v.default]));

/**
 * Merges overrides onto DEFAULT_RULES and validates the result.
 * Numbers are accepted (a switch value 2 -> '2'). Throws on an unknown name, a value that is not
 * allowed, or a value that is not implemented.
 * @param {object} [overrides]  e.g. { TIE: 'real' }
 * @param {VariantDef[]} [table] for tests only
 * @returns {object} plain JSON rules object, every name present
 */
export function resolveVariants(overrides = {}, table = VARIANTS) {
  const byName = new Map(table.map((v) => [v.name, v]));
  for (const key of Object.keys(overrides || {})) {
    if (!byName.has(key)) {
      throw new Error(`Unknown rule "${key}". Known rules: ${table.map((v) => v.name).join(', ')}`);
    }
  }
  const defaults = table === VARIANTS ? DEFAULT_RULES : Object.fromEntries(table.map((v) => [v.name, v.default]));
  const rules = {};
  for (const def of table) {
    let value = overrides && Object.prototype.hasOwnProperty.call(overrides, def.name) ? overrides[def.name] : defaults[def.name];
    if (typeof value === 'number') value = String(value);
    if (!def.values.includes(value)) {
      throw new Error(`${def.name} must be one of ${def.values.join(', ')}, got ${JSON.stringify(value)}`);
    }
    if (!def.implemented.includes(value)) {
      throw new Error(`${def.name} = ${JSON.stringify(value)} is not implemented in the web engine`);
    }
    rules[def.name] = value;
  }
  return rules;
}

/**
 * The short rules code for stats and analytics (R13): 'std' when every switch is at its
 * default; otherwise the non-default values as `code-value` joined with '+', in table order, e.g.
 * 'moor-score+trade-optional'. The rules list every non-default switch whatever the player count
 * (VOYAGES=four is listed at 2 and 4 players too, where it changes nothing), so no switch has
 * `onlyFor`; `n` is accepted for the shared interface and ignored unless a row has `onlyFor`.
 * @param {object} rules  a resolved rules object
 * @param {number} [n]    player count
 */
export function rulesCode(rules, n) {
  const parts = [];
  for (const def of VARIANTS) {
    if (n !== undefined && def.onlyFor && !def.onlyFor.includes(n)) continue;
    if (rules[def.name] !== def.default) parts.push(`${def.code}-${rules[def.name]}`);
  }
  return parts.length ? parts.join('+') : 'std';
}

/**
 * The numbers a rules object implies at player count n, read from CONSTANTS now (stored at
 * state.params by createGame, so a running game never sees a later --const change).
 * @returns {{ n:number, handSize:number, handsPerGame:number, deckSize:number, dealt:number,
 *   out:number, setAside:number, islands:number, trickPoints:number, serpentPoints:number,
 *   serpentsByNumber:object, sailStep:number, serpentsInDeck:number }}
 */
export function deriveParams(rules, n) {
  if (!Number.isInteger(n) || n < CONSTANTS.MIN_PLAYERS || n > CONSTANTS.MAX_PLAYERS) {
    throw new Error(`This game needs ${CONSTANTS.MIN_PLAYERS} to ${CONSTANTS.MAX_PLAYERS} players, got ${n}`);
  }
  const handSize = CONSTANTS.HAND_SIZE_BY_COUNT[n];
  const per = CONSTANTS.RANK_MAX - CONSTANTS.RANK_MIN + 1;
  const deckSize = SUITS.length * per;
  const dealt = n * handSize;
  if (dealt > deckSize || dealt < 0) throw new Error(`Hand size ${handSize} x ${n} players does not fit the deck`);
  const serpentsByNumber = {};
  for (const [k, v] of Object.entries(CONSTANTS.SERPENTS_BY_NUMBER)) {
    if (Number(v)) serpentsByNumber[String(k)] = Number(v);
  }
  let serpentsInDeck = 0;
  for (let r = CONSTANTS.RANK_MIN; r <= CONSTANTS.RANK_MAX; r++) serpentsInDeck += SUITS.length * (serpentsByNumber[String(r)] || 0);
  return {
    n,
    handSize,
    handsPerGame: rules.VOYAGES === 'four' ? 4 : CONSTANTS.VOYAGES_BY_COUNT[n], // R2.1, R13.4
    deckSize,
    dealt,
    out: deckSize - dealt, // the set-aside count (R3.2): 14 / 1 / 0 / 0
    setAside: deckSize - dealt,
    islands: SUITS.length * CONSTANTS.ISLANDS_PER_CARGO, // 8
    trickPoints: rules.SCORING === 'serpents' ? 0 : CONSTANTS.TRICK_POINTS, // R5.2, R13.5
    serpentPoints: CONSTANTS.SERPENT_POINTS,
    serpentsByNumber,
    serpentsInDeck,
    sailStep: CONSTANTS.SAIL_STEP,
  };
}
