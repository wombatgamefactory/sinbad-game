// bots.mjs - the bots: registry, determinism, no view mutation, legality of every move at every player
// count and under every variant value, Medium against the Python heuristic's recorded decisions,
// Medium's habits on hand-built positions, the archetypes, Hard (timing, budget, timeout fallback,
// sampling under TRADE=optional) and strength checks (Easy < Medium < Hard).
//
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.
//   node tests/bots.mjs                    the default run (a few minutes: the legality sweep, the decision
//                                          match, the hand-built checks, a short strength run)
//   node tests/bots.mjs --full             adds Hard at its real budget to the sweeps and 3x the games
//   node tests/bots.mjs --strength         ONLY the long strength run: Medium v Easy, Hard v Medium and
//                                          Hard v Easy at 2-5 players, with win counts and z-scores
//                                          [--games=N per cell, default 400] [--workers=N, at most 8]
//                                          [--strong=hard:32 --opp=medium --n=4  one cell only, for tuning]
//                                          Run it through simrun:
//                                          python D:/data/pc-health/scripts/simrun.py node tests/bots.mjs --strength
//   node tests/bots.mjs --timing           ONLY Hard's decision times at 2-5 players (p50 / p95 / max)

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createGame, applyAction, viewFor, legalActionsFromView, getActionBlockReason, makeRng, deriveSeed, VARIANTS, rngPick,
  SUITS, playableCards, resolveVariants, deriveParams, shownVoids, determinise,
} from '../src/engine/index.js';
import { getBot, botLevels, registerBot, getFallbackBot } from '../src/bots/index.js';
import { searchAction, samplingView, samplesFor, HARD_SAMPLES, HARD_MIN_SAMPLES, HARD_MAX_ROLLOUTS, HARD_TIME_BUDGET_MS } from '../src/bots/hard.js';
import { mediumChoose } from '../src/bots/medium.js';
import { suite, position, same, RING6 } from './lib.mjs';

const ARGS = process.argv.slice(2);
const flag = (name) => ARGS.includes(`--${name}`);
const numArg = (name, dflt) => { const a = ARGS.find((x) => x.startsWith(`--${name}=`)); return a ? Number(a.split('=')[1]) : dflt; };
const FULL = flag('full');

/** Level ids: any registered bot, `hard:N` (Hard with N worlds per decision) and `hard-fast` (2 worlds). */
function botOf(level) {
  if (level === 'hard-fast') return { id: level, chooseAction: (view, rng) => searchAction(view, rng, { samples: 2 }).action };
  if (/^hard:\d+$/.test(level)) return { id: level, chooseAction: (view, rng) => searchAction(view, rng, { samples: Number(level.slice(5)) }).action };
  return getBot(level);
}
const sameAction = (a, b) => a.type === b.type && a.card === b.card && a.island === b.island;

/** Plays one game; `levels[seat]` names each seat's bot. Bots get the view and their own rng only. */
function playGame({ levels, seed, rules = {}, checkView = true }) {
  const players = levels.length;
  const state = createGame({ seed, players, rules });
  const rngs = Array.from({ length: players }, (_, s) => makeRng(deriveSeed(seed, 'bot', s)));
  let refusals = 0; let illegal = 0; let mutated = 0; let actions = 0;
  while (state.toAct !== null && actions < 3000) {
    const seat = state.toAct;
    const view = viewFor(state, seat);
    const before = checkView ? JSON.stringify(view) : null;
    const act = botOf(levels[seat]).chooseAction(view, rngs[seat]);
    if (checkView && JSON.stringify(view) !== before) mutated++;
    if (!legalActionsFromView(view).some((a) => sameAction(a, act))) illegal++;
    if (getActionBlockReason(state, act) !== null) { refusals++; break; }
    applyAction(state, act, { silent: true });
    actions++;
  }
  return { state, refusals, illegal, mutated, actions, over: state.phase === 'over' && state.result !== null };
}

// ---------- strength: one strong seat against the rest, win credit and margin, z-scores ----------
function strengthChunk({ strong, opp, n, from, to, tag, rules = {} }) {
  let credit = 0; let wins = 0; let shared = 0; let marginSum = 0; let marginSq = 0; let ownSum = 0; let oppSum = 0;
  for (let i = from; i < to; i++) {
    const strongSeat = i % n;
    const r = playGame({ levels: Array.from({ length: n }, (_, s) => (s === strongSeat ? strong : opp)), seed: deriveSeed(tag, n, i), rules, checkView: false });
    const res = r.state.result;
    if (res.winners.includes(strongSeat)) { credit += 1 / res.winners.length; if (res.winners.length === 1) wins++; else shared++; }
    const margin = res.totals[strongSeat] - Math.max(...res.totals.filter((_, s) => s !== strongSeat));
    marginSum += margin; marginSq += margin * margin;
    ownSum += res.totals[strongSeat];
    oppSum += (res.totals.reduce((a, b) => a + b, 0) - res.totals[strongSeat]) / (n - 1);
  }
  return { credit, wins, shared, marginSum, marginSq, ownSum, oppSum, games: to - from };
}

/** Combine chunk results into the numbers the report shows. Base rate is 1/n (a shared win counts 1/winners). */
function summarise(parts, n) {
  const t = parts.reduce((a, p) => ({ credit: a.credit + p.credit, wins: a.wins + p.wins, shared: a.shared + p.shared, marginSum: a.marginSum + p.marginSum, marginSq: a.marginSq + p.marginSq, ownSum: a.ownSum + p.ownSum, oppSum: a.oppSum + p.oppSum, games: a.games + p.games }), { credit: 0, wins: 0, shared: 0, marginSum: 0, marginSq: 0, ownSum: 0, oppSum: 0, games: 0 });
  const g = t.games;
  const p0 = 1 / n;
  const z = (t.credit - g * p0) / Math.sqrt(g * p0 * (1 - p0));
  const mean = t.marginSum / g;
  const sd = Math.sqrt(Math.max(0, t.marginSq / g - mean * mean));
  return { games: g, wins: t.wins, shared: t.shared, credit: t.credit, win: t.credit / g, z, own: t.ownSum / g, opp: t.oppSum / g, margin: mean, marginSe: sd / Math.sqrt(g), marginZ: sd ? mean / (sd / Math.sqrt(g)) : 0 };
}

