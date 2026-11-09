// qa-run.mjs - browser QA over the whole game, run from a sub-path the way GitHub Pages serves it.
//
// 1. Copies the files that would be published into <system temp>/<slug>-qa/site/<slug>-game/ and serves
//    <temp>/site on a CASE-SENSITIVE static server (a request must match a real file name exactly, like Pages).
// 2. Drives the game in headless Chromium: the landing page from the sub-path, the consent banner and
//    analytics on a real-looking host name, every width, 2 to 5 players against every bot level, all-bot
//    games, pass-and-play, a game under every non-standard rules value, the stats screen and its exports,
//    the bug reporter, the rule book link, reduced motion, keyboard play, leaving a game and a clean console.
// 3. Prints PASS/FAIL per check, writes screenshots to <temp>/<slug>-qa/shots/ and a JSON summary to
//    <temp>/<slug>-qa/qa-results.json. Exit 1 if anything fails.
//
// Needs Playwright (not a dependency of this repo; see tests/browser-lib.mjs).
// Run: node tests/qa/qa-run.mjs [--only=<scenario substring>] [--widths=390,1440]

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VARIANTS } from '../../src/engine/index.js';
import { GAME_NAME, GAME_SLUG, GAME_TAGLINE, RULEBOOK_URL, CONTACT_EMAIL } from '../../src/game-config.js';
import { loadPlaywright, MIME } from '../browser-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = path.join(os.tmpdir(), `${GAME_SLUG}-qa${process.env.QA_TAG ? `-${process.env.QA_TAG}` : ''}`);
const SITE = path.join(TMP, 'site');
const SUB = `${GAME_SLUG}-game`;
const SHOTS = path.join(TMP, 'shots');
const STORE = `${GAME_SLUG}-stats-v1`;
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const WIDTHS_ARG = (process.argv.find((a) => a.startsWith('--widths=')) || '').slice(9).split(',').filter(Boolean).map(Number);
const WIDTHS = WIDTHS_ARG.length ? WIDTHS_ARG : [1440, 1280, 1024, 768, 390, 360];

const chromium = await loadPlaywright();
if (!chromium) { console.log('qa-run: Playwright not found'); process.exit(1); }

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const tokensLeft = /\{\{[A-Z_]+\}\}/.test(html);

// ---------- the sub-path copy of the site ----------
const SKIP_DIRS = new Set(['.git', 'node_modules', 'bug-reports', 'test-results']);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
const served = new Set(); // exact-case relative paths under SITE
(function copy(dir) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && rel !== 'tests/tmp') copy(rel); continue; }
    const dst = path.join(SITE, SUB, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dst);
    served.add(`${SUB}/${rel}`);
  }
})('');

