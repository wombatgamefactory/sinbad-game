// rules.mjs - one check (or a few) per rule of the numbered rules list, named by its number:
// components, structure, the voyage start and mooring, the trick (ladder, trade, tie, sail), scoring,
// the game end and tiebreak, the rulings, the order of events, the player view, card
// conservation, the five Playtest switches and the constants. Full games, deal rotation, totals and the
// tiebreak are tested here with hand-made states (the Python plays single voyages only, spec D1).
// It is the executable form of the rules. Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import {
  startGame, createGame, applyAction, getValidActions, getPlayBlockReason, getActionBlockReason, trickWinner, gameResult,
  viewFor, legalActionsFromView, shownVoids, unknownCards, determinise, dealRespectingVoids, nextIslands,
  makeRng, rngNext, rngInt, shuffle, deriveSeed, forkRng, hashSeed, rngPick,
  playableCards, fullDeck, sortCards, cardName, listCardNames, isCard, cardFace, cardSerpents, isSerpentCard, allIslandFaces, playMode,
  VARIANTS, DEFAULT_RULES, CONSTANTS, SUITS, CARGOES, resolveVariants, rulesCode, deriveParams, describeEvent, mooringOrderFor,
} from '../src/engine/index.js';
import { suite, position, play, conservation, roundTrip, same, throws, RING6 } from './lib.mjs';

const { check, done } = suite('rules');
const types = (evs) => evs.map((e) => e.type);
const P = (seat, card, mode) => ({ seat, card, mode });
/** This voyage's completed tricks, or the last finished voyage's if the voyage ended inside the call. */
const tricksOf = (g) => (g.tricks.length ? g.tricks : (g.handLog.length ? g.handLog[g.handLog.length - 1].tricks : []));

/** Plays a whole game with a chooser (default: random legal), checking conservation after every action. */
function fullGame(opts, choose = null) {
  const { state, events } = startGame(opts);
  const rng = makeRng(`fg-${opts.seed}`);
  const all = [...events];
  let consOk = true; let steps = 0; let problem = '';
  while (state.toAct !== null && steps < 3000) {
    const acts = getValidActions(state);
    const a = choose ? choose(state, acts, rng) : rngPick(rng, acts);
    all.push(...applyAction(state, a));
    const c = conservation(state);
    if (!c.ok && consOk) { consOk = false; problem = c.problem; }
    if (!['moor', 'play', 'over'].includes(state.phase) && consOk) { consOk = false; problem = `returned in phase ${state.phase}`; }
    steps++;
  }
  return { state, events: all, consOk, problem };
}

// ---------- rng ----------
{
  const a = makeRng(7); const b = makeRng(7); const c = makeRng('7');
  const xs = Array.from({ length: 5 }, () => rngNext(a));
  const ys = Array.from({ length: 5 }, () => rngNext(b));
  check('rng: same seed, same stream', same(xs, ys));
  check('rng: a number seed and a string seed differ', rngNext(makeRng(7)) !== rngNext(c));
  check('rng: floats are in [0, 1)', xs.every((x) => x >= 0 && x < 1));
  check('rng: rngInt stays in range', Array.from({ length: 200 }, () => rngInt(a, 6)).every((x) => x >= 0 && x < 6));
  check('rng: a missing seed is refused', throws(() => makeRng(null)) && throws(() => makeRng(NaN)));
  const deck = shuffle(makeRng(1), fullDeck());
  check('rng: shuffle is a permutation', same([...deck].sort(), [...fullDeck()].sort()) && !same(deck, fullDeck()));
  check('rng: deriveSeed is a plain label', deriveSeed(4, 'bot', 2) === '4:bot:2' && hashSeed('x') === hashSeed('x'));
  const p = makeRng(3); const f = forkRng(p);
  check('rng: a fork is its own stream', f.s !== p.s && Number.isInteger(f.s));
}

// ---------- R1 components ----------
{
  const deck = fullDeck();
  check('R1.1 40 cargo cards, four cargoes x 1-10', deck.length === 40 && new Set(deck).size === 40 && SUITS.length === 4 && CARGOES === SUITS);
  check('R1.8 cargo code order pearls, silk, spice, amber; ids <cargo>-<number>', same(SUITS, ['pearls', 'silk', 'spice', 'amber']) && deck[0] === 'pearls-1' && deck[39] === 'amber-10');
  check('R1.8 hands sort by cargo order then number', same(sortCards(['amber-2', 'pearls-10', 'pearls-2', 'spice-1']), ['pearls-2', 'pearls-10', 'spice-1', 'amber-2']));
  check('R1.2 every 1 carries 1 serpent, every 10 carries 2, 2-9 none', SUITS.every((s) => cardSerpents(`${s}-1`) === 1 && cardSerpents(`${s}-10`) === 2 && [2, 3, 4, 5, 6, 7, 8, 9].every((r) => cardSerpents(`${s}-${r}`) === 0)));
  check('R1.2 12 serpents on 8 serpent cards in the deck', deck.reduce((a, c) => a + cardSerpents(c), 0) === 12 && deck.filter((c) => isSerpentCard(c)).length === 8 && deriveParams(resolveVariants({}), 4).serpentsInDeck === 12);
  check('R1.4 8 island faces, two per cargo, a and b', allIslandFaces().length === 8 && SUITS.every((s) => allIslandFaces().filter((f) => f.startsWith(`island-${s}-`)).length === 2) && allIslandFaces()[0] === 'island-pearls-a');
  check('cards: names read well', cardName('spice-7') === 'Spice 7' && listCardNames(['spice-3', 'pearls-4']) === 'Spice 3 and Pearls 4' && listCardNames(['spice-3', 'pearls-4', 'amber-1']) === 'Spice 3, Pearls 4 and Amber 1');
  check('cards: isCard accepts the deck and refuses the rest', deck.every(isCard) && !isCard('spice-11') && !isCard('red-1') && !isCard(7) && !isCard('spice-0'));
  check('cards: one face asset per card', cardFace('silk-7') === 'card-silk-7');
  check('R1.7 2 to 5 players', CONSTANTS.MIN_PLAYERS === 2 && CONSTANTS.MAX_PLAYERS === 5 && throws(() => createGame({ seed: 1, players: 1 })) && throws(() => createGame({ seed: 1, players: 6 })));
}

