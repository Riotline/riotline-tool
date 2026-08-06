/**
 * The decisions behind the multi-account watch, kept free of the DOM so they
 * can be exercised without a browser: see tools/test-watch.js.
 *
 * Everything here is pure. app.js owns the polling loop, the status list and
 * the handoff into the graphic; this file only answers three questions - which
 * handles are we watching, is this match new, and is it actually finished.
 */

export const WATCH_MAX = 10;

/** Riot IDs pasted one per line (or comma-separated), deduped and capped. */
export function parseHandles(text, max = WATCH_MAX) {
  const handles = String(text ?? '')
    .split(/[\n,]/)
    .map((line) => line.trim())
    // A tagline is what makes it a Riot ID; anything else is a typo or a stray
    // line, and sending it would just burn a lookup on a 400.
    .filter((line) => line.includes('#') && !line.startsWith('#') && !line.endsWith('#'));

  return [...new Set(handles)].slice(0, max);
}

/**
 * The newest match this account did not have when the watch started.
 *
 * Order is whatever the provider returned - both list sources put the newest
 * first - but ids are compared as a set rather than by position, because a
 * profile that gains two games between rounds would otherwise report the older
 * one as the new arrival.
 */
export function freshMatch(matches, baseline) {
  if (!baseline) return null;
  return (matches ?? []).find((match) => match?.id && !baseline.has(String(match.id))) ?? null;
}

/**
 * Is this detail payload actually a finished scoreboard?
 *
 * A custom that has only half-landed on tracker.gg comes back as a perfectly
 * valid response carrying one player, or ten players with nothing but zeroes -
 * not as an error - so "the request succeeded" is not the test. Two players who
 * have actually done something is: it clears the empty and one-sided shapes
 * without demanding all ten, which a 5v5 that ended in a surrender may not have.
 */
export function scoreboardReady(match, minimumPlayers = 2) {
  const players = match?.players ?? [];
  const scoring = players.filter(
    (player) =>
      (player?.roundsPlayed ?? 0) > 0 ||
      (player?.kills ?? 0) + (player?.deaths ?? 0) + (player?.assists ?? 0) > 0,
  );

  return { ok: players.length >= minimumPlayers && scoring.length >= minimumPlayers, players: players.length };
}

/**
 * Failures that will still be failures next round.
 *
 * A private profile, a Riot ID that does not exist, a malformed request - none
 * of these resolve by asking again, and on a source paced at one lookup a
 * minute an account that can never answer is a slot stolen from one that can.
 * The watch drops these for the rest of its run; everything else is transient
 * and gets retried.
 */
const PERMANENT_STATUS = new Set([400, 403, 404]);

export const isPermanentFailure = (status) => PERMANENT_STATUS.has(Number(status));

/**
 * Reserve the next moment a request is allowed to start.
 *
 * Measured, tracker.gg limits how often it is asked, not how many at once: one
 * lookup every 60s ran clean indefinitely, 30s failed on the second request.
 * That is a property of the whole watch rather than of any one account, so the
 * pacing cannot live in the per-round gap - a round of ten fires ten requests
 * back to back and blows the budget however long the pause after it is.
 *
 * Returns the reserved start time and the new cursor. Keeping it pure means the
 * caller does the waiting, and the reservation itself cannot interleave: the
 * cursor moves before anything is awaited, so two callers never take one slot.
 *
 * @returns {{startAt: number, nextAt: number}}
 */
export function reserveSlot(now, cursor, minGapMs) {
  if (!minGapMs) return { startAt: now, nextAt: cursor };
  const startAt = Math.max(now, cursor);
  return { startAt, nextAt: startAt + minGapMs };
}

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving order.
 *
 * Bounded because the tracker.gg source opens a real browser tab per check -
 * ten at once is both slower than it sounds and a good way to get blocked.
 */
export async function mapLimit(items, limit, fn) {
  const results = [];
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
