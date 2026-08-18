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
 * Failures that will still be failures next time.
 *
 * A private profile, a Riot ID that does not exist, a malformed request - none
 * of these resolve by asking again, so the account is dropped for the session
 * and its place goes to a reserve. Everything else, a 502 above all, is usually
 * tracker.gg throttling: that account loses this set but stays eligible later.
 */
const PERMANENT_STATUS = new Set([400, 403, 404]);

export const isPermanentFailure = (status) => PERMANENT_STATUS.has(Number(status));

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