// ---------- R13 variants table, rules code ----------
{
  check('R13 exactly the five switches moor, tie, trade, voyages, scoring, in rules code order', same(VARIANTS.map((v) => v.code), ['moor', 'tie', 'trade', 'voyages', 'scoring']));
  check('R13 values, defaults first', same(VARIANTS.map((v) => v.values), [['clockwise', 'score'], ['first', 'real'], ['mandatory', 'optional'], ['players', 'four'], ['tricks', 'serpents']]) && VARIANTS.every((v) => v.default === v.values[0]));
  check('R13 every row has the fields the panel needs and every value is implemented', VARIANTS.every((v) => v.id && v.name && v.code && v.label && v.description && v.values.includes(v.default)
    && v.values.every((x) => v.valueLabels[x] && v.implemented.includes(x))));
  check('R13 resolveVariants fills the defaults', same(resolveVariants({}), DEFAULT_RULES) && same(DEFAULT_RULES, { MOOR: 'clockwise', TIE: 'first', TRADE: 'mandatory', VOYAGES: 'players', SCORING: 'tricks' }));
  check('R13 an unknown rule is refused', throws(() => resolveVariants({ NOPE: '1' }), /Unknown rule/));
  check('R13 a value that is not allowed is refused', throws(() => resolveVariants({ TIE: 'last' }), /must be one of/));
  const table = [{ id: 'V9', name: 'X', code: 'x', values: ['a', 'b'], implemented: ['a'], default: 'a' }];
  check('R13 a declared but unimplemented value is refused', throws(() => resolveVariants({ X: 'b' }, table), /not implemented/));
  check('R13 rules_code: standard is std at every count', [2, 3, 4, 5].every((n) => rulesCode(resolveVariants({}), n) === 'std'));
  check('R13 rules_code: one switch is code-value', rulesCode(resolveVariants({ MOOR: 'score' }), 4) === 'moor-score' && rulesCode(resolveVariants({ VOYAGES: 'four' }), 4) === 'voyages-four');
  check('R13 rules_code: switches joined by + in the fixed order', rulesCode(resolveVariants({ SCORING: 'serpents', MOOR: 'score', TRADE: 'optional', TIE: 'real', VOYAGES: 'four' }), 3) === 'moor-score+tie-real+trade-optional+voyages-four+scoring-serpents'
    && rulesCode(resolveVariants({ TRADE: 'optional', MOOR: 'score' })) === 'moor-score+trade-optional');
  check('R13.7 the state carries the rules code', createGame({ seed: 1, players: 3, rules: { TIE: 'real' } }).rulesCode === 'tie-real' && createGame({ seed: 1, players: 3 }).rulesCode === 'std');
}

// ---------- R2 structure, R3.2 deal table, R14 constants ----------
{
  const want = { 2: [13, 14, 4], 3: [13, 1, 3], 4: [10, 0, 4], 5: [8, 0, 5] };
  for (const n of [2, 3, 4, 5]) {
    const p = deriveParams(resolveVariants({}), n);
    check(`R3.2 / R2.1 ${n}p: ${want[n][0]} cards each, ${want[n][1]} set aside, ${want[n][2]} voyages`, p.handSize === want[n][0] && p.setAside === want[n][1] && p.handsPerGame === want[n][2]);
    const g = createGame({ seed: 10 + n, players: n });
    check(`R3.2 ${n}p: the deal gives ${want[n][0]} different cards to each, ${want[n][1]} set aside`, g.hands.every((h) => h.length === want[n][0]) && new Set(g.hands.flat()).size === n * want[n][0] && g.setAside.length === want[n][1] && conservation(g).ok);
    check(`R13.4 VOYAGES=four ${n}p: four voyages`, deriveParams(resolveVariants({ VOYAGES: 'four' }), n).handsPerGame === 4);
  }
  check('R14 constants', same(CONSTANTS.HAND_SIZE_BY_COUNT, { 2: 13, 3: 13, 4: 10, 5: 8 }) && same(CONSTANTS.VOYAGES_BY_COUNT, { 2: 4, 3: 3, 4: 4, 5: 5 })
    && same(CONSTANTS.SERPENTS_BY_NUMBER, { 1: 1, 10: 2 }) && CONSTANTS.TRICK_POINTS === 1 && CONSTANTS.SERPENT_POINTS === -1 && CONSTANTS.SAIL_STEP === 1 && deriveParams(resolveVariants({}), 4).islands === 8);
  const dealers = new Set(Array.from({ length: 40 }, (_, i) => createGame({ seed: `fd${i}`, players: 4 }).firstDealer));
  check('R2.2 the first dealer is drawn from the seed (repeatable, every seat possible)', dealers.size === 4 && createGame({ seed: 'x', players: 4 }).firstDealer === createGame({ seed: 'x', players: 4 }).firstDealer);
  check('R2.2 an explicit first dealer is used; a bad one is refused', createGame({ seed: 1, players: 3, firstDealer: 2 }).dealer === 2 && throws(() => createGame({ seed: 1, players: 3, firstDealer: 3 })));
}

// ---------- R2.3 - R2.7 full games: rotation, fresh ring and deal, totals, conservation ----------
for (const n of [2, 3, 4, 5]) {
  for (const fd of [0, n - 1]) {
    const { state: g, events, consOk, problem } = fullGame({ seed: `game-${n}-${fd}`, players: n, firstDealer: fd });
    const V = g.params.handsPerGame;
    const log = g.handLog;
    check(`R2.1 ${n}p fd${fd}: the game ends after ${V} voyages`, g.phase === 'over' && g.result !== null && log.length === V && events.filter((e) => e.type === 'voyage-ended').length === V);
    check(`R2.3 ${n}p fd${fd}: the deal passes left; the dealer's left leads the first trick`, log.every((h, v) => h.dealer === (fd + v) % n && h.firstLeader === (fd + v + 1) % n && h.tricks[0].leader === (fd + v + 1) % n));
    if (n === 2) check('R2.4 2p: each player deals twice', [0, 1].every((s) => log.filter((h) => h.dealer === s).length === 2));
    else check(`R2.4 ${n}p: each player deals once`, Array.from({ length: n }, (_, s) => s).every((s) => log.filter((h) => h.dealer === s).length === 1));
    const starts = events.filter((e) => e.type === 'voyage-started');
    check(`R2.5 ${n}p fd${fd}: a fresh ring and deal every voyage (ring-laid each voyage)`, starts.length === V && events.filter((e) => e.type === 'ring-laid').length === V);
    check(`R10 / R8.4 ${n}p fd${fd}: every card in exactly one place after every action; never returned in voyageEnd`, consOk, problem);
    const ty = types(events);
    check(`R8.2 ${n}p fd${fd}: each voyage-ended follows its last trick and that trick's serpents and sails only`, ty.every((t, i) => {
      if (t !== 'voyage-ended') return true;
      const j = ty.lastIndexOf('trick-won', i);
      return ty.slice(j + 1, i).every((x) => x === 'serpent-taken' || x === 'sailed');
    }));
    check(`R5.3 ${n}p fd${fd}: totals are the sums of the voyage scores`, g.totals.every((t, s) => t === log.reduce((a, h) => a + h.scores[s], 0)));
    check(`R5.5 ${n}p fd${fd}: every voyage, tricks sum to the hand size and serpents to those dealt`, log.every((h) => h.tricksWon.reduce((a, b) => a + b, 0) === h.handSize
      && h.serpentsTaken.reduce((a, b) => a + b, 0) === h.tricks.reduce((a, t) => a + t.serpents, 0)));
    check(`R8.4 ${n}p: nobody may act after the end`, getValidActions(g).length === 0 && throws(() => applyAction(g, { type: 'play', card: 'spice-1' })));
  }
}
{
  // R2.6 / R2.5 everything resets at a new voyage; scores carry over.
  const g = createGame({ seed: 'reset', players: 4, firstDealer: 0 });
  const rng = makeRng(5);
  while (g.handNo === 0) applyAction(g, rngPick(rng, getValidActions(g)));
  check('R2.6 a new voyage: ships unmoored, piles and rows empty, counts 0, no trick, phase moor', g.phase === 'moor' && g.ships.every((x) => x === null) && g.serpentRows.every((r) => r.length === 0)
    && g.wonPiles.every((r) => r.length === 0) && g.tricksWon.every((x) => x === 0) && g.serpentsTaken.every((x) => x === 0) && g.trick === null && g.trickNo === 0 && g.tricks.length === 0);
  check('R2.5 scores carry over to the next voyage', same(g.totals, g.handLog[0].scores) && g.hands.every((h) => h.length === 10));
  check('R2.7 a new game starts at 0, no voyage played', createGame({ seed: 2, players: 3 }).totals.every((t) => t === 0) && createGame({ seed: 2, players: 3 }).handLog.length === 0);
}
{
  // R3.1 rings: two islands of each cargo, any order; twins can be adjacent.
  let adj = 0; let ok = true;
  for (let i = 0; i < 200; i++) {
    const g = createGame({ seed: `ring${i}`, players: 3 });
    if (!SUITS.every((s) => g.ring.filter((x) => x === s).length === 2) || g.islandFaces.length !== 8 || new Set(g.islandFaces).size !== 8) ok = false;
    if (g.ring.some((c, k) => g.ring[(k + 1) % 8] === c)) adj++;
  }
  check('R3.1 every ring holds two islands of each cargo and all 8 faces', ok);
  check('R3.1 / R7.9 twin islands may sit together', adj > 0, `${adj}`);
  const g = createGame({ seed: 1, players: 4, deals: [{ hands: [fullDeck().slice(0, 10), fullDeck().slice(10, 20), fullDeck().slice(20, 30), fullDeck().slice(30, 40)], ring: RING6 }] });
  check('fixed deal: hands and ring as given (cargo ids get faces a then b)', same(g.ring, RING6) && g.islandFaces[0] === 'island-spice-a' && g.islandFaces[4] === 'island-spice-b' && same(g.hands[0], fullDeck().slice(0, 10)));
  check('fixed deal: a bad ring is refused', throws(() => createGame({ seed: 1, players: 4, deals: [{ hands: g.handLog.length ? [] : [fullDeck().slice(0, 10), fullDeck().slice(10, 20), fullDeck().slice(20, 30), fullDeck().slice(30, 40)], ring: ['spice', 'spice', 'spice', 'amber', 'silk', 'pearls', 'silk', 'amber'] }] }), /two|2 islands/));
}

