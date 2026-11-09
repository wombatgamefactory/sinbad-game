// bug-report.js - the in-game bug reporter: a bug button on document.body plus Ctrl+Shift+B.
// Game-agnostic apart from the name; `diagnostics()` is the one function a game may extend.
//
// Three promises:
//   1. It never throws. Every section of a report runs in section(); a failure becomes
//      { error } in that section's place, never a lost report.
//   2. It never mutates. Everything is computed from JSON clones of the live state.
//   3. The output is JSON-safe, proven by a round trip before it is written.
//
// The snapshot is frozen when the modal opens (a bot may move while the player types).
// No backend: the report is downloaded as a JSON file and a copy is kept in a small
// localStorage archive (<= 20) for re-download. The mailto link names only the public contact
// address. The button and the shortcut are disabled while the pass-and-play cover is up,
// because a report holds every hand.

import { getPlayBlockReason, legalActionsFromView, viewFor, nextIslands, playableCards, playMode, cardSuit } from '../engine/index.js';
import { GAME_NAME, GAME_SLUG, CONTACT_EMAIL, STORE_PREFIX } from '../game-config.js';

export const BUG_REPORT_EMAIL = CONTACT_EMAIL; // the mailto link is hidden if this is empty
export const SCHEMA_VERSION = 1;
export const ARCHIVE_KEY = `${STORE_PREFIX}-bugreports-v1`;
export const ARCHIVE_MAX = 20;
export const LOG_MAX = 60;
const STR_MAX = 2000;

// ---------- ring buffers ----------

const actionLog = [];
const eventLog = [];
const clone = (x) => JSON.parse(JSON.stringify(x));
const clip = (s) => String(s).slice(0, STR_MAX);

function push(buf, entry) {
  buf.push(entry);
  if (buf.length > LOG_MAX) buf.shift();
}

/** An applied action (human or bot). The one choke point: main.js feeds it from the engine's events. */
export function logAction(entry) {
  try { push(actionLog, { t: new Date().toISOString(), ...clone(entry) }); } catch { /* a logger never costs a turn */ }
}

/** An error, warning or refused click. */
export function logEvent(kind, message) {
  try { push(eventLog, { t: new Date().toISOString(), kind, message: clip(message) }); } catch { /* silent */ }
}

export function _resetLogs() { actionLog.length = 0; eventLog.length = 0; }

