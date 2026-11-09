// stats-browser.mjs - the stats screen, exports, analytics events and the bug reporter in the
// real UI (headless Chromium): two quick all-bot games (one under a variant) are played, then the
// stats screen split by rules_code, CSV/JSON downloads, gtag events (read back from dataLayer, with
// the third-party scripts blocked), blocked localStorage, the pass-and-play cover and the
// bug-report download are checked.
// Needs Playwright (see tests/browser-lib.mjs); prints SKIPPED without it (exit 0), or exits 1
// with --require. Run: node tests/stats-browser.mjs [--require]
// Sinbad's own stored fields (trades, sails, serpents, final-voyage points) and the three new analytics
// parameters (trades, sails, forced_tens) are checked in the first block and the analytics checks.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from './lib.mjs';
import { requireChromium, serveRepo } from './browser-lib.mjs';
import { ALLOWED_PARAMS, EVENT_NAMES } from '../src/ui/analytics.js';
import { GAME_SLUG } from '../src/game-config.js';
import { VARIANTS } from '../src/engine/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { check, done } = suite('stats-browser');
const STORE = `${GAME_SLUG}-stats-v1`;
const BUGS = `${GAME_SLUG}-bugreports-v1`;

const chromium = await requireChromium('stats-browser');
const { base: BASE, close } = await serveRepo(ROOT);

const browser = await chromium.launch();
const pageErrors = [];
// index.html defines the real gtag (it pushes onto window.dataLayer), which would overwrite any stub,
// so the events are read back from dataLayer. The third-party scripts (consent banner, GA) are blocked.
const events = (page) => page.evaluate(() => (window.dataLayer || []).map((a) => Array.from(a)).filter((a) => a[0] === 'event'));

async function newPage(init) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  if (init) await ctx.addInitScript(init);
  await ctx.route(/cdn-cookieyes\.com|googletagmanager\.com|google-analytics\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push(`console: ${m.text()}`); });
  return page;
}

/** Opens the setup page and starts a game. types: seat types; rules: { NAME: value }. */
async function start(page, { players = 4, types = ['easy', 'easy', 'easy', 'easy', 'easy'], rules = {}, seed = 31, reload = true } = {}) {
  if (reload) await page.goto(`${BASE}?botdelay=0&seed=${seed}`);
  await page.waitForSelector('#setup-form');
  await page.check(`input[name=players][value="${players}"]`);
  for (let i = 0; i < players; i++) await page.selectOption(`select[name=type${i}]`, types[i]);
  if (Object.keys(rules).length) {
    await page.evaluate(() => { document.getElementById('rules-panel').open = true; });
    for (const [k, v] of Object.entries(rules)) await page.selectOption(`select[name="rule-${k}"]`, v);
  }
  await page.click('#start');
}

async function finish(page) { await page.waitForSelector('.end--game', { timeout: 90000 }); }

async function openStats(page, from) {
  await page.click(`${from} [data-action=open-stats]`);
  await page.waitForSelector('.dialog .st');
}

const tryClick = (loc) => loc.click({ timeout: 5000 }).then(() => true, () => false);

/** A few human decisions (cards, hand summaries) so the game has progress worth abandoning or reporting. */
async function playSome(page, count) {
  let played = 0;
  for (let guard = 0; guard < 600 && played < count; guard++) {
    if (await page.locator('#continue').count()) { await tryClick(page.locator('#continue')); continue; }
    const moor = page.locator('.ring button.isle.is-pickable');
    if (await moor.count()) { await tryClick(moor.first()); continue; }
    const legal = page.locator('.hand .card.is-legal');
    if (await legal.count()) { if (await tryClick(legal.first())) { played++; await page.waitForTimeout(60); } } else await page.waitForTimeout(40);
  }
  return played;
}

const TRUMP = VARIANTS.find((v) => v.name === 'TIE'); // the switch this suite flips 
const TRUMP_ON = TRUMP.values.find((x) => x !== TRUMP.default);
const CODE2 = `${TRUMP.code}-${TRUMP_ON}`;