const requestLog = []; // { url, status }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (rel.endsWith('/')) rel += 'index.html';
  if (!served.has(rel) && served.has(`${rel}/index.html`)) rel += '/index.html';
  const ok = served.has(rel);
  requestLog.push({ url: url.pathname, status: ok ? 200 : 404 });
  if (!ok) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(rel)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(path.join(SITE, rel)).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/${SUB}/`;

// ---------- result bookkeeping ----------
const results = []; // { scenario, name, pass, detail }
let current = null;
function check(name, cond, detail = '') {
  const pass = !!cond;
  results.push({ scenario: current, name, pass, detail: String(detail || '') });
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}${detail && !pass ? ` -- ${detail}` : ''}`);
  return pass;
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
async function shot(page, name, opts = {}) {
  const file = path.join(SHOTS, `${slug(current || 'qa')}--${slug(name)}.png`);
  try { await page.screenshot({ path: file, ...opts }); } catch (e) { console.log(`  (screenshot failed: ${e.message})`); }
}
async function scenario(name, fn) {
  if (ONLY && !name.toLowerCase().includes(ONLY.toLowerCase())) return;
  current = name;
  console.log(`\n== ${name}`);
  const t0 = Date.now();
  try { await fn(); } catch (e) { check('scenario ran without throwing', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); }
  console.log(`   (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

// ---------- browser plumbing ----------
const browser = await chromium.launch();
const problems = []; // console errors/warnings, page errors, failed requests, HTTP >= 400
const imageBytes = new Map();
async function newPage(w = 1440, h = 900, opts = {}, init = null, b = browser) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, acceptDownloads: true, ...opts });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${current}] ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${current}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`[${current}] request failed: ${r.url()}`));
  page.on('response', async (r) => {
    if (r.status() >= 400) problems.push(`[${current}] HTTP ${r.status()} ${r.url()}`);
    const type = r.headers()['content-type'] || '';
    if (/^image\//.test(type)) { try { imageBytes.set(r.url(), (await r.body()).length); } catch { /* gone */ } }
  });
  page.__touch = !!opts.hasTouch;
  page.__w = w;
  return page;
}
const tryClick = (loc, opts = {}) => loc.click({ timeout: 5000, ...opts }).then(() => true, () => false);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const events = (page) => page.evaluate(() => (window.dataLayer || []).map((a) => Array.from(a)).filter((a) => a[0] === 'event'));

async function open(page, q = 'seed=1&botdelay=0') {
  await page.goto(`${BASE}?${q}`);
  await page.waitForSelector('#setup-form');
}
async function configure(page, { players = 4, types = [], names = [], rules = {}, auto = false } = {}) {
  await page.check(`input[name=players][value="${players}"]`);
  for (let i = 0; i < players; i++) {
    await page.selectOption(`select[name=type${i}]`, types[i] || (i === 0 ? 'human' : 'easy'));
    if (names[i]) await page.fill(`input[name=name${i}]`, names[i]);
  }
  if (Object.keys(rules).length) {
    await page.evaluate(() => { document.getElementById('rules-panel').open = true; });
    for (const [k, v] of Object.entries(rules)) await page.selectOption(`select[name="rule-${k}"]`, v);
  }
  if (auto) await page.check('#autoPlayForced');
}
async function begin(page, o = {}, q = 'seed=1&botdelay=0') {
  await open(page, q);
  await configure(page, o);
  await page.click('#start');
}
const newStats = () => ({ plays: 0, covers: 0, summaries: 0, hints: 0, leaks: 0 });

/** One human decision: a cover, a reckoning, or a card. Returns what it did. */
async function humanStep(page, stats) {
  if (await page.locator('.end--game').count()) return 'end';
  if (await page.locator('.cover').count()) {
    stats.covers++;
    if (await page.locator('.hand, .card, .cardimg, .table, .log__list').count()) stats.leaks++;
    await tryClick(page.locator('.cover .btn--primary'));
    return 'cover';
  }
  if (await page.locator('#continue').count()) { if (await tryClick(page.locator('#continue'))) stats.summaries++; return 'summary'; }
  // The other decision: every voyage opens with the mooring, one button per island (a different island each time, so ships share and spread).
  const moor = page.locator('.ring button.isle.is-pickable');
  const nMoor = await moor.count();
  if (nMoor) {
    stats.moorings = (stats.moorings || 0) + 1;
    if (!(await tryClick(moor.nth((stats.moorings * 5) % nMoor)))) { stats.moorings--; return 'retry'; }
    if (page.__touch) await tryClick(page.locator('.ring button.isle.is-selected'), { timeout: 1500 });
    return 'moor';
  }
  const legal = page.locator('.hand .card.is-legal');
  if (await legal.count()) {
    if (await page.locator('.hand .card__hint').count()) stats.hints++;
    stats.plays++;
    if (!(await tryClick(legal.first()))) { stats.plays--; return 'retry'; }
    if (page.__touch) await tryClick(page.locator('.hand .card.is-selected'), { timeout: 1500 });
    return 'card';
  }
  await page.waitForTimeout(25);
  return 'wait';
}
async function playHuman(page, limitMs = 150000, until = null) {
  const stats = newStats();
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if ((await humanStep(page, stats)) === 'end') break;
    if (until && until(stats)) break;
  }
  return stats;
}
/** Moors (and confirms any cover) until the human has a card to play: every voyage starts with the mooring. */
async function toFirstCard(page, timeout = 30000) {
  const stats = newStats();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.locator('.hand .card.is-legal').count()) return;
    await humanStep(page, stats);
  }
  throw new Error('no playable card appeared');
}
const finish = (page) => page.waitForSelector('.end--game', { timeout: 120000 });

// ============================================================================================
await scenario('Static: every referenced path is an exact-case match; lower-case names; sizes', async () => {
  const refs = [];
  const textFiles = [...served].filter((f) => /\.(html|css|js)$/.test(f) && !f.includes('/tests/'));
  for (const f of textFiles) {
    const text = fs.readFileSync(path.join(SITE, f), 'utf8');
    for (const m of text.matchAll(/["'(=]\s*((?:\.{1,2}\/)?[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:js|css|png|webp|jpg|json|pdf|md|svg))\b/g)) refs.push({ from: f, ref: m[1] });
  }
  const lower = new Map([...served].map((f) => [f.toLowerCase(), f]));
  const bad = [];
  for (const { from, ref } of refs) {
    const cands = [path.posix.normalize(path.posix.join(path.posix.dirname(from), ref)), path.posix.normalize(`${SUB}/${ref}`)];
    if (cands.some((c) => served.has(c))) continue;
    const near = cands.map((c) => lower.get(c.toLowerCase())).find(Boolean);
    if (near) bad.push(`${from} -> ${ref} (is ${near})`);
  }
  check(`every reference that resolves is an exact-case match (${refs.length} references)`, bad.length === 0, bad.slice(0, 3).join('; '));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/manifest.json'), 'utf8'));
  check('manifest has no absolute or Windows paths', manifest.assets.every((a) => !/^([A-Za-z]:|[\\/])/.test(a.file) && !/\\/.test(a.file)));
  check('manifest files marked real or placeholder are served', manifest.assets.filter((a) => a.status !== 'missing').every((a) => served.has(`${SUB}/assets/${a.file}`)));
  check('names are lower-case with no spaces (README aside)', [...served].every((f) => !/\s/.test(f) && (f === `${SUB}/README.md` || f === f.toLowerCase())));
  const big = [...served].filter((f) => fs.statSync(path.join(SITE, f)).size > 500 * 1024 && !/\/rules\/[a-z0-9-]+\.pdf$/.test(f));
  check('no file over 500 KB except the printed rule book', big.length === 0, big.join(', '));
});

await scenario('Landing from the sub-path', async () => {
  for (const w of [1440, 390]) {
    const page = await newPage(w, 900);
    imageBytes.clear();
    await open(page);
    await page.waitForLoadState('networkidle');
    const kb = [...imageBytes.values()].reduce((a, b) => a + b, 0) / 1024;
    check(`first paint at ${w}px: images under 2 MB`, kb < 2048, `${kb.toFixed(0)} KB`);
    await shot(page, `landing-${w}`);
    await page.close();
  }
  const page = await newPage();
  await open(page);
  check('title is the game name', (await page.title()) === GAME_NAME);
  check('meta description is present and not empty', (await page.getAttribute('meta[name=description]', 'content')).length > 10);
  check('hook is the tagline', (await page.textContent('.hero__hook')) === GAME_TAGLINE);
  if (tokensLeft) console.log('  (index.html still has unfilled tokens: the og / canonical checks are skipped)');
  else {
    const abs = await page.$$eval('meta[property="og:url"], meta[property="og:image"], meta[name="twitter:image"], link[rel=canonical]', (els) => els.map((e) => e.content || e.href));
    check('og and canonical addresses are absolute https', abs.every((u) => /^https:\/\//.test(u)), abs.join(' '));
  }
  const href = await page.getAttribute('a[data-action=rulebook]', 'href');
  const r = await page.request.get(BASE + href);
  check('rule book link answers 200', href === RULEBOOK_URL && r.status() === 200, `${href} ${r.status()}`);
  check('rule book link opens in a new tab with noopener', (await page.getAttribute('a[data-action=rulebook]', 'target')) === '_blank' && /noopener/.test(await page.getAttribute('a[data-action=rulebook]', 'rel')));
  const rulesFiles = [...served].filter((f) => f.startsWith(`${SUB}/rules/`));
  check('rules/ holds only the file the page links to', rulesFiles.length === 1 && rulesFiles[0] === `${SUB}/${RULEBOOK_URL}`, rulesFiles.join(', '));
  check('the favicon loads', (await (await page.request.get(`${BASE}assets/favicon.png`)).status()) === 200);
  const text = await page.textContent('body');
  check('no stray personal name or address on screen', !/@/.test(text) && !/\bDean\b(?! Morris)/.test(text));
  check('the origin root is not the game (404)', (await page.request.get(`${ORIGIN}/`)).status() === 404);
  await page.close();
});

await scenario('Consent banner and analytics on a real host name', async () => {
  const b2 = await chromium.launch({ args: [`--host-resolver-rules=MAP game.example.test 127.0.0.1`] });
  const ctx = await b2.newContext({ viewport: { width: 1280, height: 900 } });
  const seen = [];
  await ctx.route(/cdn-cookieyes\.com|googletagmanager\.com/, (route) => { seen.push(route.request().url()); route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* stub */' }); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`[${current}] pageerror: ${e.message}`));
  await page.goto(`http://game.example.test:${PORT}/${SUB}/?seed=1`);
  await page.waitForSelector('#setup-form');
  await page.waitForTimeout(300);
  check('CookieYes is requested first, then the Google tag', seen.length === 2 && /cdn-cookieyes\.com/.test(seen[0]) && /googletagmanager\.com\/gtag\/js\?id=G-/.test(seen[1]), seen.join(' | '));
  check('the Google tag is configured in dataLayer', (await page.evaluate(() => (window.dataLayer || []).some((a) => a[0] === 'config' && /^G-/.test(a[1])))));
  await b2.close();
  const page2 = await newPage();
  const third = [];
  page2.on('request', (r) => { if (!r.url().startsWith(ORIGIN)) third.push(r.url()); });
  await open(page2);
  check('nothing third-party loads on 127.0.0.1', third.length === 0, third.join(' '));
  await page2.close();
});

