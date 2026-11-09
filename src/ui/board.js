// board.js - the presentation model: what the table looks like, and how it changes event by event.
//
// One call of applyAction can play many forced moves, win the last trick, sail ships, end the voyage,
// lay the next ring and deal, and even end the game. So the screen cannot simply draw `state` after
// each action: it would jump over the last trick of every voyage. Instead the UI keeps a small "board"
// (everything that is drawn: the ring and the ships, the trick on the table, hand counts, serpent rows,
// the turn, the pad) and walks the returned events over it, one frame per beat, so every trick, every
// sail and every reckoning is seen.
//
//   boardFromState(state, humanSeats)    the board for a live state
//   reduceBoard(board, event, ctx)       the board after one engine event (a fresh copy)
//   buildFrames(board, events, ctx)      the frames to show, in order, for one action's events
//
// No rules live here: every number comes from an event (who won, who sailed where, the scores).
// tests/ui-node.mjs replays thousands of actions and requires that walking the events over the
// board before the action gives exactly boardFromState(state after the action). Pure and
// DOM-free: runs in Node.

const copy = (x) => JSON.parse(JSON.stringify(x));

/** Fields that only exist while a frame is on screen (excluded from the live-board equality test). */
export const TRANSIENT = ['fx', 'last', 'banner'];

const playOf = (p) => ({ seat: p.seat, card: p.card, mode: p.mode, sideways: !!p.sideways, countsAs: p.countsAs || null });

/**
 * @param {object} state        the live engine state
 * @param {number[]} humanSeats seats whose hand the UI may need to show (others get null)
 */
export function boardFromState(state, humanSeats = []) {
  const n = state.n;
  let trick = null;
  if (state.trick) {
    const t = state.trick;
    trick = {
      n: t.n, leader: t.leader, seats: [...t.seats], ledSuit: t.ledSuit,
      plays: t.plays.map(playOf),
      winner: null, winningCard: null, winningMode: null, tie: false, done: false,
    };
  }
  return {
    n,
    rules: copy(state.rules),
    trickPoints: state.params.trickPoints,
    serpentPoints: state.params.serpentPoints,
    handsPerGame: state.params.handsPerGame,
    handNo: state.handNo,
    handSize: state.handSize,
    phase: state.phase,
    dealer: state.dealer,
    toAct: state.toAct,
    mooringOrder: [...state.mooringOrder],
    ring: [...state.ring],
    islandFaces: [...state.islandFaces],
    ships: [...state.ships],
    setAsideCount: state.setAside.length,
    trickNo: state.trickNo, // completed tricks this voyage
    tricksWon: [...state.tricksWon],
    serpentsTaken: [...state.serpentsTaken],
    serpentRows: state.serpentRows.map((r) => [...r]),
    handCounts: state.hands.map((h) => h.length),
    totals: [...state.totals],
    trick,
    hands: state.hands.map((h, s) => (humanSeats.includes(s) ? [...h] : null)),
    fx: null,
    last: null,
    banner: null,
  };
}

/**
 * The board after one engine event. `ctx`:
 *   liveHands(seat)   the live state's hand for a human seat (used when a voyage is dealt)
 */
export function reduceBoard(board, ev, ctx = {}) {
  const b = copy(board);
  b.fx = null;
  b.banner = null;
  const n = b.n;
  switch (ev.type) {
    case 'game-started':
      return b;
    case 'voyage-started': {
      b.handNo = ev.handNo;
      b.dealer = ev.dealer;
      b.handSize = ev.handSize;
      b.phase = 'moor';
      b.mooringOrder = [...ev.mooringOrder];
      b.toAct = ev.mooringOrder[0];
      b.setAsideCount = ev.setAsideCount;
      b.ships = Array.from({ length: n }, () => null);
      b.trickNo = 0;
      b.tricksWon = Array.from({ length: n }, () => 0);
      b.serpentsTaken = Array.from({ length: n }, () => 0);
      b.serpentRows = Array.from({ length: n }, () => []);
      b.handCounts = Array.from({ length: n }, () => ev.handSize);
      b.trick = null;
      b.last = null;
      b.hands = b.hands.map((h, s) => (h === null ? null : (ctx.liveHands ? [...ctx.liveHands(s)] : [])));
      b.fx = { dealt: true };
      return b;
    }
    case 'ring-laid':
      b.ring = [...ev.ring];
      b.islandFaces = [...ev.islandFaces];
      b.fx = { ring: true };
      return b;
    case 'ship-moored': {
      b.ships[ev.seat] = ev.island;
      const i = b.mooringOrder.indexOf(ev.seat);
      b.toAct = i < b.mooringOrder.length - 1 ? b.mooringOrder[i + 1] : null;
      b.fx = { moored: ev.seat };
      return b;
    }
    case 'ships-moored':
      b.phase = 'play';
      b.toAct = ev.leader;
      return b;
    case 'card-played': {
      if (ev.asLeader) {
        b.trick = {
          n: ev.trickNo, leader: ev.seat, seats: Array.from({ length: n }, (_, k) => (ev.seat + k) % n), ledSuit: null, plays: [],
          winner: null, winningCard: null, winningMode: null, tie: false, done: false,
        };
      }
      const t = b.trick;
      t.ledSuit = ev.ledSuit;
      t.plays.push(playOf(ev));
      b.handCounts[ev.seat]--;
      if (b.hands[ev.seat]) b.hands[ev.seat] = b.hands[ev.seat].filter((c) => c !== ev.card);
      const i = t.seats.indexOf(ev.seat);
      b.toAct = i < t.seats.length - 1 ? t.seats[i + 1] : null;
      b.last = null;
      return b;
    }
    case 'trick-won': {
      const t = b.trick;
      b.tricksWon[ev.winner]++;
      b.trickNo = ev.trickNo;
      const decided = copy(t);
      decided.winner = ev.winner;
      decided.winningCard = ev.card;
      decided.winningMode = ev.mode;
      decided.tie = !!ev.tie;
      decided.done = true;
      b.last = { trick: decided, event: copy(ev) };
      b.fx = { won: ev.winner };
      b.trick = null;
      b.toAct = ev.winner; // the winner leads next
      return b;
    }
    case 'serpent-taken':
      b.serpentRows[ev.seat].push(...ev.cards);
      b.serpentsTaken[ev.seat] += ev.serpents;
      b.fx = { serpents: ev.seat };
      return b;
    case 'sailed':
      b.ships[ev.seat] = ev.to;
      b.fx = { sailed: ev.seat };
      return b;
    case 'voyage-ended':
      b.totals = [...ev.totals];
      b.handNo = ev.handNo + 1;
      b.trick = null;
      b.toAct = null;
      b.fx = { handEnded: true };
      return b;
    case 'game-over':
      b.phase = 'over';
      b.toAct = null;
      return b;
    default:
      return b;
  }
}

