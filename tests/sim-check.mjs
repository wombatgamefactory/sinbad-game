// sim-check.mjs - the simulator is deterministic and its records are consistent (a few seconds).
// Same seed twice gives identical JSON (also across worker threads); every game plays n hands and the
// records agree with the engine's own totals and winners; bad arguments are refused; --const is
// restored after a run; a few sanity reference numbers; the report and the cross-check run.
// Also checks the measures recorded per voyage (their arithmetic against each other), the reference
// numbers of the original Python simulator as wide ranges, the first-leader edge of the later seats, the --const serpent probe, the
// simulator-only bots, and every report section (summary, --deal, --moor, --catchup, --appb, the Python cross-check
// on a tiny synthetic Python file).
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, runSim, runSimThreaded } from './sim.mjs';
import { report, crossCheck, winnersOf, appendixB, crossPython, ols, batchSums, ratio, chiP } from './sim-report.mjs';
import { CONSTANTS } from '../src/engine/index.js';
import { suite } from './lib.mjs';

const { check, done } = suite('sim-check');
const run = (argv) => runSim(parseArgs(argv));
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

// ---- determinism, termination, consistency ----
for (const argv of [
  ['--players=2', '--seats=easy', '--games=60', '--seed=7'],
  ['--players=3', '--seats=medium,high,easy', '--games=60', '--seed=7', '--jitter=10'],
  ['--players=4', '--seats=medium,high,low,easy', '--games=60', '--seed=9', '--variant.TIE=real', '--variant.TRADE=optional'],
  ['--players=5', '--seats=medium', '--games=40', '--seed=3', '--variant.MOOR=score', '--variant.VOYAGES=four', '--variant.SCORING=serpents'],
  ['--players=3', '--seats=hard:2,medium,easy', '--games=6', '--seed=4'],
]) {
  const a = JSON.stringify(run(argv));
  const b = JSON.stringify(run(argv));
  const tag = argv.slice(0, 3).join(' ');
  check(`same seed, same JSON (${tag})`, a === b);
  const games = JSON.parse(a);
  const n = parseArgs(argv).players;
  const voyages = parseArgs(argv).variants.VOYAGES === 'four' ? 4 : { 2: 4, 3: 3, 4: 4, 5: 5 }[n];
  check(`${tag}: one voyage per player (4 at 2p; VOYAGES=four 4)`, games.every((g) => g.h.length === voyages));
  check(`${tag}: hand scores add up to the totals`, games.every((g) => g.tot.every((t, s) => g.h.reduce((x, h) => x + h.s[s], 0) === t)));
  check(`${tag}: tricks won add up to the tricks played`, games.every((g) => g.h.every((h) => h.tw.reduce((x, y) => x + y, 0) === h.tp)));
  check(`${tag}: the winners are the top total, then the best last-hand score, and the report agrees`, games.every((g) => {
    const w = winnersOf(g);
    return JSON.stringify(w.withTb) === JSON.stringify(g.win) && JSON.stringify(w.tied) === JSON.stringify(g.tied) && g.tb === (g.win.length < g.tied.length);
  }));
}
check('different seeds differ', JSON.stringify(run(['--games=30', '--seed=1', '--seats=easy'])) !== JSON.stringify(run(['--games=30', '--seed=2', '--seats=easy'])));
{
  const a = parseArgs(['--players=4', '--seats=medium,easy,easy,easy', '--games=24', '--seed=5']);
  const serial = JSON.stringify(runSim(a));
  const threaded = JSON.stringify((await runSimThreaded({ ...a, threads: 3 })).games);
  check('worker threads give the same games as one thread', serial === threaded);
  const rot = runSim(a);
  check('seat rotation moves the bot list', rot[0].lv[0] === 'medium' && rot[1].lv[3] === 'medium' && rot[1].lv[0] === 'easy');
  const fixed = runSim({ ...a, rotate: false });
  check('--rotate=0 keeps the seats as listed', fixed.every((g) => g.lv[0] === 'medium' && g.lv[1] === 'easy'));
}
{
  const before = JSON.stringify(CONSTANTS);
  const a = parseArgs(['--players=4', '--seats=medium', '--games=10', '--seed=1', '--const.TRICK_POINTS=3']);
  const g = run(['--players=4', '--seats=medium', '--games=10', '--seed=1', '--const.TRICK_POINTS=3']);
  check('--const changes the rules for the run (3 points a trick)', a.consts.TRICK_POINTS === 3 && g.every((x) => x.h.every((h) => h.s.every((sc, s) => sc === h.tw[s] * 3 - h.sp[s]))));
  check('--const is restored after the run', JSON.stringify(CONSTANTS) === before);
}

