// assets.js - the one place that turns an art id into an <img>.
//
// Every image in the UI is asked for by manifest id (assets/manifest.json): `img('card-back')`,
// `cardImg('red-7')`. Missing art never leaves a broken image: an unknown id, a failed manifest
// load or a 404 on the file all end in a small text chip carrying the id's label (a card face
// falls back to a plain face with its number and suit shape). The page is built to look finished
// with the chips and to improve by itself when the art is there.
// The art ids follow assets/manifest.json (the runtime art set); BUILT_IN mirrors it
// (ui-node checks every built-in id is in the manifest). Never edit assets/ from here.

import { SUITS, SUIT_ICONS, SUIT_NAMES, cardFace, cardSuit, cardValue, cardName, fullDeck, allIslandFaces, islandFaceCargo } from '../engine/index.js';

const BASE = 'assets/';

// Built-in id -> file table, used until (and if) assets/manifest.json loads. It mirrors the
// manifest, so the page works even if the manifest fetch fails (offline, file://, 404).
const BUILT_IN = {
  'card-back': 'cards/card-back.webp',
  'how-to-play-front': 'cards/how-to-play-front.webp',
  'how-to-play-back': 'cards/how-to-play-back.webp',
  favicon: 'favicon.png',
  'hero-wide': 'hero/hero-wide.jpg',
  'serpent-black': 'icons/serpent-black.webp',
  'serpent-white': 'icons/serpent-white.webp',
  'table-texture': 'table-texture.webp',
};
for (const s of SUITS) { BUILT_IN[`badge-${s}`] = `icons/badge-${s}.webp`; BUILT_IN[`icon-${s}`] = `icons/icon-${s}.webp`; }
for (let s = 1; s <= 5; s++) BUILT_IN[`avatar-${s}`] = `avatars/avatar-${s}.webp`;
for (const c of fullDeck()) BUILT_IN[cardFace(c)] = `cards/${cardFace(c)}.webp`;
for (const f of allIslandFaces()) BUILT_IN[f] = `islands/${f}.webp`;
/** Ship pawn per seat: the dhow silhouette in the seat colour, cream ring and dark edge (non-cargo colours). */
export const SHIP_IDS = ['dhow-ivory', 'dhow-black', 'dhow-purple', 'dhow-magenta', 'dhow-brown'];
for (const id of SHIP_IDS) BUILT_IN[id] = `ships/${id}.webp`;
/** The colour of each seat's ship (art audit): ivory, black, purple, magenta, brown. Used for the small "sails here next" dots. */
export const SEAT_COLOURS = ['#F4F0E2', '#1C1C24', '#7A3FB0', '#E0338F', '#8A5A34'];
export const SEAT_COLOUR_NAMES = ['ivory', 'black', 'purple', 'magenta', 'brown'];

