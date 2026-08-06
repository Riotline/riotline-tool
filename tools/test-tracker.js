/**
 * Self-check for the tracker.gg payload rules.
 *
 *   node tools/test-tracker.js
 *
 * The distinction under test is the one that matters on air: an account with no
 * games of this type is a quiet, normal answer, while nothing arriving at all
 * means the page never served its data - measured, usually throttling. They look
 * identical to findMatchesArray, which only recognises a non-empty array, so
 * they have to be told apart deliberately.
 */

import assert from 'node:assert/strict';

import { findMatchesArray, isEmptyMatchList, TRACKER_XHR_PATTERN } from '../providers.js';

// --- the endpoints the page calls ------------------------------------------

const matchesUrl =
  'https://api.tracker.gg/api/v2/valorant/standard/matches/riot/Name%23TAG?platform=pc&season=4f0864e2&type=competitive';

assert.equal(TRACKER_XHR_PATTERN.test(matchesUrl), true, 'the real matches endpoint must be intercepted');
assert.equal(TRACKER_XHR_PATTERN.test('https://api.tracker.gg/api/v2/valorant/standard/customs/riot/N%231'), true);
assert.equal(TRACKER_XHR_PATTERN.test('https://api.tracker.gg/api/v1/valorant/db/batch?types=maps'), false);
assert.equal(TRACKER_XHR_PATTERN.test('https://token.rubiconproject.com/khaos.json'), false, 'ad traffic is not ours');

// --- empty list vs nothing at all ------------------------------------------

const match = { attributes: { id: 'abc' }, segments: [{ type: 'overview' }] };

// The shape the site actually returns: { data: { matches: [...] } }.
assert.equal(isEmptyMatchList({ data: { matches: [] } }), true, 'an empty list is an answer');
assert.equal(isEmptyMatchList({ data: { matches: [match] } }), false, 'a full list is not empty');
assert.equal(isEmptyMatchList({ data: [] }), true, 'the bare-array shape counts too');
assert.equal(isEmptyMatchList({ data: [match] }), false);

// Nothing that could be a list at all - this is the throttled case, and it must
// NOT be reported as an empty list, because it is an error worth retrying.
assert.equal(isEmptyMatchList({}), false, 'no data key is not an empty list');
assert.equal(isEmptyMatchList(null), false);
assert.equal(isEmptyMatchList({ data: { metadata: {} } }), false, 'data without matches is not an answer');
assert.equal(isEmptyMatchList({ errors: [{ message: 'nope' }] }), false);

// The pair that motivated all this: findMatchesArray cannot see an empty list,
// so isEmptyMatchList is the only thing standing between "no customs yet" and a
// 502 on the operator's screen.
assert.equal(findMatchesArray({ data: { matches: [] } }), null, 'findMatchesArray ignores empty arrays by design');
assert.equal(isEmptyMatchList({ data: { matches: [] } }), true, 'so this is what makes it a non-error');
assert.equal(findMatchesArray({ data: { matches: [match] } })?.length, 1);

console.log('tracker self-check passed');
