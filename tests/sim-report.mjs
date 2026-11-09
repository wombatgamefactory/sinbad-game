// sim-report.mjs - summarises one or more sim.mjs JSON files (several = side-by-side columns).
//
//   node tests/sim-report.mjs tests/tmp/a.json [tests/tmp/b.json ...] [flags]
//
// Flags (any combination; the default report is the summary table and the win-rate tables):
//   --brief           only the summary table and, for several files, the effects against the first
//   --detail          seat tables: voyage score by first-leader offset, by mooring position, final total by seat
//   --deal            how much of the result the deal explains (regressions on the dealt hand), per file
//   --moor            twin starts and mooring quality (cards held of the moored cargo), per file
//   --catchup         voyage score by standing before the voyage, and how often the leader holds on
//   --vs=ref.json     with ONE file: z-tests of this engine's win rates and measures against a second sim file
//   --appb            reference layout: one row per file, one column per reference measure
//   --py=python.json  with --appb: cross-check each file against the Python simulator's batches
//                     (a cross-check script for the original Python simulator), measure by measure
//   --suits=4         with --py: the Python line's cargo count (4 = the build; 5 = the unbuilt fallback, no JS side)
//
// Definitions:
//   "tie for 1st"  = two or more players on the top total BEFORE any tiebreak.
//   "shared"       = still tied after the tiebreak (level on the final voyage's score too).
//   win % (tiebreak) is the game's rule: a tied total is split by most points in the final voyage, then shared 1/winners.
//   win % (no tiebreak) shares every tie on the top total (what the Python, which has no tiebreak, would count).
//   leader offset  = (seat - dealer - 1) mod n: 0 is the player on the dealer's left, who leads the voyage's first trick.
//   offset after the first dealer in a GAME table: 0 = the first dealer, 1 = the first voyage's first leader.
// Everything is recomputed from the records, so any file in the sim.mjs format works.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// ---------- statistics ----------
export function wilson(k, n, z = 1.96) {
  if (n <= 0) return [0, 0];
  const p = k / n; const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
export const pct = (x, d = 1) => (x * 100).toFixed(d);
export const ci = (k, n) => { const [lo, hi] = wilson(k, n); return `${pct(k / n)} [${pct(lo)}, ${pct(hi)}]`; };
export const sum = (xs) => xs.reduce((s, x) => s + x, 0);
export const mean = (xs) => (xs.length ? sum(xs) / xs.length : NaN);
export const sd = (xs) => { const m = mean(xs); return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / Math.max(1, xs.length - 1)); };
const mci = (xs) => (1.96 * sd(xs)) / Math.sqrt(xs.length);
export const pm = (xs, d = 2) => `${mean(xs).toFixed(d)} ±${mci(xs).toFixed(d)}`;
const f2 = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const sgn = (x, d = 2) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) : '-');
/** Two-sample z of the difference of means of two arrays (0/1 arrays give a difference of proportions). */
export function diffZ(xs, ys) {
  const se = Math.sqrt(sd(xs) ** 2 / xs.length + sd(ys) ** 2 / ys.length);
  return se === 0 ? 0 : (mean(xs) - mean(ys)) / se;
}
const verdict = (z) => (Math.abs(z) < 1.96 ? 'within CI' : 'DIFFERS');

function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x; let t = x + 5.5; t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015;
  for (const k of c) s += k / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}
function gammaP(a, x) {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let ap = a; let s = 1 / a; let del = s;
    for (let i = 0; i < 300; i++) { ap++; del *= x / ap; s += del; if (Math.abs(del) < Math.abs(s) * 1e-13) break; }
    return s * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  let b = x + 1 - a; let c = 1e300; let d = 1 / b; let h = d;
  for (let i = 1; i < 300; i++) {
    const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-13) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}
/** P(chi-square with df degrees of freedom >= x). */
export const chiP = (x, df) => 1 - gammaP(df / 2, x / 2);

/** Ordinary least squares with an intercept. rows: feature arrays; returns { beta (intercept first), se, r2, n }. */
export function ols(rows, y) {
  const n = rows.length; const k = rows[0].length + 1;
  const A = Array.from({ length: k }, () => Array(2 * k).fill(0));
  const xty = Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    const x = [1, ...rows[i]];
    for (let a = 0; a < k; a++) { xty[a] += x[a] * y[i]; for (let b = 0; b < k; b++) A[a][b] += x[a] * x[b]; }
  }
  for (let a = 0; a < k; a++) A[a][k + a] = 1;
  for (let c = 0; c < k; c++) { // Gauss-Jordan
    let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c];
    if (Math.abs(d) < 1e-12) return { beta: Array(k).fill(NaN), se: Array(k).fill(NaN), r2: NaN, n };
    for (let j = 0; j < 2 * k; j++) A[c][j] /= d;
    for (let r = 0; r < k; r++) if (r !== c) { const f = A[r][c]; if (f) for (let j = 0; j < 2 * k; j++) A[r][j] -= f * A[c][j]; }
  }
  const inv = A.map((r) => r.slice(k));
  const beta = inv.map((r) => sum(r.map((v, j) => v * xty[j])));
  const ym = mean(y); let rss = 0; let tss = 0;
  for (let i = 0; i < n; i++) { const x = [1, ...rows[i]]; const e = y[i] - sum(x.map((v, j) => v * beta[j])); rss += e * e; tss += (y[i] - ym) ** 2; }
  const s2 = rss / Math.max(1, n - k);
  return { beta, se: inv.map((r, j) => Math.sqrt(Math.max(0, s2 * inv[j][j]))), r2: tss ? 1 - rss / tss : NaN, n };
}

