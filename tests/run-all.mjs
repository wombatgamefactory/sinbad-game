// run-all.mjs - runs every Node suite in its own process; exits 1 if any fails.
// Suites that do not exist yet are skipped. The browser suites (ui-browser, stats-browser) and
// the QA run need Playwright and are NOT here: `npm run test:browser`, `npm run qa`.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SUITES = ['purity.mjs', 'rules.mjs', 'conformance.mjs', 'smoke.mjs', 'controller.mjs', 'bots.mjs', 'sim-check.mjs', 'ui-node.mjs', 'stats-node.mjs'];
let failed = 0;
let ran = 0;
for (const s of SUITES) {
  const path = fileURLToPath(new URL(`./${s}`, import.meta.url));
  if (!existsSync(path)) continue;
  ran++;
  const r = spawnSync(process.execPath, [path], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.log(`!! ${s} FAILED`); }
}
console.log(failed ? `${failed} suite(s) failed` : `All ${ran} suites passed`);
process.exit(failed ? 1 : 0);