// ---------- R3.3 set-aside ----------
{
  // 3p: the one set-aside card is a 10: its 2 serpents play no part (R7.14).
  const all = fullDeck();
  const aside = 'amber-10';
  const rest = all.filter((c) => c !== aside);
  const g = createGame({ seed: 3, players: 3, firstDealer: 2, deals: [{ hands: [rest.slice(0, 13), rest.slice(13, 26), rest.slice(26, 39)], ring: RING6 }] });
  check('R3.3 the set-aside card is held aside', same(g.setAside, [aside]));
  check('R9.7 the view shows only the set-aside count', viewFor(g, 0).setAsideCount === 1 && !JSON.stringify(viewFor(g, 0)).includes(aside) && !('setAside' in viewFor(g, 0)));
  const rng = makeRng(9);
  while (g.handNo === 0) applyAction(g, rngPick(rng, getValidActions(g)));
  check('R3.3 / R7.14 a set-aside serpent card plays no part: 10 serpents taken, not 12', g.handLog[0].serpentsTaken.reduce((a, b) => a + b, 0) === 10 && g.handLog[0].setAside === 1);
}

// ---------- R3.5 - R3.8 mooring ----------
{
  const { state: g, events } = startGame({ seed: 'moor', players: 4, firstDealer: 1 });
  check('R8.3 a voyage starts: voyage-started, then ring-laid, then the mooring phase', same(types(events), ['game-started', 'voyage-started', 'ring-laid']) && g.phase === 'moor');
  check('R3.5 mooring order: clockwise from the dealer\'s left', same(g.mooringOrder, [2, 3, 0, 1]) && g.toAct === 2 && same(events[1].mooringOrder, [2, 3, 0, 1]));
  check('R3.6 / R15.1 a mooring is one of 8 islands; never auto', same(getValidActions(g), Array.from({ length: 8 }, (_, i) => ({ type: 'moor', island: i }))));
  check('R3.6 a card cannot be played while mooring; a bad island is refused', getActionBlockReason(g, { type: 'play', card: g.hands[2][0] }) !== null && getActionBlockReason(g, { type: 'moor', island: 8 }) !== null && getActionBlockReason(g, { type: 'moor', island: 1.5 }) !== null);
  const e1 = applyAction(g, { type: 'moor', island: 5 });
  check('R3.6 a mooring is an event, and nothing is auto-played', e1.length === 1 && e1[0].type === 'ship-moored' && e1[0].seat === 2 && e1[0].island === 5 && e1[0].cargo === g.ring[5] && !e1[0].auto);
  const v3 = viewFor(g, 3);
  check('R3.6 / R9.3 moorings are public as made: the next seat sees the first ship', v3.ships[2] === 5 && v3.ships[3] === null && v3.phase === 'moor' && legalActionsFromView(v3).length === 8);
  const e2 = applyAction(g, { type: 'moor', island: 5 });
  check('R3.5 / R7.10 ships may share an island', g.ships[3] === 5 && same(e2[0].sharedWith, [2]));
  applyAction(g, { type: 'moor', island: 0 });
  const e4 = applyAction(g, { type: 'moor', island: 7 });
  check('R3.7 every ship moored: phase play, the dealer\'s left leads', g.phase === 'play' && g.toAct === 2 && g.leader === 2 && e4.some((e) => e.type === 'ships-moored'));
  check('R3.8 each ship\'s next island is public', same(nextIslands(g), [1, 0, 6, 6]) && same(viewFor(g, 0).nextIslands, [1, 0, 6, 6]));
  check('R3.6 a mooring is refused once play begins', getActionBlockReason(g, { type: 'moor', island: 1 }) !== null);
}