await scenario('Responsive landing at every width, 5 seats, rules panel open', async () => {
  for (const w of WIDTHS) {
    const page = await newPage(w, 900, w < 700 ? { hasTouch: true, isMobile: true } : {});
    await open(page);
    await page.check('input[name=players][value="5"]');
    await page.evaluate(() => { document.getElementById('rules-panel').open = true; });
    check(`${w}px: no sideways scroll`, (await overflow(page)) <= 0);
    const out = await page.evaluate((vw) => [...document.querySelectorAll('main *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 1 || r.left < -1); }).length, w);
    check(`${w}px: nothing outside the viewport`, out === 0, `${out} elements`);
    await shot(page, `landing-5-seats-${w}`);
    await page.close();
  }
});

await scenario('Human v bots to the end (every level, 2 to 5 players)', async () => {
  for (const [level, counts] of [['easy', [2, 3, 4, 5]], ['medium', [2, 4]], ['hard', [3, 5]]]) {
    for (const n of counts) {
      const page = await newPage(1280, 900);
      await begin(page, { players: n, types: ['human', level, level, level, level], names: ['Mia'] }, `seed=${n}&botdelay=0`);
      await toFirstCard(page);
      if (level === 'hard') {
        await page.evaluate(() => { window.__gap = 0; let last = performance.now(); setInterval(() => { const t = performance.now(); window.__gap = Math.max(window.__gap, t - last - 50); last = t; }, 50); });
      }
      const s = await playHuman(page);
      const hs = { 2: 13, 3: 13, 4: 10, 5: 8 }[n];
      const voyages = { 2: 4, 3: 3, 4: 4, 5: 5 }[n];
      check(`${level} ${n}p: the game ends with a ranking of ${n}`, (await page.locator('.end--game').count()) === 1 && (await page.locator('.rank').count()) === n, JSON.stringify(s));
      check(`${level} ${n}p: the human played a plausible number of cards and saw ${voyages} reckonings`, s.plays >= (n * hs) / 3 && s.summaries === voyages, JSON.stringify(s));
      if (level === 'hard') {
        const gap = await page.evaluate(() => window.__gap);
        check(`hard ${n}p: the page never froze (longest main-thread gap under 250 ms)`, gap < 250, `${gap.toFixed(0)} ms`);
        check(`hard ${n}p: decisions came from the Worker`, (await page.evaluate(() => document.body.dataset.botMode)) === 'worker');
      }
      const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{"games":[]}').games, STORE);
      check(`${level} ${n}p: the finished game was recorded once`, stored.length === 1 && stored[0].players === n);
      if (n === 4 || (level === 'hard' && n === 5)) { await shot(page, `${level}-${n}p-end`); }
      await page.close();
    }
  }
});

await scenario('All-bot games at 2 to 5 seats', async () => {
  const mixes = { 2: ['easy', 'medium'], 3: ['medium', 'hard', 'easy'], 4: ['hard', 'medium', 'easy', 'easy'], 5: ['easy', 'easy', 'medium', 'medium', 'hard'] };
  for (const n of [2, 3, 4, 5]) {
    const page = await newPage();
    await begin(page, { players: n, types: mixes[n] }, `seed=${n + 20}&botdelay=0`);
    await finish(page);
    check(`${n} bots: finishes by itself with a ranking`, (await page.locator('.rank').count()) === n);
    check(`${n} bots: no hand is shown`, (await page.locator('.hand .card').count()) === 0);
    const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).games[0], STORE);
    check(`${n} bots: recorded with ${{ 2: 4, 3: 3, 4: 4, 5: 5 }[n]} voyages and no human seat`, stored.hands === { 2: 4, 3: 3, 4: 4, 5: 5 }[n] && stored.seats.every((s) => s.type === 'bot'));
    if (n === 4) await shot(page, 'bots-4-end');
    await page.close();
  }
});

await scenario('Pass-and-play', async () => {
  for (const [n, humans, w] of [[2, 2, 1280], [3, 2, 390], [4, 3, 1280]]) {
    const page = await newPage(w, 900, w < 700 ? { hasTouch: true, isMobile: true } : {});
    await page.addInitScript(() => {
      window.__seenHandBehindCover = 0;
      document.addEventListener('DOMContentLoaded', () => {
        new MutationObserver(() => { if (document.querySelector('.cover') && document.querySelector('.hand, .card, .table, .seat, .log__list')) window.__seenHandBehindCover++; }).observe(document.body, { childList: true, subtree: true });
      });
    });
    await begin(page, { players: n, types: Array.from({ length: n }, (_, i) => (i < humans ? 'human' : 'easy')), names: ['Ann', 'Bo', 'Cy'] }, `seed=${n + 40}&botdelay=0`);
    await page.waitForSelector('.cover', { timeout: 30000 });
    if (w < 700) await shot(page, `cover-${n}p-${w}`);
    const cover = await page.$eval('.cover', (e) => { const r = e.getBoundingClientRect(); return [r.width, r.height, innerWidth, innerHeight]; });
    check(`${humans} humans in ${n}p: the cover fills the viewport`, cover[0] >= cover[2] - 1 && cover[1] >= cover[3] - 1);
    check(`${humans} humans in ${n}p: the cover names no cards or scores`, !/\d+ pts|Total|[A-Z][a-z]+ \d+/.test((await page.textContent('.cover')).replace(/Pass to .*? show my hand/, '')));
    const s = await playHuman(page, 150000);
    check(`${humans} humans in ${n}p: the game ends`, (await page.locator('.end--game').count()) === 1, JSON.stringify(s));
    check(`${humans} humans in ${n}p: a cover before every human decision, never a leak`, s.covers >= 10 && s.leaks === 0 && (await page.evaluate(() => window.__seenHandBehindCover)) === 0, JSON.stringify(s));
    await page.close();
  }
});

await scenario('Every non-standard rules value', async () => {
  for (const def of VARIANTS) {
    for (const value of def.values.filter((x) => x !== def.default)) {
      const page = await newPage();
      const n = def.onlyFor ? def.onlyFor[0] : 4;
      await begin(page, { players: n, types: Array(5).fill('easy'), rules: { [def.name]: value } }, 'seed=61&botdelay=0');
      await page.waitForSelector('.rules-flag, .end--game', { timeout: 30000 });
      await finish(page);
      const code = `${def.code}-${value}`;
      check(`${def.name}=${value}: the end panel names the rules`, (await page.textContent('.end__rules')).includes(code));
      const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).games[0], STORE);
      check(`${def.name}=${value}: the stored rules code matches`, stored.rules_code === code && stored.rules[def.name] === value);
      await page.close();
    }
  }
});