// ---------- tiebreak: recomputed from the totals and the last voyage's scores ----------
/** Winners of one game under the standard tiebreak (most points in the final voyage) and with none. */
export function winnersOf(g) {
  const top = Math.max(...g.tot);
  const tied = g.tot.map((t, s) => (t === top ? s : -1)).filter((s) => s >= 0);
  const last = g.h[g.h.length - 1].s;
  const most = Math.max(...tied.map((s) => last[s]));
  return { tied, noTb: tied, withTb: tied.filter((s) => last[s] === most) };
}

// ---------- per-voyage sums and ratio measures ----------
const zeroSums = (n) => ({
  k: 0, pv: 0, tricks: 0, tm: 0, clean: 0, trades: 0, tw: 0, wf: 0, tsp: 0, nd: 0, f1: 0, t10: 0, disc: 0, sails: 0, park: 0, ties: 0,
  sc: 0, sq: 0, twS: [0, 0], twN: [0, 0], seatS: Array(n).fill(0),
});
function addVoyage(a, h, n, dealerOf) {
  a.k++; a.pv += n; a.tricks += h.tp; a.tm += h.tm || 0; a.clean += h.ca; a.trades += sum(h.tr); a.tw += h.tt; a.wf += h.tc; a.tsp += h.ts; a.nd += h.nd;
  a.f1 += sum(h.f1); a.t10 += h.t10; a.disc += sum(h.ds); a.sails += sum(h.sl); a.park += h.sl.filter((x) => x === 0).length; a.ties += h.ti;
  a.sc += sum(h.s); a.sq += sum(h.s.map((x) => x * x));
  for (let s = 0; s < n; s++) {
    const t = h.tf[s]; a.twS[t] += h.s[s]; a.twN[t]++;
    a.seatS[(s - dealerOf - 1 + 2 * n) % n] += h.s[s];
  }
}

/** Ratio measures: [label, numerator key, denominator key, scale]. */
export const MEAS = [
  ['clean tricks %', 'clean', 'tricks', 100],
  ['trades / player / voyage', 'trades', 'pv', 1],
  ['trades that won the trick %', 'tw', 'trades', 100],
  ['  windfall: won a trick with no serpent %', 'wf', 'trades', 100],
  ['trades that won serpents %', 'tsp', 'trades', 100],
  ['trades with no duck %', 'nd', 'trades', 100],
  ['forced 10 trades / pp (strict: only island card)', 'f1', 'pv', 1],
  ['any-10 trades / pp (the Python t10)', 't10', 'pv', 1],
  ['discards / player / voyage', 'disc', 'pv', 1],
  ['sails / player / voyage', 'sails', 'pv', 1],
  ['laps (8 sails) / player / voyage', 'sails', 'pv', 1 / 8],
  ['never sailed % of player-voyages', 'park', 'pv', 100],
  ['tricks decided by the tie rule %', 'ties', 'tricks', 100],
  ['  of which the rule choice flips the winner (trade first, real card tied) %', 'tm', 'tricks', 100],
];

/** Voyage records of a file in play order, with their game. */
export function voyagesOf(data) {
  const out = [];
  data.games.forEach((g, gi) => g.h.forEach((h, v) => out.push({ g, gi, v, h, n: g.n })));
  return out;
}

/** Consecutive voyages grouped into batches of B (the unit of the cross-check's variance). */
export function batchSums(data, B) {
  const vs = voyagesOf(data); const n = data.meta.players; const out = [];
  for (let i = 0; i + B <= vs.length; i += B) {
    const a = zeroSums(n);
    for (let j = i; j < i + B; j++) addVoyage(a, vs[j].h, n, vs[j].h.dl);
    out.push(a);
  }
  return out;
}

/** Pooled ratio over clusters with the cluster-robust standard error. */
export function ratio(chunks, num, den, scale = 1) {
  const N = sum(chunks.map((c) => c[num])); const D = sum(chunks.map((c) => c[den]));
  if (!D || Number.isNaN(N)) return { v: NaN, se: NaN };
  const R = N / D;
  const se = Math.sqrt(sum(chunks.map((c) => (c[num] - R * c[den]) ** 2))) / D;
  return { v: R * scale, se: se * scale };
}
const withSe = (m, d = 2) => (Number.isFinite(m.v) ? `${m.v.toFixed(d)} ±${(1.96 * m.se).toFixed(d)}` : '-');
const chunkSd = (c) => Math.sqrt(Math.max(0, c.sq / c.pv - (c.sc / c.pv) ** 2));
const chunkTwin = (c) => (c.twN[0] && c.twN[1] ? c.twS[1] / c.twN[1] - c.twS[0] / c.twN[0] : NaN);

