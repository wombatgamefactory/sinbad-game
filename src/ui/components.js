// components.js - HTML string builders for the game screen: the ring of islands with the ships on it, the
// seats with their live score arithmetic, the trick (trades sideways), the hand and the forced-trade
// callout, the mooring step, the score pad, the log and the overlays (pass-and-play cover, the reckoning
// at the end of a voyage, the end of the game). Pure string functions of a view-model `vm` built in
// main.js; no DOM access, no game logic (the engine is asked, never re-derived).
//
// vm = { board, names, types, humanSeats, me, shown, hand, reasons, hints, myTurn, view,
//        ui, log, state (read-only: handLog, result, params), frame (the playback frame or null) }
// `vm.shown` is the seat whose hand is on screen (the viewer, "you"); null when no hand is shown.

import { SUIT_NAMES, cardSuit, cardName, cardSerpents, trickWinner } from '../engine/index.js';
import { esc, img, cardImg, cardBackImg, badgeImg, avatarId, islandImg, shipImg, SEAT_COLOURS } from './assets.js';
import { turnPrompt, waitingText, winnerBanner, tiebreakText, playSituation, situationText, signed } from './text.js';

export { esc };

const youName = (n) => n === 'You';
const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
const colourOf = (s) => SEAT_COLOURS[s % SEAT_COLOURS.length];

export function typeLabel(type) {
  if (type === 'human') return 'Human';
  return `${type.charAt(0).toUpperCase()}${type.slice(1)} bot`;
}

function badge(vm, s) {
  const t = vm.types[s];
  return `<span class="badge badge--${t === 'human' ? 'human' : 'bot'}">${esc(typeLabel(t))}</span>`;
}

function avatar(s, cls = 'seat__avatar') {
  return img(avatarId(s), { cls, alt: '', label: '', w: 96, h: 96, fallback: `<span class="${esc(cls)} avatar-chip avatar-chip--${(s % 5) + 1}" aria-hidden="true">${s + 1}</span>` });
}

/** A ship pawn: the seat's dhow. `you` ships get a ring so the viewer finds their own. */
function pawnHtml(vm, s, extra = '') {
  const name = vm.names[s];
  const you = vm.shown === s;
  return `<span class="pawn${you ? ' is-you' : ''}${extra}" data-ship-seat="${s}" title="${esc(`${name}${youName(name) ? 'r' : "'s"} ship`)}">${shipImg(s, 'pawn__img')}<span class="sr-only">${esc(name)}'s ship</span></span>`;
}

const islandLabel = (b, i) => `island ${i + 1} (${SUIT_NAMES[b.ring[i]]})`;

// ---------- the ring ----------

// The ring is laid out in percentages of its stage, island 1 at the top and the rest clockwise, so the stage's
// aspect ratio (CSS) turns the circle into an oval on a wide screen and keeps it round on a phone.
const RX = 38;
const RY = 38;
const polar = (deg, rx = RX, ry = RY) => {
  const t = (deg * Math.PI) / 180;
  return { x: +(50 + rx * Math.sin(t)).toFixed(2), y: +(50 - ry * Math.cos(t)).toFixed(2) };
};

