/**
 * One-time Cloudflare warm-up for the tracker.gg source.
 *
 *   npm run tracker:login
 *   node tools/tracker-login.js "Name#TAG"
 *
 * Opens a real, visible browser window on tracker.gg and waits for you to clear
 * the Cloudflare challenge. The clearance cookie is written to the same browser
 * profile the server uses, so later headless lookups inherit it.
 *
 * This only sticks if the headed and headless runs present the same
 * fingerprint. browser.js takes care of that: it launches the same browser
 * channel both ways and rewrites "HeadlessChrome" out of the user agent while
 * keeping the version that the Sec-CH-UA client hints report. A clearance
 * cookie is bound to the user agent and IP that earned it, so a UA that
 * disagrees with the client hints gets re-challenged immediately - which is
 * exactly what a hand-written UA string causes.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTrackerBrowser } from '../browser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const handle = process.argv[2];
const url = handle?.includes('#')
  ? `https://tracker.gg/valorant/profile/riot/${encodeURIComponent(handle)}/matches`
  : 'https://tracker.gg/valorant';

const browser = makeTrackerBrowser({
  headless: false,
  channel: (process.env.TRACKER_BROWSER_CHANNEL ?? 'auto').trim() || 'auto',
  idleCloseMs: 0,
  timeoutMs: 60_000,
});

console.log('Opening a browser window at:');
console.log(`  ${url}\n`);
console.log('Clear the Cloudflare challenge if one appears. Up to 5 minutes.');
console.log('Leave the window alone once the page loads - it closes itself.\n');

let exitCode = 0;
try {
  const result = await browser.warmUp(url, { waitMs: 5 * 60 * 1000 });

  console.log(`Browser channel : ${browser.channel ?? 'bundled chromium'}`);
  console.log(`User agent      : ${result.userAgent}`);
  console.log(`Challenge shown : ${result.challenge.seen ? 'yes' : 'no'}`);
  console.log(`Challenge passed: ${result.challenge.cleared ? 'yes' : 'NO'}`);
  console.log(`Final URL       : ${result.finalUrl}`);

  if (result.clearance) {
    const expiry = result.clearance.expires > 0 ? new Date(result.clearance.expires * 1000).toISOString() : 'session';
    console.log(`cf_clearance    : saved, expires ${expiry}`);
  } else {
    console.log('cf_clearance    : not issued (the site may not have needed one)');
  }

  if (!result.challenge.cleared) {
    console.log('\nThe challenge was never cleared. Headless lookups will fail too.');
    exitCode = 1;
  } else {
    console.log(`\nProfile saved to ${browser.profileDir}`);
    console.log('Headless lookups will reuse it. Re-run this when the clearance expires.');
  }
} catch (error) {
  console.error(`\nFailed: ${error.message}`);
  if (error.hint) console.error(error.hint);
  exitCode = 1;
} finally {
  // Closing the context is what flushes cookies to the profile on disk.
  await browser.close();
}

process.exit(exitCode);
