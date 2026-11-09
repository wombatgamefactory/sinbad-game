// scoring.js - voyage scores and the game result: totals, ranking, tiebreak, shared wins.
//
// R5.2 voyage score = tricks won x trickPoints (+1; 0 under SCORING=serpents, R13.5)
//                   + serpents taken x serpentPoints (-1), whoever played the serpent cards.
// R5.3 scores and totals may be negative.
// R6.1 - R6.4 tiebreak: of the players tied on the top total, the one with the MOST points in the
// final voyage wins; still tied = shared win. Only the players tied at the top are compared.

/**
 * The reckoning of a voyage that has just ended: per-seat breakdown (R5.7 arithmetic).
 * @param {object} state  at the moment the voyage ends
 * @returns {{ trickPoints:number, serpentPoints:number, scores:number[],
 *   lines: {tricks:number, serpents:number, trickScore:number, serpentScore:number, score:number}[] }}
 */
export function reckonHand(state) {
  const n = state.n;
  const P = state.params.trickPoints;
  const S = state.params.serpentPoints;
  const lines = Array.from({ length: n }, (_, s) => {
    const tricks = state.tricksWon[s];
    const serpents = state.serpentsTaken[s];
    const trickScore = tricks * P;
    const serpentScore = serpents * S;
    return { tricks, serpents, trickScore, serpentScore, score: trickScore + serpentScore };
  });
  return { trickPoints: P, serpentPoints: S, scores: lines.map((l) => l.score), lines };
}

/**
 * The result of a finished game (also usable mid-game as a provisional standing).
 * @returns {{
 *   totals: number[], handScores: number[][], lastHand: number[],
 *   winners: number[], shared: boolean, tiebreakUsed: boolean, tiedOnTotal: number[],
 *   ranking: {seat:number, total:number, last:number, rank:number}[],
 *   winningScore: number, margin: number, hands: number, tricks: number }}
 *   lastHand: each seat's score in the final voyage played (the tiebreak value); zeros before any voyage.
 *   winners: seats that win (more than one = shared win).
 *   tiebreakUsed: the final-voyage score separated players tied on the top total (R6.4).
 *   margin: top total minus the next-best total (0 on a tie).
 *   ranking: by total, then final-voyage score, most first; equal on both = equal rank.
 */
export function gameResult(state) {
  const n = state.n;
  const totals = [...state.totals];
  const lastLog = state.handLog.length ? state.handLog[state.handLog.length - 1] : null;
  const lastHand = Array.from({ length: n }, (_, s) => (lastLog ? lastLog.scores[s] : 0));
  const top = Math.max(...totals);
  const tied = totals.map((t, s) => (t === top ? s : -1)).filter((s) => s >= 0);
  let winners = tied;
  if (tied.length > 1) {
    const most = Math.max(...tied.map((s) => lastHand[s]));
    winners = tied.filter((s) => lastHand[s] === most); // still tied -> shared (R6.2, R6.3)
  }
  const better = (a, b) => totals[a] > totals[b] || (totals[a] === totals[b] && lastHand[a] > lastHand[b]);
  const seats = Array.from({ length: n }, (_, s) => s);
  const ranking = [...seats]
    .sort((a, b) => totals[b] - totals[a] || lastHand[b] - lastHand[a] || a - b)
    .map((s) => ({ seat: s, total: totals[s], last: lastHand[s], rank: 1 + seats.filter((o) => better(o, s)).length }));
  const sorted = [...totals].sort((a, b) => b - a);
  return {
    totals,
    handScores: state.handLog.map((h) => [...h.scores]),
    lastHand,
    winners,
    shared: winners.length > 1,
    tiebreakUsed: winners.length < tied.length,
    tiedOnTotal: tied,
    ranking,
    winningScore: top,
    margin: n > 1 ? sorted[0] - sorted[1] : 0,
    hands: state.handLog.length,
    tricks: state.measures.tricks,
  };
}