// ---------- R4 the trick: the worked example (R11) ----------
{
  // Ava 0 at island 1 (Spice), Ben 1 at 2 (Silk), Cleo 2 at 3 (Pearls), Dev 3 at 7 (Silk). Ava leads.
  const g = position({ hands: [['spice-4', 'pearls-2', 'pearls-3'], ['spice-7', 'silk-3', 'silk-4'], ['amber-10', 'silk-2', 'amber-4'], ['silk-5', 'silk-8', 'amber-5']], ships: [0, 1, 2, 6], leader: 0 });
  check('R4.1 the leader may lead any card', same(getValidActions(g).map((a) => a.card), ['pearls-2', 'pearls-3', 'spice-4']));
  const e1 = applyAction(g, { type: 'play', card: 'spice-4' });
  const ben = e1.find((e) => e.seat === 1);
  check('R4.3 rung 1: Ben holds Spice and must follow (his only Spice auto-plays)', ben && ben.mode === 'follow' && ben.auto && ben.card === 'spice-7');
  check('R4.2 / R7.5 the leader\'s card is a lead (her island is Spice too): no sail later', e1[0].mode === 'lead' && e1[0].islandCargo === 'spice');
  check('R4.3 rung 3: Cleo (no Spice, no Pearls) may discard anything', same(getValidActions(g).map((a) => a.card), ['silk-2', 'amber-4', 'amber-10']));
  applyAction(g, { type: 'play', card: 'amber-10' });
  check('R4.3 rung 2 / R4.4: Dev (no Spice, Silk island) must trade Silk: only the rank is his', same(getValidActions(g).map((a) => a.card), ['silk-5', 'silk-8']) && /island demands Silk/.test(getPlayBlockReason(g, 3, 'silk-5') || 'island demands Silk'));
  const e3 = applyAction(g, { type: 'play', card: 'silk-5' });
  const trade = e3.find((e) => e.type === 'card-played');
  check('R4.5 / R4.17 the trade is laid sideways and counts as Spice', trade.mode === 'trade' && trade.sideways && trade.countsAs === 'spice' && trade.ledSuit === 'spice');
  check('R8.1 trick events in order: card-played, trick-won, serpent-taken, sailed x2', same(types(e3), ['card-played', 'trick-won', 'serpent-taken', 'sailed', 'sailed']));
  const won = e3.find((e) => e.type === 'trick-won');
  check('R4.7 highest counting as Spice wins: Ben\'s 7 (Dev\'s 5 lower, Cleo\'s discard does not count)', won.winner === 1 && won.card === 'spice-7' && !won.tie);
  check('R4.9 the Amber 10 lies face up in front of Ben; the rest face down', same(g.serpentRows[1], ['amber-10']) && same(sortCards(g.wonPiles[1]), ['silk-5', 'spice-4', 'spice-7']) && g.tricksWon[1] === 1 && g.serpentsTaken[1] === 2);
  const sails = e3.filter((e) => e.type === 'sailed');
  check('R4.10 Cleo and Dev sail one island clockwise (3 -> 4, 7 -> 8), both to Amber; Ava and Ben stay', same(sails.map((s) => [s.seat, s.from, s.to, s.cause, s.toCargo]), [[2, 2, 3, 'discard', 'amber'], [3, 6, 7, 'trade', 'amber']]) && same(g.ships, [0, 1, 3, 7]));
  check('R3.8 routes after: Cleo\'s next stop is Spice (island 5), Dev\'s is Spice (island 1, wrapping)', same(nextIslands(g).slice(2), [4, 0]) && g.ring[4] === 'spice' && g.ring[0] === 'spice');
  check('R4.11 the winner leads the next trick', g.toAct === 1 && g.leader === 1);
  check('R5.2 / R11 Ben: 1 trick, 2 serpents = net -1 for the trick', g.tricksWon[1] * g.params.trickPoints + g.serpentsTaken[1] * g.params.serpentPoints === -1);
}
{
  // R7.2 the forced-10 bomb: Dev's only Silk is the 10.
  const g = position({ hands: [['spice-4', 'pearls-2', 'pearls-3'], ['spice-7', 'silk-3', 'silk-4'], ['amber-10', 'silk-2', 'amber-4'], ['silk-10', 'pearls-5', 'pearls-6']], ships: [0, 1, 2, 6], leader: 0 });
  play(g, 'spice-4', 'amber-10');
  const ev = g.tricks[0];
  const dev = ev.plays[3];
  check('R7.2 / R4.4 the trade is mandatory even when it must win: the Silk 10 auto-plays as a trade', dev.card === 'silk-10' && dev.mode === 'trade');
  check('R7.2 it counts as Spice and wins (10 > 7), taking Cleo\'s two serpents and its own two', ev.winner === 3 && ev.serpents === 4 && same(g.serpentRows[3], ['amber-10', 'silk-10']) && g.serpentsTaken[3] === 4);
  check('R7.7 Dev traded and won: he sails too and leads from his new island', g.ships[3] === 7 && g.toAct === 3);
  check('R5.6 a strict forced 10 is counted', g.voyageStats.forcedTens[3] === 1 && g.measures.forcedTens === 1 && g.measures.tradeTens === 1);
}
{
  // R7.4 you can never discard your island's cargo while void in the led cargo.
  const g = position({ players: 3, hands: [['spice-4', 'pearls-1'], ['silk-10', 'amber-3'], ['spice-2', 'pearls-2']], ships: [0, 1, 0], leader: 0 });
  applyAction(g, { type: 'play', card: 'spice-4' });
  const tr = tricksOf(g)[0];
  check('R7.4 the Silk 10 was a trade (auto, the only legal card) and won the trick', tr.plays[1].card === 'silk-10' && tr.plays[1].mode === 'trade' && tr.winner === 1);
  const h = position({ players: 3, hands: [['spice-4', 'pearls-1'], ['silk-10', 'silk-3'], ['spice-2', 'pearls-2']], ships: [0, 1, 0], leader: 0 });
  applyAction(h, { type: 'play', card: 'spice-4' });
  check('R4.16 a trade with several ranks is a real decision (not auto)', h.toAct === 1 && same(getValidActions(h).map((a) => a.card), ['silk-3', 'silk-10']));
  const b = position({ players: 3, hands: [['spice-4', 'pearls-1', 'pearls-5'], ['silk-10', 'silk-3', 'amber-3'], ['spice-2', 'pearls-2', 'pearls-6']], ships: [0, 1, 0], leader: 0 });
  applyAction(b, { type: 'play', card: 'spice-4' });
  check('R7.4 / R9.12 void in Spice on a Silk island: Amber 3 is refused and the reason names the island', getActionBlockReason(b, { type: 'play', card: 'amber-3' }) !== null && /island demands Silk/.test(getPlayBlockReason(b, 1, 'amber-3')));
  const f = position({ players: 3, hands: [['spice-4', 'pearls-1', 'pearls-5'], ['silk-10', 'pearls-3', 'pearls-4'], ['spice-2', 'pearls-2', 'pearls-6']], ships: [0, 1, 0], leader: 0 });
  applyAction(f, { type: 'play', card: 'pearls-1' });
  check('R9.12 a refused off-cargo card names the cargo to follow', /^Follow Pearls/.test(getPlayBlockReason(f, 1, 'silk-10') || ''));
}
{
  // R4.14 / R7.1 the island's cargo is the led cargo: holding none, discard anything, then sail.
  const g = position({ players: 3, hands: [['spice-4', 'pearls-1'], ['amber-9', 'pearls-3'], ['spice-2', 'pearls-2']], ships: [0, 0, 1], leader: 0 });
  applyAction(g, { type: 'play', card: 'spice-4' });
  check('R4.14 on a Spice island with no Spice when Spice is led: the whole hand is legal', same(getValidActions(g).map((a) => a.card), ['pearls-3', 'amber-9']));
  const ev = play(g, 'amber-9');
  const d = ev.find((e) => e.type === 'card-played' && e.seat === 1);
  check('R4.6 / R4.7 a discard never wins, even with a higher number (no trump)', d.mode === 'discard' && tricksOf(g)[0].winner === 0 && tricksOf(g)[0].winningCard === 'spice-4');
  check('R4.10 / R7.1 the discard sails', ev.some((e) => e.type === 'sailed' && e.seat === 1 && e.from === 0 && e.to === 1));
  check('R4.13 a discard is never of the led cargo nor of the island cargo', d.card.split('-')[0] !== 'spice' && d.card.split('-')[0] !== d.islandCargo);
}
{
  // R7.11 no card of your cargo: no trade, discards still sail. R7.17 followers never sail.
  const g = position({ players: 2, hands: [['amber-2', 'amber-3'], ['pearls-9', 'amber-1']], ships: [3, 7], leader: 0 });
  const ev = play(g, 'amber-2');
  check('R7.17 a follower stays parked (Amber island, Amber led)', !ev.some((e) => e.type === 'sailed' && e.trickNo === 1) && tricksOf(g)[0].sails.length === 0);
  check('R4.10 a sail from island 8 wraps to island 1', (() => {
    const h = position({ players: 2, hands: [['spice-2', 'spice-3'], ['pearls-9', 'silk-1']], ships: [0, 7], leader: 0 });
    const e = play(h, 'spice-2', 'pearls-9');
    return e.some((x) => x.type === 'sailed' && x.seat === 1 && x.from === 7 && x.to === 0);
  })());
}
{
  // R4.8 / R4.12 / R7.6 ties: a trade equal to a real card, played first, wins; two trades tie.
  const g = position({ players: 3, hands: [['spice-4', 'amber-1', 'amber-5'], ['pearls-7', 'amber-2', 'amber-6'], ['spice-7', 'amber-3', 'amber-7']], ships: [0, 2, 0], leader: 0 });
  const ev = play(g, 'spice-4', 'pearls-7', 'spice-7');
  const won = ev.find((e) => e.type === 'trick-won');
  check('R4.8 / R4.12 a trade 7 played before the real Spice 7 ties it and, first played, wins', won.winner === 1 && won.tie && won.tieBrokenBy === 'first' && won.mode === 'trade');
  check('R7.7 the trade winner sails and leads from the new island', g.ships[1] === 3 && g.toAct === 1);
  check('R5.6 the tie is counted', g.voyageStats.ties === 1 && g.measures.ties === 1);
  const t = position({ players: 4, hands: [['amber-3', 'spice-1'], ['pearls-8', 'spice-2'], ['silk-8', 'spice-3'], ['amber-2', 'spice-4']], ships: [0, 2, 1, 3], leader: 0 });
  const ev2 = play(t, 'amber-3', 'pearls-8', 'silk-8', 'amber-2');
  const w2 = ev2.find((e) => e.type === 'trick-won');
  check('R4.12 two trades of different cargoes tie: the first played wins', w2.winner === 1 && w2.tie && w2.card === 'pearls-8');
  check('trickWinner: discards never count, highest counting wins', trickWinner([P(0, 'spice-4', 'lead'), P(1, 'amber-10', 'discard'), P(2, 'silk-6', 'trade')]).seat === 2 && trickWinner([]) === null);
  check('trickWinner: the lead always counts, so a trick always has a winner', trickWinner([P(0, 'spice-1', 'lead'), P(1, 'amber-10', 'discard')]).seat === 0);
}
{
  // R7.9 twin islands: sailing from one to the other keeps the cargo and forces a second trade.
  const ring = ['spice', 'silk', 'silk', 'pearls', 'amber', 'spice', 'pearls', 'amber'];
  const g = position({ players: 2, hands: [['spice-4', 'spice-5', 'pearls-1'], ['silk-3', 'silk-9', 'amber-4']], ring, ships: [0, 1], leader: 0 });
  play(g, 'spice-4', 'silk-3');
  check('R7.9 a trade on the first Silk island sails onto its twin: still Silk', g.ships[1] === 2 && g.ring[2] === 'silk');
  check('R7.9 the next void forces a second Silk trade', g.toAct === 0 && (() => { applyAction(g, { type: 'play', card: 'spice-5' }); const t2 = tricksOf(g)[1]; return t2.plays[1].card === 'silk-9' && t2.plays[1].mode === 'trade'; })());
}
{
  // R7.10 two ships on one island: each player's trade works independently.
  const g = position({ players: 3, hands: [['spice-4', 'amber-1'], ['pearls-3', 'amber-2'], ['pearls-9', 'amber-3']], ships: [0, 2, 2], leader: 0 });
  const ev = play(g, 'spice-4', 'pearls-3', 'pearls-9');
  check('R7.10 both ships on the Pearls island trade and both sail', same(ev.filter((e) => e.type === 'sailed' && e.trickNo === 1).map((e) => [e.seat, e.from, e.to]), [[1, 2, 3], [2, 2, 3]]) && tricksOf(g)[0].winner === 2);
}
{
  // R4.16 auto-play and manual seats.
  const g = position({ players: 3, hands: [['spice-9', 'spice-8'], ['spice-2', 'amber-1'], ['amber-3', 'amber-4']], ships: [0, 0, 3], leader: 0 });
  const ev = play(g, 'spice-9');
  const autos = ev.filter((e) => e.type === 'card-played' && e.auto);
  check('R4.16 a single legal card is played at once and marked auto', autos.length === 1 && autos[0].seat === 1 && g.toAct === 2);
  const m = position({ players: 3, hands: [['spice-9', 'spice-8'], ['spice-2', 'amber-1'], ['amber-3', 'amber-4']], ships: [0, 0, 3], leader: 0 });
  m.manualSeats = [1];
  const ev2 = play(m, 'spice-9');
  check('R4.16 a manual (learner) seat is left to click even a forced card', ev2.filter((e) => e.auto).length === 0 && m.toAct === 1);
  check('auto: manualSeats must be real seats', throws(() => startGame({ seed: 1, players: 3, manualSeats: [7] })));
  const last = position({ players: 2, hands: [['spice-9'], ['amber-1']], ships: [0, 0], leader: 0 });
  const ev3 = play(last, 'spice-9');
  check('R4.16 the last card of a voyage auto-plays (and the voyage ends in the same call)', ev3.some((e) => e.type === 'card-played' && e.auto && e.seat === 1) && ev3.some((e) => e.type === 'voyage-ended'));
}

