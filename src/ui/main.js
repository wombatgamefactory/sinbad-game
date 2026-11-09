// main.js - the browser UI: landing/setup page, game screen, bot pacing, playback of what happened,
// pass-and-play cover, end panels, dialogs. All game flow lives in controller.js; the table model
// and its animation frames in board.js; the sentences in text.js; the markup in components.js and
// landing.js; the art in assets.js; bot decisions (in a Web Worker) in bot-driver.js.
//
// ---------------------------------------------------------------------------------------
// HOOKS (stats, analytics, bug reports). Each is called once at the right moment with one info
// object (see sessionInfo()); the call sites below are the only place game events leave this file.
// Each is wrapped by guard() so a failure in a hook can never reach the game. The hooks feed
// stats-store.js (local records), analytics.js (GA4, whitelisted anonymous params) and
// bug-report.js (action log).
//
//   onGameStart(info)      a game has been dealt (new game or Play again)
//   onTrickEnd(info)       a trick has been decided; info.event is the engine's trick-won event
//   onHandEnd(info)        a voyage has ended; info.event is the engine's voyage-ended event and
//                          info.record the state.handLog entry
//   onGameEnd(info)        the game is over; info.result is the engine's game result, and
//                          info.durationMs the time since onGameStart
//   onVariantChange(info)  a Playtest rules switch (or the reset) changed on the setup page:
//                          info.name, info.value, info.players, info.rules, info.rulesCode
//   onRulesOpened(source)  the How to play dialog opened ('dialog') or the rule book link was
//                          followed ('pdf')
//   onGameAbandoned(info)  a game that had started was left before it ended (Quit, Change setup)
//
//   info (sessionInfo): { seed, players, seats: [{ type, name }], names, humanSeats, rules,
//     rulesCode, handNo, startedAt, state } where `state` is the live engine state: read-only.
//
// Dialogs: the DIALOGS table below ('rules' and 'stats').
// logActionEvent() keeps every mooring, card (with its mode), trick, sail and voyage end for a bug
// report. The sail step is animated by animateSails() (Web Animations API, off under reduced motion):
// each ship slides from its old island to the next one while the 'sail' frame is on screen.
// ---------------------------------------------------------------------------------------

import { createController } from './controller.js';
import { botLevels } from '../bots/index.js';
import { describeEvent, getPlayBlockReason, VARIANTS, DEFAULT_RULES } from '../engine/index.js';
import { GAME_NAME } from '../game-config.js';
import { loadManifest, installImageFallback } from './assets.js';
import { createBotDecider } from './bot-driver.js';
import { makeVm } from './viewmodel.js';
import { boardFromState, buildFrames } from './board.js';
import { trickSentence, previewText, handEndText } from './text.js';
import {
  esc, tableHtml, seatsHtml, handBoxHtml, sideHtml, coverHtml, handSummaryHtml, gameEndHtml, endBarHtml,
} from './components.js';
import { statsStore, createRecorder, toCsv, toJson, exportFilename } from './stats-store.js';
import { statsHtml, statsButtonsHtml, download } from './stats-view.js';
import * as analytics from './analytics.js';
import { installBugReporter, logAction, logEvent } from './bug-report.js';
import {
  landingHtml, howToPlayHtml, syncSetupForm, readSetup, DEFAULT_SETUP, uniqueNames, safeCode,
} from './landing.js';

