// sim.mjs - headless bot-v-bot simulator for balance work.
//
//   node tests/sim.mjs --players=4 --seats=medium,hard,easy,medium --games=2000 --seed=1
//        [--rotate=1] [--jitter=5] [--threads=8] [--variant.TIE=real ...] [--const.X=Y] [--out=path]
//
//  --players=2..5       table size. Default: the number of --seats entries (or 4).
//  --seats=a,b,c,d      bot per seat. One entry fills every seat. Default: medium for every seat.
//                       Ids from the bot registry: easy | medium | hard | high | low, plus
//                         hard:N   Hard at N sampled worlds per decision (plain "hard" = the real budget)
//                         moor-fewest   (simulator only) Medium's card play, but it moors at the cargo it holds fewest of
//                       The archetypes always-duck, win-trades, random-moor, serpent-hoarder, naive are also valid.
//  --games=N            games to play.
//  --seed=S             run seed; game i uses deriveSeed(S, 'game', i); bot and jitter streams are separate
//                       from the game's deal RNG, so a bot's choices never change the deals.
//  --rotate=1|0         1 (default): in game i seat s plays the bot listed at (s + i) mod n, so a bot's strength
//                       is spread over every seat and seat effects cancel out of bot results. 0: list used as given.
//  --jitter=N           N percent chance per decision of playing a random legal action instead of the bot's choice.
//  --variant.CODE=VALUE a rules switch from the VARIANTS table, by code or name (moor, tie, trade, voyages, scoring; e.g.
//                       --variant.moor=score); the engine's resolveVariants throws on a bad name or value.
//  --const.NAME=VALUE   a numeric/JSON entry of the engine's CONSTANTS object (a probe, e.g. --const.TRICK_POINTS=2).
//  --threads=N          worker threads (default 1). Results are identical for any N: games are independent.
//  --out=path           JSON output (default tests/tmp/sim-<auto-name>.json).
//
// Deterministic for a fixed argument list: the JSON holds no clock values (timing goes to stderr).
//
// Record per game (compact; explained in sim-report.mjs):
//   n, lv (bot by seat), fd (first dealer), tot (final totals), win (winners after the final-voyage tiebreak),
//   tied (seats on the top total), tb (the tiebreak separated them),
//   h: one entry per voyage; arrays are by seat unless noted:
//      s score, tw tricks won, sp serpents taken, tp tricks played (number), tt tricks won by a trade card (number),
//      tr trades, tl trades that won the trick, f1 forced 10s (strict: the 10 was the only island-cargo card held),
//      ds discards, sl sails, ti tricks with a tie (number), t1 / t2 ties broken by first played / by a real card,
//      tm tricks where the tie rule changes the winner (a trade card played before a real card of the same number, number),
//      ca clean tricks (number, no serpent in them), tc trades that won a clean trick (the windfall, number),
//      ts trades that won a trick holding serpents (number), t10 trades of a 10, any 10 (number), nd trades where every
//      trade card would have won (number, no duck possible), dl dealer (number), si start island, tf start island is the
//      first of a twin pair (next island clockwise has the same cargo, the Python's definition), tb start island is the
//      second of a twin pair (previous island has the same cargo), mp mooring position (0 = moors first),
//      hs deal strength [sum of ranks, cards of 8+, serpent cards, serpents, longest cargo, cards held of the
//      moored cargo, moored at a longest cargo (1/0)].

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import {
  createGame, applyAction, viewFor, legalActionsFromView, makeRng, deriveSeed, rngInt, rngNext, rngPick,
  VARIANTS, CONSTANTS, resolveVariants, cardSuit, cardValue, cardSerpents, SUITS,
} from '../src/engine/index.js';
import { getBot, botLevels } from '../src/bots/index.js';
import { chooseMediumFromView } from '../src/bots/medium.js';
import { searchAction } from '../src/bots/hard.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

// ---------- bots ----------
const isHardN = (id) => /^hard:\d+$/.test(id);

