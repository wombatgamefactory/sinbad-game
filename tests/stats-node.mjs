// stats-node.mjs - the local stats store, the recorder, the CSV / JSON export, the summary, the
// stats screen markup, the analytics whitelist and events, and the bug report (all without a
// browser: storage is a fake, `window.gtag` is a recorder).
// Sinbad's own record fields (trades, sails, serpents, final-voyage points), CSV columns, the
// "Trades and serpents" section and the three new analytics parameters are checked below.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure. Run: node tests/stats-node.mjs

import { suite, roundTrip } from './lib.mjs';
import {
  createStatsStore, createRecorder, handRecord, toCsv, toJson, exportFilename, csvCell, gameToRow, CSV_COLUMNS, summarise, seatKind,
  STORE_KEY, MAX_GAMES,
} from '../src/ui/stats-store.js';
import { statsHtml, statsButtonsHtml } from '../src/ui/stats-view.js';
import * as analytics from '../src/ui/analytics.js';
import * as bug from '../src/ui/bug-report.js';
import { createController } from '../src/ui/controller.js';
import { VARIANTS } from '../src/engine/index.js';
import { GAME_SLUG, CONTACT_EMAIL } from '../src/game-config.js';

const { check, done } = suite('stats-node');
const BAD = /undefined|NaN|\[object/;

// ---------- helpers ----------
function fakeStorage(opts = {}) {
  const map = new Map();
  return {
    map,
    getItem: (k) => { if (opts.throwOnGet) throw new Error('blocked'); return map.has(k) ? map.get(k) : null; },
    setItem: (k, v) => { if (opts.throwOnSet) throw new Error('quota'); if (opts.maxLength && v.length > opts.maxLength) throw new Error('quota'); map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

/** A finished game played by bots (or humans standing in as Easy), with the seats as the UI would describe them. */
function finishedGame(seed, seatTypes, rules = {}) {
  const ctl = createController({ seats: seatTypes.map((t) => ({ type: t === 'human' ? 'easy' : t, name: t === 'human' ? 'Mia' : '' })), seed, rules });
  ctl.runBots();
  const seats = seatTypes.map((t) => ({ type: t, name: t === 'human' ? 'Mia' : '' }));
  return { ctl, state: ctl.state, seats, seed };
}

// ---------- recorder and store ----------
{
  const storage = fakeStorage();
  const store = createStatsStore(() => storage);
  let clock = 1_000_000;
  const rec = createRecorder(store, () => clock);
  const g = finishedGame(5, ['human', 'easy', 'medium', 'hard']);
  rec.gameStart({});
  clock += 90_000;
  const r = rec.gameEnd({ state: g.state, seats: g.seats, seed: g.seed });
  check('recorder: a finished game is stored', store.load().games.length === 1 && r.players === 4 && r.hands === 4);
  check('recorder: seats record kind and level; only a human\'s typed name is kept', r.seats[0].type === 'human' && r.seats[0].name === 'Mia' && r.seats[1].type === 'bot' && r.seats[1].level === 'easy' && r.seats[3].level === 'hard' && !('name' in r.seats[1]));
  check('recorder: duration, rules code, seed, winners and totals are kept', r.seconds === 90 && r.rules_code === 'std' && r.seed === '5' && r.winners.length >= 1 && r.totals.length === 4 && r.margin >= 0);
  check('recorder: the record is plain JSON and equals what the store reads back', JSON.stringify(roundTrip(r)) === JSON.stringify(store.load().games[0]));
  check('recorder: one hand breakdown per hand', r.hand_log.length === 4 && r.hand_log.every((h) => h.tricks_won.length === 4 && h.scores.length === 4) && handRecord(g.state.handLog[0]).scores.length === 4);
  const sumA = (a) => a.reduce((x, y) => x + y, 0);
  const hl = r.hand_log;
  check('recorder: each voyage keeps trades, trades won, forced 10s, sails, serpents and islands per seat',
    hl.every((h) => ['tricks_won', 'serpents_taken', 'scores', 'trades', 'trades_won', 'forced_tens', 'discards', 'sails', 'start_island', 'end_island'].every((k) => h[k].length === 4))
    && hl.every((h) => sumA(h.tricks_won) === h.tricks) && hl.every((h, i) => h.voyage === i + 1));
  check('recorder: game totals equal the sum of the voyages and the engine measures',
    r.trades === sumA(hl.flatMap((h) => h.trades)) && r.trades_won === sumA(hl.flatMap((h) => h.trades_won)) && r.sails === sumA(hl.flatMap((h) => h.sails))
    && r.forced_tens === sumA(hl.flatMap((h) => h.forced_tens)) && r.serpents === sumA(hl.flatMap((h) => h.serpents_taken)) && r.trades_won <= r.trades
    && r.per_seat.sails.length === 4 && sumA(r.per_seat.serpents) === r.serpents);
  check('recorder: final-voyage points (the tiebreak figure) are kept and match the last voyage',
    JSON.stringify(r.final_voyage) === JSON.stringify(hl[hl.length - 1].scores) && r.ranking.every((x) => x.last === r.final_voyage[x.seat]) && 'trade_tricks' in r === false);
  check('recorder: an unfinished game records nothing', rec.gameEnd({ state: createController({ seats: [{ type: 'human' }, { type: 'easy' }], seed: 1 }).state, seats: [], seed: 1 }) === null);
  check('store: uses the slug in its key', STORE_KEY === `${GAME_SLUG}-stats-v1`);
}
{
  const storage = fakeStorage();
  const store = createStatsStore(() => storage);
  const g = finishedGame(6, ['easy', 'easy', 'easy']);
  const rec = createRecorder(store);
  for (let i = 0; i < 5; i++) rec.gameEnd({ state: g.state, seats: g.seats, seed: i });
  check('store: appends in order', store.load().games.length === 5);
  check('store: a corrupt value reads as empty', (() => { storage.map.set(STORE_KEY, '{nope'); return store.load().games.length === 0; })());
  check('store: another version reads as empty', (() => { storage.map.set(STORE_KEY, JSON.stringify({ v: 99, games: [1] })); return store.load().games.length === 0; })());
  check('store: junk records are dropped, good ones kept', (() => {
    const good = createRecorder(createStatsStore(() => fakeStorage())).gameEnd({ state: g.state, seats: g.seats, seed: 1 });
    storage.map.set(STORE_KEY, JSON.stringify({ v: 1, games: [null, 5, { seats: 1 }, good] }));
    return store.load().games.length === 1;
  })());
  check('store: clear empties it', store.clear() && store.load().games.length === 0);
  check('store: the cap keeps the newest', MAX_GAMES >= 1000);
}
{
  const g = finishedGame(7, ['easy', 'easy', 'easy']);
  const blocked = createStatsStore(() => { throw new Error('storage blocked'); });
  const none = createStatsStore(() => null);
  const quota = createStatsStore(() => fakeStorage({ throwOnSet: true }));
  const rec = (s) => createRecorder(s).gameEnd({ state: g.state, seats: g.seats, seed: 1 });
  check('store: blocked, absent and full storage never throw; the store just forgets', rec(blocked) !== undefined && rec(none) !== undefined && rec(quota) !== undefined && blocked.load().games.length === 0 && none.load().games.length === 0 && blocked.clear() === false);
  check('store: a store that keeps only small values retries smaller and gives up quietly', createStatsStore(() => fakeStorage({ maxLength: 10 })).addGame({ big: 'x'.repeat(100) }) === false);
}

// ---------- export ----------
{
  const g1 = finishedGame(8, ['human', 'easy', 'easy', 'easy']);
  const g2 = finishedGame(9, ['easy', 'medium', 'hard'], { TIE: 'real' });
  const rec = createRecorder(createStatsStore(() => fakeStorage()));
  const r1 = rec.gameEnd({ state: g1.state, seats: g1.seats, seed: 8 });
  const r2 = rec.gameEnd({ state: g2.state, seats: g2.seats, seed: 9 });
  const csv = toCsv([r1, r2]);
  const lines = csv.trim().split('\n');
  check('csv: a header and a row per game, LF only, same number of fields as columns', lines.length === 3 && !csv.includes('\r') && csv.endsWith('\n') && lines[0].split(',').length === CSV_COLUMNS.length && gameToRow(r1).length === CSV_COLUMNS.length);
  check('csv: one rule column per VARIANTS row and one pair per seat', VARIANTS.every((v) => CSV_COLUMNS.includes(`rule_${v.name.toLowerCase()}`)) && CSV_COLUMNS.includes('seat5_type'));
  check('csv: the Sinbad columns are there and filled', ['trades', 'trades_won', 'forced_tens', 'sails', 'serpents', 'final_voyage_points', 'sails_by_seat'].every((c) => CSV_COLUMNS.includes(c))
    && (() => { const row = gameToRow(r1); const at = (c) => row[CSV_COLUMNS.indexOf(c)]; return at('trades') === r1.trades && at('sails') === r1.sails && at('final_voyage_points') === r1.final_voyage.join(' ') && at('serpents_by_seat').split(' ').length === 4; })());
  check('csv: rows carry the rules code and the seat kinds', lines[1].includes(',std,') && lines[2].includes(',tie-real,') && lines[2].includes(',easy,') && lines[2].includes(',hard,'));
  check('csv: cells with commas and quotes are quoted', csvCell('a,b') === '"a,b"' && csvCell('say "hi"') === '"say ""hi"""' && csvCell(null) === '' && csvCell(3) === '3');
  const json = JSON.parse(toJson({ v: 1, games: [r1] }));
  check('json: names the game and holds the records', json.game === GAME_SLUG && json.games.length === 1 && typeof json.exported === 'string');
  check('export: file names are the slug, the word stats and a local date', new RegExp(`^${GAME_SLUG}-stats-\\d{4}-\\d{2}-\\d{2}\\.csv$`).test(exportFilename('csv')) && exportFilename('json', new Date(2026, 10, 4)) === `${GAME_SLUG}-stats-2026-11-04.json`);
  check('export: file names are kebab-case with no spaces', !/[\sA-Z]/.test(exportFilename('csv')));

  // ---------- summary ----------
  const sum = summarise([r1, r2]);
  check('summary: counts games, seat kinds and wins', sum.total === 2 && sum.byKind.human.seats === 1 && sum.byKind.easy.seats === 4 && sum.byKind.hard.seats === 1);
  check('summary: wins by kind never exceed seats', Object.values(sum.byKind).every((t) => t.wins <= t.seats));
  check('summary: human v bot matchups only count games with both', sum.humanVs.easy.games === 1 && sum.humanVs.hard.games === 0);
  check('summary: split by rules code, standard first', sum.byRules.map((r) => r.code).join() === 'std,tie-real' && summarise([r1, r2], 'tie-real').total === 1 && summarise([r1, r2], 'tie-real').allTotal === 2);
  check('summary: by player count', sum.byPlayers[4].games === 1 && sum.byPlayers[3].games === 1);
  check('summary: seat kind helper', seatKind({ type: 'human' }) === 'human' && seatKind({ type: 'bot', level: 'hard' }) === 'hard');
  const html = statsHtml({ games: [r1, r2] }, 'all');
  const h3 = [...html.matchAll(/<h3>(.*?)<\/h3>/g)].map((m) => m[1]);
  check('stats screen: the sections', ['Win rate by seat type', 'Win rate by seat position', 'Scores by player count', 'Trades and serpents', 'Ties and the tiebreak', 'By rules'].every((s) => h3.includes(s)), h3.join(' | '));
  check('stats screen: Trades and serpents shows the five measures; the tiebreak reads final voyage, then shared',
    ['Trades', 'Trades that won the trick', 'Forced 10s', 'Sails', 'Serpents taken'].every((w) => html.includes(w)) && /most points in the final voyage/.test(html) && /shared/.test(html));
  check('stats screen: no rule words from other games', !/summit|\bmob\b|sheep|chase|descent|climb|brumby|trooper|trump|compare variants/i.test(html));
  check('summary: Sinbad totals add up over the selection', (() => { const x = sum.extra; return x.trades === r1.trades + r2.trades && x.sails === r1.sails + r2.sails && x.serpents === r1.serpents + r2.serpents && x.voyages === r1.hands + r2.hands && x.playerVoyages === r1.hands * 4 + r2.hands * 3 && summarise([r1, r2], 'tie-real').extra.trades === r2.trades; })());
  check('stats screen: both rules codes, a filter, small-sample warnings, no raw values', /Standard rules/.test(html) && /tie-real/.test(html) && /data-action="stats-filter"/.test(html) && /small sample/.test(html) && !BAD.test(html));
  check('stats screen: empty state and an unknown filter fall back', /No games recorded yet/.test(statsHtml({ games: [] })) && /2<\/b> games played/.test(statsHtml({ games: [r1, r2] }, 'nope')));
  check('stats screen: export buttons disabled with no data', /disabled/.test(statsButtonsHtml(false)) && !/disabled/.test(statsButtonsHtml(true)));
}

// ---------- analytics ----------
{
  const calls = [];
  globalThis.window = { gtag: (...a) => calls.push(a), addEventListener() {} };
  let now = 0;
  analytics._setClock(() => now);
  analytics._reset();
  const g = finishedGame(10, ['human', 'easy', 'medium', 'hard']);
  const seats = [{ type: 'human', name: 'Secret Name' }, { type: 'easy', name: '' }, { type: 'medium', name: '' }, { type: 'hard', name: '' }];
  const base = { seed: 10, players: 4, seats, rulesCode: 'std', state: g.state };
  analytics.trackGameStart(base);
  analytics.trackTrickEnd();
  analytics.trackHandEnd({ ...base, event: { handNo: 0 }, record: g.state.handLog[0] });
  now = 125_400;
  analytics.trackGameEnd({ ...base, result: g.state.result });
  analytics.trackGameEnd({ ...base, result: g.state.result }); // once only
  analytics.trackGameAbandoned(); // already ended: nothing
  const names = calls.map((c) => c[1]);
  check('analytics: game_start, hand_end and game_end fired once each; nothing after the end', same(names, ['game_start', 'hand_end', 'game_end']));
  const ge = calls[2][2];
  check('analytics: game_end carries counts, seat kinds and the result summary', ge.game_name === GAME_SLUG && ge.player_count === 4 && ge.human_players === 1 && ge.bot_players === 3 && ge.bot_levels === 'easy,hard,medium' && ge.duration_seconds === 125 && ge.hands === 4 && typeof ge.winner_seat_type === 'string' && /^(yes|no)$/.test(ge.tiebreak_used));
  check('analytics: every parameter is on the whitelist and is a number or a short token', calls.every((c) => Object.entries(c[2]).every(([k, v]) => analytics.ALLOWED_PARAMS.includes(k) && (typeof v === 'number' || /^[A-Za-z0-9_,.+-]{1,60}$/.test(v)))));
  check('analytics: no name, seed or sentence is ever sent', !JSON.stringify(calls).includes('Secret') && !JSON.stringify(calls).includes('"seed"'));
  check('analytics: clean() drops unknown keys, long strings, spaces, objects and non-finite numbers', JSON.stringify(analytics.clean({ player_name: 'x', rules_code: 'a b', game_name: 'x'.repeat(61), hands: NaN, tricks: {}, winning_score: 7, bot_levels: 'easy,hard' })) === '{"bot_levels":"easy,hard","winning_score":7}');
  const he = calls[1][2];
  const hr = g.state.handLog[0];
  const tot = (a) => a.reduce((x, y) => x + y, 0);
  check('analytics: hand_end carries the voyage totals for trades, sails and forced 10s', he.trades === tot(hr.trades) && he.sails === tot(hr.sails) && he.forced_tens === tot(hr.forcedTens) && he.hand_number === 1);
  check('analytics: game_end carries whole-game trades, sails and forced 10s', ge.trades === g.state.measures.trades && ge.sails === g.state.measures.sails && ge.forced_tens === g.state.measures.forcedTens);
  check('analytics: the whitelist adds exactly trades, sails, forced_tens to the shared names and has no trump param', ['trades', 'sails', 'forced_tens'].every((k) => analytics.ALLOWED_PARAMS.includes(k)) && !analytics.ALLOWED_PARAMS.some((k) => /trump/.test(k)) && analytics.ALLOWED_PARAMS.length === 18);
  check('analytics: event names are known', calls.every((c) => analytics.EVENT_NAMES.includes(c[1])));

  calls.length = 0;
  analytics._reset();
  analytics.trackGameStart(base);
  analytics.trackTrickEnd(); analytics.trackTrickEnd();
  now += 40_000;
  analytics.trackGameAbandoned({ beacon: true });
  analytics.trackGameAbandoned();
  const ab = calls.filter((c) => c[1] === 'game_abandoned');
  check('analytics: a game left half way is reported once, with progress and no result', ab.length === 1 && ab[0][2].tricks === 2 && ab[0][2].transport_type === 'beacon' && !('winning_score' in ab[0][2]));
  calls.length = 0;
  analytics.trackStatsViewed(); analytics.trackStatsExported(); analytics.trackRulesOpened(); analytics.trackVariantChanged({ players: 4, rulesCode: 'tie-real' });
  check('analytics: the small events carry the game name (and the rules code for a switch) only', calls.length === 4 && calls.every((c) => c[2].game_name === GAME_SLUG) && same(Object.keys(calls[3][2]).sort(), ['game_name', 'player_count', 'rules_code']));
  globalThis.window = {}; // no gtag at all
  check('analytics: with no gtag every call is a silent no-op', (() => { try { analytics.trackGameStart(base); analytics.trackGameEnd({ ...base, result: g.state.result }); analytics.trackStatsViewed(); return true; } catch { return false; } })());
  delete globalThis.window;
  check('analytics: with no window at all it still does not throw', (() => { try { analytics.trackStatsViewed(); analytics.installAbandonTracking(); return true; } catch { return false; } })());
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ---------- bug report ----------
{
  const ctl = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }], seed: 77 });
  ctl.runBots();
  const before = JSON.stringify(ctl.state);
  bug._resetLogs();
  bug.logAction({ kind: 'play', card: 'spice-1' });
  bug.logEvent('error', 'x'.repeat(5000));
  const rep = bug.buildReport({ ctl, screen: 'game' }, { title: 'T', happened: 'H', expected: 'E' });
  check('bug report: never mutates the live state', JSON.stringify(ctl.state) === before);
  check('bug report: has the state, controller, diagnostics, logs and the player\'s words', rep.schemaVersion === 1 && rep.game.kind === 'game' && rep.game.n === 3 && rep.controller.seed === 77 && Array.isArray(rep.diagnostics.cards) && rep.player.title === 'T' && rep.actionLog.length === 1);
  check('bug report: is JSON-safe and long strings are clipped', JSON.stringify(roundTrip(rep)) === JSON.stringify(rep) && rep.eventLog[0].message.length === 2000);
  {
    // mid-play: the human has moored and holds the lead, so the diagnostics must describe the ladder
    const live = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }], seed: 78 });
    live.runBots();
    live.play(live.legalActions()[0]); // moor
    live.runBots();
    if (live.state.phase === 'play' && live.toAct() === 0 && live.state.trick === null) live.play(live.legalActions()[0]); // lead
    live.runBots();
    const d = bug.buildReport({ ctl: live, screen: 'game' }).diagnostics;
    check('bug report: diagnostics name the island, its cargo, the led cargo, the ladder rung and the block reason of every card',
      d.phase === 'play' && Number.isInteger(d.island) && typeof d.islandCargo === 'string' && typeof d.rulesCode === 'string' && 'ledCargo' in d
      && d.ladder && /^(lead|follow|must-trade|discard)$/.test(d.ladder.rung) && d.ladder.modes.length === d.cards.length && d.cards.every((c) => 'blockReason' in c)
      && (d.ladder.rung !== 'follow' || d.ledCargo !== null), JSON.stringify(d).slice(0, 300));
  }
  check('bug report: the id starts with the slug', rep.id.startsWith(`${GAME_SLUG}-`));
  check('bug report: a section that fails becomes an error object, not a lost report', typeof rep.environment.error === 'string');
  const none = bug.buildReport({ ctl: null });
  check('bug report: works on the landing page (no game)', none.game === null && none.controller === null && none.diagnostics === null);
  check('bug report: the contact address is the public one', bug.BUG_REPORT_EMAIL === CONTACT_EMAIL && CONTACT_EMAIL === 'info@wombatgamefactory.com');
  const store = fakeStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true });
  for (let i = 0; i < bug.ARCHIVE_MAX + 5; i++) bug.archiveReport({ ...rep, id: `r${i}` });
  check('bug report: the archive keeps the newest few', bug.loadArchive().length === bug.ARCHIVE_MAX && bug.loadArchive().at(-1).id === `r${bug.ARCHIVE_MAX + 4}`);
  Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('blocked'); }, configurable: true });
  check('bug report: blocked storage gives an empty archive and a false save, not an error', bug.loadArchive().length === 0 && bug.archiveReport(rep) === false);
  delete globalThis.localStorage;
}

done();