// ---------- R5 scoring, R8.2 voyage end ----------
{
  // A hand-built two-card voyage: seat 0 wins a clean trick, seat 1 wins one with 3 serpents.
  const g = position({ players: 2, hands: [['spice-5', 'pearls-1'], ['spice-3', 'pearls-10']], ships: [0, 0], leader: 0 });
  const ev = play(g, 'spice-5', 'pearls-1');
  check('R5.1 the voyage ends when the hands are empty', g.handLog.length === 1 && g.handLog[0].endReason === 'hands-empty' && g.handLog[0].tricksPlayed === 2);
  check('R5.2 +1 a trick, -1 a serpent, whoever played them: 1 - 0 = 1 and 1 - 3 = -2', same(g.handLog[0].scores, [1, -2]) && same(g.handLog[0].serpentsTaken, [0, 3]));
  check('R5.3 voyage scores and totals may be negative', g.totals[1] === -2);
  const ve = ev.find((e) => e.type === 'voyage-ended');
  check('R5.7 the voyage-ended event carries the arithmetic: +tricks, -serpents, = score, total', same(ve.lines[1], { tricks: 1, serpents: 3, trickScore: 1, serpentScore: -3, score: -2, total: -2 }) && ve.trickPoints === 1 && ve.serpentPoints === -1);
  const i = types(ev).indexOf('voyage-ended');
  check('R8.2 order at the end: the last trick, then voyage-ended, then the next voyage-started and ring-laid', types(ev).slice(i, i + 3).join() === 'voyage-ended,voyage-started,ring-laid' && types(ev).lastIndexOf('trick-won') < i);
  const r = g.handLog[0];
  check('R5.6 the voyage record carries every field', ['tricksWon', 'serpentsTaken', 'scores', 'trades', 'tradesWon', 'forcedTens', 'sails', 'startIsland', 'endIsland', 'dealer', 'firstLeader', 'mooringOrder', 'setAside', 'ties', 'endReason'].every((k) => k in r));
  check('R8.4 a returned state is never in voyageEnd: the next voyage is mooring', g.phase === 'moor' && g.handNo === 1);
}
{
  // R5.4 a trick holding only serpent cards still counts as a trick; R10.4 tricksWon x n = cards won.
  const g = position({ players: 2, hands: [['spice-10', 'pearls-2', 'pearls-4'], ['spice-1', 'pearls-3', 'pearls-5']], ships: [0, 0], leader: 0 });
  play(g, 'spice-10');
  check('R5.4 a trick of serpent cards only counts (2 cards face up, 0 face down, 1 trick)', g.tricksWon[0] === 1 && g.serpentRows[0].length === 2 && g.wonPiles[0].length === 0 && g.serpentsTaken[0] === 3);
}
{
  // R5.5 sums over a full 4p voyage: tricks 10, serpents 12, scores -2.
  let ok = true;
  for (let i = 0; i < 40; i++) {
    const g = createGame({ seed: `sum${i}`, players: 4 });
    const rng = makeRng(i);
    while (g.handNo === 0) applyAction(g, rngPick(rng, getValidActions(g)));
    const h = g.handLog[0];
    if (h.tricksWon.reduce((a, b) => a + b, 0) !== 10 || h.serpentsTaken.reduce((a, b) => a + b, 0) !== 12 || h.scores.reduce((a, b) => a + b, 0) !== -2) ok = false;
  }
  check('R5.5 at 4 players every voyage: tricks sum to 10, serpents to 12, scores to -2', ok);
}