if (!isMainThread) {
  // A worker of the --strength run: play one chunk, report, and wait to be terminated by the main thread
  // (the rest of this file is the main thread's).
  parentPort.postMessage(strengthChunk(workerData));
  await new Promise(() => {});
}

/** Runs the chunks on up to `workers` worker threads; resolves to the summary. */
async function strengthParallel({ strong, opp, n, games, tag, rules = {}, workers }) {
  const per = Math.ceil(games / workers);
  const jobs = [];
  for (let from = 0; from < games; from += per) jobs.push({ strong, opp, n, from, to: Math.min(games, from + per), tag, rules });
  const parts = await Promise.all(jobs.map((job) => new Promise((resolve, reject) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: job, argv: [] });
    w.once('message', (m) => { w.terminate(); resolve(m); });
    w.once('error', reject);
  })));
  return summarise(parts, n);
}

const fmt = (r) => `${r.wins}+${r.shared}sh/${r.games} = ${(r.win * 100).toFixed(1)}%, z ${r.z.toFixed(1)}, mean total ${r.own.toFixed(2)} v ${r.opp.toFixed(2)} each, margin over best rival ${r.margin >= 0 ? '+' : ''}${r.margin.toFixed(2)} (z ${r.marginZ.toFixed(1)})`;

// ---------- Hard timing ----------
function hardTiming(n, games, level = 'hard') {
  const times = [];
  for (let g = 0; g < games; g++) {
    const state = createGame({ seed: deriveSeed('timing', n, g), players: n });
    const rngs = Array.from({ length: n }, (_, s) => makeRng(deriveSeed('timing', n, g, s)));
    while (state.toAct !== null) {
      const seat = state.toAct;
      const view = viewFor(state, seat);
      const t0 = process.hrtime.bigint();
      const act = botOf(level).chooseAction(view, rngs[seat]);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      applyAction(state, act, { silent: true });
    }
  }
  times.sort((a, b) => a - b);
  const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
  return { n, decisions: times.length, p50: q(0.5), p95: q(0.95), max: times[times.length - 1], mean: times.reduce((a, b) => a + b, 0) / times.length };
}

if (flag('timing')) {
  for (const n of [2, 3, 4, 5]) {
    const t = hardTiming(n, numArg('games', 6));
    console.log(`Hard at ${n} players: ${t.decisions} decisions, p50 ${t.p50.toFixed(1)} ms, p95 ${t.p95.toFixed(1)} ms, max ${t.max.toFixed(1)} ms, mean ${t.mean.toFixed(1)} ms`);
  }
  process.exit(0);
}

if (flag('strength')) {
  const games = numArg('games', 400);
  const workers = Math.min(8, numArg('workers', 8));
  const strArg = (name) => { const a = ARGS.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : null; };
  const cells = strArg('strong') ? [[strArg('strong'), strArg('opp') || 'medium']] : [['medium', 'easy'], ['hard', 'medium'], ['hard', 'easy']];
  const counts = ARGS.some((a) => a.startsWith('--n=')) ? [numArg('n', 4)] : [2, 3, 4, 5];
  console.log(`Strength: one strong seat against the rest, ${games} games per cell, seat rotated; base rate 1/n; z = win credit against 1/n (a shared win counts 1/winners)`);
  for (const [strong, opp] of cells) {
    for (const n of counts) {
      const t0 = Date.now();
      const r = await strengthParallel({ strong, opp, n, games, tag: `str-${strong}-${opp}`, workers });
      console.log(`  ${strong} v ${opp} x${n - 1} at ${n}p: ${fmt(r)}  [${((Date.now() - t0) / 1000).toFixed(0)} s]`);
    }
  }
  process.exit(0);
}

const { check, done } = suite('bots');
const info = (s) => console.log(`  info: ${s}`);

// ---------- 1. registry ----------
{
  const levels = botLevels();
  const ids = levels.map((l) => l.id);
  check('registry: easy, medium and hard are offered', ['easy', 'medium', 'hard'].every((id) => levels.some((l) => l.id === id && l.offered)));
  const sim = ['always-duck', 'win-trades', 'random-moor', 'serpent-hoarder', 'naive'];
  check('registry: the five archetypes are registered and not offered', sim.every((id) => levels.some((l) => l.id === id && !l.offered)));
  check('registry: nothing else is hidden but the plain references high and low', levels.filter((l) => !l.offered).length === sim.length + 2 && levels.some((l) => l.id === 'high') && levels.some((l) => l.id === 'low') && levels.filter((l) => l.offered).length === 3, ids.join(','));
  check('registry: an unknown level is refused with the known list', (() => { try { getBot('genius'); return false; } catch (e) { return /Known:/.test(e.message); } })());
  check('registry: a bot needs an id and a chooseAction', (() => { try { registerBot({ id: 'x' }); return false; } catch { return true; } })());
  check('registry: Hard falls back to Medium, everything else to itself', getFallbackBot('hard').id === 'medium' && getFallbackBot('medium').id === 'medium' && getFallbackBot('easy').id === 'easy');
}

// ---------- 2. determinism and no mutation ----------
{
  const g = createGame({ seed: 77, players: 4 });
  const seat = g.toAct;
  const view = viewFor(g, seat);
  let ok = true;
  for (const id of ['easy', 'medium', 'hard-fast', 'always-duck', 'win-trades', 'random-moor', 'serpent-hoarder', 'naive']) {
    const a = botOf(id).chooseAction(view, { s: 5 });
    const b = botOf(id).chooseAction(view, { s: 5 });
    if (!sameAction(a, b)) ok = false;
  }
  check('determinism: the same view and the same rng give the same action, for every bot (moor)', ok);
  const r1 = { s: 9 }; const r2 = { s: 9 };
  getBot('easy').chooseAction(view, r1);
  check('determinism: a bot advances only the rng it is given', r1.s !== r2.s);
  const rng = makeRng('pick');
  check('determinism: rngPick returns an element', legalActionsFromView(view).some((a) => sameAction(a, rngPick(rng, legalActionsFromView(view)))));
  // The same on a mid-voyage position, and a whole game replays from its seed.
  const a1 = playGame({ levels: ['medium', 'hard-fast', 'naive', 'easy'], seed: 'replay' });
  const a2 = playGame({ levels: ['medium', 'hard-fast', 'naive', 'easy'], seed: 'replay' });
  check('determinism: a whole mixed game replays identically from its seed', same(a1.state.totals, a2.state.totals) && same(a1.state.measures, a2.state.measures));
}