// ---------- summary ----------
export function summarise(data) {
  const gs = data.games; const N = gs.length;
  const n = data.meta.players;
  const W = gs.map(winnersOf);
  const credit = (list, s) => (list.includes(s) ? 1 / list.length : 0);
  const levels = [...new Set(gs.flatMap((g) => g.lv))].sort();

  const bySeat = Array.from({ length: n }, (_, s) => ({ seat: s, k: sum(gs.map((g, i) => credit(W[i].withTb, s))), n: N }));
  const byOffset = Array.from({ length: n }, (_, o) => ({ off: o, k: sum(gs.map((g, i) => credit(W[i].withTb, (g.fd + o) % n))), n: N }));
  const byLevel = levels.map((lv) => {
    const cred = []; const cred0 = []; const scores = []; const perVoyage = [];
    gs.forEach((g, i) => {
      for (let s = 0; s < n; s++) {
        if (g.lv[s] !== lv) continue;
        cred.push(credit(W[i].withTb, s)); cred0.push(credit(W[i].noTb, s)); scores.push(g.tot[s]);
        for (const h of g.h) perVoyage.push(h.s[s]);
      }
    });
    return { lv, cred, cred0, k: sum(cred), k0: sum(cred0), n: cred.length, base: 1 / n, mean: mean(scores), perVoyage, perHand: mean(perVoyage) };
  });
  const exp = N / n;
  const chi = sum(bySeat.map((b) => ((b.k - exp) ** 2) / exp));
  const chiOff = sum(byOffset.map((b) => ((b.k - exp) ** 2) / exp));

  const hands = gs.flatMap((g) => g.h);
  const totals = gs.flatMap((g) => g.tot);
  const finals = gs.map((g) => Math.max(...g.tot));
  const margins = gs.map((g) => { const t = [...g.tot].sort((a, b) => b - a); return t[0] - t[1]; });
  const trickCount = sum(hands.map((h) => h.tp));
  const chunks = batchSums(data, 200);
  const all = zeroSums(n); // one pooled "cluster" for sums used by tables
  for (const { h } of voyagesOf(data)) addVoyage(all, h, n, h.dl);
  return {
    N, n, H: hands.length, W, bySeat, byOffset, byLevel, chi, chiOff, levels, chunks, all,
    handScores: hands.flatMap((h) => h.s), totals, finals, margins,
    tricksPerHand: hands.map((h) => h.tp),
    tricksPerGame: gs.map((g) => sum(g.h.map((h) => h.tp))),
    trumpShare: trickCount ? sum(hands.map((h) => h.tt)) / trickCount : NaN,
    trumpTrickArr: hands.map((h) => (h.tp ? h.tt / h.tp : 0)),
    tiedArr: W.map((w) => (w.tied.length > 1 ? 1 : 0)),
    tbArr: W.map((w) => (w.withTb.length < w.tied.length ? 1 : 0)),
    sharedArr: W.map((w) => (w.withTb.length > 1 ? 1 : 0)),
    sdArr: hands.map((h) => sd(h.s)),
  };
}

// ---------- output ----------
export function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (r) => '| ' + r.map((c, i) => String(c).padEnd(widths[i])).join(' | ') + ' |';
  return [fmt(headers), '| ' + widths.map((w) => '-'.repeat(w)).join(' | ') + ' |', ...rows.map(fmt)].join('\n');
}

export function labelOf(data) {
  const m = data.meta;
  const v = Object.entries(m.variants || {}).map(([k, x]) => `${k}=${x}`).join(' ');
  const c = Object.entries(m.consts || {}).map(([k, x]) => `${k}=${typeof x === 'object' ? JSON.stringify(x) : x}`).join(' ');
  return `${m.players}p ${m.seats.join(',')}${m.rotate ? '' : ' (fixed seats)'}${m.jitter ? ` j${m.jitter}` : ''}${v ? ` ${v}` : ''}${c ? ` ${c}` : ''}`;
}

const asProp = (arr) => ci(sum(arr), arr.length);
const meanCI = (xs, d = 2) => `${mean(xs).toFixed(d)} ±${mci(xs).toFixed(d)}`;

