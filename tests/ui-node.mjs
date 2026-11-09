// ui-node.mjs - Node-level checks of the UI's pure parts: the table model and its frames (the
// event reducer must land exactly on the live state after every action, in every variant), the
// sentences, the clone-and-apply hints, the landing/setup builders (Playtest rules generated from
// VARIANTS), the art ids against the manifest, and the pass-and-play hand-hiding rules.
// Sinbad: the mooring decision, trades and discards in the sentences and hints, sails and serpent rows
// in the board model. the table UI work extends the screen checks with the real table.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure. Run: node tests/ui-node.mjs

import fs from 'node:fs';
import { suite, position, play, RING6 } from './lib.mjs';
import { createController } from '../src/ui/controller.js';
import { boardFromState, reduceBoard, buildFrames, sameBoard } from '../src/ui/board.js';
import { trickSentence, tiebreakText, turnPrompt, previewText, winnerBanner, tiedGroups, waitingText, handEndText, playSituation, situationText, signed } from '../src/ui/text.js';
import { previewCard } from '../src/ui/preview.js';
import { makeVm } from '../src/ui/viewmodel.js';
import { tableHtml, seatsHtml, handBoxHtml, sideHtml, coverHtml, handSummaryHtml, gameEndHtml, statusHtml, endBarHtml, decisionHtml, ringHtml, trickHtml, seatHtml } from '../src/ui/components.js';
import { landingHtml, howToPlayHtml, rulesPanelHtml, seatTypeOptions, uniqueNames, DEFAULT_SETUP, RULEBOOK_URL, safeCode, PLAYER_COUNTS, humanCount, variantText } from '../src/ui/landing.js';
import { SHIP_IDS, shipImg, useManifest, assetUrl, builtInIds, img, cardImg, cardBackImg, badgeImg, esc } from '../src/ui/assets.js';
import { GAME_NAME, GAME_SLUG, PUBLISH_URL } from '../src/game-config.js';
import { botLevels } from '../src/bots/index.js';
import {
  SUIT_NAMES, startGame, applyAction, getValidActions, describeEvent, makeRng, rngPick, VARIANTS, fullDeck, cardFace, viewFor, cloneState,
} from '../src/engine/index.js';