// ---------- empty state, then two games (one under a variant) ----------
{
  const page = await newPage();
  await page.goto(`${BASE}?botdelay=0&seed=31`);
  await page.waitForSelector('#setup-form');
  check('landing: a Stats link is in the top nav', (await page.locator('#topnav-links [data-action=open-stats]').count()) === 1);
  await openStats(page, '.landing');
  check('empty: shows the empty state', /No games recorded yet/.test(await page.textContent('.dialog .st')));
  check('empty: export buttons disabled', await page.$eval('[data-action=export-csv]', (b) => b.disabled));
  await page.keyboard.press('Escape');

  await start(page, { players: 4, reload: false });
  await finish(page);
  check('end screen: a Stats button is among the end buttons', (await page.locator('#end-buttons [data-action=open-stats]').count()) === 1);
  await page.click('.end [data-action=new]');
  await page.waitForSelector('#setup-form');
  await start(page, { players: 3, rules: { [TRUMP.name]: TRUMP_ON }, reload: false });
  await finish(page);
  await openStats(page, '.end');
  const lead = await page.textContent('.dialog .st__lead');
  check('stats from the end screen: 2 games played', /^\s*2\s+games played/.test(lead), lead);
  const codes = await page.$$eval('.st__table tbody th', (ths) => ths.map((t) => t.textContent.trim()));
  check('stats: both rules_codes listed in the by-rules table', codes.includes('Standard rules') && codes.includes(CODE2), codes.join(' | '));
  const sections = await page.$$eval('.st h3', (hs) => hs.map((h) => h.textContent));
  check('stats: all sections present', ['Win rate by seat type', 'Win rate by seat position', 'Scores by player count', 'Trades and serpents', 'Ties and the tiebreak', 'By rules'].every((s) => sections.includes(s)), sections.join(' | '));
  check('stats: scores by player count has 3 and 4 players', (await page.textContent('.dialog')).includes('3 players') && (await page.textContent('.dialog')).includes('4 players'));
  check('stats: small sample flagged', (await page.locator('.st__small').count()) > 0);
  await page.selectOption('[data-action=stats-filter]', CODE2);
  check('stats: filtering by rules_code shows just that game', new RegExp(`^\\s*1\\s+game played under ${CODE2.replace('+', '\\+')}`).test(await page.textContent('.dialog .st__lead')));
  await page.selectOption('[data-action=stats-filter]', 'all');
  check('stats: filter back to all', /^\s*2\s+games played/.test(await page.textContent('.dialog .st__lead')));

  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).games, STORE);
  check('store: two records, one std and one with the variant', stored.length === 2 && stored[0].rules_code === 'std' && stored[1].rules_code === CODE2 && stored[1].rules[TRUMP.name] === TRUMP_ON && stored[1].players === 3 && stored[0].players === 4);
  check('store: records carry the voyage breakdown and trick counts', stored.every((g) => g.hand_log.length === g.hands && g.hands === ({ 2: 4, 3: 3, 4: 4, 5: 5 })[g.players] && Number.isInteger(g.tricks) && Number.isInteger(g.trades) && Number.isInteger(g.sails) && Number.isInteger(g.serpents) && g.final_voyage.length === g.players));

  check('store: trades won never exceed trades, serpents add up, final-voyage points match the ranking', stored.every((g) => g.trades_won <= g.trades && g.serpents === g.hand_log.reduce((a, h) => a + h.serpents_taken.reduce((x, y) => x + y, 0), 0) && g.ranking.every((r) => r.last === g.final_voyage[r.seat]) && g.hand_log.every((h) => h.sails.length === g.players && h.start_island.length === g.players)));
  const statsText = await page.textContent('.dialog .st');
  check('stats: Trades and serpents section lists the measures', ['Trades that won the trick', 'Forced 10s', 'Serpents taken', 'Sails'].every((w) => statsText.includes(w)));
  check('stats: tiebreak wording is final voyage then shared', /most points in the final voyage/.test(statsText));
  check('stats: no rule words from other games on screen', !/summit|\bmob\b|sheep|chase|descent|climb|brumby|trooper|trump|compare variants/i.test(statsText));

  // exports
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-csv]')]);
  check('export: csv filename', new RegExp(`^${GAME_SLUG}-stats-\\d{4}-\\d{2}-\\d{2}\\.csv$`).test(csvDl.suggestedFilename()), csvDl.suggestedFilename());
  const csvText = fs.readFileSync(await csvDl.path(), 'utf8');
  const csv = csvText.trim().split('\n');
  check('export: csv has a header and one row per game, LF only', csv.length === 3 && csv[0].startsWith('date,id,seed,players,rules_code') && !csvText.includes('\r'), String(csv.length));
  check('export: csv has the Sinbad columns', ['trades', 'trades_won', 'forced_tens', 'sails', 'serpents', 'final_voyage_points'].every((c) => csv[0].split(',').includes(c)));
  check('export: csv rows carry the rules codes', csv[1].includes(',std,') && csv[2].includes(`,${CODE2},`));
  const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-json]')]);
  const json = JSON.parse(fs.readFileSync(await jsonDl.path(), 'utf8'));
  check('export: json is valid and holds both records, identical to the store', json.games.length === 2 && JSON.stringify(json.games) === JSON.stringify(stored) && /\.json$/.test(jsonDl.suggestedFilename()) && json.game === GAME_SLUG);
  await page.keyboard.press('Escape');

  // analytics: setup-page events, then everything seen so far
  await page.click('.end [data-action=new]');
  await page.waitForSelector('#setup-form');
  await page.evaluate(() => { document.getElementById('rules-panel').open = true; });
  await page.selectOption(`select[name="rule-${TRUMP.name}"]`, TRUMP_ON);
  await page.click('[data-action=reset-rules]');
  await page.click('.landing [data-action=open-rules]');
  await page.keyboard.press('Escape');
  const calls = await events(page);
  const names = calls.map((c) => c[1]);
  for (const n of ['game_start', 'hand_end', 'game_end', 'stats_viewed', 'stats_exported', 'rules_opened', 'variant_changed']) check(`analytics: ${n} fired in the page`, names.includes(n));
  check('analytics: two games started, two ended, hands counted', names.filter((n) => n === 'game_start').length === 2 && names.filter((n) => n === 'game_end').length === 2 && names.filter((n) => n === 'hand_end').length === 7, `${names.filter((n) => n === 'hand_end').length}`);
  check('analytics: every event name is known', names.every((n) => EVENT_NAMES.includes(n)));
  const keys = new Set(calls.flatMap((c) => Object.keys(c[2] || {})));
  check('analytics: page params within the whitelist', [...keys].every((k) => ALLOWED_PARAMS.includes(k)), [...keys].join(','));
  check('analytics: values are numbers or short tokens', calls.every((c) => Object.values(c[2] || {}).every((v) => typeof v === 'number' || /^[A-Za-z0-9_,.+-]{1,60}$/.test(v))));
  check('analytics: stats_exported fired for csv and json', names.filter((n) => n === 'stats_exported').length === 2);
  const ge = calls.filter((c) => c[1] === 'game_end').map((c) => c[2]);
  check('analytics: game_end carries the result summary, rules_code and counts', ge.length === 2 && ge[0].rules_code === 'std' && ge[1].rules_code === CODE2 && ge[0].player_count === 4 && ge[0].hands === 4 && ge[1].hands === 3
    && ge.every((g) => g.game_name === GAME_SLUG && Number.isInteger(g.winning_score) && Number.isInteger(g.winning_margin) && /^(easy|shared)$/.test(g.winner_seat_type) && /^(yes|no)$/.test(g.tiebreak_used) && g.human_players === 0 && g.human_rank === undefined && g.bot_levels.startsWith('easy')), JSON.stringify(ge));
  const he = calls.filter((c) => c[1] === 'hand_end').map((c) => c[2]);
  check('analytics: hand_end carries the voyage trades, sails and forced 10s; game_end the game totals', he.length === 7 && he.every((h) => Number.isInteger(h.trades) && Number.isInteger(h.sails) && Number.isInteger(h.forced_tens))
    && ge[0].trades === stored[0].trades && ge[0].sails === stored[0].sails && ge[0].forced_tens === stored[0].forced_tens && ge[1].trades === stored[1].trades, JSON.stringify(ge));
  check('analytics: game_end matches the stored record', ge[0].winning_score === stored[0].winning_score && ge[0].winning_margin === stored[0].margin && ge[1].winning_score === stored[1].winning_score && ge[0].tricks === stored[0].tricks);
  const ve = calls.filter((c) => c[1] === 'variant_changed').map((c) => c[2]);
  check('analytics: variant_changed for the switch and for the reset', ve.length >= 2 && ve.some((v) => v.rules_code === CODE2) && ve[ve.length - 1].rules_code === 'std' && ve.every((v) => Object.keys(v).sort().join() === 'game_name,player_count,rules_code'), JSON.stringify(ve));
  check('analytics: nothing sent says who won by name', !JSON.stringify(calls).match(/bot 1|Player|You/));

  // the clear button, with a confirm
  await openStats(page, '.landing');
  page.once('dialog', (d) => d.dismiss());
  await page.click('[data-action=clear-stats]');
  check('clear: dismissing the confirm keeps the data', (await page.locator('.dialog .st__table').count()) > 0);
  page.once('dialog', (d) => d.accept());
  await page.click('[data-action=clear-stats]');
  await page.waitForSelector('.st__empty');
  check('clear: accepting empties the store', (await page.evaluate((k) => localStorage.getItem(k), STORE)) === null);
  await page.close();
}