let hooked = false;
function installLoggers() {
  if (hooked || typeof window === 'undefined') return;
  hooked = true;
  try {
    window.addEventListener('error', (e) => logEvent('error', `${e.message || 'error'} (${e.filename || ''}:${e.lineno || ''})`));
    window.addEventListener('unhandledrejection', (e) => logEvent('unhandledrejection', e.reason && e.reason.stack ? e.reason.stack : String(e.reason)));
    for (const level of ['error', 'warn']) {
      const original = console[level];
      console[level] = function wrapped(...args) {
        try { logEvent(`console.${level}`, args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ')); } catch { /* silent */ }
        return original.apply(this, args);
      };
    }
  } catch { /* silent */ }
}

function safeStringify(x) {
  try { return JSON.stringify(x); } catch { return String(x); }
}

// ---------- snapshot ----------

function section(fn, name) {
  try { return fn(); } catch (e) { return { error: `${name}: ${e && e.message ? e.message : e}` }; }
}

function makeId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${GAME_SLUG}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${rand}`;
}

/** The seat the diagnostics speak for: the one human on show, else the first human, else whoever acts. */
function diagnosticSeat(ctl) {
  const shown = ctl.shownSeat();
  if (shown !== null) return shown;
  const h = ctl.seats.findIndex((s) => s.type === 'human');
  if (h >= 0) return h;
  const t = ctl.toAct();
  return t === null ? 0 : t;
}

/**
 * What helps reproduce a report: the legal set, why each card is blocked, the ship, its island and the led cargo.
 * `ladder` answers "what would the rules ask of this seat right now" even when it is not their turn:
 * the rung (lead / follow / must-trade / discard), the cards the ladder allows, and what each card would be.
 */
function diagnostics(state, ctl) {
  const seat = diagnosticSeat(ctl);
  const view = viewFor(state, seat);
  const actions = state.phase === 'over' ? [] : legalActionsFromView(view);
  const island = state.ships[seat] === null || state.ships[seat] === undefined ? null : state.ships[seat];
  const islandCargo = island === null ? null : state.ring[island];
  const led = state.trick ? state.trick.ledSuit : null;
  const hand = state.hands[seat];
  let ladder = null;
  if (state.phase === 'play') {
    const allowed = playableCards(hand, led, islandCargo, state.rules);
    const follows = led ? hand.some((c) => cardSuit(c) === led) : false;
    const rung = !led ? 'lead' : follows ? 'follow' : allowed.length < hand.length ? 'must-trade' : 'discard';
    ladder = { rung, allowed, modes: hand.map((card) => ({ card, mode: playMode(hand, card, led, islandCargo) })) };
  }
  return {
    seat,
    seatType: ctl.seats[seat].type,
    toAct: ctl.toAct(),
    phase: state.phase,
    legalCards: actions.filter((a) => a.type === 'play').map((a) => a.card),
    legalActions: actions,
    ship: state.ships[seat],
    island: island === null ? null : island + 1,
    islandCargo,
    nextIsland: (() => { try { const n = nextIslands(state); return n && n[seat] !== null && n[seat] !== undefined ? n[seat] + 1 : null; } catch { return null; } })(),
    ledCargo: led,
    trick: state.trick ? state.trick.plays || null : null,
    ladder,
    ring: [...state.ring],
    ships: [...state.ships],
    rules: { ...state.rules },
    rulesCode: state.rulesCode,
    cards: hand.map((card) => ({
      card,
      // null means the engine said this card WAS legal: a UI problem, not a rules one.
      blockReason: getPlayBlockReason(state, seat, card),
    })),
  };
}

/**
 * Builds a report. `ctx` = { ctl, screen }; ctl may be null (landing page). `words` =
 * { title, happened, expected }. Pure apart from reading the clock and the page.
 */
export function buildReport(ctx, words = {}, now = new Date()) {
  const ctl = ctx && ctx.ctl;
  const state = ctl ? section(() => clone(ctl.state), 'state') : null;
  const report = {
    schemaVersion: SCHEMA_VERSION,
    id: makeId(now),
    timestamp: now.toISOString(),
    environment: section(() => ({
      url: location.href,
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
      screen: ctx && ctx.screen ? ctx.screen : null,
    }), 'environment'),
    player: {
      title: clip((words.title || '').trim()),
      whatHappened: clip((words.happened || '').trim()),
      whatIExpected: clip((words.expected || '').trim()),
    },
    game: state,
    controller: ctl ? section(() => ({
      seed: ctl.seed,
      rules: clone(ctl.state.rules),
      rulesCode: ctl.state.rulesCode,
      seats: clone(ctl.seats),
      names: [...ctl.names],
      shownSeat: ctl.shownSeat(),
      toAct: ctl.toAct(),
      botRefusals: ctl.botRefusals,
    }), 'controller') : null,
    diagnostics: ctl && state && !state.error ? section(() => diagnostics(clone(ctl.state), ctl), 'diagnostics') : null,
    actionLog: clone(actionLog),
    eventLog: clone(eventLog),
  };
  try { return JSON.parse(JSON.stringify(report)); } catch (e) {
    return { schemaVersion: SCHEMA_VERSION, id: report.id, timestamp: report.timestamp, error: `report was not JSON-safe: ${e.message}` };
  }
}

// ---------- archive ----------

function storage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

export function loadArchive() {
  try {
    const s = storage();
    const raw = s && s.getItem(ARCHIVE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export function archiveReport(report) {
  const list = loadArchive();
  list.push(report);
  let keep = list.slice(-ARCHIVE_MAX);
  for (let i = 0; i < 6; i++) {
    try {
      const s = storage();
      if (!s) return false;
      s.setItem(ARCHIVE_KEY, JSON.stringify(keep));
      return true;
    } catch { keep = keep.slice(Math.ceil(keep.length / 2)); } // quota: evict the oldest half
  }
  return false;
}

// ---------- download and UI ----------

function saveFile(name, text) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch { return false; }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
const reportFilename = (r) => `${r.id}${r.player && r.player.title ? `-${slug(r.player.title)}` : ''}.json`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let frozen = null; // the snapshot taken when the modal opened
let getContext = () => ({ ctl: null });
let modal = null;
let lastFocus = null;

function mailtoHref(r) {
  if (!BUG_REPORT_EMAIL) return '';
  const subject = `${GAME_NAME} bug report ${r.id}`;
  const body = `Report id: ${r.id}\nPlease attach the downloaded file ${reportFilename(r)}.\n`;
  return `mailto:${BUG_REPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function pastHtml() {
  const list = loadArchive().slice().reverse();
  if (!list.length) return '';
  return `<details class="bug__past"><summary>Past reports (${list.length})</summary><ul>${list.map((r) => `<li><span>${esc(new Date(r.timestamp).toLocaleString('en-GB'))} ${esc((r.player && r.player.title) || r.id)}</span> <button type="button" class="linkbtn" data-bug="redownload" data-id="${esc(r.id)}">Download</button></li>`).join('')}</ul></details>`;
}

function formHtml() {
  return `<h2 id="bug-title">Report a problem</h2>
    <p class="bug__lead">This saves a file with the game as it is now, including every hand dealt. Nothing is sent automatically.</p>
    <form id="bug-form" novalidate>
      <label class="field"><span>Title</span><input name="title" type="text" maxlength="120" autocomplete="off"></label>
      <label class="field"><span>What happened</span><textarea name="happened" rows="3" maxlength="2000"></textarea></label>
      <label class="field"><span>What you expected</span><textarea name="expected" rows="2" maxlength="2000"></textarea></label>
      <div class="dialog__buttons"><button type="submit" class="btn btn--primary">Download report</button><button type="button" class="btn" data-bug="close">Cancel</button></div>
    </form>${pastHtml()}`;
}

function doneHtml(r, saved) {
  const mail = mailtoHref(r);
  return `<h2 id="bug-title">${saved ? 'Report saved' : 'Could not save the file'}</h2>
    <p>${saved ? `Saved as <b>${esc(reportFilename(r))}</b>.` : 'Your browser blocked the download. The report was copied to the clipboard if allowed, and kept in past reports.'} Report id: <code>${esc(r.id)}</code></p>
    ${mail ? `<p><a href="${esc(mail)}">Email it</a> (attach the file; the id is in the subject).</p>` : ''}
    <div class="dialog__buttons"><button type="button" class="btn btn--primary" data-bug="close">Close</button></div>${pastHtml()}`;
}

function setBody(html) {
  const box = modal && modal.querySelector('.dialog');
  if (!box) return;
  box.innerHTML = `<button type="button" class="dialog__close" data-bug="close" aria-label="Close">&times;</button>${html}`;
}

export function closeBugModal() {
  try {
    if (modal) modal.remove();
    modal = null;
    frozen = null;
    if (lastFocus && lastFocus.isConnected) lastFocus.focus();
  } catch { /* silent */ }
}

export function openBugModal() {
  try {
    if (modal) return;
    // a report holds every hand, so it is unavailable while the pass-and-play cover is up
    if (document.body.dataset.covered === '1') return;
    lastFocus = document.activeElement;
    frozen = buildReport(getContext(), {}); // frozen now; the player's words are added on submit
    modal = document.createElement('div');
    modal.className = 'overlay overlay--dialog bug';
    modal.setAttribute('data-bug-root', '1');
    modal.innerHTML = '<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="bug-title"></div>';
    document.body.appendChild(modal);
    setBody(formHtml());
    modal.addEventListener('click', (e) => {
      const t = e.target;
      if (t === modal) return closeBugModal();
      const b = t.closest && t.closest('[data-bug]');
      if (!b) return;
      if (b.dataset.bug === 'close') closeBugModal();
      if (b.dataset.bug === 'redownload') {
        const r = loadArchive().find((x) => x.id === b.dataset.id);
        if (r) saveFile(reportFilename(r), JSON.stringify(r, null, 2));
      }
    });
    modal.addEventListener('submit', (e) => {
      e.preventDefault();
      submit(e.target);
    });
    modal.addEventListener('keydown', (e) => {
      // Handled here and stopped, so the game's own Escape/Tab handlers stay out of it.
      if (e.key === 'Escape') { e.stopPropagation(); closeBugModal(); return; }
      if (e.key !== 'Tab') return;
      e.stopPropagation();
      const f = [...modal.querySelectorAll('button, input, textarea, summary, a[href]')].filter((x) => !x.disabled);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (!modal.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    const first = modal.querySelector('input[name=title]');
    if (first) first.focus();
  } catch { /* silent */ }
}

function submit(form) {
  try {
    const snap = frozen || buildReport(getContext(), {});
    const report = {
      ...snap,
      player: {
        title: clip(form.elements.title.value.trim()),
        whatHappened: clip(form.elements.happened.value.trim()),
        whatIExpected: clip(form.elements.expected.value.trim()),
      },
    };
    const text = JSON.stringify(report, null, 2);
    archiveReport(report);
    const saved = saveFile(reportFilename(report), text);
    if (!saved) { try { navigator.clipboard.writeText(text); } catch { /* silent */ } }
    setBody(doneHtml(report, saved));
    const c = modal && modal.querySelector('.btn--primary');
    if (c) c.focus();
  } catch (e) {
    logEvent('error', `bug reporter submit failed: ${e && e.message}`);
  }
}

/**
 * Installs the loggers, the button and the shortcut. `getCtx` is called when the modal opens:
 * () => ({ ctl, screen }). Safe to call once; a second call only replaces getCtx.
 */
export function installBugReporter(getCtx) {
  try {
    if (getCtx) getContext = getCtx;
    installLoggers();
    if (typeof document === 'undefined' || document.getElementById('bug-button')) return;
    const btn = document.createElement('button');
    btn.id = 'bug-button';
    btn.type = 'button';
    btn.className = 'bug-button';
    btn.title = 'Report a problem (Ctrl+Shift+B)';
    btn.setAttribute('aria-label', 'Report a problem');
    btn.textContent = '\u{1F41E}';
    btn.addEventListener('click', openBugModal);
    document.body.appendChild(btn);
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'B' || e.key === 'b')) { e.preventDefault(); openBugModal(); }
    });
  } catch { /* silent */ }
}