// ---- the Sinbad measures recorded per voyage agree with each other ----
{
  const games = run(['--players=4', '--seats=medium,easy,easy,medium', '--games=150', '--seed=3']).concat(run(['--players=2', '--seats=medium', '--games=40', '--seed=3']));
  const sm = (xs) => xs.reduce((a, b) => a + b, 0);
  const hs = games.flatMap((g) => g.h.map((h) => ({ h, n: g.n })));
  check('trades that won = tricks won by a trade card; windfall + serpent wins = trade wins', hs.every(({ h }) => sm(h.tl) === h.tt && h.tc + h.ts === h.tt));
  check('forced 10s <= any-10 trades <= trades; trades won <= trades', hs.every(({ h }) => sm(h.f1) <= h.t10 && h.t10 <= sm(h.tr) && sm(h.tl) <= sm(h.tr)));
  check('clean tricks <= tricks; ties split by first / real; the tie-rule flips are ties; no-duck trades <= trades', hs.every(({ h }) => h.ca <= h.tp && h.t1 + h.t2 === h.ti && h.tm <= h.ti && h.nd <= sm(h.tr)));
  check('standard rules: no tie is ever broken by a real card', hs.every(({ h }) => h.t2 === 0));
  check('start island, twin flags and mooring positions are well formed', hs.every(({ h, n }) => h.si.length === n && h.si.every((i) => i >= 0 && i < 8) && h.tf.every((x) => x === 0 || x === 1) && h.tb.every((x) => x === 0 || x === 1)
    && [...h.mp].sort().join() === Array.from({ length: n }, (_, i) => i).join()));
  check('deal strength rows: 7 numbers, moored cargo held <= longest cargo, flag agrees', hs.every(({ h, n }) => h.hs.length === n && h.hs.every((r) => r.length === 7 && r[4] >= r[5] && (r[6] === 1) === (r[5] === r[4]))));
  check('serpents dealt: at most 12, exactly 12 with 4 players (whole deck dealt)', hs.every(({ h, n }) => sm(h.hs.map((r) => r[3])) <= 12 && (n !== 4 || sm(h.hs.map((r) => r[3])) === 12)));
}

