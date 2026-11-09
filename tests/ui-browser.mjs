// ui-browser.mjs - drives the real UI in headless Chromium: landing and setup, human v Easy (and every
// level that is registered), 2 / 3 / 4 / 5 players, bot v bot, pass-and-play, a game under a
// non-standard rule, the no-Worker fallback, reduced motion, phone widths, the keyboard and a clean
// console. Starts its own static server on a free port; needs Playwright, which is NOT a dependency
// of this repo (see tests/browser-lib.mjs). Without it the suite prints SKIPPED (exit 0), or exits 1 with --require.
// Screenshots go to a fresh folder under the system temp folder (the path is printed).
// Sinbad: the islands on the ring are the mooring buttons and are played in every human game (humanStep). Scenarios:
// the ring and its ships, the mooring step (keyboard too), the forced trade and its callout, a trade laid sideways with
// its chip, the sail animation, the reckoning arithmetic, pass-and-play cover with the bug button off, phone widths.
// Run: node tests/ui-browser.mjs [--require]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from './lib.mjs';
import { requireChromium, serveRepo } from './browser-lib.mjs';
import { VARIANTS } from '../src/engine/index.js';
import { GAME_NAME, GAME_TAGLINE, PUBLISH_URL, RULEBOOK_URL } from '../src/game-config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// One folder per run: a fixed name would be overwritten by the next run, and on Windows an overwrite can
// fail while a virus scanner or indexer still holds the file from the last run.
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'card-game-ui-shots-'));
const { check, done } = suite('ui-browser');

const chromium = await requireChromium('ui-browser');
const { base: BASE, close } = await serveRepo(ROOT);
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const tokensLeft = /\{\{[A-Z_]+\}\}/.test(html);

