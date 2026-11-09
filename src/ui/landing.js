// landing.js - the landing page, which is also the setup screen (a sell sheet with a form in it),
// plus the How to play text that the in-game Rules dialog reuses. Pure string builders and two small
// form helpers; main.js owns the wiring.
//
// The page: the title banner, the hook, an at-a-glance strip (players / minutes / age / the card range
// 1 to 10), the setup form (seats Human / Easy / Medium / Hard with editable names, a "watch the bots"
// shortcut, the collapsed Playtest rules panel generated from the engine's VARIANTS), How to play in the
// six steps of the how-to-play card, the two sides of that card, the islands, and the rule book link.

import { VARIANTS, DEFAULT_RULES, SUITS, SUIT_NAMES, rulesCode, resolveVariants } from '../engine/index.js';
import { GAME_NAME, GAME_TAGLINE, RULEBOOK_URL, FOOTER_VERSION, MAX_SEATS, PLAYER_COUNTS, AT_A_GLANCE } from '../game-config.js';
import { assetUrl, img, badgeImg, esc } from './assets.js';

export { RULEBOOK_URL, MAX_SEATS, PLAYER_COUNTS };

/** The bot levels offered, in menu order. A level that is not registered is shown but disabled. */
export const LEVELS = [
  { id: 'easy', label: 'Easy' },
  { id: 'medium', label: 'Medium' },
  { id: 'hard', label: 'Hard' },
];

export const DEFAULT_SETUP = {
  players: 4,
  seats: [
    { type: 'human', name: '' }, { type: 'easy', name: '' }, { type: 'easy', name: '' }, { type: 'easy', name: '' }, { type: 'easy', name: '' },
  ],
  rules: { ...DEFAULT_RULES },
  autoPlayForced: false, // off by default so new players see, and click, the only card they may play
};

// Icons use currentColor so the strip follows the page palette.
const ICON_PLAYERS = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="13" cy="12" r="6" fill="currentColor"/><path d="M3 34c0-7 4.5-12 10-12s10 5 10 12z" fill="currentColor"/><circle cx="28" cy="12" r="6" fill="currentColor" opacity=".55"/><path d="M18 34c0-7 4.5-12 10-12s10 5 10 12z" fill="currentColor" opacity=".55"/></svg>';
const ICON_TIME = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="15" fill="none" stroke="currentColor" stroke-width="3"/><path d="M20 10v10l7 4" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" fill="none"/></svg>';
const ICON_AGE = '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="7" y="5" width="20" height="28" rx="3" fill="currentColor" opacity=".55" transform="rotate(-10 17 19)"/><rect x="14" y="8" width="20" height="28" rx="3" fill="currentColor" transform="rotate(8 24 22)"/></svg>';
const ICON_CARDS = '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="4" y="9" width="16" height="24" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.6"/><rect x="12" y="6" width="16" height="24" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.6"/><rect x="20" y="9" width="16" height="24" rx="2.5" fill="currentColor"/></svg>';

// ---------- Playtest rules, in words for players ----------

/**
 * Player-facing text for the five switches. The engine's table is the source of truth for the switches
 * (names, values, defaults) and ships its own short labels; these are the fuller sentences the setup page
 * shows. A value or switch with no entry here falls back to the engine's text.
 */
const PLAYTEST_TEXT = {
  MOOR: {
    label: 'Mooring order',
    values: { clockwise: 'Clockwise from the dealer\'s left', score: 'Trailing players moor last' },
    description: 'Each voyage starts with every player mooring a ship. Standard: clockwise from the dealer\'s left. Alternative: the player with the highest running total moors first and the player in last place moors last, so they see everyone else\'s ships before choosing. The dealer\'s left still leads the first trick.',
  },
  TIE: {
    label: 'Tie rule',
    values: { first: 'First played wins', real: 'A real card beats a trade' },
    description: 'When two cards tie for the highest counting as the led cargo. Standard: the one played first wins. Alternative: a card of the led cargo beats a traded card of the same number; two tied trades still go to the one played first.',
  },
  TRADE: {
    label: 'Trade',
    values: { mandatory: 'Mandatory', optional: 'Optional' },
    description: 'When you cannot follow the cargo led and you hold your island\'s cargo. Standard: you must trade one of those cards. Alternative: you may trade one or discard any other card instead; playing a card of your island\'s cargo is still a trade.',
  },
  VOYAGES: {
    label: 'Voyages',
    values: { players: 'One per player (four at 2 players)', four: 'Four at every player count' },
    description: 'How long the game is. Standard: one voyage per player, with four at two players. Alternative: four voyages whatever the number of players. The deal still passes left each voyage.',
  },
  SCORING: {
    label: 'Scoring',
    values: { tricks: '+1 a trick, −1 a serpent', serpents: 'Serpents only' },
    description: 'Standard: each voyage scores +1 for every trick you win and −1 for every serpent on your face-up cards. Alternative: serpents only, so each voyage scores −1 per serpent and tricks are worth nothing.',
  },
};

