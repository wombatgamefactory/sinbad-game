// stats-view.js - the stats screen markup (a dialog body) and the download helper. Pure string
// builders except download(), which needs the DOM. Numbers always come with their counts so a
// small sample is obvious.
// The "Trades and serpents" section shows Sinbad's own numbers (summarise().extra). Keep the section
// titles in step with tests/stats-node.mjs and tests/stats-browser.mjs.

import { esc } from './assets.js';
import { summarise, KINDS } from './stats-store.js';

const KIND_LABEL = { human: 'Human', easy: 'Easy bot', medium: 'Medium bot', hard: 'Hard bot' };
const LEVEL_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const num = (x, dp = 1) => (x === null || x === undefined || Number.isNaN(x) ? '-' : x.toFixed(dp).replace(/^-(0(\.0+)?)$/, '$1')); // never "-0.0"
const small = (n) => (n < 10 ? ' <span class="st__small" title="Fewer than 10 games: treat with care">(small sample)</span>' : '');
const codeLabel = (c) => (c === 'std' ? 'Standard rules' : c);

function table(head, rows) {
  return `<div class="st__scroll"><table class="st__table"><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function filterHtml(s) {
  if (s.codes.length < 2) return '';
  const opts = [`<option value="all"${s.filter === 'all' ? ' selected' : ''}>All games (${s.allTotal})</option>`]
    .concat(s.codes.map((c) => `<option value="${esc(c.code)}"${s.filter === c.code ? ' selected' : ''}>${esc(codeLabel(c.code))} (${c.games})</option>`));
  return `<label class="st__filter">Show rules <select data-action="stats-filter" aria-label="Show games played under these rules">${opts.join('')}</select></label>`;
}

/** The whole stats dialog body. `filter` is 'all' or a rules_code. */
export function statsHtml(data, filter = 'all') {
  const games = data && Array.isArray(data.games) ? data.games : [];
  let s = summarise(games, filter);
  if (!s.allTotal) {
    return '<div class="st"><p class="st__empty">No games recorded yet. Finish a game and your results will appear here. They are kept in this browser only.</p></div>';
  }
  if (filter !== 'all' && !s.codes.some((c) => c.code === filter)) s = summarise(games, 'all');

  const kindRows = KINDS.filter((k) => s.byKind[k].seats).map((k) => {
    const t = s.byKind[k];
    return `<tr><th scope="row">${KIND_LABEL[k]}</th><td>${t.seats}</td><td>${t.wins}</td><td>${pct(t.wins, t.seats)}</td><td>${num(t.totalSum / t.seats)}${small(t.seats)}</td></tr>`;
  });
  const vsRows = Object.entries(s.humanVs).filter(([, v]) => v.games).map(([level, v]) =>
    `<tr><th scope="row">Human v ${LEVEL_LABEL[level]} bot</th><td>${v.games}</td><td>${pct(v.humanWins, v.humanSeats)}</td><td>${pct(v.botWins, v.botSeats)}${small(v.games)}</td></tr>`);
  const posRows = s.bySeat.map((t, i) => (t.seats ? `<tr><th scope="row">Seat ${i + 1}</th><td>${t.seats}</td><td>${t.wins}</td><td>${pct(t.wins, t.seats)}</td><td>${num(t.totalSum / t.seats)}${small(t.seats)}</td></tr>` : ''));
  const playerRows = Object.keys(s.byPlayers).sort().map((n) => {
    const p = s.byPlayers[n];
    return `<tr><th scope="row">${n} players</th><td>${p.games}</td><td>${num(p.hands ? p.scoreSum / p.hands : null)}</td><td>${num(p.marginSum / p.games)}</td><td>${num(p.winSum / p.games)}${small(p.games)}</td></tr>`;
  });
  const t = s.ties;
  const ex = s.extra;
  const ruleRows = s.byRules.map((r) =>
    `<tr><th scope="row">${esc(codeLabel(r.code))}</th><td>${r.games}</td><td>${num(r.hands ? r.scoreSum / r.hands : null)}</td><td>${num(r.marginSum / r.games)}</td><td>${num(r.voyages ? r.trades / r.voyages : null, 2)}</td><td>${pct(r.tied, r.games)}</td><td>${pct(r.tiebreak, r.games)}</td><td>${pct(r.shared, r.games)}${small(r.games)}</td></tr>`);

  return `<div class="st">
    <p class="st__lead"><b>${s.total}</b> game${s.total === 1 ? '' : 's'} played${s.filter === 'all' ? '' : ` under ${esc(codeLabel(s.filter))}`}. Average score per voyage <b>${num(s.avgScorePerHand)}</b>, average winning margin <b>${num(s.avgMargin)}</b>.${small(s.total)}</p>
    ${filterHtml(s)}
    <h3>Win rate by seat type</h3>
    <p class="st__muted">A seat wins when it is a winner, so a shared win counts for each winner. With N players a fair share is 1 in N.</p>
    ${table(['Seat type', 'Seats played', 'Wins', 'Win rate', 'Avg total score'], kindRows)}
    ${vsRows.length ? `<h3>Human against each bot level</h3><p class="st__muted">Games with at least one human and at least one bot of that level. Win rate is per seat.</p>${table(['Matchup', 'Games', 'Human win rate', 'Bot win rate'], vsRows)}` : ''}
    <h3>Win rate by seat position</h3>
    ${table(['Position', 'Seats played', 'Wins', 'Win rate', 'Avg total score'], posRows)}
    <h3>Scores by player count</h3>
    ${table(['Players', 'Games', 'Avg score per voyage', 'Avg margin', 'Avg winning score'], playerRows)}
    <h3>Trades and serpents</h3>
    <p class="st__muted">A trade is a card laid sideways because the island demands its cargo. A forced 10 is a trade where the 10 was the only island-cargo card held, so it had to be played.</p>
    ${table(['Measure', 'Total', 'Per voyage', 'Per player per voyage'], [
      ['Trades', ex.trades], ['Trades that won the trick', ex.tradesWon], ['Forced 10s', ex.forcedTens],
      ['Sails (cards that did not follow)', ex.sails], ['Serpents taken', ex.serpents],
    ].map(([label, n]) => `<tr><th scope="row">${label}</th><td>${n}</td><td>${num(ex.voyages ? n / ex.voyages : null, 2)}</td><td>${num(ex.playerVoyages ? n / ex.playerVoyages : null, 2)}</td></tr>`))}
    <p>Over ${ex.voyages} voyage${ex.voyages === 1 ? '' : 's'} and ${ex.tricks} tricks: trades won <b>${pct(ex.tradesWon, ex.trades)}</b> of the time, and <b>${pct(ex.trades, ex.tricks)}</b> of tricks held a trade.${small(s.total)}</p>
    <h3>Ties and the tiebreak</h3>
    <p class="st__muted">The tiebreak is most points in the final voyage; if that is level too, the win is shared.</p>
    <p>Level on the top total: <b>${t.tied}</b> of ${t.games} (${pct(t.tied, t.games)}). Tiebreak decided it: <b>${t.tiebreak}</b> (${pct(t.tiebreak, t.games)}). Win shared: <b>${t.shared}</b> (${pct(t.shared, t.games)}).${small(t.games)}</p>
    <h3>By rules</h3>
    <p class="st__muted">Every game, split by the rules it was played under, so a Playtest game is never mixed with a standard one.</p>
    ${table(['Rules', 'Games', 'Avg score per voyage', 'Avg margin', 'Trades per voyage', 'Level on top', 'Tiebreak decided', 'Shared win'], ruleRows)}
    <p class="st__muted">Stored in this browser only (last 2000 games). Nothing here is sent anywhere.</p>
  </div>`;
}

export function statsButtonsHtml(hasData) {
  const dis = hasData ? '' : ' disabled';
  return `<button type="button" class="btn btn--small" data-action="export-csv"${dis}>Export CSV</button>`
    + `<button type="button" class="btn btn--small" data-action="export-json"${dis}>Export JSON</button>`
    + `<button type="button" class="btn btn--small" data-action="clear-stats"${dis}>Clear</button>`;
}

/** Blob + <a download>. Returns true if the click was issued. Never throws. */
export function download(filename, text, mime) {
  try {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch {
    return false;
  }
}