// ---------- human game: bug reporter, abandonment ----------
{
  const page = await newPage();
  await start(page, { players: 4, types: ['human', 'easy', 'easy', 'easy'], seed: 41 });
  check('bug: button on body, on the game screen', (await page.locator('body > #bug-button').count()) === 1);
  const played = await playSome(page, 5);
  check('bug: human played some decisions', played >= 5, String(played));
  check('bug: button still there after re-renders', (await page.locator('body > #bug-button').count()) === 1);
  check('bug: button visible while a hand is on show', await page.isVisible('#bug-button'));
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('#bug-form');
  await page.fill('#bug-form [name=title]', 'Card would not play');
  await page.fill('#bug-form [name=happened]', 'clicked and nothing');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  const rep = JSON.parse(text);
  check('bug: file name from id and title', new RegExp(`^${GAME_SLUG}-\\d{8}-\\d{6}-[a-z0-9]+-card-would-not-play\\.json$`).test(dl.suggestedFilename()), dl.suggestedFilename());
  check('bug: valid JSON that round-trips', JSON.stringify(JSON.parse(JSON.stringify(rep))) === JSON.stringify(rep) && text.trim().startsWith('{'));
  check('bug: report has state, diagnostics, controller and logs', rep.schemaVersion === 1 && rep.game && rep.game.kind === 'game' && rep.game.n === 4 && rep.diagnostics && Array.isArray(rep.diagnostics.cards) && Array.isArray(rep.diagnostics.legalActions) && rep.controller.seed === 41 && rep.player.title === 'Card would not play' && rep.player.whatHappened === 'clicked and nothing');
  check('bug: action log covers human and bot plays', rep.actionLog.length >= 8 && new Set(rep.actionLog.map((a) => a.seatType)).size >= 2 && rep.actionLog.some((a) => a.kind === 'play') && rep.actionLog.some((a) => a.kind === 'trick-won'));
  check('bug: mailto link shown with the contact address', (await page.locator('.bug a[href^="mailto:info@wombatgamefactory.com?"]').count()) === 1);
  const archived = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), BUGS);
  check('bug: a copy is archived locally and equals the download', archived.length === 1 && JSON.stringify(archived[0]) === JSON.stringify(rep));
  await page.click('.bug .btn--primary');
  check('bug: modal closes', (await page.locator('.bug').count()) === 0);
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('.bug__past');
  await page.click('.bug__past summary');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('.bug__past [data-bug=redownload]')]);
  check('bug: past report re-downloads identically', JSON.stringify(JSON.parse(fs.readFileSync(await dl2.path(), 'utf8'))) === JSON.stringify(rep));
  await page.keyboard.press('Escape');
  check('bug: Escape closes the modal', (await page.locator('.bug').count()) === 0);

  // leaving a running game through Setup counts as abandoning it (once)
  const before = (await events(page)).filter((c) => c[1] === 'game_abandoned').length;
  if (await page.locator('#continue').count()) await page.click('#continue'); // a hand summary may be up
  page.once('dialog', (d) => d.accept());
  await page.click('[data-action=quit]');
  await page.waitForSelector('#setup-form');
  const abandoned = (await events(page)).filter((c) => c[1] === 'game_abandoned');
  check('analytics: game_abandoned fires once when leaving a running game', before === 0 && abandoned.length === 1, `${before} -> ${abandoned.length}`);
  const ab = abandoned[0] ? abandoned[0][2] : {};
  check('analytics: game_abandoned carries usage and progress, not results', Object.keys(ab).every((k) => ALLOWED_PARAMS.includes(k) && !/winn|rank|tiebreak|trump/.test(k)) && ab.tricks >= 1 && ab.hands >= 0 && ab.human_players === 1 && ab.bot_players === 3 && ab.player_count === 4, JSON.stringify(ab));
  check('store: an abandoned game is not recorded', (await page.evaluate((k) => localStorage.getItem(k), STORE)) === null);
  await page.close();
}