// ---------- 3. legality at every player count and variant ----------
{
  const CHEAP = ['easy', 'medium', 'always-duck', 'win-trades', 'random-moor', 'serpent-hoarder', 'naive', 'high', 'low'];
  const nonDefault = VARIANTS.flatMap((v) => v.values.filter((x) => x !== v.default).map((x) => ({ [v.name]: x })));
  const allOn = Object.assign({}, ...nonDefault);
  const rulesSets = [{}, ...nonDefault, allOn, { MOOR: 'score', TRADE: 'optional' }, { TIE: 'real', SCORING: 'serpents', VOYAGES: 'four' }];
  const per = (rules) => (Object.keys(rules).length === 0 ? (FULL ? 1500 : 500) : (FULL ? 120 : 40));
  const stats = { games: 0, refusals: 0, illegal: 0, mutated: 0, unfinished: 0, seatsByLevel: {} };
  const tally = (r, levels) => {
    stats.games++; stats.refusals += r.refusals; stats.illegal += r.illegal; stats.mutated += r.mutated;
    if (!r.over) stats.unfinished++;
    for (const l of levels) stats.seatsByLevel[l] = (stats.seatsByLevel[l] || 0) + 1;
  };
  for (const n of [2, 3, 4, 5]) {
    for (const rules of rulesSets) {
      const games = per(rules);
      const rng = makeRng(deriveSeed('legal-assign', n, JSON.stringify(rules)));
      for (let i = 0; i < games; i++) {
        const levels = Array.from({ length: n }, () => rngPick(rng, CHEAP));
        tally(playGame({ levels, seed: deriveSeed('leg', n, JSON.stringify(rules), i), rules, checkView: i % 8 === 0 }), levels);
      }
      // Hard (two worlds a decision: legality does not depend on the budget) sits in a seat of mixed tables.
      const hardGames = Object.keys(rules).length === 0 ? (FULL ? 150 : 30) : (FULL ? 25 : 8);
      for (let i = 0; i < hardGames; i++) {
        const levels = Array.from({ length: n }, (_, s) => (s === i % n ? 'hard-fast' : rngPick(rng, CHEAP)));
        tally(playGame({ levels, seed: deriveSeed('leg-hard', n, JSON.stringify(rules), i), rules, checkView: i % 4 === 0 }), levels);
      }
    }
  }
  check(`legality: ${stats.games} mixed bot games (all 4 player counts, std and ${rulesSets.length - 1} variant sets) finish`, stats.unfinished === 0, `${stats.unfinished}`);
  check('legality: no bot ever proposes an action the view does not list, or one the engine refuses', stats.illegal === 0 && stats.refusals === 0, `${stats.illegal} illegal, ${stats.refusals} refused`);
  check('legality: no bot mutates its view', stats.mutated === 0, `${stats.mutated}`);
  const allLevels = [...CHEAP, 'hard-fast'];
  check('legality: every level sat in many seats', allLevels.every((l) => (stats.seatsByLevel[l] || 0) > (l === 'hard-fast' ? 150 : 400)), JSON.stringify(stats.seatsByLevel));
  info(`legality sweep: ${stats.games} games; seats by level ${JSON.stringify(stats.seatsByLevel)}`);
  // 500 games per player count for each cheap level on its own (zero refusals), standard rules.
  let own = 0; let bad = 0;
  for (const level of CHEAP) {
    for (const n of [2, 3, 4, 5]) {
      for (let i = 0; i < (FULL ? 500 : 120); i++) {
        const r = playGame({ levels: Array(n).fill(level), seed: deriveSeed('own', level, n, i), checkView: false });
        own++; if (!r.over || r.illegal || r.refusals) bad++;
      }
    }
  }
  check(`legality: ${own} all-one-level games (each cheap level at 2-5 players) have no illegal or refused move`, bad === 0, `${bad}`);
}