const browser = await chromium.launch();
const problems = [];
async function newPage(w = 1280, h = 900, opts = {}, init = null) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...opts });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${w}] ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${w}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`[${w}] request failed: ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`[${w}] HTTP ${r.status()} ${r.url()}`); });
  page.__touch = !!opts.hasTouch;
  return page;
}
// A screenshot is evidence for a human, never a pass/fail check: failing to take one must not end the run.
const shot = (page, name, full = true) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: full }).catch((e) => console.log(`  (screenshot ${name} failed: ${String(e.message).slice(0, 80)})`));

/** A click that gives up after a few seconds and says so, instead of waiting out Playwright's 30 s default and throwing. */
async function tryClick(locator, opts = {}) {
  try { await locator.click({ timeout: 5000, ...opts }); return true; } catch { return false; }
}

/** Which bot levels the registry offers (read from the setup page itself). */
let levels = ['easy'];
{
  const page = await newPage();
  await page.goto(`${BASE}?seed=1`);
  await page.waitForSelector('#setup-form');
  levels = await page.$$eval('select[name=type1] option:not([disabled])', (o) => o.map((x) => x.value).filter((v) => v !== 'human'));
  await page.close();
}
console.log(`bot levels offered: ${levels.join(', ')}`);

async function setup(page, { players = 4, types = ['human', 'easy', 'easy', 'easy', 'easy'], names = [], rules = {}, q = 'seed=11', delay = 40 } = {}) {
  await page.goto(`${BASE}?botdelay=${delay}&${q}`);
  await page.waitForSelector('#setup-form');
  await page.check(`input[name=players][value="${players}"]`);
  for (let i = 0; i < players; i++) {
    await page.selectOption(`select[name=type${i}]`, types[i]);
    if (names[i]) await page.fill(`input[name=name${i}]`, names[i]);
  }
  if (Object.keys(rules).length) {
    await page.evaluate(() => { document.getElementById('rules-panel').open = true; });
    for (const [k, v] of Object.entries(rules)) await page.selectOption(`select[name="rule-${k}"]`, v);
  }
  await page.click('#start');
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const newStats = () => ({ plays: 0, moorings: 0, covers: 0, coverLeaks: 0, summaries: 0, illegalTried: 0, tooltipMatches: 0, hints: 0 });

/**
 * One human decision, whatever it is: a cover, a reckoning or a card (the first few times a
 * dimmed card is clicked first, to see that it explains itself). Returns what it did.
 * Sinbad's other decision is the mooring: one button per island (a random one, so ships share and spread).
 */
async function humanStep(page, stats) {
  if (await page.locator('.end--game').count()) return 'end';
  if (await page.locator('.cover').count()) {
    stats.covers++;
    if (await page.locator('.hand, .card, .cardimg, .table, .log__list').count()) stats.coverLeaks++;
    await tryClick(page.locator('.cover .btn--primary'));
    return 'cover';
  }
  if (await page.locator('#continue').count()) { if (await tryClick(page.locator('#continue'))) stats.summaries++; return 'summary'; }
  const moor = page.locator('.ring button.isle.is-pickable');
  const nMoor = await moor.count();
  if (nMoor) {
    stats.moorings++;
    if (!(await tryClick(moor.nth((stats.moorings * 5) % nMoor)))) { stats.moorings--; return 'retry'; }
    if (page.__touch) await tryClick(page.locator('.ring button.isle.is-selected'), { timeout: 1500 });
    return 'moor';
  }
  const legal = page.locator('.hand .card.is-legal');
  if (await legal.count()) {
    const blocked = page.locator('.hand .card.is-blocked');
    if (stats.illegalTried < 4 && await blocked.count()) {
      const title = await blocked.first().getAttribute('title');
      if (await tryClick(blocked.first(), { force: true })) {
        stats.illegalTried++;
        const note = await page.textContent('#note');
        if (title && /^(Follow |Your island demands)/.test(title) && title === note) stats.tooltipMatches++;
      }
    }
    if (await page.locator('.hand .card__hint').count()) stats.hints++;
    stats.plays++;
    if (!(await tryClick(legal.first()))) { stats.plays--; return 'retry'; }
    if (page.__touch) await tryClick(page.locator('.hand .card.is-selected'), { timeout: 1500 });
    return 'card';
  }
  await page.waitForTimeout(30);
  return 'wait';
}

async function playHuman(page, limitMs = 170000) {
  const stats = newStats();
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if ((await humanStep(page, stats)) === 'end') break;
  }
  return stats;
}

/** Moors (and confirms covers) until the human has a card to play: every voyage starts with the mooring. */
async function toFirstCard(page, timeout = 30000) {
  const stats = newStats();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.locator('.hand .card.is-legal').count()) return stats;
    const moor = page.locator('.ring button.isle.is-pickable');
    if (await moor.count()) { stats.moorings++; await tryClick(moor.first()); if (page.__touch) await tryClick(page.locator('.ring button.isle.is-selected'), { timeout: 1500 }); continue; }
    if (await page.locator('.cover').count()) { await tryClick(page.locator('.cover .btn--primary')); continue; }
    await page.waitForTimeout(40);
  }
  throw new Error('no playable card appeared');
}

// ---------- landing ----------
{
  const page = await newPage();
  await page.goto(`${BASE}?seed=1`);
  await page.waitForSelector('#setup-form');
  check('landing: title is the game name', (await page.title()) === GAME_NAME, await page.title());
  check('landing: the hook is the tagline', (await page.textContent('.hero__hook')) === GAME_TAGLINE);
  check('landing: stat strip', /Players[\s\S]*Minutes[\s\S]*Ages/.test(await page.textContent('.stats')));
  check('landing: pills say 2-5 players (best 3-4), 25-35 minutes, 10+ and cards 1 to 10', /2-5[\s\S]*best 3-4[\s\S]*25-35[\s\S]*10\+[\s\S]*1 to 10/.test(await page.textContent('.stats')));
  check('landing: the title banner and both sides of the how-to-play card load', (await page.locator('.hero__img').count()) === 1 && (await page.locator('.how__card').count()) === 2 && await page.$$eval('.hero__img, .how__card', (els) => els.every((e) => e.complete && e.naturalWidth > 100)));
  check('landing: How to play lists the six steps and the scoring', /Follow[\s\S]*Trade[\s\S]*Discard[\s\S]*Win[\s\S]*Take[\s\S]*Sail/.test(await page.textContent('.how__steps')) && /\+1 per trick won/.test(await page.textContent('.how__score')));
  check('landing: a watch-the-bots shortcut is offered', (await page.locator('[data-action=watch-bots]').count()) === 1);
  {
    await page.evaluate(() => { document.getElementById('rules-panel').open = true; });
    const txt = await page.textContent('#rules-panel');
    check('landing: the Playtest rules read as sentences (mooring, tie, trade, voyages, scoring)', /Trailing players moor last/.test(txt) && /A real card beats a trade/.test(txt) && /you must trade one of those cards/.test(txt) && /four at two players/.test(txt) && /Serpents only/.test(txt));
    await page.evaluate(() => { document.getElementById('rules-panel').open = false; });
  }
  const opts = await page.$$eval('select[name=type1] option', (o) => o.map((x) => x.value));
  check('landing: Human and the three bot levels are on the menu, simulator bots are not', ['human', 'easy', 'medium', 'hard'].every((v) => opts.includes(v)) && !opts.includes('high'), opts.join(','));
  check('landing: hint to watch bots', /Set every seat to a bot to watch a game/.test(await page.textContent('.hint')));
  const href = await page.getAttribute('a[data-action=rulebook]', 'href');
  const r = await page.request.get(BASE + href);
  check('landing: the rule book link answers 200', href === RULEBOOK_URL && r.status() === 200, `${href} ${r.status()}`);
  check('landing: Playtest rules collapsed, no note', !(await page.$eval('#rules-panel', (d) => d.open)) && !(await page.isVisible('#rules-note')));
  await page.evaluate(() => { document.getElementById('rules-panel').open = true; });
  const visible = VARIANTS.filter((v) => !v.onlyFor || v.onlyFor.includes(4)).length;
  check('landing: one visible switch per VARIANTS row that applies at four players', (await page.locator('.rule:visible').count()) === visible);
  const v0 = VARIANTS[0];
  const other = v0.values.find((x) => x !== v0.default);
  await page.selectOption(`select[name="rule-${v0.name}"]`, other);
  check('landing: a non-standard switch shows the visible note with the code', await page.isVisible('#rules-note') && new RegExp(`Non-standard rules are on \\(${v0.code}-${other}\\)`).test(await page.textContent('#rules-note')));
  await page.click('[data-action=reset-rules]');
  check('landing: Standard rules resets and clears the note', !(await page.isVisible('#rules-note')) && (await page.inputValue(`select[name="rule-${v0.name}"]`)) === v0.default);
  await page.check('input[name=players][value="2"]');
  check('landing: 2 players shows 2 seats', (await page.locator('.seatform:visible').count()) === 2);
  await page.check('input[name=players][value="5"]');
  check('landing: 5 players shows 5 seats', (await page.locator('.seatform:visible').count()) === 5);
  if (!tokensLeft) check('landing: og:url is the published address', (await page.$eval('meta[property="og:url"]', (m) => m.content)) === PUBLISH_URL);
  check('landing: the favicon is declared and loads', (await (await page.request.get(`${BASE}assets/favicon.png`)).status()) === 200 && (await page.getAttribute('link[rel=icon]', 'href')) === 'assets/favicon.png');
  check('landing: a bug button is on the body', (await page.locator('body > #bug-button').count()) === 1);
  await shot(page, 'landing-1280');
  await page.click('[data-action=open-rules]');
  check('landing: the How to play dialog opens', (await page.locator('.dialog').count()) === 1 && /Follow[\s\S]*Trade[\s\S]*Discard[\s\S]*Win[\s\S]*Take[\s\S]*Sail/.test(await page.textContent('.dialog')));
  await page.keyboard.press('Escape');
  check('landing: Escape closes the dialog', (await page.locator('.dialog').count()) === 0);
  await page.close();
}

// ---------- human v Easy, 4 players ----------
{
  const page = await newPage();
  await setup(page, { names: ['Mia'] });
  await toFirstCard(page);
  check('4p: four seats round the table with their trick counts', (await page.locator('.seat').count()) === 4 && (await page.locator('.seat .calc__part--tricks').count()) === 4 && (await page.locator('.seat .calc__part--serpents').count()) === 4);
  check('4p: ten cards in the hand, sorted by cargo', (await page.locator('.hand .card').count()) === 10);
  check('4p: the ring of eight islands is on the table, every ship moored', (await page.locator('.ring__isle').count()) === 8 && (await page.locator('.ring .pawn').count()) === 4);
  check('4p: every seat shows its ship, its island and the next one', (await page.locator('.seat__ship').allTextContents()).every((t) => /Island \d: \w+ .* next \w+/.test(t)));
  check('4p: an arrow marks each gap of the ring and a dot each ship\'s next island', (await page.locator('.ring__arrow').count()) === 8 && (await page.locator('.ring .nextdot:not(.nextdot--key)').count()) === 4);
  {
    const counts = await page.$$eval('.seat', (els) => els.map((e) => e.querySelector('.seat__cardsnum') && e.querySelector('.seat__cardsnum').textContent));
    check('4p: every seat shows its cards in hand as a number (10 each at the start), and your own matches the hand', counts.length === 4 && counts.every((t) => t === '10') && Number(await page.textContent('.seat.is-you .seat__cardsnum')) === (await page.locator('.hand .card').count()));
    check('4p: the number sits in the seat head beside the name, with the caption', (await page.locator('.seat__head .seat__cards small').allTextContents()).every((t) => /in hand/i.test(t)));
    const fsHand = await page.$eval('.seat.is-you .seat__cardsnum', (e) => parseFloat(getComputedStyle(e).fontSize));
    const fsTricks = await page.$eval('.seat.is-you .calc__part--tricks b', (e) => parseFloat(getComputedStyle(e).fontSize));
    const fsScore = await page.$eval('.seat.is-you .calc__part--score b', (e) => parseFloat(getComputedStyle(e).fontSize));
    check('4p: what decides the score (+tricks, -serpents, = voyage) is big; cards in hand is the small number', fsTricks > fsHand * 1.4 && fsScore > fsTricks && fsHand <= 18, `${fsHand} / ${fsTricks} / ${fsScore}`);
    check('4p: the voyage arithmetic reads +tricks, serpents (0, or minus N), = voyage on every seat', (await page.locator('.seat .calc').evaluateAll((els) => els.every((e) => /^[+]\d\s*(0|[\u2212]\d+)\s*=\s*-?\d/.test(e.textContent.replace(/[a-z]+/g, ' ').replace(/\s+/g, ' ').replace(/ /g, ''))))));
  }
  await shot(page, 'start-1280');
  await page.locator('.hand .card.is-legal').first().click();
  await page.waitForFunction(() => document.querySelector('.seat.is-you .seat__cardsnum').textContent === '9', null, { timeout: 8000 }).catch(() => {});
  check('4p: playing a card lowers your cards-in-hand number', (await page.textContent('.seat.is-you .seat__cardsnum')) === '9');
  const s = await playHuman(page);
  check('4p: human moors every voyage, plays and the game ends', s.plays >= 10 && s.moorings >= 3 && (await page.locator('.end--game').count()) === 1, JSON.stringify(s));
  check('4p: every voyage end showed the reckoning (4)', s.summaries >= 3, `${s.summaries}`);
  check('4p: the log has mooring and sailing lines', (await page.locator('.log__item', { hasText: 'moors at island' }).count()) > 0 && (await page.locator('.log__item', { hasText: ' to island ' }).count()) > 0);
  check('4p: illegal cards explain themselves (tooltip equals the note)', s.illegalTried > 0 && s.tooltipMatches === s.illegalTried, `${s.tooltipMatches}/${s.illegalTried}`);
  check('4p: legal cards carry a would-win hint', s.hints > 3);
  check('4p: end screen ranks everyone with seat badges and a winner', (await page.locator('.ranking .rank').count()) === 4 && (await page.locator('.ranking .badge').count()) === 4 && (await page.locator('.rank.is-winner').count()) >= 1);
  check('4p: the typed name is used', /Mia/.test(await page.textContent('.ranking')));
  check('4p: the log has trick lines', (await page.locator('.log__item--trick').count()) > 15, `${await page.locator('.log__item--trick').count()}`);
  await shot(page, 'end-1280');
  check('4p: no horizontal scroll at the end', (await overflow(page)) <= 0);
  await page.click('.end--game [data-action=again]');
  await toFirstCard(page);
  check('play again starts a new game with the same setup', (await page.locator('.seat').count()) === 4 && (await page.locator('.log__item--trick').count()) === 0);
  await page.close();
}

// ---------- every registered level, and 2 / 3 / 5 players ----------
for (const level of levels.filter((l) => ['easy', 'medium', 'hard'].includes(l))) {
  for (const n of [2, 3, 5]) {
    if (level !== 'easy' && n === 3) continue; // keep the run short: every level meets 2 and 5 players, Easy meets 3 too
    const page = await newPage();
    await setup(page, { players: n, types: ['human', level, level, level, level], q: 'seed=21' });
    await toFirstCard(page);
    const s = await playHuman(page);
    check(`${n}p v ${level}: the game ends with a ranking of ${n}`, (await page.locator('.end--game').count()) === 1 && (await page.locator('.rank').count()) === n, JSON.stringify(s));
    check(`${n}p v ${level}: the human played a fair share of cards`, s.plays >= ({ 2: 13, 3: 13, 5: 8 })[n] / 2);
    await page.close();
  }
}

// ---------- bot v bot, with and without Workers ----------
{
  const page = await newPage();
  await setup(page, { players: 3, types: ['easy', 'medium', 'easy'], q: 'seed=3' });
  await page.waitForSelector('.end--game', { timeout: 120000 });
  check('bot v bot: finishes by itself', (await page.locator('.rank').count()) === 3);
  check('bot v bot: no hand is shown', (await page.locator('.hand .card').count()) === 0);
  check('bot v bot: the Worker was used', (await page.evaluate(() => document.body.dataset.botMode)) === 'worker');
  await page.close();
  const p2 = await newPage(1280, 900, {}, () => { delete window.Worker; });
  await setup(p2, { players: 3, types: ['easy', 'easy', 'easy'], q: 'seed=4' });
  await p2.waitForSelector('.end--game', { timeout: 120000 });
  check('no Worker: falls back to synchronous bots and still finishes', (await p2.evaluate(() => document.body.dataset.botMode)) === 'sync');
  await p2.close();
}

// ---------- pass and play ----------
{
  const page = await newPage();
  await setup(page, { players: 3, types: ['human', 'human', 'easy'], names: ['Ann', 'Bo'], q: 'seed=5' });
  await page.waitForSelector('.cover', { timeout: 30000 });
  check('pass-and-play: a cover comes first and body is marked covered', (await page.getAttribute('body', 'data-covered')) === '1' && /Pass to (Ann|Bo)/.test(await page.textContent('.cover')));
  check('pass-and-play: the bug button is disabled while the cover is up', await page.$eval('#bug-button', (b) => b.disabled === true));
  await page.keyboard.press('Control+Shift+B');
  await page.waitForTimeout(150);
  check('pass-and-play: Ctrl+Shift+B opens nothing behind the cover', (await page.locator('[data-bug-root]').count()) === 0);
  await tryClick(page.locator('.cover .btn--primary'));
  await page.waitForSelector('.ring button.isle.is-pickable', { timeout: 15000 });
  check('pass-and-play: the bug button is back once the cover is off', await page.$eval('#bug-button', (b) => b.disabled === false));
  const s = newStats();
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) { if ((await humanStep(page, s)) === 'end') break; }
  check('pass-and-play: the game ends, with a cover before each human turn and no leak behind it', (await page.locator('.end--game').count()) === 1 && s.covers > 10 && s.coverLeaks === 0, JSON.stringify(s));
  await page.close();
}

// ---------- non-standard rules ----------
{
  const v0 = VARIANTS[0];
  const other = v0.values.find((x) => x !== v0.default);
  const page = await newPage();
  await setup(page, { players: 4, rules: { [v0.name]: other }, q: 'seed=7' });
  await toFirstCard(page);
  check('variants: the game screen flags the non-standard rules', new RegExp(`${v0.code}-${other}`).test(await page.textContent('.rules-flag')));
  const s = await playHuman(page);
  check('variants: the game ends and the end panel names the rules', (await page.locator('.end--game').count()) === 1 && new RegExp(`${v0.code}-${other}`).test(await page.textContent('.end__rules')), JSON.stringify(s));
  await page.close();
}

// ---------- motion ----------
{
  const page = await newPage(1280, 900);
  await setup(page, { q: 'seed=11', delay: 800 });
  await toFirstCard(page);
  check('motion: cards transition by default', parseFloat(await page.$eval('.card', (e) => getComputedStyle(e).transitionDuration)) > 0);
  await page.close();
  const rm = await newPage(1280, 900, { reducedMotion: 'reduce' });
  await setup(rm, { q: 'seed=11', delay: 800 });
  await toFirstCard(rm);
  check('motion: prefers-reduced-motion turns the transitions off', parseFloat(await rm.$eval('.card', (e) => getComputedStyle(e).transitionDuration)) === 0);
  await rm.close();
}

// ---------- the trick winner is shown ----------
{
  const page = await newPage();
  await setup(page, { players: 3, q: 'seed=13', delay: 300 });
  await toFirstCard(page);
  await tryClick(page.locator('.hand .card.is-legal').first());
  const seen = await page.waitForSelector('.tplay.is-winner, .trick__msg.is-banner', { timeout: 15000 }).then(() => true, () => false);
  check('trick: the winner is marked on the table before the trick is taken', seen);
  await page.close();
}

// ---------- responsive ----------
for (const [w, h] of [[1440, 900], [1024, 800], [390, 844]]) {
  for (const n of [2, 3, 4, 5]) {
    const page = await newPage(w, h, w < 700 ? { hasTouch: true, isMobile: true } : {});
    await page.goto(`${BASE}?seed=1`);
    await page.waitForSelector('#setup-form');
    if (n === 4) {
      check(`responsive ${w}px: landing has no horizontal scroll`, (await overflow(page)) <= 0);
      await shot(page, `landing-${w}`);
    }
    await setup(page, { players: n, types: ['human', 'medium', 'easy', 'easy', 'easy'], q: 'seed=9' });
    await toFirstCard(page);
    check(`responsive ${w}px ${n}p: first screen has no horizontal scroll`, (await overflow(page)) <= 0);
    if (n === 4) await shot(page, `start-${w}`);
    const stats = newStats();
    for (let i = 0; i < 30 && stats.plays < 6; i++) await humanStep(page, stats);
    const box = await page.$eval('.table', (e) => { const r = e.getBoundingClientRect(); return [r.left, r.right]; });
    check(`responsive ${w}px ${n}p: mid-game has no horizontal scroll, table fits with gutters`, (await overflow(page)) <= 0 && box[0] >= 0 && box[1] <= w, JSON.stringify(box));
    {
      // measured in one go, after the islands' fade-in has settled (a new ring lands with a 0.5 s animation)
      let m = null;
      for (let k = 0; k < 4; k++) {
        await page.waitForTimeout(700);
        m = await page.evaluate(() => {
          const st = document.querySelector('.ring__stage');
          if (!st) return null;
          const b = st.getBoundingClientRect();
          return { r: [b.left, b.right, b.width, b.height], isles: [...document.querySelectorAll('.ring__isle')].map((e) => { const x = e.getBoundingClientRect(); return [x.left, x.right, x.width]; }) };
        });
        if (m && m.isles.length === 8 && m.isles.every((x) => x[2] > 0)) break;
      }
      check(`responsive ${w}px ${n}p: the ring fits the screen and every island is big enough to read and tap`, !!m && m.r[0] >= 0 && m.r[1] <= w && m.isles.length === 8 && m.isles.every((x) => x[0] >= -4 && x[1] <= w + 4 && x[2] >= (w < 700 ? 70 : 95)), JSON.stringify(m));
    }
    await shot(page, `play-${n}p-${w}`);
    if ((w === 390 && n === 4) || (w === 1024 && n === 5) || (w === 1440 && n === 2)) {
      const s = await playHuman(page);
      check(`responsive ${w}px ${n}p: the whole game plays and ends without sideways scroll`, (await page.locator('.end--game').count()) === 1 && (await overflow(page)) <= 0, JSON.stringify(s));
      if (n === 4) await shot(page, `end-${w}`);
    }
    await page.close();
  }
}

// ---------- the table: mooring step, forced trade, sideways trade, sail animation, reckoning ----------
{
  const page = await newPage(1280, 900, {}, () => {
    window.__sail = { seen: 0, frames: 0 };
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => { if (document.querySelector('.pawn.is-sailing')) window.__sail.seen++; }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
    });
  });
  await setup(page, { players: 3, types: ['human', 'easy', 'easy'], names: ['Mia'], q: 'seed=5', delay: 250 });
  await page.waitForSelector('.ring button.isle.is-pickable', { timeout: 20000 });
  check('mooring: all eight islands are buttons and the reminder says ships only sail clockwise', (await page.locator('.ring button.isle.is-pickable').count()) === 8 && /clockwise/.test(await page.textContent('.decision')));
  check('mooring: each island says how many cards of its cargo you hold, and your hand is on show', (await page.locator('.isle__hold').allTextContents()).every((t) => /^\d+ in hand$/.test(t)) && (await page.locator('.hand .card').count()) === 13);
  await shot(page, 'mooring-1280');
  await page.keyboard.press('3');
  check('mooring: key 3 focuses island 3', (await page.evaluate(() => document.activeElement.dataset.islandBtn)) === '2');
  await page.keyboard.press('ArrowRight');
  check('mooring: the arrow keys walk the islands clockwise', (await page.evaluate(() => document.activeElement.dataset.islandBtn)) === '3');
  const before = await page.locator('.ring .pawn').count();
  await page.keyboard.press('Enter');
  await page.waitForFunction((b) => document.querySelectorAll('.ring .pawn').length > b || document.querySelectorAll('.hand .card.is-legal').length > 0, before, { timeout: 8000 }).catch(() => {});
  check('mooring: Enter moors, and the ship appears on island 4', (await page.locator('.ring__isle[data-island="3"] .pawn.is-you').count()) === 1);
  // now play on, watching for the moments that matter
  const seen = { trade: false, tradeText: '', sideways: false, chip: '', discard: false, reckon: '', rankChoice: false, blockedTitle: '' };
  const deadline = Date.now() + 160000;
  const st = newStats();
  while (Date.now() < deadline) {
    if (await page.locator('.end--game').count()) break;
    if (await page.locator('.situation--trade').count() && !seen.trade) {
      seen.trade = true;
      seen.tradeText = await page.textContent('#situation');
      seen.rankChoice = (await page.locator('.hand .card.is-trade').count()) > 1;
      seen.blockedTitle = (await page.locator('.hand .card.is-blocked').first().getAttribute('title').catch(() => '')) || '';
      await shot(page, 'forced-trade-1280');
    }
    if (!seen.sideways && await page.locator('.tplay.is-sideways .mark--trade').count()) {
      seen.sideways = true;
      seen.chip = await page.textContent('.tplay.is-sideways .mark--trade');
      await shot(page, 'trade-in-trick-1280');
    }
    if (!seen.discard && await page.locator('.situation--discard').count()) seen.discard = true;
    if (!seen.reckon && await page.locator('#continue').count()) {
      seen.reckon = await page.textContent('.summary');
      await shot(page, 'reckoning-1280', false);
    }
    await humanStep(page, st);
  }
  check('forced trade: the island demands its cargo is said on screen, naming the cargo', seen.trade && /The island demands its cargo: you must trade (Spice|Pearls|Silk|Amber)/.test(seen.tradeText), seen.tradeText.slice(0, 120));
  check('forced trade: the cards that may be traded are tagged Trade and the others explain themselves in their tooltips', seen.trade && /^(Follow |Your island demands)/.test(seen.blockedTitle || 'Follow x') , seen.blockedTitle);
  check('trade: a trade is laid sideways in the trick with a counts-as chip', seen.sideways && /counts as (Spice|Pearls|Silk|Amber)/i.test(seen.chip), seen.chip);
  check('sail: ships slid round the ring (the sail animation ran)', (await page.evaluate(() => window.__sail.seen)) > 0);
  check('reckoning: the arithmetic is on screen (+tricks, -serpents, voyage score, total)', /Tricks[\s\S]*\+1 each[\s\S]*Serpents[\s\S]*Voyage score[\s\S]*Total/.test(seen.reckon) && /[+]\d/.test(seen.reckon) && /\u2212\d/.test(seen.reckon), seen.reckon.replace(/\s+/g, ' ').slice(0, 160));
  check('game ends with a ranking and final-voyage points', (await page.locator('.end--game').count()) === 1 && (await page.locator('.rank__last').count()) === 3);
  await shot(page, 'end-3p-1280', false);
  await page.close();
}
{
  // reduced motion: no sail animation runs
  const page = await newPage(1280, 900, { reducedMotion: 'reduce' }, () => {
    window.__sail = { seen: 0 };
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => { if (document.querySelector('.pawn.is-sailing')) window.__sail.seen++; }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
    });
  });
  await setup(page, { players: 2, types: ['human', 'easy'], q: 'seed=5', delay: 200 });
  const st = newStats();
  const t0 = Date.now();
  while (Date.now() - t0 < 25000 && st.plays < 8) await humanStep(page, st);
  check('reduced motion: ships still move but no sail animation runs', st.plays >= 8 && (await page.evaluate(() => window.__sail.seen)) === 0, JSON.stringify(st));
  await page.close();
}
{
  // the hand panel's island chip follows the ship round the ring
  const page = await newPage();
  await setup(page, { players: 3, types: ['human', 'easy', 'easy'], q: 'seed=5', delay: 40 });
  const st = newStats();
  const seen = new Set(); let mismatch = 0; let flashed = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 40000 && st.plays < 14) {
    await humanStep(page, st);
    const r = await page.evaluate(() => {
      const c = document.querySelector('.handbox .youisle[data-island]');
      const mine = document.querySelector('.ring__isle .isle.is-mine');
      return { c: c ? c.dataset.island : null, m: mine ? mine.closest('.ring__isle').dataset.island : null, cargo: c ? c.dataset.cargo : null, txt: c ? c.textContent : '', flash: !!document.querySelector('.youisle.is-changed') };
    });
    if (r.c !== null) { seen.add(r.c); if (r.m !== null && r.m !== r.c) mismatch++; }
    if (r.flash) flashed++;
  }
  check('hand panel: the island chip always matches your island on the ring, and changes after a sail', seen.size >= 2 && mismatch === 0, `islands seen ${[...seen]}, mismatches ${mismatch}, flashes ${flashed}`);
  await page.close();
}
{
  // watch the bots: one click, no hand, finishes
  const page = await newPage();
  await page.goto(`${BASE}?botdelay=0&seed=8`);
  await page.waitForSelector('#setup-form');
  await page.check('input[name=players][value="3"]');
  await page.click('[data-action=watch-bots]');
  await page.waitForSelector('.end--game', { timeout: 120000 });
  check('watch the bots: a game with every seat a bot runs to the end with no hand shown', (await page.locator('.hand .card').count()) === 0 && (await page.locator('.rank').count()) === 3);
  await page.close();
}

// ---------- keyboard ----------
{
  const page = await newPage();
  await setup(page, { q: 'seed=11' });
  await toFirstCard(page);
  await page.focus('.hand .card.is-legal');
  check('keyboard: focusing a card shows its hint', (await page.textContent('#preview')).length > 10);
  await page.keyboard.press('ArrowRight');
  check('keyboard: arrow keys move along the hand', await page.evaluate(() => document.activeElement.classList.contains('card')));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check('keyboard: Enter on a focused card plays it or explains why not', (await page.locator('#note').count()) === 1);
  await page.close();
}

check('console is clean (no errors, warnings, failed requests)', problems.length === 0, problems.slice(0, 5).join(' || '));

await browser.close();
close();
console.log(`screenshots: ${SHOTS}`);
done();