if (/\{\{/.test(document.title)) document.title = GAME_NAME; // before the init tool has filled the page in

// ---------- hooks: local stats, analytics ----------
const guard = (fn) => (arg) => { try { fn(arg); } catch { /* a hook must never break the game */ } };
const recorder = createRecorder(statsStore);

export const onGameStart = guard((info) => { recorder.gameStart(info); analytics.trackGameStart(info); });
export const onTrickEnd = guard((info) => analytics.trackTrickEnd(info));
export const onHandEnd = guard((info) => analytics.trackHandEnd(info));
export const onGameEnd = guard((info) => { recorder.gameEnd(info); analytics.trackGameEnd(info); });
export const onVariantChange = guard((info) => analytics.trackVariantChanged(info));
export const onRulesOpened = guard(() => analytics.trackRulesOpened());
export const onGameAbandoned = guard(() => analytics.trackGameAbandoned());
const onStatsOpened = guard(() => analytics.trackStatsViewed());

// ---------- state ----------
const params = new URLSearchParams(location.search);
const DEFAULT_DELAY = params.has('botdelay') ? Math.max(0, Math.min(5000, Number(params.get('botdelay')) || 0)) : 800;
let botDelay = DEFAULT_DELAY; // ~0.8 s per bot card; every pause in the playback scales with it
let seedCounter = params.has('seed') ? Number(params.get('seed')) || 1 : null;
const SPEEDS = [{ label: 'Normal', ms: DEFAULT_DELAY }, { label: 'Fast', ms: Math.round(DEFAULT_DELAY * 0.4) }, { label: 'Instant', ms: 0 }];
let speedIdx = 0;

const app = document.getElementById('app');
const dialogRoot = document.getElementById('dialog-root');
const live = document.getElementById('live');
const coarse = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;

let ctl = null; // the running session's controller, or null on the landing page
let sid = 0; // session counter
let lastSetup = DEFAULT_SETUP;
let setupMessage = '';
let pump = null; // { stamp, sid, cancelled }: the bot turn being played
let processedEvents = null;
let shownBoard = null; // the table as last shown (equals boardFromState once playback has finished)
let startedAt = 0;
let gameOverFired = false;
let logEntries = [];
const decider = createBotDecider();

const ui = {
  selected: null, // touch screens: the card tapped once
  preview: null, // the card whose hint is on show
  note: '', // refusal text under the hand
  endClosed: false, // "Look at the table" closed the end panel
  wantHandFocus: false,
  dialog: null, // a key of DIALOGS ('rules' | 'stats'), or null
  statsFilter: 'all', // the stats screen's rules_code filter
  opener: null,
  panels: {}, // details open/closed memory
  frame: null, // the playback frame being shown, or null for the live table
  modal: null, // the end-of-hand summary waiting for a click
  cache: { hints: new Map(), reasons: new Map(), board: null },
};

// ---------- playback: walking the events of one action over the table ----------
let queue = [];
let running = false;
let waiter = null;
let modalResolve = null;

function wait(ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); waiter = null; resolve(); };
    const timer = setTimeout(done, ms);
    waiter = { resolve: done };
  });
}
const wake = () => { if (waiter) waiter.resolve(); };

function modalWait(auto) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); modalResolve = null; resolve(); };
    const timer = auto === Infinity ? 0 : setTimeout(done, auto);
    modalResolve = done;
  });
}

function addLog(entry) {
  logEntries.push(entry);
  live.textContent = entry.text;
}

async function runPlayback() {
  if (running) return;
  running = true;
  const mySid = sid;
  while (queue.length && sid === mySid && ctl) {
    const f = queue.shift();
    if (f.log) addLog({ text: f.log, kind: f.logKind || 'info' });
    if (f.modal) addLog({ text: handEndText(f.modal.event, ctl.names), kind: 'hand' });
    if (f.hold > 0 || f.modal) {
      ui.frame = f;
      ui.modal = f.modal || null;
      render();
    }
    if (f.modal) {
      // A human reads the reckoning and clicks on; with only bots playing it moves on by itself.
      await modalWait(ctl.humanSeats.length ? Infinity : Math.max(600, 4500 * (botDelay / 800)));
      ui.modal = null;
    } else if (f.hold > 0 && botDelay > 0) {
      await wait(f.hold * (botDelay / 800));
    }
  }
  if (sid !== mySid || !ctl) { running = false; return; }
  ui.frame = null;
  ui.modal = null;
  // Back to the live table; resync from the state in case anything ever drifted.
  shownBoard = boardFromState(ctl.state, ctl.humanSeats);
  running = false;
  render();
}

