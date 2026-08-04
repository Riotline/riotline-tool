/**
 * The one thing the two tabs share: whichever match the lookup tab currently
 * has open. Kept here rather than on `window` so the dashboard imports it like
 * any other module and nothing has to guess at load order.
 */

const listeners = new Set();

export const lookup = {
  /** @type {object|null} normalised match detail, exactly as /api/match returns it */
  match: null,
  /** @type {string|null} */
  handle: null,
};

export function setLookupMatch(match, handle = null) {
  lookup.match = match;
  lookup.handle = handle;
  for (const listener of listeners) listener(lookup);
}

export function onLookupMatch(listener) {
  listeners.add(listener);
  listener(lookup);
  return () => listeners.delete(listener);
}
