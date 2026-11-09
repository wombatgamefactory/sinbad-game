/**
 * Google Analytics events. Everything sent is anonymous: no names, no free text, no seed.
 * game_end carries one anonymous result summary per finished game: which kind of seat won
 * (human / easy / medium / hard / shared), the winning score and margin, whether the last-hand
 * tiebreak decided it (tiebreak_used), and the best human rank.
 *
 * track() drops any parameter that is not on ALLOWED_PARAMS and any value that is not a finite
 * number or a short token (letters, digits and _ , . + -), so a future edit cannot leak a name or a
 * sentence by accident.
 *
 *   game_start, hand_end, game_end, game_abandoned     one game
 *   stats_viewed, stats_exported                       the local stats screen
 *   rules_opened                                       How to play dialog or rule book link
 *   variant_changed                                    a Playtest rules switch on the setup page
 *
 * Every call is a no-op when gtag is missing (ad blocker, banner refusal, tests), and a failure
 * here never reaches the game. The page loads GA only off localhost (index.html).
 * Sinbad's own anonymous counts are the three NEW parameters `trades`, `sails` and `forced_tens`:
 * on hand_end (a voyage) they are that voyage's totals over all seats; on game_end they are the
 * whole game's totals. Register each as a custom metric in GA (event scope).
 */

import { GAME_SLUG } from '../game-config.js';

export const GAME_NAME = GAME_SLUG;

export const ALLOWED_PARAMS = [
  'game_name', 'player_count', 'human_players', 'bot_players', 'bot_levels', 'rules_code',
  'hand_number', 'hands', 'tricks', 'duration_seconds',
  'winner_seat_type', 'winning_score', 'winning_margin', 'tiebreak_used', 'human_rank',
  // new for Sinbad (counts only): trades laid sideways, cards that did not follow (each sails a ship), strict forced 10s (the 10 was the only island-cargo card held)
  'trades', 'sails', 'forced_tens',
];

export const EVENT_NAMES = [
  'game_start', 'hand_end', 'game_end', 'game_abandoned',
  'stats_viewed', 'stats_exported', 'rules_opened', 'variant_changed',
];

const TOKEN = /^[A-Za-z0-9_,.+-]{1,60}$/;

let game = null; // { startedAt, ended, base, tricks, hands }
let clock = () => Date.now();

/** Tests only. */
export function _setClock(fn) { clock = fn; }
export function _reset() { game = null; }

/** Keeps whitelisted keys with a finite number or a short token as value. */
export function clean(params) {
  const out = {};
  if (!params) return out;
  for (const k of ALLOWED_PARAMS) {
    const v = params[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && TOKEN.test(v)) out[k] = v;
  }
  return out;
}

function send(name, params, extra) {
  try {
    if (typeof window === 'undefined' || typeof window.gtag !== 'function') return;
    window.gtag('event', name, { ...clean(params), ...(extra || {}) });
  } catch {
    // Deliberately silent: analytics is allowed to fail.
  }
}

const seatKind = (s) => (s.type === 'human' ? 'human' : s.type);

function seatCounts(seats) {
  const humans = seats.filter((s) => s.type === 'human').length;
  const levels = seats.filter((s) => s.type !== 'human').map((s) => s.type).sort();
  return { human_players: humans, bot_players: levels.length, bot_levels: levels.length ? levels.join(',') : 'none' };
}

const baseOf = (info) => ({
  game_name: GAME_NAME,
  player_count: info.players,
  ...seatCounts(info.seats || []),
  rules_code: info.rulesCode || 'std',
});
const total = (a) => (Array.isArray(a) ? a.reduce((x, y) => x + (Number.isFinite(y) ? y : 0), 0) : undefined);
const secondsSince = (t) => Math.max(0, Math.round((clock() - t) / 1000));

export function trackGameStart(info) {
  try {
    game = { startedAt: clock(), ended: false, base: baseOf(info), tricks: 0, hands: 0 };
    send('game_start', game.base);
  } catch { /* silent */ }
}

/** Counts completed tricks, so an abandoned game can say how far it got. */
export function trackTrickEnd() {
  try { if (game) game.tricks += 1; } catch { /* silent */ }
}

export function trackHandEnd(info) {
  try {
    if (!game) return;
    game.hands += 1;
    const rec = info.record;
    send('hand_end', {
      ...game.base,
      hand_number: info.event.handNo + 1,
      tricks: rec && Array.isArray(rec.tricks) ? rec.tricks.length : undefined,
      trades: rec ? total(rec.trades) : undefined,
      sails: rec ? total(rec.sails) : undefined,
      forced_tens: rec ? total(rec.forcedTens) : undefined,
      duration_seconds: secondsSince(game.startedAt),
    });
  } catch { /* silent */ }
}

/** The anonymous result summary (see the header). Pure; exported for the tests. */
export function resultSummary(info) {
  const res = info.result;
  const st = info.state;
  const kinds = info.seats.map(seatKind);
  const winnerKinds = new Set(res.winners.map((s) => kinds[s]));
  const humanRanks = res.ranking.filter((r) => kinds[r.seat] === 'human').map((r) => r.rank);
  const tricks = st ? st.measures.tricks : 0;
  return {
    winner_seat_type: res.shared || winnerKinds.size !== 1 ? 'shared' : [...winnerKinds][0],
    winning_score: res.winningScore,
    winning_margin: res.margin,
    tiebreak_used: res.tiebreakUsed ? 'yes' : 'no',
    human_rank: humanRanks.length ? Math.min(...humanRanks) : undefined,
    tricks,
    trades: st ? st.measures.trades : undefined,
    sails: st ? st.measures.sails : undefined,
    forced_tens: st ? st.measures.forcedTens : undefined,
  };
}

export function trackGameEnd(info) {
  try {
    if (!game || game.ended) return;
    game.ended = true;
    send('game_end', {
      ...game.base,
      ...resultSummary(info),
      hands: info.state ? info.state.handLog.length : game.hands,
      duration_seconds: secondsSince(game.startedAt),
    });
  } catch { /* silent */ }
}

export function trackStatsViewed() { send('stats_viewed', { game_name: GAME_NAME }); }
export function trackStatsExported() { send('stats_exported', { game_name: GAME_NAME }); }
export function trackRulesOpened() { send('rules_opened', { game_name: GAME_NAME }); }
export function trackVariantChanged(info) {
  send('variant_changed', { game_name: GAME_NAME, player_count: info && info.players, rules_code: info && info.rulesCode });
}

/**
 * A game that is still running when the player leaves it: either by going back to the setup
 * screen (main.js calls onGameAbandoned) or because the page goes away (pagehide). Fires at
 * most once per game, with the usage parameters only (no result).
 */
export function trackGameAbandoned({ beacon = false } = {}) {
  try {
    if (!game || game.ended) return;
    game.ended = true;
    send('game_abandoned', {
      ...game.base,
      hands: game.hands,
      tricks: game.tricks,
      duration_seconds: secondsSince(game.startedAt),
    }, beacon ? { transport_type: 'beacon' } : null); // lets the hit survive a closing page
  } catch { /* silent */ }
}

/** pagehide (not beforeunload) because it also fires on mobile and in the back/forward cache. */
export function installAbandonTracking() {
  try {
    window.addEventListener('pagehide', () => trackGameAbandoned({ beacon: true }));
  } catch { /* silent */ }
}