await scenario('Stats screen and exports', async () => {
  const page = await newPage();
  await open(page);
  await page.click('.landing [data-action=open-stats]');
  check('empty state first', /No games recorded yet/.test(await page.textContent('.dialog .st')));
  await page.keyboard.press('Escape');
  for (let i = 0; i < 3; i++) {
    await configure(page, { players: 3 + (i % 2), types: ['easy', 'easy', 'medium', 'easy'], rules: i === 2 ? { [VARIANTS[0].name]: VARIANTS[0].values.find((x) => x !== VARIANTS[0].default) } : {} });
    await page.click('#start');
    await finish(page);
    if (i < 2) { await page.click('.end [data-action=new]'); await page.waitForSelector('#setup-form'); }
  }
  await page.click('.end [data-action=open-stats]');
  await page.waitForSelector('.dialog .st');
  check('three games listed', /^\s*3\s+games played/.test(await page.textContent('.dialog .st__lead')));
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).games, STORE);
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-csv]')]);
  const csvText = fs.readFileSync(await csvDl.path(), 'utf8');
  const rows = csvText.trim().split('\n');
  check('CSV: LF only, a row per game, every row the same field count', rows.length === 4 && !csvText.includes('\r') && rows.every((r) => r.split(',').length === rows[0].split(',').length));
  const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-json]')]);
  check('JSON equals the store', JSON.stringify(JSON.parse(fs.readFileSync(await jsonDl.path(), 'utf8')).games) === JSON.stringify(stored));
  await page.keyboard.press('Escape');
  await page.close();
  const phone = await newPage(390, 844, { hasTouch: true, isMobile: true });
  await phone.addInitScript((a) => { try { localStorage.setItem(a.k, JSON.stringify({ v: 1, games: a.games })); } catch { /* ignore */ } }, { k: STORE, games: stored });
  await open(phone);
  await phone.click('.landing [data-action=open-stats]');
  await phone.waitForSelector('.dialog .st');
  check('390px: the stats dialog has no sideways scroll and its tables sit in scroll boxes', (await overflow(phone)) <= 0 && (await phone.locator('.st__scroll .st__table').count()) >= 4);
  check('390px: the dialog buttons are tall enough to tap', await phone.$$eval('.dialog__buttons .btn', (bs) => bs.every((b) => b.getBoundingClientRect().height >= 34)));
  await shot(phone, 'stats-390');
  await phone.close();
});