// ---------- 4. Medium against the Python heuristic's recorded decisions ----------
{
  const fx = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/python-bot-decisions.json', import.meta.url)), 'utf8'));
  const AB = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn';
  const cardOf = (c) => `${SUITS[Math.floor(AB.indexOf(c) / 10)]}-${(AB.indexOf(c) % 10) + 1}`;
  const charOf = (card) => AB[SUITS.indexOf(card.slice(0, card.indexOf('-'))) * 10 + Number(card.slice(card.indexOf('-') + 1)) - 1];
  const rules = resolveVariants({});
  const params = deriveParams(rules, 4);
  const MODE = { L: 'lead', F: 'follow', T: 'trade', D: 'discard' };
  const ringOf = (g) => [...g].map((d) => SUITS[Number(d)]);

  const tally = { plays: 0, exactPython: 0, ownChoiceHeuristic: 0, inCanonical: 0, rngTie: 0, orderTie: 0, legalSetMismatch: 0, detMismatch: 0, rngOutside: 0, uncovered: 0, rngDrawsChecked: 0 };
  const byTag = {};
  let mismatchSample = [];
  fx.play.forEach((r, idx) => {
    tally.plays++;
    const hand = [...r.h].map(cardOf);
    const ring = ringOf(r.g);
    const led = r.l === '-' ? null : SUITS[Number(r.l)];
    const ships = [r.i, null, null, null];
    const trick = led === null ? null : { ledSuit: led, plays: [...Array(r.p.length / 2).keys()].map((j) => ({ seat: j + 1, card: cardOf(r.p[2 * j]), mode: MODE[r.p[2 * j + 1]] })) };
    const ctx = { seat: 0, hand, trick, params, rules, ring, ships, phase: 'play' };
    const legal = playableCards(hand, led, ring[r.i], rules).map((card) => ({ type: 'play', card }));
    if (!same([...legal.map((a) => charOf(a.card))].sort(), [...r.c].sort())) { tally.legalSetMismatch++; return; }
    const canon = new Set(r.k);
    const allowed = new Set(r.a || r.k);
    const det = charOf(mediumChoose(ctx, legal, null).card);
    byTag[r.t] = (byTag[r.t] || 0) + 1;
    if (!canon.has(det)) { tally.detMismatch++; if (mismatchSample.length < 5) mismatchSample.push(`#${idx} ${r.t} hand ${r.h} got ${det} want ${r.k}`); return; }
    if (canon.size === 1) tally.exactPython++;
    if (r.y !== undefined) { if (allowed.has(r.y) && (allowed.size > 1 || det === r.y)) tally.ownChoiceHeuristic++; }
    tally.inCanonical++;
    if (allowed.size > 1) {
      if (canon.size > 1) tally.rngTie++; else tally.orderTie++;
      const rng = makeRng(`match-${idx}`);
      const seen = new Set();
      for (let d = 0; d < 48; d++) {
        const c = charOf(mediumChoose(ctx, legal, rng).card);
        tally.rngDrawsChecked++;
        if (!allowed.has(c)) { tally.rngOutside++; break; }
        seen.add(c);
      }
      if (seen.size < allowed.size) tally.uncovered++;
    }
  });
  const moorTally = { moors: 0, detOutside: 0, rngOutside: 0, uncovered: 0, pythonInside: 0 };
  fx.moor.forEach((r, idx) => {
    moorTally.moors++;
    const hand = [...r.h].map(cardOf);
    const ring = ringOf(r.g);
    const tied = new Set([...r.t].map((d) => SUITS[Number(d)]));
    const allowed = new Set(ring.map((c, i) => (tied.has(c) ? i : -1)).filter((i) => i >= 0));
    const legal = Array.from({ length: 8 }, (_, island) => ({ type: 'moor', island }));
    const ctx = { seat: 0, hand, trick: null, params, rules, ring, ships: [null, null, null, null], phase: 'moor' };
    if (allowed.has(r.y)) moorTally.pythonInside++;
    if (!allowed.has(mediumChoose(ctx, legal, null).island)) moorTally.detOutside++;
    const rng = makeRng(`moor-${idx}`);
    const seen = new Set();
    for (let d = 0; d < 96; d++) {
      const i = mediumChoose(ctx, legal, rng).island;
      if (!allowed.has(i)) { moorTally.rngOutside++; break; }
      seen.add(i);
    }
    if (seen.size < allowed.size) moorTally.uncovered++;
  });
  check(`decision-match: all ${tally.plays} recorded play decisions are legal sets the engine agrees with`, tally.legalSetMismatch === 0, `${tally.legalSetMismatch} differ`);
  check('decision-match: Medium (no rng) returns a card the Python can return, on every recorded decision', tally.detMismatch === 0, `${tally.detMismatch}: ${mismatchSample.join(' | ')}`);
  check('decision-match: Medium (with an rng) never returns a card outside the Python\'s possible set', tally.rngOutside === 0, `${tally.rngOutside}`);
  check('decision-match: with an rng Medium reaches every card the Python can return (ties are ties)', tally.uncovered === 0, `${tally.uncovered}`);
  check('decision-match: the Python\'s own choice in its own heuristic games is in that possible set (script self-check)', tally.ownChoiceHeuristic === fx.play.filter((r) => r.y !== undefined).length, `${tally.ownChoiceHeuristic}`);
  check(`decision-match: all ${moorTally.moors} Python moorings are islands of a longest cargo, and so are Medium's (with and without an rng, all of them reached)`, moorTally.detOutside === 0 && moorTally.rngOutside === 0 && moorTally.uncovered === 0 && moorTally.pythonInside === moorTally.moors, JSON.stringify(moorTally));
  const tags = Object.keys(byTag);
  const need = ['lead-one', 'lead-low', 'follow-clean-win', 'follow-duck-serp', 'follow-duck-high', 'follow-forced-win', 'trade-clean-win', 'trade-duck-serp', 'trade-duck-high', 'trade-forced-win', 'discard-ten', 'discard-one', 'discard-high'];
  check('decision-match: every branch of the heuristic is covered at least 25 times', need.every((t) => (byTag[t] || 0) >= 25), JSON.stringify(byTag));
  check('decision-match: the fixture is the Python\'s (positions from heuristic games and from random games)', fx.play.some((r) => r.s === 'h') && fx.play.some((r) => r.s === 'r') && fx.meta.sim.includes('unchanged'));
  info(`decision-match: ${tally.plays} play decisions + ${moorTally.moors} moorings from ${fx.meta.voyagesPerCount.heuristic * 4} heuristic and ${fx.meta.voyagesPerCount.random * 4} random voyages; ${tally.exactPython} have one possible card and Medium plays it; ${tally.rngTie} are rng ties (Python's rng.choice), ${tally.orderTie} are order ties (Python's set order); ${tally.rngDrawsChecked} rng draws checked; mismatches: ${tally.detMismatch + tally.rngOutside + tally.legalSetMismatch + moorTally.detOutside + moorTally.rngOutside}`);
  info(`decision-match branches: ${JSON.stringify(byTag)}`);
}