// ---------- the sections ----------
/** Voyage score by leader offset, by mooring position; final total by offset after the first dealer. */
function seatSection(data, s) {
  const n = data.meta.players; const out = [];
  const byLead = Array.from({ length: n }, () => []); const byMoor = Array.from({ length: n }, () => []);
  for (const { h } of voyagesOf(data)) {
    for (let q = 0; q < n; q++) { byLead[(q - h.dl - 1 + 2 * n) % n].push(h.s[q]); byMoor[h.mp[q]].push(h.s[q]); }
  }
  out.push('', 'Voyage score by leader offset (0 = left of the dealer, leads trick 1; mean ±95%, player-voyages):');
  out.push(table(['offset', 'n', 'mean voyage score'], byLead.map((xs, o) => [o, xs.length, meanCI(xs)])));
  const hasMoor = data.meta.variants && data.meta.variants.MOOR === 'score';
  out.push('', `Voyage score by mooring position (0 = moors first${hasMoor ? '; MOOR=score: leader of the table first' : '; standard: same as the leader offset'}):`);
  out.push(table(['mooring position', 'n', 'mean voyage score'], byMoor.map((xs, o) => [o, xs.length, meanCI(xs)])));
  const byOff = Array.from({ length: n }, () => []);
  for (const g of data.games) for (let q = 0; q < n; q++) byOff[(q - g.fd + 2 * n) % n].push(g.tot[q]);
  out.push('', 'Final total by offset after the first dealer (0 = first dealer):');
  out.push(table(['offset', 'final total ±95%'], byOff.map((xs, o) => [o, meanCI(xs)])));
  out.push(`Win-rate chi-square by offset ${s.chiOff.toFixed(1)} (df ${n - 1}, p = ${chiP(s.chiOff, n - 1).toFixed(3)}); by seat number ${s.chi.toFixed(1)} (p = ${chiP(s.chi, n - 1).toFixed(3)}).`);
  return out;
}

/** Deal features used by the regressions: indices into hs = [sum of ranks, cards of 8+, serpent cards, serpents, longest cargo, held of moored cargo, moored at longest]. */
const FEAT = [0, 1, 3, 4];
const FEAT_NAMES = ['sum of ranks', 'cards of 8+', 'serpents held', 'longest cargo'];

/** How much of the voyage and the game the deal explains (within-table: demeaned over the seats). */
export function dealSection(data) {
  const n = data.meta.players; const out = [];
  const X = []; const Y = [];
  const gX = []; const gY = [];
  const K = FEAT.length;
  for (const g of data.games) {
    const tot = Array.from({ length: n }, () => Array(K).fill(0));
    for (const h of g.h) {
      const mX = FEAT.map((j) => mean(h.hs.map((x) => x[j]))); const mY = mean(h.s);
      for (let s = 0; s < n; s++) {
        X.push(FEAT.map((j, q) => h.hs[s][j] - mX[q])); Y.push(h.s[s] - mY);
        FEAT.forEach((j, q) => { tot[s][q] += h.hs[s][j]; });
      }
    }
    const mt = Array.from({ length: K }, (_, q) => mean(tot.map((t) => t[q]))); const my = mean(g.tot);
    for (let s = 0; s < n; s++) { gX.push(tot[s].map((v, q) => v - mt[q])); gY.push(g.tot[s] - my); }
  }
  const col = (M, j) => M.map((r) => r[j]);
  const corr = (a, b) => { const ma = mean(a); const mb = mean(b); return sum(a.map((v, i) => (v - ma) * (b[i] - mb))) / Math.sqrt(sum(a.map((v) => (v - ma) ** 2)) * sum(b.map((v) => (v - mb) ** 2))); };
  const full = ols(X, Y);
  const fullG = ols(gX, gY);
  const single = FEAT_NAMES.map((_, q) => ols(col(X, q).map((v) => [v]), Y));
  out.push(`Within-table regression of the voyage score on the dealt hand (n = ${X.length} player-voyages; features and score minus the table mean, so the zero-sum part is removed):`);
  out.push(table(['feature', 'correlation with voyage score', 'one-feature coefficient ±95%', 'R-squared alone', 'coefficient in the four-feature model ±95%'],
    FEAT_NAMES.map((nm, q) => [nm, f2(corr(col(X, q), Y)), `${sgn(single[q].beta[1], 3)} ±${(1.96 * single[q].se[1]).toFixed(3)}`, `${(100 * single[q].r2).toFixed(1)}%`, `${sgn(full.beta[q + 1], 3)} ±${(1.96 * full.se[q + 1]).toFixed(3)}`])));
  out.push(`R-squared, voyage score on the whole dealt hand (the four features): ${(100 * full.r2).toFixed(1)}%. The rest is play, the opponents' hands and the ring.`);
  out.push(`R-squared, final game total on the deals summed over the game (n = ${gX.length} seat-games): ${(100 * fullG.r2).toFixed(1)}%.`);
  // deal favourite: the seat the four-feature game model rates highest wins how often (in-sample)
  let k = 0;
  const W = data.games.map(winnersOf);
  data.games.forEach((g, i) => {
    const tot = Array.from({ length: n }, () => Array(K).fill(0));
    for (const h of g.h) for (let s = 0; s < n; s++) FEAT.forEach((j, q) => { tot[s][q] += h.hs[s][j]; });
    const pred = tot.map((t) => sum(t.map((v, q) => v * fullG.beta[q + 1])));
    const best = Math.max(...pred); const fav = pred.map((p, s) => (p === best ? s : -1)).filter((s) => s >= 0);
    k += sum(fav.map((s) => (W[i].withTb.includes(s) ? 1 / W[i].withTb.length : 0))) / fav.length;
  });
  out.push(`The seat whose summed deals the model rates highest wins ${ci(k, data.games.length)}% of games (base ${pct(1 / n)}%; in-sample).`);
  return { text: out, r2Voyage: full.r2, r2Game: fullG.r2, fav: k / data.games.length };
}

