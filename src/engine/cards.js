// cards.js - card ids, the deck, serpents, islands, sorting and display names.
//
// A card id is a string `<cargo>-<number>` (R1.8): 'pearls-1' ... 'amber-10'.
// Face assets: assets/cards/card-<id>.webp (manifest id 'card-<id>', cardFace()).
// An island face id is 'island-<cargo>-<a|b>' (cosmetic only: two islands of one cargo play alike).

import { SUITS, SUIT_ORDER, SUIT_NAMES, CONSTANTS } from './rules.js';

export function cardSuit(card) {
  return card.slice(0, card.indexOf('-'));
}
/** The game's word for cardSuit. */
export const cardCargo = cardSuit;

/** The card's number (its rank). */
export function cardValue(card) {
  return Number(card.slice(card.indexOf('-') + 1));
}

export function makeCard(suit, number) {
  return `${suit}-${number}`;
}

/** True if `card` is a well-formed id of the deck. */
export function isCard(card) {
  if (typeof card !== 'string' || !/^[a-z]+-\d{1,2}$/.test(card)) return false;
  const s = cardSuit(card);
  const k = cardValue(card);
  return SUITS.includes(s) && k >= CONSTANTS.RANK_MIN && k <= CONSTANTS.RANK_MAX;
}

/** The whole deck in cargo order then number (40 cards). */
export function fullDeck() {
  const deck = [];
  for (const s of SUITS) for (let r = CONSTANTS.RANK_MIN; r <= CONSTANTS.RANK_MAX; r++) deck.push(makeCard(s, r));
  return deck;
}

/**
 * R1.2 serpents on a card: 1 on a 1, 2 on a 10, else 0 (from params.serpentsByNumber, which a
 * simulator --const can change). `params` defaults to the standard table.
 */
export function cardSerpents(card, params) {
  const table = params && params.serpentsByNumber ? params.serpentsByNumber : CONSTANTS.SERPENTS_BY_NUMBER;
  return Number(table[String(cardValue(card))] || 0);
}

/** R1.2 a serpent card carries at least one serpent; it lies face up when won (R4.9). */
export function isSerpentCard(card, params) {
  return cardSerpents(card, params) > 0;
}

/** Sort key: cargo order, then ascending number. */
export function compareCards(a, b) {
  const ds = SUIT_ORDER.indexOf(cardSuit(a)) - SUIT_ORDER.indexOf(cardSuit(b));
  if (ds !== 0) return ds;
  return cardValue(a) - cardValue(b);
}

export function sortCards(cards) {
  return [...cards].sort(compareCards);
}

/** 'spice-7' -> 'Spice 7'. */
export function cardName(card) {
  return `${SUIT_NAMES[cardSuit(card)]} ${cardValue(card)}`;
}

/** ['spice-3', 'spice-7'] -> 'Spice 3 and Spice 7'; three or more use commas. */
export function listCardNames(cards) {
  const names = cards.map(cardName);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The face asset id of a card: 'card-spice-7'. */
export function cardFace(card) {
  return `card-${card}`;
}

/** The 8 island faces of the ring, in cargo order: 'island-pearls-a', 'island-pearls-b', ... */
export function allIslandFaces() {
  const out = [];
  const letters = 'abcdefghij';
  for (const s of SUITS) for (let k = 0; k < CONSTANTS.ISLANDS_PER_CARGO; k++) out.push(`island-${s}-${letters[k]}`);
  return out;
}

/** 'island-silk-b' -> 'silk'. */
export function islandFaceCargo(face) {
  return face.split('-')[1];
}