// ---------- 5. Medium's habits on hand-built positions (and the variant extensions) ----------
{
  const med = (g, seat, rng = null) => getBot('medium').chooseAction(viewFor(g, seat), rng);
  const moor = createGame({ seed: 3, players: 4, firstDealer: 3, deals: [{ hands: [
    ['silk-1', 'silk-2', 'silk-3', 'silk-4', 'silk-5', 'pearls-1', 'pearls-2', 'spice-1', 'amber-1', 'amber-2'],
    ['silk-6', 'silk-7', 'silk-8', 'silk-9', 'silk-10', 'pearls-3', 'pearls-4', 'spice-2', 'amber-3', 'amber-4'],
    ['pearls-5', 'pearls-6', 'pearls-7', 'pearls-8', 'pearls-9', 'pearls-10', 'spice-3', 'spice-4', 'amber-5', 'amber-6'],
    ['spice-5', 'spice-6', 'spice-7', 'spice-8', 'spice-9', 'spice-10', 'amber-7', 'amber-8', 'amber-9', 'amber-10']],
    ring: RING6 }] });
  check('medium: moors at an island of the cargo it holds most of', moor.ring[med(moor, 0).island] === 'silk');
  // A 5-5 split: it picks one of the two longest cargoes, and with an rng reaches both.
  const split = createGame({ seed: 3, players: 4, firstDealer: 3, deals: [{ hands: [
    ['silk-1', 'silk-2', 'silk-3', 'silk-4', 'silk-5', 'pearls-1', 'pearls-2', 'pearls-3', 'pearls-4', 'pearls-5'],
    ['silk-6', 'silk-7', 'silk-8', 'silk-9', 'silk-10', 'pearls-6', 'pearls-7', 'amber-3', 'amber-4', 'spice-2'],
    ['spice-3', 'spice-4', 'amber-5', 'amber-6', 'amber-7', 'amber-8', 'amber-9', 'amber-10', 'spice-5', 'spice-6'],
    ['spice-7', 'spice-8', 'spice-9', 'spice-10', 'pearls-8', 'pearls-9', 'pearls-10', 'amber-1', 'amber-2', 'spice-1']],
    ring: RING6 }] });
  const seenCargoes = new Set();
  const rngM = makeRng('split');
  for (let i = 0; i < 40; i++) seenCargoes.add(split.ring[med(split, 0, rngM).island]);
  check('medium: a tie between longest cargoes is broken at random (both reached), never outside them', seenCargoes.size === 2 && seenCargoes.has('silk') && seenCargoes.has('pearls'));
  check('medium: with no rng the same tie goes to the first cargo in cargo order', split.ring[med(split, 0).island] === 'pearls');

  const lead = position({ hands: [['spice-1', 'spice-5', 'pearls-4'], ['spice-2', 'pearls-2', 'amber-2'], ['spice-3', 'pearls-3', 'amber-3'], ['spice-4', 'pearls-5', 'amber-4']], leader: 0 });
  check('medium: leads a 1 when it holds one', med(lead, 0).card === 'spice-1');
  const lead2 = position({ hands: [['spice-3', 'spice-5', 'pearls-4'], ['spice-2', 'pearls-2', 'amber-2'], ['spice-4', 'pearls-3', 'amber-3'], ['spice-6', 'pearls-5', 'amber-4']], leader: 0 });
  check('medium: with no 1, leads the lowest card of its longest cargo', med(lead2, 0).card === 'spice-3');
  const clean = position({ hands: [['spice-3', 'pearls-4', 'pearls-5'], ['spice-4', 'spice-8', 'amber-2'], ['spice-2', 'pearls-3', 'amber-3'], ['spice-5', 'pearls-6', 'amber-4']], leader: 0 });
  applyAction(clean, { type: 'play', card: 'spice-3' });
  check('medium: takes a clean trick with the lowest winner', med(clean, 1).card === 'spice-4');
  const dirty = position({ hands: [['spice-1', 'pearls-4', 'pearls-5'], ['spice-4', 'spice-10', 'amber-2'], ['spice-2', 'pearls-3', 'amber-3'], ['spice-5', 'pearls-6', 'amber-4']], leader: 0 });
  applyAction(dirty, { type: 'play', card: 'spice-1' });
  check('medium: a trick with a serpent, nothing to duck with: it wins as cheaply as it can', med(dirty, 1).card === 'spice-4');
  const duck = position({ hands: [['spice-10', 'pearls-4', 'pearls-5'], ['spice-1', 'spice-3', 'amber-2'], ['spice-2', 'pearls-3', 'amber-3'], ['spice-5', 'pearls-6', 'amber-4']], leader: 0 });
  applyAction(duck, { type: 'play', card: 'spice-10' });
  check('medium: a dirty trick it cannot win: it ducks, shedding its serpent card first', med(duck, 1).card === 'spice-1');
  const duck2 = position({ hands: [['spice-10', 'pearls-4', 'pearls-5'], ['spice-4', 'spice-3', 'amber-2'], ['spice-2', 'pearls-3', 'amber-3'], ['spice-5', 'pearls-6', 'amber-4']], leader: 0 });
  applyAction(duck2, { type: 'play', card: 'spice-10' });
  check('medium: ducking with no serpent to shed: the highest loser', med(duck2, 1).card === 'spice-4');
  const disc = position({ hands: [['spice-5', 'pearls-4', 'pearls-5'], ['amber-10', 'amber-3', 'silk-2'], ['spice-2', 'pearls-3', 'amber-5'], ['spice-6', 'pearls-6', 'amber-4']], ships: [0, 2, 0, 0], leader: 0 });
  applyAction(disc, { type: 'play', card: 'spice-5' });
  check('medium: a discard sheds a 10 first', med(disc, 1).card === 'amber-10');
  const disc1 = position({ hands: [['spice-5', 'pearls-4', 'pearls-5'], ['amber-1', 'amber-3', 'silk-2'], ['spice-2', 'pearls-3', 'amber-5'], ['spice-6', 'pearls-6', 'amber-4']], ships: [0, 2, 0, 0], leader: 0 });
  applyAction(disc1, { type: 'play', card: 'spice-5' });
  check('medium: no 10 to discard: a 1', med(disc1, 1).card === 'amber-1');
  const disc3 = position({ hands: [['spice-5', 'pearls-4', 'pearls-5'], ['amber-6', 'amber-3', 'silk-2'], ['spice-2', 'pearls-3', 'amber-5'], ['spice-6', 'pearls-6', 'amber-4']], ships: [0, 2, 0, 0], leader: 0 });
  applyAction(disc3, { type: 'play', card: 'spice-5' });
  check('medium: no 10 or 1 to discard: the highest card', med(disc3, 1).card === 'amber-6');
  // A trade: island silk (index 1), void in spice, silk 3 and silk 9 against a spice 5 lead (clean): the lowest winner is 9.
  const trade = position({ hands: [['spice-5', 'pearls-4', 'pearls-5'], ['silk-3', 'silk-9', 'amber-2'], ['spice-2', 'pearls-3', 'amber-5'], ['spice-6', 'pearls-6', 'amber-4']], ships: [0, 1, 0, 0], leader: 0 });
  applyAction(trade, { type: 'play', card: 'spice-5' });
  check('medium: a trade on a clean trick it can win: the lowest winning rank', med(trade, 1).card === 'silk-9');

  // ---- variants (beyond the Python) ----
  // TRADE=optional: void in spice, island silk with a silk 10 and an amber 2, a serpent already in the trick: duck with the amber discard.
  const optHands = [['spice-1', 'pearls-4', 'pearls-5'], ['silk-10', 'amber-2', 'amber-3'], ['spice-2', 'pearls-3', 'amber-5'], ['spice-5', 'pearls-6', 'amber-4']];
  const mand = position({ hands: optHands, ships: [0, 1, 0, 0], leader: 0 });
  applyAction(mand, { type: 'play', card: 'spice-1' });
  const opt = position({ hands: optHands, ships: [0, 1, 0, 0], leader: 0, rules: { TRADE: 'optional' } });
  applyAction(opt, { type: 'play', card: 'spice-1' });
  check('variant trade=mandatory: the forced 10 must be traded (one legal card, so the engine plays it)', mand.tricks.length >= 1 && mand.tricks[0].plays[1].card === 'silk-10' && mand.tricks[0].plays[1].mode === 'trade');
  check('variant trade=optional: on a dirty trick it discards instead of trading its 10', legalActionsFromView(viewFor(opt, 1)).length === 3 && ['amber-2', 'amber-3'].includes(med(opt, 1).card));
  const optClean = position({ hands: [['spice-5', 'pearls-4', 'pearls-5'], ['silk-8', 'amber-2', 'amber-3'], ['spice-2', 'pearls-3', 'amber-5'], ['spice-6', 'pearls-6', 'amber-4']], ships: [0, 1, 0, 0], leader: 0, rules: { TRADE: 'optional' } });
  applyAction(optClean, { type: 'play', card: 'spice-5' });
  check('variant trade=optional: on a clean trick it still takes it cheaply with a winning trade', med(optClean, 1).card === 'silk-8');
  // TIE=real: seat 1 trades silk-7 (counts as spice 7); seat 2 holds spice-7 and spice-9: real 7 now wins, so 7 is the lowest winner.
  const tieHands = [['spice-5', 'pearls-4', 'pearls-5'], ['silk-7', 'amber-2', 'amber-3'], ['spice-7', 'spice-9', 'amber-5'], ['spice-6', 'pearls-6', 'amber-4']];
  const tieFirst = position({ hands: tieHands, ships: [0, 1, 0, 0], leader: 0 });
  const tieReal = position({ hands: tieHands, ships: [0, 1, 0, 0], leader: 0, rules: { TIE: 'real' } });
  for (const g of [tieFirst, tieReal]) applyAction(g, { type: 'play', card: 'spice-5' }); // seat 1's lone silk 7 is traded by the engine
  check('variant tie=first: a spice 7 only ties the traded 7 and loses, so it needs the 9 to win', med(tieFirst, 2).card === 'spice-9');
  check('variant tie=real: a spice 7 beats the traded 7, so it wins cheaply with the 7', med(tieReal, 2).card === 'spice-7');
  // SCORING=serpents: a clean trick is worth nothing, so it ducks instead of winning.
  const scHands = [['spice-5', 'pearls-4', 'pearls-5'], ['spice-8', 'spice-2', 'amber-3'], ['spice-4', 'pearls-3', 'amber-5'], ['spice-6', 'pearls-6', 'amber-4']];
  const scStd = position({ hands: scHands, leader: 0 });
  const scSer = position({ hands: scHands, leader: 0, rules: { SCORING: 'serpents' } });
  for (const g of [scStd, scSer]) applyAction(g, { type: 'play', card: 'spice-5' });
  check('variant scoring=tricks: a clean trick is won with the lowest winner', med(scStd, 1).card === 'spice-8');
  check('variant scoring=serpents: tricks score nothing, so it ducks', med(scSer, 1).card === 'spice-2');
  // MOOR=score: the engine asks the trailing player last; Medium moors by its own hand whenever it is asked.
  const ms = createGame({ seed: 12, players: 3, rules: { MOOR: 'score' }, firstDealer: 0 });
  check('variant moor=score: Medium moors when asked, at any mooring position', (() => { let ok = true; while (ms.phase === 'moor') { const a = getBot('medium').chooseAction(viewFor(ms, ms.toAct), { s: 1 }); ok = ok && a.type === 'moor'; applyAction(ms, a); } return ok; })());
}