// ---------- R6 game result and tiebreak ----------
{
  const mk = (totals, last) => ({ n: totals.length, totals, handLog: [{ scores: last }], measures: { tricks: 9 } });
  const r1 = gameResult(mk([10, 7, 4], [3, 2, 1]));
  check('R6.1 the top total wins, margin to the next', same(r1.winners, [0]) && !r1.shared && !r1.tiebreakUsed && r1.margin === 3 && r1.winningScore === 10);
  const r2 = gameResult(mk([10, 10, 4], [2, 5, 1]));
  check('R6.2 a tied total goes to the most points in the final voyage', same(r2.winners, [1]) && r2.tiebreakUsed && same(r2.tiedOnTotal, [0, 1]) && r2.margin === 0);
  const r3 = gameResult(mk([10, 10, 4], [4, 4, 1]));
  check('R6.2 still level is a shared win', same(r3.winners, [0, 1]) && r3.shared && !r3.tiebreakUsed);
  const r4 = gameResult(mk([3, 3, 3, 9], [2, 2, 0, 5]));
  check('R6.3 three tie but one leads: only the top total is compared', same(r4.winners, [3]) && !r4.tiebreakUsed);
  const r5 = gameResult(mk([4, 4, 4, 1], [2, 2, 0, 7]));
  check('R6.3 three tie on the top total; two score 2 in the final voyage and share the win', same(r5.winners, [0, 1]) && r5.shared && r5.tiebreakUsed && same(r5.tiedOnTotal, [0, 1, 2]));
  const r6 = gameResult(mk([-3, 2, 2, -9], [1, 0, 2, -4]));
  check('R6.5 the rule book example: Ben and Cleo tie on 2, Cleo scored 2 in the final voyage to Ben\'s 0: Cleo wins', same(r6.winners, [2]) && r6.tiebreakUsed);
  check('R6.4 ranking by total then final voyage; equal on both = equal rank', same(r5.ranking.map((r) => r.seat), [0, 1, 2, 3]) && same(r5.ranking.map((r) => r.rank), [1, 1, 3, 4]));
  const r7 = gameResult(mk([-5, -2, -2], [-1, -3, -1]));
  check('R5.3 / R6.2 negative totals: highest (closest to zero) wins, tiebreak on the final voyage', same(r7.winners, [2]) && r7.tiebreakUsed);
  // A real game whose final voyage decides a tie.
  let found = false;
  for (let i = 0; i < 400 && !found; i++) {
    const { state } = fullGame({ seed: `tb${i}`, players: 3 });
    if (state.result.tiebreakUsed) {
      const last = state.handLog[state.handLog.length - 1].scores;
      found = state.result.winners.every((s) => last[s] === Math.max(...state.result.tiedOnTotal.map((x) => last[x])));
    }
  }
  check('R6.2 in a played game the final voyage separates a tie on the top total', found);
}

// ---------- R9 the player view ----------
{
  const { state: g } = startGame({ seed: 'view', players: 2, firstDealer: 1 });
  const v0 = viewFor(g, 0);
  check('R9.1 / R9.2 own hand only, counts for everyone; no other hand, no rng, no set-aside', same(v0.hand, g.hands[0]) && same(v0.handCounts, [13, 13]) && !('hands' in v0) && !('rng' in v0) && !('setAside' in v0) && !('deals' in v0));
  check('R9.7 at 2 players only the set-aside COUNT (14) is shown', v0.setAsideCount === 14 && g.setAside.every((c) => !JSON.stringify(v0).includes(`"${c}"`)));
  check('R9.3 the ring is public from the start', same(v0.ring, g.ring) && v0.islandFaces.length === 8);
  check('view: plain JSON, a fresh copy', same(roundTrip(v0), v0) && (() => { v0.hand.pop(); v0.totals[0] = 99; return g.hands[0].length === 13 && g.totals[0] !== 99; })());
  check('view: a bad seat is refused', throws(() => viewFor(g, 9)));
  const rng = makeRng(4);
  while (g.phase !== 'over') applyAction(g, rngPick(rng, getValidActions(g)));
  const vEnd = viewFor(g, 1);
  check('R9.7 the set-aside is never revealed, not after the game either', !('setAside' in vEnd) && vEnd.setAsideCount === 14 && vEnd.handLog.every((h) => h.setAside === 14 && !('setAsideCards' in h))
    && g.setAside.every((c) => !JSON.stringify(vEnd.handLog[vEnd.handLog.length - 1].tricks).includes(`"${c}"`)));
}
{
  const g = position({ hands: [['spice-4', 'pearls-2', 'pearls-3'], ['spice-7', 'silk-3', 'silk-4'], ['amber-10', 'silk-2', 'amber-4'], ['silk-5', 'silk-8', 'amber-5']], ships: [0, 1, 2, 6], leader: 0 });
  play(g, 'spice-4', 'amber-10');
  const v = viewFor(g, 3);
  check('R9.4 the current trick: plays in order, the led cargo', v.trick.ledSuit === 'spice' && same(v.trick.plays.map((p) => p.card), ['spice-4', 'spice-7', 'amber-10']));
  check('legal actions from the view equal getValidActions for the actor, empty for others', same(legalActionsFromView(v), getValidActions(g)) && legalActionsFromView(viewFor(g, 0)).length === 0);
  play(g, 'silk-5');
  const v2 = viewFor(g, 0);
  check('R9.4 a trade is flagged sideways with the cargo it counts as', v2.tricks[0].plays[3].sideways && v2.tricks[0].plays[3].countsAs === 'spice');
  check('R9.5 face-up serpent rows are public with counts', same(v2.serpentRows[1], ['amber-10']) && v2.serpentsTaken[1] === 2);
  check('R9.6 trick counts public; face-down piles as counts only', same(v2.tricksWon, [0, 1, 0, 0]) && same(v2.wonPileCounts, [0, 3, 0, 0]) && !('wonPiles' in v2));
  check('R9.8 the trick log is public (completed tricks this voyage)', v2.tricks.length === 1 && v2.tricks[0].winner === 1);
  const voids = shownVoids(v2);
  check('R9.9 a trade shows a void in the led cargo; a discard also shows no card of the island cargo', same(voids[3], ['spice']) && same(voids[2], ['pearls', 'spice']) && voids[0].length === 0 && voids[1].length === 0);
  check('unknown: the viewer cannot place other hands or the set-aside', unknownCards(v2).length === 40 - (2 + 4) && !unknownCards(v2).includes('amber-10'));
}

