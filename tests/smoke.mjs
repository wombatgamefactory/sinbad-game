// smoke.mjs - Easy bots only: many games at each of 2, 3, 4 and 5 players, and many games under
// every non-default variant value (player counts rotating 2..5). Every game must terminate, with
// zero refused bot actions, legalActionsFromView = getValidActions at every decision, card
// conservation after every action, every player to act holding a card, and the state JSON
// round-tripping (play continues on the parsed copy). The same seed must give an identical game.
// Sinbad's own invariants, checked on every action's events (rules list R4.2, R4.10, R4.13, R5.5,
// R10): a discard is never of the led cargo nor of the player's island cargo; a trade is of the island
// cargo and counts as led; exactly the non-followers sail, one island clockwise, never the leader; a
// discard never wins; every voyage's tricks sum to the hand size and its serpents to the trick serpents;
// a returned state is never in 'voyageEnd'. Card conservation (R10) after every action.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import {
  startGame, applyAction, getValidActions, getActionBlockReason, viewFor, legalActionsFromView,
  makeRng, deriveSeed, VARIANTS,
} from '../src/engine/index.js';
import { getBot } from '../src/bots/index.js';
import { suite, conservation } from './lib.mjs';

const { check, done } = suite('smoke');
const GAMES = 600;
const MAX_ACTIONS_PER_GAME = 2000; // a game is well under 400 decisions; near this is a livelock
const ROUND_TRIP_EVERY_STEP_GAMES = 30; // per run: the first N games round-trip after every action; the rest after every hand

/** Plays a game with Easy bots; returns counters. */
function playOut(players, rules, seed, everyStep) {
  const r = { refusals: 0, actions: 0, roundTripBad: 0, viewBad: 0, consBad: 0, consProblem: '', emptyToAct: 0, ruleBad: 0, ruleProblem: '', over: false, events: [] };
  const started = startGame({ seed, players, rules });
  let state = started.state;
  r.events.push(...started.events);
  const ctx = { plays: [] };
  const rngs = Array.from({ length: players }, (_, s) => makeRng(deriveSeed(seed, 'bot', s)));
  {
    const c = conservation(state);
    if (!c.ok) { r.consBad++; r.consProblem = c.problem; }
  }
  while (state.toAct !== null && r.actions < MAX_ACTIONS_PER_GAME) {
    const seat = state.toAct;
    if (state.phase === 'play' && state.hands[seat].length === 0) r.emptyToAct++;
    const view = viewFor(state, seat);
    if (JSON.stringify(legalActionsFromView(view)) !== JSON.stringify(getValidActions(state))) r.viewBad++;
    const action = getBot('easy').chooseAction(view, rngs[seat]);
    if (getActionBlockReason(state, action) !== null) { r.refusals++; break; }
    const handBefore = state.handNo;
    const evs = applyAction(state, action);
    r.events.push(...evs);
    r.actions++;
    const c = conservation(state);
    if (!c.ok) { r.consBad++; r.consProblem = r.consProblem || c.problem; }
    const bad = invariants(evs, state, ctx);
    if (bad) { r.ruleBad++; r.ruleProblem = r.ruleProblem || bad; }
    if (everyStep || state.handNo !== handBefore || state.toAct === null) {
      const text = JSON.stringify(state);
      const copy = JSON.parse(text);
      if (JSON.stringify(copy) !== text) r.roundTripBad++;
      state = copy; // continue on the round-tripped copy
    }
  }
  r.over = state.phase === 'over' && state.result !== null;
  r.state = state;
  return r;
}

