/**
 * Diagnostic: what does tracker.gg actually load, and where do matches come from?
 *
 *   node tools/probe-tracker.js "Name#TAG"
 *   node tools/probe-tracker.js "Name#TAG" --headed
 *
 * Drives the real browser, logs every JSON response the page fetches, and
 * reports which of them contains a match array. Writes the DOM and any match
 * payloads to tools/probe-output/ so the extraction can be made exact.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findMatchesArray, TRACKER_XHR_PATTERN } from '../providers.js';
import { extractEmbeddedJson, makeTrackerBrowser } from '../browser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'tools', 'probe-output');

const envPath = path.join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    if (!(key in process.env)) process.env[key] = line.slice(at + 1).trim().replace(/^["']|["']$/g, '');
  }
}

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const matchAt = args.indexOf('--match');
const matchId = matchAt === -1 ? null : args[matchAt + 1];
const handle = args.find((arg) => arg.includes('#'));

if (!handle && !matchId) {
  console.error('Usage: node tools/probe-tracker.js "Name#TAG" [--headed]');
  console.error('       node tools/probe-tracker.js --match <matchId> [--headed]');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

// Deliberately the same driver the server uses. Probing with a different
// browser channel or user agent would report a fingerprint the app never
// presents, and Cloudflare treats those very differently.
const browser = makeTrackerBrowser({
  headless: !headed,
  channel: (process.env.TRACKER_BROWSER_CHANNEL ?? 'auto').trim() || 'auto',
  timeoutMs: 30_000,
  challengeMs: headed ? 5 * 60 * 1000 : 25_000,
  idleCloseMs: 0,
});

// Customs are on their own tab - the general history never lists them. The
// dedicated match page is where the full scoreboard lives; on the profile it
// only appears after an interaction.
const targets = matchId
  ? [['match', `https://tracker.gg/valorant/match/${encodeURIComponent(matchId)}`]]
  : [
      ['profile-customs', `https://tracker.gg/valorant/profile/riot/${encodeURIComponent(handle)}/customs`],
      ['profile-matches', `https://tracker.gg/valorant/profile/riot/${encodeURIComponent(handle)}/matches`],
    ];

for (const [label, url] of targets) {
  console.log('='.repeat(74));
  console.log(label, '->', url, headed ? '(headed)' : '(headless)');

  const startedAt = Date.now();
  let result;
  try {
    // minimum: Infinity so it never short-circuits - we want every response,
    // not just the first useful one.
    result = await browser.capture(url, () => true, { minimum: Infinity });
  } catch (error) {
    console.log(`  navigation failed: ${error.message}`);
    continue;
  }

  const { captured: jsonResponses, html, status, challenge } = result;
  writeFileSync(path.join(OUT_DIR, `${label}.html`), html, 'utf8');

  console.log(`  browser: ${browser.channel ?? 'bundled chromium'} | UA: ${browser.userAgent ?? '(browser default)'}`);
  console.log(`  HTTP ${status} in ${Date.now() - startedAt}ms, ${html.length} bytes`);
  console.log(`  cloudflare challenge: shown=${challenge.seen ? 'yes' : 'no'} cleared=${challenge.cleared ? 'yes' : 'NO'}`);
  console.log(`\n  JSON responses observed: ${jsonResponses.length}`);

  // How many players a payload describes is what separates the real scoreboard
  // from the searched player's own summary.
  const playerCount = (entry) =>
    (entry?.segments ?? []).filter((segment) =>
      ['overview', 'player', 'player-summary'].includes(String(segment.type ?? '').toLowerCase()),
    ).length;

  const hits = [];
  for (const response of jsonResponses) {
    const matches = findMatchesArray(response.body);
    const wouldIntercept = TRACKER_XHR_PATTERN.test(response.url);
    const players = matches ? Math.max(0, ...matches.map(playerCount)) : 0;
    const flag = matches ? `MATCHES x${matches.length} (${players}p)` : '-';
    console.log(
      `    [${response.status}] ${flag.padEnd(20)} ${wouldIntercept ? 'intercepted' : 'ignored    '}  ${response.url.slice(0, 100)}`,
    );
    if (matches) hits.push({ response, matches, wouldIntercept, players });
  }

  if (hits.length) {
    const best = hits.sort((a, b) => b.players - a.players || b.matches.length - a.matches.length)[0];
    console.log(`\n  Fullest scoreboard seen: ${best.players} player(s)`);
    const file = path.join(OUT_DIR, `${label}-matches.json`);
    writeFileSync(file, JSON.stringify(best.matches.slice(0, 3), null, 2), 'utf8');
    console.log(`\n  Best source: ${best.response.url}`);
    console.log(`  Keys on entry 0: ${Object.keys(best.matches[0]).join(', ')}`);
    console.log(`  First 3 written to ${file}`);
    if (!best.wouldIntercept) {
      console.log('  NOTE: the provider would NOT intercept this URL - TRACKER_XHR_PATTERN needs widening.');
    }
  } else {
    console.log('\n  No match array in any XHR.');
    const blobs = extractEmbeddedJson(html);
    console.log(`  Embedded JSON blobs in HTML: ${blobs.length}`);
    for (const blob of blobs) {
      if (findMatchesArray(blob)) console.log('    -> one of them DOES contain matches (embedded fallback works)');
    }
  }
}

await browser.close();
console.log('\nDone. Output in tools/probe-output/');