function startPlayback(events) {
  const ctx = {
    names: ctl.names,
    describe: describeEvent,
    trickText: trickSentence,
    liveHands: (s) => ctl.state.hands[s],
  };
  const frames = buildFrames(shownBoard, events, ctx);
  if (frames.length) shownBoard = frames[frames.length - 1].board;
  queue.push(...frames);
  if (!running) runPlayback();
}

// ---------- sessions ----------
function freshSeed() {
  if (seedCounter !== null) return seedCounter++;
  return Math.floor(Math.random() * 2147483646) + 1; // the UI is the one place the clock-free page may draw a seed
}

function sessionInfo() {
  return {
    seed: ctl.seed,
    players: ctl.seats.length,
    seats: ctl.seats.map((s) => ({ type: s.type, name: s.name })),
    names: [...ctl.names],
    humanSeats: [...ctl.humanSeats],
    rules: { ...ctl.state.rules },
    rulesCode: ctl.state.rulesCode,
    handNo: ctl.state.handNo,
    startedAt,
    state: ctl.state,
  };
}

function resetPlayback() {
  queue = [];
  if (waiter) waiter.resolve();
  if (modalResolve) modalResolve();
  ui.frame = null;
  ui.modal = null;
}

function endSession() {
  if (ctl && !ctl.isFinished() && ctl.state.trickNo + ctl.state.handNo > 0) onGameAbandoned(sessionInfo());
  if (pump) pump.cancelled = true;
  pump = null;
  decider.cancelAll();
  sid += 1; // stops a running playback loop
  resetPlayback();
  running = false;
  ctl = null;
}

function startSession(setup) {
  endSession();
  const seats = setup.seats.slice(0, setup.players);
  const typed = uniqueNames(seats.map((s) => s.name));
  try {
    ctl = createController({
      seats: seats.map((s, i) => ({ type: s.type, name: typed[i] })),
      seed: freshSeed(),
      rules: { ...setup.rules },
      autoPlayForced: !!setup.autoPlayForced,
    });
  } catch (err) {
    ctl = null;
    setupMessage = err.message;
    renderLanding(setup);
    return false;
  }
  lastSetup = setup;
  setupMessage = '';
  Object.assign(ui, { selected: null, preview: null, note: '', endClosed: false, wantHandFocus: false });
  logEntries = [];
  for (const l of ctl.log) logEntries.push({ text: l.text, kind: l.event.type === 'voyage-started' ? 'hand' : 'info' });
  shownBoard = boardFromState(ctl.state, ctl.humanSeats);
  processedEvents = ctl.lastEvents;
  startedAt = Date.now();
  gameOverFired = false;
  ctl.subscribe(onChange);
  onGameStart(sessionInfo());
  window.scrollTo(0, 0); // the setup page is long: a game must open at its top, not where "Start game" was
  render();
  return true;
}

function onChange() {
  if (!ctl) return;
  if (ctl.lastEvents !== processedEvents) {
    processedEvents = ctl.lastEvents;
    ui.note = '';
    ui.selected = null;
    ui.preview = null;
    fireEventHooks(processedEvents);
    startPlayback(processedEvents);
    return;
  }
  render();
}

function fireEventHooks(events) {
  const info = sessionInfo();
  for (const ev of events) {
    logActionEvent(ev);
    if (ev.type === 'trick-won') onTrickEnd({ ...info, event: ev });
    else if (ev.type === 'voyage-ended') onHandEnd({ ...info, event: ev, record: ctl.state.handLog[ev.handNo] });
    else if (ev.type === 'game-over' && !gameOverFired) {
      gameOverFired = true;
      onGameEnd({ ...info, result: ev, durationMs: Date.now() - startedAt });
    }
  }
}