/** Twin starts and mooring quality. */
export function moorSection(data) {
  const n = data.meta.players; const out = [];
  const cat = { 'first of a twin pair (next island same cargo; the Python definition)': [], 'second of a twin pair (previous island same cargo)': [], 'neither': [] };
  const keys = Object.keys(cat);
  const byMh = new Map(); const byMl = [[], []];
  const X = []; const Y = [];
  for (const { h } of voyagesOf(data)) {
    const mY = mean(h.s); const mX = FEAT.map((j) => mean(h.hs.map((x) => x[j]))); const mMh = mean(h.hs.map((x) => x[5]));
    for (let s = 0; s < n; s++) {
      cat[h.tf[s] ? keys[0] : h.tb[s] ? keys[1] : keys[2]].push(h.s[s]);
      const mh = h.hs[s][5];
      if (!byMh.has(mh)) byMh.set(mh, []);
      byMh.get(mh).push(h.s[s]); byMl[h.hs[s][6]].push(h.s[s]);
      X.push([...FEAT.map((j, q) => h.hs[s][j] - mX[q]), mh - mMh]); Y.push(h.s[s] - mY);
    }
  }
  const base = cat[keys[2]];
  out.push('Voyage score by where the ship starts (player-voyages):');
  out.push(table(['start island', 'n', 'mean ±95%', 'difference from "neither" ±95%'], keys.map((k) => {
    const xs = cat[k];
    const d = mean(xs) - mean(base); const se = Math.sqrt(sd(xs) ** 2 / xs.length + sd(base) ** 2 / base.length);
    return [k, xs.length, meanCI(xs), k === keys[2] ? '-' : `${sgn(d)} ±${(1.96 * se).toFixed(2)}`];
  })));
  out.push('', 'Voyage score by cards held of the moored cargo (mooring quality):');
  out.push(table(['cards of moored cargo', 'n', 'mean voyage score ±95%'], [...byMh.keys()].sort((a, b) => a - b).map((k) => [k, byMh.get(k).length, meanCI(byMh.get(k))])));
  out.push('', `Moored at (one of) the longest cargo(es): ${byMl[1].length} player-voyages, mean ${meanCI(byMl[1])}; not at the longest: ${byMl[0].length}, mean ${byMl[0].length > 1 ? meanCI(byMl[0]) : '-'}.`);
  const fit = ols(X, Y);
  const K = FEAT.length;
  if (Number.isFinite(fit.beta[K + 1])) out.push(`Regression of the within-table voyage score on the four deal features plus cards held of the moored cargo: moored-cargo coefficient ${sgn(fit.beta[K + 1], 3)} ±${(1.96 * fit.se[K + 1]).toFixed(3)} points per extra card (n = ${X.length}); R-squared ${(100 * fit.r2).toFixed(1)}%.`);
  else out.push('Regression on cards held of the moored cargo: not identified here (every ship moored at its longest cargo, so the moored cargo is the longest-cargo feature).');
  return { text: out, mhCoef: fit.beta[K + 1], mhSe: fit.se[K + 1], cat, byMl };
}

/** Does the standing before a voyage predict the next voyage's score, and does the leader hold on? */
export function catchupSection(data) {
  const n = data.meta.players; const out = [];
  const lead = []; const last = []; const mid = [];
  let holdK = 0; let holdN = 0; let lastWinK = 0; let lastWinN = 0;
  const W = data.games.map(winnersOf);
  data.games.forEach((g, gi) => {
    const run = Array(n).fill(0);
    g.h.forEach((h, v) => {
      if (v > 0) {
        const top = Math.max(...run); const bot = Math.min(...run);
        if (top !== bot) {
          const m = mean(h.s);
          for (let s = 0; s < n; s++) (run[s] === top ? lead : run[s] === bot ? last : mid).push(h.s[s] - m);
          if (v === g.h.length - 1) {
            const leaders = run.map((x, s) => (x === top ? s : -1)).filter((s) => s >= 0);
            const trail = run.map((x, s) => (x === bot ? s : -1)).filter((s) => s >= 0);
            if (leaders.length === 1) { holdN++; holdK += W[gi].withTb.includes(leaders[0]) ? 1 / W[gi].withTb.length : 0; }
            if (trail.length === 1) { lastWinN++; lastWinK += W[gi].withTb.includes(trail[0]) ? 1 / W[gi].withTb.length : 0; }
          }
        }
      }
      for (let s = 0; s < n; s++) run[s] += h.s[s];
    });
  });
  out.push('Voyage score (minus the table mean for that voyage) by standing BEFORE the voyage (voyages 2 onwards, tables not level):');
  out.push(table(['standing before the voyage', 'n', 'mean edge ±95%'], [['leader (or joint leader)', lead.length, meanCI(lead, 3)], ['middle', mid.length, meanCI(mid, 3)], ['last (or joint last)', last.length, meanCI(last, 3)]]));
  out.push(`Leader alone going into the final voyage wins ${holdN ? ci(holdK, holdN) : '-'}% of the time (n = ${holdN}; base ${pct(1 / n)}%). Player alone in last place going into the final voyage wins ${lastWinN ? ci(lastWinK, lastWinN) : '-'}% (n = ${lastWinN}).`);
  return { text: out, lead, last, holdK, holdN, lastWinK, lastWinN };
}

