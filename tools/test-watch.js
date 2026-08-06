/**
 * Self-check for the multi-account watch rules.
 *
 *   node tools/test-watch.js
 *
 * Covers the three ways the watch can be wrong on air: firing on a match the
 * account already had, firing on a scoreboard that has not finished landing,
 * and hammering tracker.gg with an unbounded fan-out.
 */

import assert from 'node:assert/strict';

import {
  freshMatch,
  isPermanentFailure,
  mapLimit,
  parseHandles,
  reserveSlot,
  scoreboardReady,
} from '../public/watch-core.js';

// --- parseHandles ----------------------------------------------------------

assert.deepEqual(parseHandles('A#1\nB#2'), ['A#1', 'B#2']);
assert.deepEqual(parseHandles('A#1, B#2'), ['A#1', 'B#2'], 'commas separate too');
assert.deepEqual(parseHandles('  A#1  \n\n B#2 '), ['A#1', 'B#2'], 'blank lines and padding go');
assert.deepEqual(parseHandles('A#1\nA#1'), ['A#1'], 'deduped');
assert.deepEqual(parseHandles('nottag\n#1\nB#'), [], 'a Riot ID needs a name and a tagline');
assert.equal(parseHandles(Array.from({ length: 20 }, (_, i) => `P${i}#T`).join('\n')).length, 10, 'capped at ten');
assert.deepEqual(parseHandles(null), []);

// --- freshMatch ------------------------------------------------------------

const history = [{ id: 'new' }, { id: 'old-a' }, { id: 'old-b' }];
const baseline = new Set(['old-a', 'old-b']);

assert.equal(freshMatch(history, baseline)?.id, 'new');
assert.equal(freshMatch([{ id: 'old-a' }], baseline), null, 'a match already in the baseline is not new');
assert.equal(freshMatch([], baseline), null);
assert.equal(freshMatch(history, null), null, 'no baseline yet means no hit - the whole history would look new');
assert.equal(freshMatch([{ id: 'newer' }, { id: 'new' }], baseline)?.id, 'newer', 'newest first wins');
assert.equal(freshMatch([{ id: 5 }], new Set(['5'])), null, 'ids compare as strings');

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

// --- reserveSlot -----------------------------------------------------------
// tracker.gg limits how often it is asked, so the watch paces every request.

{
  // An idle watch goes immediately and books the next slot a gap ahead.
  const first = reserveSlot(1_000, 0, 60_000);
  assert.deepEqual(first, { startAt: 1_000, nextAt: 61_000 }, 'the first request does not wait');

  // A second caller in the same tick queues behind it rather than sharing it.
  const second = reserveSlot(1_000, first.nextAt, 60_000);
  assert.deepEqual(second, { startAt: 61_000, nextAt: 121_000 }, 'concurrent callers must not share a slot');

  // Ten accounts at a minute each is a ten-minute round - the measured cost.
  let cursor = 0;
  let last = 0;
  for (let i = 0; i < 10; i += 1) {
    const slot = reserveSlot(1_000, cursor, 60_000);
    cursor = slot.nextAt;
    last = slot.startAt;
  }
  assert.equal(last - 1_000, 9 * 60_000, 'a round of ten spans nine gaps');

  // A cursor already in the past must not drag a request backwards.
  assert.deepEqual(reserveSlot(500_000, 1_000, 60_000), { startAt: 500_000, nextAt: 560_000 }, 'a stale cursor is ignored');

  // No pacing configured (HenrikDev before its own limit matters) is a no-op.
  assert.deepEqual(reserveSlot(1_000, 99_000, 0), { startAt: 1_000, nextAt: 99_000 }, 'zero gap never waits');
}

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
