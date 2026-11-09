// game-config.js - the one place a game's name, slug and public address live in code.
//
// Tests read these constants instead of hard-coding the name. The rule book is v3
// (rules/sinbad-rule-book-v3.pdf).

/** Display name. */
export const GAME_NAME = 'The Voyages of Sinbad';
/** kebab-case: repo name, storage keys, export file names, the analytics game_name. */
export const GAME_SLUG = 'sinbad';
/** One short strap line for the landing page hero. */
export const GAME_TAGLINE = 'Every island demands its cargo.';
/** Where the finished game is published (trailing slash). */
export const PUBLISH_URL = 'https://www.wombatgamefactory.com/sinbad-game/';
/** The rule book the landing page and the How to play dialog link to (a file under rules/). */
export const RULEBOOK_URL = 'rules/sinbad-rule-book-v3.pdf';
/** Footer line under the setup form. */
export const FOOTER_VERSION = 'Prototype';

/** The public contact address for bug reports (never a personal address). */
export const CONTACT_EMAIL = 'info@wombatgamefactory.com';

// The seat counts (R1.7; CONSTANTS.MIN_PLAYERS / MAX_PLAYERS in src/engine/rules.js agree).
export const PLAYER_COUNTS = [2, 3, 4, 5];
export const MAX_SEATS = 5;

/** Short blurb of the At-a-glance strip (best 3-4). */
export const AT_A_GLANCE = { players: '2-5', best: '3-4', minutes: '25-35', age: '10+' };

/** Prefix for localStorage keys and export file names. */
export const STORE_PREFIX = GAME_SLUG;