/** What the setup page shows for one switch: { label, values: { value: text }, description }. */
export function variantText(v) {
  const t = PLAYTEST_TEXT[v.name] || {};
  const values = {};
  for (const x of v.values) values[x] = (t.values && t.values[x]) || v.valueLabels[x] || x;
  return { label: t.label || v.label, values, description: t.description || v.description };
}

// ---------- How to play ----------

const CARGO_LINE = SUITS.map((k) => `<li>${badgeImg(k, 'how__badge')}<span>${esc(SUIT_NAMES[k])}</span></li>`).join('');

/** The rules in plain steps: the setup, the how-to-play card's six steps, scoring, the card images and the rule book link. */
export function howToPlayHtml() {
  return `<div class="how">
    <p class="how__lead">Eight islands, four cargoes, one rule: <b>every island demands its cargo</b>. Win tricks, dodge the serpents, and mind where your ship is moored.</p>
    <div class="how__cards">
      <div class="how__fact"><b>40 cards</b><span>Four cargoes numbered <strong>1 to 10</strong></span>
        <ul class="how__suits" aria-label="The four cargoes">${CARGO_LINE}</ul></div>
      <div class="how__fact"><b>Serpents</b><span>One on every 1 and two on every 10: twelve in all</span></div>
    </div>
    <h3 class="how__sub">Before the first trick</h3>
    <p>Eight island cards, two of each cargo, are laid in a ring. Starting left of the dealer, each player moors a ship at any island; ships may share. Ships only ever sail <b>clockwise</b>. The player left of the dealer leads.</p>
    <h3 class="how__sub">Playing a trick</h3>
    <ol class="how__steps">
      <li><h4>Follow</h4><p>If you hold the cargo that was led, you must play one of those cards.</p></li>
      <li><h4>Trade</h4><p>Otherwise, if you hold your island's cargo, you must play one of those cards sideways. It counts as the cargo led and can win.</p></li>
      <li><h4>Discard</h4><p>Otherwise play any card. It cannot win.</p></li>
      <li><h4>Win</h4><p>No trumps. The highest card counting as the cargo led wins. On a tie, the card played first wins.</p></li>
      <li><h4>Take</h4><p>The winner takes the trick and leads next. Serpent cards lie face up in front of the winner; the rest go face down.</p></li>
      <li><h4>Sail</h4><p>Every trade and every discard now moves its ship one island clockwise. Leading never sails your ship.</p></li>
    </ol>
    <h3 class="how__sub">Scoring</h3>
    <p class="how__score">Each voyage: <b>+1 per trick won, &minus;1 per serpent</b>. Serpents are on every 1 (one) and every 10 (two). A voyage ends when hands are empty; then a fresh ring is laid and the deal passes left. The game lasts one voyage per player (four at two players). The highest total wins; a tie goes to the most points in the final voyage, then is shared.</p>
    <div class="how__pics">
      <figure>${img('how-to-play-front', { alt: 'The how-to-play card, front: Playing a trick, the six steps', cls: 'how__card', w: 300, h: 429 })}<figcaption>The how-to-play card</figcaption></figure>
      <figure>${img('how-to-play-back', { alt: 'The how-to-play card, back', cls: 'how__card', w: 300, h: 429 })}<figcaption>and its back</figcaption></figure>
    </div>
    <p class="how__link"><a href="${RULEBOOK_URL}" target="_blank" rel="noopener" data-action="rulebook">Read the full rule book (PDF)</a></p>
  </div>`;
}

// ---------- the page ----------

/** The hero banner (assets hero-wide, the title art), or a text hero if it is missing. */
function heroHtml() {
  const wide = assetUrl('hero-wide');
  if (!wide) {
    const glyphs = SUITS.map((s) => badgeImg(s, 'hero__suit')).join('');
    return `<div class="hero__art hero__art--plain"><p class="hero__title">${esc(GAME_NAME)}</p><p class="hero__suits" aria-hidden="true">${glyphs}</p></div>`;
  }
  return `<div class="hero__art">${img('hero-wide', { alt: GAME_NAME, cls: 'hero__img', label: GAME_NAME, w: 1600, h: 782 })}</div>`;
}