await scenario('Bug reporter', async () => {
  const page = await newPage();
  await open(page);
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('#bug-form');
  const [dl0] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  check('landing page: a report downloads as valid JSON', JSON.parse(fs.readFileSync(await dl0.path(), 'utf8')).schemaVersion === 1);
  const mail = await page.$eval('.bug a[href^="mailto:"]', (a) => a.getAttribute('href'));
  check(`the mailto names only ${CONTACT_EMAIL}`, mail.startsWith(`mailto:${CONTACT_EMAIL}?`) && (mail.match(/@/g) || []).length === 1);
  await page.keyboard.press('Escape');
  await configure(page, { players: 3 });
  await page.click('#start');
  await toFirstCard(page);
  await playHuman(page, 20000, (s) => s.plays >= 3);
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('#bug-form');
  await shot(page, 'bug-modal');
  const [dl1] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  const rep = JSON.parse(fs.readFileSync(await dl1.path(), 'utf8'));
  check('mid-game: the report holds the state and the action log', rep.game && rep.game.n === 3 && rep.actionLog.length >= 3);
  await page.keyboard.press('Escape');
  await playHuman(page);
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('#bug-form');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  check('end screen: a report downloads', JSON.parse(fs.readFileSync(await dl2.path(), 'utf8')).game.phase === 'over');
  await page.keyboard.press('Escape');
  await page.close();
  for (const w of WIDTHS) {
    const p = await newPage(w, 900, w < 700 ? { hasTouch: true, isMobile: true } : {});
    await begin(p, { players: 4 });
    await toFirstCard(p);
    await p.evaluate(() => document.querySelector('.hand').scrollIntoView({ block: 'center' }));
    const overlap = await p.evaluate(() => {
      const b = document.getElementById('bug-button').getBoundingClientRect();
      return [...document.querySelectorAll('.hand .card')].filter((c) => { const r = c.getBoundingClientRect(); return !(r.right < b.left || r.left > b.right || r.bottom < b.top || r.top > b.bottom); }).length;
    });
    check(`${w}px: with the hand scrolled into view the bug button never covers a card`, overlap === 0, `${overlap}`);
    await p.close();
  }
});