// ---------- pass-and-play: no bug report while the cover is up ----------
{
  const page = await newPage();
  await start(page, { players: 3, types: ['human', 'human', 'easy'], seed: 61 });
  await page.waitForSelector('.cover', { timeout: 30000 });
  check('cover: body is marked covered', (await page.getAttribute('body', 'data-covered')) === '1');
  check('cover: the bug button is not available', !(await page.isVisible('#bug-button')));
  await page.keyboard.press('Control+Shift+B');
  await page.waitForTimeout(200);
  check('cover: Ctrl+Shift+B opens nothing (no hands in a report)', (await page.locator('.bug').count()) === 0);
  await page.click('.cover .btn--primary');
  await page.waitForSelector('.hand .card');
  check('cover: after revealing, the button is back and the shortcut works', (await page.isVisible('#bug-button')) && (await (async () => { await page.keyboard.press('Control+Shift+B'); return page.waitForSelector('#bug-form', { timeout: 3000 }).then(() => true, () => false); })()));
  await page.keyboard.press('Escape');
  await page.close();
}

// ---------- localStorage blocked: the game and the screens still work ----------
{
  const page = await newPage(() => {
    const boom = () => { throw new Error('storage blocked'); };
    Object.defineProperty(window, 'localStorage', { get: boom, configurable: true });
  });
  await start(page, { players: 3, seed: 51 });
  await finish(page);
  check('blocked storage: game reached the end panel', (await page.locator('.end--game').count()) === 1);
  await openStats(page, '.end');
  check('blocked storage: stats screen shows the empty state', /No games recorded yet/.test(await page.textContent('.dialog .st')));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('#bug-form');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  check('blocked storage: bug report still downloads', JSON.parse(fs.readFileSync(await dl.path(), 'utf8')).schemaVersion === 1);
  await page.close();
}

// ---------- no gtag at all ----------
{
  const page = await newPage(() => { document.addEventListener('DOMContentLoaded', () => { window.gtag = undefined; }); });
  await start(page, { players: 3, seed: 52 });
  await finish(page);
  check('no gtag: game completes', (await page.locator('.end--game').count()) === 1);
  await openStats(page, '.end');
  check('no gtag: the game is still recorded locally', /^\s*1\s+game played/.test(await page.textContent('.dialog .st__lead')));
  await page.close();
}

check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
close();
done();