/** Feeds the bug reporter's action log (cards and results, in order). */
function logActionEvent(ev) {
  try {
    const seatType = (s) => (ctl.seats[s] ? ctl.seats[s].type : null);
    if (ev.type === 'ship-moored') logAction({ kind: 'moor', handNo: ev.handNo, seat: ev.seat, seatType: seatType(ev.seat), island: ev.island, cargo: ev.cargo });
    else if (ev.type === 'card-played') logAction({ kind: 'play', handNo: ev.handNo, trickNo: ev.trickNo, seat: ev.seat, seatType: seatType(ev.seat), card: ev.card, mode: ev.mode, auto: !!ev.auto });
    else if (ev.type === 'sailed') logAction({ kind: 'sailed', handNo: ev.handNo, trickNo: ev.trickNo, seat: ev.seat, from: ev.from, to: ev.to });
    else if (ev.type === 'trick-won') logAction({ kind: 'trick-won', handNo: ev.handNo, trickNo: ev.trickNo, seat: ev.winner, seatType: seatType(ev.winner), card: ev.card });
    else if (ev.type === 'voyage-ended') logAction({ kind: 'voyage-ended', handNo: ev.handNo, endReason: ev.endReason, scores: ev.scores, totals: ev.totals });
  } catch { /* silent */ }
}

// ---------- landing ----------
function renderLanding(setup = lastSetup) {
  endSession();
  document.body.dataset.screen = 'landing';
  setCovered(false);
  app.innerHTML = landingHtml(botLevels(), setup, setupMessage);
  const form = document.getElementById('setup-form');
  if (form) syncSetupForm(form);
  window.scrollTo(0, 0);
}

// ---------- game screen ----------
function buildVm() {
  const board = ui.frame ? ui.frame.board : shownBoard;
  const vm = makeVm({ ctl, ui, board, log: logEntries });
  ui.cache = { hints: vm.hints, reasons: vm.reasons, board };
  return vm;
}

function topbarHtml() {
  return `<div class="topbar"><button type="button" class="linkbtn" data-action="quit">&larr; Setup</button>
    <span class="topbar__title">${esc(GAME_NAME)}</span>
    <span class="topbar__right"><button type="button" class="linkbtn" data-action="speed" title="How fast bots play and tricks are shown">Speed: ${SPEEDS[speedIdx].label}</button><button type="button" class="linkbtn" data-action="open-rules">Rules</button></span></div>`;
}

function gameHtml(vm) {
  const over = vm.state.phase === 'over';
  const showEnd = over && !ui.frame && !ui.endClosed;
  let overlay = '';
  if (ui.modal) overlay = handSummaryHtml(vm, ui.modal);
  else if (showEnd) overlay = gameEndHtml(vm);
  const nonStd = vm.state.rulesCode !== 'std' ? `<p class="rules-flag" role="note">Non-standard rules: ${esc(vm.state.rulesCode)}</p>` : '';
  return `${topbarHtml()}
    <div class="game${over && ui.endClosed ? ' game--ended' : ''}" data-busy="${ui.frame ? 1 : 0}">
      ${over && ui.endClosed && !ui.frame ? endBarHtml(vm) : ''}
      ${nonStd}
      <div class="col col--main">
        ${tableHtml(vm)}
        ${handBoxHtml(vm)}
      </div>
      <div class="col col--side">
        ${seatsHtml(vm)}
        ${sideHtml(vm)}
      </div>
    </div>${overlay}`;
}

function render() {
  if (!ctl) return;
  document.body.dataset.screen = 'game';
  const st = ctl.state;
  const hadOverlay = !!app.querySelector('.overlay, .cover');
  const hadHandFocus = !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.hand, .decision'));

  if (!ui.frame && !ui.modal && ctl.needsHandoff() && st.phase !== 'over') {
    // Pass-and-play: no hand, trick or log stays in the DOM until the next human confirms.
    app.innerHTML = coverHtml({ names: ctl.names }, st.toAct);
    setCovered(true);
    focusOverlay(hadOverlay);
    return;
  }

  setCovered(false);
  const vm = buildVm();
  app.innerHTML = gameHtml(vm);
  refreshPreview();
  focusOverlay(hadOverlay);
  if (hadHandFocus && keyboardUser) ui.wantHandFocus = true;
  if ((hadHandFocus || ui.wantHandFocus) && vm.myTurn && !coarse) {
    const first = app.querySelector('.hand .card.is-legal, .ring button.isle.is-pickable');
    if (first) first.focus({ preventScroll: true });
    ui.wantHandFocus = false;
  }
  document.body.dataset.busy = ui.frame ? '1' : '0';
  flashYouIsle();
  if (ui.frame && ui.frame.kind === 'sail') animateSails(ui.frame.sails);
  if (!ui.frame) pumpBots();
}