await scenario('Rules dialog and rule book link', async () => {
  for (const w of [1280, 390, 360]) {
    const page = await newPage(w, 800, w < 700 ? { hasTouch: true, isMobile: true } : {});
    await open(page);
    await page.click('.landing [data-action=open-rules]');
    check(`${w}px: the dialog opens, has steps and a rule book link, and fits`, (await page.locator('.dialog .how__steps > li').count()) >= 5 && (await page.locator('.dialog a[data-action=rulebook]').count()) === 1 && (await overflow(page)) <= 0);
    if (w === 390) await shot(page, 'rules-390');
    const n = (await events(page)).filter((c) => c[1] === 'rules_opened').length;
    check(`${w}px: rules_opened was queued`, n === 1, `${n}`);
    await page.close();
  }
});

await scenario('Responsive sweep: 2, 4 and 5 players at every width', async () => {
  for (const w of WIDTHS) {
    for (const n of [2, 4, 5]) {
      const page = await newPage(w, 844, w < 700 ? { hasTouch: true, isMobile: true } : {});
      await begin(page, { players: n, types: ['human', 'medium', 'easy', 'easy', 'easy'] }, 'seed=9&botdelay=0');
      await toFirstCard(page);
      const first = await page.$$eval('.hand .card', (cs) => cs.map((c) => c.getBoundingClientRect().width));
      check(`${w}px ${n}p: first screen fits and hand cards are at least 36 px wide`, (await overflow(page)) <= 0 && Math.min(...first) >= 36, `min ${Math.min(...first).toFixed(0)}`);
      if (n === 4) await shot(page, `start-${n}p-${w}`);
      let sawSummary = false;
      for (let i = 0; i < 400 && !sawSummary; i++) { await humanStep(page, newStats()); if (await page.locator('#continue').count()) sawSummary = true; }
      if (sawSummary) {
        check(`${w}px ${n}p: the reckoning fits`, (await overflow(page)) <= 0);
        if (n === 4) await shot(page, `reckoning-${n}p-${w}`);
        await tryClick(page.locator('#continue'));
      }
      const s = await playHuman(page);
      check(`${w}px ${n}p: the end panel shows and nothing scrolls sideways`, (await page.locator('.end--game').count()) === 1 && (await overflow(page)) <= 0, JSON.stringify(s));
      if (n === 4) await shot(page, `end-${n}p-${w}`);
      await page.close();
    }
  }
});