// ---- the first leader's edge, the reference numbers of the original Python simulator, as wide ranges ----
{
  const dir = mkdtempSync(join(tmpdir(), 'sim-check-b-'));
  try {
    const a = parseArgs(['--players=4', '--seats=medium', '--games=2500', '--seed=11']);
    const data = { meta: { players: 4, seats: a.seats, rotate: true, jitter: 0, variants: {}, consts: {}, rules: a.rules }, games: runSim(a) };
    const f = join(dir, 'b.json'); writeFileSync(f, JSON.stringify(data));
    const ch = batchSums(data, 200);
    const r = (num, den, sc = 1) => ratio(ch, num, den, sc).v;
    // Python reference, 4 suits / 4p / heuristic: clean 31.8, trades 1.40, trade win 29.4, serpent wins 16.4, no duck 26.2, any-10 0.21, sails 2.29, laps 0.29, never sailed 9.1, ties 7.9, sd 1.56
    check('Python reference, 4p heuristic: clean tricks % near 31.8', Math.abs(r('clean', 'tricks', 100) - 31.8) < 2.5, String(r('clean', 'tricks', 100)));
    check('Python reference, 4p heuristic: trades per player-voyage near 1.40', Math.abs(r('trades', 'pv') - 1.4) < 0.1);
    check('Python reference, 4p heuristic: trades that won near 29.4%, winning serpents near 16.4%, no duck near 26.2%', Math.abs(r('tw', 'trades', 100) - 29.4) < 3 && Math.abs(r('tsp', 'trades', 100) - 16.4) < 3 && Math.abs(r('nd', 'trades', 100) - 26.2) < 3);
    check('Python reference, 4p heuristic: any-10 trades near 0.21, sails near 2.29, laps near 0.29, never sailed near 9.1%, ties near 7.9%', Math.abs(r('t10', 'pv') - 0.21) < 0.03 && Math.abs(r('sails', 'pv') - 2.29) < 0.15 && Math.abs(r('sails', 'pv', 1 / 8) - 0.29) < 0.03 && Math.abs(r('park', 'pv', 100) - 9.1) < 2 && Math.abs(r('ties', 'tricks', 100) - 7.9) < 1.5);
    const seatMean = (o) => ch.reduce((x, c) => x + c.seatS[o], 0) / ch.reduce((x, c) => x + c.k, 0);
    check('the later seats outscore the first leader by 0.1-0.4 a voyage (Appendix B: 0.2-0.3)', seatMean(3) - seatMean(0) > 0.1 && seatMean(3) - seatMean(0) < 0.4, String(seatMean(3) - seatMean(0)));
    const text = appendixB([f]);
    check('Appendix B layout prints the row and the seat means', /4p medium/.test(text) && /Seat mean voyage scores/.test(text));
    const full = report([f], { detail: true, deal: true, moor: true, catchup: true });
    check('the --detail --deal --moor --catchup sections print', /Voyage score by leader offset/.test(full) && /R-squared, voyage score/.test(full) && /Voyage score by where the ship starts/.test(full) && /standing BEFORE the voyage/.test(full));
    // a tiny synthetic Python file (3 batches) exercises the cross-check path
    const bt = (k) => ({ 'pos%': 31.8 + k * 0.1, trades_pp: 1.4, 'trade_win%': 29.4, 'trade_serpwin%': 16.4, 'noduck%': 26.2, t10_pp: 0.21, disc_pp: 0.89, sails_pp: 2.29, laps: 0.286, 'parked%': 9.1, 'ties%': 7.9, mean: -0.5, sd: 1.56, seats: [-0.63, -0.53, -0.49, -0.35], twin_gain: -0.08, 'twin_share%': 25 });
    const py = join(dir, 'py.json');
    writeFileSync(py, JSON.stringify({ configs: [{ n: 4, bot: 'heuristic', suits: 4, B: 200, batches: [bt(0), bt(1), bt(2)] }] }));
    const x = crossPython(f, py);
    check('the Python cross-check lines up every measure and counts the verdicts', x.total >= 15 && /within CI|DIFFERS/.test(x.text) && /seat mean score, leader offset 3/.test(x.text));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
{
  const o = ols([[1], [2], [3], [4], [5]], [3, 5, 7, 9, 11]);
  check('ols recovers y = 1 + 2x exactly (R-squared 1)', Math.abs(o.beta[0] - 1) < 1e-9 && Math.abs(o.beta[1] - 2) < 1e-9 && Math.abs(o.r2 - 1) < 1e-9);
  check('chi-square p-value: P(chi2 >= 3.84, df 1) near 0.05; P(chi2 >= 7.81, df 3) near 0.05', Math.abs(chiP(3.841, 1) - 0.05) < 0.002 && Math.abs(chiP(7.815, 3) - 0.05) < 0.002);
}

// ---- the serpent-value probe, and the simulator-only bots ----
{
  const games = run(['--players=4', '--seats=medium', '--games=60', '--seed=2', '--const.SERPENTS_BY_NUMBER={"10":2}']);
  const hands = games.flatMap((g) => g.h);
  check('--const.SERPENTS_BY_NUMBER={"10":2}: 8 serpents in the deck, so a 4-player voyage totals 10 tricks - 8 serpents = +2', hands.every((h) => h.s.reduce((a, b) => a + b, 0) === 2));
  const mh = (seats) => mean(run(['--players=3', `--seats=${seats}`, '--games=80', '--seed=2']).flatMap((g) => g.h.flatMap((h) => h.hs.map((r) => r[5]))));
  check('moor-fewest moors at a thin cargo (fewer than 2.5 cards held), Medium at its longest (more than 3.5)', mh('moor-fewest') < 2.5 && mh('medium') > 3.5);
  check('the archetypes are accepted as seats', run(['--players=3', '--seats=always-duck,win-trades,serpent-hoarder', '--games=5', '--seed=1']).length === 5);
}

// ---- refusals ----
{
  let threw = 0;
  const bad = [['--variant.NOPE=1'], ['--variant.TIE=9'], ['--seats=genius'], ['--players=6'], ['--players=1'], ['--players=4', '--seats=easy,easy'], ['--const.NOPE=1'], ['--bogus=1']];
  for (const b of bad) {
    try { parseArgs(b); } catch { threw++; }
  }
  check('bad variants, bots, counts, constants and options are refused', threw === bad.length, `${threw}/${bad.length}`);
}

// ---- sanity numbers (R5.5): with 4 players every voyage is 10 tricks; scores per voyage average -0.5 ----
{
  const games = run(['--players=4', '--seats=medium', '--games=200', '--seed=1']);
  const hands = games.flatMap((g) => g.h);
  check('4p medium: 10 tricks a voyage, -0.5 points a voyage per seat on average (10 tricks - 12 serpents over 4)', mean(hands.map((h) => h.tp)) === 10 && Math.abs(mean(hands.flatMap((h) => h.s)) + 0.5) < 1e-9);
}

// ---- the report and the cross-check ----
{
  const dir = mkdtempSync(join(tmpdir(), 'sim-check-'));
  try {
    const f = join(dir, 'a.json');
    const a = parseArgs(['--players=3', '--seats=medium,high,easy', '--games=40', '--seed=1']);
    writeFileSync(f, JSON.stringify({ meta: { players: 3, seats: a.seats, rotate: true, jitter: 0, variants: {}, consts: {}, rules: a.rules }, games: runSim(a) }));
    const text = report([f]);
    check('report prints the summary and the bot table', /tie for 1st/.test(text) && /Win % by bot/.test(text) && /still shared/.test(text) && /never sailed/.test(text));
    const x = crossCheck(f, f);
    check('cross-check of a file against itself shows no difference', /within CI/.test(x) && !/DIFFERS/.test(x));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

done();