/** The pass-and-play cover is up: hands are hidden and the bug button is off (a report would hold every hand). */
function setCovered(on) {
  document.body.dataset.covered = on ? '1' : '0';
  const bug = document.getElementById('bug-button');
  if (bug) { bug.disabled = on; bug.setAttribute('aria-hidden', on ? 'true' : 'false'); }
}

// ---------- the sail step: ships slide one island clockwise ----------
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let lastYouIsle = null; // `${seat}:${island}` of the hand panel's island chip at the last render
/** A short highlight on the hand panel's island chip when the same seat's island changes (off under reduced motion and at botdelay 0). */
function flashYouIsle() {
  const el = app.querySelector('.youisle[data-island]');
  const key = el ? `${el.dataset.seat}:${el.dataset.island}` : null;
  if (el && lastYouIsle && key !== lastYouIsle && lastYouIsle.split(':')[0] === el.dataset.seat && botDelay > 0 && !reducedMotion()) el.classList.add('is-changed');
  lastYouIsle = key;
}

/** Slides each sailing ship's pawn from the island it left to the island it reached (a short arc round the ring). */
function animateSails(sails) {
  if (!sails || !sails.length || botDelay <= 0 || reducedMotion()) return;
  const dur = Math.round(Math.min(750, 750 * (botDelay / 800)));
  if (dur < 120) return;
  const stage = app.querySelector('.ring__stage');
  if (!stage) return;
  const centre = stage.getBoundingClientRect();
  const cx = centre.left + centre.width / 2;
  const cy = centre.top + centre.height / 2;
  for (const s of sails) {
    const pawn = app.querySelector(`.ring .pawn[data-ship-seat="${s.seat}"]`);
    const from = app.querySelector(`.ring__isle[data-island="${s.from}"] .isle__ships`);
    if (!pawn || !from || typeof pawn.animate !== 'function') continue;
    const a = from.getBoundingClientRect();
    const b = pawn.getBoundingClientRect();
    const dx = (a.left + a.width / 2) - (b.left + b.width / 2);
    const dy = (a.top + a.height / 2) - (b.top + b.height / 2);
    // the middle of the path bows outwards, away from the centre of the ring, so the ship goes round, not across
    const mx = (a.left + a.width / 2 + b.left + b.width / 2) / 2 - cx;
    const my = (a.top + a.height / 2 + b.top + b.height / 2) / 2 - cy;
    const len = Math.hypot(mx, my) || 1;
    const bow = 22;
    pawn.classList.add('is-sailing');
    const anim = pawn.animate([
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: `translate(${dx / 2 + (mx / len) * bow}px, ${dy / 2 + (my / len) * bow}px) scale(1.18)`, offset: 0.5 },
      { transform: 'translate(0, 0)' },
    ], { duration: dur, easing: 'ease-in-out' });
    anim.onfinish = () => pawn.classList.remove('is-sailing');
  }
}

function focusOverlay(hadOverlay) {
  if (hadOverlay) return;
  const btn = app.querySelector('.overlay .btn--primary, .cover .btn--primary');
  if (btn) btn.focus({ preventScroll: false });
}

// ---------- hints (hover / focus / tap) ----------
const PREVIEW_HINT = coarse ? 'Tap a card to see what it would do. Tap it again to play it.' : 'Hover or focus a card to see what it would do.';

/** Fills the hint line under the hand without re-rendering the screen. */
function refreshPreview() {
  const text = app.querySelector('#preview');
  if (!text || !ctl) return;
  const { hints, reasons } = ui.cache;
  const card = ui.preview || ui.selected;
  let msg = '';
  if (card && reasons.has(card)) {
    const reason = reasons.get(card);
    if (reason) msg = reason;
    else msg = previewText(hints.get(card), ctl.names);
  } else if (reasons.size) msg = PREVIEW_HINT;
  text.textContent = msg;
  text.classList.toggle('preview--on', !!(card && msg));
  app.querySelectorAll('.hand .card.is-selected').forEach((el) => el.classList.remove('is-selected'));
  if (card && coarse) {
    const el = app.querySelector(`.hand .card[data-card="${card}"]`);
    if (el && ui.selected === card) el.classList.add('is-selected');
  }
}