// ---------- determinised worlds ----------
{
  for (const n of [2, 3, 5]) {
    const g = createGame({ seed: 21 + n, players: n });
    const rng = makeRng(`det${n}`);
    const prng = makeRng(`p${n}`);
    let ok = true; let voidOk = true; let steps = 0; let why = '';
    while (g.toAct !== null && g.handNo < 2 && steps < 400) {
      const seat = g.toAct;
      const v = viewFor(g, seat);
      const w = determinise(v, rng);
      const c = conservation(w);
      if (!c.ok) { ok = false; why = why || c.problem; }
      if (!same(w.hands[seat], g.hands[seat]) || !w.hands.every((h, s) => h.length === g.hands[s].length) || w.setAside.length !== g.setAside.length) { ok = false; why = why || 'sizes'; }
      if (!same(w.serpentRows, g.serpentRows) || !same(w.ships, g.ships) || !same(w.ring, g.ring) || !same(getValidActions(w), getValidActions(g))) { ok = false; why = why || 'public state'; }
      const sv = shownVoids(v);
      for (let s = 0; s < n; s++) if (s !== seat && w.hands[s].some((card) => sv[s].includes(card.slice(0, card.indexOf('-'))))) voidOk = false;
      if (!same(roundTrip(w), w)) ok = false;
      const copy = roundTrip(w);
      let guard = 0;
      while (copy.toAct !== null && guard++ < 600) applyAction(copy, getValidActions(copy)[0], { silent: true });
      if (copy.phase !== 'over') { ok = false; why = why || 'did not play out'; }
      applyAction(g, rngPick(prng, getValidActions(g)), { silent: true });
      steps++;
    }
    check(`determinise ${n}p: every world holds all 40 cards once, keeps the viewer's hand, the public state and the counts, and plays out`, ok, `${steps} worlds ${why}`);
    check(`determinise ${n}p: no hand holds a cargo its owner has shown it lacks (led or island)`, voidOk);
  }
  const pool = ['spice-1', 'spice-2', 'amber-1', 'amber-2', 'pearls-1', 'pearls-2'];
  const dealt = dealRespectingVoids(pool, [0, 2, 2], [new Set(), new Set(['spice']), new Set(['amber'])], makeRng(1), [1, 2]);
  check('dealRespectingVoids: honours voids and returns the rest as leftover', dealt.hands[1].every((c) => !c.startsWith('spice')) && dealt.hands[2].every((c) => !c.startsWith('amber')) && dealt.leftover.length === 2);
}

// ---------- R13.1 MOOR=score ----------
{
  const g = createGame({ seed: 'ms', players: 4, firstDealer: 0, rules: { MOOR: 'score' } });
  check('R13.1 voyage 1 (all on 0): the order equals clockwise from the dealer\'s left', same(g.mooringOrder, [1, 2, 3, 0]));
  g.totals = [5, -2, 5, 1];
  g.dealer = 0;
  check('R13.1 highest total first, last place last; equal totals clockwise from the dealer\'s left', same(mooringOrderFor(g), [2, 0, 3, 1]));
  const h = createGame({ seed: 'ms2', players: 3, firstDealer: 2, rules: { MOOR: 'score' } });
  const rng = makeRng(2);
  while (h.handNo === 0) applyAction(h, rngPick(rng, getValidActions(h)));
  const want = [1, 2, 0].map((s, k) => ({ s, k })).sort((a, b) => h.totals[b.s] - h.totals[a.s] || a.k - b.k).map((x) => x.s);
  check('R13.1 in a played game voyage 2 moors in score order', h.dealer === 0 && same(h.mooringOrder, want) && h.toAct === want[0]);
  for (const s of want) applyAction(h, { type: 'moor', island: s });
  check('R13.1 / R3.7 the dealer\'s left still leads', h.phase === 'play' && h.toAct === 1);
  check('R13.1 standard order ignores the totals', (() => { const s = createGame({ seed: 'ms3', players: 4, firstDealer: 0 }); s.totals = [9, -9, 0, 3]; return same(mooringOrderFor(s), [1, 2, 3, 0]); })());
}

// ---------- R13.2 TIE=real ----------
{
  const g = position({ players: 3, hands: [['spice-4', 'amber-1'], ['pearls-7', 'amber-2'], ['spice-7', 'amber-3']], ships: [0, 2, 0], leader: 0, rules: { TIE: 'real' } });
  const ev = play(g, 'spice-4', 'pearls-7', 'spice-7');
  const won = ev.find((e) => e.type === 'trick-won');
  check('R13.2 a real card beats an earlier trade of the same number', won.winner === 2 && won.tie && won.tieBrokenBy === 'real' && won.mode === 'follow');
  const t = position({ players: 4, hands: [['amber-3', 'spice-1'], ['pearls-8', 'spice-2'], ['silk-8', 'spice-3'], ['amber-2', 'spice-4']], ships: [0, 2, 1, 3], leader: 0, rules: { TIE: 'real' } });
  const ev2 = play(t, 'amber-3', 'pearls-8', 'silk-8', 'amber-2');
  check('R13.2 two tied trades: still the first played', ev2.find((e) => e.type === 'trick-won').winner === 1);
  check('R13.2 trickWinner: a real card after a trade wins the tie; a trade after a real card does not', trickWinner([P(0, 'spice-4', 'lead'), P(1, 'pearls-7', 'trade'), P(2, 'spice-7', 'follow')], 'real').seat === 2
    && trickWinner([P(0, 'spice-7', 'lead'), P(1, 'pearls-7', 'trade')], 'real').seat === 0 && trickWinner([P(0, 'spice-4', 'lead'), P(1, 'pearls-7', 'trade'), P(2, 'spice-7', 'follow')], 'first').seat === 1);
}