// ---------- the report ----------
export function report(files, flags = {}) {
  const { detail = false, deal = false, moor = false, catchup = false, brief = false } = flags;
  const loaded = files.map((f) => ({ f, data: JSON.parse(readFileSync(f, 'utf8')) }));
  const S = loaded.map((x) => ({ x, s: summarise(x.data) }));
  const out = [];
  const cols = ['', ...S.map(({ x }, i) => `[${i + 1}] ${labelOf(x.data)}`)];
  const row = (name, f) => [name, ...S.map(({ s }) => f(s))];
  out.push('== Summary ==');
  const rows = [
    row('games', (s) => String(s.N)),
    row('voyages per game x tricks per game', (s) => `${(s.H / s.N).toFixed(0)} x ${mean(s.tricksPerGame).toFixed(0)}`),
    row('score per voyage, mean ±95%', (s) => pm(s.handScores)),
    row('voyage score sd (player-voyages)', (s) => sd(s.handScores).toFixed(2)),
    row('final total (mean, sd)', (s) => `${mean(s.totals).toFixed(1)} (${sd(s.totals).toFixed(1)})`),
    row('winner total, mean', (s) => mean(s.finals).toFixed(1)),
    row('margin 1st-2nd, mean ±95%', (s) => pm(s.margins)),
    row('tie for 1st on total %  [CI]', (s) => asProp(s.tiedArr)),
    row('tiebreak decided %  [CI]', (s) => asProp(s.tbArr)),
    row('still shared after tiebreak %  [CI]', (s) => asProp(s.sharedArr)),
    row('seat chi-square by offset (df n-1, p)', (s) => `${s.chiOff.toFixed(1)} (p ${chiP(s.chiOff, s.n - 1).toFixed(3)})`),
  ];
  for (const [label, num, den, scale] of MEAS) rows.push(row(label, (s) => withSe(ratio(s.chunks, num, den, scale))));
  out.push(table(cols, rows));

  if (S.length > 1) {
    // effects against column [1]: difference and z (* = outside 95%); for runs of the same seed the deals are shared
    const eff = [];
    const diffCell = (a, b, dp) => { const z = (b.v - a.v) / Math.sqrt(a.se ** 2 + b.se ** 2); return Number.isFinite(z) ? `${sgn(b.v - a.v, dp)} (z ${z.toFixed(1)})${Math.abs(z) >= 1.96 ? ' *' : ''}` : '-'; };
    const arrM = (xs) => ({ v: mean(xs), se: sd(xs) / Math.sqrt(xs.length) });
    const addArr = (label, get, dp, scale = 1) => eff.push([label, ...S.slice(1).map(({ s }) => diffCell({ v: arrM(get(S[0].s)).v * scale, se: arrM(get(S[0].s)).se * scale }, { v: arrM(get(s)).v * scale, se: arrM(get(s)).se * scale }, dp))]);
    addArr('margin 1st-2nd', (s) => s.margins, 2);
    addArr('tie for 1st on total %', (s) => s.tiedArr, 1, 100);
    addArr('tiebreak decided %', (s) => s.tbArr, 1, 100);
    addArr('still shared %', (s) => s.sharedArr, 1, 100);
    addArr('tricks per game', (s) => s.tricksPerGame, 1);
    addArr('winner total', (s) => s.finals, 2);
    for (const [label, num, den, scale] of MEAS) {
      const dp = scale === 100 ? 1 : 3;
      eff.push([label.trim(), ...S.slice(1).map(({ s }) => diffCell(ratio(S[0].s.chunks, num, den, scale), ratio(s.chunks, num, den, scale), dp))]);
    }
    out.push('', 'Effect against column [1] (difference, z; * = outside the 95% interval):');
    out.push(table(['measure', ...S.slice(1).map((_, i) => `[${i + 2}] v [1]`)], eff));
  }
  if (brief) return out.join('\n');

  for (const { x, s } of S) {
    const tag = `[${S.findIndex((q) => q.x === x) + 1}] ${labelOf(x.data)}`;
    out.push('', `== ${tag} ==`);
    out.push('Win % by bot (base rate = 1/n; "tiebreak" = the game rule; "no tiebreak" shares every tie):');
    out.push(table(['bot', 'seat-games', 'win % tiebreak [95% CI]', 'win % no tiebreak [95% CI]', 'base %', 'score/voyage ±95%', 'final total'],
      s.byLevel.map((b) => [b.lv, b.n, ci(b.k, b.n), ci(b.k0, b.n), pct(b.base), meanCI(b.perVoyage), b.mean.toFixed(2)])));
    out.push('', 'Win % by position after the first dealer (0 = first dealer of voyage 1, 1 = its first leader):');
    out.push(table(['offset', 'win % [95% CI]'], s.byOffset.map((b) => [b.off, ci(b.k, b.n)])));
    if (detail || s.byLevel.length === 1 || !x.data.meta.rotate) {
      out.push('', 'Win % by seat number:');
      out.push(table(['seat', 'win % [95% CI]'], s.bySeat.map((b) => [b.seat, ci(b.k, b.n)])));
      out.push(...seatSection(x.data, s));
    }
    if (deal) out.push('', ...dealSection(x.data).text);
    if (moor) out.push('', ...moorSection(x.data).text);
    if (catchup) out.push('', ...catchupSection(x.data).text);
  }
  return out.join('\n');
}