function setPreview(card) {
  ui.preview = card;
  refreshPreview();
}

// ---------- playing ----------
function handleCard(card) {
  if (!ctl || ui.frame) return;
  const st = ctl.state;
  const seat = st.toAct;
  if (seat === null || !ctl.isHumanTurn() || st.phase !== 'play') return;
  if (ui.cache.reasons.size === 0) return;
  const reason = getPlayBlockReason(st, seat, card);
  if (reason) { ui.selected = null; ui.preview = null; ui.note = reason; logEvent('refused-click', reason); render(); return; }
  if (coarse && ui.selected !== card) { // first tap on a touch screen previews
    ui.selected = card;
    ui.note = '';
    refreshPreview();
    return;
  }
  const res = ctl.play({ type: 'play', card });
  if (!res.ok) { ui.note = res.error; render(); }
}

/** A decision that is not a card (mooring): the action arrives as JSON in data-decision (decisionHtml()). */
function handleDecide(json) {
  if (!ctl || ui.frame) return;
  const st = ctl.state;
  if (st.toAct === null || !ctl.isHumanTurn()) return;
  let action;
  try { action = JSON.parse(json); } catch { return; }
  if (coarse && action.type === 'moor' && ui.selected !== `isle:${action.island}`) { // first tap on a touch screen picks the island
    ui.selected = `isle:${action.island}`;
    render();
    return;
  }
  const res = ctl.play(action);
  if (!res.ok) { ui.note = res.error; render(); }
}

// ---------- bots ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pumpBots() {
  if (!ctl || ui.frame || running || !ctl.isBotTurn()) return;
  let task = ctl.botTask();
  if (pump && pump.sid === sid && pump.stamp === task.stamp && !pump.cancelled) return;
  if (pump) pump.cancelled = true;
  const me = ctl;
  const p = { stamp: task.stamp, sid, cancelled: false };
  pump = p;
  (async () => {
    let pace = sleep(botDelay); // ~0.8 s per bot decision, counted from the start of its turn
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await decider.decide(task);
      document.body.dataset.botMode = decider.mode;
      await pace;
      pace = Promise.resolve();
      if (p.cancelled || ctl !== me) return;
      const out = me.applyBotResult(task, result);
      if (out === 'stale') return;
      if (out) return; // applied: onChange started the playback and will ask for the next turn
      task = me.botTask(); // refused: ask again (the failure cap guarantees this ends)
      if (!task) return;
    }
  })();
}

// ---------- dialogs ----------
/** Dialog kinds: { title, body(): html, wide?, buttons?(): html }. */
const DIALOGS = {
  rules: { title: 'How to play', body: () => howToPlayHtml() },
  stats: { title: 'Stats', body: () => statsBody(), wide: true, buttons: () => statsButtonsHtml(hasStats()) },
};

function renderDialog() {
  const def = ui.dialog ? DIALOGS[ui.dialog] : null;
  if (!def) {
    dialogRoot.innerHTML = '';
    app.inert = false;
    if (ui.opener && ui.opener.isConnected) ui.opener.focus();
    ui.opener = null;
    return;
  }
  dialogRoot.innerHTML = `<div class="overlay overlay--dialog" data-overlay="dialog"><div class="dialog${def.wide ? ' dialog--wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
    <button type="button" class="dialog__close" data-action="close-dialog" aria-label="Close">&times;</button>
    <h2 id="dlg-title">${esc(def.title)}</h2>
    ${def.body()}
    <div class="dialog__buttons">${def.buttons ? def.buttons() : ''}<button type="button" class="btn btn--primary" data-action="close-dialog">Close</button></div>
  </div></div>`;
  app.inert = true;
  const close = dialogRoot.querySelector('.dialog__close');
  if (close) close.focus();
}