// ---------- R13.3 TRADE=optional ----------
{
  const mk = () => position({ players: 3, hands: [['spice-4', 'pearls-1'], ['silk-10', 'amber-3'], ['spice-2', 'pearls-2']], ships: [0, 1, 0], leader: 0, rules: { TRADE: 'optional' } });
  const g = mk();
  applyAction(g, { type: 'play', card: 'spice-4' });
  check('R13.3 void in the led cargo holding the island cargo: the whole hand is legal (no forced 10)', g.toAct === 1 && same(getValidActions(g).map((a) => a.card), ['silk-10', 'amber-3']));
  const ev = play(g, 'amber-3');
  check('R13.3 another card is a discard (cannot win) and sails', ev.find((e) => e.type === 'card-played' && e.seat === 1).mode === 'discard' && ev.some((e) => e.type === 'sailed' && e.seat === 1 && e.trickNo === 1) && tricksOf(g)[0].winner === 0);
  const h = mk();
  play(h, 'spice-4', 'silk-10');
  check('R13.3 a card of the island cargo is still a trade: sideways, counts as led, can win', tricksOf(h)[0].plays[1].mode === 'trade' && tricksOf(h)[0].plays[1].sideways && tricksOf(h)[0].winner === 1);
  // R9.9 + R13.3: with the trade optional, a discard does NOT show that the player held no island cargo (it chose to discard).
  const go = position({ players: 3, hands: [['spice-4', 'pearls-1', 'pearls-3'], ['silk-10', 'amber-3', 'amber-4'], ['spice-2', 'pearls-2', 'pearls-4']], ships: [0, 1, 0], leader: 0, rules: { TRADE: 'optional' } });
  play(go, 'spice-4', 'amber-3');
  check('R9.9 / R13.3 trade=optional: a discard shows only the led-cargo void (seat 1 still holds silk 10, its island cargo)', go.hands[1].includes('silk-10') && same(shownVoids(viewFor(go, 0))[1], ['spice']));
  const gm = position({ players: 3, hands: [['spice-4', 'pearls-1', 'pearls-3'], ['amber-3', 'amber-4', 'amber-7'], ['spice-2', 'pearls-2', 'pearls-4']], ships: [0, 1, 0], leader: 0 });
  play(gm, 'spice-4', 'amber-3');
  check('R9.9 trade=mandatory: the same discard (no silk in hand) shows the island-cargo void too', same(shownVoids(viewFor(gm, 0))[1], ['silk', 'spice']));
  check('R13.3 following is still compulsory', same(playableCards(['spice-2', 'pearls-2'], 'pearls', 'spice', { TRADE: 'optional' }), ['pearls-2']) && same(playableCards(['spice-2', 'silk-4'], 'pearls', 'spice', { TRADE: 'mandatory' }), ['spice-2']));
  check('playMode: an island-cargo card while void is a trade; another card a discard; the led cargo a follow',
    playMode(['silk-10', 'amber-3'], 'silk-10', 'spice', 'silk') === 'trade' && playMode(['silk-10', 'amber-3'], 'amber-3', 'spice', 'silk') === 'discard'
    && playMode(['spice-2', 'silk-3'], 'spice-2', 'spice', 'silk') === 'follow' && playMode(['spice-2'], 'spice-2', null, 'silk') === 'lead');
}

// ---------- R13.4 VOYAGES=four ----------
{
  const g3 = fullGame({ seed: 'v4-3', players: 3, firstDealer: 1, rules: { VOYAGES: 'four' } }).state;
  check('R13.4 3 players play 4 voyages; the first dealer deals twice', g3.handLog.length === 4 && same(g3.handLog.map((h) => h.dealer), [1, 2, 0, 1]));
  const g5 = fullGame({ seed: 'v4-5', players: 5, firstDealer: 2, rules: { VOYAGES: 'four' } }).state;
  check('R13.4 5 players play 4 voyages; the player on the first dealer\'s right never deals', g5.handLog.length === 4 && same(g5.handLog.map((h) => h.dealer), [2, 3, 4, 0]) && !g5.handLog.some((h) => h.dealer === 1));
  check('R13.4 the tiebreak is still the final voyage', same(g5.result.lastHand, g5.handLog[3].scores));
}

// ---------- R13.5 SCORING=serpents ----------
{
  const g = position({ players: 2, hands: [['spice-5', 'pearls-1'], ['spice-3', 'pearls-10']], ships: [0, 0], leader: 0, rules: { SCORING: 'serpents' } });
  const ev = play(g, 'spice-5', 'pearls-1');
  check('R13.5 a voyage scores -1 per serpent and nothing for tricks', same(g.handLog[0].scores, [0, -3]) && g.handLog[0].trickPoints === 0 && same(g.handLog[0].tricksWon, [1, 1]));
  check('R13.5 the reckoning still shows the tricks, scored 0', same(ev.find((e) => e.type === 'voyage-ended').lines[0], { tricks: 1, serpents: 0, trickScore: 0, serpentScore: 0, score: 0, total: 0 }));
  const { state } = fullGame({ seed: 'ss', players: 4, rules: { SCORING: 'serpents' } });
  check('R13.5 totals are never positive; every voyage sums to -12 at 4 players', state.totals.every((t) => t <= 0) && state.handLog.every((h) => h.scores.reduce((a, b) => a + b, 0) === -12));
}

// ---------- R13.6 constants for the simulator ----------
{
  const saved = { ...CONSTANTS.SERPENTS_BY_NUMBER };
  CONSTANTS.SERPENTS_BY_NUMBER = { 5: 3 };
  const g = createGame({ seed: 1, players: 4 });
  CONSTANTS.SERPENTS_BY_NUMBER = saved;
  check('R13.6 serpent values come from CONSTANTS at createGame (simulator --const); a running game keeps its own', g.params.serpentsInDeck === 12 && same(g.params.serpentsByNumber, { 5: 3 }) && cardSerpents('spice-5', g.params) === 3 && cardSerpents('spice-10', g.params) === 0
    && same(createGame({ seed: 1, players: 4 }).params.serpentsByNumber, { 1: 1, 10: 2 }));
}

// ---------- events and describe ----------
{
  const { state: g, events } = startGame({ seed: 'desc', players: 3, firstDealer: 0 });
  const names = ['You', 'Sam', 'Ann'];
  const rng = makeRng(1);
  const all = [...events];
  while (g.phase !== 'over') all.push(...applyAction(g, rngPick(rng, getValidActions(g))));
  const lines = all.map((e) => describeEvent(e, names)).filter(Boolean);
  check('describe: every event type has a line (ships-moored excepted)', new Set(all.filter((e) => describeEvent(e, names)).map((e) => e.type)).size >= 10);
  check('describe: lines read as English, second person for You', lines.some((l) => /^You (lead|follow|trade|discard|win|moor|sail)/.test(l)) && lines.some((l) => /^Sam (leads|follows|trades|discards|wins|moors|sails)/.test(l)));
  check('describe: no line has undefined, NaN or [object]', lines.every((l) => !/undefined|NaN|\[object/.test(l)));
  check('R4.17 every play event carries its mode; trades carry countsAs and sideways', all.filter((e) => e.type === 'card-played').every((e) => ['lead', 'follow', 'trade', 'discard'].includes(e.mode) && (e.mode !== 'trade' || (e.sideways && e.countsAs === e.ledSuit))));
  check('R4.17 every sail carries seat, from, to and cause trade | discard', all.filter((e) => e.type === 'sailed').every((e) => e.to === (e.from + 1) % 8 && ['trade', 'discard'].includes(e.cause)));
  const go = all[all.length - 1];
  check('game-over carries the ranking, the tiebreak flag and the shared flag', go.type === 'game-over' && Array.isArray(go.ranking) && typeof go.tiebreakUsed === 'boolean' && typeof go.shared === 'boolean');
}

done();