/** Sinbad's invariants over one action's events; returns a problem string or ''. */
function invariants(evs, state, ctx) {
  if (!['moor', 'play', 'over'].includes(state.phase)) return `returned in phase ${state.phase}`;
  let plays = ctx.plays;
  for (const e of evs) {
    if (e.type === 'card-played') {
      if (e.asLeader) { plays = []; ctx.plays = plays; }
      plays.push(e);
      const cg = e.card.split('-')[0];
      if (e.mode === 'discard' && (cg === e.ledSuit || cg === e.islandCargo)) return `R4.13 discard ${e.card} led ${e.ledSuit} island ${e.islandCargo}`;
      if (e.mode === 'trade' && (cg !== e.islandCargo || e.countsAs !== e.ledSuit || !e.sideways)) return `R4.5 trade ${e.card}`;
      if (e.mode === 'follow' && cg !== e.ledSuit) return `R4.3 follow ${e.card}`;
    } else if (e.type === 'trick-won') {
      const w = plays.find((p) => p.seat === e.winner);
      if (!w || w.mode === 'discard') return 'R4.7 a discard won';
      const sailers = plays.filter((p) => p.mode === 'trade' || p.mode === 'discard').map((p) => p.seat);
      const sailed = evs.filter((x) => x.type === 'sailed' && x.handNo === e.handNo && x.trickNo === e.trickNo);
      if (sailed.map((x) => x.seat).join() !== sailers.join()) return `R4.10 sailers ${sailers} v sailed ${sailed.map((x) => x.seat)}`;
      if (sailed.some((x) => x.to !== (x.from + 1) % 8)) return 'R4.10 a sail of more than one island';
      if (sailers.includes(plays[0].seat)) return 'R4.2 the leader sailed';
    } else if (e.type === 'voyage-ended') {
      const rec = state.handLog[e.handNo];
      if (rec.tricksWon.reduce((a, b) => a + b, 0) !== rec.handSize) return 'R5.5 tricks do not sum to the hand size';
      if (rec.serpentsTaken.reduce((a, b) => a + b, 0) !== rec.tricks.reduce((a, t) => a + t.serpents, 0)) return 'R5.5 serpents do not add up';
      if (state.params.serpentsInDeck === 12 && rec.setAside === 0 && rec.serpentsTaken.reduce((a, b) => a + b, 0) !== 12) return 'R5.5 12 serpents at 4 and 5 players';
    }
  }
  return '';
}

function run(label, playersFor, rules, games = GAMES) {
  let refusals = 0; let unfinished = 0; let rt = 0; let view = 0; let cons = 0; let firstProblem = ''; let actions = 0; let shared = 0; let tiebreaks = 0; let empty = 0; let ruleBad = 0; let ruleProblem = '';
  for (let i = 0; i < games; i++) {
    const r = playOut(playersFor(i), rules, deriveSeed('smoke', label, i), i < ROUND_TRIP_EVERY_STEP_GAMES);
    refusals += r.refusals; rt += r.roundTripBad; view += r.viewBad; cons += r.consBad; actions += r.actions; empty += r.emptyToAct; ruleBad += r.ruleBad;
    if (!ruleProblem && r.ruleProblem) ruleProblem = r.ruleProblem;
    if (!firstProblem && r.consProblem) firstProblem = r.consProblem;
    if (!r.over) unfinished++;
    else { shared += r.state.result.shared; tiebreaks += r.state.result.tiebreakUsed; }
  }
  check(`${label}: ${games} games terminate`, unfinished === 0, `${unfinished} unfinished`);
  check(`${label}: zero refused bot actions`, refusals === 0, `${refusals}`);
  check(`${label}: legalActionsFromView = getValidActions at every decision`, view === 0, `${view}`);
  check(`${label}: card conservation after every action`, cons === 0, `${cons}: ${firstProblem}`);
  check(`${label}: Sinbad invariants on every action (R4.2, R4.5, R4.7, R4.10, R4.13, R5.5, R8.4)`, ruleBad === 0, `${ruleBad}: ${ruleProblem}`);
  check(`${label}: the player to act always holds a card`, empty === 0, `${empty}`);
  check(`${label}: state JSON round-trips`, rt === 0, `${rt}`);
  console.log(`  ${label}: ${games} games, ${(actions / games).toFixed(0)} decisions/game, shared wins ${shared}, tiebreaks ${tiebreaks}`);
}

const t0 = process.hrtime.bigint();
for (const n of [2, 3, 4, 5]) run(`std ${n}p`, () => n, {});
for (const def of VARIANTS) {
  for (const value of def.values) {
    if (value === def.default) continue;
    run(`${def.name}=${value}`, def.onlyFor ? () => def.onlyFor[0] : (i) => 2 + (i % 4), { [def.name]: value });
  }
}
// Every switch off-default at once (the Playtest panel allows it).
run('all non-default', (i) => 2 + (i % 4), Object.fromEntries(VARIANTS.map((v) => [v.name, v.values.find((x) => x !== v.default)])), 300);

// Determinism: same seed, same game (state and events).
{
  const once = (seed) => { const r = playOut(4, {}, seed, false); return JSON.stringify([r.state, r.events]); };
  check('same seed -> identical game (state and events)', once('det-1') === once('det-1'));
  check('different seed -> different game', once('det-1') !== once('det-2'));
}
console.log(`  smoke time ${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s`);
done();