/** Compares two boards ignoring transient display fields. */
export function sameBoard(a, b) {
  const strip = (x) => { const c = copy(x); for (const k of TRANSIENT) delete c[k]; return JSON.stringify(c); };
  return strip(a) === strip(b);
}

/**
 * Frames for the events of ONE action, starting from `board` (what is on screen now).
 * A frame: { board, hold, kind, log?, logKind?, modal?, sails? (kind 'sail': [{ seat, from, to, cause }]) }
 *   hold   ms to stay on the frame before the next one, BEFORE pacing scale (the UI multiplies);
 *          `Infinity` = wait for the player (a modal). 0 = go straight on.
 * ctx adds `names` (seat labels) and `trickText(trick, event, names)` for the log sentence,
 * `describe(ev, names)` for the other log lines.
 */
export function buildFrames(board, events, ctx) {
  const frames = [];
  let b = board;
  const push = (board2, extra) => { frames.push({ board: board2, hold: 0, kind: 'plain', ...extra }); b = board2; };
  events.forEach((ev) => {
    switch (ev.type) {
      case 'voyage-started':
        push(reduceBoard(b, ev, ctx), { kind: 'deal', hold: 450, log: ctx.describe(ev, ctx.names), logKind: 'hand' });
        break;
      case 'ring-laid':
        push(reduceBoard(b, ev, ctx), { kind: 'ring', hold: 300, log: ctx.describe(ev, ctx.names), logKind: 'info' });
        break;
      case 'ship-moored':
        push(reduceBoard(b, ev, ctx), { kind: 'moor', hold: 0, log: ctx.describe(ev, ctx.names), logKind: 'info' });
        break;
      case 'card-played':
        push(reduceBoard(b, ev, ctx), { kind: 'card', hold: ev.auto ? 450 : 0 });
        break;
      case 'trick-won': {
        // Beat 1: all the cards are down and the winner is marked; beat 2: the trick is taken.
        const decided = copy(b);
        decided.trick.winner = ev.winner;
        decided.trick.winningCard = ev.card;
        decided.trick.winningMode = ev.mode;
        decided.trick.tie = !!ev.tie;
        decided.trick.done = true;
        decided.banner = { winner: ev.winner, card: ev.card, mode: ev.mode, tie: !!ev.tie, tieBrokenBy: ev.tieBrokenBy || null, serpents: ev.serpents };
        push(decided, { kind: 'decided', hold: 1250 });
        const nb = reduceBoard(b, ev, ctx);
        push(nb, { kind: 'resolve', hold: 500, log: ctx.trickText(nb.last.trick, ev, ctx.names), logKind: 'trick' });
        break;
      }
      case 'serpent-taken':
        push(reduceBoard(b, ev, ctx), { kind: 'serpents', hold: 0 }); // the trick sentence already names the serpents
        break;
      case 'sailed': {
        // Every sail of one trick is one beat: the ships slide together.
        const nb = reduceBoard(b, ev, ctx);
        const prev = frames[frames.length - 1];
        const line = ctx.describe(ev, ctx.names);
        const move = { seat: ev.seat, from: ev.from, to: ev.to, cause: ev.cause };
        if (prev && prev.kind === 'sail' && prev.trickNo === ev.trickNo && prev.handNo === ev.handNo) {
          prev.board = nb;
          prev.log = `${prev.log} ${line}`;
          prev.sails.push(move);
          b = nb;
        } else {
          // `sails` lets the screen slide each ship from its old island to its new one.
          push(nb, { kind: 'sail', hold: 900, log: line, logKind: 'info', trickNo: ev.trickNo, handNo: ev.handNo, sails: [move] });
        }
        break;
      }
      case 'voyage-ended': {
        // Show the reckoning over the table as it stands, then move on.
        const modal = { kind: 'hand', handNo: ev.handNo, event: copy(ev) };
        push(copy(b), { kind: 'hand-end', hold: Infinity, modal });
        push(reduceBoard(b, ev, ctx), { kind: 'plain', hold: 0 });
        break;
      }
      case 'game-over':
        push(reduceBoard(b, ev, ctx), { kind: 'over', hold: 0, log: ctx.describe(ev, ctx.names), logKind: 'hand' });
        break;
      default:
        b = reduceBoard(b, ev, ctx); // events with no beat of their own (ships-moored) still change the board
        if (frames.length) frames[frames.length - 1].board = b;
        else push(b, { kind: 'plain', hold: 0 });
        break;
    }
  });
  return frames;
}
