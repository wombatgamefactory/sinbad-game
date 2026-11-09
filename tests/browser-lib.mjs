// browser-lib.mjs - shared by the Playwright suites (ui-browser, stats-browser, qa/qa-run).
//
// Playwright is NOT a dependency of this repo. It is looked up as `playwright`, then in the global
// npm root (npm install -g playwright; npx playwright install chromium), or in the folder named by
// the PLAYWRIGHT_PATH environment variable. Without it a suite prints SKIPPED (exit 0), or exits 1
// with --require.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function loadPlaywright() {
  const tries = [() => import('playwright')];
  const dirs = [process.env.PLAYWRIGHT_PATH];
  try { dirs.push(path.join(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'playwright')); } catch { /* none */ }
  for (const d of dirs.filter(Boolean)) tries.push(() => import(pathToFileURL(path.join(d, 'index.mjs')).href));
  for (const t of tries) {
    try { const m = await t(); return m.chromium || (m.default && m.default.chromium); } catch { /* next */ }
  }
  return null;
}

/** Loads Playwright or ends the process the way the suite promises (SKIPPED / exit 1 with --require). */
export async function requireChromium(suiteName) {
  const chromium = await loadPlaywright();
  if (!chromium) {
    console.log(`${suiteName}: SKIPPED (Playwright not found)`);
    process.exit(process.argv.includes('--require') ? 1 : 0);
  }
  return chromium;
}

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8',
};

/** A static server for the repo root on a free port. Returns { server, base, close }. */
export async function serveRepo(root) {
  const server = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      if (p.startsWith(root) && fs.existsSync(path.join(p, 'index.html'))) { res.writeHead(200, { 'content-type': 'text/html' }); return fs.createReadStream(path.join(p, 'index.html')).pipe(res); }
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}