/**
 * Simulator-only bots (never in the game): the probes that need a habit the shipped archetypes do not have.
 *   moor-fewest  Medium's card play, but it moors at an island of a cargo it holds the FEWEST cards of (a random one of
 *                them), the opposite of Medium's own mooring policy. Measures what mooring at the longest cargo is worth.
 */
const SIM_BOTS = {
  'moor-fewest': {
    id: 'moor-fewest',
    chooseAction(view, rng) {
      const legal = legalActionsFromView(view);
      if (legal[0].type !== 'moor') return chooseMediumFromView(view, rng);
      const count = (c) => view.hand.filter((x) => cardSuit(x) === c).length;
      const fewest = Math.min(...SUITS.map(count));
      const islands = legal.filter((a) => count(view.ring[a.island]) === fewest);
      return rngPick(rng, islands);
    },
  },
};

/** The bot object for a --seats name. */
export function simBot(id) {
  if (isHardN(id)) { const samples = Number(id.slice(5)); return { id, chooseAction: (view, rng) => searchAction(view, rng, { samples }).action }; }
  return SIM_BOTS[id] || getBot(id);
}

// ---------- arguments ----------
export function parseArgs(argv) {
  const a = { players: null, seats: null, games: 1000, seed: 1, jitter: 0, rotate: true, threads: 1, out: null, variants: {}, consts: {} };
  for (const raw of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(raw);
    if (!m) throw new Error(`Bad argument "${raw}" (use --name=value)`);
    const [, key, val] = m;
    if (key.startsWith('variant.')) {
      const code = key.slice(8);
      const def = VARIANTS.find((v) => v.name === code || v.code === code.toLowerCase());
      if (!def) throw new Error(`Unknown variant "${code}". Known: ${VARIANTS.map((v) => v.code).join(', ')}`);
      a.variants[def.name] = val.toLowerCase();
    } else if (key.startsWith('const.')) {
      const name = key.slice(6);
      if (!(name in CONSTANTS)) throw new Error(`Unknown constant "${name}". Known: ${Object.keys(CONSTANTS).join(', ')}`);
      try { a.consts[name] = JSON.parse(val); } catch { a.consts[name] = val; }
    } else if (key === 'seats') a.seats = val.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'out') a.out = val;
    else if (key === 'rotate') a.rotate = !['0', 'false', 'no'].includes(val);
    else if (['players', 'games', 'jitter', 'threads'].includes(key)) {
      a[key] = Number(val);
      if (!Number.isFinite(a[key])) throw new Error(`--${key} must be a number`);
    } else if (key === 'seed') a.seed = /^\d+$/.test(val) ? Number(val) : val;
    else throw new Error(`Unknown option --${key}`);
  }
  if (!a.seats) a.seats = ['medium'];
  if (a.players === null) a.players = a.seats.length > 1 ? a.seats.length : 4;
  if (![2, 3, 4, 5].includes(a.players)) throw new Error('--players must be 2, 3, 4 or 5');
  if (a.seats.length === 1) a.seats = Array(a.players).fill(a.seats[0]);
  if (a.seats.length !== a.players) throw new Error(`--seats lists ${a.seats.length} bots for ${a.players} players`);
  const known = [...botLevels().map((l) => l.id), ...Object.keys(SIM_BOTS)];
  for (const s of a.seats) if (!known.includes(s) && !isHardN(s)) throw new Error(`--seats: unknown bot "${s}" (${known.join(', ')}, hard:N)`);
  if (a.jitter < 0 || a.jitter > 100) throw new Error('--jitter is a percentage 0..100');
  if (!Number.isInteger(a.games) || a.games < 1) throw new Error('--games must be a positive integer');
  if (!Number.isInteger(a.threads) || a.threads < 1) throw new Error('--threads must be a positive integer');
  a.rules = resolveVariants(a.variants); // throws on a bad name or value
  return a;
}