// ---------- reference layout ----------
const APPB = [
  ['clean %', 'clean', 'tricks', 100, 1], ['trades/pp', 'trades', 'pv', 1, 2], ['trade win %', 'tw', 'trades', 100, 1],
  ['trade serp %', 'tsp', 'trades', 100, 1], ['no duck %', 'nd', 'trades', 100, 1], ['forced10/pp', 'f1', 'pv', 1, 2], ['any10/pp', 't10', 'pv', 1, 2],
  ['sails/pp', 'sails', 'pv', 1, 2], ['laps', 'sails', 'pv', 1 / 8, 2], ['never sailed %', 'park', 'pv', 100, 1], ['ties %', 'ties', 'tricks', 100, 1],
];
export function appendixB(files) {
  const rows = []; const seatLines = [];
  for (const f of files) {
    const d = JSON.parse(readFileSync(f, 'utf8')); const ch = batchSums(d, 200);
    const label = `${d.meta.players}p ${[...new Set(d.meta.seats)].join('/')}`;
    rows.push([label, ...APPB.map(([, a, b, sc, dp]) => ratio(ch, a, b, sc).v.toFixed(dp)),
      f2(sum(ch.map((c) => c.sc)) / sum(ch.map((c) => c.pv))), f2(mean(ch.map(chunkSd))), sgn(mean(ch.map(chunkTwin)))]);
    const n = d.meta.players;
    seatLines.push(`  ${label}: ` + Array.from({ length: n }, (_, o) => sgn(sum(ch.map((c) => c.seatS[o])) / sum(ch.map((c) => c.k))))
      .join('  '));
  }
  return [table(['config', ...APPB.map((r) => r[0]), 'mean', 'sd', 'twin+'], rows), '', 'Seat mean voyage scores (offset 0 = first leader):', ...seatLines].join('\n');
}