/** One chevron per gap between islands, pointing clockwise. */
function arrowsHtml(n) {
  let out = '';
  for (let k = 0; k < n; k++) {
    const deg = ((k + 0.5) * 360) / n;
    const p = polar(deg, 31, 31); // just inside the islands, on the dashed track
    out += `<span class="ring__arrow" style="left:${p.x}%;top:${p.y}%;--rot:${deg.toFixed(1)}deg" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 4l10 8-10 8" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
  }
  return out;
}

function ringCentreHtml(vm) {
  const b = vm.board;
  let big;
  let small;
  if (b.phase === 'over') { big = 'Game over'; small = ''; }
  else if (b.phase === 'moor') { big = 'Mooring'; small = `Voyage ${Math.min(b.handNo + 1, b.handsPerGame)} of ${b.handsPerGame}`; }
  else {
    const t = b.trick;
    const n = t ? t.n : b.trickNo + 1;
    big = `Trick ${Math.min(n, b.handSize)} of ${b.handSize}`;
    small = t && t.ledSuit ? `<span class="led led--${t.ledSuit}">${badgeImg(t.ledSuit, 'led__badge')}${esc(SUIT_NAMES[t.ledSuit])} led</span>` : `Voyage ${Math.min(b.handNo + 1, b.handsPerGame)} of ${b.handsPerGame}`;
  }
  return `<div class="ring__centre"><svg class="ring__loop" viewBox="0 0 48 48" aria-hidden="true"><path d="M28.1 8.6A16 16 0 1 1 11.7 13.7" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/><path d="M15 9.9L15.3 18 6.9 11z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
    <b class="ring__big">${big}</b><span class="ring__small">${small}</span><span class="ring__clock">Ships sail clockwise only</span></div>`;
}

/** The 8 islands clockwise, each with its ships; during a human's mooring every island is a button. */
export function ringHtml(vm) {
  const b = vm.board;
  const view = vm.view;
  const mooring = !!(vm.myTurn && view && view.phase === 'moor');
  const youIsland = vm.shown !== null && vm.shown !== undefined ? b.ships[vm.shown] : null;
  const next = b.ships.map((x) => (x === null ? null : (x + 1) % b.ring.length));
  const sel = vm.ui.selected;
  const items = b.ring.map((cargo, i) => {
    const p = polar((i * 360) / b.ring.length);
    const here = b.ships.map((x, s) => (x === i ? s : -1)).filter((s) => s >= 0);
    const coming = next.map((x, s) => (x === i ? s : -1)).filter((s) => s >= 0);
    const moored = b.fx && b.fx.moored !== undefined ? b.fx.moored : -1;
    const pawns = here.map((s) => pawnHtml(vm, s, s === moored ? ' is-new' : '')).join('');
    const dots = coming.map((s) => `<span class="nextdot" style="--seat:${colourOf(s)}" title="${esc(`${vm.names[s]} sails here next`)}"></span>`).join('');
    const holding = view ? view.hand.filter((c) => cardSuit(c) === cargo).length : 0;
    const hereNames = here.map((s) => vm.names[s]).join(', ');
    let label = `Island ${i + 1}, ${SUIT_NAMES[cargo]}.${hereNames ? ` Ships here: ${hereNames}.` : ' No ships here.'}`;
    if (mooring) label = `Moor at island ${i + 1}, ${SUIT_NAMES[cargo]}. You hold ${plural(holding, 'card', 'cards')} of ${SUIT_NAMES[cargo]}.${hereNames ? ` Ships here: ${hereNames}.` : ''} The next island is ${SUIT_NAMES[b.ring[(i + 1) % b.ring.length]]}.`;
    const cls = ['isle', `isle--${cargo}`];
    if (i === youIsland) cls.push('is-mine');
    if (mooring) cls.push('is-pickable');
    if (sel === `isle:${i}`) cls.push('is-selected');
    const inner = `${islandImg(b.islandFaces[i], 'isle__img')}
        <span class="isle__num" aria-hidden="true">${i + 1}</span>
        <span class="isle__next" aria-hidden="true">${dots}</span>
        <span class="isle__ships" data-n="${here.length}">${pawns}</span>
        <span class="isle__cargo" aria-hidden="true">${badgeImg(cargo, 'isle__badge')}<b>${esc(SUIT_NAMES[cargo])}</b></span>
        ${mooring ? `<span class="isle__hold" aria-hidden="true">${holding} in hand</span><span class="isle__go" aria-hidden="true">${sel === `isle:${i}` ? 'Tap again to moor' : 'Moor here'}</span>` : ''}`;
    const el = mooring
      ? `<button type="button" class="${cls.join(' ')}" data-action="decide" data-island-btn="${i}" data-decision='{"type":"moor","island":${i}}' aria-label="${esc(label)}">${inner}</button>`
      : `<div class="${cls.join(' ')}" role="group" aria-label="${esc(label)}">${inner}</div>`;
    return `<li class="ring__isle" data-island="${i}" style="left:${p.x}%;top:${p.y}%">${el}</li>`;
  }).join('');
  const caption = vm.frame && vm.frame.kind === 'sail' && vm.frame.log
    ? `<p class="ring__caption is-sail" id="ring-caption" aria-hidden="true">${esc(vm.frame.log)}</p>`
    : '<p class="ring__caption" id="ring-caption"><span class="nextdot nextdot--key" aria-hidden="true"></span> A small dot marks the island a ship sails to next.</p>';
  return `<div class="ring${b.fx && b.fx.ring ? ' is-fresh' : ''}" aria-label="The ring of eight islands, clockwise from island 1">
    <div class="ring__stage"><span class="ring__track" aria-hidden="true"></span>${arrowsHtml(b.ring.length)}${ringCentreHtml(vm)}<ol class="ring__list">${items}</ol></div>
    ${caption}</div>`;
}

// ---------- seats ----------

export function seatHtml(vm, s) {
  const b = vm.board;
  const name = vm.names[s];
  const toAct = b.toAct === s && b.phase !== 'over';
  const tags = [];
  if (b.phase !== 'over' && b.dealer === s) tags.push('<span class="tag tag--dealer" title="Dealer this voyage">Dealer</span>');
  if (b.phase === 'play' && ((b.trick && b.trick.leader === s) || (!b.trick && b.toAct === s))) tags.push('<span class="tag tag--leader" title="Leads this trick">Leads</span>');
  if (toAct) tags.push(`<span class="tag tag--turn">${vm.types[s] === 'human' && vm.humanSeats.length === 1 ? (b.phase === 'moor' ? 'Your mooring' : 'Your turn') : (b.phase === 'moor' ? 'To moor' : 'To play')}</span>`);
  const cards = b.handCounts[s];
  const winning = b.trick && b.trick.winner === s;
  const ship = b.ships[s];
  const shipText = ship === null
    ? 'Not moored yet'
    : `Island ${ship + 1}: <b>${esc(SUIT_NAMES[b.ring[ship]])}</b> &rarr; next ${esc(SUIT_NAMES[b.ring[(ship + 1) % b.ring.length]])}`;
  const row = b.serpentRows[s].map((c) => cardImg(c, { cls: 'seat__serpentcard', alt: cardName(c) })).join('');
  const t = b.tricksWon[s];
  const sp = b.serpentsTaken[s];
  const trickScore = t * b.trickPoints;
  const serpentScore = sp * b.serpentPoints;
  const voyagePts = trickScore + serpentScore;
  const minus = (n) => signed(n); // 0 shows as 0, never -0
  return `<article class="seat${toAct ? ' is-turn' : ''}${winning ? ' is-winning' : ''}${vm.shown === s ? ' is-you' : ''}" data-seat="${s}" style="--seat:${colourOf(s)}" aria-label="${esc(name)}">
    <header class="seat__head">
      ${avatar(s)}
      <div class="seat__id"><b class="seat__name">${esc(name)}</b>${badge(vm, s)}</div>
      <div class="seat__cards" title="Cards in hand" aria-label="${plural(cards, 'card', 'cards')} in hand"><b class="seat__cardsnum" data-cards="${s}">${cards}</b><small>in hand</small></div>
    </header>
    <div class="seat__tags">${tags.join('')}</div>
    <p class="seat__ship" data-ship="${s}">${shipImg(s, 'seat__shipimg')}<span>${shipText}</span></p>
    <div class="calc" role="group" aria-label="${esc(`${name}, this voyage so far: ${plural(t, 'trick', 'tricks')}, ${plural(sp, 'serpent', 'serpents')}, ${plural(voyagePts, 'point', 'points')}`)}">
      <span class="calc__part calc__part--tricks${b.trickPoints ? '' : ' is-off'}${b.fx && b.fx.won === s ? ' fx-bump' : ''}" title="${b.trickPoints ? `${plural(t, 'trick', 'tricks')} won this voyage, +${b.trickPoints} each` : `${plural(t, 'trick', 'tricks')} won: tricks score nothing in this game`}"><b>+${trickScore}</b><i>${t === 1 ? 'trick' : 'tricks'}</i></span>
      <span class="calc__part calc__part--serpents${b.fx && b.fx.serpents === s ? ' fx-bump' : ''}" title="${plural(sp, 'serpent', 'serpents')} on your face-up cards, ${b.serpentPoints} each" data-serpents="${s}"><b>${minus(serpentScore)}</b><i>${sp === 1 ? 'serpent' : 'serpents'}</i></span>
      <span class="calc__eq" aria-hidden="true">=</span>
      <span class="calc__part calc__part--score" title="This voyage so far"><b>${voyagePts}</b><i>voyage</i></span>
    </div>
    ${row ? `<div class="seat__serpents" aria-label="Face-up serpent cards">${row}</div>` : ''}
    <footer class="seat__total" title="Total over finished voyages">Total <b>${b.totals[s]}</b></footer>
  </article>`;
}

// ---------- the table ----------

export function tableHtml(vm) {
  return `<div class="table" data-n="${vm.board.n}">
    <div class="table__status">${statusHtml(vm)}</div>
    <div class="table__ring">${ringHtml(vm)}</div>
    <div class="table__trick">${trickHtml(vm)}</div>
  </div>`;
}

/** Every seat with its ship, its live score arithmetic and its face-up serpents. */
export function seatsHtml(vm) {
  const seats = Array.from({ length: vm.board.n }, (_, s) => seatHtml(vm, s)).join('');
  return `<div class="table__seats" data-n="${vm.board.n}" role="group" aria-label="The players">${seats}</div>`;
}

// ---------- status and trick ----------

export function statusHtml(vm) {
  const b = vm.board;
  const names = vm.names;
  let line1;
  if (b.phase === 'over') line1 = 'Game over';
  else {
    const voyage = `Voyage ${Math.min(b.handNo + 1, b.handsPerGame)} of ${b.handsPerGame}`;
    const step = b.phase === 'moor' ? 'Mooring' : `Trick ${Math.min(b.trickNo + 1, b.handSize)} of ${b.handSize}`;
    const aside = b.setAsideCount ? ` &middot; ${b.setAsideCount} set aside` : '';
    line1 = `${voyage} &middot; ${step} &middot; ${esc(names[b.dealer])} ${youName(names[b.dealer]) ? 'deal' : 'deals'}${aside}`;
  }
  let prompt = '';
  if (vm.myTurn && vm.view && !vm.frame) prompt = turnPrompt(vm.view);
  else prompt = waitingText(b, names, vm.types);
  return `<div class="status" role="status"><p class="status__line">${line1}</p><p class="status__prompt" id="prompt">${esc(prompt)}</p></div>`;
}

/** Who is best right now, by the engine's own trickWinner (never worked out here). */
function bestNow(b, t) {
  if (!t || t.winner !== null || !t.plays.length) return null;
  try { return trickWinner(t.plays.map((p) => ({ seat: p.seat, card: p.card, mode: p.mode })), b.rules.TIE); } catch { return null; }
}

export function trickHtml(vm) {
  const b = vm.board;
  const names = vm.names;
  const live = b.trick;
  const recap = !live && b.last ? b.last.trick : null;
  const t = live || recap;
  const startSeat = t ? t.leader : (b.toAct !== null ? b.toAct : 0);
  const order = t ? t.seats : Array.from({ length: b.n }, (_, k) => (startSeat + k) % b.n);
  const best = bestNow(b, t);
  const slots = order.map((s) => {
    const idx = t ? t.plays.findIndex((x) => x.seat === s) : -1;
    const p = idx >= 0 ? t.plays[idx] : null;
    const who = `<span class="tplay__who">${pawnHtml(vm, s, ' pawn--small')}<span class="tplay__name">${esc(names[s])}</span></span>`;
    if (!p) return `<li class="tplay tplay--empty" data-seat="${s}"><span class="tplay__box"><span class="tplay__slot"></span></span>${who}</li>`;
    const win = t.winner === s;
    const isBest = !win && best && best.seat === s;
    const n = cardSerpents(p.card);
    const tags = [];
    if (p.mode === 'lead') tags.push(['led', 'Leads']);
    if (p.mode === 'trade') tags.push(['trade', `Trade: counts as ${SUIT_NAMES[p.countsAs]}`]);
    if (p.mode === 'discard') tags.push(['discard', "Discard: can't win"]);
    if (n > 0) tags.push(['serpent', `${plural(n, 'serpent', 'serpents')}`]);
    if (win) tags.push(['wins', 'Wins']);
    else if (isBest) tags.push(['best', 'Best so far']);
    const cls = ['tplay'];
    if (win) cls.push('is-winner');
    if (isBest) cls.push('is-best');
    if (p.sideways) cls.push('is-sideways');
    if (p.mode === 'discard') cls.push('is-discard');
    if (t.winner !== null && !win) cls.push('is-lost');
    return `<li class="${cls.join(' ')}" data-mode="${p.mode}" data-seat="${s}"><span class="tplay__box"><span class="tplay__rot">${cardImg(p.card, { alt: cardName(p.card) })}</span></span>${who}<span class="tplay__tags">${tags.map(([k, x]) => `<i class="mark mark--${k}">${k === 'trade' ? badgeImg(p.countsAs, 'mark__badge') : ''}${esc(x)}</i>`).join('')}</span></li>`;
  }).join('');
  let title;
  if (b.phase === 'moor') title = 'The trick table: mooring comes first';
  else if (recap) title = `Trick ${recap.n} taken`;
  else if (!live) title = `Trick ${Math.min(b.trickNo + 1, b.handSize)}`;
  else if (live.ledSuit) title = `Trick ${live.n} of ${b.handSize} &middot; <span class="led led--${live.ledSuit}">${badgeImg(live.ledSuit, 'led__badge')}${esc(`${SUIT_NAMES[live.ledSuit]} led`)}</span>`;
  else title = `Trick ${live.n} of ${b.handSize}`;
  let banner = b.banner;
  if (!banner && live && live.done) banner = { winner: live.winner, card: live.winningCard, mode: live.winningMode, tie: live.tie };
  if (!banner && recap && b.last.event) banner = { winner: b.last.event.winner, card: b.last.event.card, mode: b.last.event.mode, tie: !!b.last.event.tie, tieBrokenBy: b.last.event.tieBrokenBy || null, serpents: b.last.event.serpents };
  let msg = '';
  let note = '';
  if (banner) msg = winnerBanner(banner, names);
  else if (live && best) {
    const w = names[best.seat];
    msg = `${w} ${youName(w) ? 'are' : 'is'} winning with ${cardName(best.card)}${best.mode === 'trade' ? ' (a trade)' : ''}.`;
    if (best.tie) note = best.tieBrokenBy === 'real' ? `Tied on ${best.value}: a real card beats a trade, so the real card is ahead.` : `Tied on ${best.value}: the first card played wins.`;
  } else if (!live && b.phase === 'play') msg = b.toAct !== null ? `${names[b.toAct]} ${youName(names[b.toAct]) ? 'lead' : 'leads'} the next trick.` : '';
  else if (b.phase === 'moor') msg = 'Each player moors a ship, then the first trick is led.';
  return `<div class="trick${recap ? ' trick--recap' : ''}"><p class="trick__title">${title}</p><ol class="tplays">${slots}</ol><p class="trick__msg${banner ? ' is-banner' : ''}" id="trick-msg">${esc(msg)}</p>${note ? `<p class="trick__note" id="trick-note">${esc(note)}</p>` : '<p class="trick__note" id="trick-note"></p>'}</div>`;
}

// ---------- the hand ----------

export function handHtml(vm) {
  const hand = vm.hand;
  if (!hand) return '';
  const items = hand.map((card, i) => {
    const reason = vm.reasons.get(card) || null;
    const hint = vm.hints.get(card) || null;
    const legal = vm.myTurn && vm.state.phase === 'play' && !reason;
    const suit = cardSuit(card);
    const cls = ['card', `card--${suit}`];
    if (!vm.myTurn || vm.state.phase !== 'play') cls.push('is-wait');
    else if (legal) cls.push('is-legal'); else cls.push('is-blocked');
    if (i === 0 || cardSuit(hand[i - 1]) !== suit) cls.push('is-first');
    if (vm.ui.selected === card) cls.push('is-selected');
    const trade = !!(legal && hint && hint.mode === 'trade');
    if (trade) cls.push('is-trade');
    let mark = '';
    if (legal && hint && (hint.mode === 'follow' || hint.mode === 'trade')) mark = `<span class="card__hint ${hint.wins ? 'is-win' : 'is-lose'}" aria-hidden="true">${hint.wins ? '&#10003;' : '&#10007;'}</span>`;
    const tag = trade ? '<span class="card__tag" aria-hidden="true">Trade</span>' : '';
    let title;
    if (!vm.myTurn) title = `${cardName(card)}: wait for your turn`;
    else if (vm.state.phase === 'moor') title = `${cardName(card)}: moor your ship first`;
    else if (reason) title = reason;
    else if (hint && hint.mode === 'trade') title = `Trade ${cardName(card)}: laid sideways, counts as ${SUIT_NAMES[hint.ledSuit]}`;
    else if (hint && hint.mode === 'discard') title = `Discard ${cardName(card)}: cannot win`;
    else title = `Play ${cardName(card)}`;
    const sr = legal && hint && (hint.mode === 'follow' || hint.mode === 'trade') ? (hint.wins ? ' (would win the trick as it stands)' : ' (would not win)') : '';
    return `<button type="button" class="${cls.join(' ')}" data-action="play" data-card="${card}" title="${esc(title)}" aria-label="${esc(cardName(card) + (trade ? ', a trade' : '') + sr)}"${legal ? '' : ' aria-disabled="true"'}>${cardImg(card)}${mark}${tag}</button>`;
  }).join('');
  return `<div class="hand" role="group" aria-label="Your hand, sorted by cargo">${items}</div>`;
}

/**
 * The mooring step's panel (R3.6). The islands on the ring are the buttons (data-action="decide" and
 * data-decision='{"type":"moor","island":3}', see ringHtml); this panel explains the choice.
 */
export function decisionHtml(vm) {
  if (!vm.myTurn || !vm.view || vm.view.phase !== 'moor') return '';
  const v = vm.view;
  const moored = v.ships.filter((x) => x !== null).length;
  const holds = ['spice', 'pearls', 'silk', 'amber'].map((c) => `<li>${badgeImg(c, 'decision__badge')}<span><b>${v.hand.filter((x) => cardSuit(x) === c).length}</b> ${esc(SUIT_NAMES[c])}</span></li>`).join('');
  return `<div class="decision" role="group" aria-label="Moor your ship">
    <p class="decision__title">Moor your ship: pick any island on the ring</p>
    <p class="decision__text">${moored ? `${plural(moored, 'ship is', 'ships are')} already moored, and ships may share an island. ` : 'Ships may share an island. '}Ships only sail <b>clockwise</b>: whenever you trade or discard, your ship moves one island on. Your island's cargo is what you must trade when you cannot follow.</p>
    <ul class="decision__hold" aria-label="Cards in your hand by cargo">${holds}</ul>
  </div>`;
}

/** The callout above the hand: the forced trade, an optional trade, a discard or a follow, in words. */
export function situationHtml(vm) {
  if (!vm.myTurn || !vm.view || vm.view.phase !== 'play' || vm.frame) return '';
  const sit = playSituation(vm.view);
  const text = situationText(sit);
  if (!text) return '<p class="situation situation--lead" id="situation">You lead: any card is allowed, and its cargo is the cargo led. Leading never sails your ship.</p>';
  const isTrade = sit.kind === 'trade' || sit.kind === 'trade-optional';
  const face = isTrade ? vm.board.islandFaces[sit.island] : null;
  return `<div class="situation situation--${sit.kind}" id="situation" role="note">
    ${face ? `<span class="situation__isle">${islandImg(face, 'situation__img')}</span>` : ''}
    <div class="situation__text"><p class="situation__title">${esc(text.title)}</p><p>${esc(text.body)}</p>${text.tip ? `<p class="situation__tip">${esc(text.tip)}</p>` : ''}</div>
  </div>`;
}

/** The viewer's current island, in the hand panel: their dhow, "Island N", the cargo badge and name, in the cargo's colour. Nothing before they have moored. */
export function youIsleHtml(vm) {
  const b = vm.board;
  const isl = vm.shown !== null && vm.shown !== undefined ? b.ships[vm.shown] : null;
  if (isl === null || isl === undefined) return '<p class="youisle youisle--none">Not moored yet</p>';
  const cargo = b.ring[isl];
  return `<p class="youisle youisle--${cargo}" data-seat="${vm.shown}" data-island="${isl}" data-cargo="${cargo}" aria-label="${esc(`Your ship is at island ${isl + 1}, ${SUIT_NAMES[cargo]}`)}">${shipImg(vm.shown, 'youisle__ship')}<span class="youisle__txt">Island ${isl + 1}</span>${badgeImg(cargo, 'youisle__badge')}<b>${esc(SUIT_NAMES[cargo])}</b></p>`;
}

export function handBoxHtml(vm) {
  const who = vm.humanSeats.length > 1 ? `${esc(vm.names[vm.shown])}'s hand` : 'Your hand';
  if (vm.hand === null) {
    // Pass-and-play and it is not this human's decision (or nobody is human): never show a hand.
    if (vm.humanSeats.length === 0) return '';
    return `<div class="handbox handbox--hidden"><p class="handbox__title">Hands are hidden</p>${cardBackImg('handbox__back')}</div>`;
  }
  const playing = vm.myTurn && vm.state.phase === 'play';
  const moorTurn = vm.myTurn && vm.state.phase === 'moor';
  const title = `${who} <span>sorted by cargo</span>`;
  return `<div class="handbox${vm.myTurn ? ' is-turn' : ''}">
    ${moorTurn ? decisionHtml(vm) : ''}
    ${playing ? situationHtml(vm) : ''}
    <div class="handbox__head">${youIsleHtml(vm)}<p class="handbox__title">${title}</p></div>
    <div class="hand-wrap">${handHtml(vm)}</div>
    ${moorTurn ? '<p class="legend">Look at your hand, then choose an island on the ring above. Later ships can see yours.</p>' : ''}
    <p class="preview" id="preview" aria-live="polite"></p>
    <p class="note" id="note" role="status">${esc(vm.ui.note || '')}</p>
  </div>`;
}

// ---------- score pad and log ----------

/** Score pad rows by voyage: finished voyages, this one so far, the rest to come. */
export function padHtml(vm) {
  const b = vm.board;
  const log = vm.state.handLog;
  const names = vm.names;
  const rows = [];
  for (let h = 0; h < b.handsPerGame; h++) {
    if (h < log.length && (h < b.handNo || b.phase === 'over')) {
      const rec = log[h];
      rows.push(`<tr><th scope="row">Voyage ${h + 1}</th>${rec.scores.map((x, s) => `<td title="${esc(`${plural(rec.tricksWon[s], 'trick', 'tricks')}, ${plural(rec.serpentsTaken[s], 'serpent', 'serpents')}`)}">${x}</td>`).join('')}</tr>`);
    } else if (h === b.handNo && b.phase !== 'over') {
      rows.push(`<tr class="is-now"><th scope="row">Voyage ${h + 1} <small>so far</small></th>${names.map((_, s) => `<td title="Tricks and serpents so far">${b.tricksWon[s] * b.trickPoints + b.serpentsTaken[s] * b.serpentPoints}</td>`).join('')}</tr>`);
    } else {
      rows.push(`<tr class="is-todo"><th scope="row">Voyage ${h + 1}</th>${names.map(() => '<td>&middot;</td>').join('')}</tr>`);
    }
  }
  return `<table class="pad"><caption class="sr-only">Score pad by voyage</caption>
    <thead><tr><th scope="col"></th>${names.map((n, s) => `<th scope="col" title="${esc(n)}">${avatar(s, 'pad__avatar')}<span class="pad__name">${esc(n)}</span></th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>
    <tfoot><tr><th scope="row">Total</th>${b.totals.map((t) => `<td>${t}</td>`).join('')}</tr></tfoot></table>`;
}

export function logHtml(vm) {
  const items = vm.log.slice().reverse().slice(0, 80).map((l) => `<li class="log__item log__item--${l.kind || 'info'}">${esc(l.text)}</li>`).join('');
  return `<ol class="log__list" id="log" aria-label="What has happened, newest first">${items || '<li class="log__item">Nothing yet.</li>'}</ol>`;
}

export function sideHtml(vm) {
  const open = (k, d = true) => (vm.ui.panels[k] === undefined ? d : vm.ui.panels[k]) ? ' open' : '';
  return `<aside class="side">
    <details class="panel" data-panel="pad"${open('pad')}><summary>Score pad</summary>${padHtml(vm)}</details>
    <details class="panel" data-panel="log"${open('log')}><summary>What happened</summary>${logHtml(vm)}</details>
  </aside>`;
}

// ---------- overlays ----------

/** Pass-and-play cover: nothing from the game is in the DOM while it is up. */
export function coverHtml(vm, seat) {
  const name = vm.names[seat];
  return `<div class="cover" id="cover" role="dialog" aria-modal="true" aria-labelledby="cover-title">
    <div class="cover__card">
      ${avatar(seat, 'cover__avatar')}
      <p class="cover__kicker">Pass the device</p>
      <h2 id="cover-title">Pass to ${esc(name)}</h2>
      <p class="cover__msg">It is your turn. Everyone else look away: your hand is about to appear.</p>
      <button type="button" class="btn btn--primary btn--big" data-action="reveal" data-seat="${seat}">I am ${esc(name)}: show my hand</button>
    </div>
  </div>`;
}

/** The reckoning at the end of a voyage (R5.7): +tricks, -serpents, = score, and the running total. */
export function handSummaryHtml(vm, modal) {
  const ev = modal.event;
  const names = vm.names;
  const last = vm.state.phase === 'over' && modal.handNo === vm.state.handLog.length - 1;
  const tp = vm.board.trickPoints;
  const sp = vm.board.serpentPoints;
  const lines = ev.lines || ev.scores.map((x, s) => ({ tricks: ev.tricksWon[s], serpents: (ev.serpentsTaken || [])[s] || 0, trickScore: ev.tricksWon[s] * tp, serpentScore: (((ev.serpentsTaken || [])[s]) || 0) * sp, score: x, total: ev.totals[s] }));
  const top = Math.max(...ev.scores);
  const minus = (n) => signed(n); // 0 shows as 0, never -0
  const rows = names.map((n, s) => `<tr${ev.scores[s] === top ? ' class="is-top"' : ''}>
    <th scope="row"><span class="who">${avatar(s, 'pad__avatar')}<span>${esc(n)}</span></span></th>
    <td class="num num--tricks" title="${esc(plural(lines[s].tricks, 'trick', 'tricks'))}"><b>+${lines[s].trickScore}</b><small>${plural(lines[s].tricks, 'trick', 'tricks')}</small></td>
    <td class="num num--serpents" title="${esc(plural(lines[s].serpents, 'serpent', 'serpents'))}"><b>${minus(lines[s].serpentScore)}</b><small>${plural(lines[s].serpents, 'serpent', 'serpents')}</small></td>
    <td class="num num--score"><b>${ev.scores[s]}</b></td>
    <td class="num num--total">${ev.totals[s]}</td></tr>`).join('');
  const title = `Voyage ${modal.handNo + 1} of ${vm.board.handsPerGame} is over`;
  const note = tp ? `Score = +${tp} for each trick won and ${signed(sp)} for each serpent on your face-up cards. Scores can go below zero.` : `Serpents only: ${signed(sp)} for each serpent on your face-up cards; tricks score nothing.`;
  // The pad up to and including this voyage, from the event (the live state may already be on the next one).
  const prior = vm.state.handLog.slice(0, modal.handNo);
  const padRows = [...prior.map((r, i) => `<tr><th scope="row">Voyage ${i + 1}</th>${r.scores.map((x) => `<td>${x}</td>`).join('')}</tr>`), `<tr class="is-now"><th scope="row">Voyage ${modal.handNo + 1}</th>${ev.scores.map((x) => `<td>${x}</td>`).join('')}</tr>`].join('');
  return `<div class="overlay" data-overlay="hand"><div class="end end--hand" role="dialog" aria-modal="true" aria-labelledby="hand-title">
    <p class="end__kicker">The reckoning</p>
    <h2 id="hand-title">${esc(title)}</h2>
    <div class="table-wrap"><table class="summary"><thead><tr><th scope="col">Player</th><th scope="col" title="Tricks won this voyage">${tp ? `Tricks <em>+${tp} each</em>` : 'Tricks <em>score nothing</em>'}</th><th scope="col" title="Serpents taken this voyage">Serpents <em>${signed(sp)} each</em></th><th scope="col">Voyage score</th><th scope="col">Total</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="end__note">${esc(note)}</p>
    <details class="panel panel--pad"><summary>Score pad</summary><table class="pad pad--end"><thead><tr><th></th>${names.map((n) => `<th>${esc(n)}</th>`).join('')}</tr></thead><tbody>${padRows}</tbody><tfoot><tr><th>Total</th>${ev.totals.map((t) => `<td>${t}</td>`).join('')}</tr></tfoot></table></details>
    <div class="end__buttons"><button type="button" class="btn btn--primary btn--big" data-action="continue" id="continue">${last ? 'See the final result' : 'Lay the next ring'}</button></div>
  </div></div>`;
}

export function gameEndHtml(vm) {
  const result = vm.state.result;
  const names = vm.names;
  const winners = result.winners;
  const wName = winners.map((s) => names[s]);
  let headline;
  if (result.shared) headline = `Shared win: ${wName.slice(0, -1).join(', ')}${wName.length > 1 ? ' and ' : ''}${wName[wName.length - 1]}`;
  else headline = `${wName[0]} ${youName(wName[0]) ? 'win' : 'wins'}!`;
  const rows = result.ranking.map((r) => {
    const win = winners.includes(r.seat);
    const eq = result.ranking.filter((x) => x.rank === r.rank).length > 1 ? '=' : '';
    return `<li class="rank${win ? ' is-winner' : ''}"><span class="rank__pos">${eq}${r.rank}</span>${avatar(r.seat, 'rank__avatar')}<span class="rank__who"><b>${esc(names[r.seat])}</b>${badge(vm, r.seat)}${win ? `<i class="crown">${result.shared ? 'Shared win' : 'Winner'}</i>` : ''}</span><span class="rank__last" title="Points in the final voyage (the tiebreak)">final voyage <b>${r.last}</b></span><span class="rank__total"><b>${r.total}</b> pts</span></li>`;
  }).join('');
  const tb = tiebreakText(result, names);
  const code = vm.state.rulesCode;
  const padRows = vm.state.handLog.map((h, i) => `<tr><th scope="row">Voyage ${i + 1}</th>${h.scores.map((x) => `<td>${x}</td>`).join('')}</tr>`).join('');
  return `<div class="overlay" data-overlay="end"><div class="end end--game" role="dialog" aria-modal="true" aria-labelledby="end-title">
    <p class="end__kicker">Game over</p>
    <h2 id="end-title">${esc(headline)}</h2>
    ${tb ? `<p class="end__tiebreak" id="tiebreak">${esc(tb)}</p>` : ''}
    <ol class="ranking" aria-label="Final ranking">${rows}</ol>
    <details class="panel panel--pad"><summary>Score pad</summary><table class="pad pad--end"><thead><tr><th></th>${names.map((n) => `<th>${esc(n)}</th>`).join('')}</tr></thead><tbody>${padRows}</tbody><tfoot><tr><th>Total</th>${result.totals.map((t) => `<td>${t}</td>`).join('')}</tr></tfoot></table></details>
    <p class="end__rules">${code === 'std' ? 'Standard rules.' : `Non-standard rules were on: ${esc(code)}.`}</p>
    <div class="end__buttons" id="end-buttons">
      <button type="button" class="btn btn--primary btn--big" data-action="again">Play again</button>
      <button type="button" class="btn" data-action="new">Change setup</button>
      <button type="button" class="btn btn--quiet" data-action="review">Look at the table</button>
      <button type="button" class="btn btn--quiet" data-action="open-stats">Stats</button>
    </div>
  </div></div>`;
}

export function endBarHtml(vm) {
  const result = vm.state.result;
  const w = result.winners.map((s) => vm.names[s]).join(' and ');
  return `<div class="endbar" role="status"><span><b>Game over.</b> ${esc(result.shared ? `Shared win: ${w}.` : `${w} ${youName(w) ? 'win' : 'wins'}.`)}</span><button type="button" class="btn btn--primary" data-action="again">Play again</button><button type="button" class="btn" data-action="show-end">Show result</button><button type="button" class="btn btn--quiet" data-action="open-stats">Stats</button></div>`;
}