function openDialog(kind, opener) {
  ui.dialog = kind;
  ui.opener = opener || null;
  if (kind === 'stats') ui.statsFilter = 'all';
  renderDialog();
  if (kind === 'rules') onRulesOpened('dialog');
  else if (kind === 'stats') onStatsOpened();
}

// ---------- stats screen ----------
function hasStats() {
  try { return statsStore.load().games.length > 0; } catch { return false; }
}

function statsBody() {
  try { return statsHtml(statsStore.load(), ui.statsFilter); } catch { return '<p class="st__empty">The stats could not be shown.</p>'; }
}

function exportStats(format) {
  const data = statsStore.load();
  const ok = format === 'csv'
    ? download(exportFilename('csv'), toCsv(data.games), 'text/csv;charset=utf-8')
    : download(exportFilename('json'), toJson(data), 'application/json');
  if (ok) analytics.trackStatsExported();
}

function closeDialog() {
  ui.dialog = null;
  renderDialog();
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const overlay = e.target.closest && e.target.closest('[data-overlay="dialog"]');
  if (overlay && e.target === overlay) return closeDialog();
  if (ui.frame && !ui.modal && e.target.closest && e.target.closest('.area-centre')) wake(); // click the table to skip a pause
  const el = e.target.closest && e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  switch (action) {
    case 'play': handleCard(el.dataset.card); break;
    case 'decide': handleDecide(el.dataset.decision); break;
    case 'reveal': if (ctl) ctl.reveal(Number(el.dataset.seat)); break;
    case 'continue': if (modalResolve) modalResolve(); break;
    case 'again': startSession(lastSetup); break;
    case 'watch-bots': {
      const form = el.closest('form');
      if (!form) break;
      const setup = readSetup(form);
      setup.seats = setup.seats.map(() => ({ type: 'medium', name: '' })); // every seat a Medium bot: just watch
      setupMessage = '';
      startSession(setup);
      break;
    }
    case 'new': setupMessage = ''; renderLanding(lastSetup); break;
    case 'quit':
      if (ctl && !ctl.isFinished() && ctl.state.trickNo + ctl.state.handNo > 0 && typeof window.confirm === 'function' && !window.confirm('Leave this game and go back to setup? The game in progress will be lost.')) break;
      setupMessage = '';
      renderLanding(lastSetup);
      break;
    case 'review': ui.endClosed = true; render(); break;
    case 'show-end': ui.endClosed = false; render(); break;
    case 'speed':
      speedIdx = (speedIdx + 1) % SPEEDS.length;
      botDelay = SPEEDS[speedIdx].ms;
      wake();
      if (ctl) render();
      break;
    case 'open-rules': openDialog('rules', el); break;
    case 'open-stats': openDialog('stats', el); break;
    case 'export-csv': exportStats('csv'); break;
    case 'export-json': exportStats('json'); break;
    case 'clear-stats':
      if (window.confirm('Delete all saved results from this browser? This cannot be undone.')) { statsStore.clear(); ui.statsFilter = 'all'; renderDialog(); }
      break;
    case 'close-dialog': closeDialog(); break;
    case 'reset-rules': {
      const form = el.closest('form');
      if (form) {
        for (const v of VARIANTS) if (form.elements[`rule-${v.name}`]) form.elements[`rule-${v.name}`].value = DEFAULT_RULES[v.name];
        syncSetupForm(form);
        lastSetup = readSetup(form);
        onVariantChange({ name: null, value: null, players: lastSetup.players, rules: { ...lastSetup.rules }, rulesCode: safeCode(lastSetup) });
      }
      break;
    }
    case 'rulebook': onRulesOpened('pdf'); break; // the link itself opens the rule book
    default: break;
  }
});

app.addEventListener('submit', (e) => {
  if (e.target.id !== 'setup-form') return;
  e.preventDefault();
  setupMessage = '';
  startSession(readSetup(e.target));
});