function defaultOut(a) {
  const tag = (o) => Object.entries(o).map(([k, v]) => `${k.toLowerCase().replace(/_/g, '-')}-${typeof v === 'object' ? JSON.stringify(v) : v}`.replace(/[^a-z0-9.-]+/gi, '')).join('-');
  const variants = tag(a.variants);
  const consts = tag(a.consts);
  const who = a.seats.join('-').replace(/:/g, '');
  const name = `sim-${a.players}p-${who}-n${a.games}-s${a.seed}${a.rotate ? '' : '-fixed'}${a.jitter ? `-j${a.jitter}` : ''}${variants ? `-${variants}` : ''}${consts ? `-${consts}` : ''}.json`;
  return resolve(HERE, 'tmp', name.toLowerCase());
}

// ---------- recording ----------
const sumOf = (xs) => xs.reduce((a, b) => a + b, 0);

/** What the simulator notes at the start of a voyage (the deal and the measures so far), before anyone moors. */
function snapshotDeal(state) {
  return { hands: state.hands.map((h) => [...h]), noDuck: state.measures.noDuckTrades };
}

/** Deal strength of one hand: [sum of ranks, cards of 8+, serpent cards, serpents, longest cargo]. */
function handFeatures(hand, params) {
  const per = Object.fromEntries(SUITS.map((c) => [c, 0]));
  let r = 0; let hi = 0; let sc = 0; let sp = 0;
  for (const c of hand) {
    const v = cardValue(c);
    r += v;
    if (v >= 8) hi++;
    const k = cardSerpents(c, params);
    if (k > 0) { sc++; sp += k; }
    per[cardSuit(c)]++;
  }
  return { r, hi, sc, sp, ls: Math.max(...Object.values(per)), per };
}

/**
 * A trick where the tie rule (R4.8 v R13.2) is the difference: the top number is held by a trade card played BEFORE a
 * real (lead or follow) card of the same number. First-played gives it to the trade, TIE=real to the real card.
 */
function ruleMatters(t) {
  const counting = t.plays.filter((p) => p.mode !== 'discard');
  const top = Math.max(...counting.map((p) => cardValue(p.card)));
  const atTop = counting.filter((p) => cardValue(p.card) === top);
  return atTop.length > 1 && atTop[0].mode === 'trade' && atTop.some((p) => p.mode !== 'trade');
}

/** One compact record from a finished game state. `snaps` = snapshotDeal() at each voyage start (+ a final one). */
export function recordGame(g, levels, snaps) {
  const r = g.result;
  const n = g.n;
  return {
    n: g.n,
    lv: [...levels],
    fd: g.firstDealer,
    tot: r.totals,
    win: r.winners,
    tied: r.tiedOnTotal,
    tb: r.tiebreakUsed,
    h: g.handLog.map((h, v) => {
      const plays = h.tricks.flatMap((t) => t.plays);
      const trades = plays.filter((p) => p.mode === 'trade');
      const tradeWins = h.tricks.filter((t) => t.winningMode === 'trade');
      const hs = h.startIsland.map((isl, s) => {
        const f = handFeatures(snaps[v].hands[s], g.params);
        const mh = f.per[h.ring[isl]];
        return [f.r, f.hi, f.sc, f.sp, f.ls, mh, mh === f.ls ? 1 : 0];
      });
      const ring = h.ring;
      return {
        s: h.scores, tw: h.tricksWon, sp: h.serpentsTaken, tp: h.tricksPlayed, tt: tradeWins.length,
        tr: h.trades, tl: h.tradesWon, f1: h.forcedTens, ds: h.discards, sl: h.sails,
        ti: h.ties, t1: h.tricks.filter((t) => t.tieBrokenBy === 'first').length, t2: h.tricks.filter((t) => t.tieBrokenBy === 'real').length,
        tm: h.tricks.filter(ruleMatters).length,
        ca: h.tricks.filter((t) => t.serpents === 0).length,
        tc: tradeWins.filter((t) => t.serpents === 0).length,
        ts: tradeWins.filter((t) => t.serpents > 0).length,
        t10: trades.filter((p) => cardValue(p.card) === 10).length,
        nd: snaps[v + 1].noDuck - snaps[v].noDuck,
        dl: h.dealer,
        si: h.startIsland,
        tf: h.startIsland.map((i) => (ring[(i + 1) % 8] === ring[i] ? 1 : 0)),
        tb: h.startIsland.map((i) => (ring[(i + 7) % 8] === ring[i] ? 1 : 0)),
        mp: h.startIsland.map((_, s) => h.mooringOrder.indexOf(s)),
        hs,
      };
    }),
  };
}