await scenario('Reduced motion', async () => {
  const dflt = await newPage();
  await begin(dflt, { players: 3 }, 'seed=11&botdelay=800');
  await toFirstCard(dflt);
  check('by default cards transition', parseFloat(await dflt.$eval('.card', (e) => getComputedStyle(e).transitionDuration)) > 0);
  await dflt.close();
  const rm = await newPage(1280, 900, { reducedMotion: 'reduce' });
  await begin(rm, { players: 3 }, 'seed=11&botdelay=800');
  await toFirstCard(rm);
  check('with reduced motion the transitions and animations are off', parseFloat(await rm.$eval('.card', (e) => getComputedStyle(e).transitionDuration)) === 0 && (await rm.$eval('.seat', (e) => getComputedStyle(e).animationName)) === 'none');
  await rm.close();
});

await scenario('Keyboard play', async () => {
  const page = await newPage();
  await begin(page, { players: 3, auto: false });
  await toFirstCard(page);
  await page.focus('.hand .card.is-legal');
  await page.keyboard.press('Home');
  const first = await page.evaluate(() => document.activeElement.dataset.card);
  await page.keyboard.press('End');
  const last = await page.evaluate(() => document.activeElement.dataset.card);
  check('Home and End move to the first and last card', !!first && !!last && first !== last);
  const blocked = page.locator('.hand .card.is-blocked');
  if (await blocked.count()) {
    await blocked.first().focus();
    await page.keyboard.press('Enter');
    check('Enter on a dimmed card explains why it cannot be played', (await page.textContent('#note')).length > 10);
  } else check('Enter on a dimmed card explains why it cannot be played (no dimmed card this deal)', true);
  await page.focus('.hand .card.is-legal');
  const before = await page.locator('.hand .card').count();
  await page.keyboard.press('Enter');
  await page.waitForFunction((b) => document.querySelectorAll('.hand .card').length < b || document.querySelector('.cover, #continue, .end--game'), before, { timeout: 10000 }).catch(() => {});
  check('Enter on a legal card plays it', (await page.locator('.hand .card').count()) < before || (await page.locator('#continue, .end--game').count()) > 0);
  await page.click('[data-action=open-rules]');
  await page.keyboard.press('Tab');
  check('a dialog keeps focus inside it', await page.evaluate(() => !!document.activeElement.closest('.dialog')));
  await page.keyboard.press('Escape');
  await page.close();
});