app.addEventListener('change', (e) => {
  const form = e.target.closest && e.target.closest('#setup-form');
  if (!form) return;
  syncSetupForm(form);
  lastSetup = readSetup(form);
  const name = e.target.name || '';
  if (name.startsWith('rule-')) {
    onVariantChange({ name: name.slice(5), value: e.target.value, players: lastSetup.players, rules: { ...lastSetup.rules }, rulesCode: safeCode(lastSetup) });
  }
});

// The stats screen's rules filter lives in the dialog, outside #app.
dialogRoot.addEventListener('change', (e) => {
  if (!e.target.matches || !e.target.matches('[data-action="stats-filter"]')) return;
  ui.statsFilter = e.target.value;
  renderDialog();
  const sel = dialogRoot.querySelector('[data-action="stats-filter"]');
  if (sel) sel.focus();
});

// Remember which side panels the player opened or closed (a re-render must not undo it).
app.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d && d.dataset && d.dataset.panel) ui.panels[d.dataset.panel] = d.open;
}, true);

// Hints: pointer hover (mouse/pen only; touch uses tap-to-select) and keyboard focus.
app.addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch') return;
  const card = e.target.closest && e.target.closest('.hand .card[data-card]');
  if (card && card.dataset.card !== ui.preview) setPreview(card.dataset.card);
});
app.addEventListener('pointerout', (e) => {
  if (e.pointerType === 'touch') return;
  const card = e.target.closest && e.target.closest('.hand .card[data-card]');
  if (!card) return;
  const to = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.hand .card[data-card]');
  if (!to) setPreview(null);
});
app.addEventListener('focusin', (e) => {
  const card = e.target.closest && e.target.closest('.hand .card[data-card]');
  if (!card) ui.wantHandFocus = false;
  if (card) setPreview(card.dataset.card);
});
app.addEventListener('focusout', (e) => {
  const card = e.target.closest && e.target.closest('.hand .card[data-card]');
  const to = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.hand .card[data-card]');
  if (card && !to) setPreview(null);
});

// True while the last input was the keyboard (so a re-render may hand focus back to the hand).
let keyboardUser = false;
document.addEventListener('pointerdown', () => { keyboardUser = false; ui.wantHandFocus = false; }, true);
document.addEventListener('keydown', (e) => {
  keyboardUser = true;
  if (e.key === 'Escape' && ui.dialog) return closeDialog();
  const isle = e.target.closest && e.target.closest('.ring button.isle');
  if (isle && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
    // mooring: the arrows walk the islands in sailing order (right / down = clockwise)
    const all = [...app.querySelectorAll('.ring button.isle')];
    const i = all.indexOf(isle);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + step + all.length) % all.length;
    e.preventDefault();
    all[j].focus();
    return;
  }
  if (/^[1-8]$/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey && !ui.dialog && !(e.target.matches && e.target.matches('input, textarea, select'))) {
    const target = app.querySelector(`.ring button.isle[data-island-btn="${Number(e.key) - 1}"]`); // keys 1 to 8 pick up an island to moor at
    if (target) { e.preventDefault(); target.focus(); return; }
  }
  const card = e.target.closest && e.target.closest('.hand .card[data-card]');
  if (card && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    const all = [...app.querySelectorAll('.hand .card[data-card]')];
    const i = all.indexOf(card);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
    if (all[j]) { e.preventDefault(); all[j].focus(); }
    return;
  }
  // Keep Tab inside whichever modal is open.
  if (e.key === 'Tab') {
    const modal = dialogRoot.querySelector('.dialog') || app.querySelector('.overlay .end, .cover');
    if (!modal) return;
    const f = [...modal.querySelectorAll('button, a[href], input, select')].filter((x) => !x.disabled);
    if (!f.length) return;
    const first = f[0];
    const lastEl = f[f.length - 1];
    if (!modal.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
  }
});

// ---------- start ----------
analytics.installAbandonTracking();
installBugReporter(() => ({ ctl, screen: document.body.dataset.screen || null }));
installImageFallback();
loadManifest().then(() => {
  document.body.dataset.ready = '1';
  renderLanding(DEFAULT_SETUP);
});
