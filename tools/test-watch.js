/**
 * Self-check for the multi-account custom finder.
 *
 *   node tools/test-watch.js
 *
 * Covers the ways the check can be wrong on air: firing on a scoreboard that
 * has not finished landing, dropping an account that could still have answered,
 * and hammering tracker.gg with an unbounded fan-out.
 */

import assert from 'node:assert/strict';

import { isPermanentFailure, mapLimit, parseHandles, scoreboardReady } from '../public/watch-core.js';

// --- parseHandles ----------------------------------------------------------

assert.deepEqual(parseHandles('A#1\nB#2'), ['A#1', 'B#2']);
assert.deepEqual(parseHandles('A#1, B#2'), ['A#1', 'B#2'], 'commas separate too');
assert.deepEqual(parseHandles('  A#1  \n\n B#2 '), ['A#1', 'B#2'], 'blank lines and padding go');
assert.deepEqual(parseHandles('A#1\nA#1'), ['A#1'], 'deduped');
assert.deepEqual(parseHandles('nottag\n#1\nB#'), [], 'a Riot ID needs a name and a tagline');
assert.equal(parseHandles(Array.from({ length: 20 }, (_, i) => `P${i}#T`).join('\n')).length, 10, 'capped at ten');
assert.deepEqual(parseHandles(null), []);

// --- scoreboardReady -------------------------------------------------------

const player = (over = {}) => ({ roundsPlayed: 24, kills: 15, deaths: 12, assists: 4, ...over });

assert.equal(scoreboardReady({ players: [player(), player()] }).ok, true);
assert.equal(scoreboardReady({ players: [player()] }).ok, false, 'one player is a half-landed match');
assert.equal(scoreboardReady({ players: [] }).ok, false);
assert.equal(scoreboardReady({}).ok, false, 'no players key at all');
assert.equal(
  scoreboardReady({ players: Array.from({ length: 10 }, () => player({ roundsPlayed: 0, kills: 0, deaths: 0, assists: 0 })) }).ok,
  false,
  'ten players of zeroes is a shell, not a scoreboard',
);
assert.equal(
  scoreboardReady({ players: [player({ roundsPlayed: 0, kills: 0, deaths: 1, assists: 0 }), player()] }).ok,
  true,
  'a player who only died still played',
);
assert.equal(scoreboardReady({ players: [player(), player()] }).players, 2, 'reports the count for the status line');

// --- isPermanentFailure ----------------------------------------------------
// A dropped account frees a slot; a wrongly dropped one loses an account for
// the rest of the show, so only the statuses that cannot recover count.

assert.equal(isPermanentFailure(403), true, 'private profile');
assert.equal(isPermanentFailure(404), true, 'no such Riot ID');
assert.equal(isPermanentFailure(400), true, 'malformed request');
assert.equal(isPermanentFailure(429), false, 'rate limiting passes');
assert.equal(isPermanentFailure(502), false, 'a browser failure is retryable');
assert.equal(isPermanentFailure(0), false, 'a network blip is retryable');
assert.equal(isPermanentFailure(undefined), false);

// --- mapLimit --------------------------------------------------------------

{
  let live = 0;
  let peak = 0;

  const results = await mapLimit([1, 2, 3, 4, 5, 6, 7], 2, async (value) => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((resolve) => setTimeout(resolve, 5));
    live -= 1;
    return value * 2;
  });

  assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14], 'results keep input order');
  assert.equal(peak, 2, `never more than 2 in flight, saw ${peak}`);
}

assert.deepEqual(await mapLimit([], 5, async () => 1), [], 'empty input does not hang');
assert.deepEqual(await mapLimit([1], 0, async (v) => v), [1], 'a zero limit still makes progress');

console.log('watch self-check passed');