// ---------- 6. the archetypes ----------
{
  const view = (g, seat) => viewFor(g, seat);
  const hands = [['spice-3', 'spice-9', 'pearls-4'], ['spice-4', 'spice-8', 'amber-2'], ['spice-2', 'pearls-3', 'amber-3'], ['spice-5', 'pearls-6', 'amber-4']];
  const g0 = position({ hands, leader: 0 });
  check('naive: leads its highest card', getBot('naive').chooseAction(view(g0, 0), { s: 1 }).card === 'spice-9');
  const mooring = createGame({ seed: 4, players: 3 });
  check('naive: moors at island 1 (index 0)', getBot('naive').chooseAction(viewFor(mooring, mooring.toAct), { s: 1 }).island === 0);
  const g1 = position({ hands, leader: 0 }); applyAction(g1, { type: 'play', card: 'spice-3' });
  check('naive: wins with the lowest card that beats the trick', getBot('naive').chooseAction(view(g1, 1), { s: 1 }).card === 'spice-4');
  const g2 = position({ hands: [['spice-9', 'spice-8', 'pearls-4'], ['spice-4', 'spice-6', 'amber-2'], ['spice-2', 'pearls-3', 'amber-3'], ['spice-5', 'pearls-6', 'amber-4']], leader: 0 }); applyAction(g2, { type: 'play', card: 'spice-9' });
  check('naive: cannot win, plays its lowest legal card', getBot('naive').chooseAction(view(g2, 1), { s: 1 }).card === 'spice-4');
  check('always-duck: a clean trick it could win with a 4 it ducks high instead (Medium would win)', (() => { const g = position({ hands: [['spice-3', 'pearls-4', 'pearls-5'], ['spice-1', 'spice-4', 'amber-2'], ['spice-2', 'pearls-3', 'amber-3'], ['spice-5', 'pearls-6', 'amber-4']], leader: 0 }); applyAction(g, { type: 'play', card: 'spice-3' }); return getBot('always-duck').chooseAction(view(g, 1), { s: 1 }).card === 'spice-1' && getBot('medium').chooseAction(view(g, 1), null).card === 'spice-4'; })());
  check('always-duck: forced to win, wins as cheaply as it can', (() => { const g = position({ hands: [['spice-3', 'pearls-4', 'pearls-5'], ['spice-5', 'spice-9', 'amber-2'], ['spice-2', 'pearls-3', 'amber-3'], ['spice-6', 'pearls-6', 'amber-4']], leader: 0 }); applyAction(g, { type: 'play', card: 'spice-3' }); return getBot('always-duck').chooseAction(view(g, 1), { s: 1 }).card === 'spice-5'; })());
  // win-trades: a dirty trick (seat 1 discarded an amber 10 onto a spice 5), seat 2 on island silk holds silk 2 and silk 8.
  const gt = position({ hands: [['spice-5', 'pearls-4', 'pearls-5'], ['amber-10', 'amber-3', 'pearls-1'], ['silk-2', 'silk-8', 'amber-5'], ['spice-6', 'pearls-6', 'amber-4']], ships: [0, 0, 1, 0], leader: 0 });
  applyAction(gt, { type: 'play', card: 'spice-5' });
  applyAction(gt, { type: 'play', card: 'amber-10' });
  check('win-trades: on a dirty trick it trades the lowest card that wins (silk 8) where Medium ducks with silk 2', gt.toAct === 2 && getBot('win-trades').chooseAction(view(gt, 2), { s: 1 }).card === 'silk-8' && getBot('medium').chooseAction(view(gt, 2), null).card === 'silk-2');
  const gt2 = position({ hands: [['spice-9', 'pearls-4', 'pearls-5'], ['silk-2', 'silk-6', 'silk-8'], ['spice-2', 'pearls-3', 'amber-5'], ['spice-1', 'pearls-1', 'amber-4']], ships: [0, 1, 0, 0], leader: 0 });
  applyAction(gt2, { type: 'play', card: 'spice-9' });
  check('win-trades: when no trade card can win it plays as Medium does', getBot('win-trades').chooseAction(view(gt2, 1), { s: 1 }).card === getBot('medium').chooseAction(view(gt2, 1), null).card);
  const ids = new Set();
  const rr = makeRng('rm');
  for (let i = 0; i < 80; i++) ids.add(getBot('random-moor').chooseAction(viewFor(mooring, mooring.toAct), rr).island);
  check('random-moor: moors anywhere (at least 6 of the 8 islands in 80 draws)', ids.size >= 6, `${ids.size}`);
  const gh = position({ hands: [['spice-1', 'spice-5', 'pearls-4'], ['spice-2', 'pearls-2', 'amber-2'], ['spice-3', 'pearls-3', 'amber-3'], ['spice-4', 'pearls-5', 'amber-4']], leader: 0 });
  check('serpent-hoarder: keeps its 1 (Medium would lead it) and leads its lowest quiet card', getBot('serpent-hoarder').chooseAction(view(gh, 0), { s: 1 }).card !== 'spice-1' && getBot('medium').chooseAction(view(gh, 0), null).card === 'spice-1');
  const gh2 = position({ hands: [['spice-9', 'pearls-4', 'pearls-5'], ['spice-1', 'spice-10', 'amber-2'], ['spice-2', 'pearls-3', 'amber-3'], ['spice-5', 'pearls-6', 'amber-4']], leader: 0 }); applyAction(gh2, { type: 'play', card: 'spice-9' });
  check('serpent-hoarder: forced to follow with serpent cards only, it plays one', ['spice-1', 'spice-10'].includes(getBot('serpent-hoarder').chooseAction(view(gh2, 1), { s: 1 }).card));
}