// ---------- cross-check against the Python simulator's batches ----------
const PY_DEAL = { 4: { 2: 13, 3: 13, 4: 10, 5: 8 }, 5: { 2: 13, 3: 16, 4: 12, 5: 10 } };
/** A Python batch (the dict run_config returns for B voyages) rebuilt into the same sums as batchSums. */
export function pyBatchToSums(b, n, suits, B) {
  const pv = B * n; const tricks = B * PY_DEAL[suits][n]; const trades = b.trades_pp * pv;
  return {
    k: B, pv, tricks, clean: (b['pos%'] / 100) * tricks, trades, tw: (b['trade_win%'] / 100) * trades,
    wf: ((b['trade_win%'] - b['trade_serpwin%']) / 100) * trades, tsp: (b['trade_serpwin%'] / 100) * trades, nd: (b['noduck%'] / 100) * trades,
    f1: NaN, t10: b.t10_pp * pv, disc: b.disc_pp * pv, sails: b.sails_pp * pv, park: (b['parked%'] / 100) * pv, ties: (b['ties%'] / 100) * tricks,
    mean: b.mean, sdv: b.sd, twin: b.twin_gain, seats: b.seats,
  };
}
const PY_BOT = { easy: 'random', medium: 'heuristic' };
/** Measure-by-measure comparison of a sim file (all seats the same bot) with the Python config of the same count and bot. */
export function crossPython(jsFile, pyFile, suits = 4) {
  const d = JSON.parse(readFileSync(jsFile, 'utf8')); const py = JSON.parse(readFileSync(pyFile, 'utf8'));
  const n = d.meta.players; const bots = [...new Set(d.meta.seats)];
  if (bots.length !== 1 || !PY_BOT[bots[0]]) throw new Error('cross-check needs a file whose seats are all easy or all medium');
  const cfg = py.configs.find((c) => c.n === n && c.bot === PY_BOT[bots[0]] && c.suits === suits);
  if (!cfg) throw new Error(`the Python file has no ${suits}-cargo ${PY_BOT[bots[0]]} line at ${n} players`);
  const B = cfg.B;
  const js = batchSums(d, B); const pc = cfg.batches.map((b) => pyBatchToSums(b, n, suits, B));
  const rows = [];
  let within = 0; let total = 0;
  const push = (label, a, b, dp, note = '') => {
    const z = (a.v - b.v) / Math.sqrt(a.se ** 2 + b.se ** 2);
    if (Number.isFinite(z)) { total++; if (Math.abs(z) < 1.96) within++; }
    rows.push([label, `${a.v.toFixed(dp)} ±${(1.96 * a.se).toFixed(dp)}`, Number.isFinite(b.v) ? `${b.v.toFixed(dp)} ±${(1.96 * b.se).toFixed(dp)}` : 'n/a', Number.isFinite(z) ? z.toFixed(2) : '-', Number.isFinite(z) ? verdict(z) : `JS only${note}`]);
  };
  for (const [label, num, den, scale] of MEAS) {
    const dp = scale === 100 ? 1 : 3;
    push(label.trim(), ratio(js, num, den, scale), ratio(pc, num, den, scale), dp);
  }
  const arr = (xs) => ({ v: mean(xs), se: sd(xs) / Math.sqrt(xs.length) });
  push('mean voyage score', arr(js.map((c) => c.sc / c.pv)), arr(pc.map((c) => c.mean)), 3);
  push('voyage score sd', arr(js.map(chunkSd)), arr(pc.map((c) => c.sdv)), 3);
  push('twin start gain (first of a pair v the rest)', arr(js.map(chunkTwin).filter(Number.isFinite)), arr(pc.map((c) => c.twin).filter(Number.isFinite)), 3);
  for (let o = 0; o < n; o++) push(`seat mean score, leader offset ${o}`, arr(js.map((c) => c.seatS[o] / c.k)), arr(pc.map((c) => c.seats[o])), 3);
  return { text: table(['measure', `JS (${js.length} batches of ${B} voyages)`, `Python (${pc.length} batches of ${B})`, 'z', 'verdict'], rows), within, total, jsBatches: js.length, pyBatches: pc.length };
}

// ---------- cross-check against a second sim file ----------
/**
 * Side-by-side table of two sim files with the z of the difference.
 * |z| < 1.96 = "within CI" (the difference is not distinguishable from noise at 95%).
 */
export function crossCheck(jsFile, refFile) {
  const a = summarise(JSON.parse(readFileSync(jsFile, 'utf8')));
  const b = summarise(JSON.parse(readFileSync(refFile, 'utf8')));
  const rows = [];
  const add = (name, xs, ys, kind) => {
    const z = diffZ(xs, ys);
    const f = kind === 'pct' ? (arr) => `${pct(mean(arr), 1)}%` : (arr) => mean(arr).toFixed(2);
    rows.push([name, f(xs), f(ys), z.toFixed(2), verdict(z)]);
  };
  add('tricks per voyage', a.tricksPerHand, b.tricksPerHand, 'num');
  add('tricks won by a trade (per-voyage mean of the share)', a.trumpTrickArr, b.trumpTrickArr, 'pct');
  add('tied games (tie for 1st on total)', a.tiedArr, b.tiedArr, 'pct');
  add('margin 1st-2nd', a.margins, b.margins, 'num');
  for (const lv of a.levels) {
    const bl = b.byLevel.find((l) => l.lv === lv);
    const al = a.byLevel.find((l) => l.lv === lv);
    if (bl && al) add(`win % per seat: ${lv}`, al.cred0, bl.cred0, 'pct');
  }
  const head = ['measure', `This file (${a.N} games)`, `Reference (${b.N} games)`, 'z of difference', 'verdict'];
  return table(head, rows);
}

// ---------- CLI ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--'));
  const opt = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
  if (!files.length) { console.error('usage: node tests/sim-report.mjs file.json [file2.json ...] [--detail --deal --moor --catchup --appb --py=python.json --vs=reference.json]'); process.exit(2); }
  const has = (f) => args.includes(`--${f}`);
  if (has('appb')) {
    console.log(appendixB(files));
    const py = opt('py');
    if (py) for (const f of files) { const r = crossPython(f, py, Number(opt('suits') || 4)); console.log('', `== ${f} v Python: ${r.within} of ${r.total} measures within CI ==`, r.text); }
  } else if (opt('vs')) console.log(crossCheck(files[0], opt('vs')));
  else console.log(report(files, { detail: has('detail'), deal: has('deal'), moor: has('moor'), catchup: has('catchup'), brief: has('brief') }));
}