await scenario('Leaving a game', async () => {
  const page = await newPage();
  await begin(page, { players: 3 }, 'seed=71&botdelay=0');
  await toFirstCard(page);
  await playHuman(page, 20000, (s) => s.plays >= 3);
  page.once('dialog', (d) => d.dismiss());
  await page.click('[data-action=quit]');
  check('Cancel keeps the game', (await page.locator('.hand').count()) === 1 && (await page.locator('#setup-form').count()) === 0);
  if (await page.locator('#continue').count()) await page.click('#continue');
  page.once('dialog', (d) => d.accept());
  await page.click('[data-action=quit]');
  await page.waitForSelector('#setup-form');
  const ab = (await events(page)).filter((c) => c[1] === 'game_abandoned').length;
  check('game_abandoned fires once', ab === 1, `${ab}`);
  check('an abandoned game is not recorded in the stats', (await page.evaluate((k) => localStorage.getItem(k), STORE)) === null);
  await page.close();
});

// ============================================================================================
await scenario('Console and server log', async () => {
  check('no console errors or warnings, no failed requests, no HTTP 4xx across the whole run', problems.length === 0, problems.slice(0, 4).join(' || '));
  const missing = requestLog.filter((r) => r.status === 404 && r.url !== '/');
  check('the server log has no 404 (the origin root aside)', missing.length === 0, missing.slice(0, 3).map((r) => r.url).join(' '));
});

await browser.close();
server.close();
const failed = results.filter((r) => !r.pass);
fs.writeFileSync(path.join(TMP, 'qa-results.json'), `${JSON.stringify({ total: results.length, failed: failed.length, results }, null, 1)}\n`);
console.log(`\nqa-run: ${results.length - failed.length} passed, ${failed.length} failed. Screenshots: ${SHOTS}`);
if (failed.length) { for (const f of failed) console.log(`  FAIL [${f.scenario}] ${f.name}${f.detail ? ` -- ${f.detail}` : ''}`); process.exit(1); }