// ---------- 7. imports: the bots see views, never the game ----------
{
  const dir = fileURLToPath(new URL('../src/bots/', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  const bad = [];
  for (const f of files) {
    const text = readFileSync(dir + f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    if (/\b(createGame|startGame|viewFor)\s*\(/.test(text)) bad.push(`${f} builds or views a game`);
    if (/from '\.\.\/ui\//.test(text)) bad.push(`${f} imports the UI`);
  }
  check('bots: no bot file creates a game or calls viewFor (they receive a view)', bad.length === 0, bad.join('; '));
}

// ---------- 8. Hard ----------
{
  check('hard: sample counts shrink as candidates grow, within the bounds', samplesFor(1) === HARD_SAMPLES && samplesFor(10) >= HARD_MIN_SAMPLES && samplesFor(10) <= HARD_SAMPLES && samplesFor(10000) === HARD_MIN_SAMPLES);
  check('hard: the rollout budget a decision may use is bounded by HARD_MAX_ROLLOUTS (or the minimum samples)', [2, 3, 8, 10, 13].every((k) => samplesFor(k) * k <= Math.max(HARD_MAX_ROLLOUTS, HARD_MIN_SAMPLES * k)));
  const g = createGame({ seed: 31, players: 3 });
  const v = viewFor(g, g.toAct);
  const a = searchAction(v, { s: 3 }, { samples: 8 });
  const b = searchAction(v, { s: 3 }, { samples: 8 });
  check('hard: a search is reproducible from its rng, and scores one entry per legal action', sameAction(a.action, b.action) && a.scores.length === legalActionsFromView(v).length && same(a.scores, b.scores));
  check('hard: at a mooring it chooses an island (8 candidates searched)', a.action.type === 'moor' && a.scores.length === 8 && a.worlds === 8);
  const single = position({ players: 3, hands: [['spice-5'], ['spice-3'], ['spice-2']], leader: 0 });
  check('hard: a single legal action is returned at once', searchAction(viewFor(single, 0), { s: 1 }).scores.length === 1);

  // The caller's clock: expired from the start -> Medium's choice; expired after 4 worlds -> a search of 4.
  const mid = position({ hands: [['spice-1', 'spice-5', 'pearls-4', 'amber-5'], ['spice-2', 'pearls-2', 'amber-2', 'silk-4'], ['spice-3', 'pearls-3', 'amber-3', 'silk-5'], ['spice-4', 'pearls-5', 'amber-4', 'silk-6']], leader: 0 });
  const mv = viewFor(mid, 0);
  const instant = searchAction(mv, { s: 1 }, { expired: () => true });
  check('hard timeout: out of time before any world, it returns Medium\'s choice', sameAction(instant.action, getBot('medium').chooseAction(mv, null)) && instant.worlds === 0);
  let calls = 0;
  const after4 = searchAction(mv, { s: 1 }, { expired: () => calls++ >= 4 });
  check('hard timeout: out of time after 4 worlds, it uses the 4 it has', after4.worlds === 4);
  let c2 = 0;
  const after2 = searchAction(mv, { s: 1 }, { expired: () => c2++ >= 2 });
  check('hard timeout: out of time with fewer than 3 worlds done, Medium\'s choice', after2.worlds === 2 && sameAction(after2.action, getBot('medium').chooseAction(mv, null)));
  check('hard timeout: the bot object takes the caller\'s clock as ctx.expired', sameAction(getBot('hard').chooseAction(mv, { s: 1 }, { expired: () => true }), getBot('medium').chooseAction(mv, null)));
  check('hard timeout: the budget constant is a sane number of milliseconds', HARD_TIME_BUDGET_MS >= 500 && HARD_TIME_BUDGET_MS <= 5000);

  // TRADE=optional: a discard does not show an empty island cargo (engine shownVoids, R9.9 / R13.3), so no world Hard samples may rule out a cargo a seat really holds.
  let rawWrong = 0; let sampWrong = 0; let looked = 0; let worldsBad = 0;
  for (let i = 0; i < (FULL ? 60 : 24); i++) {
    const n = 3 + (i % 3);
    const state = createGame({ seed: deriveSeed('opt', i), players: n, rules: { TRADE: 'optional' } });
    const rngs = Array.from({ length: n }, (_, s) => makeRng(deriveSeed('opt-bot', i, s)));
    let decisions = 0;
    while (state.toAct !== null) {
      const seat = state.toAct;
      const view = viewFor(state, seat);
      if (state.phase === 'play' && decisions++ % 5 === 0) {
        const raw = shownVoids(view);
        const samp = shownVoids(samplingView(view));
        for (let o = 0; o < n; o++) {
          if (o === seat) continue;
          looked++;
          if (raw[o].some((c) => state.hands[o].some((x) => x.startsWith(`${c}-`)))) rawWrong++;
          if (samp[o].some((c) => state.hands[o].some((x) => x.startsWith(`${c}-`)))) sampWrong++;
        }
        const w = determinise(samplingView(view), makeRng(`w${i}${decisions}`));
        for (let o = 0; o < n; o++) if (o !== seat && w.hands[o].length !== state.hands[o].length) worldsBad++;
      }
      applyAction(state, getBot('easy').chooseAction(view, rngs[seat]), { silent: true });
    }
  }
  check('hard sampling (trade=optional): neither the engine voids nor the sampling view ever rule out a card a seat really holds', rawWrong === 0 && sampWrong === 0 && worldsBad === 0, `${sampWrong} wrong voids, ${worldsBad} bad worlds in ${looked} seat checks`);

  // Time per decision at 5 players with the real budget.
  const t5 = hardTiming(5, FULL ? 8 : 3);
  check('hard: a decision at 5 players has p95 under 250 ms in Node', t5.p95 < 250, `p50 ${t5.p50.toFixed(1)}, p95 ${t5.p95.toFixed(1)}, max ${t5.max.toFixed(1)} ms`);
  info(`Hard at 5 players (real budget, ${t5.decisions} decisions): p50 ${t5.p50.toFixed(1)} ms, p95 ${t5.p95.toFixed(1)} ms, max ${t5.max.toFixed(1)} ms, mean ${t5.mean.toFixed(1)} ms`);
}

// ---------- 9. strength (a short run; the long one is --strength) ----------
{
  const games = FULL ? 400 : 240;
  const rows = [];
  for (const n of [2, 3, 4, 5]) {
    const m = summarise([strengthChunk({ strong: 'medium', opp: 'easy', n, from: 0, to: games, tag: 'm-v-e' })], n);
    rows.push(`medium v easy at ${n}p: ${fmt(m)}`);
    check(`strength: one Medium against ${n - 1} Easy wins clearly more than 1/${n} at ${n} players (${games} games)`, m.z > 3, fmt(m));
    check(`strength: and its mean total is above an Easy seat's at ${n} players`, m.own > m.opp, `${m.own.toFixed(2)} v ${m.opp.toFixed(2)}`);
  }
  // Hard (12 worlds a decision, a quarter of the real budget, to keep the default run short) against Medium and Easy.
  const hGames = FULL ? 160 : 60;
  for (const n of [2, 3, 4, 5]) {
    const hm = summarise([strengthChunk({ strong: 'hard:12', opp: 'medium', n, from: 0, to: hGames, tag: 'h-v-m' })], n);
    rows.push(`hard:12 v medium at ${n}p: ${fmt(hm)}`);
    check(`strength: one Hard (12 worlds) against ${n - 1} Medium wins clearly more than 1/${n} at ${n} players (${hGames} games)`, hm.z > 3, fmt(hm));
  }
  const h = summarise([strengthChunk({ strong: 'hard:12', opp: 'easy', n: 4, from: 0, to: hGames, tag: 'h-v-e' })], 4);
  check(`strength: one Hard (12 worlds) against three Easy wins well over a quarter of games (${hGames} games)`, h.z > 3, fmt(h));
  for (const r of rows) info(r);
  info('the long run, with the real Hard budget and 400 games a cell: node tests/bots.mjs --strength (through simrun)');
}

done();