// ---------- playing ----------
function makeChooser(id, jitter, rngBot, rngJit) {
  const bot = simBot(id);
  return (view) => {
    if (jitter > 0 && rngNext(rngJit) * 100 < jitter) {
      const legal = legalActionsFromView(view);
      return legal[rngInt(rngJit, legal.length)];
    }
    return bot.chooseAction(view, rngBot);
  };
}

function playToEnd(state, choosers) {
  const snaps = [];
  let guard = 0;
  while (state.toAct !== null) {
    if (state.phase === 'moor' && snaps.length === state.handNo) snaps.push(snapshotDeal(state));
    const seat = state.toAct;
    const act = choosers[seat](viewFor(state, seat));
    applyAction(state, act, { silent: true });
    if (++guard > 5000) throw new Error('livelock');
  }
  snaps.push({ hands: [], noDuck: state.measures.noDuckTrades });
  return snaps;
}

/** Plays games [from, to) of the run. Pure function of the arguments (CONSTANTS are set for the run, then restored). */
export function runRange(a, from, to) {
  const saved = {};
  for (const [k, v] of Object.entries(a.consts)) { saved[k] = CONSTANTS[k]; CONSTANTS[k] = v; }
  try {
    const n = a.players;
    const games = [];
    for (let i = from; i < to; i++) {
      const seed = deriveSeed(a.seed, 'game', i);
      const levels = Array.from({ length: n }, (_, s) => a.seats[a.rotate ? (s + i) % n : s]);
      const choosers = levels.map((lv, s) => makeChooser(lv, a.jitter, makeRng(deriveSeed(seed, 'bot', s)), makeRng(deriveSeed(seed, 'jitter', s))));
      const g = createGame({ seed, players: n, rules: a.variants });
      const snaps = playToEnd(g, choosers);
      games.push(recordGame(g, levels, snaps));
    }
    return games;
  } finally {
    for (const [k, v] of Object.entries(saved)) CONSTANTS[k] = v;
  }
}

export function runSim(a) {
  return runRange(a, 0, a.games);
}

/** Splits the run across worker threads; output order and content are the same as runSim. */
export async function runSimThreaded(a) {
  const t0 = Date.now();
  if (a.threads <= 1 || a.games < 2 * a.threads) return { games: runSim(a), ms: Date.now() - t0 };
  const size = Math.ceil(a.games / a.threads);
  const jobs = [];
  for (let from = 0; from < a.games; from += size) {
    const to = Math.min(a.games, from + size);
    jobs.push(new Promise((res, rej) => {
      const w = new Worker(SELF, { workerData: { a, from, to } });
      w.once('message', res);
      w.once('error', rej);
    }));
  }
  const parts = await Promise.all(jobs);
  return { games: parts.flat(), ms: Date.now() - t0 };
}

// ---------- worker entry ----------
if (!isMainThread && workerData && workerData.a) {
  parentPort.postMessage(runRange(workerData.a, workerData.from, workerData.to));
}

// ---------- main ----------
if (isMainThread && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const a = parseArgs(process.argv.slice(2));
    const { games, ms } = await runSimThreaded(a);
    const out = a.out ? resolve(a.out) : defaultOut(a);
    const meta = {
      tool: 'sinbad-sim', version: 2, players: a.players, seats: a.seats, rotate: a.rotate, games: a.games, seed: a.seed,
      jitter: a.jitter, rules: a.rules, variants: a.variants, consts: a.consts,
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ meta, games }) + '\n');
    console.error(`${a.games} games in ${(ms / 1000).toFixed(1)}s`);
    console.log(out);
  } catch (e) {
    console.error(`sim: ${e.message}`);
    process.exit(2);
  }
}