const { check, done } = suite('ui-node');
const BAD = /undefined|NaN|\[object/;

// ---------- config and the page ----------
{
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  check('config: name, slug and address are set', GAME_NAME.length > 0 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(GAME_SLUG) && /^https:\/\/.+\/$/.test(PUBLISH_URL));
  const tokens = [...new Set(html.match(/\{\{[A-Z_]+\}\}/g) || [])];
  console.log(`  info: index.html still has ${tokens.length} unfilled token(s)${tokens.length ? `: ${tokens.join(' ')}` : ''}`);
  check('index.html: one app root, one module script, the consent loader before gtag, nothing loads on localhost', /id="app"/.test(html) && /type="module" src="src\/ui\/main\.js"/.test(html)
    && html.indexOf('cdn-cookieyes.com') < html.indexOf('googletagmanager.com/gtag/js') && /localhost/.test(html));
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  check('package.json: the scripts the workflow relies on', ['dev', 'test', 'test:browser', 'sim', 'qa', 'sweep'].every((k) => pkg.scripts[k]) && pkg.type === 'module');
}

// ---------- art ids against the manifest ----------
{
  const manifest = JSON.parse(fs.readFileSync(new URL('../assets/manifest.json', import.meta.url), 'utf8'));
  const ids = new Set(manifest.assets.map((a) => a.id));
  check('assets: every built-in art id is in the manifest', builtInIds().every((id) => ids.has(id)), builtInIds().filter((id) => !ids.has(id)).join(','));
  check('assets: all 40 cards resolve to a face in the manifest', fullDeck().every((c) => ids.has(cardFace(c))));
  check('assets: every file the manifest calls real or placeholder exists', manifest.assets.filter((a) => a.status !== 'missing').every((a) => fs.existsSync(new URL(`../assets/${a.file}`, import.meta.url))));
  check('assets: the five seat ships are the tinted dhow, built in, in the manifest, on disk, and no old ship-* ids remain', SHIP_IDS.join() === 'dhow-ivory,dhow-black,dhow-purple,dhow-magenta,dhow-brown'
    && SHIP_IDS.every((id) => ids.has(id) && builtInIds().includes(id) && fs.existsSync(new URL(`../assets/ships/${id}.webp`, import.meta.url))) && !builtInIds().some((id) => /^ship-/.test(id)) && !manifest.assets.some((a) => /^ship-/.test(a.id)));
  check('assets: shipImg keeps the dhow aspect ratio and names the seat id', /data-asset="dhow-purple"/.test(shipImg(2)) && /width="256" height="215"/.test(shipImg(2)));
  check('assets: no absolute or Windows path in the manifest', manifest.assets.every((a) => !/^([A-Za-z]:|[\\/])/.test(a.file) && !/\\/.test(a.file)));
  check('assets: the UI\'s art ids are all built in', ['card-back', 'favicon', 'avatar-1', 'avatar-5', 'badge-spice', 'badge-pearls', 'island-silk-a', 'dhow-ivory', 'dhow-brown', 'hero-wide', 'serpent-white'].every((id) => builtInIds().includes(id)));
  check('assets: every manifest id the UI needs is built in (cards, islands, ships, badges)', manifest.assets.filter((a) => /^(card-|island-|dhow-(?!svg)|badge-|avatar-)/.test(a.id)).every((a) => builtInIds().includes(a.id)));
  useManifest(manifest);
  check('assets: assetUrl resolves by manifest id and refuses an unknown id', assetUrl('badge-pearls') === 'assets/icons/badge-pearls.webp' && assetUrl('card-spice-7') === 'assets/cards/card-spice-7.webp' && assetUrl('card-red-7') === null);
  check('assets: an unknown id gives a text chip, not a broken image', /asset-chip/.test(img('nope', { label: 'Nope' })) && !/<img/.test(img('nope')));
  check('assets: a card with art is an <img> by manifest id', /<img/.test(cardImg('spice-7')) && /cards\/card-spice-7\.webp/.test(cardImg('spice-7')));
  check('assets: a card with no art is drawn as a face with its number, cargo shape and a label', (() => {
    useManifest({ assets: [] });
    const ok = /cardchip--spice/.test(cardImg('spice-7')) && />7</.test(cardImg('spice-7')) && /aria-label="Spice 7"/.test(cardImg('spice-7')) && !BAD.test(cardBackImg()) && !BAD.test(badgeImg('spice'));
    useManifest(manifest);
    return ok;
  })());
}

// ---------- sentences ----------
{
  const names = ['Mia', 'Sam', 'Ann', 'Bo'];
  // The worked-example trick: Mia leads Spice 4, Sam follows Spice 7, Ann discards Amber 10, Bo trades Silk 5.
  const g = position({ hands: [['spice-4', 'pearls-2', 'pearls-3'], ['spice-7', 'silk-3', 'silk-4'], ['amber-10', 'silk-2', 'amber-4'], ['silk-5', 'silk-8', 'amber-5']], ships: [0, 1, 2, 6], leader: 0 });
  const ev = play(g, 'spice-4', 'amber-10', 'silk-5');
  const won = ev.find((e) => e.type === 'trick-won');
  const s = trickSentence(g.tricks[0], won, names);
  check('sentence: a lead, a follow, a discard and a trade, the winner and the serpents', s === 'Mia led Spice 4; Sam followed with Spice 7 and wins; Ann discarded Amber 10; Bo traded Silk 5 (counts as Spice). Sam takes 2 serpents.', s);
  check('banner: says who won with what, and a trade', winnerBanner({ winner: 1, card: 'silk-9', mode: 'trade' }, names) === 'Sam wins with Silk 9 (a trade)');
  check('banner: second person for You; a tie and the serpents', winnerBanner({ winner: 0, card: 'spice-9', mode: 'lead', tie: true, tieBrokenBy: 'first', serpents: 2 }, ['You', 'Sam']) === 'You win with Spice 9, a tie: first played wins, taking 2 serpents');
  const v3 = viewFor(g, 3);
  check('prompt: a lone human to play gets a sentence (the ladder in words)', !BAD.test(turnPrompt(viewFor(g, 1))) && turnPrompt(viewFor(g, 1)).length > 10 && v3.phase === 'play');
  const t = position({ players: 3, hands: [['spice-4', 'pearls-1', 'pearls-5'], ['silk-10', 'silk-3', 'amber-3'], ['spice-2', 'pearls-2', 'pearls-6']], ships: [0, 1, 0], leader: 0 });
  play(t, 'spice-4');
  check('prompt: the forced trade is surfaced (the island demands its cargo)', /island demands its cargo: you must trade Silk/.test(turnPrompt(viewFor(t, 1))), turnPrompt(viewFor(t, 1)));
  const m = startGame({ seed: 3, players: 3 }).state;
  check('prompt: mooring', /^Moor your ship/.test(turnPrompt(viewFor(m, m.toAct))));
}
{
  const names = ['Ann', 'Bo', 'Cy'];
  const mk = (tied, winners, shared, used, lastHand) => ({ tiedOnTotal: tied, winners, shared, tiebreakUsed: used, winningScore: 14, lastHand, ranking: [] });
  const t1 = tiebreakText(mk([0, 1], [1], false, true, [3, 6, 0]), names);
  check('tiebreak text: most points in the final voyage decides, tied players only', /^Ann and Bo tied on 14\. Tiebreak: most points in the final voyage\. Points in the final voyage: Ann 3, Bo 6\. Bo wins\.$/.test(t1), t1);
  const t2 = tiebreakText(mk([0, 1], [0, 1], true, false, [4, 4, 0]), names);
  check('tiebreak text: a shared win says shared', /Still level, so the win is shared\.$/.test(t2), t2);
  const t3 = tiebreakText(mk([0, 1, 2], [0, 1], true, true, [5, 5, 2]), names);
  check('tiebreak text: a three-way tie with two level on the final voyage shares between those two', /^Ann, Bo and Cy tied on 14\. Tiebreak: most points in the final voyage\. Points in the final voyage: Ann 5, Bo 5, Cy 2\. Ann and Bo share the win\.$/.test(t3), t3);
  check('tiebreak text: no tie at the top says nothing', tiebreakText(mk([0], [0], false, false, [3, 2, 1]), names) === '');
  check('tied groups: only groups of two or more', JSON.stringify(tiedGroups({ ranking: [{ seat: 0, total: 9 }, { seat: 1, total: 9 }, { seat: 2, total: 4 }] })) === '[[0,1]]');
  check('voyage end text: names every score, with the arithmetic when given', handEndText({ handNo: 0, scores: [3, 5, 0] }, names) === 'Voyage 1 scores: Ann 3, Bo 5, Cy 0.'
    && handEndText({ handNo: 1, scores: [1, -2, 0], lines: [{ trickScore: 3, serpentScore: -2 }, { trickScore: 1, serpentScore: -3 }, { trickScore: 0, serpentScore: 0 }] }, names) === 'Voyage 2 scores: Ann +3 -2 = 1, Bo +1 -3 = -2, Cy +0 +0 = 0.');
  check('waiting text: bot, human, You and the end', waitingText({ phase: 'play', toAct: 1 }, names, ['human', 'easy', 'human']) === 'Bo is thinking.'
    && waitingText({ phase: 'play', toAct: 0 }, ['You', 'x'], ['human', 'easy']) === 'You are to play.' && waitingText({ phase: 'over', toAct: null }, names, []) === 'Game over.'
    && waitingText({ phase: 'moor', toAct: 1 }, names, ['human', 'easy', 'human']) === 'Bo is choosing an island.');
}

// ---------- clone-and-apply hints ----------
{
  const g = position({ hands: [['spice-8', 'spice-1', 'pearls-1'], ['spice-2', 'spice-9', 'pearls-2'], ['spice-3', 'spice-5', 'pearls-3'], ['spice-4', 'spice-10', 'pearls-4']], leader: 0 });
  const before = JSON.stringify(g);
  const lead = previewCard(g, 'spice-8');
  check('preview: leading is a lead hint and never touches the real state', lead.kind === 'lead' && JSON.stringify(g) === before);
  play(g, 'spice-8');
  const lose = previewCard(g, 'spice-2');
  const win = previewCard(g, 'spice-9');
  check('preview: a card that cannot beat the lead says so, with who is ahead', lose.kind === 'follow' && lose.mode === 'follow' && !lose.wins && lose.winnerSeat === 0 && lose.winnerCard === 'spice-8' && lose.remaining === 2 && !lose.sails);
  check('preview: a card that beats the lead says it would win as it stands', win.wins && !win.final && win.remaining === 2);
  check('preview: a card that may not be played has no hint', previewCard(g, 'pearls-2') === null && previewCard(g, 'nope') === null);
  play(g, 'spice-9', 'spice-3');
  const last = previewCard(g, 'spice-4');
  const lastWin = previewCard(g, 'spice-10');
  check('preview: the last card of a trick knows the final result', last.final && !last.wins && last.winnerSeat === 1 && lastWin.final && lastWin.wins);
  check('preview: the last card of a trick knows the serpents it takes', lastWin.serpents === 2 && last.serpents === 0);
  const tr = position({ players: 3, hands: [['spice-4', 'pearls-1', 'pearls-5'], ['silk-10', 'silk-3', 'amber-3'], ['spice-2', 'pearls-2', 'pearls-6']], ships: [0, 1, 0], leader: 0 });
  play(tr, 'spice-4');
  const pt = previewCard(tr, 'silk-10');
  check('preview: a trade says it counts as led, can win, and where the ship sails', pt.mode === 'trade' && pt.wins && pt.sails && pt.sailTo === 2 && pt.sailToCargo === 'pearls' && /trade: it counts as Spice/.test(previewText(pt, ['A', 'B', 'C'])) && /sail to island 3 \(Pearls\)/.test(previewText(pt, ['A', 'B', 'C'])));
  check('preview text: reads as English with no raw values', [lead, lose, win, last, lastWin, pt].every((p) => !BAD.test(previewText(p, ['A', 'B', 'C', 'D'])) && previewText(p, ['A', 'B', 'C', 'D']).length > 10));
  check('cloneState: a deep, independent copy', (() => { const c = cloneState(g); c.hands[0].pop(); c.totals[0] = 99; return g.totals[0] !== 99 && JSON.stringify(cloneState(g)) === JSON.stringify(g); })());
}

// ---------- the table model: events land exactly on the live state ----------
{
  const CONFIGS = [{ rules: {} }, { rules: { MOOR: 'score', TIE: 'real', TRADE: 'optional' } }, { rules: { VOYAGES: 'four', SCORING: 'serpents' } }];
  let actions = 0; let drift = 0; let firstDrift = ''; let framesBad = 0; let modals = 0; let handEnds = 0; let decided = 0; let tricks = 0; let games = 0; let sailFrames = 0; let sailEvents = 0;
  for (const cfg of CONFIGS) {
    for (let seed = 1; seed <= 10; seed++) {
      for (const players of [2, 3, 4, 5]) {
        for (const humans of [[0], [0, 2], []]) {
          if (humans.some((h) => h >= players)) continue;
          if (!(seed <= 3 || humans.length === 1)) continue;
          const started = startGame({ seed: seed * 7 + players, players, rules: cfg.rules });
          games++;
          const state = started.state;
          const names = Array.from({ length: players }, (_, i) => `P${i + 1}`);
          let board = boardFromState(state, humans);
          const rng = makeRng(`b${seed}${players}`);
          while (state.phase !== 'over') {
            const action = rngPick(rng, getValidActions(state));
            const events = applyAction(state, action);
            const ctx = { names, describe: describeEvent, trickText: trickSentence, liveHands: (s) => state.hands[s] };
            const frames = buildFrames(board, events, ctx);
            actions++;
            if (frames.length) board = frames[frames.length - 1].board;
            const live = boardFromState(state, humans);
            if (!sameBoard(board, live)) { drift++; if (!firstDrift) firstDrift = `${JSON.stringify(cfg.rules)} seed ${seed} p${players}: ${diffKeys(board, live)}`; board = live; }
            for (const f of frames) {
              if (f.hold === Infinity && !f.modal) framesBad++;
              if (f.modal) modals++;
              if (f.kind === 'decided') { decided++; if (!f.board.trick || !f.board.banner || f.board.trick.winner === undefined) framesBad++; }
              if (f.kind === 'resolve') { tricks++; if (!f.log || !/\.$/.test(f.log)) framesBad++; }
            }
            const he = events.filter((e) => e.type === 'voyage-ended').length;
            sailEvents += events.filter((e) => e.type === 'sailed').length;
            sailFrames += frames.filter((f) => f.kind === 'sail').length;
            if (events.some((e) => e.type === 'sailed') && !frames.some((f) => f.kind === 'sail')) framesBad++;
            handEnds += he;
            if (frames.filter((f) => f.modal).length !== he) framesBad++;
            if (events.some((e) => e.type === 'trick-won' && !frames.some((f) => f.kind === 'decided'))) framesBad++;
          }
        }
      }
    }
  }
  check('board: walking the events lands exactly on the live state, every action, every variant', drift === 0, `${actions} actions in ${games} games, ${drift} drifts, first: ${firstDrift}`);
  check('board: frames are well formed (a decided beat per trick, one modal per voyage end, sails shown as one beat per trick)', framesBad === 0 && modals === handEnds && handEnds > 100 && decided === tricks && tricks > 1000 && sailFrames > 0 && sailFrames <= sailEvents, `bad ${framesBad}, modals ${modals}, voyage ends ${handEnds}, decided ${decided}, tricks ${tricks}, sail frames ${sailFrames}`);
}
function diffKeys(a, b) {
  const keys = Object.keys(a).filter((k) => !['fx', 'last', 'banner'].includes(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  return keys.map((k) => `${k}: ${JSON.stringify(a[k])} vs ${JSON.stringify(b[k])}`).join(' | ');
}
{
  // The last trick of a hand plays itself: the frames must show the trick, the reckoning, and then the new deal.
  let seen = 0; let ok = true;
  for (let seed = 1; seed <= 8; seed++) {
    const { state } = startGame({ seed, players: 4 });
    let board = boardFromState(state, [0]);
    const rng = makeRng(`z${seed}`);
    while (state.phase !== 'over') {
      const action = rngPick(rng, getValidActions(state));
      const events = applyAction(state, action);
      const frames = buildFrames(board, events, { names: ['A', 'B', 'C', 'D'], describe: describeEvent, trickText: trickSentence, liveHands: (s) => state.hands[s] });
      if (frames.length) board = frames[frames.length - 1].board;
      if (events.some((e) => e.type === 'voyage-ended')) {
        seen++;
        const kinds = frames.map((f) => f.kind);
        const iEnd = kinds.indexOf('hand-end');
        const iNext = kinds.indexOf('deal');
        if (!(state.phase === 'over' ? iNext === -1 : iNext > iEnd)) ok = false;
        if (frames[iEnd].board.trickNo !== state.handSize && state.phase !== 'over') { /* the board at the reckoning still shows the full hand */ }
      }
    }
  }
  check('board: a voyage end shows the reckoning before the next deal', seen >= 20 && ok, `${seen} voyage ends`);
  const b0 = boardFromState(startGame({ seed: 1, players: 3 }).state, [0]);
  check('board: reduceBoard returns a fresh copy and ignores unknown events', reduceBoard(b0, { type: 'nope' }) !== b0 && sameBoard(reduceBoard(b0, { type: 'nope' }), b0));
}

// ---------- landing and setup ----------
{
  const levels = botLevels();
  const html = landingHtml(levels, DEFAULT_SETUP, '');
  check('landing: a radio per player count and five seat forms', PLAYER_COUNTS.every((n) => html.includes(`name="players" value="${n}"`)) && (html.match(/class="seatform"/g) || []).length === 5);
  check('landing: the Playtest rules panel has one row per VARIANTS entry, each with its options and description', (html.match(/class="rule"/g) || []).length === VARIANTS.length
    && VARIANTS.every((v) => html.includes(`name="rule-${v.name}"`) && v.values.every((x) => html.includes(esc(variantText(v).values[x]))) && html.includes(esc(variantText(v).description))));
  check('landing: every switch has player-facing text (no raw codes), the standard named in its description', VARIANTS.every((v) => {
    const t = variantText(v);
    return t.label.length > 3 && t.description.length > 60 && v.values.every((x) => t.values[x] && t.values[x] !== x) && /Standard/.test(t.description);
  }));
  check('landing: the pills (2-5 best 3-4, 25-35, 10+, 1 to 10), the hook, watch-the-bots and both sides of the how-to-play card', /2-5/.test(html) && /best 3-4/.test(html) && /25-35/.test(html) && /10\+/.test(html) && /1 to 10/.test(html) && /Every island demands its cargo\./.test(html) && /data-action="watch-bots"/.test(html) && /hero-wide|The Voyages of Sinbad/.test(html) && /how-to-play-front|how-to-play card/.test(html));
  const how = howToPlayHtml();
  const steps = ['Follow', 'Trade', 'Discard', 'Win', 'Take', 'Sail'];
  check('how to play: the six steps in order, the scoring and the 1 to 10 range', steps.every((k, i) => how.includes(`<h4>${k}</h4>`) && (i === 0 || how.indexOf(`<h4>${k}</h4>`) > how.indexOf(`<h4>${steps[i - 1]}</h4>`)))
    && /\+1 per trick won, &minus;1 per serpent/.test(how) && /every 1 \(one\) and every 10 \(two\)/.test(how) && /1 to 10/.test(how));
  check('landing: the panel marks the standard value and has a reset', /\(standard\)/.test(rulesPanelHtml(DEFAULT_SETUP)) && /data-action="reset-rules"/.test(html));
  check('landing: Play forced cards for me is off by default and explained', /Play forced cards for me/.test(html) && !/id="autoPlayForced" checked/.test(html));
  check('landing: How to play and the rule book link are on the page', /How to play/.test(html) && html.includes(RULEBOOK_URL) && howToPlayHtml().includes(RULEBOOK_URL));
  check('landing: the bug-free text (no undefined / NaN / [object])', !BAD.test(html) && !BAD.test(howToPlayHtml()));
  check('landing: the contact for bug reports is not on the page as a raw address', !/@/.test(html));
  check('seat menu: human and the three levels, a missing level disabled', /value="human"/.test(seatTypeOptions(levels, 'human')) && /value="hard"/.test(seatTypeOptions(levels, 'easy'))
    && /disabled/.test(seatTypeOptions(levels.filter((l) => l.id !== 'hard'), 'easy')));
  check('seat menu: simulator-only bots are not offered', !/value="high"/.test(seatTypeOptions(levels, 'easy')) && !/value="low"/.test(seatTypeOptions(levels, 'easy')));
  check('setup: names made unique, case-insensitive', JSON.stringify(uniqueNames(['Sam', 'sam', '', 'Ann', 'SAM'])) === '["Sam","sam 2","","Ann","SAM 3"]');
  check('setup: the rules code of a setup', safeCode(DEFAULT_SETUP) === 'std' && safeCode({ players: 4, rules: { TIE: 'real' } }) === 'tie-real' && safeCode({ players: 4, rules: { TIE: 'nonsense' } }) === 'std');
  check('setup: humans counted over the seats in play only', humanCount({ players: 3, seats: [{ type: 'human' }, { type: 'easy' }, { type: 'human' }, { type: 'human' }] }) === 2);
}

// ---------- pass-and-play: hands stay hidden ----------
{
  const ui = { selected: null, note: '', panels: {}, frame: null, modal: null };
  const mk = (seats, reveal) => {
    const ctl = createController({ seats, seed: 21 });
    if (reveal !== undefined) ctl.reveal(reveal);
    return ctl;
  };
  const lone = mk([{ type: 'human' }, { type: 'easy' }, { type: 'easy' }]);
  const vmLone = makeVm({ ctl: lone, ui, board: boardFromState(lone.state, lone.humanSeats), log: [] });
  check('viewmodel: a lone human always has their hand on show (also while mooring), with a reason or a hint on every card when it is their turn to play', vmLone.hand !== null && vmLone.hand.length === 13 && (!vmLone.myTurn || vmLone.state.phase !== 'play' || vmLone.hand.every((c) => vmLone.reasons.has(c))));
  const duo = mk([{ type: 'human', name: 'A' }, { type: 'human', name: 'B' }, { type: 'easy' }]);
  const vmCover = makeVm({ ctl: duo, ui, board: boardFromState(duo.state, duo.humanSeats), log: [] });
  check('viewmodel: with two humans no hand is shown until the next human confirms', duo.needsHandoff() ? vmCover.hand === null : true);
  if (duo.isHumanTurn()) duo.reveal(duo.toAct());
  const vmShown = makeVm({ ctl: duo, ui, board: boardFromState(duo.state, duo.humanSeats), log: [] });
  check('viewmodel: after the cover is confirmed the hand of that human is shown', !duo.isHumanTurn() || (vmShown.hand !== null && vmShown.shown === duo.toAct()));
  const cover = coverHtml({ names: duo.names }, 1);
  check('cover: names the player and shows no card, trick or score', /Pass to B/.test(cover) && !/class="hand"|cardimg|cardchip|tplay|Total/.test(cover));
  const replay = makeVm({ ctl: duo, ui: { ...ui, frame: { board: boardFromState(duo.state, duo.humanSeats) } }, board: boardFromState(duo.state, duo.humanSeats), log: [] });
  check('viewmodel: while a replay frame is on screen with two humans, no hand is shown', replay.hand === null || replay.shown === null);
}

// ---------- screens ----------
{
  const ui = { selected: null, note: '', panels: {}, frame: null, modal: null };
  const ctl = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed: 31 });
  let guard = 0; let screens = 0; let bad = '';
  const rng = makeRng('scr');
  let sawSummary = false; let sawEnd = false; let sawPlay = false; let sawMoor = false;
  while (guard++ < 400) {
    ctl.runBots();
    const board = boardFromState(ctl.state, ctl.humanSeats);
    const vm = makeVm({ ctl, ui, board, log: ctl.log.map((l) => ({ text: l.text, kind: 'info' })) });
    const html = [tableHtml(vm), seatsHtml(vm), handBoxHtml(vm), sideHtml(vm), statusHtml(vm)].join('');
    screens++;
    if (BAD.test(html) && !bad) bad = (html.match(/.{40}(undefined|NaN|\[object).{20}/) || ['?'])[0];
    if (ctl.isFinished()) {
      const end = gameEndHtml(vm) + endBarHtml(vm);
      if (BAD.test(end) && !bad) bad = 'end';
      sawEnd = true;
      check('end screen: ranks everyone, names a winner, offers Play again and Stats', (end.match(/class="rank/g) || []).length >= 4 && /Play again/.test(end) && /data-action="open-stats"/.test(end));
      break;
    }
    if (ctl.state.handLog.length && !sawSummary) {
      const rec = ctl.state.handLog[0];
      const html2 = handSummaryHtml(vm, { kind: 'hand', handNo: 0, event: { handNo: 0, tricksWon: rec.tricksWon, scores: rec.scores, totals: rec.scores } });
      sawSummary = true;
      check('voyage summary: a row per player, the arithmetic and a Lay the next ring button', (html2.match(/<tr/g) || []).length >= 5 && /Lay the next ring/.test(html2) && /Serpents/.test(html2) && !BAD.test(html2));
      const noSerp = handSummaryHtml(vm, { kind: 'hand', handNo: 0, event: { handNo: 0, tricksWon: rec.tricksWon, serpentsTaken: [0, 0, 0, 0, 0], scores: rec.scores, totals: rec.scores } });
      check('voyage summary: zero serpents shows 0, never -0', /num--serpents[^>]*><b>0<\/b>/.test(noSerp) && !/[−-]0/.test(noSerp.replace(/<[^>]*>/g, ' ')));
    }
    if (ctl.isHumanTurn()) {
      const legal = ctl.legalActions();
      const myHtml = handBoxHtml(vm);
      if (ctl.state.phase === 'play' && !sawPlay) { sawPlay = true; check('hand: every playable card is a button, every other dimmed with its reason', (myHtml.match(/is-legal/g) || []).length === legal.length && (myHtml.match(/is-blocked/g) || []).length === vm.hand.length - legal.length); }
      if (ctl.state.phase === 'moor' && !sawMoor) { sawMoor = true; check('mooring: one button per island, the hand on show, no card playable', (ringHtml(vm).match(/data-action="decide"/g) || []).length === 8 && /clockwise/.test(decisionHtml(vm)) && (myHtml.match(/is-legal/g) || []).length === 0 && /Moor your ship/.test(myHtml)); }
      ctl.play(rngPick(rng, legal));
    }
  }
  check('screens: the table, hand, side and status render for the whole game with no raw values', screens > 20 && !bad, bad);
  check('screens: the summary, the end screen, a mooring and a play were all reached', sawSummary && sawEnd && sawPlay && sawMoor);
  const ring = ringHtml({ board: boardFromState(ctl.state, [0]), names: ctl.names, ui: { selected: null }, shown: 0, view: null, myTurn: false, frame: null });
  const seatZero = seatHtml(makeVm({ ctl, ui, board: boardFromState(ctl.state, ctl.humanSeats), log: [] }), 0);
  check('seat calc: a player with no serpents shows 0, never -0', /data-serpents="0"[^>]*><b>(0|[−+]\d+)<\/b>/.test(seatZero) && !/[−-]0/.test(seatZero.replace(/<[^>]*>/g, ' ')));
  {
    // the hand panel's island chip: the shown seat's island and cargo; nothing leaks while the hand is hidden
    const bd = boardFromState(ctl.state, ctl.humanSeats);
    const vm0 = makeVm({ ctl, ui, board: bd, log: [] });
    const html0 = handBoxHtml(vm0);
    const isl = bd.ships[vm0.shown];
    check('hand panel: the island chip shows the shown seat island number, cargo badge and cargo name', isl !== null && vm0.hand !== null
      && new RegExp(`class="youisle youisle--${bd.ring[isl]}"[^>]*data-seat="${vm0.shown}" data-island="${isl}" data-cargo="${bd.ring[isl]}"`).test(html0) && html0.includes(`Island ${isl + 1}`) && html0.includes(`data-asset="badge-${bd.ring[isl]}"`) && html0.includes(SUIT_NAMES[bd.ring[isl]]) && !BAD.test(html0));
    const moved = { ...bd, ships: bd.ships.map((x, i) => (i === vm0.shown ? (x + 1) % bd.ring.length : x)) };
    const html1 = handBoxHtml({ ...vm0, board: moved });
    check('hand panel: the chip follows a sail (next island, its cargo)', html1.includes(`data-island="${(isl + 1) % bd.ring.length}"`) && html1.includes(`data-cargo="${bd.ring[(isl + 1) % bd.ring.length]}"`));
    const unmoored = handBoxHtml({ ...vm0, board: { ...bd, ships: bd.ships.map(() => null) } });
    check('hand panel: before mooring the chip is neutral, with no island', /youisle--none/.test(unmoored) && /Not moored yet/.test(unmoored) && !/data-island=/.test(unmoored.replace(/<div class="hand-wrap">[\s\S]*$/, '')));
    const hidden = handBoxHtml({ ...vm0, hand: null, humanSeats: [0, 1], shown: null });
    check('hand panel: pass-and-play while hands are hidden shows no island chip', !/youisle/.test(hidden) && /Hands are hidden/.test(hidden));
  }
  check('ring: eight islands in order, every ship on its island', (ring.match(/data-island=/g) || []).length === 8 && (ring.match(/data-ship-seat=/g) || []).length === 4 && !BAD.test(ring));
}

// ---------- the Sinbad table: forced trade, sideways trade, arithmetic, sail frames, leftovers ----------
{
  // A forced trade with several ranks: Bo (island Silk) holds no Spice but two Silk cards; Spice is led.
  const t = position({ players: 3, hands: [['spice-4', 'pearls-1', 'pearls-5'], ['silk-10', 'silk-3', 'amber-3'], ['spice-2', 'pearls-2', 'pearls-6']], ships: [0, 1, 0], leader: 0 });
  play(t, 'spice-4');
  const sit = playSituation(viewFor(t, 1));
  const txt = situationText(sit);
  check('situation: a forced trade with two ranks names the island, the cargo and the choice of rank', sit.kind === 'trade' && sit.ranks.length === 2 && /The island demands its cargo: you must trade Silk/.test(txt.title) && /counts as Spice/.test(txt.body) && /rank/.test(txt.tip) && /island 3 \(Pearls\)/.test(txt.body), JSON.stringify(txt));
  check('situation: before a card is led the situation is a lead', playSituation(viewFor(t, 0)) === null || playSituation(viewFor(position({ players: 3, hands: [['spice-4', 'pearls-1', 'pearls-5'], ['silk-10', 'amber-3', 'amber-4'], ['spice-2', 'pearls-2', 'pearls-6']], ships: [0, 1, 0], leader: 0 }), 0)).kind === 'lead');
  const one = situationText({ kind: 'trade', led: 'spice', islandCargo: 'silk', island: 1, sailTo: 2, sailToCargo: 'pearls', count: 1, ranks: ['silk-10'] });
  check('situation: a single trade rank says it is the only one', /Silk 10 is the only Silk card you hold/.test(one.tip), one.tip);
  const t3 = position({ players: 3, hands: [['spice-4', 'pearls-1', 'pearls-5'], ['amber-10', 'amber-3', 'pearls-4'], ['spice-2', 'pearls-2', 'pearls-6']], ships: [0, 1, 0], leader: 0 });
  play(t3, 'spice-4');
  const dis = playSituation(viewFor(t3, 1));
  check('situation: nothing to follow or trade is a discard that cannot win', dis.kind === 'discard' && /cannot win/.test(situationText(dis).body));
  const opt = position({ players: 3, rules: { TRADE: 'optional' }, hands: [['spice-4', 'pearls-1', 'pearls-5'], ['silk-10', 'amber-3', 'amber-4'], ['spice-2', 'pearls-2', 'pearls-6']], ships: [0, 1, 0], leader: 0 });
  play(opt, 'spice-4');
  check('situation: an optional trade says may, not must', playSituation(viewFor(opt, 1)).kind === 'trade-optional' && /you may trade Silk/.test(situationText(playSituation(viewFor(opt, 1))).title));

  // The trick on screen: a trade is sideways with its chip; a discard is marked; the best card is named by the engine.
  const hands4 = () => [['spice-4', 'pearls-2', 'pearls-3'], ['spice-7', 'silk-3', 'silk-4'], ['amber-10', 'silk-2', 'amber-4'], ['silk-9', 'silk-8', 'amber-5']];
  const mk = (state) => ({ board: boardFromState(state, [0]), names: ['Mia', 'Sam', 'Ann', 'Bo'], shown: 0, ui: { selected: null, panels: {} }, frame: null, view: null, myTurn: false });
  const g2 = position({ hands: hands4(), ships: [0, 1, 2, 6], leader: 0 });
  play(g2, 'spice-4', 'spice-7', 'amber-10');
  const trick = trickHtml(mk(g2));
  check('trick: cards in play order, the discard marked cannot win, the best card named', /Leads/.test(trick) && /Discard: can&#39;t win/.test(trick) && /tplay is-best/.test(trick) && /Best so far/.test(trick) && /Sam is winning with Spice 7/.test(trick) && !/is-sideways/.test(trick));
  const tr = position({ hands: hands4(), ships: [0, 1, 2, 6], leader: 0 });
  play(tr, 'spice-4', 'spice-7', 'amber-10', 'silk-9');
  const tt = trickHtml({ ...mk(tr), board: { ...boardFromState(tr, [0]) } });
  // the trick completed in the engine (and was taken); build the on-table trick from the events instead
  const live = position({ hands: [['spice-4', 'pearls-2', 'pearls-3'], ['spice-7', 'silk-3', 'silk-4'], ['silk-9', 'silk-2', 'amber-4'], ['silk-8', 'silk-5', 'amber-5']], ships: [0, 1, 0, 6], leader: 0 });
  play(live, 'spice-4', 'spice-7');
  const sideways = trickHtml(mk(live));
  check('trick: a card still to play leaves an empty dashed slot', /tplay--empty/.test(sideways) && tt.length > 100);
  const lt = position({ hands: [['spice-4', 'pearls-2', 'pearls-3'], ['spice-3', 'silk-3', 'silk-4'], ['silk-9', 'silk-2', 'amber-4'], ['silk-8', 'silk-5', 'amber-5']], ships: [0, 1, 1, 6], leader: 0 });
  play(lt, 'spice-4', 'spice-3', 'silk-9');
  const tradeHtml = trickHtml(mk(lt));
  check('trick: a trade is laid sideways with its counts-as chip and, when it leads, is the best card', /tplay is-best is-sideways/.test(tradeHtml) && /Trade: counts as Spice/.test(tradeHtml) && /mark--trade/.test(tradeHtml) && /Silk 9 \(a trade\)/.test(tradeHtml), tradeHtml.slice(0, 200));
  const ties = position({ hands: [['spice-7', 'pearls-2', 'pearls-3'], ['spice-7', 'silk-3', 'silk-4'], ['amber-10', 'silk-2', 'amber-4'], ['silk-8', 'silk-5', 'amber-5']], ships: [0, 1, 2, 6], leader: 0 });
  play(ties, 'spice-7', 'spice-7');
  check('trick: a tie is noted (first played wins)', /Tied on 7: the first card played wins/.test(trickHtml(mk(ties))));

  // the seat's live arithmetic: +tricks -serpents = voyage
  const board = boardFromState(ties, [0]);
  const seat = seatHtml({ board: { ...board, tricksWon: [3, 0, 0, 0], serpentsTaken: [2, 0, 0, 0], serpentRows: [['spice-1', 'amber-10'], [], [], []], totals: [5, 0, 0, 0] }, names: ['Mia', 'Sam', 'Ann', 'Bo'], types: ['human', 'easy', 'easy', 'easy'], humanSeats: [0], shown: 0 }, 0);
  check('seat: tricks, serpents and the voyage score are shown as +3 −2 = 1, with the total and the cards in hand', />\+3</.test(seat) && />−2</.test(seat) && /calc__part--score[^>]*><b>1<\/b>/.test(seat) && /Total <b>5<\/b>/.test(seat) && /seat__cardsnum/.test(seat) && (seat.match(/seat__serpentcard/g) || []).length === 2, seat.slice(0, 300));
  check('signed: plus, typographic minus and zero', signed(3) === '+3' && signed(-2) === '−2' && signed(0) === '0');
}
{
  // Sail frames carry who sailed from where to where, and every sail of one trick is one frame.
  let sails = 0; let frames = 0; let bad = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const { state } = startGame({ seed, players: 4 });
    let board = boardFromState(state, [0]);
    const rng = makeRng(`s${seed}`);
    while (state.phase !== 'over') {
      const events = applyAction(state, rngPick(rng, getValidActions(state)));
      const fr = buildFrames(board, events, { names: ['A', 'B', 'C', 'D'], describe: describeEvent, trickText: trickSentence, liveHands: (s) => state.hands[s] });
      if (fr.length) board = fr[fr.length - 1].board;
      for (const f of fr.filter((x) => x.kind === 'sail')) {
        frames++; sails += f.sails.length;
        if (!f.sails.every((m) => Number.isInteger(m.seat) && Number.isInteger(m.from) && Number.isInteger(m.to) && m.to === (m.from + 1) % 8)) bad++;
      }
      if (events.filter((e) => e.type === 'sailed').length !== fr.filter((x) => x.kind === 'sail').reduce((a, f) => a + f.sails.length, 0)) bad++;
    }
  }
  check('board: sail frames list every ship that moved, one island clockwise', frames > 50 && bad === 0 && sails >= frames, `${frames} frames, ${sails} sails, ${bad} bad`);
}
{
  // The ring: eight islands, a clockwise arrow in each gap, mooring buttons only on a human's turn, ships and next-island dots.
  const { state } = startGame({ seed: 5, players: 3 });
  const board = boardFromState(state, [0]);
  const base = { board, names: ['A', 'B', 'C'], ui: { selected: null, panels: {} }, shown: 0, frame: null };
  const quiet = ringHtml({ ...base, view: null, myTurn: false });
  check('ring: no mooring buttons when it is not a human\'s turn; a clockwise arrow in each of the eight gaps', !/data-action="decide"/.test(quiet) && (quiet.match(/class="ring__arrow"/g) || []).length === 8 && /Ships sail clockwise only/.test(quiet));
  const turn = ringHtml({ ...base, view: viewFor(state, state.toAct), myTurn: true });
  check('ring: on a human\'s mooring turn every island is a button with a label that says where it is', (turn.match(/data-action="decide"/g) || []).length === 8 && /aria-label="Moor at island 1, /.test(turn) && /data-decision='\{"type":"moor","island":7\}'/.test(turn));
  applyAction(state, { type: 'moor', island: 2 });
  const r2 = ringHtml({ ...base, board: boardFromState(state, [0]), view: null, myTurn: false });
  check('ring: a moored ship sits on its island and its next island carries a dot', (r2.match(/data-ship-seat=/g) || []).length === 1 && (r2.match(/class="nextdot"/g) || []).length === 1 && /sails here next/.test(r2));
}
{
  // Leftover words from a template and from other games must not be in the UI; no script-like decoration.
  const files = ['src/ui/components.js', 'src/ui/landing.js', 'src/ui/text.js', 'src/ui/board.js', 'src/ui/main.js', 'src/ui/viewmodel.js', 'src/ui/preview.js', 'style.css', 'index.html'];
  // The marker is written in two pieces so that this guard does not trip the publication sweep (tests/qa/sweep.mjs).
  const marker = 'TO' + 'DO\\(game\\)';
  const re = new RegExp(`\\b(summit|mob|sheep|troopers?|climbs?|descents?|trumps?|brumby|snowy|waltzing|matilda|starter kit)\\b|1-12|1 to 12|${marker}`, 'i');
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').split('\n');
    text.forEach((line, i) => { if (re.test(line) && !/No trumps?\b/i.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 80)}`); });
  }
  check('leftovers: no leftover words from other games or from a template in the UI', hits.length === 0, hits.slice(0, 5).join(' | '));
  const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  check('guardrails: no web fonts and no script-imitating faces', !/@import|@font-face|fonts\.googleapis/.test(css) && !/aladin|arabic|kufi|naskh|nastaliq|cairo|amiri/i.test(css));
}

done();