/** Options for a seat's type select. `levels` is botLevels() (what the registry offers). */
export function seatTypeOptions(levels, selected) {
  const offered = levels.filter((l) => l.offered !== false);
  const have = new Set(offered.map((l) => l.id));
  const known = new Set(LEVELS.map((l) => l.id));
  const extra = offered.filter((l) => !known.has(l.id)).map((l) => ({ id: l.id, label: l.label }));
  const opts = [{ id: 'human', label: 'Human', ok: true }, ...[...LEVELS, ...extra].map((l) => ({ id: l.id, label: `${l.label} bot`, ok: have.has(l.id) }))];
  return opts.map((o) => `<option value="${o.id}"${o.id === selected ? ' selected' : ''}${o.ok ? '' : ' disabled'}>${esc(o.label)}${o.ok ? '' : ' (not available yet)'}</option>`).join('');
}

function have(levels, id) {
  return id === 'human' || levels.some((l) => l.id === id && l.offered !== false);
}

function seatFieldset(i, levels, setup) {
  const seat = setup.seats[i];
  const type = have(levels, seat.type) ? seat.type : 'easy';
  return `<fieldset class="seatform" data-seat="${i}"${i >= setup.players ? ' hidden' : ''}>
      <legend>Seat ${i + 1}</legend>
      <label class="field"><span>Player</span><select name="type${i}">${seatTypeOptions(levels, type)}</select></label>
      <label class="field"><span>Name <small>(optional)</small></span><input name="name${i}" type="text" maxlength="16" autocomplete="off" value="${esc(seat.name)}" placeholder="${i === 0 ? 'You' : `Seat ${i + 1}`}"></label>
    </fieldset>`;
}

/** The "Playtest rules" panel, generated from the engine's VARIANTS table (texts from variantText()). */
export function rulesPanelHtml(setup) {
  const rows = VARIANTS.map((v) => {
    const t = variantText(v);
    const opts = v.values.map((x) => `<option value="${esc(x)}"${setup.rules[v.name] === x ? ' selected' : ''}>${esc(t.values[x])}${x === v.default ? ' (standard)' : ''}</option>`).join('');
    return `<div class="rule" data-rule="${v.name}"${v.onlyFor ? ` data-only-for="${v.onlyFor.join(',')}"` : ''}>
        <label for="rule-${v.name}"><span class="rule__id">${v.id}</span> ${esc(t.label)}</label>
        <select name="rule-${v.name}" id="rule-${v.name}">${opts}</select>
        <p class="rule__desc">${esc(t.description)}</p>
      </div>`;
  }).join('');
  return `<details class="rules" id="rules-panel">
      <summary><span>Playtest rules</span> <small id="rules-summary">standard</small></summary>
      <p class="rules__intro">Five questions the designer is still testing, as switches. The standard rules are the default; a game with any other setting is a playtest game and is recorded with the rules it used.</p>
      ${rows}
      <button type="button" class="btn btn--quiet" data-action="reset-rules">Standard rules</button>
    </details>
    <p class="rules-note" id="rules-note" role="status" hidden></p>`;
}

