/**
 * Which production this page is looking at.
 *
 * The server now keeps a separate set of graphics per account, so every request
 * has to say which one it means. There are exactly two ways to say it, and they
 * are for two different kinds of client:
 *
 *   ?session=<id>   a dashboard, signed in, looking at somebody else's
 *                   production because they shared it. Rides on the login
 *                   cookie - the id says which, the cookie says who.
 *   ?key=<key>      an OBS browser source or a game-client webhook. There is no
 *                   person and no cookie; the key is the whole credential. It
 *                   opens the output pages and the two webhooks and nothing
 *                   else, because it ends up written into OBS configuration and
 *                   read out over screen shares.
 *
 * Both live in the page's own URL rather than in storage, so a browser source
 * points at one production for ever, a shared dashboard survives a reload, and
 * the three preview iframes inherit the target from the page that framed them.
 */

const params = new URLSearchParams(location.search);

/** The OBS/webhook key this page was opened with, if any. */
export const SESSION_KEY = params.get('key') ?? '';

/** The session id this page was told to look at, if any. */
export const SESSION_ID = params.get('session') ?? '';

/**
 * A same-origin URL carrying whichever of the two this page holds.
 *
 * Never both: a key already names a session, and sending an id beside it would
 * invite the question of which wins. The server reads the key first.
 */
export function api(path) {
  const url = new URL(path, location.origin);
  if (SESSION_KEY) url.searchParams.set('key', SESSION_KEY);
  else if (SESSION_ID) url.searchParams.set('session', SESSION_ID);
  return url.pathname + url.search;
}

/** The same, as a string a person is meant to read and copy into OBS. */
export function outputUrl(page, key) {
  return `${location.origin}${page}${key ? `?key=${encodeURIComponent(key)}` : ''}`;
}

/**
 * Point the whole dashboard at a different production.
 *
 * A reload rather than a re-fetch, and deliberately so: every module holds its
 * own copy of a state, the three preview iframes hold three more, and the live
 * stream is subscribed per event name at first use. Rebuilding all of that in
 * place is a great deal of machinery to get subtly wrong, in exchange for
 * saving an operator half a second between shows.
 */
export function switchTo(sessionId) {
  const url = new URL(location.href);
  if (sessionId) url.searchParams.set('session', sessionId);
  else url.searchParams.delete('session');
  location.assign(url);
}

/**
 * The signed-in account, fetched once and shared.
 *
 * Four dashboard modules want the same three facts - who am I, what is my
 * session key, and which productions can I reach - and four requests for them
 * would be three too many on a page whose whole connection budget is six.
 *
 * Resolves to null on an output page: those carry a key rather than a login, so
 * the request is a 401 and there is nothing to ask about.
 */
let accountPromise = null;

export function account() {
  accountPromise ??= fetch('/api/account/me')
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  return accountPromise;
}

/** Forget the cached account - after a key rotation or a grant change. */
export function refreshAccount() {
  accountPromise = null;
  return account();
}

/**
 * The key to put in an OBS URL for whatever this dashboard is looking at.
 *
 * Your own key when you are on your own production; the owner's when you are
 * operating one that was shared with you - the browser source has to reach
 * *their* graphics, and OBS has no login of its own to say so.
 */
export async function targetKey() {
  const data = await account();
  if (!data) return '';
  if (!SESSION_ID || SESSION_ID === data.user.id) return data.user.sessionKey ?? '';
  return data.sessions?.find((entry) => entry.id === SESSION_ID)?.sessionKey ?? '';
}

/** An in-page link (a preview iframe, an "open in a tab") for the target. */
export function pageUrl(page) {
  return SESSION_ID ? `${page}?session=${encodeURIComponent(SESSION_ID)}` : page;
}