const table = new Map(Object.entries(BUILT_IN).map(([id, file]) => [id, { file, w: 0, h: 0 }]));

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Reads assets/manifest.json ({ assets: [...] } or a bare array). Never throws; on any failure the built-in table stays. */
export async function loadManifest(timeoutMs = 2500) {
  try {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    const res = await fetch(`${BASE}manifest.json`, ctl ? { signal: ctl.signal } : undefined);
    if (timer) clearTimeout(timer);
    if (!res.ok) return false;
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data && data.assets);
    if (!Array.isArray(list)) return false;
    for (const a of list) {
      if (a && typeof a.id === 'string' && typeof a.file === 'string') {
        if (a.status === 'missing') table.delete(a.id); // known to be absent: go straight to the chip, no 404
        else table.set(a.id, { file: a.file, w: a.width || 0, h: a.height || 0 });
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Replaces the table from an already parsed manifest (tests). */
export function useManifest(data) {
  const list = Array.isArray(data) ? data : data.assets;
  table.clear();
  for (const a of list) if (a.status !== 'missing') table.set(a.id, { file: a.file, w: a.width || 0, h: a.height || 0 });
}

/** URL for an art id, or null if the id is unknown or marked missing. */
export function assetUrl(id) {
  const a = table.get(id);
  return a ? BASE + a.file : null;
}

/** Every id the built-in table knows (tests compare it with the manifest). */
export function builtInIds() {
  return Object.keys(BUILT_IN);
}

/** A text chip standing in for art. */
export function chip(label, cls = '') {
  return `<span class="asset-chip ${esc(cls)}" role="img" aria-label="${esc(label)}">${esc(label)}</span>`;
}

/**
 * An <img> for an art id, as an HTML string. Options: alt, cls, label (chip text if the art
 * is missing; defaults to alt or the id), w / h (intrinsic size attributes, stops layout jumps),
 * fallback (an HTML string to use instead of the plain chip when the art is missing).
 */
export function img(id, { alt = '', cls = '', label = '', w = 0, h = 0, fallback = '' } = {}) {
  const url = assetUrl(id);
  const text = label || alt || id;
  if (!url) return fallback || chip(text, cls);
  const size = w && h ? ` width="${w}" height="${h}"` : '';
  return `<img class="${esc(cls)}" src="${url}" alt="${esc(alt)}" data-asset="${esc(id)}" data-label="${esc(text)}"${size} decoding="async" draggable="false">`;
}

/** Glyph for each suit icon (a shape, so suits never rely on colour alone). */
const GLYPHS = { circle: '●', triangle: '▲', square: '■', diamond: '◆' };
export const suitGlyph = (suit) => GLYPHS[SUIT_ICONS[suit]] || '?';

/** A card face drawn in HTML: the number and the suit shape, in the suit's colour. */
export function cardChip(card, cls = '') {
  const suit = cardSuit(card);
  return `<span class="asset-chip cardimg cardchip cardchip--${suit} ${esc(cls)}" role="img" aria-label="${esc(cardName(card))}"><b>${cardValue(card)}</b><i aria-hidden="true">${suitGlyph(suit)}</i></span>`;
}

/** A card face as an <img> (the aspect ratio is fixed by CSS), or the drawn face when there is no art. */
export function cardImg(card, { cls = '', alt = '' } = {}) {
  return img(cardFace(card), { cls: `cardimg ${cls}`.trim(), alt, label: cardName(card), w: 300, h: 429, fallback: cardChip(card, cls) });
}

export function cardBackImg(cls = '') {
  return img('card-back', { cls: `cardimg ${cls}`.trim(), alt: '', label: 'Card back', w: 300, h: 429, fallback: `<span class="asset-chip cardimg cardchip cardchip--back ${esc(cls)}" role="img" aria-label="Card back"></span>` });
}

/** The suit badge (a coloured disc, the colour-blind cue). */
export function badgeImg(kind, cls = '') {
  return img(`badge-${kind}`, { cls: `badge-suit ${cls}`.trim(), alt: '', label: kind, w: 64, h: 64, fallback: `<span class="badge-suit badge-suit--${esc(kind)} ${esc(cls)}" aria-hidden="true">${suitGlyph(kind)}</span>` });
}

/** An island card by face id ('island-silk-a'); falls back to a chip naming the cargo. */
export function islandImg(face, cls = '') {
  const cargo = islandFaceCargo(face);
  return img(face, { cls: `islandimg ${cls}`.trim(), alt: `${SUIT_NAMES[cargo]} island`, label: SUIT_NAMES[cargo], w: 480, h: 335 });
}

/** A seat's ship pawn. */
export function shipImg(seat, cls = '') {
  return img(SHIP_IDS[seat % SHIP_IDS.length], { cls: `shipimg ${cls}`.trim(), alt: '', label: `Ship ${seat + 1}`, w: 256, h: 215, fallback: `<span class="shipchip shipchip--${(seat % 5) + 1} ${cls}" style="--seat:${SEAT_COLOURS[seat % 5]}" aria-hidden="true">${seat + 1}</span>` });
}

/** Seat avatar: seat k uses avatar-(k+1), wrapping after five. */
export function avatarId(seat) {
  return `avatar-${(seat % 5) + 1}`;
}

/**
 * Once per page: turns any <img data-asset> that fails to load into its text chip.
 * `error` does not bubble, so the listener is a capture listener on the document.
 */
export function installImageFallback(doc = document) {
  doc.addEventListener('error', (e) => {
    const el = e.target;
    if (!el || el.tagName !== 'IMG' || !el.dataset || !el.dataset.asset) return;
    const span = doc.createElement('span');
    span.className = `asset-chip ${el.className || ''}`.trim();
    span.setAttribute('role', 'img');
    span.setAttribute('aria-label', el.dataset.label || el.dataset.asset);
    span.textContent = el.dataset.label || el.dataset.asset;
    el.replaceWith(span);
  }, true);
}