/** The whole landing / setup page. `levels` is botLevels(); `setup` the form defaults; `message` an error. */
export function landingHtml(levels, setup = DEFAULT_SETUP, message = '') {
  const seats = Array.from({ length: MAX_SEATS }, (_, i) => seatFieldset(i, levels, setup)).join('');
  const radios = PLAYER_COUNTS.map((n) => `<label class="seg"><input type="radio" name="players" value="${n}"${setup.players === n ? ' checked' : ''}><span>${n} players</span></label>`).join('');
  const isles = ['spice', 'pearls', 'silk', 'amber'].map((c) => `<li>${img(`island-${c}-a`, { alt: `${SUIT_NAMES[c]} island`, cls: 'islandimg landing__isle', w: 480, h: 335 })}<span>${badgeImg(c, 'how__badge')}${esc(SUIT_NAMES[c])}</span></li>`).join('');
  return `<div class="landing">
    <nav class="topnav" aria-label="Site">
      <span class="topnav__brand">${esc(GAME_NAME)}</span>
      <span class="topnav__links" id="topnav-links">
        <button type="button" class="linkbtn" data-action="open-rules">How to play</button>
        <button type="button" class="linkbtn" data-action="open-stats">Stats</button>
      </span>
    </nav>
    <header class="hero">
      ${heroHtml()}
      <h1 class="sr-only">${esc(GAME_NAME)}</h1>
      <div class="hero__text">
        <p class="hero__hook">${esc(GAME_TAGLINE)}</p>
        <p class="hero__sub">A trick-taking card game of the seven seas for ${esc(AT_A_GLANCE.players)} players. Four cargoes, cards numbered 1 to 10, and a ship that sails on every card you cannot follow. Play against bots or friends in your browser.</p>
      </div>
    </header>
    <ul class="stats" aria-label="At a glance">
      <li>${ICON_PLAYERS}<div><b>${esc(AT_A_GLANCE.players)}</b><span>Players (best ${esc(AT_A_GLANCE.best)})</span></div></li>
      <li>${ICON_TIME}<div><b>${esc(AT_A_GLANCE.minutes)}</b><span>Minutes</span></div></li>
      <li>${ICON_AGE}<div><b>${esc(AT_A_GLANCE.age)}</b><span>Ages</span></div></li>
      <li>${ICON_CARDS}<div><b>1 to 10</b><span>In four cargoes</span></div></li>
    </ul>
    <section class="panel setup-panel" aria-labelledby="setup-title">
      <h2 id="setup-title">Set up a game</h2>
      <form id="setup-form" novalidate>
        <fieldset class="players"><legend>Players</legend><div class="segs">${radios}</div></fieldset>
        <div class="setup__seats">${seats}</div>
        <p class="hint">Set every seat to a bot to watch a game, or use the button below. With two or more humans you pass the device, and a cover hides each hand between turns.</p>
        <label class="check"><input type="checkbox" name="autoPlayForced" id="autoPlayForced"${setup.autoPlayForced ? ' checked' : ''}><span><b>Play forced cards for me</b><small>When you have only one card you are allowed to play, play it automatically. Leave this off while you learn which cards are legal.</small></span></label>
        ${rulesPanelHtml(setup)}
        <p class="form-msg" role="alert">${esc(message)}</p>
        <div class="form-buttons">
          <button type="submit" class="btn btn--primary btn--big" id="start">Start game</button>
          <button type="button" class="btn" id="watch" data-action="watch-bots" title="Start a game with every seat played by a Medium bot, and just watch">Watch the bots play</button>
        </div>
      </form>
    </section>
    <section class="panel" id="how" aria-labelledby="how-title">
      <h2 id="how-title">How to play</h2>
      ${howToPlayHtml()}
    </section>
    <section class="panel landing__ring" aria-labelledby="ring-title">
      <h2 id="ring-title">The ring of islands</h2>
      <p>Eight island cards, two of each cargo, are shuffled into a new ring every voyage. Your ship's island is the cargo you must trade when you cannot follow.</p>
      <ul class="landing__isles">${isles}</ul>
    </section>
    <footer class="footer">
      <span><b>Game design: Dean Morris</b> &middot; Wombat Game Factory &middot; London, UK</span>
      <span>${esc(FOOTER_VERSION)}</span>
    </footer>
  </div>`;
}

// ---------- form helpers ----------

/** Reads the form into a setup object (never throws). */
export function readSetup(form) {
  const v = (n) => (form.elements[n] ? form.elements[n].value : '');
  const checked = form.querySelector('input[name="players"]:checked');
  const players = checked ? Number(checked.value) : 4;
  const seats = Array.from({ length: MAX_SEATS }, (_, i) => ({ type: v(`type${i}`) || (i === 0 ? 'human' : 'easy'), name: v(`name${i}`).trim() }));
  const rules = {};
  for (const def of VARIANTS) rules[def.name] = v(`rule-${def.name}`) || def.default;
  const auto = form.elements.autoPlayForced;
  return { players, seats, rules, autoPlayForced: !!(auto && auto.checked) };
}

/** Shows only the seats and rule rows that apply, and keeps the "non-standard rules" note honest. */
export function syncSetupForm(form) {
  const setup = readSetup(form);
  form.querySelectorAll('fieldset.seatform').forEach((fs) => { fs.hidden = Number(fs.dataset.seat) >= setup.players; });
  form.querySelectorAll('.rule[data-only-for]').forEach((row) => {
    row.hidden = !row.dataset.onlyFor.split(',').map(Number).includes(setup.players);
  });
  const code = safeCode(setup);
  const summary = form.querySelector('#rules-summary');
  const note = form.querySelector('#rules-note');
  if (summary) summary.textContent = code === 'std' ? 'standard' : `non-standard: ${code}`;
  if (note) {
    note.hidden = code === 'std';
    note.textContent = code === 'std' ? '' : `Non-standard rules are on (${code}). This is a playtest game, not the standard rules, and the result is recorded with these rules.`;
  }
}

/** The rules code for a setup, 'std' when standard. Never throws. */
export function safeCode(setup) {
  try { return rulesCode(resolveVariants(setup.rules), setup.players); } catch { return 'std'; }
}

/** Typed names made unique (case-insensitive): two "Sam"s become "Sam" and "Sam 2". */
export function uniqueNames(names) {
  const seen = new Map();
  return names.map((n) => {
    if (!n) return n;
    const key = n.toLowerCase();
    const k = (seen.get(key) || 0) + 1;
    seen.set(key, k);
    return k === 1 ? n : `${n} ${k}`;
  });
}

/** Whether a setup has two or more humans (pass-and-play). */
export function humanCount(setup) {
  return setup.seats.slice(0, setup.players).filter((s) => s.type === 'human').length;
}
