# The Voyages of Sinbad

A trick-taking card game for 2 to 5 players (best with 3 or 4), played in the browser. About 25 to 35 minutes a game, ages 10 and up.

*Every island demands its cargo.* Eight islands, four cargoes, one rule: when you cannot follow the cargo that was led, your ship's island tells you what you must trade. Win tricks, dodge the serpents, and mind where your ship is moored.

**Play it online: <https://www.wombatgamefactory.com/sinbad-game/>**

## How a game goes

- The deck is 40 cargo cards in four cargoes (Spice, Pearls, Silk and Amber), numbered 1 to 10. Every 1 carries one **serpent** and every 10 carries two, twelve in all. There are no trumps.
- A ring of 8 **island** cards is laid out, two of each cargo. Each player **moors** a ship at any island; ships may share an island. Ships only ever sail **clockwise**.
- Everyone is dealt 13 cards (2 or 3 players), 10 (4 players) or 8 (5 players); the rest are set aside, unseen.
- The player left of the dealer leads any card. On every trick:
  - **Follow.** If you hold the cargo that was led, you must play one of those cards.
  - **Trade.** Otherwise, if you hold your island's cargo, you must play one of those cards, laid sideways. It counts as the cargo led, and it can win.
  - **Discard.** Otherwise play any card. It cannot win.
- There are no trumps. The highest card counting as the cargo led wins the trick, and a tie goes to the card played first.
- After the trick, every player who traded or discarded sails one island clockwise. The player who led never sails, and neither does anyone who followed.
- **Scoring.** A voyage (one deal) scores +1 for every trick you won and -1 for every serpent on the cards you won. Scores can go negative.
- A game is one voyage per player (four voyages at two players), and the deal passes left each time. The highest total wins. If totals are tied, the tied player with the most points in the final voyage wins; if that is level too, the win is shared.

The printed rule book is in [`rules/`](rules/sinbad-rule-book-v3.pdf), and the page has a short how-to-play.

## What is in the game

- 2 to 5 seats. Each seat can be a human or an Easy, Medium or Hard bot. Set every seat to a bot to watch a game.
- Pass and play: with two or more humans on one device, a cover hides each hand between turns.
- When you must trade, the game tells you so and shows which cards are your island's cargo. Ships sail with a short animation, a chip in your hand panel always shows your island and its cargo, and a small dot on the ring marks the island each ship sails to next.
- For learners, you play every card yourself, even when only one is legal. Tick "Play forced cards for me" on the setup screen to have those played automatically.
- **Playtest rules.** A collapsed panel on the setup page holds five switches, each with the standard rule as the default. A game with any other setting is a playtest game, and its result is recorded with the rules it used.
  - *Mooring order*: clockwise from the dealer's left (standard), or the players with the highest running totals moor first and the player in last place moors last.
  - *Tie rule*: the card played first wins a tie (standard), or a card of the led cargo beats a traded card of the same number.
  - *Trade*: mandatory (standard), or optional, so that you may discard instead of trading.
  - *Voyages*: one per player, four at two players (standard), or four at every player count.
  - *Scoring*: +1 a trick and -1 a serpent (standard), or serpents only.
- A local stats screen with CSV and JSON export. Results stay in your browser.
- A built-in "report a problem" button (also Ctrl+Shift+B) that saves a JSON snapshot of the game as it stands, for bug reports. Nothing is sent automatically; it prepares an email to info@wombatgamefactory.com.
- The live site uses Google Analytics behind a cookie-consent banner. It counts games started, voyages finished, games finished and games left unfinished, and for each finished game sends a short anonymous summary: number of players, the kinds of seat (human or bot level), the rules code, the kind of seat that won (human, a bot level, or shared), the winning score and margin, whether the tiebreak was used, the number of tricks, trades, sails and forced 10s, and the game's length in seconds. It also counts when the stats screen or the rules are opened and when a playtest switch is changed. No names or free text are sent. Neither the banner nor Analytics loads on localhost.

## Run it locally

There is no build step and nothing to install. The game is plain JavaScript modules, HTML and CSS.

```sh
npm run dev
```

This serves the folder on <http://localhost:8080> (it uses `npx http-server`, so it needs Node.js and an internet connection the first time). Any other static file server works too: serve the repository root and open `index.html` through it. Opening the file directly from disk will not work in most browsers, because modules need a server.

Two URL options are handy while testing: `?seed=7` makes the deals repeatable, and `?botdelay=50` sets the pause (in milliseconds) before each bot move.

## Tests

```sh
npm test
```

Runs every Node test suite: the engine's purity, the rules (one check per numbered rule), a replay of games recorded from the original Python simulator, a smoke test that plays thousands of bot games, the game controller, the bots, the simulator, the stats store, the analytics whitelist and the interface helpers. It needs only Node.js.

```sh
npm run test:browser
```

Drives the real page in headless Chromium: full games against each bot level at 2 to 5 players, pass and play, the mooring ring and sailing ships, the stats screen and exports, the bug reporter and several screen widths. This one needs [Playwright](https://playwright.dev) (`npm install -g playwright`, then `npx playwright install chromium`); the tests look for it in the global npm folder, or in the folder named by the `PLAYWRIGHT_PATH` environment variable. It takes several minutes.

Two more scripts are for people preparing a release:

```sh
npm run qa      # a longer browser run from a sub-path, with screenshots in your temp folder
npm run sweep   # checks that nothing private or oversized is in the files that would be published
```

## The bots

- **Easy** plays a random legal card and picks a random island to moor at.
- **Medium** follows a short list of rules of thumb for which card to play and where to moor, using only what it can see.
- **Hard** samples the cards it cannot see, plays each candidate move out over those samples, and picks the one with the best expected score. It runs in a Web Worker so the page never freezes.

The simulator can also seat some fixed-policy players that the page does not offer, for example one that never plays a serpent while it has another legal card.

## Simulations

The bots and the rules can be run without a browser. `npm run sim` plays many bot-versus-bot games and writes a JSON record; `tests/sim-report.mjs` summarises it.

```sh
# 400 four-player games, Medium at every seat, with 5% random noise so the seats are not copies of each other
npm run sim -- --players=4 --seats=medium --games=400 --seed=1 --jitter=5 --out=tests/tmp/medium.json

# 200 three-player games, one Hard against two Medium bots
npm run sim -- --players=3 --seats=hard,medium,medium --games=200 --seed=1 --out=tests/tmp/hard-v-medium.json

node tests/sim-report.mjs tests/tmp/medium.json tests/tmp/hard-v-medium.json
```

The header of `tests/sim.mjs` lists every option, including the Playtest switches (`--variant.moor=score`). Output goes to `tests/tmp/`, which is not tracked.

## Project layout

```text
index.html, style.css      the page and its styles
src/engine/                the rules: pure functions on a plain-JSON game state (no DOM, no clock)
src/bots/                  Easy, Medium and Hard bots (and the simulator's fixed-policy players)
src/ui/                    the interface: setup page, game screen, stats, bug reporter, analytics
assets/                    runtime art, and manifest.json listing every image
rules/                     the printed rule book (PDF)
tests/                     Node suites, Playwright suites, the simulator and tests/qa (QA run and sweep)
```

The engine never touches the page, so the same code runs in the browser, in the Node tests and in the simulator.

## Credits

Game design and development: Wombat Game Factory.
